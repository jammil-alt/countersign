// Measures the Match engine's settings against the matching goldens (docs/step-model-plan.md §7,
// §13 item 10): for each profile, every shortlist size, confidence threshold and second-opinion
// floor, what the engine does with the real model as `choose` and `second`. The model is the
// caller's (`Deciders`): the live run is `measure-matching.eval.ts`, by hand or in the "Model runs"
// workflow; the tests here use a fake one, so `pnpm test` never calls a model.
//
// What is measured (the goldens are made up: no client data, docs/plan.md §1.35):
//   - Master items: fixtures/matching/*.json. A pair (a, b) labelled "same" says line `a` is item
//     `b`. The records are every distinct `b`; the items are every distinct `a`; an item's right
//     answers are the `b`s it is "same" as, and an item with none has no right record, so any
//     match is wrong.
//   - CRM records: fixtures/matching/crm. Each row's `expect` is its right records (any of them);
//     [] or null: none of them.
// Vendor items stay exact by SKU only (owner rule) and are not measured.
//
// DECISION: the shortlist here is character-trigram similarity (the stand-in for the area's
// trigram and meaning search, which need a database and embeddings): the same for every setting,
// so the sizes compare fairly, but a size's recall is a floor on what the areas' own search gives.
// DECISION: the second opinion is "AI then person" (the default), by the model the executor would
// pick for it (`conferModel`), so a disagreement goes to a person.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Decimal,
  matchWithProfile,
  type ProfileCandidate,
  type ProfileChooser,
  type ProfileItem,
  type ProfileRecord,
  type ProfileStore,
  steps,
} from "@countersign/core";
import {
  attributesHit,
  MASTER_ITEMS_PROFILE,
  masterNeverSame,
  parseLine,
} from "@countersign/pack-materials";
import {
  CRM_RECORDS_PROFILE,
  crmItemKeys,
  crmKeyHits,
  crmNeverSame,
  type KeyMapping,
  keysOf,
  kindOf,
  rowValues,
  scorePair,
  zohoMapper,
} from "@countersign/pack-sales";

/** The settings measured (the request: shortlists, thresholds and second-opinion floors). */
export const SHORTLISTS = [5, 10, 20, 30, 50] as const;
export const THRESHOLDS = [80, 85, 90, 95] as const;
/** `null`: no second opinion, for comparison. */
export const FLOORS = [60, 70, null] as const;

/** The precision on "same" a setting must reach (CLAUDE.md, Testing). */
export const PRECISION_TARGET = 0.95;
/** Today's defaults (`MatchSettings`): a shortlist of 20, a threshold of 90. */
export const CURRENT = { shortlist: 20, threshold: 90 } as const;

export interface Setting {
  shortlist: number;
  threshold: number;
  /** The second-opinion floor; null for none. */
  floor: number | null;
}

/** A setting's cases are only the ones the engine accepts (the floor sits below the threshold). */
export function settingsGrid(): Setting[] {
  const out: Setting[] = [];
  for (const shortlist of SHORTLISTS)
    for (const threshold of THRESHOLDS)
      for (const floor of FLOORS) {
        if (floor !== null && floor >= threshold) continue;
        out.push({ shortlist, threshold, floor });
      }
  return out;
}

export const settingLabel = (s: Setting) =>
  `shortlist ${s.shortlist}, threshold ${s.threshold}, second opinion ${s.floor === null ? "off" : `from ${s.floor}`}`;

// ── Similarity: the shortlist's search ───────────────────────────────────────────────────────

