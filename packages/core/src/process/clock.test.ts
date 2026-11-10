import { describe, expect, it } from "vitest";
import {
  anyOpen,
  dueAt,
  dueAtForMany,
  effectiveHours,
  isAway,
  isOpen,
  isWorking,
  NoOpenTimeError,
  type Schedule,
  scheduleFor,
} from "./clock";
import { type BusinessHours, defaultBusinessHours, type PersonHours } from "./hours";

const CHICAGO = "America/Chicago";
const client = defaultBusinessHours(CHICAGO);
const at = (iso: string) => new Date(iso);
const business = (businessHours: BusinessHours, away?: Schedule["away"]) =>
  ({ hours: "business", businessHours, away }) as const;

describe("isOpen", () => {
  it("is open inside the hours and closed at the close, on weekends and holidays", () => {
    // Friday 2026-11-06, CST (UTC-6).
    expect(isOpen(at("2026-11-06T23:59:00Z"), client)).toBe(true); // 17:59
    expect(isOpen(at("2026-11-07T00:00:00Z"), client)).toBe(false); // 18:00
    expect(isOpen(at("2026-11-06T13:59:00Z"), client)).toBe(false); // 07:59
    expect(isOpen(at("2026-11-07T16:00:00Z"), client)).toBe(false); // Saturday
    expect(isOpen(at("2026-11-11T16:00:00Z"), client)).toBe(false); // Veterans Day
    expect(isOpen(at("2026-11-11T16:00:00Z"), { ...client, usHolidays: false })).toBe(true);
    expect(isOpen(at("2026-11-12T16:00:00Z"), { ...client, closed: ["2026-11-12"] })).toBe(false);
  });
});

describe("dueAt, clock", () => {
  it("adds real time, through nights, weekends and a DST change", () => {
    expect(
      dueAt(at("2026-03-06T23:50:00Z"), "3 days", { hours: "clock", businessHours: client }),
    ).toEqual(at("2026-03-09T23:50:00Z"));
  });

  it("runs through away dates", () => {
    const due = dueAt(at("2026-11-17T16:00:00Z"), "1 day", {
      hours: "clock",
      businessHours: client,
      away: [{ from: "2026-11-17", to: "2026-11-20" }],
    });
    expect(due).toEqual(at("2026-11-18T16:00:00Z"));
  });
});

