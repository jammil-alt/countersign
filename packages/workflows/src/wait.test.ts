// A step that waits on something outside the run (a reach-out's reply, docs/plan.md §1.25): the
// executor checks before waiting, waits for the port's event or the timeout, then asks the port
// what came of it; a replay repeats nothing; a test run never waits because its port never asks to.
import { describe, expect, it } from "vitest";
import { executeWorkflow } from "./executor";
import { FakeStepRunner } from "./fake-runner";
import { Harness, SKILL, wf } from "./fakes.test-helper";
import type { StepOutcome } from "./ports";

const step = { id: "reach", kind: "skill", name: "Reach out", skill: SKILL.id, input: {} };

function waitingHarness(opts: { alreadyDone?: boolean } = {}) {
  const h = new Harness();
  const seen: { timedOut: boolean }[] = [];
  let checks = 0;
  h.handlers.reach = () => ({
    kind: "waiting",
    wait: { eventType: "reachout-1", timeout: "2 days", state: { reachOutId: "r1" } },
  });
  h.agent.waitDone = async () => {
    checks++;
    return opts.alreadyDone === true;
  };
  h.agent.afterWait = async (req): Promise<StepOutcome> => {
    seen.push({ timedOut: req.timedOut });
    return {
      kind: "done",
      output: { outcome: req.timedOut ? "no_reply" : "replied", state: req.wait.state },
    };
  };
  return { h, seen, checks: () => checks };
}

describe("waiting steps", () => {
  it("waits for the event, then the port says what came of it; the fork sees it", async () => {
    const { h, seen } = waitingHarness();
    const runner = new FakeStepRunner({ onWait: "block" });
    runner.onWaitStarted = (_name, type) => runner.deliver(type, { reachOutId: "r1" });
    const result = await executeWorkflow(
      runner,
      h.context(),
      wf([
        step,
        {
          id: "f",
          kind: "fork",
          name: "Replied?",
          paths: [
            {
              id: "yes",
              name: "Replied",
              when: {
                match: "all",
                rules: [{ field: "{{steps.reach.output.outcome}}", op: "=", value: "replied" }],
              },
              steps: [],
            },
          ],
          otherwise: { id: "no", steps: [] },
        },
      ]),
      {},
    );
    expect(result).toEqual({ status: "succeeded" });
    expect(seen).toEqual([{ timedOut: false }]);
    expect(h.row("reach")?.updates.map((u) => u.status)).toEqual(["waiting", "succeeded"]);
    expect(h.row("reach")?.updates[0]?.summary).toBe("Reach out: waiting for a reply");
    expect(h.row("f")?.output).toEqual({ pathId: "yes", pathName: "Replied" });
    expect(runner.names("wait")).toEqual(["reach:wait:1:wait"]);
  });

  it("times out as the port decides, and skips the wait when it already ended", async () => {
    const timed = waitingHarness();
    await executeWorkflow(new FakeStepRunner(), timed.h.context(), wf([step]), {});
    expect(timed.seen).toEqual([{ timedOut: true }]);
    expect(timed.h.row("reach")?.output).toMatchObject({ outcome: "no_reply" });

    const early = waitingHarness({ alreadyDone: true });
    const runner = new FakeStepRunner();
    await executeWorkflow(runner, early.h.context(), wf([step]), {});
    expect(early.checks()).toBe(1);
    expect(runner.names("wait")).toEqual([]);
    expect(early.seen).toEqual([{ timedOut: false }]);
  });

  it("fails clearly when the port can't wait", async () => {
    const h = new Harness();
    h.handlers.reach = () => ({
      kind: "waiting",
      wait: { eventType: "reachout-1", timeout: "1 hour" },
    });
    const result = await executeWorkflow(new FakeStepRunner(), h.context(), wf([step]), {});
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("can't wait");
  });
});
