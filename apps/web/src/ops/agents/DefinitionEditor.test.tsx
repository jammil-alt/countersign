// The definition editor: field checks before anything is sent, skill settings from each skill's
// settings schema, the draft it saves (workflows untouched, parent = the version it was opened
// on), and the API's no-op answer.
import type { SkillOption } from "@countersign/core";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ApiProvider } from "../../api/useApi";
import { AGENT_DETAIL, AGENT_SUMMARY, FORK_BUNDLE, fakeApi, Reply } from "../../test/fixtures";
import { DefinitionEditor } from "./DefinitionEditor";

const SKILLS: SkillOption[] = [
  {
    id: "docs.extract",
    name: "Read a document",
    description: "Extracts lines from an invoice",
    category: "documents",
    source: "builtin",
    version: null,
    settings: [
      {
        key: "min_confidence",
        label: "Minimum confidence",
        type: "number",
        default: 0.8,
        clientSpecific: false,
      },
      {
        key: "mode",
        label: "Mode",
        type: "enum",
        default: "fast",
        options: ["fast", "careful"],
        clientSpecific: false,
      },
    ],
    requiresConnectors: [],
  },
  {
    id: "docs.find-support",
    name: "Find supporting document",
    description: "Finds the invoice for a bill",
    category: "documents",
    source: "builtin",
    version: null,
    settings: [],
    requiresConnectors: [],
  },
  {
    id: "custom:price-watch",
    name: "Price watch",
    description: "Flags price changes",
    category: "custom",
    source: "shared",
    version: 2,
    settings: [
      {
        key: "vendors",
        label: "Vendors",
        type: "string",
        default: "",
        clientSpecific: true,
      },
    ],
    requiresConnectors: [],
  },
];

const AGENT_PATH = `/api/ops/agents/${AGENT_SUMMARY.id}/versions`;

function setup(reply: (body: Record<string, unknown>) => unknown = () => saved()) {
  const sent: Record<string, unknown>[] = [];
  const api = fakeApi({
    [`POST ${AGENT_PATH}`]: ({ init }) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      sent.push(body);
      return reply(body);
    },
  });
  const onSaved = vi.fn();
  const onNoChange = vi.fn();
  render(
    <MemoryRouter>
      <ApiProvider client={api.client}>
        <DefinitionEditor
          agent={AGENT_SUMMARY}
          from={AGENT_DETAIL.versions[0] as (typeof AGENT_DETAIL.versions)[number]}
          bundle={FORK_BUNDLE}
          skills={SKILLS}
          onSaved={onSaved}
          onNoChange={onNoChange}
        />
      </ApiProvider>
    </MemoryRouter>,
  );
  return { api, sent, onSaved, onNoChange, user: userEvent.setup() };
}

function saved(errors: unknown[] = []) {
  return {
    version: {
      ...AGENT_DETAIL.versions[0],
      id: "00000000-0000-4000-8000-0000000e0003",
      version: 3,
    },
    errors,
  };
}

