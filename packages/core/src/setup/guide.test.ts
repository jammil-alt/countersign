// Getting started's pure rules (docs/setup-plan.md; docs/plan.md §1.185).
import { describe, expect, it } from "vitest";
import { membersNamedIn, minutesLeft, readAgentGuide, readTenantGuide, runbook } from "./guide";

const DANA = { userId: "d", name: "Dana Ruiz", email: "dana@hartley.test" };
const LUIS = { userId: "l", name: "Luis Ortega", email: "luis@hartley.test" };
const MARK = { userId: "m", name: "Mark Lee", email: "mark@hartley.test" };
const MARK2 = { userId: "m2", name: "Mark Diaz", email: "mdiaz@hartley.test" };

describe("membersNamedIn", () => {
  it("finds members by full or first name, in the order the answer names them", () => {
    expect(
      membersNamedIn("Luis signs anything over five grand, and Dana if he's out", [
        DANA,
        LUIS,
        MARK,
      ]),
    ).toEqual(["l", "d"]);
    expect(membersNamedIn("Mark Lee knows the job codes", [DANA, LUIS, MARK])).toEqual(["m"]);
  });

  it("never guesses between two people with the same first name", () => {
    expect(membersNamedIn("Mark knows the job codes", [MARK, MARK2])).toEqual([]);
    expect(membersNamedIn("Mark Diaz knows the job codes", [MARK, MARK2])).toEqual(["m2"]);
  });

  it("names nobody when nobody is named", () => {
    expect(membersNamedIn("The owner approves everything", [DANA, LUIS])).toEqual([]);
    expect(membersNamedIn("", [DANA])).toEqual([]);
  });

  it("ignores accents and case", () => {
    expect(
      membersNamedIn("JOSÉ approves", [{ userId: "j", name: "José Ruiz", email: "j@x.test" }]),
    ).toEqual(["j"]);
  });
});

describe("runbook", () => {
  it("dates each step from the invite and marks what is done", () => {
    const r = runbook(
      {
        invitedAt: "2026-11-20T09:00:00.000Z",
        trialStartedAt: null,
        liveAt: null,
        now: "2026-11-22T09:00:00.000Z",
      },
      false,
    );
    expect(r.map((s) => [s.key, s.day, s.done])).toEqual([
      ["invite", 0, true],
      ["kickoff", 2, false],
      ["trial", 3, false],
      ["checkin", 10, false],
      ["live", 17, false],
    ]);
    expect(r[1]?.at).toBe("2026-11-22T09:00:00.000Z");
  });

  it("dates the check-in a week after the trial starts", () => {
    const r = runbook(
      {
        invitedAt: "2026-11-20T09:00:00.000Z",
        trialStartedAt: "2026-11-23T09:00:00.000Z",
        liveAt: null,
        now: "2026-12-01T09:00:00.000Z",
      },
      true,
    );
    expect(r.find((s) => s.key === "checkin")).toMatchObject({
      at: "2026-11-30T09:00:00.000Z",
      done: true,
    });
    expect(r.find((s) => s.key === "trial")?.done).toBe(true);
  });
});

describe("stored state", () => {
  it("reads what parses, and nothing else", () => {
    expect(
      readAgentGuide({
        guide: { marks: { s1: { state: "ok", by: "u", byName: "Dana", at: "x" } } },
      }).marks?.s1?.state,
    ).toBe("ok");
    expect(readAgentGuide({ guide: { marks: "nope" } })).toEqual({});
    expect(readAgentGuide(null)).toEqual({});
    expect(
      readTenantGuide({ setupGuide: { people: { by: "u", byName: "Dana", at: "x" } } }).people
        ?.byName,
    ).toBe("Dana");
    expect(readTenantGuide({})).toEqual({});
  });
});

describe("minutesLeft", () => {
  it("adds up what is left, at least a minute", () => {
    expect(minutesLeft([])).toBe(0);
    expect(minutesLeft([{ chapter: "tools" }, { chapter: "people" }, { chapter: "see" }])).toBe(5);
  });
});
