// The Builder's guide to step kinds (owner, 2026-11-24: "how do we make sure the builder knows all
// of its options, what is available and how it works?"). One entry per step kind: when to use it,
// what to mind, and an example that parses as a step. The Builder's rules are written from it
// (`stepGuideText`), so what the Builder is told about steps is never older than the schema:
// - the type below names every kind of `Step`, so a new kind without an entry doesn't compile;
// - a test parses every example against `Step`, so an example that falls behind fails CI.
// The catalog (tools, skills, connectors, events, automations, templates, models) already comes
// from the registries; this is the part that was hand-written in the rules and fell behind
// (Collect reports, repeat and hand-off were missing).

import type { TriggerOn } from "../schemas/workflow";
import type { Checks, StepKind } from "./schema";

export interface StepGuideEntry {
  /** When to use it, in one or two sentences. */
  use: string;
  /** What to mind: the fields that matter and the mistakes to avoid. */
  mind: string;
  /** A step of this kind, as JSON; it parses against `Step`. */
  example: Record<string, unknown>;
}

const person = (id: string, title: string) => ({
  id,
  kind: "person",
  name: title,
  mode: "ask",
  assignee: "client_admin",
  title,
  payload: {},
  deadline: { after: "2 days", hours: "business" },
});

export const STEP_GUIDE: { readonly [K in StepKind]: StepGuideEntry } = {
  read: {
    use: "Read from a tool without changing anything: search the CRM, get a record, read a document.",
    mind: "Its tool's sideEffect is \"none\". The output is the tool's output: later steps read it as {{steps.<id>.output.<field>}}.",
    example: {
      id: "find_account",
      kind: "read",
      name: "Find the account in Zoho",
      tool: "zoho_crm.record.search",
      input: { module: "Accounts", word: "{{item.buyer}}" },
    },
  },
  skill: {
    use: "Run a skill: one job with a typed input and output (read a document into fields, match, classify, clean rows, draft). Built-in skills also do work in code: Read table (data.read-table) reads a spreadsheet into rows, Reshape data (data.reshape) renames and reformats fields. Three run only as a skill step, never as a tool: Request info (forms.request) sends a person a form and waits for the answers, Reach out (comms.reach-out) sends a contact a message, Converse (comms.converse) holds a conversation.",
    mind: 'Its input must give the skill\'s required input fields. A spreadsheet is never read by a model: Read table reads it (its expected columns in "customize": {"parameters": {"columns": [...]}}), and a skill after it takes the rows. Where no skill in the catalog does a job that needs judgment, the job needs a new skill: say what it gets and gives back.',
    example: {
      id: "read_file",
      kind: "skill",
      name: "Read the UCC file",
      skill: "data.read-table",
      input: { documentId: "{{trigger.documents[0]}}" },
    },
  },
  write: {
    use: "Change something: a client's tool (external) or a platform record (internal). Update a CRM record, create a bill, save a document, make a .csv or .xlsx file (Write table, the tool data.table.write).",
    mind: 'An external write keeps its approval check on ("checks": {"approval": {"required": "required"}}). One write per record: inside a for_each to write many.',
    example: {
      id: "save_outcome",
      kind: "write",
      name: "Record the outcome on the deal",
      tool: "zoho_crm.record.update",
      input: { module: "Deals", id: "{{item.dealId}}", fields: { Stage: "{{item.outcome}}" } },
      checks: { approval: { required: "required" } },
    },
  },
  person: {
    use: 'Ask a person on the client\'s team (mode "ask") or get their approval (mode "approve"): a review, a decision the agent can\'t make, work no part of the catalog does yet.',
    mind: 'It has an assignee ("client_admin", "lead", "operator", a "seat:<role>" the client fills, or a person), a title, a payload of what they need to see, and a deadline (with reminders and what happens if nobody answers). Later steps read the answer.',
    example: person("assign_by_hand", "Assign the filings no territory rule covers"),
  },
  conversation: {
    use: "Talk with a contact outside the client (a vendor, a customer) by email, SMS, WhatsApp or a call until a goal is met, and record what it finds out.",
    mind: 'It has a goal, what it must find ("find": field to type), the most turns, and a deadline. Its messages need approval unless the operator loosens them; never loosen them yourself.',
    example: {
      id: "ask_vendor",
      kind: "conversation",
      name: "Ask the vendor for the missing invoice",
      with: "{{trigger.vendorEmail}}",
      channel: "email",
      goal: "Get a copy of invoice {{trigger.number}}",
      find: { invoiceDocumentId: "string" },
      deadline: { after: "3 days", hours: "business" },
    },
  },
  notify: {
    use: "A note to the client's team or ours: a summary at the end, a heads-up. Anyone outside the client is a write or a conversation, never a notify.",
    mind: 'Say who ("to"), the channel (inbox, email, sms) and the message, with {{...}} references to what the run found. A run that names no other end ends with one.',
    example: {
      id: "tell_team",
      kind: "notify",
      name: "Send the report to the team",
      notify: {
        to: ["client_admin"],
        channel: "email",
        message: "The UCC report for {{trigger.month}} is ready.",
      },
    },
  },
  if: {
    use: "A decision: ordered paths, each with its rules (or chosen by the agent); the first that matches runs, else otherwise, then the process goes on below the if.",
    mind: 'A path holds only what differs between the paths; steps for every case go after the if. With "decide": "agent" the agent picks by each path\'s "describe" (and "ifUnsure": "ask" sends a person). End a path with a stop only when that case must not go on.',
    example: {
      id: "any_unassigned",
      kind: "if",
      name: "If any filing has no territory",
      paths: [
        {
          id: "some_unassigned",
          name: "Some have none",
          when: {
            rules: [{ field: "{{steps.assign.output.unassignedCount}}", op: ">", value: 0 }],
          },
          steps: [person("assign_rest", "Assign the filings no rule covers")],
        },
      ],
      otherwise: { id: "all_assigned", steps: [] },
    },
  },
  for_each: {
    use: "Do the same steps for each item of a list: each filing, each invoice line, each sales manager's group.",
    mind: 'Its "over" is a list from an earlier step; inside, {{item}} is the item and {{index}} its place. Its steps are the per-item work, all of it: they run for every item (up to "concurrency" at once).',
    example: {
      id: "each_manager",
      kind: "for_each",
      name: "For each sales manager",
      over: "{{steps.group.output.groups}}",
      steps: [person("manager_review", "Review your filings for {{item.key}}")],
    },
  },
  repeat: {
    use: "Do steps again until something is true: ask until the answer is complete, check until a payment shows, at most a few times, with a wait between.",
    mind: 'Its "until" is plain rules over the pass, or {"agent": {"goal": ...}}; "maxTimes" (at most 10), "between" (a duration) and "onLimit" (stop or proceed) say how long it tries.',
    example: {
      id: "until_complete",
      kind: "repeat",
      name: "Ask until the form is complete",
      steps: [person("fill_form", "Complete your filings form")],
      until: { agent: { goal: "Every filing has an outcome and a reason" } },
      maxTimes: 3,
      between: "2 days",
      onLimit: "proceed",
    },
  },
  wait: {
    use: "Wait a set time before going on.",
    mind: 'Use it for a fixed pause only; a wait for a person is their step\'s deadline, and a wait for an answer is a person, conversation or collect step. "for" is a duration like "2 days".',
    example: { id: "pause", kind: "wait", name: "Wait two days", for: "2 days" },
  },
  stop: {
    use: "End the run here: nothing more to do in this case, or it can't go on.",
    mind: 'Its "status" is succeeded, failed or cancelled. Use it at the end of a path that must not go on; the end of the steps ends the run without one.',
    example: {
      id: "nothing_new",
      kind: "stop",
      name: "Stop: no filings this month",
      status: "succeeded",
    },
  },
  process: {
    use: "Run an automation from the catalog as one step: steps someone already built and reuses, pinned to a version.",
    mind: 'Its "process" is the automation\'s ref, "slug@version", from the catalog; its input gives the automation\'s input.',
    example: {
      id: "match_vendor",
      kind: "process",
      name: "Match the vendor",
      process: "match-vendor@1",
      input: { documentId: "{{trigger.documentId}}" },
    },
  },
  handoff: {
    use: 'Start another run: another agent of the same client at one of its steps, or this agent\'s own main workflow ("agent": "@self") from a second way in. This run goes on at once.',
    mind: 'A way in with its own steps first (a schedule that finds items) hands each item off into the main workflow with "@self"; never copy the main workflow\'s steps.',
    example: {
      id: "to_main",
      kind: "handoff",
      name: "Hand each bill to the main workflow",
      to: { agent: "@self", workflow: "main", step: "read_bill" },
      input: { documentId: "{{item.documentId}}" },
    },
  },
  missing: {
    use: "A part that can't be built yet, held where it belongs: no connector, tool or skill does it.",
    mind: 'It never runs, and the operator fills it. "need" says what is missing in one sentence; "fill" says what would fill it (connector, tool or skill). In a draft that must run as it is, a person step stands in for it instead.',
    example: {
      id: "read_bank",
      kind: "missing",
      name: "Read the bank statement",
      need: "There is no bank connector, so it can't read the statement.",
      fill: "connector",
    },
  },
  collect: {
    use: "Wait for files (reports) from named people on a schedule: each report has an owner, the period it covers, its format (PDF, spreadsheet, image), a due date and follow-ups. Each owner gets a link to send the file; what comes back is checked in code; a late report is escalated.",
    mind: 'Its owners are fixed in the step ("seat:<role>" each client fills, or a person), at most 20 reports. It collects files, not answers: asking each person in a list for answers through a form is a for_each with a Request info skill step (forms.request). Later steps read {{steps.<id>.output.documents}}.',
    example: {
      id: "collect_reports",
      kind: "collect",
      name: "Collect the monthly sales reports",
      items: [
        {
          id: "houston_report",
          name: "Houston sales report",
          owner: "seat:houston-manager",
          frequency: "monthly",
          formats: ["spreadsheet"],
          due: "2 days",
          hours: "business",
          followUp: { after: "1 day", every: "2 days", max: 2 },
        },
      ],
      escalate: {
        to: "seat:regional-manager",
        after: "4 days",
        deadline: { after: "1 day", hours: "business" },
      },
    },
  },
};

