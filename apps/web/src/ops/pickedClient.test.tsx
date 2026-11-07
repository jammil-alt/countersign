// The back office's picked client: the page's own client (from its address, or reported by a page
// such as a run), else the last one picked or opened in this tab's session.
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
  return <output data-testid="picked">{picked.clientId ?? "all"}</output>;
}

/** A run's page: its client isn't in its address, so it says which it is. */
function RunPage({ clientId }: { clientId: string | undefined }) {
  usePageClient(clientId);
  return null;
}

function renderAt(path: string, runClient?: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <PickedClientProvider>
        <Picker />
        <Routes>
          <Route path="/ops/runs/:id" element={<RunPage clientId={runClient} />} />
          <Route path="*" element={null} />
        </Routes>
      </PickedClientProvider>
    </MemoryRouter>,
  );
}

afterEach(() => sessionStorage.clear());

describe("the picked client", () => {
  it("is the client of a client's page, and stays picked on pages without one", () => {
    renderAt(`/ops/clients/${DEMO}/documents`);
    expect(screen.getByTestId("picked")).toHaveTextContent(DEMO);
    act(() => go("/ops/lab"));
    expect(screen.getByTestId("picked")).toHaveTextContent(DEMO);
    expect(sessionStorage.getItem("mezonas.ops.client")).toBe(DEMO);
  });

  it("is a run's client while its page is open, once the run has loaded", () => {
    const { rerender } = renderAt("/ops/runs/r1", undefined);
    expect(screen.getByTestId("picked")).toHaveTextContent("all");
    rerender(
      <MemoryRouter initialEntries={["/ops/runs/r1"]}>
        <PickedClientProvider>
          <Picker />
          <Routes>
            <Route path="/ops/runs/:id" element={<RunPage clientId={SANDBOX} />} />
          </Routes>
        </PickedClientProvider>
      </MemoryRouter>,
    );
    expect(screen.getByTestId("picked")).toHaveTextContent(SANDBOX);
  });

  it("keeps the picked client when a run of it opens", () => {
    sessionStorage.setItem("mezonas.ops.client", DEMO);
    renderAt("/ops/runs/r1", DEMO);
    expect(screen.getByTestId("picked")).toHaveTextContent(DEMO);
  });

  it("starts from the session's last pick", () => {
    sessionStorage.setItem("mezonas.ops.client", SANDBOX);
    renderAt("/ops");
    expect(screen.getByTestId("picked")).toHaveTextContent(SANDBOX);
  });
});