describe("DefinitionEditor", () => {
  it("shows the definition and each skill's settings from its schema", () => {
    setup();
    expect(screen.getByTestId("agent-editor-name-input")).toHaveValue("Material costs");
    expect(screen.getByTestId("agent-editor-model-select")).toHaveValue("claude-opus-5-5");
    const extract = screen.getByTestId("agent-editor-skill-docs.extract");
    expect(within(extract).getByText("Read a document")).toBeInTheDocument();
    expect(
      screen.getByTestId("agent-editor-setting-docs.extract-min_confidence-input"),
    ).toHaveAttribute("placeholder", "0.8");
    expect(screen.getByTestId("agent-editor-setting-docs.extract-mode-select")).toHaveValue("");
    // Approval is per step and on by default: the rule is shown with the mode.
    expect(screen.getByTestId("agent-editor-approval-rule")).toHaveTextContent(
      /Delete is never automatic/,
    );
  });

  it("refuses to save with invalid fields and says which, without calling the API", async () => {
    const { user, sent } = setup();
    await user.clear(screen.getByTestId("agent-editor-name-input"));
    await user.clear(screen.getByTestId("agent-editor-max-cost-input"));
    await user.type(screen.getByTestId("agent-editor-max-cost-input"), "lots");
    await user.type(
      screen.getByTestId("agent-editor-setting-docs.extract-min_confidence-input"),
      "high",
    );
    await user.selectOptions(
      screen.getByTestId("agent-editor-setting-docs.extract-mode-select"),
      "careful",
    );
    await user.click(screen.getByTestId("agent-editor-save"));

    expect(screen.getByTestId("agent-editor-invalid")).toBeInTheDocument();
    expect(screen.getByTestId("agent-editor-name-error")).toHaveTextContent(
      "Give the agent a name.",
    );
    expect(screen.getByTestId("agent-editor-max-cost-error")).toHaveTextContent(
      /amount in dollars/,
    );
    expect(
      screen.getByTestId("agent-editor-setting-docs.extract-min_confidence-error"),
    ).toHaveTextContent("Minimum confidence must be a number.");
    expect(screen.getByTestId("agent-editor-save")).toBeDisabled();
    expect(sent).toEqual([]);

    // Fixing them enables saving again.
    await user.type(screen.getByTestId("agent-editor-name-input"), "Material costs");
    await user.clear(screen.getByTestId("agent-editor-max-cost-input"));
    await user.type(screen.getByTestId("agent-editor-max-cost-input"), "0.75");
    await user.clear(screen.getByTestId("agent-editor-setting-docs.extract-min_confidence-input"));
    await user.type(
      screen.getByTestId("agent-editor-setting-docs.extract-min_confidence-input"),
      "0.9",
    );
    expect(screen.queryByTestId("agent-editor-invalid")).not.toBeInTheDocument();
    expect(screen.getByTestId("agent-editor-save")).toBeEnabled();
  });

  it("saves a draft from the version it was opened on, with typed settings and workflows untouched", async () => {
    const { user, sent, onSaved } = setup();
    await user.clear(screen.getByTestId("agent-editor-instructions-input"));
    await user.type(screen.getByTestId("agent-editor-instructions-input"), "Itemize every bill.");
    await user.type(
      screen.getByTestId("agent-editor-setting-docs.extract-min_confidence-input"),
      "0.95",
    );
    await user.click(screen.getByTestId("agent-editor-skill-docs.find-support-remove"));
    await user.selectOptions(
      screen.getByTestId("agent-editor-skill-add-select"),
      "custom:price-watch",
    );
    await user.click(screen.getByTestId("agent-editor-skill-add"));
    expect(screen.getByTestId("agent-editor-skill-custom:price-watch")).toHaveTextContent(
      "this client's",
    );
    await user.click(screen.getByTestId("agent-editor-mode-act"));
    await user.selectOptions(screen.getByTestId("agent-editor-approver-select"), "operator");
    await user.type(screen.getByTestId("agent-editor-change-note-input"), "Stricter reading");
    await user.click(screen.getByTestId("agent-editor-save"));

    expect(sent).toHaveLength(1);
    const body = sent[0] as {
      bundle: typeof FORK_BUNDLE;
      parentVersionId: string;
      changeNote: string;
      releaseNote?: string;
    };
    expect(body.parentVersionId).toBe(AGENT_DETAIL.versions[0]?.id);
    expect(body.changeNote).toBe("Stricter reading");
    // A client agent has no release note.
    expect(body.releaseNote).toBeUndefined();
    expect(body.bundle.definition.instructions).toBe("Itemize every bill.");
    expect(body.bundle.definition.skills).toEqual([
      { skill: "docs.extract", settings: { min_confidence: 0.95 } },
      { skill: "custom:price-watch", settings: {} },
    ]);
    expect(body.bundle.definition.permissions).toEqual({ mode: "act", approver: "operator" });
    expect(body.bundle.workflows).toEqual(FORK_BUNDLE.workflows);
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ errors: [] }));
  });

  it("reports the API's no-op answer instead of an error", async () => {
    const { user, onNoChange, onSaved } = setup(
      () =>
        new Reply(409, {
          error: { code: "no_op", message: "nothing changed since the version it was edited from" },
        }),
    );
    await user.click(screen.getByTestId("agent-editor-save"));
    expect(onNoChange).toHaveBeenCalledTimes(1);
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.queryByTestId("agent-editor-save-error")).not.toBeInTheDocument();
  });

  it("shows any other refusal", async () => {
    const { user } = setup(
      () => new Reply(422, { error: { code: "invalid_bundle", message: "the bundle is broken" } }),
    );
    await user.click(screen.getByTestId("agent-editor-save"));
    expect(await screen.findByTestId("agent-editor-save-error")).toHaveTextContent(
      "the bundle is broken",
    );
  });

  it("marks a skill this agent can't use", () => {
    const api = fakeApi({});
    render(
      <MemoryRouter>
        <ApiProvider client={api.client}>
          <DefinitionEditor
            agent={AGENT_SUMMARY}
            from={AGENT_DETAIL.versions[0] as (typeof AGENT_DETAIL.versions)[number]}
            bundle={FORK_BUNDLE}
            skills={SKILLS.filter((s) => s.id !== "docs.find-support")}
            onSaved={() => {}}
            onNoChange={() => {}}
          />
        </ApiProvider>
      </MemoryRouter>,
    );
    expect(screen.getByTestId("agent-editor-skill-docs.find-support-missing")).toBeInTheDocument();
  });
});
