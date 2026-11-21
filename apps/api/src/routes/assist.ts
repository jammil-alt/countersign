// Draft (docs/plan.md §1.168): a long text field in the back office written from the operator's
// notes. The field's descriptor (core's `ASSIST_FIELDS`) makes the system prompt; the records the
// field may use are loaded here by id, inside the operator's own clients (row-level security and
// the scope checks the field's own routes use), never taken as text from the browser. The notes,
// the field's text and the records go to the model as data (invariant 9). A client in HIPAA mode
// is refused until the model's vendor is covered (`DRAFT_ASSIST_FEATURE`). A slow route: the model
// runs outside any transaction; the audit row is the route's own (`mountLong`).

import {
  ASSIST_FIELDS,
  ASSIST_TOOL,
  AssistAnswer,
  type AssistField,
  type AssistFieldId,
  type AssistMaterial,
  assistRoutes,
  assistSystem,
  assistUserMessage,
  BRIEF_FIELDS,
  BRIEF_LABELS,
  ComplianceRefusal,
  clientLanguage,
  complianceOf,
  DRAFT_ASSIST_FEATURE,
  FIT_WORDS,
  fitToLength,
  isUuid,
  LOCALE_ENGLISH_NAMES,
  parseCoveredProcessors,
  processingRefusal,
  readBrief,
  readFitGap,
  SETUP_WORDS,
} from "@countersign/core";
import { buildItem, clientFact, dealPerson, type Tx, tenant } from "@countersign/db";
import { createLlmClient, DEFAULT_MODELS } from "@countersign/llm";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Hono } from "hono";
import { type BuildRow, readBuild } from "../build/store";
import { clientModels } from "../compliance/models";
import { type AppEnv, ensureClient, HttpError, mountLong, type Services } from "../http";
import { claimMetered } from "../metered";
import { reportHandled } from "../observability/report";
import { readFile } from "../onboarding/files";
import { readDeal } from "../work/deals";

/** At most this many of a client file's current facts go with a fact's draft. */
const FILE_FACTS_MAX = 20;

interface Gathered {
  material: AssistMaterial;
  /** Every client whose data the call may carry: each is held to its HIPAA mode. */
  clients: string[];
  /** The client the text is about (its language, the allowance), if one. */
  primary: string | null;
  language: string;
}

/** The one thing on the build `ref` names, in lines; null when it names nothing there. */
async function refOf(
  tx: Tx,
  row: BuildRow,
  ref: string,
): Promise<NonNullable<AssistMaterial["about"]> | null> {
  const at = ref.indexOf(":");
  const kind = ref.slice(0, at);
  const id = ref.slice(at + 1);
  const fitgap = readFitGap(row.fitgap);
  if (kind === "item") {
    if (!isUuid(id)) return null;
    const [i] = await tx
      .select({ kind: buildItem.kind, title: buildItem.title, detail: buildItem.detail })
      .from(buildItem)
      .where(and(eq(buildItem.id, id), eq(buildItem.buildId, row.id)));
    return i
      ? { kind: `An open ${i.kind} on the build`, lines: [i.title, i.detail].filter(Boolean) }
      : null;
  }
  if (kind === "decision") {
    const d = fitgap.decisions.find((x) => x.id === id);
    return d
      ? {
          kind: "A decision the Builder made",
          lines: [
            d.what,
            d.why ? `Why: ${d.why}` : "",
            d.value ? `Starts at: ${d.value}` : "",
          ].filter(Boolean),
        }
      : null;
  }
  if (kind === "fit") {
    const r = fitgap.rows.find((x) => x.id === id);
    return r
      ? {
          kind: "A step of the fit-gap",
          lines: [
            `Step: ${r.need}`,
            `The Builder's verdict: ${FIT_WORDS[r.verdict]}`,
            r.how ? `How: ${r.how}` : "",
          ].filter(Boolean),
        }
      : null;
  }
  if (kind === "setup") {
    const f = fitgap.setup.find((x) => x.id === id);
    return f
      ? {
          kind: "A question of the client intake form",
          lines: [`Question: ${f.label}`, `Kind: ${SETUP_WORDS[f.kind]}`],
        }
      : null;
  }
  // DECISION: a ref that names nothing on the build (a draft problem, a test case) gives no
  // context rather than an error: the field is still drafted from the notes and the brief.
  return null;
}

