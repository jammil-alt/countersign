// What the model gets, on a skill step's setup (docs/plan.md §1.180): asked with the draft as
// drawn, shown part by part with where each part comes from, the tools, and the agent's notes.
import type { processes, StepPromptPreview } from "@countersign/core";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ApiProvider } from "../../api/useApi";
import { fakeApi } from "../../test/fixtures";
import { PromptPreview } from "./prompt-preview";

const AGENT = "00000000-0000-4000-8000-00000000a001";
const WORKFLOW = { schemaVersion: 4, triggers: [], steps: [] } as unknown as processes.Process;
const DEFINITION = { identity: { name: "Clerk" } };

const AGENT_MODE: StepPromptPreview = {
  runs: "model",
  skill: { ref: "custom:fix", name: "Fix an amount", mode: "agent" },
  model: { id: "claude-sonnet-5-5", maxTokens: 1024 },
  system: [
    { key: "governance", text: "The ground rules." },
    { key: "finish", text: "When you are done, call the `finish` tool exactly once." },
    { key: "identity", text: "## Who you are\nClerk: purchasing clerk." },
    { key: "agent_instructions", text: "## How you work\nWork carefully." },
    { key: "task", text: "## This task: Fix an amount\nDo the task.\n\nRound to cents." },
  ],
  governance: [
    { tier: "guardrails", source: "mezonas", id: "g", version: "1" },
    { tier: "charter", source: "client", id: "c", version: "4" },
    { tier: "policy", source: "mezonas", id: "p1", version: "1" },
    { tier: "policy", source: "client", id: "p2", version: "2" },
  ],
  tools: [
    { id: "testkit.update", name: "testkit__update", description: "Update a record" },
    { id: "finish", name: "finish", description: "Finish with the result" },
  ],
  turn: "Read the task input with `read_task_input`, then do the task.",
  data: {
    keys: ["input", "memory"],
    memory: { enabled: true, given: true, notes: ["Acme bills in euros."] },
  },
  problems: [],
};

function setup(answer: StepPromptPreview) {
  const bodies: unknown[] = [];
  const api = fakeApi({
    [`POST /api/ops/agents/${AGENT}/prompt-preview`]: ({ init }) => {
      bodies.push(JSON.parse(String(init.body)));
      return answer;
    },
  });
  render(
    <ApiProvider client={api.client}>
      <PromptPreview
        agentId={AGENT}
        workflow={WORKFLOW}
        definition={DEFINITION}
        step={{ id: "fix" }}
      />
    </ApiProvider>,
  );
  return { bodies, user: userEvent.setup() };
}

describe("what the model gets", () => {
  it("asks with the draft as drawn and shows the prompt part by part, the tools and the notes", async () => {
    const { bodies, user } = setup(AGENT_MODE);
    // Nothing is asked until the operator wants to see it.
    expect(screen.queryByTestId("builder-prompt-preview-system")).toBeNull();
    await user.click(screen.getByTestId("builder-prompt-preview-show"));
    await screen.findByTestId("builder-prompt-preview-system");
    expect(bodies).toEqual([{ process: WORKFLOW, stepId: "fix", definition: DEFINITION }]);

    expect(screen.getByTestId("builder-prompt-preview-model")).toHaveTextContent(
      "Runs on claude-sonnet-5-5. It works as the agent",
    );
    const parts = [...screen.getByTestId("builder-prompt-preview-system").children].map((e) =>
      e.getAttribute("data-testid"),
    );
    expect(parts).toEqual([
      "builder-prompt-part-governance",
      "builder-prompt-part-finish",
      "builder-prompt-part-identity",
      "builder-prompt-part-agent_instructions",
      "builder-prompt-part-task",
    ]);
    // Each part says where it comes from; the ground rules say what they hold.
    expect(screen.getByTestId("builder-prompt-part-governance")).toHaveTextContent(
      "Read first on every step: our guardrails, the client's charter and 2 policies.",
    );
    const task = screen.getByTestId("builder-prompt-part-task");
    expect(task).toHaveAttribute("open");
    expect(task).toHaveTextContent("Round to cents.");
    expect(screen.getByTestId("builder-prompt-tools")).toHaveTextContent("Tools it may call (2)");
    expect(screen.getByTestId("builder-prompt-data-keys")).toHaveTextContent("input, memory");
    const data = screen.getByTestId("builder-prompt-data");
    expect(within(data).getByTestId("builder-prompt-memory")).toHaveTextContent(
      "The agent's notes for this client, newest first (1)",
    );
    expect(data).toHaveTextContent("Acme bills in euros.");
  });

  it("says why a task skill gets no notes, and what stops a step running as drawn", async () => {
    const { user } = setup({
      ...AGENT_MODE,
      skill: { ref: "custom:read", name: "Read the total", mode: "task" },
      system: [AGENT_MODE.system[0], AGENT_MODE.system[4]] as StepPromptPreview["system"],
      data: { keys: ["input"], memory: { enabled: true, given: false, notes: [] } },
      problems: ["Vendor hint needs a value"],
    });
    await user.click(screen.getByTestId("builder-prompt-preview-show"));
    expect(await screen.findByTestId("builder-prompt-preview-model")).toHaveTextContent(
      "A task skill is the same job in any agent",
    );
    expect(screen.getByTestId("builder-prompt-memory")).toHaveTextContent(
      "No notes: a task skill is not handed the agent's notes.",
    );
    expect(screen.getByTestId("builder-prompt-preview-problems")).toHaveTextContent(
      "It can't run as drawn: Vendor hint needs a value",
    );
  });

  it("says a step no model does has no prompt", async () => {
    const { user } = setup({
      ...AGENT_MODE,
      runs: "rules",
      model: null,
      system: [],
      tools: [],
      turn: "",
      data: { keys: [], memory: { enabled: false, given: false, notes: [] } },
    });
    await user.click(screen.getByTestId("builder-prompt-preview-show"));
    expect(await screen.findByTestId("builder-prompt-preview-none")).toHaveTextContent(
      "it runs its rule rows, so there is no prompt",
    );
    expect(screen.queryByTestId("builder-prompt-preview-copy")).toBeNull();
  });
});
