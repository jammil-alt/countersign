// The client agent page's loading (the owner's review: agent pages took 3+ seconds, then
// redirected): the frame shows at once, an agent handed over by the page before skips the lookup
// by slug, and `/ops/agents/:id` hands the agent it loaded to the page it sends you to.
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ApiProvider } from "../../api/useApi";
import { AGENT_DETAIL, AGENT_SUMMARY, fakeApi, SANDBOX_DETAIL } from "../../test/fixtures";
import { AgentPage } from "./AgentPage";
import { OpsAgentRedirect } from "./AgentRedirect";

const ID = AGENT_SUMMARY.id;
const CLIENT = AGENT_SUMMARY.tenantId;
const PATH = `/ops/clients/${CLIENT}/agents/${AGENT_SUMMARY.slug}`;

function setup(entry: string | { pathname: string; state: unknown }) {
  const api = fakeApi({
    [`GET /api/ops/clients/${CLIENT}`]: () => SANDBOX_DETAIL,
    [`GET /api/ops/clients/${CLIENT}/agents`]: () => ({ agents: [AGENT_SUMMARY] }),
    [`GET /api/ops/agents/${ID}`]: () => AGENT_DETAIL,
    [`GET /api/ops/agents/${ID}/skills`]: () => ({ skills: [] }),
  });
  render(
    <MemoryRouter initialEntries={[entry]}>
      <ApiProvider client={api.client}>
        <Routes>
          <Route path="/ops/agents/:id" element={<OpsAgentRedirect />} />
          <Route path="/ops/clients/:clientId/agents/:slug/*" element={<AgentPage />} />
        </Routes>
      </ApiProvider>
    </MemoryRouter>,
  );
  return api;
}

describe("AgentPage", () => {
  it("finds the agent by its slug in the client's list", async () => {
    const api = setup(PATH);
    const bar = await screen.findByTestId("agent-bar");
    expect(within(bar).getByRole("heading", { name: "Material costs" })).toBeInTheDocument();
    expect(await within(bar).findByTestId("agent-bar-line")).toHaveTextContent("Sandbox");
    expect(api.calls).toContain(`GET /api/ops/clients/${CLIENT}/agents`);
  });

  it("shows a handed-over agent at once, without looking it up", async () => {
    const api = setup({ pathname: PATH, state: { agent: AGENT_DETAIL } });
    expect(screen.getByTestId("agent-bar")).toBeInTheDocument();
    await screen.findByTestId("agent-how-it-works");
    expect(api.calls).not.toContain(`GET /api/ops/clients/${CLIENT}/agents`);
  });

  it("sends /ops/agents/:id on with the agent it loaded", async () => {
    const api = setup(`/ops/agents/${ID}`);
    expect(await screen.findByTestId("agent-bar")).toBeInTheDocument();
    expect(api.calls).not.toContain(`GET /api/ops/clients/${CLIENT}/agents`);
  });
});
