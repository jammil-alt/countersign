// Clearing the lab's Drafts on a test environment (docs/plan.md §1.173): the button shows only
// where the API allows it and there is something to clear; it asks first, says nothing is deleted,
// and what it cleared is listed in the Archive.
import type { BuildSummary } from "@countersign/core";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ApiProvider } from "../../api/useApi";
import { fakeApi } from "../../test/fixtures";
import { clearWords } from "./ClearDrafts";
import { LabScreen } from "./LabScreen";

const at = "2026-11-21T10:00:00.000Z";
const BUILD: BuildSummary = {
  id: "00000000-0000-4000-8000-0000000c0001",
  kind: "agent",
  title: "Material purchasor",
  client: null,
  phase: "draft",
  status: "open",
  agentId: null,
  skillId: null,
  testAgentId: null,
  testClient: null,
  openItems: 0,
  waitingOnClient: 0,
  createdBy: "Ann",
  createdAt: at,
  updatedAt: at,
  phaseAt: at,
  path: "new",
  flow: "describe",
  templateId: null,
  promisedOn: null,
  origin: null,
  requirements: null,
  pipelineStage: "building",
  standing: "you",
  waitingOn: "operator",
  statusLine: "",
  stuck: false,
};

function setup(allowed: boolean) {
  let cleared = false;
  const api = fakeApi({
    "GET /api/ops/lab": () => ({ published: [], drafts: [], clientOnly: [] }),
    "GET /api/ops/templates": () => ({ templates: [] }),
    "GET /api/ops/builds": ({ url }) => {
      const stopped = url.searchParams.get("status") === "stopped";
      const builds = stopped
        ? cleared
          ? [{ ...BUILD, status: "stopped" }]
          : []
        : cleared
          ? []
          : [BUILD];
      return { builds, items: [] };
    },
    "GET /api/ops/lab/drafts/clear": () =>
      allowed
        ? { allowed: true, builds: cleared ? 0 : 1, drafts: cleared ? 0 : 2 }
        : { allowed: false, builds: 0, drafts: 0 },
    "POST /api/ops/lab/drafts/clear": () => {
      cleared = true;
      return { builds: 1, drafts: 2 };
    },
  });
  render(
    <MemoryRouter initialEntries={["/ops/lab?tab=drafts"]}>
      <ApiProvider client={api.client}>
        <Routes>
          <Route path="/ops/lab" element={<LabScreen />} />
          <Route path="*" element={null} />
        </Routes>
      </ApiProvider>
    </MemoryRouter>,
  );
  return { api, user: userEvent.setup() };
}

describe("Clear all drafts", () => {
  it("says what it would archive in words", () => {
    expect(clearWords({ builds: 3, drafts: 2 })).toBe("3 builds and 2 drafts");
    expect(clearWords({ builds: 1, drafts: 0 })).toBe("1 build");
    expect(clearWords({ builds: 0, drafts: 1 })).toBe("1 draft");
  });

  it("isn't offered where the environment doesn't allow it", async () => {
    setup(false);
    expect(await screen.findByTestId(`builds-card-${BUILD.id}`)).toBeInTheDocument();
    expect(screen.queryByTestId("lab-clear-drafts")).toBeNull();
  });

  it("asks first, clears the board, and lists what it cleared in the Archive", async () => {
    const { api, user } = setup(true);
    await user.click(await screen.findByTestId("lab-clear-drafts-start"));
    expect(screen.getByTestId("lab-clear-drafts-ask")).toHaveTextContent(
      "Stop and archive 1 build and 2 drafts? Nothing is deleted: they move to the Archive below.",
    );
    // Nothing is sent until it is confirmed.
    expect(api.calls).not.toContain("POST /api/ops/lab/drafts/clear");
    await user.click(screen.getByTestId("lab-clear-drafts-yes"));
    await waitFor(() => expect(screen.queryByTestId(`builds-card-${BUILD.id}`)).toBeNull());
    const archive = await screen.findByTestId("lab-stopped");
    expect(archive).toHaveTextContent("Stopped builds · 1");
    expect(archive).toHaveTextContent("Material purchasor");
    expect(archive.querySelector("a")).toHaveAttribute("href", `/ops/builds/${BUILD.id}`);
    // Nothing is left to clear, so the button goes.
    await waitFor(() => expect(screen.queryByTestId("lab-clear-drafts")).toBeNull());
  });
});
