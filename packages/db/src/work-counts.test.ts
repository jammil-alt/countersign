// §1.234: every counter core defines is counted by the one query, from a column of its own.
import { WORK_COUNT_IDS, WORK_COUNTER_IDS } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { WORK_COUNT_COLUMNS } from "./work-counts";

describe("the work statement's counters", () => {
  it("counts every counter core defines, each from its own column", () => {
    expect(Object.keys(WORK_COUNT_COLUMNS).sort()).toEqual([...WORK_COUNT_IDS].sort());
    expect(new Set(Object.values(WORK_COUNT_COLUMNS)).size).toBe(WORK_COUNT_IDS.length);
    // The dollars are the one counter that isn't a number of things.
    expect(
      WORK_COUNTER_IDS.filter((id) => !(WORK_COUNT_IDS as readonly string[]).includes(id)),
    ).toEqual(["dollarsIdentified"]);
  });
});
