// The Agent lab's Drafts tab and New say what's wrong rather than show an empty board or a dead
// button (BUILDER_QA.md, the flow lens of 2026-11-19: FLOW-7 and FLOW-8).
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ApiProvider } from "../../api/useApi";
import { fakeApi, Reply } from "../../test/fixtures";
import { LabScreen } from "./LabScreen";

const EMPTY_LAB = { published: [], drafts: [], clientOnly: [] };

function renderLab(path: string, routes: Parameters<typeof fakeApi>[0]) {
  const api = fakeApi({
    "GET /api/ops/lab": () => EMPTY_LAB,
    "GET /api/ops/templates": () => ({ templates: [] }),
    ...routes,
  });
  render(
    <MemoryRouter initialEntries={[path]}>
      <ApiProvider client={api.client}>
        <Routes>
          <Route path="/ops/lab" element={<LabScreen />} />
        </Routes>
      </ApiProvider>
    </MemoryRouter>,
  );
  return { api, user: userEvent.setup() };
}

describe("the Agent lab says what is wrong", () => {
  // FLOW-7: LabScreen reads `builds.data?.builds ?? []` and never looks at `builds.error`; with
  // the lab itself loaded, a failed builds read shows the Drafts empty state ("No drafts ... New
  // starts a build"), so the operator reads every build in progress as gone and may start again.
  it("says the builds couldn't be read, rather than that there are no drafts", async () => {
    renderLab("/ops/lab?tab=drafts", {
      "GET /api/ops/builds": () =>
        new Reply(500, { error: { code: "internal", message: "something went wrong" } }),
    });
    await screen.findByTestId("lab-tabs");
    // Expected: no "No drafts" claim while the builds are unknown; an error with a retry instead.
    expect(screen.queryByText("No drafts")).toBeNull();
    expect(screen.getByTestId("ops-lab")).toHaveTextContent(/try again/i);
  });

  // FLOW-8: New → Client agent with no client the operator serves (or the clients read failing):
  // the "For" list holds only "Pick a client", Start stays off, and the only reason is a `title`
  // tooltip (never seen on a phone or by keyboard). Nothing says there is no client to pick or
  // where to add one.
  it("says why a client agent can't start when there is no client to pick", async () => {
    const { user } = renderLab("/ops/lab?tab=drafts&new=template", {
      "GET /api/ops/builds": () => ({ builds: [], items: [] }),
      "GET /api/ops/clients": () => ({ clients: [] }),
    });
    const form = await screen.findByTestId("builds-start");
    await user.click(within(form).getByTestId("builds-start-kind-client"));
    await user.type(within(form).getByTestId("builds-start-title"), "Bill review");
    expect(within(form).getByTestId("builds-start-go")).toBeDisabled();
    // Expected: a visible line, not only a tooltip, saying there's no client to pick.
    expect(form).toHaveTextContent(/no client|add a client|pick the client it's for/i);
  });

  // FLOW-8: with clients to pick, the reason is to pick one; once picked, Start is on.
  it("says to pick the client, and starts once one is picked", async () => {
    const { user } = renderLab("/ops/lab?tab=drafts&new=client", {
      "GET /api/ops/builds": () => ({ builds: [], items: [] }),
      "GET /api/ops/clients": () => ({
        clients: [
          {
            id: "00000000-0000-4000-8000-00000000a001",
            name: "Harbor Millwork",
            timezone: "America/Chicago",
            createdAt: "2026-11-01T00:00:00.000Z",
            agents: 1,
            openInbox: 0,
          },
        ],
      }),
    });
    const form = await screen.findByTestId("builds-start");
    await user.type(within(form).getByTestId("builds-start-title"), "Bill review");
    expect(await within(form).findByTestId("builds-start-why")).toHaveTextContent(
      "Pick the client it's for.",
    );
    await user.selectOptions(
      within(form).getByTestId("builds-start-client"),
      "00000000-0000-4000-8000-00000000a001",
    );
    expect(within(form).queryByTestId("builds-start-why")).toBeNull();
    expect(within(form).getByTestId("builds-start-go")).toBeEnabled();
  });

  // FLOW-8: the clients read failing is said, with a retry.
  it("says the clients couldn't be read", async () => {
    renderLab("/ops/lab?tab=drafts&new=client", {
      "GET /api/ops/builds": () => ({ builds: [], items: [] }),
      "GET /api/ops/clients": () =>
        new Reply(500, { error: { code: "internal", message: "something went wrong" } }),
    });
    const form = await screen.findByTestId("builds-start");
    expect((await within(form).findAllByText(/try again/i)).length).toBeGreaterThan(0);
    expect(within(form).queryByTestId("builds-start-why")).toBeNull();
  });
});
