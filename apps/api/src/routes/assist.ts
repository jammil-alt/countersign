import { getAgent } from "@countersign/agents";
import { ContentStore, ensureUploadConnection } from "@countersign/connectors";
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
  readTestData,
  SETUP_WORDS,
  steps as stepModel,
  TEST_DATA_SYSTEM,
  TEST_DATA_TOOL,
  TEST_DOCUMENT_SYSTEM,
  TEST_DOCUMENT_TOOL,
  TestDataAnswer,
  TestDocument,
  testDataUserMessage,
  testDocumentFilename,
  triggerOnSchema,
  triggerReads,
  wantsDocument,
} from "@countersign/core";
import {
  buildItem,
  clientFact,
  dealPerson,
  narrowToTenant,
  type Tx,
  tenant,
} from "@countersign/db";
import { storeDocument } from "@countersign/documents";
import { DEFAULT_MODELS } from "@countersign/llm";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Hono } from "hono";
import { type BuildRow, readBuild } from "../build/store";
import { clientModels } from "../compliance/models";
import { type AppEnv, ensureClient, HttpError, mountLong, notFound, type Services } from "../http";
import { claimMetered } from "../metered";
import { meterDepsOf, meteredLlm } from "../metering";
import { reportHandled } from "../observability/report";
import { readFile } from "../onboarding/files";
import { renderTestDocument } from "../try/test-document";
import { readDeal } from "../work/deals";
import { extractInBackground } from "./documents";
import { sandboxClient } from "./testbench";

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
  // Made-up data to try a draft workflow on (docs/plan.md §1.186; rebuilt for the step model on
  // 2026-11-26). The model is given the workflow's name, its steps' names, the trigger's shape and
  // what the steps read of it; nothing of a client's. Where the trigger carries a stored document,
  // the model writes a document's contents instead, drawn here as a PDF and kept in the Sandbox
  // quietly (no `document.received`, so no agent starts on it), read in the background as a try's
  // upload is, and its id is the trigger's data.
  // DECISION: a made-up document is kept in the Sandbox only, as the back office's uploads are
  // (§1.16): a client agent, which test-runs on its own client's data, is refused one (422).
  mountLong(app, assistRoutes.opsAssistTestData, async (ctx) => {
    const { services, body } = ctx;
    const row = await ctx.inTx(async (scoped) => {
      const a = await getAgent(scoped.tx, ctx.params.id);
      if (a.tenantId !== null && !ctx.tenantIds.includes(a.tenantId)) throw notFound("agent");
      const [client] = a.tenantId
        ? await scoped.tx
            .select({ settings: tenant.settings })
            .from(tenant)
            .where(eq(tenant.id, a.tenantId))
        : [];
      return { tenantId: a.tenantId, kind: a.kind, settings: client?.settings ?? null };
    });
    if (row.settings) {
      const refusal = processingRefusal(
        complianceOf(row.settings as Record<string, unknown>),
        parseCoveredProcessors(services.env.BAA_PROCESSORS),
        DRAFT_ASSIST_FEATURE.processors,
        DRAFT_ASSIST_FEATURE.what,
      );
      if (refusal) throw new HttpError(409, "hipaa", refusal);
    }
    const parsed = stepModel.Workflow.safeParse(body.workflow);
    if (!parsed.success) {
      throw new HttpError(422, "invalid_workflow", "the workflow doesn't read in the step model");
    }
    const wf = parsed.data;
    const on = wf.triggers[0]?.on;
    const events = Object.fromEntries(services.platform.events.list().map((e) => [e.type, e]));
    const schema = on ? triggerOnSchema(on as never, { events }) : undefined;
    const document = wantsDocument(schema);
    if (document && row.kind === "client") {
      throw new HttpError(
        422,
        "sandbox_only",
        "a made-up document is kept in the Sandbox only: try the template there, or upload one of the client's documents",
      );
    }
    const stepNames: string[] = [];
    const walk = (list: readonly unknown[]) => {
      for (const s of list as {
        name?: string;
        steps?: unknown[];
        paths?: { steps: unknown[] }[];
        otherwise?: { steps: unknown[] };
      }[]) {
        if (s.name?.trim()) stepNames.push(s.name.trim());
        if (s.steps) walk(s.steps);
        for (const p of s.paths ?? []) walk(p.steps);
        if (s.otherwise) walk(s.otherwise.steps);
      }
    };
    walk(wf.steps);
    await ctx.inTx((scoped) =>
      claimMetered(scoped.tx, ctx.c, {
        kind: "assist.draft",
        tenantId: row.tenantId,
        session: ctx.session,
        role: ctx.role,
      }),
    );
    // §1.210: our own cost, recorded as the back office's (never the client's) when it ends.
    const { llm } = meteredLlm(meterDepsOf(ctx), {
      transport: clientModels(services, {
        clients: row.tenantId ? [row.tenantId] : [],
        read: services.db,
      }),
      tenantId: row.tenantId,
      source: "assist",
    });
    const ask = {
      workflow: body.name,
      steps: stepNames.slice(0, 60),
      ...(document ? {} : { schema, reads: triggerReads(wf.steps) }),
      notes: body.notes,
    };
    try {
      if (!document) {
        const out = await llm.callTool({
          model: DEFAULT_MODELS.assist,
          system: TEST_DATA_SYSTEM,
          messages: [{ role: "user", content: testDataUserMessage(ask) }],
          tool: { ...TEST_DATA_TOOL, schema: TestDataAnswer },
          maxTokens: 6000,
          label: "assist.test_data",
        });
        return { ...readTestData(schema, out.value), document: null };
      }
      const out = await llm.callTool({
        model: DEFAULT_MODELS.assist,
        system: TEST_DOCUMENT_SYSTEM,
        messages: [{ role: "user", content: testDataUserMessage(ask) }],
        tool: { ...TEST_DOCUMENT_TOOL, schema: TestDocument },
        maxTokens: 4000,
        label: "assist.test_document",
      });
      const made = out.value;
      const bytes = await renderTestDocument(made);
      const filename = testDocumentFilename(made);
      const stored = await ctx.inTx(async (scoped) => {
        const sandbox = await sandboxClient(scoped);
        return narrowToTenant(scoped.tx, sandbox, async (tx) => {
          const conn = await ensureUploadConnection(tx, sandbox);
          const doc = await storeDocument(
            tx,
            new ContentStore(services.deps.objects(services.env)),
            {
              tenantId: sandbox,
              source: "upload",
              connectionId: conn.id,
              bytes,
              filename,
              mimeType: "application/pdf",
              meta: { uploadedBy: ctx.session.user.id, via: "try", madeUp: true },
              announce: false,
            },
          );
          return { sandbox, doc: doc.document, created: doc.created };
        });
      });
      if (stored.created) {
        ctx.defer(() => extractInBackground(services, stored.sandbox, [stored.doc.id]));
      }
      return {
        // The payload `document.received` carries, as a try's upload sends it.
        trigger: {
          documentId: stored.doc.id,
          source: stored.doc.source,
          filename: stored.doc.filename,
          mimeType: stored.doc.mimeType,
          sha256: stored.doc.sha256,
        },
        missing: false,
        document: { id: stored.doc.id, filename: stored.doc.filename, clientId: stored.sandbox },
      };
    } catch (error) {
      if (error instanceof ComplianceRefusal || error instanceof HttpError) throw error;
      reportHandled("making up test data failed", error, { kind: "assist.test_data" });
      throw new HttpError(502, "draft_failed", "we couldn't make up the data: try again");
    }
  });

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
    // §1.210: our own cost, recorded as the back office's (never the client's) when it ends.
    const { llm } = meteredLlm(meterDepsOf(ctx), {
      // Held to every named client's HIPAA mode here too, beside the check above.
      transport: clientModels(ctx.services, { clients: g.clients, read: ctx.services.db }),
      tenantId: g.primary,
      source: "assist",
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
      // the back office's questions): recorded as the back office's (§1.210), never the client's.
    } catch (error) {
      if (error instanceof ComplianceRefusal) throw error;
      reportHandled("draft failed", error, { kind: "assist.draft", field: id });
      throw new HttpError(502, "draft_failed", "we couldn't write a draft: try again");
    }
    if (!text) throw new HttpError(502, "draft_failed", "we couldn't write a draft: try again");
    return { text };
  });
}
