// Connectors C4 (docs/connectors-plan.md §5.4, §7.1, §7.2): the rules for a change to a client's
// connection. What a change does row by row and whether it is tighter or looser
// (`changeDirection`); what a client admin may set themselves (`clientMayAllow`); whether an edit of
// ours fits the client's standing say (`withinAuthorization`); and a change request's life (stale,
// expired). Pure: the API decides with these, the portal and the back office word them.

import { canonicalJson } from "../canonical";
import { deepEqual, isPlainObject } from "../json";
import {
  CONNECTION_CHANGE_REQUEST_DAYS,
  type ConnectionRowChange,
  type MezonasMay,
} from "../schemas/connection-requests";
import type {
  PermissionEntity,
  PermissionLevel,
  PermissionMatrix,
  Verb,
} from "../schemas/permissions";
import { levelFor } from "./decide";
import { declaredEntity, declaredScope, readEntities } from "./entities";
import type { ConnectorNeed } from "./needs";

const VERBS: readonly Verb[] = ["read", "create", "update", "delete"];
const STRICTNESS: Record<PermissionLevel, number> = { auto: 0, approval: 1, off: 2 };
const DAY_MS = 24 * 60 * 60 * 1000;

/** A connection's settings as these rules read them: a stored matrix may leave verbs out. */
export interface SettingsLike {
  permissions: Partial<PermissionMatrix> | null | undefined;
  config: Readonly<Record<string, unknown>> | null | undefined;
}

export type RowDirection = "tighter" | "looser";
export type ChangeDirection = "none" | "tighter" | "looser" | "mixed";

/**
 * A verb's level, for the whole connection (`entity` null: the group's own control, and any tool
 * with no record type) or for one record type (its level as the gate reads it: the stricter of
 * the verb's and its own).
 */
export interface LevelRowChange {
  kind: "level";
  verb: Verb;
  entity: string | null;
  from: PermissionLevel;
  to: PermissionLevel;
  direction: RowDirection;
}

/**
 * A scope: on a record type and verb (a declared scope's id, null for none), or the connection's
 * own connector-specific scope (`entity` and `verb` null; its value is opaque).
 */
export interface ScopeRowChange {
  kind: "scope";
  verb: Verb | null;
  entity: string | null;
  from: unknown;
  to: unknown;
  direction: RowDirection;
}

/**
 * One key of the tool's setup (`connection.config`): a list (folders, channels, sheets) says what
 * it added and removed; any other value only that it changed.
 */
export interface SetupRowChange {
  kind: "setup";
  key: string;
  /** For a list on both sides (or a list and nothing): the items added and removed. */
  added: unknown[] | null;
  removed: unknown[] | null;
  direction: RowDirection;
}

export type RowChange = LevelRowChange | ScopeRowChange | SetupRowChange;

export interface ChangeResult {
  direction: ChangeDirection;
  rows: RowChange[];
}

function stricter(a: PermissionLevel, b: PermissionLevel): PermissionLevel {
  return STRICTNESS[a] >= STRICTNESS[b] ? a : b;
}

function levelDirection(from: PermissionLevel, to: PermissionLevel): RowDirection {
  return STRICTNESS[to] < STRICTNESS[from] ? "looser" : "tighter";
}

function own<T>(record: Readonly<Record<string, T>> | null | undefined, key: string) {
  return record && Object.hasOwn(record, key) ? record[key] : undefined;
}

/** A record type's level for a verb as the gate reads it, before any grant or tool scope. */
function entityLevel(
  matrix: Partial<PermissionMatrix> | null | undefined,
  entity: string,
  verb: Verb,
): PermissionLevel {
  const entities = readEntities(matrix ?? undefined);
  if (entities === null) return "off";
  return stricter(levelFor(matrix ?? undefined, verb), own(entities, entity)?.[verb] ?? "auto");
}

/** The tools a scope id lets through, null for no scope (every tool); unknown ids let none. */
function scopeToolSet(
  declared: readonly PermissionEntity[] | undefined,
  entity: string,
  verb: Verb,
  scopeId: unknown,
): readonly string[] | null {
  if (scopeId === undefined || scopeId === null) return null;
  return typeof scopeId === "string"
    ? (declaredScope(declared, entity, verb, scopeId)?.tools ?? [])
    : [];
}

