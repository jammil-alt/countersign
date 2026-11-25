// Check the skill (owner, 2026-11-24): what a draft gets, does and gives back, edited by hand and
// saved as one change; Try it on JSON or a file, blocked while changes are unsaved; a try kept as
// a test with what it gave back as the expected answer.
import type { SkillDefinition, SkillTryView } from "@countersign/core";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiProvider } from "../../api/useApi";
import { fakeApi } from "../../test/fixtures";
import { CheckSkill } from "./CheckSkill";

const SESSION = "01a20000-0000-7000-8000-00000000c0de";

const DEF: SkillDefinition = {
  schemaVersion: 1,
  id: "custom:filter-ucc-filings",
  name: "Filter UCC filings",
  description: "Keeps the filings that matter",
  category: "data",
  mode: "task",
  model: { id: "claude-haiku-5-5" },
  instructions: "Remove amendments.",
  tools: [],
  input: {
    type: "object",
    properties: { rows: { type: "array", items: { type: "object", properties: {} } } },
    required: ["rows"],
  },
  output: {
    type: "object",
    properties: {
      kept: {
        type: "array",
        items: { type: "object", properties: { buyer: { type: "string" } } },
      },
    },
  },
  settings: [],
  requiresConnectors: [],
  requiresPacks: [],
  producesAlerts: false,
};

const TRIED: SkillTryView = {
  status: "succeeded",
  input: { rows: [{ buyer: "Gulf Site Works" }] },
  from: null,
  output: { kept: [{ buyer: "Gulf Site Works" }] },
  error: null,
  costUsd: "0.001200",
  modelCalls: 1,
  toolCalls: [],
  keepable: true,
};

const at = "2026-11-24T00:00:00.000Z";
const turn = {
  id: "00000000-0000-4000-8000-0000000d0009",
  seq: 9,
  role: "operator",
  text: "Changed by hand.",
  command: "/edit",
  changes: [],
  questions: [],
  gaps: [],
  notes: [],
  errors: [],
  savedVersionId: null,
  costUsd: "0",
  undoneAt: null,
  createdAt: at,
};
/** The conversation as an edit answers it. */
const answered = () => ({
  session: {
    id: SESSION,
    kind: "skill",
    clientId: null,
    clientName: null,
    agentId: null,
    skillId: null,
    baseVersionId: null,
    status: "open",
    bundle: { definition: DEF, cases: [] },
    errors: [],
    closest: [],
    createdAt: at,
    updatedAt: at,
  },
  turns: [turn],
  turn,
});

function renderCheck(api: ReturnType<typeof fakeApi>, more: { sample?: File } = {}) {
  const onChanged = vi.fn();
  render(
    <ApiProvider client={api.client}>
      <CheckSkill
        sessionId={SESSION}
        definition={DEF}
        firstInput={{ rows: [{ buyer: "Gulf Site Works" }] }}
        onChanged={onChanged}
        {...more}
      />
    </ApiProvider>,
  );
  return { user: userEvent.setup(), onChanged };
}

