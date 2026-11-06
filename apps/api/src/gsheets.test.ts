// v0.14 W4-D (ARCHITECTURE §6.11 row 7, docs/plan.md §1.52): Google Sheets through the API against a
// fake (nothing live). The client admin signs in through the generic OAuth routes with `drive.file`
// only (a broader grant is refused and nothing is kept); tokens go to the vault and never into a
// response. Picked sheets are checked with the connection's own grant before they are kept. A
// workflow appends a row to a picked sheet only after a person approves (approval on by default:
// the step says nothing about it), once, with its before state; replaying the run adds nothing. A
// sheet the client didn't pick is refused.

import {
  createGsheetsConnector,
  GSHEETS_TOOLS,
  generateEncryptionKey,
} from "@countersign/connectors";
import { FAKE_GOOGLE_SHEETS, fakeGoogleSheets } from "@countersign/connectors/testing";
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
  OPERATOR,
  user,
} from "./api.test-helper";
import { credentialsFor, executeRun } from "./runs/execute";
import { cloudflareStepRunner } from "./runs/step-runner";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const ENCRYPTION_KEY = generateEncryptionKey();
const ORIGIN = "https://app.mezonas.test";
const ACCOUNT = "books@acme.example";
const sheets = fakeGoogleSheets();
const budget = sheets.seed("Shop budget", {
  Costs: [
    ["Date", "Vendor", "Amount"],
    ["2026-10-01", "Hardwood Supply", 412.5],
  ],
});
const payroll = sheets.seed("Payroll", { Sheet1: [["Name", "Pay"]] });

const h = await createApiHarness({
  connectors: () => [createGsheetsConnector({ ...FAKE_GOOGLE_SHEETS, fetch: sheets.fetch })],
  env: {
    ENCRYPTION_KEY,
    OAUTH_STATE_SECRET: "state-secret-".repeat(4),
    APP_ORIGIN: ORIGIN,
    GOOGLE_CLIENT_ID: FAKE_GOOGLE_SHEETS.clientId,
    GOOGLE_PICKER_API_KEY: "AIza-fake-picker-key",
    GOOGLE_PROJECT_NUMBER: "123456789012",
  },
});
afterAll(() => h?.close());

function bundle(name: string, input: Record<string, unknown>): AgentBundle {
  return AgentBundle.parse({
    schemaVersion: 1,
    definition: {
      schemaVersion: 2,
      identity: { name, role: "keeps the books", mission: "log costs" },
      kind: "functional",
      model: { id: "claude-opus-5-5", maxTokens: 1024 },
      instructions: "Only do what the workflow says.",
      skills: [],
      extraTools: [GSHEETS_TOOLS.append],
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
              id: "write",
              name: "Write",
              kind: "action",
              tool: GSHEETS_TOOLS.append,
              input,
              client: { visible: true, label: name },
            },
          ],
        },
      },
    ],
  } as AgentBundleInput);
}

