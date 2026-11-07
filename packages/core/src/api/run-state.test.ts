import { describe, expect, it } from "vitest";
import {
  APPROVAL_OVERDUE_HOURS,
  approvalOverdue,
  type ClientMember,
  nobodyToAct,
  runState,
  runWaitOf,
  waitOn,
  whoMayApprove,
} from "./run-state";

const admin = (signedIn: boolean | null): ClientMember => ({
  userId: "admin",
  role: "client_admin",
  canSign: true,
  signedIn,
});
const viewer: ClientMember = { userId: "v", role: "client_user", canSign: false, signedIn: true };
const clerk: ClientMember = { userId: "c", role: "client_user", canSign: true, signedIn: true };
const role = (r: string | null) => ({ assigneeRole: r, assigneeUserId: null });

describe("runState", () => {
  it("reads a running run that waits on a person as waiting, never running", () => {
    expect(runState({ status: "running" })).toBe("running");
    expect(runState({ status: "running", waiting: true })).toBe("waiting");
    expect(runState({ status: "queued" })).toBe("queued");
    expect(runState({ status: "waiting" })).toBe("waiting");
    expect(runState({ status: "succeeded", waiting: true })).toBe("done");
    expect(runState({ status: "cancelled" })).toBe("stopped");
  });
});

describe("who waits, and whether anybody can act", () => {
  it("names who an item waits on", () => {
    expect(waitOn(role(null))).toBe("client_admin");
    expect(waitOn(role("client_admin"))).toBe("client_admin");
    expect(waitOn(role("client_user"))).toBe("client_team");
    expect(waitOn(role("operator"))).toBe("operator");
    expect(waitOn({ assigneeRole: "client_admin", assigneeUserId: "u" })).toBe("person");
  });

  it("finds who may approve, never a viewer", () => {
    expect(whoMayApprove(role("client_admin"), [admin(true), clerk, viewer])).toEqual([
      admin(true),
    ]);
    expect(whoMayApprove(role("client_user"), [admin(true), clerk, viewer])).toHaveLength(2);
    expect(whoMayApprove({ assigneeRole: null, assigneeUserId: "v" }, [viewer])).toEqual([]);
  });

  it("says why nobody can act", () => {
    const known = { signInsKnown: true, emailOn: true };
    expect(nobodyToAct(role("client_admin"), [], known)).toBe("no_approver");
    expect(nobodyToAct(role("client_admin"), [admin(false)], known)).toBe("not_signed_in");
    expect(nobodyToAct(role("client_admin"), [admin(true)], known)).toBeNull();
    // A signed-in approver can act on their next visit, emails or not.
    expect(nobodyToAct(role("client_admin"), [admin(true)], { ...known, emailOn: false })).toBe(
      null,
    );
    // The dev sign-in can't tell who signed in: only emails tell people.
    const dev = { signInsKnown: false, emailOn: false };
    expect(nobodyToAct(role("client_admin"), [admin(null)], dev)).toBe("no_email");
    expect(nobodyToAct(role("client_admin"), [admin(null)], { ...dev, emailOn: true })).toBeNull();
    // We are always there.
    expect(nobodyToAct(role("operator"), [], dev)).toBeNull();
  });

  it("is overdue after a day", () => {
    const now = new Date("2026-11-07T12:00:00Z");
    const hours = (n: number) => new Date(now.getTime() - n * 3_600_000);
    expect(approvalOverdue(hours(APPROVAL_OVERDUE_HOURS - 1), now)).toBe(false);
    expect(approvalOverdue(hours(39).toISOString(), now)).toBe(true);
  });

  it("takes a run's wait from its oldest open item", () => {
    const wait = runWaitOf(
      [
        {
          ...role("operator"),
          createdAt: new Date("2026-11-06T10:00:00Z"),
          personName: null,
        },
        {
          assigneeRole: null,
          assigneeUserId: "admin",
          createdAt: new Date("2026-11-05T21:00:00Z"),
          personName: "Ana Ruiz",
        },
      ],
      [admin(false)],
      { signInsKnown: true, emailOn: false },
    );
    expect(wait).toEqual({
      on: "person",
      person: "Ana Ruiz",
      since: "2026-11-05T21:00:00.000Z",
      items: 2,
      nobodyToAct: "not_signed_in",
      emailOff: true,
    });
    expect(runWaitOf([], [], { signInsKnown: true, emailOn: true })).toBeNull();
  });
});
