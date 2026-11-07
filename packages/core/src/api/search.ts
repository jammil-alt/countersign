// v0.12 W2-F: ⌘K search (ARCHITECTURE §11.6; docs/plan.md §1.49). The portal searches its own
// client; the back office the clients it serves (or one). Up to 5 hits of each kind, each kind one
// plain SQL query inside the request's scope (RLS and `tenant_id`). The portal's hits never carry
// templates, bundles, costs or operator notes (invariant 11; the contract test checks the names).

import { z } from "zod";
import { isUuid } from "../ids";
import { defineRoute } from "./contract";
import { shortRunIdTail } from "./run-controls";
import { RunWait } from "./run-state";

const Id = z.string().refine((v) => isUuid(v), "not an id");
const OPS = ["operator"] as const;
const CLIENT = ["client_admin", "client_user"] as const;

/** Hits of each kind a search returns. */
export const SEARCH_HITS_PER_KIND = 5;

/** The longest search text. */
export const SEARCH_MAX_LENGTH = 200;

// ── Reading the query ───────────────────────────────────────────────────────────────────────────

export interface SearchText {
  /** The text, trimmed, runs of spaces made one. */
  text: string;
  /** The amount it names (`$1,234.50`, `1234.5`), as a decimal string; null when it names none. */
  amount: string | null;
  /** The hex tail of a run's short id (`R-1a2b3c`); null when it is not one. */
  runTail: string | null;
}

const isDigit = (c: string) => c >= "0" && c <= "9";
const isSpace = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r";

/** Trimmed, with each run of whitespace made one space (a plain loop: no regex on input). */
export function squeezeSpaces(input: string): string {
  let out = "";
  let pendingSpace = false;
  for (const c of input) {
    if (isSpace(c)) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) out += " ";
    pendingSpace = false;
    out += c;
  }
  return out;
}

/**
 * The amount a search names, as a decimal string, or null: digits with an optional `$` in front,
 * `,` between thousands, one `.` and up to 4 decimals (`$1,234.50` → `1234.50`). Read with a plain
 * loop.
 */
// DECISION: a minus sign, words or more than 4 decimals make it not an amount (the text still
// matches names and numbers); amounts compare with the record's total (and a receivable's balance).
export function searchAmountOf(input: string): string | null {
  let s = input.trim();
  if (s.startsWith("$")) s = s.slice(1).trim();
  let whole = "";
  let fraction: string | null = null;
  for (const c of s) {
    if (isDigit(c)) {
      if (fraction === null) whole += c;
      else fraction += c;
    } else if (c === "," && fraction === null && whole.length > 0) {
      // Thousands separator: skipped.
    } else if (c === "." && fraction === null) {
      fraction = "";
    } else {
      return null;
    }
  }
  if (whole.length === 0 || whole.length > 10) return null;
  if (fraction !== null && (fraction.length === 0 || fraction.length > 4)) return null;
  return fraction === null ? whole : `${whole}.${fraction}`;
}

export function readSearchText(q: string): SearchText {
  const text = squeezeSpaces(q).slice(0, SEARCH_MAX_LENGTH);
  return { text, amount: searchAmountOf(text), runTail: shortRunIdTail(text) };
}

/** A LIKE pattern that matches `text` anywhere, its own `%`, `_` and `\` taken literally. */
export function likeContaining(text: string): string {
  let out = "%";
  for (const c of text) out += c === "%" || c === "_" || c === "\\" ? `\\${c}` : c;
  return `${out}%`;
}

// ── Hits ────────────────────────────────────────────────────────────────────────────────────────

const Ref = z.object({ id: z.string(), name: z.string() });

export const SearchServiceHit = z.object({
  id: z.string(),
  /** The service's name (else the agent's). */
  name: z.string(),
  status: z.string().nullable(),
});

export const SearchRunHit = z.object({
  id: z.string(),
  /** `R-1a2b3c`. */
  shortId: z.string(),
  service: Ref,
  status: z.string(),
  createdAt: z.string(),
  /** The portal: the run waits on someone of the client now (UI cleanup, stream A). */
  waitingOnYou: z.boolean().optional(),
});