describe.skipIf(!h)("Google Sheets through the API", () => {
  const H = h as ApiHarness;
  const A = () => H.A.tenantId;
  const seen: string[] = [];
  const call = async (...args: Parameters<ApiHarness["call"]>) => {
    const res = await H.call(...args);
    seen.push(JSON.stringify(res.json ?? null));
    return res;
  };
  const deps = () => ({
    db: H.db,
    platform: H.platform,
    transport: new FakeModel(),
    instances: H.instances,
    credentials: credentialsFor(H.db, { current: ENCRYPTION_KEY }),
  });
  let conn = "";

  function approver(before: () => void) {
    return new FakeWorkflowStep(async (_name, type) => {
      before();
      const res = await call(admin("a"), "GET", "/api/inbox");
      const item = j(res.json).items.find(
        (i: { id: string }) => `inbox-${i.id.replace(/-/g, "")}` === type,
      );
      if (!item) throw new Error(`no open item for ${type}`);
      const done = await call(admin("a"), "POST", `/api/inbox/${item.id}/resolve`, {
        decision: "approve",
      });
      expect(done.status, JSON.stringify(done.json)).toBe(200);
      return H.instances.events.find((e) => e.event.type === type)?.event.payload;
    });
  }

  async function callback(code: string) {
    const start = await call(admin("a"), "POST", "/api/connections/gsheets/authorize");
    expect(start.status, JSON.stringify(start.json)).toBe(200);
    const redirect = new URL(j(start.json).redirectUrl);
    const state = redirect.searchParams.get("state") ?? "";
    const done = await call(admin("a"), "POST", "/api/connections/gsheets/callback", {
      params: { code, state },
    });
    return { redirect, done };
  }

  async function startRun(agentName: string, input: Record<string, unknown>) {
    const created = await call(OPERATOR, "POST", `/api/ops/clients/${A()}/agents`, {
      slug: agentName.toLowerCase().replace(/[^a-z]+/g, "-"),
      bundle: bundle(agentName, input),
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    const id = j(created.json).agent.id;
    const op = await call(OPERATOR, "PATCH", `/api/ops/agents/${id}/operation`, {
      bindings: { gsheets: conn },
    });
    expect(op.status, JSON.stringify(op.json)).toBe(200);
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
    return params;
  }

  beforeAll(async () => {
    const offer = await call(OPERATOR, "PUT", `/api/ops/clients/${A()}/connectors`, {
      offered: ["testkit", "gsheets"],
    });
    expect(offer.status, JSON.stringify(offer.json)).toBe(200);
  });

  it("refuses a broader grant and keeps nothing, then signs in with drive.file only", async () => {
    const refused = await callback(
      sheets.issueCode({
        address: ACCOUNT,
        scopes: [
          "https://www.googleapis.com/auth/drive.file",
          "https://www.googleapis.com/auth/spreadsheets",
        ],
      }),
    );
    expect(refused.done.status).toBe(422);
    expect(j(refused.done.json).error.code).toBe("sign_in_refused");
    const none = await H.t.db.select().from(connection).where(eq(connection.connector, "gsheets"));
    expect(none).toEqual([]);

    const { redirect, done } = await callback(sheets.issueCode({ address: ACCOUNT }));
    expect(redirect.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive.file");
    expect(redirect.searchParams.get("redirect_uri")).toBe(
      `${ORIGIN}/connections/gsheets/callback`,
    );
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    conn = j(done.json).connection.connection.id;
    const [row] = await H.t.db.select().from(connection).where(eq(connection.id, conn));
    expect(row).toMatchObject({ status: "connected", externalAccountId: ACCOUNT });
    expect(row?.config).toEqual({ address: ACCOUNT, scopes: ["drive.file"] });
    expect(row?.permissions).toMatchObject({
      read: "auto",
      create: "approval",
      update: "approval",
    });
    // The tokens are in the vault, encrypted: none of them in the row as written.
    const stored = JSON.stringify(row?.credentialsEncrypted);
    for (const t of [...sheets.issued().accessTokens, ...sheets.issued().refreshTokens]) {
      expect(stored).not.toContain(t);
    }
  });

  it("serves the Picker's public values to the client admin only", async () => {
    const res = await call(admin("a"), "GET", "/api/connections/gsheets/picker");
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toEqual({
      available: true,
      connectionId: conn,
      account: ACCOUNT,
      developerKey: "AIza-fake-picker-key",
      appId: "123456789012",
      clientId: FAKE_GOOGLE_SHEETS.clientId,
      sheets: [],
    });
    expect((await call(user("a"), "GET", "/api/connections/gsheets/picker")).status).toBe(403);
  });

  it("keeps a picked sheet, and refuses one Google didn't open to this connection", async () => {
    const refused = await call(admin("a"), "PUT", "/api/connections/gsheets/sheets", {
      sheetIds: [payroll.id],
    });
    expect(refused.status).toBe(422);
    expect(j(refused.json).error.code).toBe("sheet_not_available");
    const bad = await call(admin("a"), "PUT", "/api/connections/gsheets/sheets", {
      sheetIds: ["not/a/sheet/id"],
    });
    expect(bad.status).toBe(400);

    sheets.pick(budget.id, ACCOUNT);
    const ok = await call(admin("a"), "PUT", "/api/connections/gsheets/sheets", {
      sheetIds: [budget.id],
    });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(j(ok.json).sheets).toEqual([
      expect.objectContaining({ id: budget.id, name: "Shop budget", usable: true }),
    ]);
    const [row] = await H.t.db.select().from(connection).where(eq(connection.id, conn));
    expect(row?.config).toMatchObject({
      address: ACCOUNT,
      sheets: [{ id: budget.id, name: "Shop budget", account: ACCOUNT }],
    });
  });

  it("appends a row to a picked sheet only after approval, once", async () => {
    const params = await startRun("Cost logger", {
      spreadsheetId: budget.id,
      rows: [["2026-10-07", '=HYPERLINK("https://evil.example")', 129.95]],
    });
    const atWait: number[] = [];
    const step = approver(() => atWait.push(sheets.cells(budget.id).length));
    expect(await executeRun(deps(), params, cloudflareStepRunner(step))).toEqual({
      status: "succeeded",
    });
    // Nothing was added before the approval.
    expect(atWait).toEqual([2]);
    expect(sheets.cells(budget.id)).toEqual([
      ["Date", "Vendor", "Amount"],
      ["2026-10-01", "Hardwood Supply", 412.5],
      ["2026-10-07", '\'=HYPERLINK("https://evil.example")', 129.95],
    ]);
    const [action] = await H.t.db
      .select()
      .from(externalAction)
      .where(eq(externalAction.runId, params.runId));
    expect(action).toMatchObject({
      tool: GSHEETS_TOOLS.append,
      status: "done",
      connectionId: conn,
      approvedBy: H.A.admin,
    });
    expect(action?.before).toMatchObject({ rowCount: 2, nextRow: 3, adding: 1 });
    expect(action?.result).toMatchObject({ range: "A3:C3", alreadyDone: false });

    // The run replayed (a retried Workflow): nothing is added twice.
    await executeRun(deps(), params, cloudflareStepRunner(step));
    expect(sheets.cells(budget.id)).toHaveLength(3);
  });

  it("refuses a sheet the client didn't pick", async () => {
    // Google would open it to this account, but it isn't on the connection's list.
    sheets.pick(payroll.id, ACCOUNT);
    const params = await startRun("Payroll writer", {
      spreadsheetId: payroll.id,
      rows: [["Pat", 1000]],
    });
    const step = approver(() => {});
    const result = await executeRun(deps(), params, cloudflareStepRunner(step)).catch(
      (e: unknown) => ({ status: "threw", error: String(e) }),
    );
    expect(result.status).not.toBe("succeeded");
    expect(sheets.cells(payroll.id)).toEqual([["Name", "Pay"]]);
  });

  it("never put a token in a response", () => {
    const all = seen.join("\n");
    for (const t of [...sheets.issued().accessTokens, ...sheets.issued().refreshTokens]) {
      expect(all).not.toContain(t);
    }
  });
});
