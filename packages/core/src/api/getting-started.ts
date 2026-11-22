// Setting up a client (docs/setup-plan.md; docs/plan.md §1.199): Getting started's five chapters
// (business, tools, people, see it work, go live), one line per agent of what is left before its
// trial and who it waits on, and the back office's Setup tab. Each view is the client's own words
// and people: never the agent's bundle, instructions, prompts, cost, a seat's role name beyond its
// label, or anything of ours (invariant 11). Answers and "we do it differently" are data (invariant
// 9). Nothing here loosens an approval (invariant 8): a seat changes who signs, never whether.

import { z } from "zod";
import { isUuid } from "../ids";
import { AgentStage } from "../lifecycle/stage";
import { ReachChannel, RoleName, SeatKind } from "../reach/rules";
import { defineRoute } from "./contract";

const Id = z.string().refine((v) => isUuid(v), "not an id");
const OPS = ["operator"] as const;
const CLIENT = ["client_admin", "client_user"] as const;
const CLIENT_ADMIN = ["client_admin"] as const;
const AgentParams = z.object({ id: Id });

// ── Chapters ─────────────────────────────────────────────────────────────────────────────────

/** Getting started's chapters, in the order the page shows them (owner, §1.199 q6). */
export const SETUP_CHAPTERS = ["business", "tools", "people", "see", "live"] as const;
export const SetupChapter = z.enum(SETUP_CHAPTERS);
export type SetupChapter = z.infer<typeof SetupChapter>;

/** Where a chapter stands for this client. */
export const CHAPTER_STATES = ["done", "open", "not_started", "not_needed"] as const;
export const ChapterState = z.enum(CHAPTER_STATES);
export type ChapterState = z.infer<typeof ChapterState>;

export const ChapterProgress = z.object({
  key: SetupChapter,
  state: ChapterState,
  done: z.number().int().min(0),
  total: z.number().int().min(0),
});
export type ChapterProgress = z.infer<typeof ChapterProgress>;

/** A person something waits on, as the client sees them. */
export const SetupWho = z.object({
  userId: z.string().nullable(),
  name: z.string(),
  /** The person reading. */
  me: z.boolean(),
});
export type SetupWho = z.infer<typeof SetupWho>;

/** One thing left before an agent's trial: "Connect Gmail · you". */
export const SetupLeft = z.object({
  /** Stable within the agent: `tool:<connector>`, `seat:<role>`, `item:<id>`, `see`, `try`, `scope`. */
  key: z.string(),
  chapter: SetupChapter,
  label: z.string(),
  who: SetupWho.nullable(),
});
export type SetupLeft = z.infer<typeof SetupLeft>;

/** One agent being set up, in the client's words. */
export const SetupAgentLine = z.object({
  agentId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  stage: AgentStage.nullable(),
  left: z.array(SetupLeft),
});
export type SetupAgentLine = z.infer<typeof SetupAgentLine>;

export const GettingStartedView = z.object({
  /** The agents not yet on trial or live that this person sees. */
  agents: z.array(SetupAgentLine),
  chapters: z.array(ChapterProgress),
  lead: z.object({ name: z.string() }).nullable(),
  /** Roughly how long what is left takes, in minutes. */
  minutesLeft: z.number().int().min(0),
});
export type GettingStartedView = z.infer<typeof GettingStartedView>;

// ── People (SU2) ─────────────────────────────────────────────────────────────────────────────

/** Someone of the client who can sit in a seat. */
export const SeatMember = z.object({
  userId: z.string(),
  name: z.string().nullable(),
  email: z.string(),
  role: z.enum(["client_admin", "client_user"]),
  canSign: z.boolean(),
  /** Has signed in at least once. */
  joined: z.boolean(),
  me: z.boolean(),
});
export type SeatMember = z.infer<typeof SeatMember>;

/** A directory contact, for a seat that is told or contacted. */
export const SeatContact = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  reachable: z.array(ReachChannel),
});
export type SeatContact = z.infer<typeof SeatContact>;

