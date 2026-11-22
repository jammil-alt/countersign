// The back office's picked client: the page's own client (from its address, or reported by a page
// such as a run), else none. Navigation only: nothing is remembered from page to page, so a
// screen that lists every client never shows one client's name beside it.
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { PickedClientProvider, usePageClient, usePickedClient } from "./pickedClient";

const DEMO = "00000000-0000-4000-8000-00000000a002";
const SANDBOX = "00000000-0000-4000-8000-00000000a001";

let go: (to: string) => void = () => {};

function Picker() {
  const picked = usePickedClient();
  go = useNavigate();
  return <output data-testid="picked">{picked.clientId ?? "none"}</output>;
}

/** A run's page: its client isn't in its address, so it says which it is. */
function RunPage({ clientId }: { clientId: string | undefined }) {
  usePageClient(clientId);
  return null;
}

function tree(path: string, runClient?: string) {
  return (
    <MemoryRouter initialEntries={[path]}>
      <PickedClientProvider>
        <Picker />
        <Routes>
          <Route path="/ops/runs/:id" element={<RunPage clientId={runClient} />} />
          <Route path="*" element={null} />
        </Routes>
      </PickedClientProvider>
    </MemoryRouter>
  );
}

afterEach(() => sessionStorage.clear());

describe("the picked client", () => {
  it("is the client of a client's page, and none on a page without one", () => {
    render(tree(`/ops/clients/${DEMO}/documents`));
    expect(screen.getByTestId("picked")).toHaveTextContent(DEMO);
    // Runs lists every client: the picker must not keep showing the one opened before.
    act(() => go("/ops/runs"));
    expect(screen.getByTestId("picked")).toHaveTextContent("none");
    act(() => go("/ops/lab"));
    expect(screen.getByTestId("picked")).toHaveTextContent("none");
    expect(sessionStorage.length).toBe(0);
  });

  it("is a run's client while its page is open, once the run has loaded", () => {
    const { rerender } = render(tree("/ops/runs/r1", undefined));
    expect(screen.getByTestId("picked")).toHaveTextContent("none");
    rerender(tree("/ops/runs/r1", SANDBOX));
    expect(screen.getByTestId("picked")).toHaveTextContent(SANDBOX);
  });

  it("ignores a pick an older version remembered in the tab's session", () => {
    sessionStorage.setItem("mezonas.ops.client", SANDBOX);
    render(tree("/ops"));
    expect(screen.getByTestId("picked")).toHaveTextContent("none");
  });
});
