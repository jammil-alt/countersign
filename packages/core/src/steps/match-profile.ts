// Match profiles (docs/step-model-plan.md §7): what one kind of record is matched on. A profile is
// defined once, in code, by the area that owns the records (a pack's manifest, or the platform for
// shared records); a Match step picks one ("Match to: Vendors") and sets the rest. The profile fixes
// the step's input and output, the keys it may use, the text a semantic match reads, and the
// "never the same if" rules, which are shown on the step and not editable.
//
// Matching is always against our own records (§7, "Where matching happens"): an area's table, or
// the raw copies of a synced type with a key index. An outside system's id is a key like any other.

import { z } from "zod";
import { Slug } from "../schemas/common";
import { AreaId } from "../schemas/tool";
import { type Field, Fields, MATCH_TYPES, type MatchSettings } from "./schema";

/** One key a profile allows: an exact match on one input field. */
export const MatchKey = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
  /** In plain words: "Accounting id", "SKU", "Tax id". */
  name: z.string().min(1).max(60),
  /** The input field holding the value. */
  field: z.string().min(1).max(64),
  /**
   * Other names an item may give the same value under, tried after `field` (an invoice's line as
   * read names its SKU `vendorSku`). Optional, so stored profiles parse as they were.
   */
  also: z.array(z.string().min(1).max(64)).max(5).optional(),
});
export type MatchKey = z.infer<typeof MatchKey>;

/** The value an item gives a key: its `field`, else the first of `also` it has. */
export function keyValue(key: MatchKey, item: Readonly<Record<string, unknown>>): unknown {
  for (const f of [key.field, ...(key.also ?? [])]) {
    const v = item[f];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

/** A rule that makes two records never the same, whatever else agrees (§7). */
export const NeverSame = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
  /** In plain words, as the step shows it: "Two different tax ids". */
  words: z.string().min(1).max(160),
});

export const MatchProfile = z
  .strictObject({
    id: Slug,
    /** "Vendors", "Vendor items". */
    name: z.string().min(1).max(60),
    /** The area that owns the records (`shared` for the shared business records). */
    area: AreaId,
    /** The kind of record a match links to (`vendor`, `vendor_item`, `catalog_item`). */
    record: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
    /** Where the records are: an area's own table, or the raw copies of a synced type. */
    source: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("table") }),
      z.strictObject({
        kind: z.literal("raw"),
        connector: z.string().min(1),
        entity: z.string().min(1),
      }),
    ]),
    /** What comes in to be matched: one item's fields (a list of them is matched item by item). */
    input: Fields,
    /** The keys allowed for an exact match, in their default order. */
    keys: z.array(MatchKey).min(1).max(10),
    /** The input fields a semantic match reads; absent: exact only, whatever the step says. */
    semantic: z.strictObject({ text: z.array(z.string().min(1)).min(1).max(5) }).optional(),
    /** The match types a step may choose; a profile without `semantic` allows exact only. */
    types: z.array(z.enum(MATCH_TYPES)).min(1).max(3),
    neverSame: z.array(NeverSame).max(10).default([]),
    /** Whether a person's answer is saved as a learned name, so it is an exact hit next time. */
    learns: z.boolean().default(true),
  })
  .refine((p) => p.semantic !== undefined || p.types.every((t) => t === "exact"), {
    message: "a profile with no text to read by meaning allows exact match only",
    path: ["types"],
  })
  .refine((p) => p.keys.every((k) => p.input.some((f) => f.name === k.field)), {
    message: "every key reads one of the profile's input fields",
    path: ["keys"],
  });
export type MatchProfile = z.infer<typeof MatchProfile>;

/** How a line was matched, in the Match result. */
export const MATCHED_BY = ["exact", "learned", "semantic", "second_opinion", "person"] as const;

/**
 * The fields of a Match step's output, the same for every profile but for the record linked
 * (§7): each item as it came in, the record it matched (or none), how, how sure, and the candidates.
 */
export function matchResultFields(profile: Pick<MatchProfile, "record" | "input">): Field[] {
  return [
    {
      name: "items",
      type: "list",
      required: true,
      of: [
        { name: "item", type: "group", required: true, of: profile.input },
        { name: "matched", type: "record", record: profile.record, required: false },
        { name: "how", type: "text", required: false, about: MATCHED_BY.join(", ") },
        { name: "confidence", type: "number", required: false, about: "0 to 100" },
        { name: "isNew", type: "yes_no", required: true },
        { name: "unsure", type: "yes_no", required: true },
        {
          name: "candidates",
          type: "list",
          required: true,
          of: [
            { name: "record", type: "record", record: profile.record, required: true },
            { name: "confidence", type: "number", required: true },
          ],
        },
      ],
    },
    { name: "matched", type: "number", required: true },
    { name: "unsure", type: "number", required: true },
    { name: "anyUnsure", type: "yes_no", required: true },
  ];
}

/** What a Match step's settings break of its profile, in plain words (empty: none). */
export function matchSettingsProblems(settings: MatchSettings, profile: MatchProfile): string[] {
  const out: string[] = [];
  if (!profile.types.includes(settings.type)) {
    out.push(`${profile.name} can be matched by ${profile.types.join(" or ")} only`);
  }
  for (const key of settings.keys ?? []) {
    if (!profile.keys.some((k) => k.id === key)) {
      out.push(`${profile.name} has no key "${key}"`);
    }
  }
  if (settings.secondOpinion && settings.secondOpinion.from >= settings.confidenceThreshold) {
    out.push("the second opinion starts below the confidence threshold");
  }
  return out;
}
