// A run step's input and output as the step panel shows them (docs/plan.md §1.95): on the portal
// only what the client may see (invariant 11: never a bundle, instructions, a prompt, a model or a
// cost), and on both sides the records and documents a step names, for its Data tab.

import { isPlainObject } from "../json";
import { FORBIDDEN_PORTAL_FIELD, FORBIDDEN_SECRET_FIELD } from "./contract";

/**
 * Keys a step's data never shows a client, beyond the contract's portal and secret fields: the
 * model a step ran on, the agent's own working (the run oversight's note stays ours, §10.11), and
 * any key naming a model or a token (a QuickBooks `syncToken` is no secret, but means nothing to
 * a client and the portal's responses carry no such key).
 */
const CLIENT_HIDDEN_KEY = /^(provider|reasoning|thinking|rationale)$|model|token/i;

/** How deep the portal copy goes; anything deeper is left out rather than sent unread. */
const MAX_DEPTH = 8;

/**
 * A step's input or output with every key a client may not read taken out, at any depth; values
 * deeper than the cut are dropped. `undefined` when nothing is left to show.
 */
// DECISION (step panel): the portal's step data is the stored value with a deny list of keys
// removed (the contract's own portal and secret field names, and models), rather than a per-skill
// allow list: step data is business data (bills, lines, record ids) and the contract names what
// must never reach a client. Check rows (confers) send none at all.
export function clientStepData(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return undefined;
  if (depth > MAX_DEPTH) return undefined;
  if (Array.isArray(value)) {
    return value.map((v) => clientStepData(v, depth + 1) ?? null);
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (
        FORBIDDEN_PORTAL_FIELD.test(k) ||
        FORBIDDEN_SECRET_FIELD.test(k) ||
        CLIENT_HIDDEN_KEY.test(k)
      ) {
        continue;
      }
      const kept = clientStepData(v, depth + 1);
      if (kept !== undefined) out[k] = kept;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  return value;
}

/** The document ids a step's data names (`documentId`, `documentIds`), at any depth, in order. */
export function stepDocumentIds(...values: unknown[]): string[] {
  const found: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === "string" && v.length > 0 && !found.includes(v)) found.push(v);
  };
  const visit = (v: unknown, depth: number) => {
    if (depth > MAX_DEPTH) return;
    if (Array.isArray(v)) {
      for (const x of v) visit(x, depth + 1);
      return;
    }
    if (!isPlainObject(v)) return;
    for (const [k, x] of Object.entries(v)) {
      if (k === "documentId") add(x);
      else if (k === "documentIds" && Array.isArray(x)) for (const d of x) add(d);
      else visit(x, depth + 1);
    }
  };
  for (const v of values) visit(v, 0);
  return found;
}
