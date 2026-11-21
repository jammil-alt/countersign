// docs/plan.md §1.164 "The happy path (done when)": the Sales pack's template "Spreadsheet to Zoho"
// end to end through the API against the fakes (Zoho CRM, a scripted model and embeddings; nothing
// live). The client's Zoho leads sync in; the operator switches the Sales area on, forks the
// template and adds the client's own column (Zoho's custom field Region, labelled "Sales region");
// the client uploads a 20-row .xlsx:
//   Read table (the agent's columns) → Reshape into Zoho's fields → Match to CRM: 15 by key, 3 by
//   meaning and the model, 2 unsure → Confirm matches: one approved, one remapped through the
//   look-up, the High ones approved → the confirmed matches → 20 updates, approval on, proposed
//   together and signed as one group → the fake Zoho holds the new values, each update with its
//   before state → the same file again: all 20 matched with no person (the aliases).
//
// It needs Read table (PR #480) on the platform: until that merges, it is skipped. The model and the
// embeddings are scripted in the test (FakeModel and a concept embedder, as packs/sales'
// match.test.ts), never live.

import { DEV_USER_HEADER } from "@countersign/auth";
import * as connectors from "@countersign/connectors";
import {
  ContentStore,
  createZohoCrmConnector,
  generateEncryptionKey,
} from "@countersign/connectors";
import { fakeZoho } from "@countersign/connectors/testing";
import { processes } from "@countersign/core";
import { agent, agentVersion, externalAction, inboxItem, stepRun } from "@countersign/db";
import { type EmbedRequest, FakeModel, type LlmRequest } from "@countersign/llm";
import { crmMatch, salesManifest } from "@countersign/pack-sales";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type ApiHarness,
  admin,
  allowForAgent,
  createApiHarness,
  FakeWorkflowStep,
  forbiddenKeys,
  OPERATOR,
} from "./api.test-helper";
import { credentialsFor, executeRun } from "./runs/execute";
import { cloudflareStepRunner } from "./runs/step-runner";
import { runZohoSync } from "./zoho/sync";

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
type J = any;
const j = (v: unknown) => v as J;

const ENCRYPTION_KEY = generateEncryptionKey();
const ORIGIN = "https://app.mezonas.test";
const zoho = fakeZoho();

// Read table's writer and skill come with PR #480; read loosely so this file typechecks without it.
const writeXlsx = (connectors as unknown as Record<string, unknown>).writeXlsx as
  | ((grid: { headers: string[]; rows: unknown[][] }, o?: { sheet?: string }) => Uint8Array)
  | undefined;

const h = await createApiHarness({
  connectors: () => [
    createZohoCrmConnector({
      clientId: "1000.CLIENT",
      clientSecret: "zoho-secret",
      fetch: zoho.fetch,
    }),
  ],
  env: { ENCRYPTION_KEY, OAUTH_STATE_SECRET: "state-secret-".repeat(4), APP_ORIGIN: ORIGIN },
});
afterAll(() => h?.close());
const ready = Boolean(h && writeXlsx && h.platform.catalog.get("data.read-table"));

// ── The client's Zoho and its sheet ────────────────────────────────────────────────────────────

const synced = new Date(Date.now() - 3 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "+00:00");
let nextId = 5725767000000500000n;
/** Whether digits pass the card-number check (Luhn). */
const luhn = (digits: string) =>
  [...digits].reverse().reduce((sum, ch, i) => {
    const d = Number(ch) * (i % 2 === 1 ? 2 : 1);
    return sum + (d > 9 ? d - 9 : d);
  }, 0) %
    10 ===
  0;
// DECISION (test): ids that don't read as card numbers. A real Zoho id can (19 digits, about one
// in ten passes Luhn), and a change carrying one is refused today: see the PR's follow-up.
const recordId = () => {
  let id = String(nextId++);
  while (luhn(id)) id = String(nextId++);
  return id;
};
const lead = (f: Record<string, unknown>): Record<string, unknown> & { id: string } => ({
  id: recordId(),
  Modified_Time: synced,
  Region: "Unassigned",
  ...f,
});

