// QA W9: a trial reads "In trial" in the portal, as the back office says it (apps/web/src/agents/
// status.ts, BuildView, FlowBar), never "On trial".
import { describe, expect, it } from "vitest";
import { createTranslator } from "../i18n/catalog";
import { stageWord } from "./agentState";

const t = createTranslator("en");

describe("the go-live stage's word", () => {
  it("says In trial, as the back office does, and nothing once live", () => {
    expect(stageWord("trial", t)).toBe("In trial");
    expect(stageWord("live", t)).toBeNull();
  });
});
