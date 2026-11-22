// The inspector inside the one-screen builder's side panel (docs/builder-plan.md §12, F2): it leaves
// out what the panel shows (the heading, the name, connections, Delete) and folds the less used
// settings into "More settings"; without `layout` it renders as it always did.
import type { BuilderCatalog, ProcessAgentBundle, ToolSpec } from "@countersign/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { BuilderData } from "./catalog";
import { Inspector, type InspectorProps } from "./Inspector";
import type { Process } from "./model";
import { NO_PEOPLE } from "./people";

const find: ToolSpec = {
  id: "qbo.vendor.find",
  description: "Finds a vendor by name",
  input: { type: "object", properties: { name: { type: "string" } } },
  output: { type: "object" },
  sideEffect: "none",
  verb: "read",
  source: "qbo",
  connector: "qbo",
};

const workflow = {
  schemaVersion: 4,
  triggers: [{ id: "t", on: { type: "manual", input: { type: "object", properties: {} } } }],
  steps: [{ id: "s1", kind: "read", name: "Find the vendor", tool: find.id, input: {} }],
} as unknown as Process;

const bundle = {
  schemaVersion: 1,
  definition: { skills: [], extraTools: [] },
  workflows: [{ slug: "main", name: "Main", enabled: true, workflow }],
} as unknown as ProcessAgentBundle;

const data: BuilderData = {
  catalog: {
    skills: [],
    tools: [find],
    connectors: [{ id: "qbo", name: "QuickBooks" }],
    automations: [],
  } as unknown as BuilderCatalog,
  events: [],
};

function props(over: Partial<InspectorProps> = {}): InspectorProps {
  const ctx = { tools: { [find.id]: find } };
  return {
    workflow,
    bundle,
    selection: { type: "step", id: "s1" },
    data,
    ctx,
    env: {
      ctx,
      agentKind: "template",
      mode: "act",
      matrices: {},
      connectorName: (id) => (id === "qbo" ? "QuickBooks" : id),
    },
    errors: [],
    template: null,
    people: NO_PEOPLE,
    focus: null,
    onStep: vi.fn(),
    onTrigger: vi.fn(),
    onAddTrigger: vi.fn(),
    onRemoveTrigger: vi.fn(),
    onDelete: vi.fn(),
    ...over,
  };
}

describe("the inspector in the side panel", () => {
  it("renders as before without a layout", () => {
    render(<Inspector {...props()} />);
    expect(screen.getByTestId("builder-inspector-name")).toBeTruthy();
    expect(screen.getByTestId("builder-inspector-delete")).toBeTruthy();
    expect(screen.queryByTestId("builder-inspector-more")).toBeNull();
  });

  it("leaves out the heading, name and Delete, and folds the rest", () => {
    render(<Inspector {...props({ layout: "panel" })} />);
    expect(screen.queryByTestId("builder-inspector-name")).toBeNull();
    expect(screen.queryByTestId("builder-inspector-delete")).toBeNull();
    expect(screen.queryByText("Reads from a tool. It never changes anything.")).toBeNull();
    // The main field stays out of the fold. What the tool does is said once, in the panel's head
    // (owner, 2026-11-22), so the inspector doesn't repeat it here.
    expect(screen.getByText("Find vendor")).toBeTruthy();
    expect(screen.queryByText("Finds a vendor by name")).toBeNull();
    const more = screen.getByTestId("builder-inspector-more");
    expect(more).toHaveTextContent("More settings · all on their defaults");
    expect(more).not.toHaveAttribute("open");
    fireEvent.click(screen.getByText("More settings"));
    expect(more).toHaveAttribute("open");
  });

  it("says when a folded setting is changed, and opens for a focus request", () => {
    const shown = {
      ...workflow,
      steps: [{ ...workflow.steps[0], client: { visible: false } }],
    } as unknown as Process;
    render(
      <Inspector
        {...props({
          layout: "panel",
          workflow: shown,
          focus: { node: "s1", field: "client", nonce: 1 },
        })}
      />,
    );
    const more = screen.getByTestId("builder-inspector-more");
    expect(more).toHaveTextContent("some changed from their defaults");
    expect(more).toHaveAttribute("open");
  });

  it("leaves out a trigger's heading in the panel", () => {
    render(<Inspector {...props({ layout: "panel", selection: { type: "trigger", id: "t" } })} />);
    expect(screen.queryByText("How it starts")).toBeNull();
    expect(screen.getByTestId("builder-trigger-type")).toBeTruthy();
  });
});
