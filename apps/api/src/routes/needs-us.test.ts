// QA (2026-11-22): Needs us is what the operator must act on. A client's approval someone there
// can act on waits on the client however long it waits; approvals nobody there can act on are one
// escalation per client and reason, naming every item. "Today" is the browser's day when it sends
// one that can be today's start, else midnight UTC.

import type { ClientMember, ReachContext } from "@countersign/core";
import { describe, expect, it } from "vitest";
import type { OpenItemRow } from "../runs/run-wait";
import { approvalEscalations, startOfToday } from "./command-center";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const NOW = new Date("2026-11-22T03:00:00.000Z");
const hoursAgo = (n: number) => new Date(NOW.getTime() - n * 3_600_000);

let n = 0;
function item(tenantId: string, values: Partial<OpenItemRow> = {}): OpenItemRow {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    tenantId,
    runId: null,
    agentId: null,
    title: `Add person ${n} to the directory`,
    payload: {},
    assigneeRole: "client_admin",
    assigneeUserId: null,
    createdAt: hoursAgo(n),
    personName: null,
    ...values,
  };
}

const admin = (signedIn: boolean): ClientMember => ({
  userId: `u-${signedIn}`,
  role: "client_admin",
  canSign: true,
  signedIn,
});

const workos: ReachContext = { signInsKnown: true, emailOn: true };

describe("approvalEscalations", () => {
  it("leaves out what someone at the client can act on, however long it has waited", () => {
    const items = [item(A, { createdAt: hoursAgo(239) }), item(A, { createdAt: hoursAgo(50) })];
    const members = new Map([[A, [admin(true)]]]);
    expect(approvalEscalations(items, members, workos)).toEqual([]);
  });

  it("makes one per client and reason, oldest first, naming every item", () => {
    const old = item(A, { createdAt: hoursAgo(239), runId: "r-1" });
    const newer = item(A, { createdAt: hoursAgo(2) });
    const team = item(A, { assigneeUserId: "u-left", createdAt: hoursAgo(5) });
    const atB = item(B, { createdAt: hoursAgo(1) });
    const members = new Map<string, ClientMember[]>([
      // A's admin never signed in; the person one item names is no longer at A.
      [A, [admin(false)]],
      [B, [admin(false)]],
    ]);
    const out = approvalEscalations([newer, team, old, atB], members, workos);
    const byKey = new Map(out.map((e) => [`${e.tenantId}:${e.wait?.nobodyToAct}`, e]));
    expect([...byKey.keys()].sort()).toEqual(
      [`${A}:not_signed_in`, `${A}:no_approver`, `${B}:not_signed_in`].sort(),
    );
    const signIn = byKey.get(`${A}:not_signed_in`);
    expect(signIn).toMatchObject({
      kind: "approval",
      id: old.id,
      title: old.title,
      blockedSince: old.createdAt.toISOString(),
      itemIds: [old.id, newer.id],
      // Two items: no one run to open.
      runId: null,
    });
    expect(signIn?.wait).toMatchObject({ items: 2, on: "client_admin" });
    expect(byKey.get(`${A}:no_approver`)).toMatchObject({ itemIds: [team.id] });
    expect(byKey.get(`${B}:not_signed_in`)).toMatchObject({ itemIds: [atB.id] });
    // One item keeps its run.
    const one = approvalEscalations([old], new Map([[A, [admin(false)]]]), workos);
    expect(one[0]?.runId).toBe("r-1");
  });
});

describe("startOfToday", () => {
  it("takes the browser's start of day when it can be today's", () => {
    // 21 Nov 00:00 in New York is 05:00 UTC: 22 hours back.
    expect(startOfToday(NOW, "2026-11-21T05:00:00.000Z").toISOString()).toBe(
      "2026-11-21T05:00:00.000Z",
    );
    expect(startOfToday(NOW, "2026-11-21T00:00:00-05:00").toISOString()).toBe(
      "2026-11-21T05:00:00.000Z",
    );
  });

  it("falls back to midnight UTC without one, or with one that can't be today's", () => {
    const utc = "2026-11-22T00:00:00.000Z";
    expect(startOfToday(NOW).toISOString()).toBe(utc);
    expect(startOfToday(NOW, "2026-11-22T04:00:00.000Z").toISOString()).toBe(utc);
    expect(startOfToday(NOW, "2026-11-20T00:00:00.000Z").toISOString()).toBe(utc);
    expect(startOfToday(NOW, "not a time").toISOString()).toBe(utc);
  });
});
