// Browser connections through the API (docs/plan.md §1.26 phase 3, M12's done-when), with fakes
// for Browser Run (a fake browser on a fake supplier portal) and the code service: the operator's
// site catalogue, the client admin's setup on the Access page, and an agent with a read-only grant
// that signs in as its agent account with an emailed code, downloads an invoice as a document and
// signs out, while the model's transcript and every tool result hold neither the password nor the
// code. A second agent without the binding is refused, and no response carries the password or a
// kept session's cookies.

import {
  BROWSER_FILE_DOWNLOAD_TOOL,
  BROWSER_PAGE_READ_TOOL,
  ContentStore,
  createBrowserConnector,
  FakeBrowserDriver,
  FakeCodesService,
  FakeSupplierPortal,
  generateEncryptionKey,
} from "@countersign/connectors";
import { FAKE_RESEND_MAIN, fakeResend } from "@countersign/connectors/testing";
import {
  AgentBundle,
  type AgentBundleInput,
  type BrowserSiteProfileInput,
  SkillDefinition,
} from "@countersign/core";
import {
  agent,
  connection,
  connectionChange,
  document,
  event,
  inboxItem,
  message,
  run,
  stepRun,
  toolCall,
} from "@countersign/db";
import { FakeModel, type FakeTurn } from "@countersign/llm";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { releaseDepsFromEnv } from "./access/release";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  FakeWorkflowStep,
  OPERATOR,
  user,
} from "./api.test-helper";
import { codesClient } from "./codes/client";
import type { Bindings } from "./env";
import { credentialsFor, executeRun, type RunDeps } from "./runs/execute";
import { cloudflareStepRunner } from "./runs/step-runner";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const ENCRYPTION_KEY = generateEncryptionKey();
const ORIGIN = "https://portal.supplier.test";
const USERNAME = "agent@client-a.test";
const PASSWORD = "Pw-only-for-the-agent-7731";
const CODE = "481516";
const SKILL = "test.fetch-invoices";

const PROFILE: BrowserSiteProfileInput = {
  login: {
    url: `${ORIGIN}/login`,
    origins: [ORIGIN],
    usernameField: "#user",
    passwordField: "#pass",
    submitButton: "#go",
    secondFactor: {
      kind: "email",
      sender: "@supplier.test",
      pattern: "code is (\\d{6})",
      codeField: "#code",
      codeButton: "#verify",
    },
    signedIn: { selector: "#account" },
  },
  signOut: { url: `${ORIGIN}/logout` },
  allow: [`${ORIGIN}/home`, `${ORIGIN}/invoices*`],
};

const fetchInvoices = SkillDefinition.parse({
  schemaVersion: 1,
  id: SKILL,
  name: "Fetch invoices",
  description: "Read the supplier's invoices and download the open ones",
  category: "test",
  mode: "agent",
  instructions: "Read the invoices page, then download each open invoice.",
  tools: [BROWSER_PAGE_READ_TOOL, BROWSER_FILE_DOWNLOAD_TOOL],
  input: { type: "object", properties: {} },
  output: {
    type: "object",
    properties: {
      answer: { type: "string" },
      sources: { type: "array", items: { type: "string" } },
    },
    required: ["answer"],
  },
});

const codes = new FakeCodesService();
const h = await createApiHarness({
  connectors: () => [createBrowserConnector({ codePoll: { intervalMs: 0, attempts: 5 } })],
  env: { ENCRYPTION_KEY, CODES: codes } as Partial<Bindings>,
  skills: [fetchInvoices],
});
afterAll(() => h?.close());

