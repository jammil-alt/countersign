// A client's sandbox (docs/plan.md §1.243): run one of the client's agents on its real data as a
// test run, from the portal or the back office, and see what it would do: every change it would
// make to the client's tools (a record's fields before and after, an email or a text as it would
// be received) and every notice it would send. Nothing is written (invariant 8: a sandbox run is a
// test run). A message can be sent once to the person looking ("Send to me"): from the client's
// own mailbox to their sign-in email, or from the client's own Twilio number to the phone on their
// own directory entry, never to anyone else. The portal's views carry the client's own words only:
// never a bundle, instructions, prompts or cost (invariant 11).

import { z } from "zod";
import { isUuid } from "../ids";
import { defineRoute } from "./contract";
import { TryCandidate } from "./getting-started";
import { RunForm } from "./lifecycle";

const Id = z.string().refine((v) => isUuid(v), "not an id");
const OPS = ["operator"] as const;
const CLIENT = ["client_admin", "client_user"] as const;

/** Sandbox runs a client may start in a day, from both sides together. */
export const SANDBOX_RUNS_PER_DAY = 20;
/** "Send to me" a client may use in a day, from both sides together. */
export const SANDBOX_SENDS_PER_DAY = 20;
/** The `connection_change.change.kind` that records a "Send to me". */
export const SANDBOX_SEND_CHANGE = "sandbox_preview";

/** Where a sandbox run was started. */
export const SandboxSide = z.enum(["portal", "ops"]);
export type SandboxSide = z.infer<typeof SandboxSide>;

/** What a sandbox run's trigger carries (`run.trigger.sandbox`): who started it, and where. */
export const SandboxMark = z.object({
  by: z.string(),
  side: SandboxSide,
  /** What it ran on, in words: the document, or the form's name. */
  title: z.string().max(300).optional(),
});
export type SandboxMark = z.infer<typeof SandboxMark>;

/** The channels a message change goes out on. */
export const SandboxChannel = z.enum(["email", "sms", "whatsapp", "voice", "other"]);
export type SandboxChannel = z.infer<typeof SandboxChannel>;

/** A message the agent would have sent, as it would be received. */
export const SandboxMessage = z.object({
  channel: SandboxChannel,
  to: z.string(),
  /** The contact's name, when the directory knows it. */
  toName: z.string().nullable(),
  /** The mailbox or number it would come from, when known. */
  from: z.string().nullable(),
  subject: z.string().nullable(),
  text: z.string().nullable(),
  /** Files that would go with it (a preview sent to you carries none). */
  attachments: z.number().int().min(0),
});
export type SandboxMessage = z.infer<typeof SandboxMessage>;

/** One field of a record the agent would have changed. */
export const SandboxField = z.object({
  field: z.string(),
  before: z.string().nullable(),
  after: z.string().nullable(),
});
export type SandboxField = z.infer<typeof SandboxField>;

/** Whether this person may have a message sent to them, where, and why not. */
export const SandboxSend = z.object({
  channel: z.enum(["email", "sms"]),
  /** Their own address, or their phone with all but the last four digits hidden. */
  to: z.string().nullable(),
  can: z.boolean(),
  /** Why not, in plain words; null when they can. */
  reason: z.string().nullable(),
});
export type SandboxSend = z.infer<typeof SandboxSend>;

/** A "Send to me" already made for this change. */
export const SandboxSent = z.object({
  at: z.string(),
  byName: z.string().nullable(),
  channel: z.enum(["email", "sms"]),
  to: z.string(),
});
export type SandboxSent = z.infer<typeof SandboxSent>;

/** A change the agent would have made to one of the client's tools. Nothing was written. */
export const SandboxChange = z.object({
  /** The recorded change's id (`external_action`). */
  id: z.string(),
  stepId: z.string().nullable(),
  stepName: z.string().nullable(),
  kind: z.enum(["message", "record"]),
  /** In words: "Email to Northside Lumber", "Update the record". */
  title: z.string(),
  tool: z.object({ connector: z.string(), connectorName: z.string() }),
  message: SandboxMessage.nullable(),
  /** A record's fields as they are and as they would be; empty for a message. */
  fields: z.array(SandboxField),
  /** "Send to me" for this person; null when the change is not a message that can be sent. */
  send: SandboxSend.nullable(),
  sent: z.array(SandboxSent),
});
export type SandboxChange = z.infer<typeof SandboxChange>;

/** A notice the run would have sent to someone of the client's (a notify step). */
export const SandboxNotice = z.object({
  stepId: z.string(),
  stepName: z.string().nullable(),
  channel: z.string(),
  to: z.string().nullable(),
  text: z.string(),
});
export type SandboxNotice = z.infer<typeof SandboxNotice>;

/** One step of a sandbox run, in the timeline's words ("Would …" for a write). */
export const SandboxStep = z.object({
  id: z.string(),
  name: z.string(),
  state: z.enum(["done", "running", "waiting", "skipped", "failed"]),
  summary: z.string().nullable(),
  /** A person step or an approval: someone would have been asked. */
  person: z.boolean(),
});
export type SandboxStep = z.infer<typeof SandboxStep>;