describe("dueAt, business minutes", () => {
  it("Friday 17:50 Chicago + 30 business minutes is Monday 08:20", () => {
    expect(dueAt(at("2026-11-06T23:50:00Z"), "30 minutes", business(client))).toEqual(
      at("2026-11-09T14:20:00Z"),
    );
  });

  it("is due at the close, not the next opening, when the time runs out exactly then", () => {
    expect(dueAt(at("2026-11-06T23:30:00Z"), "30 minutes", business(client))).toEqual(
      at("2026-11-07T00:00:00Z"),
    );
  });

  it("starts counting at the opening when the start is before it", () => {
    // Tuesday 06:00 CST + 30 minutes → 08:30.
    expect(dueAt(at("2026-11-10T12:00:00Z"), "30 minutes", business(client))).toEqual(
      at("2026-11-10T14:30:00Z"),
    );
  });

  it("skips the observed July 4th, and counts it when US holidays are off", () => {
    // July 4, 2026 is a Saturday, observed Friday July 3 (CDT, UTC-5).
    expect(dueAt(at("2026-07-03T15:00:00Z"), "30 minutes", business(client))).toEqual(
      at("2026-07-06T13:30:00Z"),
    );
    expect(dueAt(at("2026-07-02T22:00:00Z"), "2 hours", business(client))).toEqual(
      at("2026-07-06T14:00:00Z"),
    );
    expect(
      dueAt(at("2026-07-03T15:00:00Z"), "30 minutes", business({ ...client, usHolidays: false })),
    ).toEqual(at("2026-07-03T15:30:00Z"));
  });

  it("closes only the observed date: a business open on Saturdays works July 4th", () => {
    const sixDays: BusinessHours = {
      ...client,
      week: { ...client.week, sat: [{ from: "08:00", to: "18:00" }] },
    };
    // Friday July 3, 2026 (observed) is closed; Saturday July 4 (the holiday itself) is open.
    expect(isOpen(at("2026-07-03T15:00:00Z"), sixDays)).toBe(false);
    expect(isOpen(at("2026-07-04T15:00:00Z"), sixDays)).toBe(true);
    // Thursday 17:30 CDT + 1 hour: 30 minutes Thursday, then Saturday 08:30.
    expect(dueAt(at("2026-07-02T22:30:00Z"), "1 hour", business(sixDays))).toEqual(
      at("2026-07-04T13:30:00Z"),
    );
    // New Year's Day 2028 is a Saturday, observed Friday December 31, 2027.
    expect(isOpen(at("2027-12-31T16:00:00Z"), sixDays)).toBe(false);
    expect(isOpen(at("2028-01-01T16:00:00Z"), sixDays)).toBe(true);
    // A holiday on a weekday is its own observed date.
    expect(isOpen(at("2026-11-11T16:00:00Z"), sixDays)).toBe(false);
  });

  it("runs a deadline longer than five years; only five closed years in a row give up", () => {
    // 300 business weeks (1,500 open days) and 16,000 open hours both run past five years.
    const weeks = dueAt(at("2026-11-10T16:00:00Z"), "300 weeks", business(client));
    expect(weeks.getTime()).toBeGreaterThan(at("2032-06-01T00:00:00Z").getTime());
    const hours = dueAt(at("2026-11-10T16:00:00Z"), "16000 hours", business(client));
    expect(hours.getTime()).toBeGreaterThan(at("2032-11-01T00:00:00Z").getTime());
    // Closed for six years, then open: a run of closed days longer than five years gives up.
    const away = [{ from: "2026-11-01", to: "2032-12-31" }];
    expect(() => dueAt(at("2026-11-10T16:00:00Z"), "1 hour", business(client, away))).toThrow(
      NoOpenTimeError,
    );
    expect(() => dueAt(at("2026-11-10T16:00:00Z"), "1 day", business(client, away))).toThrow(
      NoOpenTimeError,
    );
    // Closed for four years, then open: it runs.
    const fourYears = [{ from: "2026-11-01", to: "2030-10-31" }];
    expect(dueAt(at("2026-11-10T16:00:00Z"), "1 hour", business(client, fourYears))).toEqual(
      at("2030-11-01T14:00:00Z"),
    );
  }, 30_000);

  it("skips the client's closed dates", () => {
    const hours = { ...client, closed: ["2026-11-09"] };
    expect(dueAt(at("2026-11-06T23:50:00Z"), "30 minutes", business(hours))).toEqual(
      at("2026-11-10T14:20:00Z"),
    );
  });

  it("counts several stretches in one day, skipping the break", () => {
    const split = [
      { from: "08:00", to: "12:00" },
      { from: "13:00", to: "17:00" },
    ];
    const hours: BusinessHours = {
      tz: CHICAGO,
      week: { mon: split, tue: split, wed: split, thu: split, fri: split },
      usHolidays: true,
      closed: [],
    };
    // Monday 2026-11-09: 11:30 + 1 hour → 13:30.
    expect(dueAt(at("2026-11-09T17:30:00Z"), "1 hour", business(hours))).toEqual(
      at("2026-11-09T19:30:00Z"),
    );
    // A start in the break counts from 13:00.
    expect(dueAt(at("2026-11-09T18:15:00Z"), "1 hour", business(hours))).toEqual(
      at("2026-11-09T20:00:00Z"),
    );
    // 8 hours from the opening is the day's close.
    expect(dueAt(at("2026-11-09T14:00:00Z"), "8 hours", business(hours))).toEqual(
      at("2026-11-09T23:00:00Z"),
    );
    expect(isOpen(at("2026-11-09T18:30:00Z"), hours)).toBe(false);
  });

  it("crosses the spring-forward weekend", () => {
    // Friday 2026-03-06 17:50 CST → Monday 2026-03-09 08:20 CDT.
    expect(dueAt(at("2026-03-06T23:50:00Z"), "30 minutes", business(client))).toEqual(
      at("2026-03-09T13:20:00Z"),
    );
  });

  it("crosses the fall-back weekend", () => {
    // Friday 2026-10-30 17:50 CDT → Monday 2026-11-02 08:20 CST.
    expect(dueAt(at("2026-10-30T22:50:00Z"), "30 minutes", business(client))).toEqual(
      at("2026-11-02T14:20:00Z"),
    );
  });

  it("counts real minutes in a stretch that spans a DST change", () => {
    const sundays = (from: string, to: string): BusinessHours => ({
      tz: CHICAGO,
      week: { sun: [{ from, to }] },
      usHolidays: false,
      closed: [],
    });
    // Sunday 2026-03-08 01:00 CST to 04:00 CDT is two real hours.
    const spring = sundays("01:00", "04:00");
    expect(dueAt(at("2026-03-08T07:00:00Z"), "2 hours", business(spring))).toEqual(
      at("2026-03-08T09:00:00Z"),
    );
    // The third hour is the next Sunday's first, 01:00 CDT.
    expect(dueAt(at("2026-03-08T07:00:00Z"), "3 hours", business(spring))).toEqual(
      at("2026-03-15T07:00:00Z"),
    );
    // Sunday 2026-11-01 01:00 CDT to 04:00 CST is four real hours.
    expect(dueAt(at("2026-11-01T06:00:00Z"), "4 hours", business(spring))).toEqual(
      at("2026-11-01T10:00:00Z"),
    );
    // An opening at 02:30, a time that does not happen on 2026-03-08, opens at 03:30 CDT.
    const gap = sundays("02:30", "04:00");
    expect(isOpen(at("2026-03-08T08:00:00Z"), gap)).toBe(false);
    expect(isOpen(at("2026-03-08T08:30:00Z"), gap)).toBe(true);
  });

  it("is due at the start for a zero duration", () => {
    expect(dueAt(at("2026-11-07T16:00:00Z"), "0 minutes", business(client))).toEqual(
      at("2026-11-07T16:00:00Z"),
    );
  });

  it("refuses hours with no open time", () => {
    const never: BusinessHours = { tz: CHICAGO, week: {}, usHolidays: true, closed: [] };
    expect(() => dueAt(at("2026-11-07T16:00:00Z"), "1 hour", business(never))).toThrow(
      /no open time/,
    );
    expect(() => dueAt(at("2026-11-07T16:00:00Z"), "1 week", business(never))).toThrow(
      /no open time/,
    );
  });
});