/** One seat, merged across the agents being set up that declare it. */
export const SeatView = z.object({
  role: RoleName,
  label: z.string(),
  kind: SeatKind,
  description: z.string(),
  required: z.boolean(),
  agents: z.array(z.object({ id: z.string(), name: z.string() })),
  userIds: z.array(z.string()),
  backupUserIds: z.array(z.string()),
  contactIds: z.array(z.string()),
  /**
   * "We think", from the client's own answers (the intake's people questions), matched to its
   * members by name. Null when the seat is filled or nothing matched.
   */
  weThink: z
    .object({
      userIds: z.array(z.string()),
      /** The answer it came from, in the client's words. */
      from: z.string(),
    })
    .nullable(),
  /** Every agent that declares it has the same people in it. */
  filled: z.boolean(),
});
export type SeatView = z.infer<typeof SeatView>;

export const PeopleChapterView = z.object({
  seats: z.array(SeatView),
  members: z.array(SeatMember),
  contacts: z.array(SeatContact),
  /** The client admin fills seats; everyone else reads them. */
  canEdit: z.boolean(),
  /** "Looks right" on the chapter, once said. */
  confirmed: z.object({ byName: z.string(), at: z.string() }).nullable(),
});
export type PeopleChapterView = z.infer<typeof PeopleChapterView>;

/** Who sits in a seat. Absent lists are kept as they are. */
export const SeatBody = z
  .strictObject({
    userIds: z.array(Id).max(10).optional(),
    backupUserIds: z.array(Id).max(10).optional(),
    contactIds: z.array(Id).max(10).optional(),
  })
  .refine(
    (b) => b.userIds !== undefined || b.backupUserIds !== undefined || b.contactIds !== undefined,
    "nothing to change",
  );
export type SeatBody = z.infer<typeof SeatBody>;

// ── Tools (SU3) ──────────────────────────────────────────────────────────────────────────────

/** One line of "what we see in <tool>": counted by code, never a model; the client says yes. */
export const FirstLookLine = z.object({
  key: z.string(),
  text: z.string(),
  confirmed: z.boolean(),
});
export type FirstLookLine = z.infer<typeof FirstLookLine>;

/** A tool the agents being set up need, and what they do in it, in words. */
export const SetupTool = z.object({
  connector: z.string(),
  name: z.string(),
  connected: z.boolean(),
  connectionId: z.string().nullable(),
  /** The account it is signed in to, as the connection names it ("Hartley Millwork LLC"). */
  account: z.string().nullable(),
  accountConfirmed: z.boolean(),
  agents: z.array(z.object({ id: z.string(), name: z.string() })),
  /** "Bills, vendors and accounts". */
  reads: z.array(z.string()),
  /** "Create bills (asks you first)". */
  changes: z.array(z.string()),
  /** What the agents never do there: delete, and anything they have no tool for. */
  never: z.array(z.string()),
  /** After the first sync; null before, or for a tool we don't count. */
  firstLook: z.array(FirstLookLine).nullable(),
  /** Someone else was asked to connect it. */
  askedOf: SetupWho.nullable(),
});
export type SetupTool = z.infer<typeof SetupTool>;

export const ToolsChapterView = z.object({
  tools: z.array(SetupTool),
  canEdit: z.boolean(),
});
export type ToolsChapterView = z.infer<typeof ToolsChapterView>;

export const ToolConfirmBody = z.discriminatedUnion("what", [
  z.strictObject({ what: z.literal("account") }),
  z.strictObject({ what: z.literal("line"), key: z.string().min(1).max(100) }),
]);
export type ToolConfirmBody = z.infer<typeof ToolConfirmBody>;

// ── See it work (SU4, SU5) ───────────────────────────────────────────────────────────────────

/** A step the client read: "Looks right", or "We do it differently" (a request to us). */
export const WalkMark = z.object({
  stepId: z.string(),
  state: z.enum(["ok", "asked"]),
  byName: z.string().nullable(),
  at: z.string(),
  /** Their words, for "asked". */
  text: z.string().nullable(),
  /** The request it filed, for "asked". */
  request: z.object({ id: z.string(), number: z.number().int() }).nullable(),
});
export type WalkMark = z.infer<typeof WalkMark>;