// DECISION: a scope change on a record type is tighter when it lets through no tool it didn't
// before (no scope → a scope, or a scope with fewer of the declared tools); without the
// connector's declared scopes, moving from one scope to another counts as looser. The
// connection's own connector-specific scope is opaque, so any change to it counts as looser.
function scopeDirection(
  declared: readonly PermissionEntity[] | undefined,
  entity: string,
  verb: Verb,
  from: unknown,
  to: unknown,
): RowDirection {
  if (to === undefined || to === null) return "looser";
  if (from === undefined || from === null) return "tighter";
  if (!declared) return "looser";
  const before = scopeToolSet(declared, entity, verb, from) ?? [];
  const after = scopeToolSet(declared, entity, verb, to) ?? [];
  return after.some((t) => !before.includes(t)) ? "looser" : "tighter";
}

/** A list item's identity: its `id` when it is an object with one, else its canonical JSON. */
function itemKey(item: unknown): string {
  if (isPlainObject(item) && typeof item.id === "string") return `id:${item.id}`;
  return canonicalJson(item ?? null);
}

// DECISION (docs/plan.md §1.161, C4): a setup value that is a list (folders, channels, sheets) is
// compared by item (an object's `id`, else its JSON): any item added is looser, only items removed
// is tighter. Any other setup change (a Gmail query, a new key, a key dropped) counts as looser,
// since the platform can't judge whether it gives agents more.
function setupRow(key: string, from: unknown, to: unknown): SetupRowChange | null {
  if (deepEqual(from, to)) return null;
  const fromList = Array.isArray(from) ? from : from === undefined ? [] : null;
  const toList = Array.isArray(to) ? to : to === undefined ? [] : null;
  if (fromList && toList) {
    const had = new Set(fromList.map(itemKey));
    const has = new Set(toList.map(itemKey));
    const added = toList.filter((i) => !had.has(itemKey(i)));
    const removed = fromList.filter((i) => !has.has(itemKey(i)));
    // Same items in another order: nothing a person would call a change.
    if (added.length === 0 && removed.length === 0) return null;
    return {
      kind: "setup",
      key,
      added,
      removed,
      direction: added.length > 0 ? "looser" : "tighter",
    };
  }
  return { kind: "setup", key, added: null, removed: null, direction: "looser" };
}

/**
 * What a change to a connection's settings does, row by row, and whether it is tighter, looser or
 * both. Rows: each verb whose level changed (the group's control, `entity` null); each record type
 * whose level for a verb changed as the gate reads it (the declared ones, and any either matrix
 * names); each scope changed; each setup key changed. Pass the connector's `permissionEntities`:
 * without them, opening a verb shows only the verb's row, not the record types it opens.
 */
export function changeDirection(
  before: SettingsLike,
  after: SettingsLike,
  declared?: readonly PermissionEntity[] | undefined,
): ChangeResult {
  const rows: RowChange[] = [];
  const b = before.permissions ?? undefined;
  const a = after.permissions ?? undefined;

  for (const verb of VERBS) {
    const from = levelFor(b, verb);
    const to = levelFor(a, verb);
    if (from !== to) {
      rows.push({
        kind: "level",
        verb,
        entity: null,
        from,
        to,
        direction: levelDirection(from, to),
      });
    }
  }

  const eb = readEntities(b);
  const ea = readEntities(a);
  const ids = new Set<string>([
    ...(declared ?? []).map((e) => e.id),
    ...Object.keys(eb ?? {}),
    ...Object.keys(ea ?? {}),
  ]);
  for (const id of [...ids].sort()) {
    const known = declaredEntity(declared, id);
    for (const verb of VERBS) {
      // A declared record type has rows for its own verbs; one only a matrix names, for every
      // verb. Never delete: it is off for every record type (the verb's row says the rest).
      if (verb === "delete" || (known && !known.verbs.includes(verb))) continue;
      const from = entityLevel(b, id, verb);
      const to = entityLevel(a, id, verb);
      if (from !== to) {
        rows.push({
          kind: "level",
          verb,
          entity: id,
          from,
          to,
          direction: levelDirection(from, to),
        });
      }
      const sFrom = own(eb, id)?.scope?.[verb] ?? null;
      const sTo = own(ea, id)?.scope?.[verb] ?? null;
      if (sFrom !== sTo) {
        rows.push({
          kind: "scope",
          verb,
          entity: id,
          from: sFrom,
          to: sTo,
          direction: scopeDirection(declared, id, verb, sFrom, sTo),
        });
      }
    }
  }

  if (!deepEqual(b?.scope, a?.scope)) {
    rows.push({
      kind: "scope",
      verb: null,
      entity: null,
      from: b?.scope ?? null,
      to: a?.scope ?? null,
      direction: "looser",
    });
  }

  const cb = before.config ?? {};
  const ca = after.config ?? {};
  for (const key of [...new Set([...Object.keys(cb), ...Object.keys(ca)])].sort()) {
    const row = setupRow(key, own(cb, key), own(ca, key));
    if (row) rows.push(row);
  }

  const looser = rows.some((r) => r.direction === "looser");
  const tighter = rows.some((r) => r.direction === "tighter");
  const direction: ChangeDirection =
    looser && tighter ? "mixed" : looser ? "looser" : tighter ? "tighter" : "none";
  return { direction, rows };
}

