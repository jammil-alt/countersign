// v0.16 (docs/plan.md §1.86): a browsing skill's calls through callTool with its scope, against
// the real browser connector and a fake supplier portal: refused before the gate and the browser,
// logged like any refusal; limits; and what finishScope keeps (paths, a script draft).

import {
  BROWSE_SCRIPT_DRAFT_SUBJECT,
  BROWSER_PAGE_READ_TOOL,
  type BrowserServices,
  BrowseScope,
  type ConnectionRef,
  ConnectorRegistry,
  createBrowserConnector,
  FakeBrowserDriver,
  FakeSupplierPortal,
  memoryCredentials,
} from "@countersign/connectors";
import {
  type BrowserConnectionState,
  BrowserSiteProfile,
  type JsonObject,
} from "@countersign/core";
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../registry/tools";
import { PLATFORM_TOOLS } from "../tools/platform";
import { callTool, finishScope, type ToolCallScope } from "./call-tool";
import type { RuntimeDeps, StepContext } from "./context";

const TENANT = "0190f5e8-8a3c-7d6e-8f00-00000000aaaa";
const CONNECTION = "0190f5e8-8a3c-7d6e-8f00-00000000cccc";
const VERSION = "0190f5e8-8a3c-7d6e-8f00-00000000eeee";
const ORIGIN = "https://portal.supplier.test";
const USERNAME = "agent@client.test";
const PASSWORD = "S3cret-pass!word";

function setUp(mode: "live" | "test" = "live") {
  const portal = new FakeSupplierPortal({ username: USERNAME, password: PASSWORD, codeTo: null });
  const driver = new FakeBrowserDriver(portal);
  let state: BrowserConnectionState | null = null;
  let shots = 0;
  const profile = BrowserSiteProfile.parse({
    login: {
      url: `${ORIGIN}/login`,
      origins: [ORIGIN],
      usernameField: "#user",
      passwordField: "#pass",
      submitButton: "#go",
      secondFactor: { kind: "none" },
      signedIn: { selector: "#account" },
    },
    signOut: { url: `${ORIGIN}/logout` },
    allow: [`${ORIGIN}/home`, `${ORIGIN}/invoices*`, `${ORIGIN}/statements*`],
  });
  const services: BrowserServices = {
    site: async () => ({
      slug: "supplier",
      name: "Supplier portal",
      tier: "low",
      versionId: VERSION,
      version: 1,
      profile,
    }),
    open: () => driver.open(),
    codes: null,
    state: {
      get: async () => state,
      put: async (next) => {
        state = next;
      },
      stop: async () => {},
    },
    storeDocument: async () => ({ documentId: "doc-1", created: true }),
    saveScreenshot: async () => `shot-${++shots}`,
    record: async () => {},
    sleep: async () => {},
  };
  const conn: ConnectionRef = {
    id: CONNECTION,
    tenantId: TENANT,
    connector: "browser",
    status: "connected",
    externalAccountId: null,
    config: {
      site: "supplier",
      siteVersionId: VERSION,
      identity: null,
      stricter: { noWrites: false, personSignIn: false },
    } as JsonObject,
    permissions: { read: "auto", create: "approval", update: "approval", delete: "off" },
  };
  const logged: { start: unknown[]; finish: unknown[] } = { start: [], finish: [] };
  const notes: { id: string; note: string; scope: string; createdAt: Date }[] = [];
  const items: unknown[] = [];
  const deps = {
    tools: new ToolRegistry({
      platform: PLATFORM_TOOLS,
      connectors: new ConnectorRegistry([
        createBrowserConnector({ codePoll: { intervalMs: 0, attempts: 1 } }),
      ]),
    }),
    ports: {
      log: {
        startToolCall: async (_t: string, call: unknown) => {
          logged.start.push(call);
          return `tc${logged.start.length}`;
        },
        finishToolCall: async (_t: string, _id: string, done: unknown) => {
          logged.finish.push(done);
        },
      },
      store: {
        connection: async () => conn,
        grant: async () => null,
        // The live notes only, as the store answers (a test run's are not read back).
        memoryNotes: async () => notes.filter((n) => n.scope === "agent"),
      },
      platform: {
        writeMemory: async (_t: string, n: { note: string; scope: string }) => {
          notes.push({ id: `m${notes.length + 1}`, createdAt: new Date(), ...n });
          return { id: `m${notes.length}` };
        },
        createInboxItem: async (_t: string, item: unknown) => {
          items.push(item);
          return { id: `i${items.length}` };
        },
      },
    },
    credentials: () => memoryCredentials({ username: USERNAME, password: PASSWORD }),
    services: () => ({ browser: services }),
  } as unknown as RuntimeDeps;
  const step = {
    tenantId: TENANT,
    runId: "r1",
    stepRunId: "s1",
    stepId: "find",
    mode,
    agent: {
      agentId: "a1",
      agentVersionId: "v1",
      bindings: { "browser:supplier": CONNECTION },
      bundle: { definition: { permissions: { mode: "act" } } },
    },
    externalIndex: { next: 0 },
  } as unknown as StepContext;
  const scope = new BrowseScope({
    skill: "custom:find-invoice",
    browse: { sites: ["supplier"], pages: ["/invoices", "/invoices/*"] },
    goal: "Find the invoice for PO-77",
    limits: { pages: 2 },
  });
  const read = (url: string, s: ToolCallScope = scope) =>
    callTool(deps, step, {
      toolId: BROWSER_PAGE_READ_TOOL,
      input: { site: "supplier", url },
      allowed: new Set([BROWSER_PAGE_READ_TOOL]),
      scope: s,
    });
  return { deps, step, scope, read, driver, portal, logged, notes, items };
}

