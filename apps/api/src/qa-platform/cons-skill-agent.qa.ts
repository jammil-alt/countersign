// CONS lens (consistency): a skill step's `agent` (ARCHITECTURE §10.1: "another agent of the same
// client; default the owner"). The validator accepts it in place of the owner's skill check; the
// executor's agent port runs the skill as the run's own agent.
import type { RuntimeDeps } from "@countersign/agents";
import { processes } from "@countersign/core";
import { executeWorkflow } from "@countersign/workflows";
import { describe, expect, it } from "vitest";
import { Harness, RUN, SKILL } from "../../../../packages/workflows/src/fakes.test-helper";
import { FakeWorkflowStep } from "../api.test-helper";
import { agentPort } from "../runs/ports";
import { cloudflareStepRunner } from "../runs/step-runner";

const HELPER_VERSION = "0192f7a0-0000-7000-8000-00000000d002";

const PROCESS = {
  schemaVersion: 4,
  triggers: [{ id: "t", on: { type: "manual", input: {} } }],
  steps: [
    {
      id: "ask",
      kind: "skill",
      name: "Ask the helper",
      skill: SKILL.id,
      agent: "helper",
      input: {},
    },
  ],
} as unknown as processes.Process;

/** The owner: may ask `helper`, has no skills of its own. The helper has the skill. */
function setUp() {
  const loaded: string[] = [];
  const owner = {
    agentId: RUN.agentId,
    agentVersionId: RUN.agentVersionId,
    slug: "clerk",
    bindings: {},
    bundle: {
      definition: {
        skills: [],
        extraTools: [],
        canCommand: ["helper"],
        permissions: { mode: "suggest_only" },
      },
      workflows: [],
    },
  };
  const helper = {
    ...owner,
    agentId: "0192f7a0-0000-7000-8000-00000000d001",
    agentVersionId: HELPER_VERSION,
    slug: "helper",
    bundle: {
      definition: { ...owner.bundle.definition, canCommand: [], skills: [{ skill: SKILL.id }] },
      workflows: [],
    },
  };
  const deps = {
    catalog: { get: (id: string) => (id === SKILL.id ? SKILL : undefined) },
    ports: {
      store: {
        loadAgentVersion: async (_t: string, versionId: string) => {
          loaded.push(versionId);
          return versionId === HELPER_VERSION ? helper : owner;
        },
        run: async () => null,
      },
      log: {
        finishStepRun: async () => undefined,
        startStepRun: async () => "sr-x",
      },
    },
  } as unknown as RuntimeDeps;
  return { deps, loaded, owner };
}

describe("CONS: a skill step's agent", () => {
  it("CONS-1: a step the validator accepts with `agent: helper` runs as the helper, not as the owner", async () => {
    const t = setUp();
    // What the builder and publish check: the owner may ask `helper`, so the step is valid even
    // though the owner has no such skill (skill_not_allowed is skipped when `agent` is set).
    const v = processes.validateProcess(PROCESS, {
      skills: { [SKILL.id]: SKILL },
      agent: t.owner.bundle.definition as never,
    });
    expect(v.errors).toEqual([]);

    // The real executor over the real agent port (apps/api/src/runs/ports.ts runSkill).
    const h = new Harness();
    const result = await executeWorkflow(
      cloudflareStepRunner(new FakeWorkflowStep()),
      h.context({ agent: agentPort(t.deps) }),
      PROCESS,
      {},
    );
    expect({
      status: result.status,
      reason: "reason" in result ? result.reason : undefined,
      ranAs: t.loaded,
    }).toEqual({ status: "succeeded", reason: undefined, ranAs: [HELPER_VERSION] });
  });
});