/** Something real to try the agent on: a recent document of the client's. */
export const TryCandidate = z.object({
  documentId: z.string(),
  title: z.string(),
  from: z.string().nullable(),
  at: z.string(),
});
export type TryCandidate = z.infer<typeof TryCandidate>;

/** One step of a try, as the client reads it: what it did, or would have done. */
export const TryStep = z.object({
  id: z.string(),
  name: z.string(),
  state: z.enum(["done", "running", "waiting", "skipped", "failed"]),
  /** In words; a write reads "Would …": a test run writes nothing. */
  summary: z.string().nullable(),
  /** A person step or an approval: who would have been asked. */
  person: z.boolean(),
  /** The client said: right, or not right. */
  verdict: z.enum(["right", "not_right"]).nullable(),
});
export type TryStep = z.infer<typeof TryStep>;

export const TryView = z.object({
  runId: z.string(),
  title: z.string(),
  status: z.enum(["running", "done", "failed"]),
  startedAt: z.string(),
  steps: z.array(TryStep),
});
export type TryView = z.infer<typeof TryView>;

/** Tries per agent during setup (owner, §1.199 q2). */
export const SETUP_TRIES_MAX = 3;

export const WalkthroughView = z.object({
  agentId: z.string(),
  name: z.string(),
  marks: z.array(WalkMark),
  tries: z.object({
    used: z.number().int().min(0),
    max: z.number().int().min(1),
    /** Newest first. */
    recent: z.array(TryView),
  }),
  /** What it can be tried on; empty when the agent doesn't start from a document. */
  candidates: z.array(TryCandidate),
  /** Whether this person may try it (one who can sign; a viewer reads only). */
  canTry: z.boolean(),
  /**
   * Whether this person can sign: they say Looks right or We do it differently on a step, and
   * Right or Not right on a try's step. A viewer reads only.
   */
  canSign: z.boolean(),
});
export type WalkthroughView = z.infer<typeof WalkthroughView>;

export const WalkMarkBody = z.union([
  z.strictObject({ ok: z.literal(true) }),
  z.strictObject({ different: z.string().trim().min(1).max(2000) }),
]);
export type WalkMarkBody = z.infer<typeof WalkMarkBody>;

export const SetupTryBody = z.strictObject({ documentId: Id });
export const TryVerdictBody = z.union([
  z.strictObject({ right: z.literal(true) }),
  z.strictObject({ right: z.literal(false), because: z.string().trim().min(1).max(2000) }),
]);
export type TryVerdictBody = z.infer<typeof TryVerdictBody>;

// ── Go live ──────────────────────────────────────────────────────────────────────────────────

/** The trial's length, the same for every agent (owner, §1.199 q5). */
export const SETUP_TRIAL_DAYS = 14;

/** An agent's scope in the client's words: what was checked in the chapters, in one place. */
export const ScopeView = z.object({
  agentId: z.string(),
  name: z.string(),
  /** The agent's version the scope reads. */
  version: z.number().int(),
  does: z.string(),
  reads: z.array(z.string()),
  changes: z.array(z.string()),
  /** "Dana up to $5,000 (Luis if she's away)". */
  signs: z.array(z.string()),
  answers: z.array(z.string()),
  /** Settings the client chose: "Approval amount: $5,000". */
  choices: z.array(z.string()),
  /** What is still with us: their open requests about it. */
  open: z.array(z.string()),
  signed: z.object({ byName: z.string(), at: z.string(), version: z.number().int() }).nullable(),
  canSign: z.boolean(),
  trialDays: z.number().int(),
  stage: AgentStage.nullable(),
});
export type ScopeView = z.infer<typeof ScopeView>;

// ── The back office's Setup tab (SU6) ────────────────────────────────────────────────────────

export const BoardCell = z.object({
  chapter: SetupChapter,
  state: ChapterState,
  /** Who it waits on, by name; null when nobody or done. */
  waitingOn: z.string().nullable(),
  note: z.string().nullable(),
});
export type BoardCell = z.infer<typeof BoardCell>;

