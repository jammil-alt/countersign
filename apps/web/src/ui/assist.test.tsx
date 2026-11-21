// Draft (docs/plan.md §1.166) on a long text field: the button opens a sheet for notes; Write it
// sends the field's id, the notes, what the field holds and the page's records by id; the draft
// shows as a suggestion, and only Use it puts it in the field (through the screen's own onChange).
// Cancel leaves the field as it was; Try again asks again; a refusal is said in the sheet.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { ApiProvider } from "../api/useApi";
import { fakeApi, Reply } from "../test/fixtures";
import { AssistScope, type AssistSpec } from "./assist-scope";
import { Field, TextArea, TextInput } from "./forms";

const BUILD = "0190a0b0-0000-7000-8000-000000000001";
const PATH = "POST /api/ops/assist/draft";

function Form({ assist, input }: { assist: AssistSpec; input?: boolean }) {
  const [text, setText] = useState("Old goal");
  return (
    <AssistScope value={{ buildId: BUILD }}>
      <Field label="Goal">
        {input ? (
          <TextInput
            value={text}
            onChange={(e) => setText(e.target.value)}
            data-testid="goal"
            assist={assist}
          />
        ) : (
          <TextArea
            value={text}
            onChange={(e) => setText(e.target.value)}
            data-testid="goal"
            assist={assist}
          />
        )}
      </Field>
      <output data-testid="saved">{text}</output>
    </AssistScope>
  );
}

function setup(
  answers: unknown[],
  props: Parameters<typeof Form>[0] = { assist: "build.brief.goal" },
) {
  const bodies: unknown[] = [];
  const api = fakeApi({
    [PATH]: ({ init }) => {
      bodies.push(JSON.parse(String(init.body)));
      return answers.shift();
    },
  });
  render(
    <ApiProvider client={api.client}>
      <Form {...props} />
    </ApiProvider>,
  );
  return { bodies, api };
}

describe("Draft", () => {
  it("is off unless a field turns it on", () => {
    render(<TextArea value="" onChange={() => {}} data-testid="plain" />);
    expect(screen.queryByText("Draft")).toBeNull();
  });

  it("drafts from notes, and Use it fills the field", async () => {
    const u = userEvent.setup();
    const { bodies } = setup([{ text: "Match each invoice to its PO." }]);
    await u.click(await screen.findByTestId("goal-draft"));
    const sheet = await screen.findByTestId("goal-draft-sheet");
    expect(sheet).toHaveTextContent("Goal (the brief)");
    // Nothing to write from yet but the field's own text: Write it improves it.
    expect(screen.getByTestId("goal-draft-write")).toBeEnabled();
    await u.type(screen.getByTestId("goal-draft-notes"), "match invoices to POs");
    await u.click(screen.getByTestId("goal-draft-write"));
    expect(await screen.findByTestId("goal-draft-suggestion")).toHaveTextContent(
      "Match each invoice to its PO.",
    );
    expect(bodies).toEqual([
      {
        field: "build.brief.goal",
        notes: "match invoices to POs",
        current: "Old goal",
        context: { buildId: BUILD },
      },
    ]);
    // A suggestion only: the field is unchanged until Use it.
    expect(screen.getByTestId("saved")).toHaveTextContent("Old goal");
    await u.click(screen.getByTestId("goal-draft-use"));
    expect(screen.queryByTestId("goal-draft-sheet")).toBeNull();
    expect(screen.getByTestId("goal")).toHaveValue("Match each invoice to its PO.");
    expect(screen.getByTestId("saved")).toHaveTextContent("Match each invoice to its PO.");
  });

  it("leaves the field as it was on Cancel, after a draft too", async () => {
    const u = userEvent.setup();
    setup([{ text: "Something else." }]);
    await u.click(await screen.findByTestId("goal-draft"));
    await u.type(await screen.findByTestId("goal-draft-notes"), "notes");
    await u.click(screen.getByTestId("goal-draft-write"));
    await screen.findByTestId("goal-draft-suggestion");
    await u.click(screen.getByTestId("goal-draft-cancel"));
    expect(screen.queryByTestId("goal-draft-sheet")).toBeNull();
    expect(screen.getByTestId("goal")).toHaveValue("Old goal");
    expect(screen.getByTestId("saved")).toHaveTextContent("Old goal");
  });

  it("asks again on Try again, with the field's ref beside the page's records", async () => {
    const u = userEvent.setup();
    const { bodies } = setup([{ text: "First." }, { text: "Second." }], {
      assist: { field: "build.setup.hint", ref: "setup:vendor-list" },
      input: true,
    });
    await u.click(await screen.findByTestId("goal-draft"));
    await u.type(await screen.findByTestId("goal-draft-notes"), "why we need the list");
    await u.click(screen.getByTestId("goal-draft-write"));
    expect(await screen.findByTestId("goal-draft-suggestion")).toHaveTextContent("First.");
    await u.click(screen.getByTestId("goal-draft-again"));
    await waitFor(() =>
      expect(screen.getByTestId("goal-draft-suggestion")).toHaveTextContent("Second."),
    );
    expect(bodies).toHaveLength(2);
    expect((bodies[1] as { context: unknown }).context).toEqual({
      buildId: BUILD,
      ref: "setup:vendor-list",
    });
    await u.click(screen.getByTestId("goal-draft-use"));
    expect(screen.getByTestId("goal")).toHaveValue("Second.");
  });

  it("says why when the API refuses, and changes nothing", async () => {
    const u = userEvent.setup();
    setup([
      new Reply(409, {
        error: {
          code: "hipaa",
          message:
            "Draft sends data to Anthropic, which has no signed BAA; this client is in HIPAA mode",
        },
      }),
    ]);
    await u.click(await screen.findByTestId("goal-draft"));
    await u.type(await screen.findByTestId("goal-draft-notes"), "x");
    await u.click(screen.getByTestId("goal-draft-write"));
    expect(await screen.findByText(/HIPAA mode/)).toBeInTheDocument();
    expect(screen.queryByTestId("goal-draft-use")).toBeNull();
    expect(screen.getByTestId("saved")).toHaveTextContent("Old goal");
  });
});