/** 15 leads the sheet names by email. */
const KEYED = Array.from({ length: 15 }, (_, i) =>
  lead({
    First_Name: `Person${i}`,
    Last_Name: `Keyed${i}`,
    Company: `Keyed Company ${i}`,
    Email: `person${i}@keyed${i}.example.com`,
  }),
);
/** 3 leads the sheet names in other words: found by meaning, chosen by the model. */
const MEANT = [
  lead({
    First_Name: "Olivia",
    Last_Name: "Brown",
    Company: "Golden Gate Bakery",
    Email: "olivia@ggbakery.com",
  }),
  lead({
    First_Name: "Robert",
    Last_Name: "Tanaka",
    Company: "Tanaka Builders",
    Email: "robert@tanakabuild.com",
  }),
  lead({
    First_Name: "William",
    Last_Name: "Chen",
    Company: "Chen Family Dental",
    Email: "wchen@chendental.com",
  }),
];
/** 2 pairs the match can't tell apart: a person decides. */
const SAM = lead({
  First_Name: "Sam",
  Last_Name: "Okafor",
  Company: "Harbor Supply Co",
  Email: "sam@harborsupply.com",
});
const SAMUEL = lead({
  First_Name: "Samuel",
  Last_Name: "Okafor",
  Company: "Harbor Supply Company",
  Email: "s.okafor@harbor-supply.net",
});
const PAT = lead({
  First_Name: "Pat",
  Last_Name: "Lee",
  Company: "Lee Builders",
  Email: "pat@leebuilders.com",
});
const PAT_TOO = lead({
  First_Name: "Pat",
  Last_Name: "Lee",
  Company: "Lee Landscaping",
  Email: "pat@leelandscaping.com",
});
const PATRICIA = lead({
  First_Name: "Patricia",
  Last_Name: "Lee",
  Company: "Lee Group Holdings",
  Email: "patricia@leegroupholdings.com",
});
const LEADS = [...KEYED, ...MEANT, SAM, SAMUEL, PAT, PAT_TOO, PATRICIA];

/** The sheet: headers as the client writes them, a region for each row. */
const HEADERS = ["Email", "First name", "Last name", "Company", "Sales region"];
const SHEET: string[][] = [
  ...KEYED.map((l, i) => [String(l.Email), "", "", "", `Region ${i}`]),
  ["", "Liv", "Brown", "SF Sourdough", "West"],
  ["", "Bob", "Tanaka", "Tanaka Construction", "Mountain"],
  ["", "Bill", "Chen", "Chen Dentistry", "Pacific"],
  ["", "Sam", "Okafor", "Harbor Supply", "North"],
  ["", "Pat", "Lee", "Lee Group", "South"],
];

/** Embeddings by concept: the words a test names share a direction; any other text its own. */
const CONCEPTS: [RegExp, number][] = [
  [/olivia|\bliv\b/, 1],
  [/robert|\bbob\b/, 2],
  [/william|\bbill\b/, 3],
];
function embed(request: EmbedRequest) {
  return Promise.resolve({
    model: "text-embedding-3-large",
    embeddings: request.input.map((text) => {
      let h = 0;
      for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) % 1000;
      const dim = CONCEPTS.find(([re]) => re.test(text))?.[1] ?? 20 + h;
      return Array.from({ length: request.dimensions }, (_, k) => (k === dim ? 1 : 0));
    }),
    usage: { inputTokens: 5 * request.input.length },
  });
}

