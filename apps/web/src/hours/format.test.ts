// Business hours in words (R8): a week as a few lines, problems in plain words, dates that never
// move a day with the reader's zone, and the week as it is saved.

import { PEOPLE_HOURS_MAX_CONTACTS } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { createI18n } from "../i18n/i18n";
import {
  awayNow,
  cleanWeek,
  dateText,
  listedHours,
  nextStretch,
  weekLines,
  weekProblem,
} from "./format";

const en = createI18n("en");
const de = createI18n("de");
const NINE_TO_SIX = [{ from: "08:00", to: "18:00" }];

describe("hours in words", () => {
  it("runs days with the same hours together and says Closed for the rest", () => {
    const week = {
      mon: NINE_TO_SIX,
      tue: NINE_TO_SIX,
      wed: NINE_TO_SIX,
      thu: NINE_TO_SIX,
      fri: [
        { from: "08:00", to: "12:00" },
        { from: "13:00", to: "17:30" },
      ],
    };
    expect(weekLines(week, en)).toEqual([
      { days: "Mon to Thu", hours: "8:00 AM to 6:00 PM", closed: false },
      { days: "Fri", hours: "8:00 AM to 12:00 PM, 1:00 PM to 5:30 PM", closed: false },
      { days: "Sat to Sun", hours: "Closed", closed: true },
    ]);
    // German: its own day names (with or without a dot, by ICU's version) and a 24-hour clock.
    const [first] = weekLines(week, de);
    expect(first?.days).toMatch(/^Mo\.? bis Do\.?$/);
    expect(first?.hours).toMatch(/^0?8:00 bis 18:00$/);
  });

  it("finds ends before starts and overlaps, in the reader's words", () => {
    expect(weekProblem({ mon: NINE_TO_SIX }, en)).toBeNull();
    expect(weekProblem({ tue: [{ from: "18:00", to: "08:00" }] }, en)).toBe(
      "Tuesday: each closing time must be after its opening time.",
    );
    expect(
      weekProblem(
        {
          wed: [
            { from: "13:00", to: "17:00" },
            { from: "08:00", to: "13:30" },
          ],
        },
        en,
      ),
    ).toBe("Wednesday: the hours overlap.");
  });

  // Wave 3b: the server refuses a week with no open hours (422 invalid_hours).
  it("refuses a week with every day closed, in the reader's words", () => {
    expect(weekProblem({}, en)).toBe(
      "Give at least one day its hours: a week with no open hours can't be saved.",
    );
    expect(weekProblem({ mon: [], sat: [] }, de)).toMatch(/^Geben Sie mindestens einem Tag/);
  });

  it("adds a stretch an hour after the last, or up to 23:59 late in the day, never 23:59 to 23:59", () => {
    const first = { from: "08:00", to: "18:00" };
    expect(nextStretch([], first)).toEqual(first);
    expect(nextStretch([{ from: "08:00", to: "12:00" }], first)).toEqual({
      from: "13:00",
      to: "15:00",
    });
    expect(nextStretch([{ from: "08:00", to: "22:30" }], first)).toEqual({
      from: "23:30",
      to: "23:59",
    });
    expect(nextStretch([{ from: "08:00", to: "23:00" }], first)).toEqual({
      from: "23:00",
      to: "23:59",
    });
    expect(nextStretch([{ from: "08:00", to: "23:59" }], first)).toBeNull();
    // The latest end counts, whatever the order.
    expect(
      nextStretch(
        [
          { from: "14:00", to: "16:00" },
          { from: "08:00", to: "12:00" },
        ],
        first,
      ),
    ).toEqual({ from: "17:00", to: "19:00" });
  });

  it("knows a contact's hours only from a list that holds every contact", () => {
    const contact = (id: string, hours: null | { away: never[] } = null) => ({
      kind: "contact" as const,
      id,
      name: id,
      hours,
    });
    const short = { people: [contact("a", { away: [] })] };
    expect(listedHours(short, "contact", "a")).toEqual({ away: [] });
    // A list under the cap is whole: a contact missing from it has no hours of their own.
    expect(listedHours(short, "contact", "b")).toBeNull();
    const full = {
      people: Array.from({ length: PEOPLE_HOURS_MAX_CONTACTS }, (_, i) => contact(`c${i}`)),
    };
    // At the cap some may be left out: unknown, never "no hours".
    expect(listedHours(full, "contact", "past-the-cap")).toBeUndefined();
    expect(listedHours(full, "contact", "c1")).toBeNull();
  });

  it("saves a week in day order, each day's stretches sorted, closed days left out", () => {
    const week = cleanWeek({
      sat: [],
      fri: [
        { from: "13:00", to: "17:00" },
        { from: "08:00", to: "12:00" },
      ],
      mon: NINE_TO_SIX,
    });
    expect(Object.keys(week)).toEqual(["mon", "fri"]);
    expect(week.fri?.[0]?.from).toBe("08:00");
  });

  it("formats a date as the day it names, and knows who is away today", () => {
    expect(dateText("2026-01-01", "en-US")).toBe("Jan 1, 2026");
    const away = [{ from: "2026-12-21", to: "2027-01-02" }];
    expect(awayNow(away, "2026-12-25")).toEqual(away[0]);
    expect(awayNow(away, "2027-01-03")).toBeNull();
  });
});
