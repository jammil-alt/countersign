import { z } from "zod";
import {
  BrowserScriptSlug,
  RecorderAction,
  ScriptInputDecl,
  ScriptOutputDecl,
  ScriptRecording,
  ScriptStep,
  ScriptUndo,
} from "../browser/script";
import { BrowserTier } from "../browser/site";
import { isUuid } from "../ids";
import { defineRoute } from "./contract";

// Scripted site tools (docs/plan.md §1.86 "Scripts (wave 4)"; ARCHITECTURE v0.16 §10.14 "Browser
// connectors"). The operator, or the client admin from the portal's website logins, records a
// script on one of the client's browser logins: each action goes through our API to our browser
// (signed in by our code first, so whoever records never sees the login), comes back as a step
// with its screenshot, and is kept on the recording. Saving makes an immutable version; only the
// operator publishes one, and only a published version runs, as `browser.script.read` or
// `browser.script.submit` for that client alone. A test is a dry run that never submits.

const Id = z.string().refine((v) => isUuid(v), "not an id");
const OPS = ["operator"] as const;
const CLIENT_ADMIN = ["client_admin"] as const;

/** Where a script is: still being recorded, saved and waiting for us to publish, or published. */
export const BrowserScriptState = z.enum(["recording", "draft", "published"]);
export type BrowserScriptState = z.infer<typeof BrowserScriptState>;

export const BrowserScriptVersionView = z.object({
  version: z.number().int(),
  sideEffect: z.enum(["none", "external"]),
  recordedSide: z.enum(["operator", "client"]),
  createdAt: z.string(),
});

export const BrowserScriptView = z.object({
  id: z.string(),
  clientId: z.string(),
  clientName: z.string(),
  connectionId: z.string(),
  site: z.string(),
  siteName: z.string(),
  slug: z.string(),
  name: z.string(),
  state: BrowserScriptState,
  createdSide: z.enum(["operator", "client"]),
  recording: ScriptRecording,
  /** What stops the recording from being saved as it is (empty: it may be saved). */
  problems: z.array(z.string()),
  versions: z.array(BrowserScriptVersionView),
  published: z.object({ version: z.number().int(), publishedAt: z.string() }).nullable(),
  /** The script-draft offer it was started from (an operator inbox item). */
  offerItemId: z.string().nullable(),
  updatedAt: z.string(),
});
export type BrowserScriptView = z.infer<typeof BrowserScriptView>;

/** A browser login a script may be recorded on (never a blocked or person-only site). */
export const ScriptLogin = z.object({
  clientId: z.string(),
  clientName: z.string(),
  connectionId: z.string(),
  site: z.string(),
  siteName: z.string(),
  tier: BrowserTier,
});

export const BrowserScriptList = z.object({
  scripts: z.array(BrowserScriptView),
  logins: z.array(ScriptLogin),
});

export const StartBrowserScript = z.strictObject({
  connectionId: Id,
  slug: BrowserScriptSlug,
  name: z.string().trim().min(1).max(120),
  /** Back office only: the script-draft offer to start from (its pages become open steps). */
  fromOffer: Id.optional(),
});

/** The review: names, inputs and outputs, and the steps kept (a step's page part may not change). */
export const EditBrowserScript = z.strictObject({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).default(""),
  inputs: z.array(ScriptInputDecl).max(30),
  outputs: z.array(ScriptOutputDecl).max(30),
  steps: z.array(ScriptStep).max(50),
  undo: ScriptUndo.default({ kind: "none" }),
});
export type EditBrowserScript = z.input<typeof EditBrowserScript>;

export const RecorderControl = z.object({
  selector: z.string(),
  kind: z.enum(["field", "select", "button", "link"]),
  label: z.string(),
});

/** The page after an action: its address, some of its text, its tables and what may be used. */
export const RecorderPage = z.object({
  url: z.string(),
  text: z.string(),
  tables: z.array(z.object({ headers: z.array(z.string()), rows: z.array(z.array(z.string())) })),
  controls: z.array(RecorderControl),
  /** A 5-minute link to the screenshot after the action; null when none was kept. */
  screenshotUrl: z.string().nullable(),
});
export type RecorderPage = z.infer<typeof RecorderPage>;

export const BrowserScriptActionResult = z.object({
  script: BrowserScriptView,
  /** The step recorded; a submit is recorded and never clicked. */
  step: ScriptStep,
  /** What a read gave, shown to whoever records. */
  value: z.unknown().optional(),
  page: RecorderPage,
});

export const TestBrowserScript = z.strictObject({
  /** The saved version to test; absent: the recording as it is. */
  version: z.number().int().min(1).optional(),
  /** The inputs to fill; absent: each input's example. */
  inputs: z.record(z.string(), z.unknown()).optional(),
});