function bundle(name: string): AgentBundle {
  return AgentBundle.parse({
    schemaVersion: 1,
    definition: {
      schemaVersion: 2,
      identity: { name, role: "fetches supplier invoices", mission: "keep the invoices in" },
      kind: "functional",
      model: { id: "claude-opus-5-5", maxTokens: 1024 },
      instructions: "Only do what the workflow says.",
      skills: [{ skill: SKILL, settings: {} }],
      extraTools: [],
      canCommand: [],
      permissions: { mode: "act" },
      budgets: { maxSteps: 6, maxCostUsd: "0.10" },
      memory: { enabled: false },
    },
    workflows: [
      {
        slug: "main",
        name: "Fetch invoices",
        workflow: {
          schemaVersion: 3,
          trigger: { id: "trg-manual", on: { type: "manual", input: {} } },
          steps: [
            {
              id: "fetch",
              name: "Fetch the invoices",
              kind: "skill",
              skill: SKILL,
              input: {},
              client: { visible: true, label: "Fetched the supplier's invoices" },
            },
          ],
        },
      },
    ],
  } as AgentBundleInput);
}

describe.skipIf(!h)("browser connections through the API", () => {
  const H = h as ApiHarness;
  const A = () => H.A.tenantId;
  const portal = new FakeSupplierPortal({
    username: USERNAME,
    password: PASSWORD,
    codeTo: null,
    code: CODE,
  });
  const driver = new FakeBrowserDriver(portal);
  const content = new ContentStore(H.objects);
  let connectionId = "";
  let clerk = "";
  let stranger = "";

  const deps = (model: FakeModel): RunDeps => ({
    db: H.db,
    platform: H.platform,
    transport: model,
    instances: H.instances,
    credentials: credentialsFor(H.db, { current: ENCRYPTION_KEY }),
    documents: { content },
    browser: {
      open: () => driver.open(),
      codes: codesClient(codes),
      content,
      sleep: async () => {},
    },
  });

  async function makeAgent(slug: string, bindings: Record<string, string>) {
    const created = await H.call(OPERATOR, "POST", `/api/ops/clients/${A()}/agents`, {
      slug,
      bundle: bundle(slug),
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    expect(j(created.json).errors ?? [], JSON.stringify(created.json)).toEqual([]);
    const id = j(created.json).agent.id as string;
    const op = await H.call(OPERATOR, "PATCH", `/api/ops/agents/${id}/operation`, { bindings });
    expect(op.status, JSON.stringify(op.json)).toBe(200);
    const pub = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${id}/versions/${j(created.json).version.id}/publish`,
    );
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
    await H.t.db.update(agent).set({ runStatus: "active" }).where(eq(agent.id, id));
    return id;
  }

  async function runOnce(agentId: string, script: FakeTurn[]) {
    const res = await H.call(OPERATOR, "POST", `/api/ops/agents/${agentId}/run`, {
      workflow: "main",
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const params = H.instances.started.get(j(res.json).runId);
    if (!params) throw new Error("not started");
    const model = new FakeModel(script);
    const result = await executeRun(
      deps(model),
      params,
      cloudflareStepRunner(new FakeWorkflowStep()),
    );
    return { result, model, runId: params.runId };
  }

  describe("the site catalogue (back office)", () => {
    it("is the operator's: clients can't read or change it", async () => {
      for (const who of [admin("a"), user("a")]) {
        expect((await H.call(who, "GET", "/api/ops/browser-sites")).status).toBe(403);
        expect(
          (
            await H.call(who, "POST", "/api/ops/browser-sites", {
              slug: "x",
              name: "X",
              tier: "low",
              notes: "none",
              profile: PROFILE,
            })
          ).status,
        ).toBe(403);
      }
    });

    it("adds a site with its notes, adds versions, sets the tier", async () => {
      const made = await H.call(OPERATOR, "POST", "/api/ops/browser-sites", {
        slug: "supplier",
        name: "Supplier portal",
        tier: "low",
        notes: "Terms allow automated access (checked by J. M., 2026-11-05)",
        profile: PROFILE,
      });
      expect(made.status, JSON.stringify(made.json)).toBe(200);
      expect(j(made.json).site).toMatchObject({
        slug: "supplier",
        tier: "low",
        versions: 1,
        current: { version: 1, profile: { login: { origins: [ORIGIN] } } },
      });
      // A profile that types on a page off its origins is refused.
      const bad = await H.call(OPERATOR, "POST", "/api/ops/browser-sites", {
        slug: "bad",
        name: "Bad",
        tier: "low",
        notes: "none at all",
        profile: { ...PROFILE, login: { ...PROFILE.login, url: "https://evil.test/login" } },
      });
      expect(bad.status).toBe(400);
      expect(
        (
          await H.call(OPERATOR, "POST", "/api/ops/browser-sites", {
            slug: "supplier",
            name: "Again",
            tier: "low",
            notes: "none at all",
            profile: PROFILE,
          })
        ).status,
      ).toBe(409);
      // The same profile again is no new version.
      expect(
        (
          await H.call(OPERATOR, "POST", "/api/ops/browser-sites/supplier/versions", {
            profile: PROFILE,
          })
        ).status,
      ).toBe(409);
      // A tier needs its note.
      expect(
        (await H.call(OPERATOR, "PUT", "/api/ops/browser-sites/supplier/tier", { tier: "medium" }))
          .status,
      ).toBe(400);
      const keeper = await H.call(OPERATOR, "POST", "/api/ops/browser-sites", {
        slug: "keeper",
        name: "Price lists",
        tier: "low",
        notes: "Terms checked by J. M.",
        profile: { ...PROFILE, session: { keep: true } },
      });
      expect(keeper.status, JSON.stringify(keeper.json)).toBe(200);
      const bank = await H.call(OPERATOR, "POST", "/api/ops/browser-sites", {
        slug: "bank",
        name: "A bank",
        tier: "blocked",
        notes: "Banks are never signed in to",
        profile: PROFILE,
      });
      expect(bank.status).toBe(200);
      const list = await H.call(OPERATOR, "GET", "/api/ops/browser-sites");
      expect(
        j(list.json)
          .sites.map((s: { slug: string }) => s.slug)
          .sort(),
      ).toEqual(["bank", "keeper", "supplier"]);
    });
  });

  describe("setting up a browser login (portal)", () => {
    it("offers allowed sites once the browser connector is offered, never blocked ones", async () => {
      const before = await H.call(admin("a"), "GET", "/api/access");
      expect(j(before.json).browserSites).toEqual([]);
      const offer = await H.call(OPERATOR, "PUT", `/api/ops/clients/${A()}/connectors`, {
        offered: ["testkit", "browser"],
      });
      expect(offer.status, JSON.stringify(offer.json)).toBe(200);
      const view = await H.call(admin("a"), "GET", "/api/access");
      expect(j(view.json).browserSites).toEqual([
        { slug: "keeper", name: "Price lists", tier: "low", secondFactor: "email" },
        { slug: "supplier", name: "Supplier portal", tier: "low", secondFactor: "email" },
      ]);
      // The generic API-key form is not offered for browser logins.
      expect(j(view.json).setup.map((s: { connector: string }) => s.connector)).not.toContain(
        "browser",
      );
      expect(j((await H.call(user("a"), "GET", "/api/access")).json).browserSites).toEqual([]);
      expect(
        (await H.call(admin("a"), "POST", "/api/access/browser", { site: "bank" })).status,
      ).toBe(409);
    });

    it("pins the site's version, makes the agent identity, takes the login write-only", async () => {
      expect(
        (await H.call(user("a"), "POST", "/api/access/browser", { site: "supplier" })).status,
      ).toBe(403);
      const set = await H.call(admin("a"), "POST", "/api/access/browser", { site: "supplier" });
      expect(set.status, JSON.stringify(set.json)).toBe(200);
      connectionId = j(set.json).connectionId;
      expect(
        (await H.call(admin("a"), "POST", "/api/access/browser", { site: "supplier" })).status,
      ).toBe(409);
      const [identity] = [...codes.identities.values()];
      expect(identity?.tenantId).toBe(A());
      portal.options.codeTo = { codes, email: identity?.email ?? "" };

      // The login goes through the write-only route, naming its connection.
      expect(
        (
          await H.call(admin("a"), "PUT", "/api/connections/browser/credentials", {
            values: { username: USERNAME, password: PASSWORD },
          })
        ).status,
      ).toBe(422);
      const saved = await H.call(admin("a"), "PUT", "/api/connections/browser/credentials", {
        values: { username: USERNAME, password: PASSWORD },
        connectionId,
      });
      expect(saved.status, JSON.stringify(saved.json)).toBe(200);
      expect(JSON.stringify(saved.json)).not.toContain(PASSWORD);
      const [row] = await H.t.db.select().from(connection).where(eq(connection.id, connectionId));
      expect(row?.status).toBe("connected");
      expect(JSON.stringify(row?.credentialsEncrypted)).not.toContain(PASSWORD);

      const view = await H.call(admin("a"), "GET", "/api/access");
      const item = j(view.json).items.find(
        (i: { connectionId: string }) => i.connectionId === connectionId,
      );
      expect(item).toMatchObject({
        kind: "browser",
        name: "Supplier portal",
        status: "connected",
        secret: {
          set: true,
          fields: [
            { name: "username", set: true, value: USERNAME },
            { name: "password", set: true, value: null },
          ],
        },
        browser: {
          site: { slug: "supplier", tier: "low" },
          effectiveTier: "low",
          siteVersion: 1,
          identity: { email: identity?.email, phone: null },
          stricter: { noWrites: false, personSignIn: false },
          signInsPerDay: 10,
          signInsToday: 0,
          stopped: null,
        },
      });
      expect(j(view.json).browserSites.map((s: { slug: string }) => s.slug)).toEqual(["keeper"]);
    });

    it("lets the client make a login stricter, never looser", async () => {
      const keeperSet = await H.call(admin("a"), "POST", "/api/access/browser", { site: "keeper" });
      const keeperId = j(keeperSet.json).connectionId;
      const path = `/api/access/browser/${keeperId}`;
      const strict = await H.call(admin("a"), "PUT", path, { noWrites: true, personSignIn: false });
      expect(strict.status, JSON.stringify(strict.json)).toBe(200);
      const loose = await H.call(admin("a"), "PUT", path, { noWrites: false, personSignIn: false });
      expect(loose.status).toBe(403);
      expect(j(loose.json).error.code).toBe("loosening");
      expect(
        (await H.call(user("a"), "PUT", path, { noWrites: true, personSignIn: true })).status,
      ).toBe(403);
      // Another client's login is not found.
      expect(
        (await H.call(admin("b"), "PUT", path, { noWrites: true, personSignIn: true })).status,
      ).toBe(404);
    });
  });

  describe("M12: an agent signs in, downloads an invoice and signs out", () => {
    beforeAll(async () => {
      clerk = await makeAgent("invoice-clerk", { "browser:supplier": connectionId });
      // A read-only grant: the agent may read and nothing else.
      const grant = await H.call(
        OPERATOR,
        "PUT",
        `/api/ops/agents/${clerk}/grants/${connectionId}`,
        {
          limits: { verbs: { read: "auto", create: "off", update: "off", delete: "off" } },
        },
      );
      expect(grant.status, JSON.stringify(grant.json)).toBe(200);
      stranger = await makeAgent("stranger", {});
    });

    it("signs in with the emailed code, downloads the invoice as a document, signs out", async () => {
      const read = { site: "supplier", url: `${ORIGIN}/invoices` };
      const pdf = { site: "supplier", url: `${ORIGIN}/invoices/INV-1001.pdf` };
      const { result, model, runId } = await runOnce(clerk, [
        { toolUse: { name: "browser__page__read", input: read } },
        { toolUse: { name: "browser__file__download", input: pdf } },
        { toolUse: { name: "finish", input: { answer: "Downloaded INV-1001" } } },
      ]);
      expect(result).toEqual({ status: "succeeded" });
      // One browser per tool call: each signs in and out on its own.
      expect(portal.signIns).toBe(2);
      expect(portal.signOuts).toBe(2);
      expect(portal.sessions.size).toBe(0);
      expect(driver.closed).toBe(driver.opened);
      // The code was asked for by a wait and handed out once; nothing unsolicited.
      expect(codes.waits.every((w) => w.claimed)).toBe(true);
      expect(codes.alertsRaised).toEqual([]);

      const docs = await H.t.db.select().from(document).where(eq(document.tenantId, A()));
      expect(docs).toHaveLength(1);
      expect(docs[0]).toMatchObject({
        source: "connector",
        connectionId,
        filename: "INV-1001.pdf",
        mimeType: "application/pdf",
        meta: { via: "browser", site: "supplier", sourceUrl: pdf.url },
      });

      const calls = await H.t.db
        .select()
        .from(toolCall)
        .innerJoin(stepRun, eq(stepRun.id, toolCall.stepRunId))
        .where(eq(stepRun.runId, runId));
      expect(calls.map((c) => [c.tool_call.tool, c.tool_call.status])).toEqual([
        [BROWSER_PAGE_READ_TOOL, "succeeded"],
        [BROWSER_FILE_DOWNLOAD_TOOL, "succeeded"],
      ]);
      expect(calls[1]?.tool_call.output).toMatchObject({ documentId: docs[0]?.id });

      // Neither the password nor the code is anywhere the model or a person can see.
      const seen = JSON.stringify({
        requests: model.requests,
        calls,
        steps: await H.t.db.select().from(stepRun).where(eq(stepRun.runId, runId)),
        run: await H.t.db.select().from(run).where(eq(run.id, runId)),
        messages: await H.t.db.select().from(message).where(eq(message.tenantId, A())),
        inbox: await H.t.db.select().from(inboxItem).where(eq(inboxItem.tenantId, A())),
        log: await H.t.db
          .select()
          .from(connectionChange)
          .where(eq(connectionChange.connectionId, connectionId)),
      });
      expect(seen).toContain("INV-1001");
      expect(seen).not.toContain(PASSWORD);
      expect(seen).not.toContain(CODE);
      expect(seen).not.toContain("pending-");

      // The session's record: pages, actions and screenshots after sign-in, signed out.
      const sessions = (
        await H.t.db
          .select()
          .from(connectionChange)
          .where(eq(connectionChange.connectionId, connectionId))
      )
        .map((r) => r.change as Record<string, unknown>)
        .filter((c) => c.kind === "browser_session");
      expect(sessions).toHaveLength(2);
      expect(sessions[1]).toMatchObject({
        tool: BROWSER_FILE_DOWNLOAD_TOOL,
        signIn: "fresh",
        outcome: "done",
        signedOut: true,
        actions: [{ kind: "download", documentId: docs[0]?.id }],
      });
      expect(sessions[0]?.screenshots).toHaveLength(2);
      const view = await H.call(admin("a"), "GET", "/api/access");
      const item = j(view.json).items.find(
        (i: { connectionId: string }) => i.connectionId === connectionId,
      );
      expect(item.browser).toMatchObject({ signInsToday: 2, stopped: null });
      expect(item.agents).toEqual([
        expect.objectContaining({
          agentId: clerk,
          effective: { read: "auto", create: "off", update: "off", delete: "off" },
        }),
      ]);
    });

    it("refuses an agent without the binding", async () => {
      const opened = driver.opened;
      const { result, runId } = await runOnce(stranger, [
        {
          toolUse: {
            name: "browser__page__read",
            input: { site: "supplier", url: `${ORIGIN}/invoices` },
          },
        },
        { toolUse: { name: "finish", input: { answer: "Could not read" } } },
      ]);
      expect(result).toEqual({ status: "succeeded" });
      const calls = await H.t.db
        .select()
        .from(toolCall)
        .innerJoin(stepRun, eq(stepRun.id, toolCall.stepRunId))
        .where(eq(stepRun.runId, runId));
      expect(calls.map((c) => [c.tool_call.status, c.tool_call.output])).toEqual([
        ["refused", { refused: "no browser connection is bound" }],
      ]);
      expect(driver.opened).toBe(opened);
    });

    it("needs a person's release before signing in when the website login asks for one", async () => {
      // Human release (§1.26 phase 4) on the website login: the client admin names herself.
      const on = await H.call(
        admin("a"),
        "PUT",
        `/api/access/connections/${connectionId}/release`,
        {
          mode: "code",
          personId: H.A.admin,
          channel: "email",
          window: "run",
        },
      );
      expect(on.status, JSON.stringify(on.json)).toBe(200);
      const view = await H.call(admin("a"), "GET", "/api/access");
      const login = j(view.json).items.find(
        (i: { connectionId: string }) => i.connectionId === connectionId,
      );
      expect(login.kind).toBe("browser");
      expect(login.release).toMatchObject({ mode: "code", person: { id: H.A.admin } });

      const resend = fakeResend();
      const releaseDeps = releaseDepsFromEnv(
        {
          ...H.env,
          RESEND_API_KEY: FAKE_RESEND_MAIN.apiKey,
          RESEND_FALLBACK_DOMAIN: "mail.mezonas.test",
        } as Bindings,
        { db: H.db, platform: H.platform, instances: H.instances, fetch: resend.fetch },
      );
      const read = { site: "supplier", url: `${ORIGIN}/invoices` };
      const res = await H.call(OPERATOR, "POST", `/api/ops/agents/${clerk}/run`, {
        workflow: "main",
      });
      const params = H.instances.started.get(j(res.json).runId);
      if (!params) throw new Error("not started");
      const opened = driver.opened;
      const signIns = portal.signIns;
      const step = new FakeWorkflowStep(async (_name, type) => {
        // Nothing opened a browser, signed in or reused a kept session before the release.
        expect(driver.opened).toBe(opened);
        expect(portal.signIns).toBe(signIns);
        const code = /(\d{6})\./.exec(resend.emails.at(-1)?.text ?? "")?.[1];
        if (!code) throw new Error("no code emailed");
        const items = j((await H.call(admin("a"), "GET", "/api/inbox")).json).items;
        const item = items.find((i: { id: string }) => `inbox-${i.id.replace(/-/g, "")}` === type);
        const entered = await H.call(admin("a"), "POST", `/api/access/requests/${item.id}/code`, {
          code,
        });
        expect(j(entered.json).result).toBe("released");
        return H.instances.events.find((e) => e.event.type === type)?.event.payload;
      });
      const model = new FakeModel([
        { toolUse: { name: "browser__page__read", input: read } },
        // The step runs again once released; the model starts over.
        { toolUse: { name: "browser__page__read", input: read } },
        { toolUse: { name: "finish", input: { answer: "Read the invoices" } } },
      ]);
      const result = await executeRun(
        { ...deps(model), release: releaseDeps },
        params,
        cloudflareStepRunner(step),
      );
      expect(result).toEqual({ status: "succeeded" });
      expect(step.waits).toHaveLength(1);
      expect(portal.signIns).toBe(signIns + 1);

      // Without the release port (no way to ask), a login that needs one never opens a browser.
      const again = await runOnce(clerk, [
        { toolUse: { name: "browser__page__read", input: read } },
        { toolUse: { name: "finish", input: { answer: "Could not read" } } },
      ]);
      expect(again.result).toEqual({ status: "succeeded" });
      expect(portal.signIns).toBe(signIns + 1);
      const off = await H.call(
        admin("a"),
        "PUT",
        `/api/access/connections/${connectionId}/release`,
        {
          mode: "off",
        },
      );
      expect(off.status).toBe(200);
    });

    it("stops after two failed sign-ins and needs a person; entering the login again starts it", async () => {
      await H.call(admin("a"), "PUT", "/api/connections/browser/credentials", {
        values: { username: USERNAME, password: "a-wrong-password" },
        connectionId,
      });
      const tryRead = () =>
        runOnce(clerk, [
          {
            toolUse: {
              name: "browser__page__read",
              input: { site: "supplier", url: `${ORIGIN}/invoices` },
            },
          },
          { toolUse: { name: "finish", input: { answer: "no" } } },
        ]);
      await tryRead();
      await tryRead();
      const [row] = await H.t.db.select().from(connection).where(eq(connection.id, connectionId));
      expect(row?.status).toBe("error");
      const items = await H.t.db
        .select()
        .from(inboxItem)
        .where(and(eq(inboxItem.tenantId, A()), eq(inboxItem.subjectType, "browser_stop")));
      expect(items.map((i) => i.assigneeRole).sort()).toEqual(["client_admin", "operator"]);
      // The supervisor's event and fingerprint (docs/plan.md §1.28): once, with the stop.
      for (const i of items) {
        expect(j(i.payload).fingerprint).toBe(`login_stopped:${connectionId}`);
      }
      const stops = await H.t.db
        .select()
        .from(event)
        .where(and(eq(event.tenantId, A()), eq(event.type, "connection.needs_attention")));
      expect(stops).toHaveLength(1);
      expect(stops[0]?.payload).toMatchObject({
        connectionId,
        connector: "browser",
        reason: "login_stopped",
      });
      const view = await H.call(admin("a"), "GET", "/api/access");
      const item = j(view.json).items.find(
        (i: { connectionId: string }) => i.connectionId === connectionId,
      );
      expect(item.browser.stopped.reason).toMatch(/2 failed sign-ins/);
      expect(JSON.stringify(view.json)).not.toContain("a-wrong-password");

      await H.call(admin("a"), "PUT", "/api/connections/browser/credentials", {
        values: { username: USERNAME, password: PASSWORD },
        connectionId,
      });
      const back = await H.call(admin("a"), "GET", "/api/access");
      const again = j(back.json).items.find(
        (i: { connectionId: string }) => i.connectionId === connectionId,
      );
      expect(again).toMatchObject({ status: "connected", browser: { stopped: null } });
    });
  });

  it("no response carries the password or a kept session's cookies", async () => {
    // A low-tier site that keeps its session: the cookies are in the vault after a run.
    const view = await H.call(admin("a"), "GET", "/api/access");
    const keeper = j(view.json).items.find(
      (i: { browser: { site: { slug: string } } | null }) => i.browser?.site.slug === "keeper",
    );
    const keeperIdentity = [...codes.identities.values()].find((i) =>
      i.label.startsWith("Price lists"),
    );
    const keeperPortal = portal;
    keeperPortal.options.codeTo = { codes, email: keeperIdentity?.email ?? "" };
    await H.call(admin("a"), "PUT", "/api/connections/browser/credentials", {
      values: { username: USERNAME, password: PASSWORD },
      connectionId: keeper.connectionId,
    });
    const keeperAgent = await makeAgent("price-reader", { "browser:keeper": keeper.connectionId });
    const { result } = await runOnce(keeperAgent, [
      {
        toolUse: {
          name: "browser__page__read",
          input: { site: "keeper", url: `${ORIGIN}/invoices` },
        },
      },
      { toolUse: { name: "finish", input: { answer: "read" } } },
    ]);
    expect(result).toEqual({ status: "succeeded" });
    const cookie = [...portal.sessions][0];
    expect(cookie).toBeTruthy();

    const responses: unknown[] = [];
    for (const [who, path] of [
      [admin("a"), "/api/access"],
      [user("a"), "/api/access"],
      [admin("a"), "/api/connections"],
      [OPERATOR, `/api/ops/clients/${A()}/connections`],
      [OPERATOR, `/api/ops/agents/${keeperAgent}/grants`],
      [OPERATOR, `/api/ops/agents/${clerk}/grants`],
      [OPERATOR, "/api/ops/browser-sites"],
      [admin("a"), "/api/runs"],
      [OPERATOR, `/api/ops/runs?client=${A()}`],
    ] as const) {
      const res = await H.call(who, "GET", path);
      expect(res.status, path).toBe(200);
      responses.push({ path, status: res.status, body: res.json });
    }
    const all = JSON.stringify(responses);
    expect(all).not.toContain(PASSWORD);
    expect(all).not.toContain(cookie as string);
    expect(all).not.toContain(CODE);
  });
});
