// The audit log in words (overnight S6.9, QA PH4 and SC2): a row's action as a person would say it
// ("Viewed a run's client timeline", "Signed in"), which of its target's ids name what (a run, an
// agent, a client), and a person's reads of one thing counted as visits. The rows themselves are
// never changed (invariant 14): this only reads them.

import { allRoutes } from "../api/all-routes";
import type { RouteSpec } from "../api/contract";

/**
 * Sent by the app (value `1`) on a request that refreshes what is already on screen (a page's
 * poll, a reload after a change), so its audit row is tagged `refresh` and isn't counted as the
 * person opening the page again. The row is kept like any other (invariant 14).
 */
export const AUDIT_REFRESH_HEADER = "x-countersign-refresh";

/** The audit target's key, value `1`, of a request the app sent as a refresh. */
export const AUDIT_REFRESH_KEY = "refresh";

/** A person's reads of the same thing within this long of the last one count as one visit (D6). */
export const AUDIT_VISIT_MINUTES = 30;

/** The thing an id in an audit target names. */
export type AuditSubject =
  | "client"
  | "agent"
  | "run"
  | "item"
  | "document"
  | "build"
  | "user"
  | "issue";

/** Actions that are not routes. */
const NAMED: Record<string, string> = {
  "session.sign_in": "Signed in",
  "session.sign_out": "Signed out",
  "agent.stage": "Moved an agent to another stage",
};

/** Route path segments, before an id, that say what the id names. */
const SEGMENT_SUBJECT: Record<string, AuditSubject> = {
  clients: "client",
  agents: "agent",
  templates: "agent",
  services: "agent",
  runs: "run",
  inbox: "item",
  documents: "document",
  builds: "build",
  users: "user",
  people: "user",
  members: "user",
  team: "user",
  issues: "issue",
};

/** Route params whose own name says what they name. */
const PARAM_SUBJECT: Record<string, AuditSubject> = {
  client: "client",
  clientId: "client",
  tenantId: "client",
  agentId: "agent",
  templateId: "agent",
  runId: "run",
  itemId: "item",
  documentId: "document",
  buildId: "build",
  userId: "user",
  issueId: "issue",
};

const ROUTE_ACTION = /^(?:mcp )?(GET|POST|PUT|PATCH|DELETE) (\/\S*)$/;

let byAction: Map<string, RouteSpec> | null = null;
function routeOf(method: string, path: string): RouteSpec | undefined {
  if (!byAction) {
    byAction = new Map(
      Object.values(allRoutes as Record<string, RouteSpec>).map((r) => [
        `${r.method} ${r.path}`,
        r,
      ]),
    );
  }
  return byAction.get(`${method} ${path}`);
}

/** Irregular past tenses of the verbs route summaries start with. */
const PAST: Record<string, string> = {
  Build: "Built",
  Choose: "Chose",
  Get: "Got",
  Give: "Gave",
  Go: "Went",
  Keep: "Kept",
  Leave: "Left",
  Let: "Let",
  Make: "Made",
  Put: "Put",
  Read: "Read",
  Run: "Ran",
  Send: "Sent",
  Set: "Set",
  Take: "Took",
  Undo: "Undid",
  Write: "Wrote",
  Cancel: "Cancelled",
};

/** Words a summary starts with that are not a verb: the summary names a thing. */
const NOT_VERBS = new Set([
  "A",
  "An",
  "The",
  "This",
  "That",
  "Your",
  "Our",
  "Its",
  "Their",
  "Each",
  "Every",
  "All",
  "One",
  "What",
  "Who",
  "Which",
  "How",
  "When",
  "Where",
  "Whether",
]);

function past(verb: string): string {
  const irregular = PAST[verb];
  if (irregular) return irregular;
  if (/e$/.test(verb)) return `${verb}d`;
  if (/[^aeiou]y$/.test(verb)) return `${verb.slice(0, -1)}ied`;
  if (/^(Stop|Pin|Plan|Ship|Drop|Tag|Flag|Admit|Submit|Commit)$/.test(verb)) {
    return `${verb}${verb.slice(-1)}ed`;
  }
  return `${verb}ed`;
}

