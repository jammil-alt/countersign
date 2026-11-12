// §1.97: OneDrive through the API against a fake (nothing live). The client admin signs in through
// the generic OAuth routes with the app folder only; tokens go to the vault and never into a
// response. Google Drive is registered beside it and both supply `drive.file.upload`: a workflow
// that names that tool files the document in OneDrive because the agent is bound to OneDrive, only
// after a person approves (approval on by default), once; replaying the run files nothing more.

import {
  ContentStore,
  createGdriveConnector,
  createOnedriveConnector,
  generateEncryptionKey,
  MICROSOFT_AUTH_URL,
  ONEDRIVE_TOOLS,
} from "@countersign/connectors";
import {
  FAKE_GOOGLE_DRIVE,
  FAKE_MICROSOFT_APP,
  fakeGoogleDrive,
  fakeOnedrive,
} from "@countersign/connectors/testing";
import { AgentBundle, type AgentBundleInput } from "@countersign/core";
import { agent, connection, externalAction, withTenant } from "@countersign/db";
import { storeDocument } from "@countersign/documents";
import { FakeModel } from "@countersign/llm";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  FakeWorkflowStep,
  OPERATOR,
} from "./api.test-helper";
import { credentialsFor, executeRun } from "./runs/execute";
import { cloudflareStepRunner } from "./runs/step-runner";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const ENCRYPTION_KEY = generateEncryptionKey();
const ORIGIN = "https://app.mezonas.test";
const gdrive = fakeGoogleDrive();
const onedrive = fakeOnedrive();

const h = await createApiHarness({
  connectors: () => [
    createGdriveConnector({ ...FAKE_GOOGLE_DRIVE, fetch: gdrive.fetch }),
    createOnedriveConnector({ ...FAKE_MICROSOFT_APP, fetch: onedrive.fetch }),
  ],
  env: {
    ENCRYPTION_KEY,
    OAUTH_STATE_SECRET: "state-secret-".repeat(4),
    APP_ORIGIN: ORIGIN,
  },
});
afterAll(() => h?.close());

function bundle(input: Record<string, unknown>): AgentBundle {
  return AgentBundle.parse({
    schemaVersion: 1,
    definition: {
      schemaVersion: 2,
      identity: { name: "Filing clerk", role: "keeps the paperwork", mission: "file bills" },
      kind: "functional",
      model: { id: "claude-opus-5-5", maxTokens: 1024 },
      instructions: "Only do what the workflow says.",
      skills: [],
      extraTools: [ONEDRIVE_TOOLS.upload],
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
              id: "file",
              name: "File it",
              kind: "action",
              tool: ONEDRIVE_TOOLS.upload,
              input,
              client: { visible: true, label: "File it" },
            },
          ],
        },
      },
    ],
  } as AgentBundleInput);
}