describe("callTool with a browsing skill's scope", () => {
  it("refuses off-site, protocol-relative and traversing addresses before the gate, and logs it", async () => {
    const t = setUp();
    for (const url of [
      "//elsewhere.test/invoices",
      `${ORIGIN}/invoices/../statements`,
      `${ORIGIN}/invoices/%2E%2E/statements`,
      `${ORIGIN}/statements`,
    ]) {
      expect(await t.read(url)).toMatchObject({ status: "refused" });
    }
    expect(t.logged.finish).toHaveLength(4);
    expect(t.logged.finish.every((f) => (f as { status: string }).status === "refused")).toBe(true);
    // Another host on a listed path: the scope can't know the site's hosts, so the connector
    // refuses it with the site's rules, still before a browser opens or a sign-in is spent.
    expect(await t.read("https://elsewhere.test/invoices")).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/not one agents may open/),
    });
    expect(t.driver.opened).toBe(0);
    expect(t.portal.signIns).toBe(0);
  });

  it("reads a listed page with the skill's pages as `within`, then asks for help at the limit", async () => {
    const t = setUp();
    const first = await t.read(`${ORIGIN}/invoices`);
    expect(first).toMatchObject({ status: "done", output: { url: `${ORIGIN}/invoices` } });
    // What the connector got (and the log shows): the skill's pages, not the model's.
    expect(t.logged.start[0]).toMatchObject({
      input: { site: "supplier", url: `${ORIGIN}/invoices`, within: ["/invoices", "/invoices/*"] },
    });
    // A redirect off the skill's pages fails in the connector and counts as tried.
    expect(await t.read(`${ORIGIN}/invoices/to-statements`)).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/not one of this skill's pages/),
    });
    expect(await t.read(`${ORIGIN}/invoices/INV-1002`)).toMatchObject({
      status: "refused",
      reason: expect.stringMatching(/limit of 2 pages/),
    });
    expect(t.scope.overLimit("0.02")).toBe("pages");
    const help = t.scope.needsHelp();
    expect(help.tried).toEqual([
      "Looked for: Find the invoice for PO-77",
      `Read ${ORIGIN}/invoices`,
      expect.stringMatching(/^Could not open .*to-statements: .*not one of this skill's pages/),
      expect.stringMatching(/^Refused .*INV-1002/),
    ]);
    expect(help.screenshots).toEqual(["shot-2"]);
  });

  it("keeps a path that worked, and offers a script draft to the operator the second time", async () => {
    const t = setUp();
    await t.read(`${ORIGIN}/invoices`);
    expect(await finishScope(t.deps, t.step, t.scope)).toMatchObject({
      memory: [expect.stringMatching(/^\[browse-path skill=custom:find-invoice /)],
    });
    expect(t.items).toEqual([]);

    const again = new BrowseScope({
      skill: "custom:find-invoice@2",
      browse: { sites: ["supplier"], pages: ["/invoices", "/invoices/*"] },
      goal: "Find the invoice for PO-77",
    });
    await t.read(`${ORIGIN}/invoices`, again);
    await finishScope(t.deps, t.step, again);
    expect(t.items).toEqual([
      expect.objectContaining({
        kind: "review",
        assigneeRole: "operator",
        subjectType: BROWSE_SCRIPT_DRAFT_SUBJECT,
        agentId: "a1",
        runId: "r1",
        payload: expect.objectContaining({
          stepId: "find",
          agentVersionId: "v1",
          draft: expect.objectContaining({
            steps: [expect.objectContaining({ site: "supplier", page: "/invoices" })],
          }),
        }),
      }),
    ]);
    // Offered once.
    await finishScope(t.deps, t.step, again);
    expect(t.items).toHaveLength(1);
  });

  it("a test run keeps its notes in its own scope and never offers a draft", async () => {
    const t = setUp("test");
    for (let i = 0; i < 2; i++) {
      const s = new BrowseScope({
        skill: "custom:find-invoice",
        browse: { sites: ["supplier"], pages: ["/invoices"] },
        goal: "Find it",
      });
      await t.read(`${ORIGIN}/invoices`, s);
      await finishScope(t.deps, t.step, s);
    }
    expect(t.notes.map((n) => n.scope)).toEqual(["test-run:r1", "test-run:r1"]);
    expect(t.items).toEqual([]);
  });
});
