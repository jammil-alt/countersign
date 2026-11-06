// v0.12 W3-B (M29, docs/plan.md §1.52): Google Drive and Outlook through the API against fakes
// (nothing live). The client admin signs in to each through the generic OAuth routes; Drive makes
// its folder at sign-in; tokens go to the vault and never into a response. A workflow files a
// stored document in Drive by month, and another sends an email from Outlook: each only after a
// person approves (approval on by default: the steps say nothing about it), each once, with its
// before state; replaying the run writes nothing more.

import {
  ContentStore,
  createGdriveConnector,
  createOutlookConnector,
  GDRIVE_TOOLS,
  GOOGLE_DRIVE_AUTH_URL,
  generateEncryptionKey,
  MICROSOFT_AUTH_URL,
  OUTLOOK_SEND_TOOL,
} from "@countersign/connectors";
import {
  FAKE_GOOGLE_DRIVE,
  FAKE_MICROSOFT,
  fakeDriveText,
  fakeGoogleDrive,
  fakeMicrosoft,
} from "@countersign/connectors/testing";
import { AgentBundle, type AgentBundleInput } from "@countersign/core";
import { agent, connection, externalAction, rawRecord, withTenant } from "@countersign/db";
import { storeDocument } from "@countersign/documents";
import { FakeModel } from "@countersign/llm";
import { and, eq } from "drizzle-orm";
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
const MARIA = "maria@proveedor.example";
const drive = fakeGoogleDrive();
const microsoft = fakeMicrosoft();

const h = await createApiHarness({
  connectors: () => [
    createGdriveConnector({ ...FAKE_GOOGLE_DRIVE, fetch: drive.fetch }),
    createOutlookConnector({ ...FAKE_MICROSOFT, fetch: microsoft.fetch }),
  ],
  env: {
    ENCRYPTION_KEY,
    OAUTH_STATE_SECRET: "state-secret-".repeat(4),
    APP_ORIGIN: ORIGIN,
    EMAIL_FORWARDING_DOMAIN: "in.mezonas.test",
  },
});
afterAll(() => h?.close());

function bundle(name: string, tool: string, input: Record<string, unknown>): AgentBundle {
  return AgentBundle.parse({
    schemaVersion: 1,
    definition: {
      schemaVersion: 2,
      identity: { name, role: "keeps the paperwork", mission: "file and ask" },
      kind: "functional",
      model: { id: "claude-opus-5-5", maxTokens: 1024 },
      instructions: "Only do what the workflow says.",
      skills: [],
      extraTools: [tool],
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
              tool,
              input,
              client: { visible: true, label: name },
            },
          ],
        },
      },
    ],
  } as AgentBundleInput);
}

