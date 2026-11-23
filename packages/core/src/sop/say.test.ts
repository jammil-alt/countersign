// S5.7 (overnight fixes, 2026-11-23): what the SOP's code writes is said by key beside its English,
// so the app writes it in the reader's language (the Spanish chart said "We start it by hand").
import { describe, expect, it } from "vitest";
import { directorySuggestionTitle } from "../directory/schemas";
import { sopTriggerSay, sopTriggerWords, sopView } from "./build";
import { input } from "./fixtures.test-helper";
import { SOP_SAY_KEYS } from "./say";
import { type SopStepLine, SopView } from "./view";

const step = (view: SopView, id: string) =>
  view.procedure.find((l): l is SopStepLine => l.line === "step" && l.id === id) as SopStepLine;

describe("the SOP by key", () => {
  it("says a tool step's purpose by key, its record type translatable", () => {
    const view = sopView(input());
    expect(SopView.parse(view)).toBeTruthy();
    const create = step(view, "create");
    expect(create.purpose).toBe("Adds bills to QuickBooks Online.");
    expect(create.purposeSay).toEqual({
      key: "sop.say.purpose.adds",
      params: { what: "bills", where: "QuickBooks Online" },
      paramKeys: { what: "sop.say.entity.bill" },
    });
    // The operator's own words have no key: they stay as written.
    expect(step(view, "vendor").purposeSay).toBeUndefined();
    expect(create.approval?.ifRejectedSay?.key).toMatch(/^sop\.say\.rejected\./);
  });

  it("says each trigger by key, in the order of the English", () => {
    const view = sopView(input());
    expect(view.start.triggersSay?.length).toBe(view.start.triggers.length);
    expect(sopTriggerWords({ type: "manual" }, () => null)).toBe("We start it by hand");
    expect(sopTriggerSay({ type: "manual" }, () => null)).toEqual({
      key: "sop.say.trigger.manualUs",
    });
    expect(sopTriggerSay({ type: "handoff", from: { agent: "pia" } }, () => "Pia")).toEqual({
      key: "sop.say.trigger.handoff",
      params: { name: "Pia" },
    });
    // A schedule is said in English only.
    expect(sopTriggerSay({ type: "schedule", cron: "0 7 * * 1-5" }, () => null)).toBeNull();
    for (const said of view.start.triggersSay ?? []) {
      if (said) expect(SOP_SAY_KEYS).toContain(said.key);
    }
  });

  it("says a directory suggestion's title by key", () => {
    const add = directorySuggestionTitle({
      action: "add_organization",
      organization: { name: "QA Supplies Ltd" },
    } as Parameters<typeof directorySuggestionTitle>[0]);
    expect(add).toEqual({
      key: "directory.suggestions.title.add",
      params: { name: "QA Supplies Ltd" },
      english: "Add QA Supplies Ltd to the directory",
    });
  });
});
