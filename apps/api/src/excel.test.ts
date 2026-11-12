// §1.97: Excel through the API against a fake Microsoft (nothing live). The client admin signs in
// through the generic OAuth routes with `Files.ReadWrite`, searches their own OneDrive and picks a
// workbook; each new pick is checked with the connection's grant. An agent adds rows only to a
// picked workbook, only after a person approves, once (also when the run is replayed); an unpicked
// workbook is refused before Microsoft is called. No response carries a token.

import {
  ContentStore,
  createExcelConnector,
  EXCEL_TOOLS,
  generateEncryptionKey,
} from "@countersign/connectors";
import { FAKE_EXCEL_APP, fakeExcel } from "@countersign/connectors/testing";
import { AgentBundle, type AgentBundleInput } from "@countersign/core";
import { agent, connection, externalAction } from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  FakeWorkflowStep,
  forbiddenKeys,
  OPERATOR,
  user,
} from "./api.test-helper";
import { credentialsFor, executeRun } from "./runs/execute";
import { cloudflareStepRunner } from "./runs/step-runner";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const ENCRYPTION_KEY = generateEncryptionKey();
const ORIGIN = "https://app.mezonas.test";
const excel = fakeExcel();
const LOG = excel.seed(
  "Receiving log.xlsx",
  { Log: [["Date", "Vendor", "Item"]] },
  { folder: "Finance" },
);
const PAYROLL = excel.seed("Payroll.xlsx", { Sheet1: [["Name", "Rate"]] });

const h = await createApiHarness({
  connectors: () => [createExcelConnector({ ...FAKE_EXCEL_APP, fetch: excel.fetch })],
  env: { ENCRYPTION_KEY, OAUTH_STATE_SECRET: "state-secret-".repeat(4), APP_ORIGIN: ORIGIN },
});
afterAll(() => h?.close());

function bundle(workbookId: string): AgentBundle {
  return AgentBundle.parse({
    schemaVersion: 1,
    definition: {
      schemaVersion: 2,
      identity: { name: "Receiving clerk", role: "logs deliveries", mission: "log deliveries" },
      kind: "functional",
      model: { id: "claude-opus-5-5", maxTokens: 1024 },
      instructions: "Only do what the workflow says.",
      skills: [],
      extraTools: [EXCEL_TOOLS.append],
      canCommand: [],
      permissions: { mode: "suggest_only" },
      budgets: { maxSteps: 4, maxCostUsd: "0.10" },
      memory: { enabled: false },
    },
    workflows: [
      {
        slug: "main",
        name: "Main",
        workflow: {
          schemaVersion: 3,
          trigger: { id: "trg-manual", on: { type: "manual", input: {} } },
          // No `approval` on the step: a write waits for a person by default.
          steps: [
            {
              id: "log",
              name: "Log it",
              kind: "action",
              tool: EXCEL_TOOLS.append,
              input: { workbookId, rows: [["2026-11-12", "Hardwood Supply", '=HYPERLINK("x")']] },
              client: { visible: true, label: "Log the delivery" },
            },
          ],
        },
      },
    ],
  } as AgentBundleInput);
}

