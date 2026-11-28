// The CRM matching golden set (docs/plan.md §1.164 "The match"; fixtures/matching/crm): a client's
// synced Zoho leads, contacts, accounts and deals, and spreadsheet rows labelled with the record
// each is, heavy on near-misses (namesakes, colleagues at one domain, a shared main line, duplicate
// leads, two renewals of one account). The deterministic stage decides "same" when one record
// reaches the threshold (0.9) and no other does. Target: precision on "same" of at least 95%.
// Recall is reported: a row the rules leave goes to the model and then to a person, so a miss here
// costs a review, never a wrong update.

import { readdirSync, readFileSync } from "node:fs";
import { matchWithProfile, type ProfileStore, steps } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { keysOf } from "../keys/build";
import { zohoMapper } from "../keys/zoho";
import type { CrmKeys } from "../schema";
import { type KeyMapping, kindOf, rowKeys, rowValues } from "./match";
import { CRM_RECORDS_PROFILE, crmItemKeys, crmKeyHits, crmNeverSame } from "./profile";
import { decideByRules, MATCH_THRESHOLD, scorePair } from "./score";

interface GoldenRecord {
  id: string;
  module: string;
  payload: Record<string, unknown>;
}
interface GoldenRow {
  values: Record<string, string>;
  modules: string[];
  /** The records the row is; [] for none of them; null when the row can't say. */
  expect: string[] | null;
  note: string;
}
interface GoldenSet {
  keys: KeyMapping;
  records: GoldenRecord[];
  rows: GoldenRow[];
}

const dir = new URL("../../../../fixtures/matching/crm/", import.meta.url);
const sets = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => ({ file: f, set: JSON.parse(readFileSync(new URL(f, dir), "utf8")) as GoldenSet }));

interface Prepared {
  id: string;
  module: string;
  keys: CrmKeys;
}

function prepare(set: GoldenSet): Prepared[] {
  return set.records.map((r) => {
    const mapped = zohoMapper.map(r.module, r.payload);
    if (!mapped) throw new Error(`record ${r.id} doesn't read`);
    return { id: r.id, module: r.module, keys: keysOf(mapped.fields) };
  });
}

/** The rules' answer for a row against every record in its modules: a record id, or null. */
function predict(set: GoldenSet, records: readonly Prepared[], row: GoldenRow): string | null {
  const keys = rowKeys(rowValues(row.values, set.keys));
  const weighed = records
    .filter((r) => row.modules.includes(r.module))
    .map((r) => ({ candidate: r, pair: scorePair(keys, r.keys, { kind: kindOf(r.module) }) }));
  const verdict = decideByRules(weighed, MATCH_THRESHOLD);
  return verdict.kind === "matched" ? verdict.best.candidate.id : null;
}

function evaluate(set: GoldenSet) {
  const records = prepare(set);
  let right = 0;
  let wrong = 0;
  let missed = 0;
  const wrongs: string[] = [];
  for (const row of set.rows) {
    const got = predict(set, records, row);
    const same = row.expect !== null && row.expect.length > 0;
    if (got !== null) {
      if (row.expect?.includes(got)) right += 1;
      else {
        wrong += 1;
        wrongs.push(
          `${JSON.stringify(row.values)} → ${got} (expected ${JSON.stringify(row.expect)}; ${row.note})`,
        );
      }
    } else if (same) missed += 1;
  }
  const precision = right + wrong === 0 ? 1 : right / (right + wrong);
  const sameRows = set.rows.filter((r) => r.expect !== null && r.expect.length > 0).length;
  const recall = sameRows === 0 ? 1 : right / sameRows;
  return { right, wrong, missed, precision, recall, wrongs };
}

describe("CRM matching golden set", () => {
  const all = sets.flatMap((s) => s.set.rows);

  it("has about 60 labelled rows against about 40 synced records, some none of them", () => {
    expect(all.length).toBeGreaterThanOrEqual(60);
    expect(sets.reduce((n, s) => n + s.set.records.length, 0)).toBeGreaterThanOrEqual(40);
    const notSame = all.filter((r) => r.expect === null || r.expect.length === 0).length;
    expect(notSame / all.length).toBeGreaterThan(0.15);
  });

  it("reaches 95% precision on 'same' at the default threshold (recall reported)", () => {
    const lines: string[] = [];
    let right = 0;
    let wrong = 0;
    for (const s of sets) {
      const r = evaluate(s.set);
      right += r.right;
      wrong += r.wrong;
      lines.push(
        `${s.file}: precision ${(r.precision * 100).toFixed(1)}%, recall ${(r.recall * 100).toFixed(1)}% (${r.right} auto, ${r.wrong} wrong, ${r.missed} to the model or a person)`,
        ...r.wrongs.map((w) => `  wrong: ${w}`),
      );
    }
    const precision = right + wrong === 0 ? 1 : right / (right + wrong);
    console.info([`crm golden: precision ${(precision * 100).toFixed(1)}%`, ...lines].join("\n"));
    expect(precision).toBeGreaterThanOrEqual(0.95);
    // Recall is reported, not targeted; this floor only catches rules that stopped working.
    expect(right).toBeGreaterThan(all.length / 3);
  });

  it("never matches a row the records can't tell apart, or a new person at a known company", () => {
    for (const s of sets) {
      const records = prepare(s.set);
      for (const row of s.set.rows.filter((r) => r.expect === null || r.expect.length === 0)) {
        expect(
          predict(s.set, records, row),
          `${JSON.stringify(row.values)} (${row.note})`,
        ).toBeNull();
      }
    }
  });

  // Step model §7 (stream D): the same rows on the Match engine's CRM records profile: email,
  // phone and website (exact, where the area's rules let a key settle it), the hard rules vetoing.
  // Exact only: no model answers here, so names and meaning (the semantic tier) are left to the
  // model and a person; recall is lower than the rules' above, which also matched on names.
  it("runs on the Match engine's CRM records profile at 95% precision", async () => {
    const settings = steps.MatchSettings.parse({ to: "crm-records", type: "exact" });
    let right = 0;
    let wrong = 0;
    let missed = 0;
    let rows = 0;
    for (const s of sets) {
      const records = prepare(s.set);
      for (const row of s.set.rows) {
        rows += 1;
        const mine = records.filter((r) => row.modules.includes(r.module));
        const store: ProfileStore = {
          get: async (id) => (mine.some((r) => r.id === id) ? { id, label: id } : null),
          byKey: async (key, item) =>
            crmKeyHits(crmItemKeys(item), key, mine).map((r) => ({ id: r.id, label: r.id })),
          neverSame: (item, record) => {
            const r = mine.find((x) => x.id === record.id);
            return r ? crmNeverSame(crmItemKeys(item), r) : null;
          },
        };
        const out = await matchWithProfile({
          profile: CRM_RECORDS_PROFILE,
          settings,
          store,
          items: [rowValues(row.values, s.set.keys)],
        });
        const got = out.output.items[0]?.matched ?? null;
        const same = row.expect !== null && row.expect.length > 0;
        if (got !== null) {
          if (row.expect?.includes(got)) right += 1;
          else wrong += 1;
        } else if (same) missed += 1;
      }
    }
    const precision = right + wrong === 0 ? 1 : right / (right + wrong);
    console.info(
      `crm golden on the Match engine (CRM records, exact): ${rows} rows; precision ${(precision * 100).toFixed(1)}%, ${right} matched, ${wrong} wrong, ${missed} to the model or a person`,
    );
    expect(precision).toBeGreaterThanOrEqual(0.95);
    expect(right).toBeGreaterThan(0);
  });
});