// ── Words ────────────────────────────────────────────────────────────────────────────────────

const VERB_WORDS: Record<Verb, string> = {
  read: "Read",
  create: "Create",
  update: "Update",
  delete: "Delete",
};

/** A level in the connector page's words: reads are On or Off; writes Ask me first, On its own. */
export function levelWords(verb: Verb, level: PermissionLevel): string {
  if (level === "off") return "Off";
  if (verb === "read") return "On";
  return level === "auto" ? "On its own" : "Ask me first";
}

/** A record type's label from the connector's declared ones, else its id in words. */
export function entityWords(
  entity: string,
  declared?: readonly PermissionEntity[] | undefined,
): string {
  return declaredEntity(declared, entity)?.label ?? entity.replaceAll("_", " ");
}

function lowerFirst(s: string): string {
  return s.length > 0 ? s[0]?.toLowerCase() + s.slice(1) : s;
}

/** A row's name: "Create bills", "Read" (the group's own control), "Setup: folders". */
export function rowWords(
  row: RowChange,
  declared?: readonly PermissionEntity[] | undefined,
): string {
  if (row.kind === "setup") return `Setup: ${row.key.replaceAll("_", " ")}`;
  if (row.kind === "scope" && row.verb === null) return "Connection scope";
  const verb = VERB_WORDS[row.verb as Verb];
  const what = row.entity ? `${verb} ${lowerFirst(entityWords(row.entity, declared))}` : verb;
  return row.kind === "scope" ? `${what}: scope` : what;
}

function scopeWords(
  row: ScopeRowChange,
  value: unknown,
  declared: readonly PermissionEntity[] | undefined,
): string {
  if (value === null || value === undefined) return row.verb === null ? "None" : "Everything";
  if (row.entity && row.verb && typeof value === "string") {
    return declaredScope(declared, row.entity, row.verb, value)?.label ?? value;
  }
  return "Changed";
}

/**
 * A row in plain words, ready for a screen or a notice: "Create bills: Off → Ask me first",
 * "Setup: folders: 2 added, 1 removed", "Setup: query: changed".
 */
export function describeRowChange(
  row: RowChange,
  declared?: readonly PermissionEntity[] | undefined,
): string {
  const name = rowWords(row, declared);
  if (row.kind === "level") {
    return `${name}: ${levelWords(row.verb, row.from)} → ${levelWords(row.verb, row.to)}`;
  }
  if (row.kind === "scope") {
    if (row.verb === null) return `${name}: changed`;
    return `${name}: ${scopeWords(row, row.from, declared)} → ${scopeWords(row, row.to, declared)}`;
  }
  if (row.added === null || row.removed === null) return `${name}: changed`;
  const parts: string[] = [];
  if (row.added.length > 0) parts.push(`${row.added.length} added`);
  if (row.removed.length > 0) parts.push(`${row.removed.length} removed`);
  return `${name}: ${parts.join(", ")}`;
}

