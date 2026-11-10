// "browser": an agent working in a website that has no API (ARCHITECTURE §6.10, docs/plan.md
// §1.26 phase 3), on an operator-allowed site, signed in by our code as a dedicated agent account.
// A client has one browser connection per site; agents bind one by `browser:<site slug>` and pass
// `site` in each tool's input. The model gets page data only: `browser.page.read` (text and
// tables of an allowed page) and `browser.file.download` (a file into documents, as uploads are).
// No form submit yet: it comes after the pilot, as an external action behind approval.
// v0.16 (docs/plan.md §1.86): an `ai` skill that declares `browse` reaches these tools only through
// its scope (./scope.ts), which sets `within` to the skill's pages.

import { BrowsePage, BrowserSiteSlug } from "@countersign/core";
import { z } from "zod";
import { type Connector, defineConnector, defineReadTool } from "../connector";
import { isDocumentType } from "../upload/forwarding";
import { BROWSER_CONNECTOR_ID, BROWSER_FILE_DOWNLOAD_TOOL, BROWSER_PAGE_READ_TOOL } from "./ids";
import { type BrowserSessionOptions, inBrowserSession } from "./session";
import { BrowserRefused } from "./sign-in";

export * from "./driver";
export * from "./fake";
export * from "./ids";
export * from "./playwright";
export * from "./scope";
export * from "./services";
export {
  type BrowserCall,
  type HeldBrowserSession,
  holdBrowserSession,
  inBrowserSession,
  Redactor,
  type SignedInPage,
  withBrowserSession,
} from "./session";
export {
  BrowserCapReached,
  BrowserRefused,
  BrowserStop,
  checkForStops,
  isSignedIn,
  PLATFORM_STOP_SELECTORS,
  SignInFailed,
  signIn,
  signOut,
} from "./sign-in";

/** The most page text a read returns (characters); the rest is cut and `truncated` says so. */
export const BROWSER_TEXT_MAX = 60_000;

const Site = BrowserSiteSlug.describe("The site's slug, as the agent's binding names it");
const Url = z.string().min(1).max(2000).describe("An address on the site, one agents may open");
// DECISION: a browsing skill's pages travel in the input, the only thing that reaches the connector
// from a call. They can only narrow (a page must match the site's allowed pages too), and the
// skill's scope always replaces whatever the model wrote here.
const Within = z
  .array(BrowsePage)
  .min(1)
  .max(50)
  .optional()
  .describe("Set by the platform for a skill that browses: only pages matching these open");

const PageReadInput = z.strictObject({ site: Site, url: Url, within: Within });
const PageReadOutput = z.object({
  url: z.string(),
  text: z.string(),
  tables: z.array(z.object({ headers: z.array(z.string()), rows: z.array(z.array(z.string())) })),
  truncated: z.boolean(),
  /** A browsing skill's read only: the page's evidence screenshot (its storage key). */
  screenshot: z.string().optional(),
});

const DownloadInput = z.strictObject({ site: Site, url: Url, within: Within });
const DownloadOutput = z.object({
  documentId: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  url: z.string(),
  /** True when the client already had this exact file: the existing document is returned. */
  alreadyHad: z.boolean(),
});

export interface BrowserConnectorOptions {
  /** Whether this deployment has a browser (Browser Run's binding); false: "not available yet". */
  available?: boolean;
  codePoll?: BrowserSessionOptions["codePoll"];
}

// DECISION: one browser per tool call, signed in and out within the call (or, low tier, keeping
// the session): tool calls have no step-end hook to close a browser kept across a step's calls, and
// a session left open is a risk for nothing. Each call that signs in counts toward the daily cap.
// v0.16: except a browsing skill's calls, which the run's scope closes at its end: those share
// one session per site for the skill run (./session.ts `inBrowserSession`).
export function createBrowserConnector(options: BrowserConnectorOptions = {}): Connector {
  const session: BrowserSessionOptions = {
    codePoll: options.codePoll ?? { intervalMs: 2_000, attempts: 45 },
  };
  return defineConnector({
    id: BROWSER_CONNECTOR_ID,
    name: "Website logins",
    description:
      "An agent signs in to a website we allow as its own agent account, reads pages and downloads files. We sign in, never the agent; it never sees the password or a code.",
    icon: "globe",
    // The agent account's login is entered by the client admin, like an API key (write-only).
    auth: "api_key",
    credentialFields: [
      {
        name: "username",
        label: "Agent account username",
        secret: false,
        hint: "The account you made on the site for our agent, with the smallest role that does the job.",
      },
      { name: "password", label: "Agent account password", secret: true },
    ],
    entities: [],
    // v0.12 W2-A: record types for the matrix (docs/plan.md §1.44).
    permissionEntities: [
      { id: "page", label: "Pages", verbs: ["read"] },
      { id: "file", label: "Files", verbs: ["read"] },
    ],
    isConfigured: () => options.available !== false,
    bindingKey(input) {
      const site = BrowserSiteSlug.safeParse((input as { site?: unknown } | null)?.site);
      return site.success ? `${BROWSER_CONNECTOR_ID}:${site.data}` : null;
    },
    tools: [
      defineReadTool({
        id: BROWSER_PAGE_READ_TOOL,
        entity: "page",
        description:
          "Read a page of a website you are signed in to: its text and tables. Only the site's allowed pages open; settings, password, user, billing and delete pages never do.",
        summary: "Read {{url}}",
        input: PageReadInput,
        output: PageReadOutput,
        run: (input, ctx) =>
          inBrowserSession(
            ctx,
            {
              tool: BROWSER_PAGE_READ_TOOL,
              site: input.site,
              url: input.url,
              within: input.within,
            },
            session,
            async (page) => {
              const url = await page.open(input.url);
              const text = await page.readText();
              const tables = await page.readTables();
              page.note({ kind: "read", url });
              const shot = input.within ? page.lastScreenshot() : null;
              return {
                url,
                text: text.slice(0, BROWSER_TEXT_MAX),
                tables,
                truncated: text.length > BROWSER_TEXT_MAX,
                ...(shot ? { screenshot: shot } : {}),
              };
            },
          ),
      }),
      defineReadTool({
        id: BROWSER_FILE_DOWNLOAD_TOOL,
        entity: "file",
        description:
          "Download a file (a PDF or an image, such as an invoice) from a website you are signed in to into the client's documents.",
        summary: "Downloaded {{filename}}",
        input: DownloadInput,
        output: DownloadOutput,
        run: (input, ctx) =>
          inBrowserSession(
            ctx,
            {
              tool: BROWSER_FILE_DOWNLOAD_TOOL,
              site: input.site,
              url: input.url,
              within: input.within,
            },
            session,
            async (page) => {
              const file = await page.download(input.url);
              if (!isDocumentType(file.mimeType)) {
                throw new BrowserRefused(
                  `${input.url} is ${file.mimeType || "an unknown type"}; documents are PDFs or images`,
                );
              }
              const services = ctx.services?.browser;
              if (!services) throw new BrowserRefused("documents are not available here");
              const stored = await services.storeDocument({
                bytes: file.bytes,
                filename: file.filename,
                mimeType: file.mimeType,
                sourceUrl: file.finalUrl,
              });
              page.note({ kind: "download", url: file.finalUrl, documentId: stored.documentId });
              return {
                documentId: stored.documentId,
                filename: file.filename,
                mimeType: file.mimeType,
                sizeBytes: file.bytes.length,
                url: file.finalUrl,
                alreadyHad: !stored.created,
              };
            },
          ),
      }),
    ],
  });
}