export const BoardAgent = z.object({
  agentId: z.string(),
  name: z.string(),
  stage: AgentStage.nullable(),
  version: z.number().int().nullable(),
  cells: z.array(BoardCell),
  /** What still holds Start trial, in words; empty when it can start. */
  holds: z.array(z.string()),
});
export type BoardAgent = z.infer<typeof BoardAgent>;

export const BoardWaiting = z.object({
  userId: z.string().nullable(),
  name: z.string(),
  items: z.array(z.string()),
  lastSeenAt: z.string().nullable(),
});
export type BoardWaiting = z.infer<typeof BoardWaiting>;

/** A "we do it differently" or a "not right" from the chapters: an open request of the client's. */
export const BoardAsk = z.object({
  requestId: z.string(),
  number: z.number().int(),
  agentId: z.string().nullable(),
  agentName: z.string().nullable(),
  stepId: z.string().nullable(),
  text: z.string(),
  byName: z.string().nullable(),
  at: z.string(),
});
export type BoardAsk = z.infer<typeof BoardAsk>;

export const RUNBOOK_STEPS = ["invite", "kickoff", "trial", "checkin", "live"] as const;
export const RunbookStep = z.object({
  key: z.enum(RUNBOOK_STEPS),
  /** Days after the invite. */
  day: z.number().int(),
  label: z.string(),
  /** When it happened, or is due. */
  at: z.string().nullable(),
  state: z.enum(["done", "now", "next"]),
});
export type RunbookStep = z.infer<typeof RunbookStep>;

export const OpsSetupBoard = z.object({
  client: z.object({ id: z.string(), name: z.string() }),
  agents: z.array(BoardAgent),
  waiting: z.array(BoardWaiting),
  asks: z.array(BoardAsk),
  runbook: z.array(RunbookStep),
  /** The client's open intake, for Do it on a call; null when none is open. */
  intakeId: z.string().nullable(),
});
export type OpsSetupBoard = z.infer<typeof OpsSetupBoard>;

/** One answer the lead gives on a call: shown to the client as "From our call: please check". */
export const CallAnswerBody = z.strictObject({
  answers: z
    .array(
      z.strictObject({
        fieldKey: z.string().min(1).max(200),
        value: z.unknown(),
      }),
    )
    .min(1)
    .max(60),
});
export type CallAnswerBody = z.infer<typeof CallAnswerBody>;

