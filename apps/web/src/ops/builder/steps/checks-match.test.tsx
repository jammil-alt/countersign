import { steps } from "@countersign/core";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChecksSection } from "./ChecksSection";
import type { StepFormEnv } from "./form-kit";
import { MatchSection } from "./MatchSection";
import { indexCatalog, NO_USES_CONTEXT } from "./options";
import type { DoStep, Step } from "./types";

const profile = (types: ("exact" | "semantic" | "hybrid")[]) =>
  steps.MatchProfile.parse({
    id: "vendors",
    name: "Vendors",
    area: "shared",
    record: "vendor",
    source: { kind: "table" },
    input: [
      { name: "name", type: "text", required: true },
      { name: "taxId", type: "text", required: false },
    ],
    keys: [
      { id: "tax", name: "Tax id", field: "taxId" },
      { id: "name", name: "Name", field: "name" },
    ],
    semantic: types.some((t) => t !== "exact") ? { text: ["name"] } : undefined,
    types,
    neverSame: [{ id: "tax", words: "Two different tax ids" }],
  });
const items = profile(["exact"]);
const both = { ...profile(["exact", "semantic", "hybrid"]), id: "customers", name: "Customers" };

const arg = <T,>(fn: ReturnType<typeof vi.fn>, i: number): T =>
  (fn.mock.calls[i] as unknown[])[0] as T;

const env = (): StepFormEnv => ({
  workflow: { schemaVersion: 5, triggers: [], outputs: [], steps: [] } as never,
  uses: {
    ...NO_USES_CONTEXT,
    profiles: [items, both],
    actions: indexCatalog([
      {
        type: "connector",
        id: "qbo",
        name: "QuickBooks",
        actions: [
          {
            id: "qbo.bill.create",
            label: "Create bill",
            description: "",
            kind: "change",
            input: [],
            output: [],
          },
          {
            id: "qbo.vendor.query",
            label: "Find vendors",
            description: "",
            kind: "get",
            input: [],
            output: [],
          },
        ],
      },
    ]),
  },
  trigger: [],
  people: { members: [], people: [] },
  suggest: vi.fn(),
  models: [],
});
const doStep = (extra: object): Step =>
  ({ kind: "do", id: "s", name: "x", input: {}, doneBy: "rules", ...extra }) as Step;

describe("Checks", () => {
  it("shows the approver on and locked for a Change, and never loosens it", async () => {
    const onChange = vi.fn();
    const step = doStep({ uses: { type: "action", action: "qbo.bill.create" } });
    render(<ChecksSection step={step} env={env()} issues={[]} onChange={onChange} />);
    const box = within(screen.getByTestId("check-approver")).getByRole(
      "checkbox",
    ) as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Add an approver" }));
    const next = onChange.mock.calls[0]?.[0] as Step;
    expect(next.checks?.approval?.required).toBe("required");
    expect(next.checks?.approval?.when).toBeUndefined();
  });

  it("shows no approver for a Get, and only Tell after for a Tell", () => {
    const get = doStep({ uses: { type: "action", action: "qbo.vendor.query" } });
    const { unmount } = render(
      <ChecksSection step={get} env={env()} issues={[]} onChange={vi.fn()} />,
    );
    expect(screen.queryByTestId("check-approver")).toBeNull();
    expect(screen.getByTestId("check-confer")).toBeTruthy();
    unmount();
    render(
      <ChecksSection
        step={doStep({ uses: { type: "tell" } })}
        env={env()}
        issues={[]}
        onChange={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("check-confer")).toBeNull();
    expect(screen.queryByTestId("check-review")).toBeNull();
    expect(screen.getByTestId("check-tell-after")).toBeTruthy();
  });

  it("adds a notice with Tell after, and sets Review", async () => {
    const onChange = vi.fn();
    const step = doStep({});
    render(<ChecksSection step={step} env={env()} issues={[]} onChange={onChange} />);
    await userEvent.click(within(screen.getByTestId("check-tell-after")).getByRole("checkbox"));
    const first = arg<Step>(onChange, 0);
    expect(first.checks?.notify).toHaveLength(1);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Review" }), "always");
    expect(arg<Step>(onChange, 1).review).toBe("always");
  });

  it("offers nothing for an automation", () => {
    const { container } = render(
      <ChecksSection
        step={doStep({ doneBy: undefined, uses: { type: "automation", automation: "a" } })}
        env={env()}
        issues={[]}
        onChange={vi.fn()}
      />,
    );
    expect(container.textContent).toBe("");
  });
});

const matchStep = (id: string, extra: object = {}): DoStep =>
  doStep({
    uses: {
      type: "match",
      match: steps.MatchSettings.parse({
        to: id,
        type: id === "vendors" ? "exact" : "hybrid",
        ...extra,
      }),
    },
  }) as DoStep;

describe("Match settings", () => {
  it("enables only the types the profile allows, and hides semantic settings for exact", () => {
    render(<MatchSection step={matchStep("vendors")} env={env()} issues={[]} onChange={vi.fn()} />);
    const type = screen.getByRole("combobox", { name: "Match type" });
    expect((within(type).getByText("Semantic match") as HTMLOptionElement).disabled).toBe(true);
    expect(screen.queryByLabelText("Confidence threshold")).toBeNull();
    expect(screen.getByText("Two different tax ids", { exact: false })).toBeTruthy();
  });

  it("resets keys and clamps the type when the profile changes", async () => {
    const onChange = vi.fn();
    const step = matchStep("customers", { keys: ["name"] });
    render(<MatchSection step={step} env={env()} issues={[]} onChange={onChange} />);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Match to" }), "vendors");
    const uses = arg<DoStep>(onChange, 0).uses;
    if (uses?.type !== "match") throw new Error("match");
    expect(uses.match).toMatchObject({ to: "vendors", type: "exact" });
    expect(uses.match.keys).toBeUndefined();
  });

  it("says when the second opinion doesn't sit below the threshold", () => {
    const step = matchStep("customers", { secondOpinion: { from: 95, by: "ai" } });
    render(<MatchSection step={step} env={env()} issues={[]} onChange={vi.fn()} />);
    expect(screen.getByTestId("match-problems").textContent).toContain(
      "below the confidence threshold",
    );
  });

  it("takes a whole percent only", async () => {
    const onChange = vi.fn();
    render(
      <MatchSection step={matchStep("customers")} env={env()} issues={[]} onChange={onChange} />,
    );
    const field = screen.getByLabelText("Confidence threshold");
    await userEvent.clear(field);
    await userEvent.type(field, "150");
    await userEvent.tab();
    expect(onChange).not.toHaveBeenCalled();
    await userEvent.clear(field);
    await userEvent.type(field, "85");
    await userEvent.tab();
    expect(onChange).toHaveBeenCalled();
  });
});