/** Loads what the field may use, in the request's scope. Not found when the scope can't see it. */
async function gather(
  tx: Tx,
  tenantIds: readonly string[],
  services: Pick<Services, "env">,
  id: AssistFieldId,
  field: AssistField,
  context: {
    buildId?: string | undefined;
    clientId?: string | undefined;
    dealId?: string | undefined;
    fileId?: string | undefined;
    ref?: string | undefined;
  },
): Promise<Gathered> {
  const uses = new Set(field.uses);
  const material: AssistMaterial = {};
  const clients: (string | null)[] = [];
  // The record's own client first: the client the text is about.
  let primary: string | null = null;

  if (context.clientId) ensureClient({ tenantIds }, context.clientId);

  if (context.buildId && (uses.has("build") || uses.has("brief") || uses.has("ref"))) {
    // Row-level security shows a build only to operators serving its client and test client.
    const row = await readBuild(tx, context.buildId);
    clients.push(row.clientId, row.testClientId);
    primary ??= row.clientId;
    if (uses.has("build")) material.build = { title: row.title, kind: row.kind };
    if (uses.has("brief")) {
      const brief = readBrief(row.brief);
      const own = id.startsWith("build.brief.") ? id.slice("build.brief.".length) : null;
      material.brief = BRIEF_FIELDS.flatMap((k) => {
        const f = brief[k];
        // The field's own text goes as the current text, from the screen (it may be unsaved).
        return k !== own && f?.text
          ? [{ label: BRIEF_LABELS[k], text: f.text, state: f.state }]
          : [];
      });
    }
    if (uses.has("ref") && context.ref) material.about = await refOf(tx, row, context.ref);
  }

  if (context.dealId && uses.has("deal")) {
    const d = await readDeal(tx, tenantIds, context.dealId);
    clients.push(d.clientId);
    primary ??= d.clientId;
    const [person] = await tx
      .select({ name: dealPerson.name })
      .from(dealPerson)
      .where(eq(dealPerson.dealId, d.id))
      .orderBy(desc(dealPerson.isPrimary), asc(dealPerson.createdAt))
      .limit(1);
    material.deal = {
      title: d.title,
      company: d.company,
      stage: d.stage,
      description: d.description,
      nextStep: d.nextStep,
      person: person?.name ?? null,
    };
  }

  if (context.fileId && uses.has("file")) {
    const f = await readFile(tx, tenantIds, context.fileId);
    clients.push(f.clientId);
    primary ??= f.clientId;
    const facts = await tx
      .select({ id: clientFact.id, text: clientFact.text, replacesId: clientFact.replacesId })
      .from(clientFact)
      .where(eq(clientFact.fileId, f.id))
      .orderBy(desc(clientFact.createdAt))
      .limit(FILE_FACTS_MAX * 2);
    const replaced = new Set(facts.map((x) => x.replacesId).filter(Boolean));
    material.file = {
      name: f.name,
      website: f.website,
      facts: facts
        .filter((x) => !replaced.has(x.id))
        .slice(0, FILE_FACTS_MAX)
        .map((x) => x.text),
    };
  }

  if (context.clientId) {
    clients.push(context.clientId);
    primary ??= context.clientId;
  }

  const ids = [...new Set(clients.filter((c): c is string => !!c))];
  const rows = ids.length
    ? await tx
        .select({ id: tenant.id, name: tenant.name, settings: tenant.settings })
        .from(tenant)
        .where(inArray(tenant.id, ids))
    : [];
  // HIPAA mode (§1.35): nothing about a client in HIPAA mode goes to an uncovered vendor.
  const covered = parseCoveredProcessors(services.env.BAA_PROCESSORS);
  for (const r of rows) {
    const refusal = processingRefusal(
      complianceOf(r.settings as Record<string, unknown>),
      covered,
      DRAFT_ASSIST_FEATURE.processors,
      DRAFT_ASSIST_FEATURE.what,
    );
    if (refusal) throw new HttpError(409, "hipaa", refusal);
  }
  const own = rows.find((r) => r.id === primary);
  if (own) material.client = { name: own.name };
  // DECISION: a field the client reads (the intake form's hint, an email to the deal's person) is
  // written in the language the client chose for the portal, when the field is about one client
  // that has chosen one; everything else, and a field about no client (a template, a prospect), in
  // English, the back office's language.
  const locale =
    field.audience === "client" && own
      ? clientLanguage(own.settings as Record<string, unknown>)
      : null;
  return {
    material,
    clients: ids,
    primary: own ? own.id : null,
    language: locale ? LOCALE_ENGLISH_NAMES[locale] : "English",
  };
}

export function assistDraftRoutes(app: Hono<AppEnv>): void {
  mountLong(app, assistRoutes.opsAssistDraft, async (ctx) => {
    const { field: id, notes, current, context } = ctx.body;
    const field = ASSIST_FIELDS[id];
    const g = await ctx.inTx((scoped) =>
      gather(scoped.tx, ctx.tenantIds, ctx.services, id, field, context),
    );
    // Audit 5.9: each operator's drafts are limited per minute and per day, per client (or none).
    await ctx.inTx((scoped) =>
      claimMetered(scoped.tx, ctx.c, {
        kind: "assist.draft",
        tenantId: g.primary,
        session: ctx.session,
        role: ctx.role,
      }),
    );
    const llm = createLlmClient({
      // Held to every named client's HIPAA mode here too, beside the check above.
      transport: clientModels(ctx.services, { clients: g.clients, read: ctx.services.db }),
    });
    let text = "";
    try {
      const out = await llm.callTool({
        model: DEFAULT_MODELS.assist,
        system: assistSystem(id, g.language),
        messages: [
          {
            role: "user",
            content: assistUserMessage({
              field: id,
              notes,
              current,
              material: g.material,
              language: g.language,
            }),
          },
        ],
        tool: { ...ASSIST_TOOL, schema: AssistAnswer },
        // A token is about four characters; room for the longest field and the tool's wrapping.
        maxTokens: Math.min(4000, Math.ceil(field.maxLength / 2) + 200),
        label: "assist.draft",
      });
      text = fitToLength(out.value.text, field.maxLength);
      // DECISION: a draft is the operator's own cost, never a client's (the client didn't ask, as
      // the back office's questions): logged, not recorded as a client's usage.
      console.info(
        JSON.stringify({
          event: "assist.draft.cost",
          who: "operator",
          field: id,
          tenantId: g.primary,
          model: out.record.model,
          tokensIn: out.record.usage.inputTokens,
          tokensOut: out.record.usage.outputTokens,
          costUsd: out.record.costUsd,
        }),
      );
    } catch (error) {
      if (error instanceof ComplianceRefusal) throw error;
      reportHandled("draft failed", error, { kind: "assist.draft", field: id });
      throw new HttpError(502, "draft_failed", "we couldn't write a draft: try again");
    }
    if (!text) throw new HttpError(502, "draft_failed", "we couldn't write a draft: try again");
    return { text };
  });
}