describe.skipIf(!h)("Excel through the API", () => {
  const H = h as ApiHarness;
  const A = () => H.A.tenantId;
  const seen: string[] = [];
  const call = async (...args: Parameters<ApiHarness["call"]>) => {
    const res = await H.call(...args);
    seen.push(JSON.stringify(res.json ?? null));
    expect(forbiddenKeys(res.json), `${args[1]} ${args[2]}`).toEqual([]);
    return res;
  };
  let conn = "";

  beforeAll(async () => {
    const offer = await call(OPERATOR, "PUT", `/api/ops/clients/${A()}/connectors`, {
      offered: ["testkit", "excel"],
    });
    expect(offer.status, JSON.stringify(offer.json)).toBe(200);
  });

  it("signs in with Files.ReadWrite through the generic routes; nothing is picked yet", async () => {
    const start = await call(admin("a"), "POST", "/api/connections/excel/authorize");
    expect(start.status, JSON.stringify(start.json)).toBe(200);
    const redirect = new URL(j(start.json).redirectUrl);
    expect(redirect.searchParams.get("scope")).toBe(
      "openid email offline_access https://graph.microsoft.com/Files.ReadWrite",
    );
    expect(redirect.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/connections/excel/callback`);
    const done = await call(admin("a"), "POST", "/api/connections/excel/callback", {
      params: { code: excel.issueCode(), state: redirect.searchParams.get("state") ?? "" },
    });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    conn = j(done.json).connection.connection.id;
    const [row] = await H.t.db.select().from(connection).where(eq(connection.id, conn));
    expect(row?.permissions).toMatchObject({
      create: "approval",
      update: "approval",
      delete: "off",
    });
    const picker = await call(admin("a"), "GET", "/api/connections/excel/picker");
    expect(j(picker.json)).toMatchObject({ available: true, connectionId: conn, workbooks: [] });
  });

  it("the client admin searches their OneDrive and picks a workbook, checked with Microsoft", async () => {
    expect((await call(user("a"), "GET", "/api/connections/excel/search?q=log")).status).toBe(403);
    const found = await call(admin("a"), "GET", "/api/connections/excel/search?q=log");
    expect(found.status, JSON.stringify(found.json)).toBe(200);
    expect(j(found.json).results.map((r: { name: string }) => r.name)).toContain(
      "Receiving log.xlsx",
    );
    const picked = await call(admin("a"), "PUT", "/api/connections/excel/workbooks", {
      workbookIds: [LOG.id],
    });
    expect(picked.status, JSON.stringify(picked.json)).toBe(200);
    expect(j(picked.json).workbooks).toEqual([
      expect.objectContaining({ id: LOG.id, name: "Receiving log.xlsx", usable: true }),
    ]);
    // An id that isn't a workbook the person can open is refused, and the list is unchanged.
    const bad = await call(admin("a"), "PUT", "/api/connections/excel/workbooks", {
      workbookIds: [LOG.id, "01NOTAREALFILE0000000000000000000"],
    });
    expect(bad.status).toBe(422);
  });

  it("an agent adds rows to the picked workbook only after approval, once; text stays text", async () => {
    const created = await call(OPERATOR, "POST", `/api/ops/clients/${A()}/agents`, {
      slug: "receiving-clerk",
      bundle: bundle(LOG.id),
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    expect(j(created.json).errors ?? []).toEqual([]);
    const id = j(created.json).agent.id;
    await call(OPERATOR, "PATCH", `/api/ops/agents/${id}/operation`, { bindings: { excel: conn } });
    const pub = await call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${id}/versions/${j(created.json).version.id}/publish`,
    );
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
    await H.t.db.update(agent).set({ runStatus: "active" }).where(eq(agent.id, id));
    const res = await call(OPERATOR, "POST", `/api/ops/agents/${id}/run`, { workflow: "main" });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const params = H.instances.started.get(j(res.json).runId);
    if (!params) throw new Error("no run started");
    const atWait: number[] = [];
    const step = new FakeWorkflowStep(async (_name, type) => {
      atWait.push(excel.cells(LOG.id, "Log").length);
      const inbox = await call(admin("a"), "GET", "/api/inbox");
      const item = j(inbox.json).items.find(
        (i: { id: string }) => `inbox-${i.id.replace(/-/g, "")}` === type,
      );
      if (!item) throw new Error(`no open item for ${type}`);
      const done = await call(admin("a"), "POST", `/api/inbox/${item.id}/resolve`, {
        decision: "approve",
      });
      expect(done.status, JSON.stringify(done.json)).toBe(200);
      return H.instances.events.find((e) => e.event.type === type)?.event.payload;
    });
    const deps = {
      db: H.db,
      platform: H.platform,
      transport: new FakeModel(),
      instances: H.instances,
      credentials: credentialsFor(H.db, { current: ENCRYPTION_KEY }),
      documents: { content: new ContentStore(H.objects) },
    };
    expect(await executeRun(deps, params, cloudflareStepRunner(step))).toEqual({
      status: "succeeded",
    });
    expect(atWait).toEqual([1]);
    const rows = excel.cells(LOG.id, "Log");
    expect(rows).toHaveLength(2);
    expect(rows[1]?.slice(0, 2)).toEqual(["2026-11-12", "Hardwood Supply"]);
    // Formula-looking text was written as text, never as a formula.
    expect(typeof rows[1]?.[2]).toBe("string");
    const [action] = await H.t.db
      .select()
      .from(externalAction)
      .where(eq(externalAction.runId, params.runId));
    expect(action).toMatchObject({ tool: EXCEL_TOOLS.append, status: "done", connectionId: conn });
    await executeRun(deps, params, cloudflareStepRunner(step));
    expect(excel.cells(LOG.id, "Log")).toHaveLength(2);
    // The unpicked workbook was never touched.
    expect(excel.cells(PAYROLL.id)).toEqual([["Name", "Rate"]]);
  });

  it("never put a token in a response", () => {
    const all = seen.join("\n");
    for (const t of [...excel.issued().accessTokens, ...excel.issued().refreshTokens]) {
      expect(all).not.toContain(t);
    }
  });
});
