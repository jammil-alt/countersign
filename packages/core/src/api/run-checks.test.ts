import { describe, expect, it } from "vitest";
import {
  approvalOf,
  checkKindOf,
  conferOf,
  itemOfStep,
  noAnswerOf,
  stepNodeOf,
  urgentOf,
} from "./run-checks";

const row = (over: Partial<Parameters<typeof conferOf>[0]>) => ({
  nodeId: "post",
  nodeType: "write",
  status: "succeeded",
  ...over,
});

const item = (over: Partial<Parameters<typeof approvalOf>[1][number]> = {}) => ({
  id: "i1",
  kind: "external_action",
  status: "open",
  payload: { stepId: "post" },
  createdAt: "2026-11-10T10:00:00.000Z",
  ...over,
});

describe("run checks", () => {
  it("splits a durable name into its step and the check after it", () => {
    expect(stepNodeOf("post")).toEqual({ node: "post", suffix: [] });
    expect(stepNodeOf("post:confer:0")).toEqual({ node: "post", suffix: ["confer", "0"] });
    expect(stepNodeOf("loop:2:post")).toEqual({ node: "loop:2:post", suffix: [] });
    expect(stepNodeOf("loop:2:post:approval:1:a1")).toEqual({
      node: "loop:2:post",
      suffix: ["approval", "1", "a1"],
    });
    expect(checkKindOf("post:notify:0")).toBe("notify");
    expect(checkKindOf("loop:0:post")).toBeNull();
  });

  it("reads a confer row: a person, a second check, someone away", () => {
    expect(
      conferOf(
        row({
          nodeId: "post:confer:1",
          nodeType: "confer",
          input: { reviewer: "dana" },
          output: { verdict: "disagree", note: "The total is off", by: "dana" },
        }),
      ),
    ).toEqual({ reviewer: "person", who: "dana", verdict: "disagree", note: "The total is off" });
    expect(
      conferOf(
        row({
          nodeId: "post:confer:0",
          nodeType: "confer",
          input: { reviewer: "ai" },
          output: { verdict: "agree", note: "", by: "ai" },
        }),
      ),
    ).toEqual({ reviewer: "ai", who: null, verdict: "agree", note: null });
    expect(
      conferOf(
        row({
          nodeId: "post:confer:2",
          nodeType: "confer",
          status: "skipped",
          output: { verdict: "no_answer", note: "away", by: "dana" },
        }),
      ),
    ).toEqual({ reviewer: "person", who: "dana", verdict: "no_answer", note: null, away: true });
    // Still waiting: no verdict yet.
    expect(conferOf(row({ nodeId: "post:confer:0", nodeType: "confer" }))).toBeNull();
    expect(conferOf(row({}))).toBeNull();
  });

  it("tells a step that went on from one where the run stopped, with no answer", () => {
    expect(noAnswerOf(row({ output: { proceededWithoutAnswer: true } }), null)).toBe("proceeded");
    expect(noAnswerOf(row({}), { reason: "timeout", nodeId: "post:approval:1" })).toBe("stopped");
    expect(noAnswerOf(row({}), { reason: "not_seen", nodeId: "post" })).toBe("stopped");
    expect(noAnswerOf(row({}), { reason: "timeout", nodeId: "other" })).toBeNull();
    expect(noAnswerOf(row({}), { reason: "rejected", nodeId: "post" })).toBeNull();
  });

  it("lists a step's approvers in the order asked, never a confer's ask", () => {
    const items = [
      item({
        id: "i2",
        kind: "approval",
        status: "resolved",
        resolution: { approved: false },
        payload: { nodeId: "post:approval:1:a1" },
        assigneeUserId: "u2",
        resolvedAt: "2026-11-10T12:00:00.000Z",
        createdAt: "2026-11-10T11:00:00.000Z",
      }),
      item({ id: "i1", status: "expired", assigneeRole: "client_admin" }),
      item({ id: "i3", kind: "approval", payload: { nodeId: "post:confer:1" } }),
    ];
    expect(itemOfStep(items[2] as never, { nodeId: "post" })).toBe(false);
    expect(approvalOf({ nodeId: "post" }, items, "in_turn")).toEqual({
      mode: "in_turn",
      approvers: [
        { itemId: "i1", role: "client_admin", userId: null, state: "no_answer", at: null },
        {
          itemId: "i2",
          role: null,
          userId: "u2",
          state: "rejected",
          at: "2026-11-10T12:00:00.000Z",
        },
      ],
    });
    expect(approvalOf({ nodeId: "other" }, items)).toBeNull();
  });

  it("follows an urgent notice's Seen", () => {
    const notice = row({
      nodeId: "post:notify:0",
      nodeType: "notify",
      output: { urgent: { dueAt: "2026-11-10T13:00:00.000Z" }, ackItemId: "ack" },
    });
    expect(urgentOf(notice, [])).toEqual({
      dueAt: "2026-11-10T13:00:00.000Z",
      state: "waiting",
      seenAt: null,
    });
    expect(
      urgentOf(notice, [
        item({
          id: "ack",
          kind: "review",
          status: "resolved",
          resolvedAt: "2026-11-10T12:30:00.000Z",
        }),
      ]),
    ).toEqual({
      dueAt: "2026-11-10T13:00:00.000Z",
      state: "seen",
      seenAt: "2026-11-10T12:30:00.000Z",
    });
    // Found by its item alone.
    expect(
      urgentOf(row({ nodeId: "post:notify:1", nodeType: "notify" }), [
        item({
          kind: "review",
          status: "expired",
          payload: { nodeId: "post:notify:1", urgent: { dueAt: "2026-11-10T13:00:00.000Z" } },
        }),
      ])?.state,
    ).toBe("not_seen");
    expect(urgentOf(row({ nodeType: "notify" }), [])).toBeNull();
  });
});
