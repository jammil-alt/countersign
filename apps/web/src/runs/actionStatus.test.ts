import { describe, expect, it } from "vitest";
import { en } from "../i18n/messages/en";
import { actionStatus } from "./actionStatus";

describe("actionStatus", () => {
  // S4.5: the portal showed a change nobody answered in time as "Waiting for approval".
  it("says a change nobody answered in time was not made", () => {
    const s = actionStatus({ status: "rejected", expired: true });
    expect(s.key).toBe("action.status.expired");
    expect(en["action.status.expired"]).toBe("Not made: no answer in time");
    expect(s.tone).toBe("neutral");
  });

  it("keeps the other states' words", () => {
    expect(actionStatus({ status: "rejected" }).key).toBe("action.status.rejected");
    expect(actionStatus({ status: "proposed" })).toEqual({
      key: "action.status.proposed",
      tone: "warning",
    });
    expect(actionStatus({ status: "done" }).tone).toBe("positive");
    expect(actionStatus({ status: "odd" })).toEqual({ key: null, tone: "neutral" });
  });
});