function trigrams(s: string): Map<string, number> {
  const t = ` ${s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()} `;
  const out = new Map<string, number>();
  for (let i = 0; i + 3 <= t.length; i += 1) {
    const g = t.slice(i, i + 3);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

/** Dice similarity of two texts' character trigrams, 0 to 1. */
export function similarity(a: string, b: string): number {
  const x = trigrams(a);
  const y = trigrams(b);
  let shared = 0;
  let nx = 0;
  let ny = 0;
  for (const n of x.values()) nx += n;
  for (const n of y.values()) ny += n;
  for (const [g, n] of x) shared += Math.min(n, y.get(g) ?? 0);
  return nx + ny === 0 ? 0 : (2 * shared) / (nx + ny);
}

function closest(
  text: string,
  records: readonly { record: ProfileRecord; text: string; floor?: number }[],
  limit: number,
): ProfileCandidate[] {
  return records
    .map((r) => ({ ...r.record, score: Math.max(r.floor ?? 0, similarity(text, r.text)) }))
    .sort((p, q) => q.score - p.score || p.id.localeCompare(q.id))
    .slice(0, limit);
}

// ── The cases ────────────────────────────────────────────────────────────────────────────────

/** One item to match, and the records that are right for it (empty: none is). */
export interface Case {
  item: ProfileItem;
  right: readonly string[];
}

/** A profile's cases, and how its store is built for one item. */
export interface CaseSet {
  profile: steps.MatchProfile;
  /** The settings' fixed part: the type and the keys. */
  base: { type: steps.MatchSettings["type"]; keys?: string[] };
  cases: readonly Case[];
  store(c: Case): ProfileStore;
}

interface Pair {
  a: string;
  b: string;
  label: "same" | "different";
}

const matchingDir = join(dirname(fileURLToPath(import.meta.url)), "../../../../fixtures/matching");

/** Master items: every distinct `b` is an item of the master list; every distinct `a` a line. */
export function materialsSet(dir: string = matchingDir): CaseSet {
  const pairs = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .flatMap((f) => (JSON.parse(readFileSync(join(dir, f), "utf8")) as { pairs: Pair[] }).pairs);
  const ids = new Map<string, string>();
  for (const p of pairs) if (!ids.has(p.b)) ids.set(p.b, `item-${ids.size + 1}`);
  const rights = new Map<string, Set<string>>();
  for (const p of pairs) {
    const set = rights.get(p.a) ?? new Set<string>();
    if (p.label === "same") set.add(ids.get(p.b) as string);
    rights.set(p.a, set);
  }
  const pool = [...ids].map(([text, id]) => {
    const parsed = parseLine(text);
    const values: Record<string, string> = { category: parsed.category };
    for (const [k, v] of Object.entries(parsed.attributes)) {
      if (typeof v === "string" && v) values[k] = v;
    }
    return { id, text, parsed, record: { id, label: text, values, sources: [id] } };
  });
  const records = pool.map((r) => ({ record: r.record, text: r.text }));
  const store: ProfileStore = {
    get: async (id) => pool.find((r) => r.id === id)?.record ?? null,
    byKey: async (_key, item) => {
      const hits = attributesHit(
        parseLine(String(item.description)),
        pool.map((r) => ({ ...r.parsed, id: r.id })),
      );
      return hits
        .map((h) => pool.find((r) => r.id === h.id)?.record)
        .filter((r) => r !== undefined);
    },
    shortlist: async (item, limit) => closest(String(item.description), records, limit),
    neverSame: (item, record) => {
      const r = pool.find((x) => x.id === record.id);
      return r ? masterNeverSame(parseLine(String(item.description)), r.parsed) : null;
    },
  };
  return {
    profile: MASTER_ITEMS_PROFILE,
    base: { type: "hybrid", keys: ["attributes"] },
    cases: [...rights].map(([a, set]) => ({ item: { description: a }, right: [...set] })),
    store: () => store,
  };
}

interface GoldenRecord {
  id: string;
  module: string;
  payload: Record<string, unknown>;
}
interface GoldenRow {
  values: Record<string, string>;
  modules: string[];
  expect: string[] | null;
}
interface GoldenSet {
  keys: KeyMapping;
  records: GoldenRecord[];
  rows: GoldenRow[];
}

/** CRM records: each file's rows against its synced records, in the row's modules. */
export function crmSet(dir: string = join(matchingDir, "crm")): CaseSet {
  const sets = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as GoldenSet);
  const modulesOf = new Map<Case, { set: number; modules: readonly string[] }>();
  const prepared = sets.map((set) =>
    set.records.map((r) => {
      const mapped = zohoMapper.map(r.module, r.payload);
      if (!mapped) throw new Error(`crm golden record ${r.id} doesn't read`);
      return {
        id: r.id,
        module: r.module,
        keys: keysOf(mapped.fields),
        display: mapped.display,
      };
    }),
  );
  const cases: Case[] = [];
  sets.forEach((set, n) => {
    for (const row of set.rows) {
      const c: Case = { item: rowValues(row.values, set.keys), right: row.expect ?? [] };
      modulesOf.set(c, { set: n, modules: row.modules });
      cases.push(c);
    }
  });
  return {
    profile: CRM_RECORDS_PROFILE,
    base: { type: "hybrid" },
    cases,
    store(c) {
      const at = modulesOf.get(c);
      if (!at) throw new Error("a case from another set");
      const mine = (prepared[at.set] ?? []).filter((r) => at.modules.includes(r.module));
      const rowKeys = crmItemKeys(c.item);
      const text = (k: { name?: string; company?: string; deal?: string }) =>
        [k.name, k.company, k.deal].filter(Boolean).join(" ");
      const label = (r: (typeof mine)[number]) =>
        r.display.name ?? r.display.company ?? r.display.deal ?? r.id;
      const recordOf = (r: (typeof mine)[number]): ProfileRecord => ({
        id: r.id,
        label: label(r),
        values: { module: r.module, ...r.display },
        sources: [r.id],
      });
      return {
        get: async (id) => {
          const r = mine.find((x) => x.id === id);
          return r ? recordOf(r) : null;
        },
        byKey: async (key, item) => crmKeyHits(crmItemKeys(item), key, mine).map(recordOf),
        shortlist: async (_item, limit) =>
          closest(
            text(rowKeys),
            mine.map((r) => ({
              record: recordOf(r),
              text: text(r.keys),
              floor: scorePair(rowKeys, r.keys, { kind: kindOf(r.module) }).score,
            })),
            limit,
          ),
        neverSame: (item, record) => {
          const r = mine.find((x) => x.id === record.id);
          return r ? crmNeverSame(crmItemKeys(item), r) : null;
        },
      };
    },
  };
}

// ── Running a setting ────────────────────────────────────────────────────────────────────────

/** The models a run asks; usage is the caller's to count (`Deciders.spent`). */
export interface Deciders {
  choose: ProfileChooser;
  second: ProfileChooser;
}

export interface Result {
  profile: string;
  setting: Setting;
  items: number;
  /** Items with a right record. */
  withRight: number;
  matched: number;
  right: number;
  wrong: number;
  /** Matched by the model (a semantic or second-opinion match), of `matched`. */
  byModel: number;
  rightByModel: number;
  /** Left to a person. */
  toPerson: number;
  precision: number;
  recall: number;
  personShare: number;
  tokens: { input: number; output: number };
  /** USD, decimal. */
  cost: string;
}

/** What a setting's model calls used: a decider reports it through this. */
export interface Spend {
  input: number;
  output: number;
  cost: Decimal;
}

export const noSpend = (): Spend => ({ input: 0, output: 0, cost: new Decimal(0) });

/** Runs one setting over a profile's cases. `spend` is filled by the deciders as they are asked. */
export async function runSetting(
  set: CaseSet,
  setting: Setting,
  make: (spend: Spend) => Deciders,
): Promise<Result> {
  const spend = noSpend();
  const deciders = make(spend);
  const settings = steps.MatchSettings.parse({
    to: set.profile.id,
    type: set.base.type,
    ...(set.base.keys ? { keys: set.base.keys } : {}),
    confidenceThreshold: setting.threshold,
    ...(setting.floor === null
      ? {}
      : { secondOpinion: { from: setting.floor, by: "ai_then_person" } }),
    shortlist: { model: setting.shortlist },
  });
  let matched = 0;
  let right = 0;
  let wrong = 0;
  let byModel = 0;
  let rightByModel = 0;
  let toPerson = 0;
  let withRight = 0;
  for (const c of set.cases) {
    if (c.right.length > 0) withRight += 1;
    const run = await matchWithProfile({
      profile: set.profile,
      settings,
      store: set.store(c),
      items: [c.item],
      choose: deciders.choose,
      second: deciders.second,
    });
    const got = run.output.items[0];
    if (!got) continue;
    if (got.unsure) toPerson += 1;
    if (got.matched === null) continue;
    matched += 1;
    const ok = c.right.includes(got.matched);
    if (ok) right += 1;
    else wrong += 1;
    if (got.how === "semantic" || got.how === "second_opinion") {
      byModel += 1;
      if (ok) rightByModel += 1;
    }
  }
  const n = set.cases.length;
  return {
    profile: set.profile.id,
    setting,
    items: n,
    withRight,
    matched,
    right,
    wrong,
    byModel,
    rightByModel,
    toPerson,
    precision: matched === 0 ? 1 : right / matched,
    recall: withRight === 0 ? 1 : right / withRight,
    personShare: n === 0 ? 0 : toPerson / n,
    tokens: { input: spend.input, output: spend.output },
    cost: spend.cost.toFixed(4),
  };
}

// ── Recommending, reporting ──────────────────────────────────────────────────────────────────

/**
 * The setting to recommend for a profile: of those at the precision target, the most recall, then
 * the fewest sent to a person, then the cheapest. Null when none reaches the target.
 */
export function recommend(results: readonly Result[]): Result | null {
  const ok = results.filter((r) => r.precision >= PRECISION_TARGET);
  ok.sort(
    (p, q) =>
      q.recall - p.recall ||
      p.personShare - q.personShare ||
      new Decimal(p.cost).comparedTo(q.cost),
  );
  return ok[0] ?? null;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

function row(r: Result): string {
  const s = r.setting;
  return `| ${s.shortlist} | ${s.threshold} | ${s.floor ?? "off"} | ${pct(r.precision)}${r.precision < PRECISION_TARGET ? " ✗" : ""} | ${pct(r.recall)} | ${pct(r.personShare)} | ${r.matched} (${r.wrong} wrong) | ${r.byModel} | ${r.tokens.input + r.tokens.output} | $${r.cost} |`;
}

/** The report: a table per profile, the recommendation, and what the numbers rest on. */
export function renderReport(input: {
  model: string;
  secondModel: string;
  results: readonly Result[];
}): string {
  const profiles = [...new Set(input.results.map((r) => r.profile))];
  const lines = [
    "# Match measurement",
    "",
    `Model ${input.model}; second opinion ${input.secondModel}. Goldens: fixtures/matching (Master items) and fixtures/matching/crm (CRM records), made up. Vendor items are exact by SKU only and not measured.`,
    "",
    `Precision is of what was matched (target ${pct(PRECISION_TARGET)}, ✗ where missed); recall is of the items that have a right record; "to a person" is the share left unsure. Cost is the model calls the setting would make, in USD.`,
    "",
  ];
  const total = input.results.reduce((s, r) => s.plus(r.cost), new Decimal(0));
  for (const p of profiles) {
    const mine = input.results.filter((r) => r.profile === p);
    const best = recommend(mine);
    const first = mine[0];
    lines.push(`## ${p}`, "");
    if (first) lines.push(`${first.items} items, ${first.withRight} with a right record.`, "");
    lines.push(
      best
        ? `Recommended: ${settingLabel(best.setting)} (precision ${pct(best.precision)}, recall ${pct(best.recall)}, ${pct(best.personShare)} to a person, $${best.cost}).`
        : "No setting reached the precision target.",
      "",
    );
    const today = mine.find(
      (r) =>
        r.setting.shortlist === CURRENT.shortlist &&
        r.setting.threshold === CURRENT.threshold &&
        r.setting.floor === 70,
    );
    if (today)
      lines.push(
        `Today's default (20, 90, second opinion from 70): ${pct(today.precision)} precision, ${pct(today.recall)} recall, ${pct(today.personShare)} to a person.`,
        "",
      );
    lines.push(
      "| Shortlist | Threshold | Second from | Precision | Recall | To a person | Matched | By the model | Tokens | Cost |",
      "|---|---|---|---|---|---|---|---|---|---|",
      ...mine.map(row),
      "",
    );
  }
  lines.push(
    `Total cost of the settings as if each ran alone: $${total.toFixed(2)} (the run asks each question once).`,
  );
  return lines.join("\n");
}