/** A row as the API sends it: the row and its words. */
export function rowChangeView(
  row: RowChange,
  declared?: readonly PermissionEntity[] | undefined,
): ConnectionRowChange {
  return { ...row, label: describeRowChange(row, declared) } as ConnectionRowChange;
}

// ── What a client admin may set (§5.4) ───────────────────────────────────────────────────────

export interface RefusedRow {
  row: RowChange;
  reason: string;
}

export type ClientMayAllowResult = { ok: true } | { ok: false; refused: RefusedRow[] };

/**
 * The client admin's rule (docs/connectors-plan.md §5.4): any read on or off; any write between
 * Off and Ask me first; a write lowered from On its own; never a write set to On its own (one that
 * already was stays); delete never on. The tool's setup is theirs. Refused rows say why.
 */
// DECISION (docs/plan.md §1.161, C4): the connection's own connector-specific scope stays the
// operator's (as before: the platform can't judge it). A record type's scope the client may set
// or widen, except where the row then runs on its own: widening that lets more run without anyone
// signing is ours to ask for.
export function clientMayAllow(
  before: SettingsLike,
  after: SettingsLike,
  declared?: readonly PermissionEntity[] | undefined,
): ClientMayAllowResult {
  const { rows } = changeDirection(before, after, declared);
  const refused: RefusedRow[] = [];
  for (const row of rows) {
    if (row.kind === "level") {
      if (row.verb === "delete" && row.to !== "off") {
        refused.push({ row, reason: "Delete stays off." });
      } else if (row.verb !== "read" && row.to === "auto") {
        refused.push({
          row,
          reason:
            "On its own is something we propose for you to approve. Choose Ask me first or Off.",
        });
      }
      continue;
    }
    if (row.kind === "scope") {
      if (row.verb === null) {
        refused.push({ row, reason: "Only Mezonas changes this connection's scope." });
        continue;
      }
      if (
        row.direction === "looser" &&
        row.verb !== "read" &&
        row.entity !== null &&
        entityLevel(after.permissions, row.entity, row.verb) === "auto"
      ) {
        refused.push({
          row,
          reason:
            "This would let more run on its own. Set the row to Ask me first before widening it.",
        });
      }
    }
  }
  return refused.length === 0 ? { ok: true } : { ok: false, refused };
}

// ── Changes by Mezonas (§7.2) ────────────────────────────────────────────────────────────────

/** How long a client admin's go-ahead lasts: until they turn it off, or 30 days. */
export const MEZONAS_MAY_DURATIONS = ["until_off", "30_days"] as const;
export type MezonasMayDuration = (typeof MEZONAS_MAY_DURATIONS)[number];

/** When a go-ahead set now ends (ISO), or null for until turned off. */
export function mezonasMayUntil(duration: MezonasMayDuration, now: Date): string | null {
  return duration === "30_days" ? new Date(now.getTime() + 30 * DAY_MS).toISOString() : null;
}

/** The go-ahead in force now, or null: none set, or its `until` has passed. */
export function activeMezonasMay(may: MezonasMay | null | undefined, now: Date): MezonasMay | null {
  if (!may) return null;
  if (may.until !== null && Date.parse(may.until) <= now.getTime()) return null;
  return may;
}

export interface ProposedChange {
  before: SettingsLike;
  after: SettingsLike;
  /** The connector's `permissionEntities`, so a verb opened shows the record types it opens. */
  declared?: readonly PermissionEntity[] | undefined;
}

export type WithinAuthorization =
  | { fits: true }
  | { fits: false; reason: string; rows: RowChange[] };

/** Whether a need calls for a level row: same verb, and the row's record type (or the verb's). */
function needCovers(need: ConnectorNeed, row: LevelRowChange): boolean {
  if (need.verb !== row.verb) return false;
  // The verb's own row opens with any need of that verb (allowNeeds opens it, pinning the rest).
  if (row.entity === null) return true;
  return need.entity === row.entity;
}