export const SandboxRunSummary = z.object({
  runId: z.string(),
  agentId: z.string(),
  agentName: z.string(),
  title: z.string(),
  status: z.enum(["running", "done", "failed"]),
  startedAt: z.string(),
  side: SandboxSide,
  byName: z.string().nullable(),
  /** Changes it would have made, and how many of them are messages. */
  changes: z.number().int().min(0),
  messages: z.number().int().min(0),
});
export type SandboxRunSummary = z.infer<typeof SandboxRunSummary>;

/** A sandbox run in full. `changeCount` is the summary's `changes`. */
export const SandboxRun = SandboxRunSummary.omit({ changes: true }).extend({
  changeCount: z.number().int().min(0),
  steps: z.array(SandboxStep),
  changes: z.array(SandboxChange),
  notices: z.array(SandboxNotice),
});
export type SandboxRun = z.infer<typeof SandboxRun>;

/** How many sandbox runs the client started today, of the most it may. */
export const SandboxUse = z.object({
  runs: z.number().int().min(0),
  maxRuns: z.number().int().min(1),
  sends: z.number().int().min(0),
  maxSends: z.number().int().min(1),
});
export type SandboxUse = z.infer<typeof SandboxUse>;

/** An agent the person may run in the sandbox, and what it can start from. */
export const SandboxAgent = z.object({
  id: z.string(),
  name: z.string(),
  /** Recent documents of the client's one of its workflows starts on. */
  documents: z.array(TryCandidate),
  /** Workflows started by hand with a form. */
  forms: z.array(RunForm),
  /** Whether a sandbox run of it is running (the next waits for it). */
  running: z.boolean(),
});
export type SandboxAgent = z.infer<typeof SandboxAgent>;

export const SandboxView = z.object({
  agents: z.array(SandboxAgent),
  /** Newest first. */
  runs: z.array(SandboxRunSummary),
  use: SandboxUse,
  /** Whether this person may start a run and send to themselves (someone who can sign). */
  canTry: z.boolean(),
});
export type SandboxView = z.infer<typeof SandboxView>;

export const OpsSandboxView = z.object({
  /** Newest first. */
  runs: z.array(SandboxRunSummary),
  use: SandboxUse,
  /**
   * Whether "Send to me" is ours here: only in the Sandbox client. In a real client only the
   * client's own people send from its tools.
   */
  canSend: z.boolean(),
});
export type OpsSandboxView = z.infer<typeof OpsSandboxView>;

/** Start a sandbox run from the portal: on a document, or with a hand-started workflow's form. */
export const SandboxStartBody = z.union([
  z.strictObject({ agentId: Id, documentId: Id }),
  z.strictObject({
    agentId: Id,
    workflow: z.string().min(1).max(100),
    input: z.record(z.string(), z.unknown()).default({}),
  }),
]);
export type SandboxStartBody = z.infer<typeof SandboxStartBody>;

const RunParams = z.object({ runId: Id });
const ChangeParams = z.object({ runId: Id, changeId: Id });
const OpsParams = z.object({ id: Id });
const OpsRunParams = z.object({ id: Id, runId: Id });
const OpsChangeParams = z.object({ id: Id, runId: Id, changeId: Id });

export const sandboxRoutes = {
  portalSandbox: defineRoute({
    method: "GET",
    path: "/api/sandbox",
    auth: "session",
    roles: CLIENT,
    summary:
      "Your sandbox: the agents you can try on your own data, what each can start from, and recent sandbox runs",
    response: SandboxView,
  }),
  portalSandboxStart: defineRoute({
    method: "POST",
    path: "/api/sandbox/runs",
    auth: "session",
    roles: CLIENT,
    summary:
      "Run an agent in the sandbox on a document or a form: a test run that reads your data and writes nothing",
    body: SandboxStartBody,
    response: z.object({ run: SandboxRun }),
  }),
  portalSandboxRun: defineRoute({
    method: "GET",
    path: "/api/sandbox/runs/:runId",
    auth: "session",
    roles: CLIENT,
    summary: "One sandbox run: its steps, and what it would have changed and sent",
    params: RunParams,
    response: z.object({ run: SandboxRun }),
  }),
  portalSandboxSend: defineRoute({
    method: "POST",
    path: "/api/sandbox/runs/:runId/changes/:changeId/send",
    auth: "session",
    roles: CLIENT,
    summary:
      "Send me this message as the agent would have sent it: from your own mailbox or number, to you only",
    params: ChangeParams,
    response: z.object({ run: SandboxRun }),
  }),
  opsSandbox: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/sandbox",
    auth: "session",
    roles: OPS,
    summary:
      "A client's sandbox runs, newest first (start one with a test run marked sandbox), and today's use",
    params: OpsParams,
    response: OpsSandboxView,
  }),
  opsSandboxRun: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/sandbox/runs/:runId",
    auth: "session",
    roles: OPS,
    summary: "One sandbox run: its steps, and what it would have changed and sent",
    params: OpsRunParams,
    response: z.object({ run: SandboxRun }),
  }),
  opsSandboxSend: defineRoute({
    method: "POST",
    path: "/api/ops/clients/:id/sandbox/runs/:runId/changes/:changeId/send",
    auth: "session",
    roles: OPS,
    summary:
      "Send me this message as the agent would have sent it (the Sandbox client only; in a real client only its people send)",
    params: OpsChangeParams,
    response: z.object({ run: SandboxRun }),
  }),
};
