// "browser": an agent working in a website that has no API (ARCHITECTURE §6.10, docs/plan.md
// §1.26 phase 3), on an operator-allowed site, signed in by our code as a dedicated agent account.
// A client has one browser connection per site; agents bind one by `browser:<site slug>` and pass
// `site` in each tool's input. The model gets page data only: `browser.page.read` (text and
// tables of an allowed page) and `browser.file.download` (a file into documents, as uploads are).
// No form submit yet: it comes after the pilot, as an external action behind approval.
// v0.16 (docs/plan.md §1.86): an `ai` skill that declares `browse` reaches these tools only through
// its scope (./scope.ts), which sets `within` to the skill's pages.

// v0.16 wave 4 (docs/plan.md §1.86 "Scripts (wave 4)"): a client's published scripts run as
// `browser.script.read` (a script that only reads) and `browser.script.submit` (one that submits a
// form: a write, behind approval and external_action), naming the script in their input.

import {
  BrowsePage,
  BrowserScriptSlug,
  BrowserSiteSlug,
  browserWriteCeiling,
} from "@countersign/core";
import { z } from "zod";
import { type Connector, defineConnector, defineReadTool, defineWriteTool } from "../connector";
import { isDocumentType } from "../upload/forwarding";
import {
  BROWSER_CONNECTOR_ID,
  BROWSER_FILE_DOWNLOAD_TOOL,
  BROWSER_PAGE_READ_TOOL,
  BROWSER_SCRIPT_READ_TOOL,
  BROWSER_SCRIPT_SUBMIT_TOOL,
} from "./ids";
import { loadScript, runPublishedScript, ScriptSubmitBefore, scriptSubmitBefore } from "./script";
import { type BrowserSessionOptions, browserConnectionSite, inBrowserSession } from "./session";
import { BrowserRefused } from "./sign-in";

export * from "./driver";
export * from "./fake";
export * from "./ids";
export * from "./remote";
export * from "./scope";
export * from "./script";
export * from "./services";
export {
  type BrowserCall,
  browserConnectionSite,
  HELD_SESSION_REOPENS,
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

const ScriptCallInput = z.strictObject({
  site: Site,
  script: BrowserScriptSlug.describe("The script's name on the site, as it was published"),
  inputs: z
    .record(z.string(), z.unknown())
    .default({})
    .describe("The script's inputs by name, typed as the script declares them"),
  help: z
    .unknown()
    .optional()
    .describe("Set by the platform: a person's answer after the script asked for help (data only)"),
});
/** A script's outputs by name, checked against its declarations before they leave the tool. */
const ScriptOutput = z.record(z.string(), z.unknown());

/**
 * The write ceiling of the call's connection (the tier table): a blocked site or a client that
 * turned writes off refuses here, before an approval card is made. Medium and high tiers are always
 * approved, as every script write is (`approval: "always"`).
 */
async function mayWrite(ctx: Parameters<typeof browserConnectionSite>[0], site: string) {
  const { site: pinned, config } = await browserConnectionSite(ctx, site);
  if (browserWriteCeiling(pinned.tier, config.stricter) === "off") {
    throw new BrowserRefused(`no changes are made on ${pinned.name} through this login`);
  }
}

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
      // Wave 4: a published write script submits a form on the site.
      { id: "form", label: "Forms", verbs: ["create"] },
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
      defineReadTool({
        id: BROWSER_SCRIPT_READ_TOOL,
        entity: "page",
        description:
          "Run one of the client's published scripts on a website that only reads: fixed steps we recorded, with its inputs. Gives back what the script reads, or asks for help when the page changed.",
        input: ScriptCallInput,
        output: ScriptOutput,
        run: (input, ctx) => runPublishedScript(ctx, input, "none", session),
      }),
      // DECISION: one write tool for every write script, `approval: "always"`: a person signs every
      // script that submits, on every tier (low tier's matrix `auto` is not offered for scripts
      // yet: a recorded form is new to everyone). Verb `create` on the `form` entity: submitting a
      // form adds something on the site.
      // DECISION: the tool's undo is `none`. R5's Undo reads the record now and compares it with
      // the state the write left (`canUndo`); a script has no record to read without a sign-in,
      // so a script's own reverse script (its `undo`) is named in the write's output (`reverse`,
      // the call that takes it back) for a person to run, not pressed as Undo.
      defineWriteTool({
        id: BROWSER_SCRIPT_SUBMIT_TOOL,
        verb: "create",
        entity: "form",
        approval: "always",
        undo: { kind: "none" },
        description:
          "Run one of the client's published scripts that submits a form on a website: fixed steps we recorded, with its inputs. Always approved by a person first.",
        input: ScriptCallInput,
        output: ScriptOutput,
        beforeSchema: ScriptSubmitBefore,
        async before(input, ctx) {
          // Nothing on the site is read before a submit (it would spend a sign-in): the checks are
          // the script's, the inputs' and the connection's ceiling. The before state is the
          // version a person approves and its steps, so the card shows what will be sent.
          const { script } = await loadScript(ctx, input, "external");
          await mayWrite(ctx, input.site);
          return scriptSubmitBefore(script);
        },
        // DECISION: the version approved (the proposal's before) must still be the published one
        // when the write runs; another version published in between is refused, to be approved
        // again. The runtime always passes the action's before (`proposedBefore: action.before`,
        // null when none was kept, never absent), so every write it runs is checked and a null
        // before is refused, to be approved again. Only a caller that leaves `proposedBefore` out
        // runs the published one unchecked, and the platform has none (only tests call so).
        async run(input, ctx) {
          await mayWrite(ctx, input.site);
          return runPublishedScript(ctx, input, "external", session, ctx.proposedBefore);
        },
      }),
    ],
  });
}