/** The model: the record a nickname is, by its full name; the Okafors and the Lees unsure. */
const WHO: [RegExp, string][] = [
  [/"Liv"/, "Olivia Brown"],
  [/"Bob"/, "Robert Tanaka"],
  [/"Bill"/, "William Chen"],
];
function choose(request: LlmRequest) {
  const content = String(request.messages[0]?.content ?? "");
  const row = /<row>([\s\S]*?)<\/row>/.exec(content)?.[1] ?? "";
  const lines = (/<candidates>\n([\s\S]*?)\n<\/candidates>/.exec(content)?.[1] ?? "").split("\n");
  const candidates = lines.flatMap((l) => {
    try {
      return [JSON.parse(l) as { id: string; name?: string }];
    } catch {
      return [];
    }
  });
  const want = WHO.find(([re]) => re.test(row))?.[1];
  const hit = want ? candidates.find((c) => c.name === want) : undefined;
  return {
    toolUse: {
      name: "record_choice",
      input: hit
        ? { decision: "matched", record_id: hit.id, confidence: 0.95, reason: "The same person." }
        : { decision: "unsure", record_id: null, confidence: 0.5, reason: "Two people match." },
    },
  };
}

describe.skipIf(!ready)("Spreadsheet to Zoho, end to end", () => {
  const H = h as ApiHarness;
  const A = () => H.A.tenantId;
  const ids = { connection: "", template: "", agentId: "", documentId: "" };
  const zdeps = () => ({
    db: H.db,
    platform: H.platform,
    credentials: credentialsFor(H.db, { current: ENCRYPTION_KEY }),
  });
  const deps = (transport: FakeModel) => ({
    db: H.db,
    platform: H.platform,
    transport: { create: (r: LlmRequest) => transport.create(r), embed },
    instances: H.instances,
    credentials: credentialsFor(H.db, { current: ENCRYPTION_KEY }),
    documents: { content: new ContentStore(H.objects) },
  });
  const typing = () => ({
    skills: Object.fromEntries(H.platform.catalog.list().map((s) => [s.id, s])),
    tools: H.platform.tools.specs(),
    events: H.platform.events.byType(),
  });

  beforeAll(async () => {
    zoho.state.listed.Leads = LEADS;
    // The client signs in to its Zoho.
    const offer = await H.call(OPERATOR, "PUT", `/api/ops/clients/${A()}/connectors`, {
      offered: ["zoho_crm"],
    });
    expect(offer.status, JSON.stringify(offer.json)).toBe(200);
    const start = await H.call(admin("a"), "POST", "/api/connections/zoho_crm/authorize");
    const state = new URL(j(start.json).redirectUrl).searchParams.get("state") ?? "";
    const done = await H.call(admin("a"), "POST", "/api/connections/zoho_crm/callback", {
      params: {
        code: "fixture-code",
        state,
        location: "eu",
        "accounts-server": "https://accounts.zoho.eu",
      },
    });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    ids.connection = j(done.json).connection.connection.id;
    // The operator switches the Sales area on: its template is installed.
    const on = await H.call(OPERATOR, "POST", `/api/ops/clients/${A()}/packs/sales/enable`);
    expect(on.status, JSON.stringify(on.json)).toBe(200);
    const [tpl] = await H.t.db
      .select()
      .from(agent)
      .where(and(eq(agent.kind, "template"), eq(agent.slug, "spreadsheet-to-zoho")));
    ids.template = tpl?.id ?? "";
    // The leads sync in; the Sales area builds their keys after each page.
    const synced1 = await runZohoSync(zdeps(), { tenantId: A(), connectionId: ids.connection });
    expect(synced1.stored).toBe(LEADS.length);
    // No approval waits out an undo window here.
    const desk = await H.call(OPERATOR, "PUT", `/api/ops/clients/${A()}/desk`, { undoSeconds: 0 });
    expect(desk.status, JSON.stringify(desk.json)).toBe(200);
  });

  it("ships a template that validates on the platform, approval on", () => {
    const [t] = salesManifest.templates;
    const latest = (t?.versions?.at(-1) ?? t?.bundle) as never;
    expect(processes.validateAnyBundle(latest, typing()).errors).toEqual([]);
  });

  it("forks it for the client, with the client's own column for Zoho's custom field", async () => {
    const [v2] = await H.t.db
      .select()
      .from(agentVersion)
      .where(and(eq(agentVersion.agentId, ids.template), eq(agentVersion.version, 2)));
    const fork = await H.call(OPERATOR, "POST", `/api/ops/templates/${ids.template}/fork`, {
      clientId: A(),
      slug: "spreadsheet-to-zoho-a",
      versionId: v2?.id,
    });
    expect(fork.status, JSON.stringify(fork.json)).toBe(200);
    ids.agentId = j(fork.json).agent.id;
    const bound = await H.call(OPERATOR, "PATCH", `/api/ops/agents/${ids.agentId}/operation`, {
      bindings: { zoho_crm: ids.connection },
    });
    expect(bound.status, JSON.stringify(bound.json)).toBe(200);
    // Connectors C4: the connection started low risk; the client admin allows what it needs.
    await allowForAgent(H, admin("a"), ids.connection, ids.agentId);
    // The client's sheet has a "Sales region" column: Zoho's custom field Region. Marked the
    // client's own, so a promotion back to the template leaves it out.
    const bundle = structuredClone(j(v2?.bundle));
    const read = bundle.definition.skills.find((s: J) => s.skill === "data.read-table");
    read.parameters.columns.push({
      field: "region",
      headers: ["Sales region"],
      type: "text",
      clientSpecific: true,
    });
    const steps = bundle.workflows[0].workflow.steps as J[];
    const shape = steps.find((s) => s.id === "shape");
    const rows = shape.reshape.fields[0];
    rows.schema.items.properties.Region = { type: "string" };
    rows.from.mapList.fields.Region = { item: "region" };
    const saved = await H.call(OPERATOR, "POST", `/api/ops/agents/${ids.agentId}/versions`, {
      bundle,
      parentVersionId: j(fork.json).version.id,
      changeNote: "The client's Sales region column",
    });
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    expect(j(saved.json).errors).toEqual([]);
    const pub = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${ids.agentId}/versions/${j(saved.json).version.id}/publish`,
    );
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
    await H.t.db.update(agent).set({ runStatus: "active" }).where(eq(agent.id, ids.agentId));
  });

  it("takes the client's .xlsx as a document", async () => {
    const xlsx = (writeXlsx as NonNullable<typeof writeXlsx>)(
      {
        headers: HEADERS,
        rows: SHEET.map((r) => r.map((v) => (v ? { kind: "text", value: v } : null))),
      },
      { sheet: "Leads" },
    );
    const form = new FormData();
    form.append("files", new File([xlsx], "trade-show-leads.xlsx", { type: "" }));
    const deferred: Promise<unknown>[] = [];
    const res = await H.app.request(
      "/api/uploads",
      { method: "POST", headers: { [DEV_USER_HEADER]: admin("a") }, body: form },
      H.env,
      {
        waitUntil: (p: Promise<unknown>) => void deferred.push(p),
        passThroughOnException: () => {},
        props: {},
      } as unknown as ExecutionContext,
    );
    while (deferred.length > 0) await Promise.all(deferred.splice(0));
    expect(res.status).toBe(200);
    const [file] = j(await res.json()).results;
    expect(file).toMatchObject({ kind: "document", created: true });
    ids.documentId = file.document.id;
  });

  async function run(model: FakeModel, onCard: (item: J) => Promise<void>) {
    const res = await H.call(OPERATOR, "POST", `/api/ops/agents/${ids.agentId}/run`, {
      workflow: "spreadsheet-to-zoho",
      input: { documentId: ids.documentId },
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const runId = j(res.json).runId as string;
    const params = H.instances.started.get(runId);
    if (!params) throw new Error("not started");
    let signing: Promise<void> | null = null;
    const groups: string[][] = [];
    const cardErrors: string[] = [];
    const step = new FakeWorkflowStep(async (_name, type) => {
      const woke = () => H.instances.events.find((e) => e.event.type === type)?.event.payload;
      const items = await H.t.db.select().from(inboxItem).where(eq(inboxItem.runId, runId));
      const item = items.find((i) => `inbox-${i.id.replace(/-/g, "")}` === type);
      if (!item) throw new Error(`no item for ${type}`);
      if (item.kind === "external_action") {
        // Every update the loop proposes is signed together, once all of them are proposed.
        signing ??= (async () => {
          let open: (typeof inboxItem.$inferSelect)[] = [];
          for (let i = 0; i < 200 && open.length < 20; i++) {
            open = (await H.t.db.select().from(inboxItem).where(eq(inboxItem.runId, runId))).filter(
              (x) => x.kind === "external_action" && x.status === "open",
            );
            if (open.length < 20) await new Promise((r) => setTimeout(r, 25));
          }
          expect(new Set(open.map((x) => x.batchKey))).toEqual(new Set([`${runId}:update`]));
          groups.push(open.map((x) => x.id));
          const signed = await H.call(admin("a"), "POST", "/api/inbox/batch/resolve", {
            batchKey: `${runId}:update`,
            approve: open.map((x) => x.id),
          });
          expect(signed.status, JSON.stringify(signed.json)).toBe(200);
        })();
        await signing;
        return woke();
      }
      // A failed check on the card would only time the run out: it is kept and shown after.
      await onCard(item).catch((e: unknown) => {
        cardErrors.push(String(e));
        throw e;
      });
      return woke();
    });
    const result = await executeRun(deps(model), params, cloudflareStepRunner(step));
    const steps = await H.t.db.select().from(stepRun).where(eq(stepRun.runId, runId));
    expect(cardErrors).toEqual([]);
    expect(
      result,
      JSON.stringify([result, steps.map((s) => [s.nodeId, s.status, s.summary])]),
    ).toMatchObject({ status: "succeeded" });
    return { result, steps, runId, groups };
  }

  it("matches 15 by key and 3 by meaning, asks about 2, and updates all 20 in one signed group", async () => {
    const model = new FakeModel(Array.from({ length: 5 }, () => choose));
    let card = 0;
    const { steps, runId, groups } = await run(model, async (item) => {
      expect(item.payload.review).toBe("sales.match");
      card++;
      const path = `/api/inbox/${item.id}/pack-review`;
      const view = await H.call(admin("a"), "GET", path);
      expect(view.status, JSON.stringify(view.json)).toBe(200);
      expect(forbiddenKeys(view.json, /cost|token|prompt|instruction|bundle/i)).toEqual([]);
      const rows = j(view.json).data.rows as J[];
      // The two unsure rows come first, each beside a suggested lead.
      expect(rows.slice(0, 2).map((r) => [r.index, r.agent.decision])).toEqual([
        [18, "unsure"],
        [19, "unsure"],
      ]);
      expect(rows.filter((r) => r.agent.decision === "matched")).toHaveLength(18);
      // Sam: the suggestion as it is.
      const approved = await H.call(admin("a"), "POST", path, {
        action: "approve",
        input: { index: 18 },
      });
      expect(approved.status, JSON.stringify(approved.json)).toBe(200);
      // Pat: remapped to Patricia, found with the look-up.
      const found = await H.call(admin("a"), "GET", `${path}/lookup?q=patricia%20lee`);
      expect(found.status, JSON.stringify(found.json)).toBe(200);
      const patricia = (j(found.json).records as J[]).find((r) => r.externalId === PATRICIA.id);
      expect(patricia).toBeDefined();
      const remapped = await H.call(admin("a"), "POST", path, {
        action: "lookup",
        input: { index: 19, recordKeyId: patricia.recordKeyId },
      });
      expect(remapped.status, JSON.stringify(remapped.json)).toBe(200);
      // And the rows we matched with High confidence, so the same sheet matches by itself.
      const high = await H.call(admin("a"), "POST", path, {
        action: "approve_high",
        input: {},
      });
      expect(high.status, JSON.stringify(high.json)).toBe(200);
      const finish = await H.call(admin("a"), "POST", `/api/inbox/${item.id}/resolve`, {
        decision: "approve",
        answer: { reviewed: 20 },
      });
      expect(finish.status, JSON.stringify(finish.json)).toBe(200);
    });
    expect(card).toBe(1);
    // The match: 15 by key, 3 by the model (found by meaning), 2 for a person.
    const match = steps.find((s) => s.nodeId === "match");
    const out = j(match?.output);
    expect(out.counts).toEqual({ matched: 18, none: 0, unsure: 2 });
    const methods = (out.rows as J[]).map((r) => r.method);
    expect(methods.filter((m) => m === "key")).toHaveLength(15);
    const byModel = (out.rows as J[]).filter(
      (r) => r.method === "model" && r.decision === "matched",
    );
    expect(byModel.map((r) => r.record.externalId).sort()).toEqual(MEANT.map((l) => l.id).sort());
    for (const r of byModel) expect(r.candidates[0].foundBy).toContain("meaning");
    // The person step's answer: the confirmed matches as recorded.
    const person = steps.find((s) => s.nodeId === "confirm");
    expect(j(person?.output).answer.matches).toHaveLength(20);
    // 20 updates, proposed together, signed in one go.
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(20);
    const actions = await H.t.db
      .select()
      .from(externalAction)
      .where(eq(externalAction.runId, runId));
    expect(actions).toHaveLength(20);
    expect(actions.every((a) => a.status === "done" && a.tool === "zoho_crm.record.update")).toBe(
      true,
    );
    // The fake Zoho holds each row's region on the lead it was matched to, each with its before.
    const regionOf = (id: string) => LEADS.find((l) => l.id === id)?.Region;
    const expected = new Map<string, string>([
      ...KEYED.map((l, i) => [l.id, `Region ${i}`] as [string, string]),
      [MEANT[0]?.id as string, "West"],
      [MEANT[1]?.id as string, "Mountain"],
      [MEANT[2]?.id as string, "Pacific"],
      [SAM.id, "North"],
      [PATRICIA.id, "South"],
    ]);
    for (const [id, region] of expected) expect(regionOf(id), id).toBe(region);
    expect(PAT.Region).toBe("Unassigned");
    expect(PAT_TOO.Region).toBe("Unassigned");
    expect(SAMUEL.Region).toBe("Unassigned");
    for (const a of actions) {
      expect(j(a.before)).toMatchObject({ fields: { Region: "Unassigned" } });
      // Only the row's own field: a sheet's spelling never renames a lead.
      expect(Object.keys(j(a.input).fields)).toEqual(["Region"]);
    }
  });

  it("matches the same sheet again with no person: the aliases", async () => {
    // Zoho's records changed with the updates: the next sync reads them again.
    await runZohoSync(zdeps(), { tenantId: A(), connectionId: ids.connection });
    const model = new FakeModel([]);
    const { steps, runId } = await run(model, async (item) => {
      throw new Error(`no person expected: ${item.title}`);
    });
    expect(model.requests).toEqual([]);
    const out = j(steps.find((s) => s.nodeId === "match")?.output);
    expect(out.counts).toEqual({ matched: 20, none: 0, unsure: 0 });
    expect(new Set((out.rows as J[]).map((r) => r.method))).toEqual(new Set(["alias"]));
    expect(steps.find((s) => s.nodeId === "confirm")).toBeUndefined();
    const decisions = await H.t.db
      .select()
      .from(crmMatch)
      .where(and(eq(crmMatch.tenantId, A()), eq(crmMatch.runId, runId)));
    expect(decisions.every((d) => d.decidedByUserId === null)).toBe(true);
    const actions = await H.t.db
      .select({ id: externalAction.id })
      .from(externalAction)
      .where(and(eq(externalAction.runId, runId), inArray(externalAction.status, ["done"])));
    expect(actions).toHaveLength(20);
  });
});
