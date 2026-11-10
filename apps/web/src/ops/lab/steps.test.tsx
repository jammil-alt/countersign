// Wave 3b: the lab's workflow and the new-agent preview read a template's v4 version (a process:
// `triggers`, an `if`, a write) as they read a v3 workflow, instead of nothing.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FORK_BUNDLE, PROCESS_BUNDLE } from "../../test/fixtures";
import { StepList } from "../../ui/steps";
import { WorkflowPreview } from "../agents/NewAgentParts";
import { workflowStepItems } from "./steps";

describe("a template's workflow in the lab and the new-agent preview", () => {
  it("lists a process's first trigger and its steps, a write waiting for approval", () => {
    const process = PROCESS_BUNDLE.workflows[0]?.workflow;
    if (!process) throw new Error("no workflow");
    const items = workflowStepItems(process);
    expect(items.map((i) => i.key)).toEqual(["trigger", "find", "confidence", "update"]);
    render(<StepList steps={items} testId="lab-steps" />);
    const list = screen.getByTestId("lab-steps");
    expect(list).toHaveTextContent("Started by hand");
    expect(list).toHaveTextContent("If");
    expect(list).toHaveTextContent("Needs approval");
  });

  it("previews a process as it does a v3 workflow", () => {
    render(<WorkflowPreview bundle={PROCESS_BUNDLE} />);
    const preview = screen.getByTestId("new-agent-preview");
    expect(preview).toHaveTextContent("Starting workflow · 4 steps");
    expect(preview).toHaveTextContent("Started by hand");
    expect(preview).toHaveTextContent("Write");
    expect(preview).toHaveTextContent("Approval");
  });

  it("keeps a v3 workflow as it was", () => {
    const workflow = FORK_BUNDLE.workflows[0]?.workflow;
    if (!workflow) throw new Error("no workflow");
    expect(workflowStepItems(workflow).map((i) => i.key)).toEqual([
      "trigger",
      "find",
      "read",
      "confidence",
      "update",
    ]);
  });
});
