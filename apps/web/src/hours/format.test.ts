// Business hours in words (R8): a week as a few lines, problems in plain words, dates that never
// move a day with the reader's zone, and the week as it is saved.
import { describe, expect, it } from "vitest";
import { createI18n } from "../i18n/i18n";
import { awayNow, cleanWeek, dateText, weekLines, weekProblem } from "./format";

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