/**
 * Whether an edit of ours fits the client's go-ahead on this connection (§7.2), so it applies at
 * once instead of going to them as a request. Only the looser rows need covering: a tighter row
 * always applies. Nothing covers On its own or delete; an ended go-ahead covers nothing; `needs`
 * covers level rows an agent's need calls for (`needs`: those of the agents bound to this
 * connection), up to Ask me first; `any` covers every row and the setup, up to Ask me first.
 */
// DECISION (docs/plan.md §1.161, C4): under `needs`, a scope widened and a setup change are never
// covered: allowNeeds never makes either, and neither is a record type and verb an agent needs.
export function withinAuthorization(
  change: ProposedChange,
  mezonasMay: MezonasMay | null | undefined,
  needs: readonly ConnectorNeed[],
  now: Date,
): WithinAuthorization {
  const { rows } = changeDirection(change.before, change.after, change.declared);
  const looser = rows.filter((r) => r.direction === "looser");
  if (looser.length === 0) return { fits: true };

  const deletes = looser.filter((r) => r.kind === "level" && r.verb === "delete");
  if (deletes.length > 0) return { fits: false, reason: "Delete stays off.", rows: deletes };
  const auto = looser.filter((r) => r.kind === "level" && r.verb !== "read" && r.to === "auto");
  if (auto.length > 0) {
    return { fits: false, reason: "On its own always goes to the client to approve.", rows: auto };
  }

  if (!mezonasMay) {
    return { fits: false, reason: "The client asks to approve each change here.", rows: looser };
  }
  if (!activeMezonasMay(mezonasMay, now)) {
    const ended = mezonasMay.until ? mezonasMay.until.slice(0, 10) : "";
    return {
      fits: false,
      reason: `The client's go-ahead ended on ${ended}.`,
      rows: looser,
    };
  }
  if (mezonasMay.choice === "any") return { fits: true };

  const uncovered = looser.filter(
    (r) => r.kind !== "level" || !needs.some((n) => needCovers(n, r)),
  );
  if (uncovered.length === 0) return { fits: true };
  const first = uncovered[0] as RowChange;
  const reason =
    first.kind === "setup"
      ? "The client lets us make changes agents need; a setup change goes to them to approve."
      : `${rowWords(first, change.declared)} isn't something an agent needs.`;
  return { fits: false, reason, rows: uncovered };
}

// ── Change requests (§7.1) ───────────────────────────────────────────────────────────────────

/** Settings in one shape, so equal settings compare equal whatever their keys' order or gaps. */
export function normalizeSettings(s: SettingsLike): {
  permissions: Record<string, unknown>;
  config: Record<string, unknown>;
} {
  const p = s.permissions ?? undefined;
  const permissions: Record<string, unknown> = {};
  for (const verb of VERBS) permissions[verb] = levelFor(p, verb);
  if (p?.scope !== undefined) permissions.scope = p.scope;
  const entities = p?.entities;
  if (entities !== undefined && !(isPlainObject(entities) && Object.keys(entities).length === 0)) {
    permissions.entities = entities;
  }
  return { permissions, config: { ...(s.config ?? {}) } };
}

/** Whether two settings are the same (verbs left out read as the platform's defaults). */
export function settingsEqual(a: SettingsLike, b: SettingsLike): boolean {
  return canonicalJson(normalizeSettings(a)) === canonicalJson(normalizeSettings(b));
}

/**
 * A request is Out of date once the connection's settings are no longer the ones it was made
 * against (the client changed something since): approving it is refused, never applied over.
 */
export function requestStale(request: { against: SettingsLike }, current: SettingsLike): boolean {
  return !settingsEqual(request.against, current);
}

/** When a request made at `createdAt` ends unanswered (14 days on). */
export function requestExpiresAt(createdAt: Date): Date {
  return new Date(createdAt.getTime() + CONNECTION_CHANGE_REQUEST_DAYS * DAY_MS);
}

/** Whether an open request has passed its end (a closed one is never newly expired). */
export function requestExpired(
  request: { status?: string | undefined; expiresAt: Date | string },
  now: Date,
): boolean {
  if (request.status !== undefined && request.status !== "open") return false;
  const ends =
    request.expiresAt instanceof Date ? request.expiresAt.getTime() : Date.parse(request.expiresAt);
  return now.getTime() >= ends;
}