export const gettingStartedRoutes = {
  portalGettingStarted: defineRoute({
    method: "GET",
    path: "/api/getting-started",
    auth: "session",
    roles: CLIENT,
    summary:
      "Getting started: each agent being set up with what is left before its trial and who it waits on, and the five chapters' progress",
    response: GettingStartedView,
  }),
  portalSetupPeople: defineRoute({
    method: "GET",
    path: "/api/getting-started/people",
    auth: "session",
    roles: CLIENT,
    summary:
      "Your people: each seat of the agents being set up (who approves, answers, is told or contacted), who is in it, and who we think",
    response: z.object({ people: PeopleChapterView }),
  }),
  portalSetupSeat: defineRoute({
    method: "PUT",
    path: "/api/getting-started/people/:role",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary:
      "Put people in a seat, on every agent being set up that has it; once a trial has started, a change to who signs tells your lead",
    params: z.object({ role: RoleName }),
    body: SeatBody,
    response: z.object({ people: PeopleChapterView }),
  }),
  portalSetupPeopleConfirm: defineRoute({
    method: "POST",
    path: "/api/getting-started/people/confirm",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary: '"Looks right" on Your people',
    response: z.object({ people: PeopleChapterView }),
  }),
  portalSetupTools: defineRoute({
    method: "GET",
    path: "/api/getting-started/tools",
    auth: "session",
    roles: CLIENT,
    summary:
      "Your tools: each tool the agents being set up need, whether it is connected and to which account, what they read and change there, and what we see in it",
    response: ToolsChapterView,
  }),
  portalSetupToolConfirm: defineRoute({
    method: "POST",
    path: "/api/getting-started/tools/:connector/confirm",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary: "Yes, that's the right account; or yes to one line of what we see in it",
    params: z.object({ connector: z.string().min(1).max(64) }),
    body: ToolConfirmBody,
    response: ToolsChapterView,
  }),
  portalSetupToolAsk: defineRoute({
    method: "POST",
    path: "/api/getting-started/tools/:connector/ask",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary: "Ask a colleague who holds the login to connect a tool: just that card, on their Desk",
    params: z.object({ connector: z.string().min(1).max(64) }),
    body: z.strictObject({ userId: Id }),
    response: ToolsChapterView,
  }),
  portalSetupWalkthrough: defineRoute({
    method: "GET",
    path: "/api/getting-started/agents/:id/walkthrough",
    auth: "session",
    roles: CLIENT,
    summary:
      "See it work: what you said about each step, the tries so far and what the agent can be tried on",
    params: AgentParams,
    response: WalkthroughView,
  }),
  portalSetupWalkMark: defineRoute({
    method: "POST",
    path: "/api/getting-started/agents/:id/steps/:stepId",
    auth: "session",
    roles: CLIENT,
    summary:
      '"Looks right" on a step, or "We do it differently" (a request to us, tied to the step)',
    params: z.object({ id: Id, stepId: z.string().min(1).max(100) }),
    body: WalkMarkBody,
    response: WalkthroughView,
  }),
  portalSetupTry: defineRoute({
    method: "POST",
    path: "/api/getting-started/agents/:id/try",
    auth: "session",
    roles: CLIENT,
    summary:
      "Try the agent on one of your documents: a test run that writes nothing and asks nobody (up to three per agent, one at a time)",
    params: AgentParams,
    body: SetupTryBody,
    response: z.object({ try: TryView }),
  }),
  portalSetupTryView: defineRoute({
    method: "GET",
    path: "/api/getting-started/agents/:id/tries/:runId",
    auth: "session",
    roles: CLIENT,
    summary: "One try, step by step: what it did, or would have done",
    params: z.object({ id: Id, runId: Id }),
    response: z.object({ try: TryView }),
  }),
  portalSetupTryVerdict: defineRoute({
    method: "POST",
    path: "/api/getting-started/agents/:id/tries/:runId/steps/:stepId",
    auth: "session",
    roles: CLIENT,
    summary: '"Right" or "Not right because…" on one step of a try (not right files a request)',
    params: z.object({ id: Id, runId: Id, stepId: z.string().min(1).max(100) }),
    body: TryVerdictBody,
    response: z.object({ try: TryView }),
  }),
  portalSetupScope: defineRoute({
    method: "GET",
    path: "/api/getting-started/agents/:id/scope",
    auth: "session",
    roles: CLIENT,
    summary: "Go live: the agent's scope in your words, and whether it is signed",
    params: AgentParams,
    response: z.object({ scope: ScopeView }),
  }),
  portalSetupScopeSign: defineRoute({
    method: "POST",
    path: "/api/getting-started/agents/:id/scope/sign",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary: "Sign the scope: your lead can then start the trial, where you sign every change",
    params: AgentParams,
    response: z.object({ scope: ScopeView }),
  }),
  opsSetupBoard: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/setup",
    auth: "session",
    roles: OPS,
    summary:
      "A client's Setup tab: each agent by chapter with who it waits on, the people waiting, the change asks, the runbook",
    params: z.object({ id: Id }),
    response: OpsSetupBoard,
  }),
  opsSetupNudge: defineRoute({
    method: "POST",
    path: "/api/ops/clients/:id/setup/nudge",
    auth: "session",
    roles: OPS,
    summary: "Nudge a person something waits on: an email from their lead listing what's left",
    params: z.object({ id: Id }),
    body: z.strictObject({ userId: Id }),
    response: z.object({ sent: z.boolean(), reason: z.string().nullable() }),
  }),
  opsSetupCallAnswers: defineRoute({
    method: "POST",
    path: "/api/ops/intakes/:id/call-answers",
    auth: "session",
    roles: OPS,
    summary:
      'Answers the lead gives on a call: shown to the client as "From our call: please check" until they confirm the card',
    params: z.object({ id: Id }),
    body: CallAnswerBody,
    response: z.object({ saved: z.number().int() }),
  }),
} as const;