describe("Check the skill", () => {
  it("edits what it gives back and what it does, and saves them as one change", async () => {
    const bodies: unknown[] = [];
    const api = fakeApi({
      [`POST /api/ops/builder/sessions/${SESSION}/skill`]: ({ init }) => {
        bodies.push(JSON.parse(String(init.body)));
        return answered();
      },
    });
    const { user, onChanged } = renderCheck(api);
    // The list of records shows its own fields.
    expect(screen.getByTestId("check-skill-output-1-0-name")).toHaveValue("buyer");
    expect(screen.queryByTestId("check-skill-save")).toBeNull();
    // A field added to each kept record, with a meaning; a rule added.
    await user.click(screen.getByTestId("check-skill-output-1-add"));
    await user.type(screen.getByTestId("check-skill-output-1-1-name"), "reason");
    await user.type(screen.getByTestId("check-skill-output-1-1-meaning"), "Why it stays");
    await user.type(screen.getByTestId("check-skill-instructions"), "\nRemove refinances.");
    // Unsaved: Try it waits for the save.
    expect(screen.getByTestId("try-skill-run")).toBeDisabled();
    expect(screen.getByTestId("try-skill-blocked")).toHaveTextContent("Save your changes first");
    await user.click(screen.getByTestId("check-skill-save"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(bodies).toEqual([
      {
        instructions: "Remove amendments.\nRemove refinances.",
        output: {
          type: "object",
          properties: {
            kept: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  buyer: { type: "string" },
                  reason: { type: "string", description: "Why it stays" },
                },
              },
            },
          },
        },
      },
    ]);
  });

  it("won't save a field with no name", async () => {
    const { user } = renderCheck(fakeApi({}));
    await user.click(screen.getByTestId("check-skill-input-0-add"));
    expect(screen.getByTestId("check-skill-problems")).toHaveTextContent(
      "A field in What it gets has no name.",
    );
    expect(screen.getByTestId("check-skill-save")).toBeDisabled();
    await user.click(screen.getByTestId("check-skill-reset"));
    expect(screen.queryByTestId("check-skill-unsaved")).toBeNull();
  });

  it("tries it on JSON, shows what it gave back, and keeps it as a test", async () => {
    const bodies: Record<string, unknown[]> = { try: [], keep: [] };
    const api = fakeApi({
      [`POST /api/ops/builder/sessions/${SESSION}/try`]: ({ init }) => {
        bodies.try?.push(JSON.parse(String(init.body)));
        return TRIED;
      },
      [`POST /api/ops/builder/sessions/${SESSION}/skill`]: ({ init }) => {
        bodies.keep?.push(JSON.parse(String(init.body)));
        return answered();
      },
    });
    const { user, onChanged } = renderCheck(api);
    // No sample handed over: it starts on JSON, from the first test's input.
    expect(screen.getByTestId("try-skill-json")).toHaveValue(
      JSON.stringify({ rows: [{ buyer: "Gulf Site Works" }] }, null, 2),
    );
    await user.click(screen.getByTestId("try-skill-run"));
    expect(await screen.findByTestId("try-skill-status")).toHaveTextContent("Done");
    expect(screen.getByTestId("try-skill-output")).toHaveTextContent('"buyer": "Gulf Site Works"');
    expect(screen.getByTestId("try-skill-result")).toHaveTextContent("On your JSON · 1 model call");
    expect(bodies.try).toEqual([{ input: { rows: [{ buyer: "Gulf Site Works" }] } }]);
    await user.clear(screen.getByTestId("try-skill-case-name"));
    await user.type(screen.getByTestId("try-skill-case-name"), "One filing kept");
    await user.click(screen.getByTestId("try-skill-keep"));
    expect(await screen.findByTestId("try-skill-kept")).toHaveTextContent("Kept as a test");
    expect(bodies.keep).toEqual([
      { addCase: { name: "One filing kept", input: TRIED.input, expected: TRIED.output } },
    ]);
    expect(onChanged).toHaveBeenCalled();
  });

  it("tries it on the sample handed over; a try on a document isn't kept", async () => {
    const bodies: unknown[] = [];
    const api = fakeApi({
      [`POST /api/ops/builder/sessions/${SESSION}/try`]: ({ init }) => {
        bodies.push(JSON.parse(String(init.body)));
        return { ...TRIED, from: "notice.pdf", input: { notice: "sample" }, keepable: false };
      },
    });
    const sample = new File(["%PDF"], "notice.pdf", { type: "application/pdf" });
    const { user } = renderCheck(api, { sample });
    expect(screen.getByTestId("try-skill-file-name")).toHaveTextContent("notice.pdf, your sample");
    await user.click(screen.getByTestId("try-skill-run"));
    expect(await screen.findByTestId("try-skill-result")).toHaveTextContent("On notice.pdf");
    expect(bodies).toEqual([
      { sample: { filename: "notice.pdf", mimeType: "application/pdf", base64: btoa("%PDF") } },
    ]);
    expect(screen.queryByTestId("try-skill-keep")).toBeNull();
    expect(screen.getByTestId("try-skill-result")).toHaveTextContent("can't be kept as a test");
  });
});
