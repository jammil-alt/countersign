// The browser connector's test setup, shared by its tests (./browser.test.ts, ./script.test.ts): a
// fake supplier portal behind a fake browser, a fake code service, and the connector's services in
// memory (the site's pinned version, state, documents, screenshots, the session log, and the
// client's published scripts).

import {
  type BrowserConnectionState,
  BrowserSiteProfile,
  type BrowserSiteProfileInput,
  type BrowserTier,
  type JsonObject,
  type PinnedBrowserSite,
  type PublishedBrowserScript,
} from "@countersign/core";
import type { ToolContext } from "../connector";
import { memoryCredentials } from "../credentials-accessor";
import { runReadTool } from "../invoke";
import { noopLogger } from "../logger";
import {
  BROWSER_FILE_DOWNLOAD_TOOL,
  BROWSER_PAGE_READ_TOOL,
  type BrowserServices,
  type BrowserSessionRecord,
  createBrowserConnector,
  FakeBrowserDriver,
  FakeCodesService,
  FakeSupplierPortal,
  fakeCodesPort,
} from "./index";

export const TENANT = "0190f5e8-8a3c-7d6e-8f00-00000000aaaa";
export const CONNECTION = "0190f5e8-8a3c-7d6e-8f00-00000000cccc";
export const VERSION = "0190f5e8-8a3c-7d6e-8f00-00000000eeee";
export const USERNAME = "agent@client.test";
export const PASSWORD = "S3cret-pass!word";
export const ORIGIN = "https://portal.supplier.test";

export const PROFILE: BrowserSiteProfileInput = {
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

export interface Setup {
  tier?: BrowserTier;
  keep?: boolean;
  stricter?: { noWrites?: boolean; personSignIn?: boolean };
  caps?: JsonObject;
  password?: string;
  codes?: boolean;
  profile?: Partial<BrowserSiteProfileInput>;
  /** The client's published scripts on the site, by slug (none: scripts aren't available). */
  scripts?: Record<string, PublishedBrowserScript>;
}

export function setUp(opts: Setup = {}) {
  const codes = new FakeCodesService();
  const identity = { id: "", email: "" };
  const portal = new FakeSupplierPortal({ username: USERNAME, password: PASSWORD, codeTo: null });
  const driver = new FakeBrowserDriver(portal);
  const state: { value: BrowserConnectionState | null } = { value: null };
  const stops: string[] = [];
  const records: BrowserSessionRecord[] = [];
  const documents: { filename: string; mimeType: string; sourceUrl: string; bytes: Uint8Array }[] =
    [];
  const screenshots: string[] = [];
  const opens: { hosts: string[]; keepAliveMs?: number | undefined }[] = [];
  const profile = BrowserSiteProfile.parse({
    ...PROFILE,
    ...opts.profile,
    session: { keep: opts.keep ?? false },
  });
  let tier: BrowserTier = opts.tier ?? "low";
  const services: BrowserServices = {
    site: async (ref) =>
      ref.slug === "supplier" && ref.versionId === VERSION
        ? ({
            slug: "supplier",
            name: "Supplier portal",
            tier,
            versionId: VERSION,
            version: 1,
            profile,
          } satisfies PinnedBrowserSite)
        : null,
    open: (options) => {
      opens.push(options);
      return driver.open();
    },
    codes: opts.codes === false ? null : fakeCodesPort(codes, TENANT),
    state: {
      get: async () => state.value,
      put: async (next) => {
        state.value = next;
      },
      stop: async (reason) => {
        stops.push(reason);
        connection.status = "error";
      },
    },
    storeDocument: async (file) => {
      documents.push(file);
      return { documentId: `doc-${documents.length}`, created: true };
    },
    saveScreenshot: async () => {
      screenshots.push(`shot-${screenshots.length + 1}`);
      return `shot-${screenshots.length}`;
    },
    record: async (r) => {
      records.push(r);
    },
    sleep: async () => {},
    ...(opts.scripts ? { script: async (slug: string) => opts.scripts?.[slug] ?? null } : {}),
  };
  const connection = {
    id: CONNECTION,
    tenantId: TENANT,
    connector: "browser",
    status: "connected" as "connected" | "error",
    externalAccountId: null,
    config: {
      site: "supplier",
      siteVersionId: VERSION,
      identity: null as JsonObject | null,
      stricter: { noWrites: false, personSignIn: false, ...opts.stricter },
      ...(opts.caps ? { caps: opts.caps } : {}),
    } as JsonObject,
    permissions: { read: "auto", create: "approval", update: "approval", delete: "off" } as const,
  };
  const credentials = memoryCredentials({
    username: USERNAME,
    password: opts.password ?? PASSWORD,
  });
  let now = new Date("2026-11-05T15:00:00Z");
  const ctx: ToolContext = {
    tenantId: TENANT,
    connection,
    credentials,
    logger: noopLogger,
    now: () => now,
    services: { browser: services },
  };
  const connector = createBrowserConnector({ codePoll: { intervalMs: 0, attempts: 3 } });
  return {
    codes,
    portal,
    driver,
    state,
    stops,
    records,
    documents,
    screenshots,
    opens,
    connection,
    credentials,
    connector,
    ctx,
    async identify() {
      const made = await codes.createIdentity({ tenantId: TENANT, label: "Supplier portal" });
      if (!made.ok) throw new Error("no identity");
      identity.id = made.value.id;
      identity.email = made.value.email;
      connection.config = { ...connection.config, identity: { ...identity, phone: null } };
      portal.options.codeTo = { codes, email: identity.email };
    },
    setTier(t: BrowserTier) {
      tier = t;
    },
    later(ms: number) {
      now = new Date(now.getTime() + ms);
    },
    read: (url: string, site = "supplier") =>
      runReadTool(connector, BROWSER_PAGE_READ_TOOL, { site, url }, ctx),
    download: (url: string) =>
      runReadTool(connector, BROWSER_FILE_DOWNLOAD_TOOL, { site: "supplier", url }, ctx),
  };
}

export type S = ReturnType<typeof setUp>;

export async function failure(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  throw new Error("expected a failure");
}