describe("dueAt, business days", () => {
  it("is the same clock time on the next open day", () => {
    // Tuesday 2026-11-17 10:00 CST → Wednesday 10:00.
    expect(dueAt(at("2026-11-17T16:00:00Z"), "1 day", business(client))).toEqual(
      at("2026-11-18T16:00:00Z"),
    );
    // Friday → Monday.
    expect(dueAt(at("2026-11-06T16:00:00Z"), "1 day", business(client))).toEqual(
      at("2026-11-09T16:00:00Z"),
    );
    // Tuesday 2026-11-10 → past Veterans Day to Thursday.
    expect(dueAt(at("2026-11-10T16:00:00Z"), "1 day", business(client))).toEqual(
      at("2026-11-12T16:00:00Z"),
    );
    expect(dueAt(at("2026-11-17T16:00:00Z"), "3 days", business(client))).toEqual(
      at("2026-11-20T16:00:00Z"),
    );
  });

  it("moves a start outside the hours to the next opening first", () => {
    // Saturday 2026-11-07 → Monday 08:00 → Tuesday 08:00.
    expect(dueAt(at("2026-11-07T18:00:00Z"), "1 day", business(client))).toEqual(
      at("2026-11-10T14:00:00Z"),
    );
  });

  it("keeps the wall-clock time across a DST change", () => {
    // Friday 2026-10-30 10:00 CDT → Monday 2026-11-02 10:00 CST.
    expect(dueAt(at("2026-10-30T15:00:00Z"), "1 day", business(client))).toEqual(
      at("2026-11-02T16:00:00Z"),
    );
  });

  it("holds the time inside a shorter day's hours", () => {
    const full = [{ from: "08:00", to: "18:00" }];
    const hours: BusinessHours = {
      tz: CHICAGO,
      week: { mon: full, tue: full, wed: full, thu: full, fri: [{ from: "08:00", to: "12:00" }] },
      usHolidays: true,
      closed: [],
    };
    // Thursday 2026-11-05 15:00 → Friday's close, 12:00.
    expect(dueAt(at("2026-11-05T21:00:00Z"), "1 day", business(hours))).toEqual(
      at("2026-11-06T18:00:00Z"),
    );
  });

  it("counts a week as the week's open days", () => {
    // Tuesday 2026-11-10 + 5 open days (Wednesday is Veterans Day) → Wednesday 2026-11-18.
    expect(dueAt(at("2026-11-10T16:00:00Z"), "1 week", business(client))).toEqual(
      at("2026-11-18T16:00:00Z"),
    );
  });
});