export const RECORD_HIT_KINDS = ["transaction", "vendor", "receivable"] as const;

export const SearchRecordHit = z.object({
  kind: z.enum(RECORD_HIT_KINDS),
  id: z.string(),
  /** A bill's vendor and number, a vendor's name, an invoice's customer and number. */
  label: z.string(),
  /** purchase, bill or vendor_credit; open, paid… for a receivable; null for a vendor. */
  type: z.string().nullable(),
  number: z.string().nullable(),
  date: z.string().nullable(),
  amount: z.string().nullable(),
  currency: z.string().nullable(),
});
export type SearchRecordHit = z.infer<typeof SearchRecordHit>;

export const SearchPersonHit = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  title: z.string().nullable(),
  organization: Ref.nullable(),
});

export const SearchOrganizationHit = z.object({
  id: z.string(),
  name: z.string(),
  kinds: z.array(z.string()),
  website: z.string().nullable(),
});

export const SearchDocumentHit = z.object({
  id: z.string(),
  filename: z.string(),
  status: z.string(),
  /** The latest reading's vendor and invoice number, when it was read. */
  vendor: z.string().nullable(),
  number: z.string().nullable(),
  receivedAt: z.string(),
});

/** The portal's hits: its own client's, never templates, bundles, costs or notes. */
export const PortalSearchResult = z.object({
  services: z.array(SearchServiceHit),
  runs: z.array(SearchRunHit),
  records: z.array(SearchRecordHit),
  people: z.array(SearchPersonHit),
  organizations: z.array(SearchOrganizationHit),
  documents: z.array(SearchDocumentHit),
});
export type PortalSearchResult = z.infer<typeof PortalSearchResult>;

const WithClient = { client: Ref };

/** The back office's hits: each names its client; agents include templates. */
export const OpsSearchResult = z.object({
  agents: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      serviceName: z.string().nullable(),
      kind: z.enum(["template", "client"]),
      /** Null for a template. */
      client: Ref.nullable(),
      status: z.string().nullable(),
    }),
  ),
  runs: z.array(
    SearchRunHit.extend({
      ...WithClient,
      mode: z.string(),
      /** The latest step summary, for telling runs apart. */
      summary: z.string().nullable(),
      /** Who the run waits on, when it waits for approval (UI cleanup, stream A). */
      waiting: RunWait.nullable().optional(),
    }),
  ),
  records: z.array(SearchRecordHit.extend(WithClient)),
  people: z.array(SearchPersonHit.extend(WithClient)),
  organizations: z.array(SearchOrganizationHit.extend(WithClient)),
  documents: z.array(SearchDocumentHit.extend(WithClient)),
});
export type OpsSearchResult = z.infer<typeof OpsSearchResult>;

/**
 * At most `limit` records, taking from each kind in turn (transactions, receivables, vendors), so
 * one kind with many hits doesn't hide the others.
 */
export function interleave<T>(lists: readonly (readonly T[])[], limit: number): T[] {
  const out: T[] = [];
  for (let i = 0; out.length < limit; i++) {
    let any = false;
    for (const list of lists) {
      const item = list[i];
      if (item === undefined) continue;
      any = true;
      if (out.length < limit) out.push(item);
    }
    if (!any) break;
  }
  return out;
}

const SearchQ = z.string().trim().min(1).max(SEARCH_MAX_LENGTH);

// ── Routes ──────────────────────────────────────────────────────────────────────────────────────

export const searchRoutes = {
  portalSearch: defineRoute({
    method: "GET",
    path: "/api/search",
    auth: "session",
    roles: CLIENT,
    summary:
      "Search your services, runs, records, people, organizations and documents: up to 5 of each",
    query: z.object({ q: SearchQ }),
    response: PortalSearchResult,
  }),
  opsSearch: defineRoute({
    method: "GET",
    path: "/api/ops/search",
    auth: "session",
    roles: OPS,
    summary:
      "Search the clients served (or one): agents and templates, runs, records, people, organizations and documents, up to 5 of each",
    query: z.object({ q: SearchQ, client: Id.optional() }),
    response: OpsSearchResult,
  }),
} as const;
