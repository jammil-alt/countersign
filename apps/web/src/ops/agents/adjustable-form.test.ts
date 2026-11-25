// B5 (docs/builder-plan.md §7): the definition editor's marks of what the client may adjust, as
// strings while typing, checked, and written into `definition.adjustable` (left out when none).
import { describe, expect, it } from "vitest";
import {
  type AdjustDraft,
  draftProblem,
  draftsFrom,
  scheduleTargets,
  settingsFrom,
  toggleDraft,
  updateDraft,
  withAdjustable,
} from "./adjustable-form";

const tolerance = {
  kind: "parameter" as const,
  skill: "custom:price-match",
  parameter: "tolerance",
  type: "number" as const,
};
const daily = { kind: "schedule" as const, workflow: "main", triggerId: "t1" };

describe("adjustable marks in the definition editor", () => {
  it("marks, edits and unmarks a parameter, and round-trips through the definition", () => {
    let drafts: AdjustDraft[] = toggleDraft([], tolerance, true, { label: "Tolerance" });
    expect(drafts.map((d) => d.id)).toEqual(["param-tolerance"]);
    drafts = updateDraft(drafts, tolerance, { min: "0", max: "5", tighter: "lower" });
    const settings = settingsFrom(drafts);
    expect(settings).toEqual([
      {
        id: "param-tolerance",
        label: "Tolerance",
        hint: "",
        target: tolerance,
        bounds: { min: "0", max: "5" },
        tighter: "lower",
      },
    ]);
    expect(draftsFrom({ adjustable: settings })).toEqual(drafts);
    expect(toggleDraft(drafts, tolerance, false, { label: "x" })).toEqual([]);
  });

  it("checks the limits and a schedule's options in plain words", () => {
    const base = toggleDraft([], tolerance, true, { label: "Tolerance" })[0] as AdjustDraft;
    expect(draftProblem(base)).toBe("Give it a low limit, a high one, or a stricter side.");
    expect(draftProblem({ ...base, min: "a" })).toBe("Limits are numbers, like 0 or 5.5.");
    expect(draftProblem({ ...base, min: "6", max: "5" })).toBe(
      "The low limit is above the high one.",
    );
    expect(draftProblem({ ...base, tighter: "lower" })).toBeNull();
    expect(draftProblem({ ...base, label: " ", max: "5" })).toBe(
      "Give it a name the client reads.",
    );
    const sched = toggleDraft([], daily, true, { label: "When it runs" })[0] as AdjustDraft;
    expect(draftProblem(sched)).toBe("List the times the client may choose, one per line.");
    // Crons keep their commas: one per line.
    const ok = { ...sched, options: "0 7 * * 1-5\n0 9 * * 1,4\n" };
    expect(draftProblem(ok)).toBeNull();
    expect(settingsFrom([ok])[0]?.bounds).toEqual({ options: ["0 7 * * 1-5", "0 9 * * 1,4"] });
  });

  it("keeps a date's limits as dates (G11), and a step's own parameter apart", () => {
    const start = { ...tolerance, parameter: "start", type: "date" as const, stepId: "s1" };
    let drafts = toggleDraft([], start, true, { label: "Start date" });
    expect(drafts.map((d) => d.id)).toEqual(["param-s1-start"]);
    const base = drafts[0] as AdjustDraft;
    expect(draftProblem(base)).toBeNull();
    expect(draftProblem({ ...base, min: "soon" })).toBe("Limits are dates, like 2026-12-24.");
    expect(draftProblem({ ...base, min: "2026-12-31", max: "2026-12-01" })).toBe(
      "The earliest date is after the latest.",
    );
    drafts = updateDraft(drafts, start, {
      min: "2026-12-01",
      max: "2026-12-31",
      tighter: "higher",
    });
    const settings = settingsFrom(drafts);
    expect(settings[0]).toMatchObject({
      target: start,
      bounds: { earliest: "2026-12-01", latest: "2026-12-31" },
      tighter: "higher",
    });
    expect(draftsFrom({ adjustable: settings })).toEqual(drafts);
  });

  it("leaves the field out when nothing is marked, and keeps the rest of the definition", () => {
    const def = { identity: { name: "A" }, adjustable: [{ id: "x" }] };
    expect(withAdjustable(def, [])).toEqual({ identity: { name: "A" } });
    const one = toggleDraft([], daily, true, { label: "When", options: "0 7 * * 1" });
    expect(withAdjustable(def, one)).toMatchObject({
      identity: { name: "A" },
      adjustable: [{ id: "schedule-main-t1", target: daily }],
    });
  });

  it("lists the agent's schedules from a workflow's triggers", () => {
    expect(
      scheduleTargets({
        workflows: [
          {
            slug: "main",
            name: "Main",
            workflow: {
              schemaVersion: 5,
              triggers: [
                { id: "t1", on: { type: "schedule", cron: "0 7 * * 1-5" } },
                { id: "t2", on: { type: "manual", input: {} } },
              ],
            },
          },
        ] as never,
      }),
    ).toEqual([{ target: daily, workflow: "Main", cron: "0 7 * * 1-5" }]);
  });
});