describe("a person's own hours and away dates", () => {
  const london: BusinessHours = {
    tz: "Europe/London",
    week: Object.fromEntries(
      ["mon", "tue", "wed", "thu", "fri"].map((d) => [d, [{ from: "09:00", to: "17:00" }]]),
    ),
    usHolidays: false,
    closed: [],
  };
  const person: PersonHours = { hours: london, away: [] };

  it("uses the person's hours when they have them, with the client's closed dates", () => {
    expect(effectiveHours(client)).toBe(client);
    expect(effectiveHours(client, { away: [] })).toBe(client);
    const eff = effectiveHours({ ...client, closed: ["2026-12-24"] }, person);
    expect(eff.tz).toBe("Europe/London");
    expect(eff.closed).toEqual(["2026-12-24"]);
  });

  it("runs on the person's zone, not the client's", () => {
    // Tuesday 2026-11-17 10:00 CST is 16:00 in London: one hour left there, then Wednesday 09:00.
    const hours = effectiveHours(client, person);
    expect(dueAt(at("2026-11-17T16:00:00Z"), "2 hours", business(hours))).toEqual(
      at("2026-11-18T10:00:00Z"),
    );
    // 11:30 in Chicago is open for the client, but 17:30 in London is not for the person.
    expect(isOpen(at("2026-11-17T17:30:00Z"), client)).toBe(true);
    expect(isWorking(at("2026-11-17T17:30:00Z"), client, person)).toBe(false);
    expect(isWorking(at("2026-11-17T16:30:00Z"), client, person)).toBe(true);
  });

  it("skips the person's away dates in business time", () => {
    const away = { ...person, away: [{ from: "2026-11-18", to: "2026-11-18" }] };
    const s = scheduleFor(client, away);
    expect(dueAt(at("2026-11-17T16:00:00Z"), "2 hours", business(s.businessHours, s.away))).toEqual(
      at("2026-11-19T10:00:00Z"),
    );
    expect(isAway(at("2026-11-18T12:00:00Z"), away, client)).toBe(true);
    expect(isAway(at("2026-11-19T12:00:00Z"), away, client)).toBe(false);
    expect(isWorking(at("2026-11-18T12:00:00Z"), client, away)).toBe(false);
  });

  it("reads away dates in the client's zone when the person has no hours", () => {
    const away: PersonHours = { away: [{ from: "2026-11-18", to: "2026-11-20" }] };
    // 2026-11-18 03:00Z is still the 17th in Chicago.
    expect(isAway(at("2026-11-18T03:00:00Z"), away, client)).toBe(false);
  });
});