describe.skipIf(!h)("OneDrive through the API", () => {
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
    documents: { content: new ContentStore(H.objects) },
  });
  let conn = "";

  beforeAll(async () => {
    const offer = await call(OPERATOR, "PUT", `/api/ops/clients/${A()}/connectors`, {
      offered: ["testkit", "gdrive", "onedrive"],
    });
    expect(offer.status, JSON.stringify(offer.json)).toBe(200);
  });

  it("signs in through the generic routes with the app folder only", async () => {
    const start = await call(admin("a"), "POST", "/api/connections/onedrive/authorize");
    expect(start.status, JSON.stringify(start.json)).toBe(200);
    const redirect = new URL(j(start.json).redirectUrl);
    expect(`${redirect.origin}${redirect.pathname}`).toBe(MICROSOFT_AUTH_URL);
    expect(redirect.searchParams.get("redirect_uri")).toBe(
      `${ORIGIN}/connections/onedrive/callback`,
    );
    expect(redirect.searchParams.get("scope")).toBe(
      "openid email offline_access https://graph.microsoft.com/Files.ReadWrite.AppFolder",
    );
    const state = redirect.searchParams.get("state") ?? "";

    // A grant that could reach every file is refused, and nothing is kept.
    const refused = await call(admin("a"), "POST", "/api/connections/onedrive/callback", {
      params: {
        code: onedrive.issueCode({ scopes: ["Files.ReadWrite", "openid", "offline_access"] }),
        state,
      },
    });
    expect(refused.status).toBe(422);
    expect(j(refused.json).error.code).toBe("sign_in_refused");

    const again = await call(admin("a"), "POST", "/api/connections/onedrive/authorize");
    const state2 = new URL(j(again.json).redirectUrl).searchParams.get("state") ?? "";
    const done = await call(admin("a"), "POST", "/api/connections/onedrive/callback", {
      params: { code: onedrive.issueCode({ address: "books@acme.example" }), state: state2 },
    });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    const c = j(done.json).connection.connection;
    expect(c).toMatchObject({ status: "connected", externalAccountId: "books@acme.example" });
    conn = c.id;
    const [row] = await H.t.db.select().from(connection).where(eq(connection.id, conn));
    expect(row?.config).toMatchObject({
      folderId: onedrive.appRoot(),
      folderName: "Mezonas",
      scopes: ["Files.ReadWrite.AppFolder"],
    });
    expect(row?.permissions).toMatchObject({ read: "auto", create: "approval", delete: "off" });
    const stored = JSON.stringify(row?.credentialsEncrypted);
    for (const t of [
      ...onedrive.identity.issued().accessTokens,
      ...onedrive.identity.issued().refreshTokens,
    ]) {
      expect(stored).not.toContain(t);
    }
  });

  it("files Drive's workflow in OneDrive by the agent's binding, after approval, once", async () => {
    const pdf = new TextEncoder().encode("%PDF-1.4\n% Hardwood Supply INV-1042\n%%EOF\n");
    const doc = await withTenant(H.db, A(), (tx) =>
      storeDocument(tx, new ContentStore(H.objects), {
        tenantId: A(),
        source: "upload",
        connectionId: null,
        bytes: pdf,
        filename: "hardwood-INV-1042.pdf",
        mimeType: "application/pdf",
      }),
    );
    const created = await call(OPERATOR, "POST", `/api/ops/clients/${A()}/agents`, {
      slug: "filing-clerk",
      bundle: bundle({
        documentId: doc.document.id,
        path: "Bills/{yyyy}/{MM}",
        date: "2026-10-15",
      }),
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    expect(j(created.json).errors ?? []).toEqual([]);
    const id = j(created.json).agent.id;
    const op = await call(OPERATOR, "PATCH", `/api/ops/agents/${id}/operation`, {
      bindings: { onedrive: conn },
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

    const atWait: (string | undefined)[] = [];
    const step = new FakeWorkflowStep(async (_name, type) => {
      atWait.push(onedrive.text("Bills/2026/10/hardwood-INV-1042.pdf"));
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
    expect(await executeRun(deps(), params, cloudflareStepRunner(step))).toEqual({
      status: "succeeded",
    });
    // Nothing was filed before the approval, and nothing went to Google Drive.
    expect(atWait).toEqual([undefined]);
    expect(onedrive.text("Bills/2026/10/hardwood-INV-1042.pdf")).toBe(
      new TextDecoder().decode(pdf),
    );
    expect(gdrive.uploaded()).toHaveLength(0);
    const [action] = await H.t.db
      .select()
      .from(externalAction)
      .where(eq(externalAction.runId, params.runId));
    expect(action).toMatchObject({
      tool: ONEDRIVE_TOOLS.upload,
      status: "done",
      connectionId: conn,
      approvedBy: H.A.admin,
    });
    expect(action?.before).toMatchObject({
      path: "Bills/2026/10",
      fileName: "hardwood-INV-1042.pdf",
      exists: false,
      folderExists: false,
    });
    expect(action?.result).toMatchObject({ name: "hardwood-INV-1042.pdf", alreadyDone: false });

    // The run replayed (a retried Workflow): nothing is filed twice.
    await executeRun(deps(), params, cloudflareStepRunner(step));
    expect(onedrive.requests.filter((r) => r.method === "PUT")).toHaveLength(1);
  });

  it("never put a token in a response", () => {
    const all = seen.join("\n");
    for (const t of [
      ...onedrive.identity.issued().accessTokens,
      ...onedrive.identity.issued().refreshTokens,
    ]) {
      expect(all).not.toContain(t);
    }
  });
});
