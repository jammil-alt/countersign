// The client page's Agents › Sandbox (docs/plan.md §1.243): today's use, why Send to me is the
// client's in a real client, every sandbox run from both sides, and a run started from the back
// office as a test run marked sandbox; then the run's page with what it would do, the email's
// Send to me off with the server's reason.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import {
  AGENT_DETAIL,
  AGENT_SUMMARY,
  fakeApi,
  OPERATOR_SESSION,
  SANDBOX_DETAIL,
  versionId,
} from "../../test/fixtures";
import { SANDBOX_EMAIL, SANDBOX_RUN, sandboxRun } from "../../test/sandbox";
import { clientPageOf } from "./ClientFrame";
import { sandboxAgents } from "./ClientSandbox";

const SLOW = 20_000;
const CLIENT = SANDBOX_DETAIL.client.id;
const AGENT = AGENT_SUMMARY.id;
const NEW_RUN = "00000000-0000-4000-8000-0000000e5009";

const LIST = {
  runs: [
    {
      runId: SANDBOX_RUN,
      agentId: AGENT,
      agentName: "Material costs",
      title: "Send an order",
      status: "done" as const,
      startedAt: "2026-11-24T10:00:00.000Z",
      side: "portal" as const,
      byName: "Dana Reyes",
      changes: 3,
      messages: 2,
    },
  ],
  use: { runs: 3, maxRuns: 20, sends: 0, maxSends: 20 },
  canSend: false,
};

function setup(path: string) {
  const sent: unknown[] = [];
  const opsRun = sandboxRun({ side: "ops", byName: "Operator" });
  const email = opsRun.changes.find((c) => c.id === SANDBOX_EMAIL);
  if (email) {
    email.send = {
      channel: "email",
      to: null,
      can: false,
      reason: "In a real client only the client's own people send from its tools.",
    };
  }
  const api = fakeApi({
    "GET /api/session": () => OPERATOR_SESSION,
    [`GET /api/ops/clients/${CLIENT}`]: () => SANDBOX_DETAIL,
    "GET /api/ops/clients": () => ({ clients: [] }),
    [`GET /api/ops/clients/${CLIENT}/sandbox`]: () => LIST,
    [`GET /api/ops/agents/${AGENT}`]: () => AGENT_DETAIL,
    [`POST /api/ops/agents/${AGENT}/versions/${versionId(1)}/test-run`]: ({ init }) => {
      sent.push(JSON.parse(String(init.body)));
      return { runId: NEW_RUN, agentId: AGENT, versionId: versionId(1) };
    },
    [`GET /api/ops/clients/${CLIENT}/sandbox/runs/${NEW_RUN}`]: () => ({
      run: { ...opsRun, runId: NEW_RUN },
    }),
  });
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
  return { sent };
}

describe("the back office's sandbox", () => {
  it("is the Agents tab's second page", () => {
    expect(clientPageOf(`/ops/clients/${CLIENT}/sandbox`, CLIENT)).toEqual({
      tab: "agents",
      page: "sandbox",
    });
    expect(clientPageOf(`/ops/clients/${CLIENT}/sandbox/${SANDBOX_RUN}`, CLIENT)).toEqual({
      tab: "agents",
      page: "sandbox",
    });
    expect(
      sandboxAgents([
        AGENT_SUMMARY,
        { ...AGENT_SUMMARY, id: "t", testCopy: true },
        { ...AGENT_SUMMARY, id: "r", status: "retired" },
      ]).map((a) => a.id),
    ).toEqual([AGENT]);
  });

  it(
    "lists the runs and today's use, starts a sandbox run, and opens it",
    async () => {
      const { sent } = setup(`/ops/clients/${CLIENT}/sandbox`);
      expect(await screen.findByTestId("ops-sandbox-use")).toHaveTextContent("3 of 20 runs today");
      expect(screen.getByTestId("ops-sandbox-no-send")).toHaveTextContent(
        "Only the client's own people can send from its tools",
      );
      const pages = screen.getByTestId("ops-client-agents-pages");
      expect(within(pages).getByRole("link", { name: "Sandbox" })).toHaveAttribute(
        "aria-current",
        "page",
      );
      const row = screen.getByTestId(`ops-sandbox-run-${SANDBOX_RUN}`);
      expect(row).toHaveTextContent("Dana Reyes · Portal");
      expect(row).toHaveTextContent("3 changes · 2 messages");
      expect(within(row).getByRole("link", { name: "Send an order" })).toHaveAttribute(
        "href",
        `/ops/clients/${CLIENT}/sandbox/${SANDBOX_RUN}`,
      );

      // The live version's workflow, with a hand-typed input.
      const form = await screen.findByTestId("ops-sandbox-form");
      expect(within(form).getByTestId("ops-sandbox-workflow")).toHaveValue("new-bill");
      await userEvent.type(within(form).getByTestId("ops-sandbox-payload"), '{{"note": "rush"}');
      await userEvent.click(within(form).getByTestId("ops-sandbox-start-button"));
      await waitFor(() =>
        expect(sent).toEqual([{ workflow: "new-bill", payload: { note: "rush" }, sandbox: true }]),
      );

      // The run's page: what it would do; the email can't be sent from here, and says why.
      expect(await screen.findByTestId("ops-sandbox-run")).toBeInTheDocument();
      expect(await screen.findByTestId("sandbox-run-not-written")).toHaveTextContent(
        "Nothing was written to the client's tools",
      );
      const card = screen.getByTestId(`sandbox-change-${SANDBOX_EMAIL}`);
      expect(within(card).getByTestId(`sandbox-change-${SANDBOX_EMAIL}-send`)).toBeDisabled();
      expect(within(card).getByTestId(`sandbox-change-${SANDBOX_EMAIL}-reason`)).toHaveTextContent(
        "only the client's own people send",
      );
    },
    SLOW,
  );
});
