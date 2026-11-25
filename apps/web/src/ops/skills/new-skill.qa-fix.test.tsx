// New skill keeps the first words and says why when the Builder's first draft fails (FLOW-4,
// BUILDER_QA.md, the flow lens of 2026-11-19; on Describe the skill since 2026-11-24).
import type { BuildDetail } from "@countersign/core";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { fakeApi, OPERATOR_SESSION, Reply } from "../../test/fixtures";
import { BUILD_ID, buildDetail } from "../flow/checkFixtures";

await import("../OpsApp");

const SESSION_ID = "00000000-0000-4000-8000-00000000a301";
const at = "2026-11-06T00:00:00.000Z";

const session = {
  id: SESSION_ID,
  kind: "skill",
  clientId: null,
  clientName: null,
  agentId: null,
  skillId: null,
  baseVersionId: null,
  status: "open",
  bundle: { definition: null, cases: [] },
  errors: [],
  closest: [],
  createdAt: at,
  updatedAt: at,
};

const turn = {
  id: "00000000-0000-4000-8000-00000000a402",
  seq: 2,
  role: "builder",
  text: "Here is a first draft.",
  command: null,
  changes: [],
  questions: [],
  gaps: [],
  notes: [],
  errors: [],
  savedVersionId: null,
  costUsd: "0.01",
  undoneAt: null,
  createdAt: at,
};

function Probe() {
  const loc = useLocation();
  return <span data-testid="location">{`${loc.pathname}${loc.search}`}</span>;
}

function renderAt(path: string, routes: Parameters<typeof fakeApi>[0]) {
  const api = fakeApi({ "GET /api/session": () => OPERATOR_SESSION, ...routes });
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
        <Probe />
      </AppProviders>
    </MemoryRouter>,
  );
  return { api, user: userEvent.setup() };
}

function skillBuild(drafted: boolean): BuildDetail {
  const d = buildDetail();
  return {
    ...d,
    build: { ...d.build, kind: "skill", phase: drafted ? "draft" : "intake" },
    draft: drafted
      ? {
          agentId: null,
          skillId: null,
          sessionId: SESSION_ID,
          versionId: null,
          version: null,
          live: false,
          problems: [],
          steps: [],
        }
      : null,
  };
}

describe("New skill's first message", () => {
  // FLOW-4: a failed first draft left an empty conversation, without the words or the error.
  // Describe the skill (owner, 2026-11-24) keeps the same promise: the words stay on the form with
  // the error, and drafting again drafts the same build.
  it("keeps the words and says the Builder failed when the first draft fails", async () => {
    const gets = "Card charges from the bank feed";
    const gives = "Each charge with the receipt it belongs to";
    let drafts = 0;
    const { api, user } = renderAt("/ops/skills/new", {
      "POST /api/ops/builds": () => skillBuild(false),
      [`POST /api/ops/builds/${BUILD_ID}/draft-now`]: () => {
        drafts += 1;
        if (drafts === 1) {
          return new Reply(502, {
            error: {
              code: "builder_unavailable",
              message: "The Builder can't reach its model right now.",
            },
          });
        }
        return skillBuild(true);
      },
      [`GET /api/ops/builder/sessions/${SESSION_ID}`]: () => ({ session, turns: [turn] }),
    });
    await user.type(await screen.findByTestId("skill-describe-name"), "Match card charges");
    await user.type(screen.getByTestId("skill-describe-gets"), gets);
    await user.type(screen.getByTestId("skill-describe-gives"), gives);
    await user.click(screen.getByTestId("skill-describe-draft"));
    await waitFor(() => expect(drafts).toBe(1));

    expect(
      await screen.findByText("The Builder can't reach its model right now.", { exact: false }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("location")).not.toHaveTextContent("session=");
    expect(screen.getByTestId("skill-describe-gets")).toHaveValue(gets);
    expect(screen.getByTestId("skill-describe-gives")).toHaveValue(gives);

    // Drafting again uses the build already started, then opens its conversation.
    await user.click(screen.getByTestId("skill-describe-draft"));
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(`session=${SESSION_ID}`),
    );
    expect(api.calls.filter((c) => c === "POST /api/ops/builds")).toHaveLength(1);
  });
});