/** The step kinds as the Builder's rules list them: use, what to mind, and an example each. */
export function stepGuideText(): string {
  return (Object.keys(STEP_GUIDE) as StepKind[])
    .map((kind) => {
      const g = STEP_GUIDE[kind];
      return `- ${kind}: ${g.use} ${g.mind} Example: ${JSON.stringify(g.example)}`;
    })
    .join("\n");
}

// ── Ways in ─────────────────────────────────────────────────────────────────────────────────────

/** A trigger's kind (`on.type`). */
export type TriggerKind = TriggerOn["type"];

export interface TriggerGuideEntry {
  use: string;
  mind: string;
  /** A trigger's `on`, as JSON; it parses against `TriggerOn`. */
  example: Record<string, unknown>;
}

// DECISION (owner, 2026-11-24): the rules named four ways in (manual, event, schedule, command);
// message, webhook and hand-off were in the schema but not in what the Builder was told, so "when
// the UCC file arrives by email" had no way in it knew of. Typed over every kind, as the steps are.
export const TRIGGER_GUIDE: { readonly [K in TriggerKind]: TriggerGuideEntry } = {
  event: {
    use: 'Something happened in Mezonas: a document arrived (by upload or forwarded email, "document.received"), a transaction came in, an alert was raised. The event types are in the catalog.',
    mind: 'A "filter" (rules over the event) narrows it. The event\'s payload is {{trigger.<field>}}; a received document is {{trigger.documentId}}.',
    example: { type: "event", event: "document.received" },
  },
  message: {
    use: "A message arrives on one of the client's channels (email, SMS, WhatsApp, a command or Sloan) from the people it names: the UCC file emailed by the provider, a text from a field crew.",
    mind: 'Say the channels and who it is from ("from": relationships, contact tags, contact ids or the client\'s roles). Its attachments are documents: {{trigger.documents}}. "reply.confirm" sends fixed words back.',
    example: { type: "message", channels: ["email"], from: { tags: ["ucc-provider"] } },
  },
  schedule: {
    use: "On a schedule: every weekday morning, the first Monday of the month, month end.",
    mind: 'A five-field cron in the client\'s time zone; "1#1" in its last field is the first Monday, "5L" the last Friday, "L" as the day the last day; every other week adds "every": {"weeks": 2, "from": a Sunday}. "skipHolidays" skips US holidays.',
    example: { type: "schedule", cron: "0 8 1 * *" },
  },
  manual: {
    use: "Someone starts it by hand, with a form built from its input: Run now in the back office, or the client's own Run button when allowed.",
    mind: '"input" is the JSON Schema of what is asked for; "client": {"canRun": true} lets the client start it.',
    example: {
      type: "manual",
      input: { type: "object", properties: { month: { type: "string" } }, required: ["month"] },
    },
  },
  command: {
    use: 'A "/command" posted in a thread starts it.',
    mind: "The command's words are {{trigger.args}}.",
    example: { type: "command", command: "ucc-report" },
  },
  webhook: {
    use: "Another system posts to one of the client's inbound hooks.",
    mind: 'It names the hook ("hookId"); its delivery is {{trigger.data.<field>}}; a "dedupeKey" starts one run per key.',
    example: { type: "webhook", hookId: "01a20000-0000-7000-8000-000000000001" },
  },
  handoff: {
    use: "Another agent of the same client hands work to this one.",
    mind: '"from" names the agent (and one of its workflows); what it hands over is {{trigger.<field>}}.',
    example: { type: "handoff", from: { agent: "ucc-intake" } },
  },
};

