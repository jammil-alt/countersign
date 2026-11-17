// Autopilot in the back office (docs/plan.md §1.124.4; docs/design/pipelines.html `autopilot()`):
// each flow's stages and plays, every one at "Draft for me" to start; a locked play's Send is
// disabled with its lock line; setting a level calls the route; the always-yours list and targets.
import {
  ALWAYS_YOURS,
  ALWAYS_YOURS_SECRETS,
  AUTOPILOT_TARGETS,
  type AutopilotView,
  PLAY_FLOW_IDS,
  PLAY_FLOW_WORDS,
  PLAYS,
  type PlayView,
  playMaySend,
  playStages,
} from "@countersign/core";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../../App";
import { fakeApi, OPERATOR_SESSION } from "../../../test/fixtures";

const ZERO = { drafted: 0, sent: 0, edited: 0, done: 0, lastFive: 0, lastFiveUnchanged: 0 };

function view(): AutopilotView {
  return {
    flows: PLAY_FLOW_IDS.map((flow) => ({
      flow,
      name: PLAY_FLOW_WORDS[flow],
      stages: playStages(flow).map((s) => ({
        stage: s.id,
        name: s.name,
        plays: (PLAYS[flow][s.id] ?? []).map(
          (p): PlayView => ({
            flow,
            stage: s.id,
            key: p.key,
            name: p.name,
            when: p.when,
            does: p.does,
            internal: p.internal,
            locked: p.locked ?? null,
            level: "draft",
            maySend: playMaySend(p),
            track:
              p.key === "send_requirements"
                ? { ...ZERO, sent: 5, lastFive: 5, lastFiveUnchanged: 5 }
                : ZERO,
            trackLine:
              p.key === "send_requirements" ? "Sent 5 this month, 0 edited" : "No sends yet",
            ready: p.key === "send_requirements",
          }),
        ),
      })),
    })),
    alwaysYours: [...ALWAYS_YOURS],
    secrets: ALWAYS_YOURS_SECRETS,
    targets: [...AUTOPILOT_TARGETS],
  };
}

function renderAt(path: string, api: ReturnType<typeof fakeApi>) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
}

const common = {
  "GET /api/session": () => OPERATOR_SESSION,
  "GET /api/ops/counts": () => ({ needsUs: 0, clients: [] }),
  "GET /api/ops/clients": () => ({ clients: [] }),
  "GET /api/ops/autopilot": () => view(),
};

describe("Autopilot", () => {
  it("shows a flow's plays at draft, with locks, what is always yours and the targets", async () => {
    const api = fakeApi(common);
    renderAt("/ops/autopilot/issues", api);
    const fix = await screen.findByTestId("play-fix-fix_agent");
    expect(fix).toHaveTextContent("Fix the agent");
    expect(fix).toHaveTextContent("Changes to an agent are always yours");
    expect(within(fix).getByRole("button", { name: "Send, tell me" })).toBeDisabled();
    expect(within(fix).getByRole("button", { name: "Draft for me" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // An internal play reads Off, Suggest, On.
    const urgency = screen.getByTestId("play-reported-set_urgency");
    expect(within(urgency).getByRole("button", { name: "On" })).toBeEnabled();
    expect(within(urgency).getByRole("button", { name: "Suggest" })).toBeInTheDocument();
    expect(screen.getByTestId("autopilot-always-yours")).toHaveTextContent(
      "Releasing a safety hold, or rolling an agent back.",
    );
    expect(screen.getByTestId("autopilot-targets")).toHaveTextContent("Sends asThe client's lead");
    expect(screen.getByRole("link", { name: "Issues" })).toHaveAttribute("aria-current", "page");
  });

  it("sets a play's level, and offers to send once its record earns it", async () => {
    const api = fakeApi(common);
    let sent: unknown = null;
    api.on("PUT /api/ops/autopilot/issues/reported/tell_client", ({ init }) => {
      sent = JSON.parse(String(init.body));
      const v = view().flows[2]?.stages[0]?.plays[0] as PlayView;
      return { ...v, level: "send" };
    });
    renderAt("/ops/autopilot/issues", api);
    const tell = await screen.findByTestId("play-reported-tell_client");
    await userEvent.click(within(tell).getByRole("button", { name: "Send, tell me" }));
    expect(sent).toEqual({ level: "send" });
    expect(await within(tell).findByRole("button", { name: "Send, tell me" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    renderAt("/ops/autopilot/builds", api);
    const req = await screen.findByTestId("play-requirements-send_requirements");
    expect(req).toHaveTextContent("Ready to send on its own?");
    expect(within(req).getByRole("button", { name: "Let Reggie send these" })).toBeInTheDocument();
  });
});
