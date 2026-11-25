import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SuggestButton } from "./SuggestButton";
import type { Step } from "./types";

const step = { kind: "do", id: "s1", name: "Read it", input: {} } as Step;

describe("Suggest", () => {
  it("offers the three choices and applies the answer at once, with Undo", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    const suggest = vi.fn(async () => ({
      step: { ...step, name: "Read the invoice" } as Step,
      summary: "Named it from the document.",
      applied: true,
    }));
    render(
      <SuggestButton step={step} field="goal" label="Goal" suggest={suggest} onApply={onApply} />,
    );
    await user.click(screen.getByRole("button", { name: "Suggest for Goal" }));
    expect(screen.getByText("Tell it what you need")).toBeTruthy();
    expect(screen.getByText("Use the default")).toBeTruthy();
    await user.click(screen.getByText("Use the default"));
    await waitFor(() =>
      expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ name: "Read the invoice" })),
    );
    expect(suggest).toHaveBeenCalledWith({ step, field: "goal", how: "default" });
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(onApply).toHaveBeenLastCalledWith(step);
  });

  it("sends what the person says, and says so when nothing was changed", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    const suggest = vi.fn(async () => ({
      step,
      summary: "Suggest isn't switched on yet.",
      applied: false,
    }));
    render(<SuggestButton step={step} label="this step" suggest={suggest} onApply={onApply} />);
    await user.click(screen.getByRole("button", { name: "Suggest for this step" }));
    await user.click(screen.getByText("Tell it what you need"));
    await user.type(screen.getByRole("textbox"), "only lines over $500");
    await user.click(screen.getByRole("button", { name: "Suggest" }));
    await screen.findByText("Suggest isn't switched on yet.");
    expect(suggest).toHaveBeenCalledWith({
      step,
      field: undefined,
      how: "tell",
      text: "only lines over $500",
    });
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });
});
