// What a tool hands back (invariants 9 and 13). Everything read from the database is data someone
// else wrote (a client's feedback, a vendor's name, a document's text, a run's output), so it goes
// to the model inside one `<untrusted-data>` block and never in the tool's own words. Only our
// fixed sentences, counts and the confirm token sit outside it. Inside, `<` and `>` are written as
// JSON escapes, so nothing in the data can close the block early or open a tag of its own.
//
// Secrets never get this far (the routes' contracts and mappers leave them out); as a second
// guard, any field named like a secret (core's FORBIDDEN_SECRET_FIELD) is replaced before output.

import { FORBIDDEN_SECRET_FIELD } from "@countersign/core";
import type { Content, ToolResult } from "./protocol";

export const UNTRUSTED_OPEN = "<untrusted-data";
export const UNTRUSTED_CLOSE = "</untrusted-data>";
export const REDACTED = "[redacted]";

/** A copy with secret-named fields replaced by REDACTED, at any depth. */
export function scrubSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubSecrets);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = FORBIDDEN_SECRET_FIELD.test(k) ? REDACTED : scrubSecrets(v);
    }
    return out;
  }
  return value;
}

/** JSON that cannot break out of the block it is put in. */
export function safeJson(value: unknown): string {
  return JSON.stringify(scrubSecrets(value) ?? null, null, 2)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
}

/** Large free-form JSON (step input and output, payloads), shortened for a tool result. */
export function clip(value: unknown, max = 4000): unknown {
  if (value === null || value === undefined) return value ?? null;
  const text = JSON.stringify(value);
  if (text === undefined || text.length <= max) return value;
  return { truncated: true, chars: text.length, preview: text.slice(0, max) };
}

/** Our own words first, then the data, fenced. */
export function untrusted(source: string, value: unknown): string {
  return `${UNTRUSTED_OPEN} source="mezonas:${source}">\n${safeJson(value)}\n${UNTRUSTED_CLOSE}`;
}

export function dataResult(
  source: string,
  summary: string,
  value: unknown,
  extra: Content[] = [],
): ToolResult {
  return {
    content: [{ type: "text", text: `${summary}\n\n${untrusted(source, value)}` }, ...extra],
  };
}

export function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