export const BrowserScriptTestResult = z.object({
  outcome: z.enum(["done", "needs_help", "refused"]),
  /** What it read, checked against its outputs (done only). */
  outputs: z.record(z.string(), z.unknown()).nullable(),
  reason: z.string().nullable(),
  steps: z.array(
    z.object({
      id: z.string(),
      op: z.string(),
      url: z.string(),
      status: z.enum(["done", "skipped"]),
      screenshotUrl: z.string().nullable(),
    }),
  ),
  needsHelp: z.object({ question: z.string(), tried: z.array(z.string()) }).nullable(),
});
export type BrowserScriptTestResult = z.infer<typeof BrowserScriptTestResult>;

/** A client's published script as the builder and the Library list it: a browser tool's call. */
export const BrowserScriptTool = z.object({
  tool: z.enum(["browser.script.read", "browser.script.submit"]),
  connector: z.literal("browser"),
  site: z.string(),
  siteName: z.string(),
  script: z.string(),
  name: z.string(),
  description: z.string(),
  sideEffect: z.enum(["none", "external"]),
  version: z.number().int(),
  inputs: z.array(ScriptInputDecl),
  outputs: z.array(ScriptOutputDecl),
});
export type BrowserScriptTool = z.infer<typeof BrowserScriptTool>;

const ScriptParams = z.object({ id: Id });
const OneScript = z.object({ script: BrowserScriptView });

export const browserScriptRoutes = {
  opsBrowserScripts: defineRoute({
    method: "GET",
    path: "/api/ops/browser-scripts",
    auth: "session",
    roles: OPS,
    summary:
      "Recorded scripts on the browser logins of the clients you serve, and the logins to record on",
    response: BrowserScriptList,
  }),
  opsClientBrowserScriptTools: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/browser-scripts",
    auth: "session",
    roles: OPS,
    summary: "A client's published scripts as browser read and write tools (builder, Library)",
    params: z.object({ id: Id }),
    response: z.object({ tools: z.array(BrowserScriptTool) }),
  }),
  opsStartBrowserScript: defineRoute({
    method: "POST",
    path: "/api/ops/browser-scripts",
    auth: "session",
    roles: OPS,
    summary: "Start recording a script on a client's browser login (or from a script-draft offer)",
    body: StartBrowserScript,
    response: OneScript,
  }),
  opsBrowserScriptAction: defineRoute({
    method: "POST",
    path: "/api/ops/browser-scripts/:id/actions",
    auth: "session",
    roles: OPS,
    summary: "Record one action in our browser, signed in by our code: the step and its screenshot",
    params: ScriptParams,
    body: z.strictObject({ action: RecorderAction }),
    response: BrowserScriptActionResult,
  }),
  opsEditBrowserScript: defineRoute({
    method: "PUT",
    path: "/api/ops/browser-scripts/:id",
    auth: "session",
    roles: OPS,
    summary: "Review a recording: its name, inputs, outputs, undo and the steps kept",
    params: ScriptParams,
    body: EditBrowserScript,
    response: OneScript,
  }),
  opsSaveBrowserScript: defineRoute({
    method: "POST",
    path: "/api/ops/browser-scripts/:id/versions",
    auth: "session",
    roles: OPS,
    summary: "Save the recording as a new, immutable version (a draft until published)",
    params: ScriptParams,
    response: OneScript,
  }),
  opsTestBrowserScript: defineRoute({
    method: "POST",
    path: "/api/ops/browser-scripts/:id/test",
    auth: "session",
    roles: OPS,
    summary: "Test a script: a dry run in our browser that never submits and keeps no file",
    params: ScriptParams,
    body: TestBrowserScript,
    response: BrowserScriptTestResult,
  }),
  opsPublishBrowserScript: defineRoute({
    method: "POST",
    path: "/api/ops/browser-scripts/:id/versions/:version/publish",
    auth: "session",
    roles: OPS,
    summary: "Publish a version: it becomes a browser tool for this client alone",
    params: z.object({ id: Id, version: z.coerce.number().int().min(1) }),
    response: OneScript,
  }),
  portalBrowserScripts: defineRoute({
    method: "GET",
    path: "/api/access/browser-scripts",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary: "Your recorded scripts on your website logins, and where each one stands",
    response: BrowserScriptList,
  }),
  portalStartBrowserScript: defineRoute({
    method: "POST",
    path: "/api/access/browser-scripts",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary: "Start recording a script on one of your website logins",
    body: StartBrowserScript.omit({ fromOffer: true }),
    response: OneScript,
  }),
  portalBrowserScriptAction: defineRoute({
    method: "POST",
    path: "/api/access/browser-scripts/:id/actions",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary: "Record one action in our browser, signed in by us: the step and its screenshot",
    params: ScriptParams,
    body: z.strictObject({ action: RecorderAction }),
    response: BrowserScriptActionResult,
  }),
  portalEditBrowserScript: defineRoute({
    method: "PUT",
    path: "/api/access/browser-scripts/:id",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary: "Name your recording's inputs and outputs and the steps kept",
    params: ScriptParams,
    body: EditBrowserScript,
    response: OneScript,
  }),
  portalSaveBrowserScript: defineRoute({
    method: "POST",
    path: "/api/access/browser-scripts/:id/versions",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary: "Save your recording for us to review and publish (it doesn't run until we do)",
    params: ScriptParams,
    response: OneScript,
  }),
} as const;
