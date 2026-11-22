// The intake's log on a deal's timeline (§1.149; §1.220): an invite that didn't go out reads so
// and shows in risk; Send it again is offered once per person, on the newest line about their
// invite, and only while the back office says it still hasn't gone.
import type { OpsIntakeView } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { onboardingLines } from "./timeline";

const I = "0192f7a0-0000-7000-8000-0000000000a1";
const DANA = "0192f7a0-0000-7000-8000-0000000000d1";
const MARK = "0192f7a0-0000-7000-8000-0000000000d2";

function view(over: Partial<OpsIntakeView>): OpsIntakeView {
  return {
    intake: { id: I } as OpsIntakeView["intake"],
    guide: { version: 1, sections: [], totals: {} } as unknown as OpsIntakeView["guide"],
    people: [
      { id: DANA, name: "Dana Ruiz" },
      { id: MARK, name: "Mark Lee" },
    ] as OpsIntakeView["people"],
    answers: [],
    progress: [],
    events: [],
    ...over,
  };
}

const ev = (id: string, kind: string, personId: string, meta: Record<string, unknown>) =>
  ({ id, kind, personId, meta, at: `2026-11-22T10:0${id}:00Z` }) as OpsIntakeView["events"][number];

describe("onboardingLines", () => {
  it("says an invite that didn't go out, and offers Send it again on the newest", () => {
    const lines = onboardingLines(
      view({
        unsentInvites: [DANA],
        events: [
          ev("3", "bounced", DANA, { email: "invite", notificationId: "n2" }),
          ev("2", "sent", DANA, { email: "invite", notificationId: "n2", status: "sent" }),
          ev("1", "sent", DANA, { email: "invite", notificationId: "n1", status: "skipped" }),
        ],
      }),
    );
    expect(lines.map((l) => [l.body, l.failed, !!l.sendAgain])).toEqual([
      ["The invite to Dana Ruiz bounced.", true, true],
      ["Invite sent to Dana Ruiz.", false, false],
      ["The invite to Dana Ruiz didn't go out.", true, false],
    ]);
    expect(lines[0]?.sendAgain).toEqual({ intakeId: I, personId: DANA });
  });

  it("offers nothing once it went, for a colleague's email, or for a closed intake's skip", () => {
    const lines = onboardingLines(
      view({
        unsentInvites: [],
        events: [
          ev("2", "sent", MARK, { email: "colleague", status: "failed" }),
          ev("1", "sent", DANA, { email: "invite", status: "failed" }),
        ],
      }),
    );
    expect(lines.every((l) => !l.sendAgain)).toBe(true);
    const closed = onboardingLines(
      view({
        events: [ev("1", "sent", DANA, { email: "invite", status: "skipped", reason: "closed" })],
      }),
    );
    expect(closed[0]?.failed).toBe(false);
  });
});