/** The first clause of a route's summary. */
function clause(summary: string): string {
  const first = summary.split(/:|;| \(| — |, /)[0]?.trim() ?? "";
  return first;
}

const theirs = (s: string) =>
  s
    .replace(/\byour\b/g, "their")
    .replace(/\bYour\b/g, "Their")
    .replace(/\byou\b/g, "they");

/** Names a summary may start with, kept as they are mid-sentence. */
const PROPER =
  /^(QuickBooks|Gmail|Google|Outlook|Slack|Sloan|Reggie|Mezonas|WhatsApp|Zoho|Claude|SOC|HIPAA|PCI|MFA|SOP|KPI|CSV|PDF|QA|POC|AI|API|MCP)\b/;

/** A summary as the rest of a sentence: its first word in lower case, unless it is a name. */
const plainFirst = (s: string) =>
  !s || PROPER.test(s) || /^[A-Z]{2}/.test(s) ? s : `${s[0]?.toLowerCase()}${s.slice(1)}`;
const humanise = (s: string) => {
  const text = s.replace(/[._]+/g, " ").trim();
  return text ? `${text[0]?.toUpperCase()}${text.slice(1)}` : s;
};

/**
 * An audit row's action in words: "Viewed a run's client timeline" for `GET /api/runs/:id`,
 * "Added an open item to a build" for `POST /api/ops/builds/:id/items`, "Signed in" for
 * `session.sign_in`. From the route contract's own summary, so every route has its words; an
 * action no route matches is shown humanised.
 */
// DECISION (S6.9): the words come from each route's summary in the contract, not a hand list, so
// a new route never shows as a path. A read is "Viewed …", a write its summary's verb in the past.
export function auditActionWords(action: string): string {
  const named = NAMED[action];
  if (named) return named;
  const m = ROUTE_ACTION.exec(action);
  if (!m) return humanise(action);
  const [, method = "GET", path = ""] = m;
  const via = action.startsWith("mcp ") ? " (through Claude)" : "";
  const route = routeOf(method, path);
  const words = route ? clause(route.summary) : "";
  if (!words) {
    const last = path
      .split("/")
      .filter((s) => s && s !== "api" && s !== "ops" && !s.startsWith(":"))
      .at(-1);
    const thing = last ? last.replace(/[-_]+/g, " ") : "the app";
    return `${method === "GET" ? "Viewed" : "Changed"} ${thing}${via}`;
  }
  const [head = "", ...rest] = words.split(" ");
  // A read's summary names what it returns: "Viewed a run's client timeline".
  const said =
    method === "GET"
      ? `Viewed ${plainFirst(words)}`
      : NOT_VERBS.has(head) || !/^[A-Z][a-z]+$/.test(head)
        ? words
        : [past(head), ...rest].join(" ");
  // The portal's summaries speak to the client ("your inbox"); the log speaks about them.
  return `${theirs(said)}${via}`;
}

/**
 * Which of an audit row's target keys name what, read from its action's route: `/api/runs/:id`'s
 * `id` is a run, `/api/ops/clients/:id/agents/:agentId`'s `id` a client and `agentId` an agent;
 * `client` (the requested client) is always a client.
 */
export function auditTargetSubjects(action: string): Record<string, AuditSubject> {
  const out: Record<string, AuditSubject> = { client: "client" };
  const m = ROUTE_ACTION.exec(action);
  if (!m) return out;
  const segments = (m[2] ?? "").split("/");
  segments.forEach((s, i) => {
    if (!s.startsWith(":")) return;
    const param = s.slice(1);
    const bySegment = SEGMENT_SUBJECT[segments[i - 1] ?? ""];
    const subject = PARAM_SUBJECT[param] ?? (param === "id" ? bySegment : undefined);
    if (subject) out[param] = subject;
  });
  return out;
}

/** Whether an audit row's target says the app sent it as a refresh of what was on screen. */
export function isAuditRefresh(target: unknown): boolean {
  return (
    typeof target === "object" &&
    target !== null &&
    (target as Record<string, unknown>)[AUDIT_REFRESH_KEY] === "1"
  );
}