/** The ways in as the Builder's rules list them. */
export function triggerGuideText(): string {
  return (Object.keys(TRIGGER_GUIDE) as TriggerKind[])
    .map((kind) => {
      const g = TRIGGER_GUIDE[kind];
      return `- ${kind}: ${g.use} ${g.mind} Example "on": ${JSON.stringify(g.example)}`;
    })
    .join("\n");
}

// ── Checks on a step ───────────────────────────────────────────────────────────────────────────

export type CheckKind = keyof Checks;

export interface CheckGuideEntry {
  use: string;
  /** A step's `checks` holding this check alone; it parses against `Checks`. */
  example: Record<string, unknown>;
}

export const CHECK_GUIDE: { readonly [K in CheckKind]-?: CheckGuideEntry } = {
  approval: {
    use: 'A person\'s yes before the step\'s write. On every step that changes a client\'s tool ("required": "required", no "when"); never loosen it.',
    example: { approval: { required: "required" } },
  },
  confer: {
    use: "A second opinion on the step's result, from another model or a person, before it goes on. It never changes the output and never approves a write.",
    example: {
      confer: { with: [{ ai: { focus: "Is every filing's outcome supported by a deal?" } }] },
    },
  },
  notify: {
    use: "Tell the client's team (or ours) after the step: who, the channel and the message.",
    example: { notify: [{ to: ["client_admin"], message: "{{steps.save.output.count}} saved." }] },
  },
};

/** The checks as the Builder's rules list them. */
export function checkGuideText(): string {
  return (Object.keys(CHECK_GUIDE) as CheckKind[])
    .map(
      (kind) =>
        `- ${kind}: ${CHECK_GUIDE[kind].use} Example "checks": ${JSON.stringify(CHECK_GUIDE[kind].example)}`,
    )
    .join("\n");
}