describe("a role: the clock runs while any one person is working", () => {
  const hoursOf = (tz: string, from: string, to: string): BusinessHours => ({
    tz,
    week: Object.fromEntries(["mon", "tue", "wed", "thu", "fri"].map((d) => [d, [{ from, to }]])),
    usHolidays: true,
    closed: [],
  });

  it("counts the union of the people's hours", () => {
    const people: Schedule[] = [
      { businessHours: hoursOf(CHICAGO, "08:00", "12:00") },
      { businessHours: hoursOf(CHICAGO, "12:00", "18:00") },
    ];
    // Monday 2026-11-16 11:00 CST + 2 hours → 13:00.
    expect(
      dueAtForMany(at("2026-11-16T17:00:00Z"), "2 hours", { hours: "business", people }),
    ).toEqual(at("2026-11-16T19:00:00Z"));
  });

  it("joins people in different zones", () => {
    const people: Schedule[] = [
      { businessHours: hoursOf("Europe/London", "09:00", "17:00") },
      { businessHours: client },
    ];
    // Open together 09:00Z to 24:00Z. Tuesday 2026-11-17 15:00Z + 10 hours → Wednesday 10:00Z.
    expect(
      dueAtForMany(at("2026-11-17T15:00:00Z"), "10 hours", { hours: "business", people }),
    ).toEqual(at("2026-11-18T10:00:00Z"));
    expect(anyOpen(at("2026-11-17T23:30:00Z"), people)).toBe(true);
    expect(anyOpen(at("2026-11-18T03:00:00Z"), people)).toBe(false);
    // One person away: only the other's hours count.
    const oneAway: Schedule[] = [
      { ...people[0], away: [{ from: "2026-11-18", to: "2026-11-18" }] } as Schedule,
      people[1] as Schedule,
    ];
    expect(anyOpen(at("2026-11-18T10:00:00Z"), oneAway)).toBe(false);
  });

  it("takes the earliest person's due time for days", () => {
    const people: Schedule[] = [
      { businessHours: client, away: [{ from: "2026-11-18", to: "2026-11-18" }] },
      { businessHours: client },
    ];
    expect(
      dueAtForMany(at("2026-11-17T16:00:00Z"), "1 day", { hours: "business", people }),
    ).toEqual(at("2026-11-18T16:00:00Z"));
  });

  it("skips a person with no open time, and refuses only when nobody has any", () => {
    const never: Schedule = { businessHours: { ...client, week: {} } };
    const people: Schedule[] = [never, { businessHours: client }];
    // Tuesday 2026-11-17 10:00 CST.
    expect(
      dueAtForMany(at("2026-11-17T16:00:00Z"), "1 day", { hours: "business", people }),
    ).toEqual(at("2026-11-18T16:00:00Z"));
    expect(
      dueAtForMany(at("2026-11-17T16:00:00Z"), "1 week", { hours: "business", people }),
    ).toEqual(at("2026-11-24T16:00:00Z"));
    expect(
      dueAtForMany(at("2026-11-17T16:00:00Z"), "2 hours", { hours: "business", people }),
    ).toEqual(at("2026-11-17T18:00:00Z"));
    for (const after of ["1 day", "1 week", "2 hours"]) {
      expect(() =>
        dueAtForMany(at("2026-11-17T16:00:00Z"), after, {
          hours: "business",
          people: [never, never],
        }),
      ).toThrow(NoOpenTimeError);
    }
  }, 30_000);

  it("adds real time on the clock, and needs someone in business time", () => {
    expect(
      dueAtForMany(at("2026-11-17T16:00:00Z"), "1 hour", { hours: "clock", people: [] }),
    ).toEqual(at("2026-11-17T17:00:00Z"));
    expect(() =>
      dueAtForMany(at("2026-11-17T16:00:00Z"), "1 hour", { hours: "business", people: [] }),
    ).toThrow(/at least one person/);
  });
});