describe.skipIf(!h)("Google Drive and Outlook through the API", () => {
  const H = h as ApiHarness;
  const A = () => H.A.tenantId;
  /** Every response read, to look for a token in any of them. */
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

  /** Approves the item the run waits on as client A's admin; `before` runs first. */
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

  async function signIn(connector: string, params: Record<string, string>) {
    const start = await call(admin("a"), "POST", `/api/connections/${connector}/authorize`);
    expect(start.status, JSON.stringify(start.json)).toBe(200);
    const redirect = new URL(j(start.json).redirectUrl);
    expect(redirect.searchParams.get("redirect_uri")).toBe(
      `${ORIGIN}/connections/${connector}/callback`,
    );
    const state = redirect.searchParams.get("state") ?? "";
    const done = await call(admin("a"), "POST", `/api/connections/${connector}/callback`, {
      params: { ...params, state },
    });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    return { redirect, connection: j(done.json).connection.connection };
  }

  async function startRun(
    agentName: string,
    tool: string,
    input: Record<string, unknown>,
    bindings: Record<string, string>,
  ) {
    const created = await call(OPERATOR, "POST", `/api/ops/clients/${A()}/agents`, {
      slug: agentName.toLowerCase().replace(/[^a-z]+/g, "-"),
      bundle: bundle(agentName, tool, input),
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    expect(j(created.json).errors ?? []).toEqual([]);
    const id = j(created.json).agent.id;
    const op = await call(OPERATOR, "PATCH", `/api/ops/agents/${id}/operation`, { bindings });
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

  const actionsOf = (runId: string) =>
    H.t.db.select().from(externalAction).where(eq(externalAction.runId, runId));

  beforeAll(async () => {
    const offer = await call(OPERATOR, "PUT", `/api/ops/clients/${A()}/connectors`, {
      offered: ["testkit", "gdrive", "outlook"],
    });
    expect(offer.status, JSON.stringify(offer.json)).toBe(200);
    const fwd = await call(admin("a"), "GET", "/api/connections/upload/forwarding");
    expect(fwd.status, JSON.stringify(fwd.json)).toBe(200);
    const made = await call(admin("a"), "POST", "/api/contacts", {
      name: "María Núñez",
      email: MARIA,
      language: "es",
      consent: { channels: ["email"], source: "signed the supplier agreement" },
    });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
  });

  describe("Google Drive", () => {
    let driveConn = "";

    it("signs in through the generic routes with drive.file only and makes the folder", async () => {
      const { redirect, connection: conn } = await signIn("gdrive", {
        code: drive.issueCode({ address: "books@acme.example" }),
        folder_name: "Acme Millwork",
      });
      expect(`${redirect.origin}${redirect.pathname}`).toBe(GOOGLE_DRIVE_AUTH_URL);
      expect(redirect.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive.file");
      expect(conn).toMatchObject({ status: "connected", externalAccountId: "books@acme.example" });
      driveConn = conn.id;
      const [row] = await H.t.db.select().from(connection).where(eq(connection.id, driveConn));
      const folder = [...drive.files.values()].find((f) => f.name === "Mezonas - Acme Millwork");
      expect(row?.config).toMatchObject({
        folderId: folder?.id,
        folderName: "Mezonas - Acme Millwork",
        scopes: ["drive.file"],
      });
      expect(row?.permissions).toMatchObject({ read: "auto", create: "approval", delete: "off" });
      const stored = JSON.stringify(row?.credentialsEncrypted);
      for (const t of [...drive.issued().accessTokens, ...drive.issued().refreshTokens]) {
        expect(stored).not.toContain(t);
      }
    });

    it("files a document by month only after approval, once, with its before state", async () => {
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
      const params = await startRun(
        "Filing clerk",
        GDRIVE_TOOLS.upload,
        { documentId: doc.document.id, path: "Bills/{yyyy}/{MM}", date: "2026-10-15" },
        { gdrive: driveConn },
      );
      const atWait: number[] = [];
      const step = approver(() => atWait.push(drive.uploaded().length));
      expect(await executeRun(deps(), params, cloudflareStepRunner(step))).toEqual({
        status: "succeeded",
      });
      // Nothing was filed before the approval.
      expect(atWait).toEqual([0]);
      const filed = drive.uploaded();
      expect(filed.map((f) => f.path)).toEqual([
        "Mezonas - Acme Millwork/Bills/2026/10/hardwood-INV-1042.pdf",
      ]);
      expect(fakeDriveText(filed[0] as never)).toBe(new TextDecoder().decode(pdf));
      const [action] = await actionsOf(params.runId);
      expect(action).toMatchObject({
        tool: GDRIVE_TOOLS.upload,
        status: "done",
        connectionId: driveConn,
        approvedBy: H.A.admin,
      });
      expect(action?.before).toMatchObject({
        path: "Bills/2026/10",
        fileName: "hardwood-INV-1042.pdf",
        exists: false,
        folderExists: false,
      });
      expect(action?.result).toMatchObject({ fileId: filed[0]?.id, alreadyDone: false });

      // The run replayed (a retried Workflow): nothing is filed twice.
      await executeRun(deps(), params, cloudflareStepRunner(step));
      expect(drive.uploaded()).toHaveLength(1);
    });
  });

  describe("Outlook", () => {
    let outlookConn = "";

    it("signs in through the generic routes with Mail.Send and no read scope", async () => {
      const { redirect, connection: conn } = await signIn("outlook", {
        code: microsoft.issueCode({ address: "pat.lee@acme.example" }),
      });
      expect(`${redirect.origin}${redirect.pathname}`).toBe(MICROSOFT_AUTH_URL);
      expect(redirect.searchParams.get("scope")).toBe(
        "openid email offline_access https://graph.microsoft.com/Mail.Send",
      );
      expect(conn).toMatchObject({
        status: "connected",
        externalAccountId: "pat.lee@acme.example",
      });
      outlookConn = conn.id;
      const [row] = await H.t.db.select().from(connection).where(eq(connection.id, outlookConn));
      expect(row?.config).toEqual({ address: "pat.lee@acme.example", scopes: ["Mail.Send"] });
      expect(row?.permissions).toMatchObject({ create: "approval", delete: "off" });

      // A grant that could read mail is refused, and nothing is kept.
      const start = await call(admin("a"), "POST", "/api/connections/outlook/authorize");
      const state = new URL(j(start.json).redirectUrl).searchParams.get("state") ?? "";
      const refused = await call(admin("a"), "POST", "/api/connections/outlook/callback", {
        params: {
          code: microsoft.issueCode({ scopes: ["Mail.Send", "Mail.Read", "openid"] }),
          state,
        },
      });
      expect(refused.status).toBe(422);
      expect(j(refused.json).error.code).toBe("sign_in_refused");
    });

    it("sends an approved email once: a replayed run doesn't send again", async () => {
      const params = await startRun(
        "Orders desk",
        OUTLOOK_SEND_TOOL,
        {
          to: MARIA,
          subject: "Entrega del viernes",
          text: "Hola María, ¿confirma la entrega del viernes?",
        },
        { outlook: outlookConn },
      );
      const atWait: number[] = [];
      const step = approver(() => atWait.push(microsoft.sent.length));
      expect(await executeRun(deps(), params, cloudflareStepRunner(step))).toEqual({
        status: "succeeded",
      });
      expect(atWait).toEqual([0]);
      expect(microsoft.sent).toHaveLength(1);
      expect(microsoft.sent[0]?.account).toBe("pat.lee@acme.example");
      expect(microsoft.sent[0]?.body.message.toRecipients).toEqual([
        { emailAddress: { address: MARIA } },
      ]);
      const [action] = await actionsOf(params.runId);
      expect(action).toMatchObject({
        tool: OUTLOOK_SEND_TOOL,
        status: "done",
        connectionId: outlookConn,
        approvedBy: H.A.admin,
      });
      expect(action?.before).toMatchObject({
        contact: { name: "María Núñez" },
        to: MARIA,
        from: "pat.lee@acme.example",
        subject: "Entrega del viernes",
      });
      // The attempt was recorded before Graph was called, and the email once in María's thread.
      const records = await H.t.db
        .select()
        .from(rawRecord)
        .where(and(eq(rawRecord.connectionId, outlookConn)));
      expect(records.map((r) => r.entityType).sort()).toEqual(["EmailAttempt", "EmailMessage"]);
      expect(records.every((r) => r.connector === "outlook")).toBe(true);

      await executeRun(deps(), params, cloudflareStepRunner(step));
      expect(microsoft.sent).toHaveLength(1);
    });

    it("never put a token in a response", () => {
      const all = seen.join("\n");
      for (const t of [
        ...drive.issued().accessTokens,
        ...drive.issued().refreshTokens,
        ...microsoft.issued().accessTokens,
        ...microsoft.issued().refreshTokens,
      ]) {
        expect(all).not.toContain(t);
      }
    });
  });
});
