// Text Postgres can store (BUILDER_QA INPUT-1, INPUT-3): no NUL (U+0000), which text and jsonb
// refuse, and whole characters, since a lone UTF-16 surrogate (half of an emoji or a rare CJK
// character) fails a jsonb write. One rule for the schemas that take people's text, and one cutter
// for code that shortens text before it is stored.

import { z } from "zod";

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** What a schema says when text breaks the rule. */
export const STORABLE_TEXT_MESSAGE =
  "The text has a character we can't store: a NUL, or half of a character such as an emoji cut in two.";

/** No NUL and no lone surrogate. */
export function storableText(text: string): boolean {
  return !text.includes("\u0000") && !LONE_SURROGATE.test(text);
}

/** A string schema that refuses text Postgres can't store, with a 400 naming the field. */
export function storable(schema: z.ZodString = z.string()): z.ZodString {
  return schema.refine(storableText, STORABLE_TEXT_MESSAGE);
}

/** Every string in a JSON-like value, keys included, is storable text. */
export function storableJson(value: unknown, depth = 0): boolean {
  if (typeof value === "string") return storableText(value);
  if (value === null || typeof value !== "object" || depth > 64) return true;
  if (Array.isArray(value)) return value.every((v) => storableJson(v, depth + 1));
  for (const [k, v] of Object.entries(value)) {
    if (!storableText(k) || !storableJson(v, depth + 1)) return false;
  }
  return true;
}

/**
 * The first `max` UTF-16 code units of `text`, never ending on half of a surrogate pair: when the
 * cut falls inside one, the whole character goes.
 */
export function sliceWhole(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 0) return "";
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}
