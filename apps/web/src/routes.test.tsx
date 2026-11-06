// The route map (portal/routes.tsx, ops/routes.tsx): every route renders a page, never "Not
// found", and every old address lands on its new home with its params, query and hash. A jsdom
// sweep, beside the browser one (#141), so a moved route fails here first.
import { render, screen, waitFor } from "@testing-library/react";
import { createRoutesFromElements, MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "./App";
import { OPS_PATHS } from "./ops/paths";
import { opsRoutes } from "./ops/routes";
import { portalRoutes } from "./portal/routes";
import { CLIENT_SESSION, fakeApi, OPERATOR_SESSION } from "./test/fixtures";

const ID = "00000000-0000-4000-8000-00000000e001";

function LocationProbe() {
  const { pathname, search, hash } = useLocation();
  return <span data-testid="location">{`${pathname}${search}${hash}`}</span>;
}

function renderAt(path: string, operator: boolean) {
  // Every route the page calls answers 404 unless named: a page must still render.
  const api = fakeApi({
    "GET /api/session": () => (operator ? OPERATOR_SESSION : CLIENT_SESSION),
    "GET /api/overview": () => ({
      client: { id: CLIENT_SESSION.activeTenantId, name: "Demo client" },
      services: [],
      needsYou: { inbox: 0 },
      recentRuns: [],
    }),
  });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
        <LocationProbe />
      </AppProviders>
    </MemoryRouter>,
  );
}

/** The route table's patterns, with each `:param` filled and a `*` dropped. */
function paths(table: React.ReactElement, prefix: string): string[] {
  const out: string[] = [];
  for (const r of createRoutesFromElements(table)) {
    const p = r.index ? "" : (r.path ?? "");
    const filled = p
      .split("/")
      .map((seg) => (seg.startsWith(":") ? ID : seg === "*" ? "" : seg))
      .filter((seg) => seg !== "")
      .join("/");
    out.push(`${prefix}/${filled}`.replace(/\/$/, "") || "/");
  }
  return out;
}

// Sign-in returns and provider windows act on arrival; their own tests cover them.
const ACTS_ON_ARRIVAL = (p: string) =>
  p.endsWith("/callback") || p.endsWith("/pick") || p.endsWith("/signup");

describe("the portal's routes", () => {
  const all = paths(portalRoutes, "").filter((p) => !ACTS_ON_ARRIVAL(p));

  it("has the plan's new homes", () => {
    for (const p of [
      "/",
      "/desk",
      "/agents/x",
      "/accounts",
      "/people",
      "/settings",
      "/runs",
      "/weekly",
      "/sloan",
      // UI-3a
      "/upload",
      "/settings/team",
      "/settings/exports",
    ]) {
      const pattern = p.replace("/x", `/${ID}`);
      expect(all).toContain(pattern);
    }
  });

  it.each(all)("%s renders a page", async (path) => {
    renderAt(path, false);
    await screen.findByTestId("shell-portal");
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull(), { timeout: 3000 });
    expect(screen.queryByRole("heading", { name: "Not found" })).toBeNull();
  });

  it.each([
    [`/services/${ID}`, `/agents/${ID}`],
    ["/inbox?status=open#top", "/desk?status=open#top"],
    ["/connections", "/accounts"],
    ["/access", "/accounts#vault"],
    ["/accounts/access?x=1", "/accounts?x=1#vault"],
    ["/directory", "/people"],
    ["/people/directory", "/people"],
    ["/contacts", "/people/contacts"],
    ["/billing", "/settings/billing"],
  ])("%s redirects to %s", async (from, to) => {
    renderAt(from, false);
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(to));
    await screen.findByTestId("shell-portal");
    expect(screen.queryByRole("heading", { name: "Not found" })).toBeNull();
  });

  it("keeps the providers' return addresses", () => {
    const raw = paths(portalRoutes, "");
    expect(raw).toContain(`/connections/${ID}/callback`);
    expect(raw).toContain("/connections/gsheets/pick");
    expect(raw).toContain("/connections/whatsapp_meta/signup");
  });
});

describe("the back office's routes", () => {
  const all = paths(opsRoutes, "/ops").filter((p) => !ACTS_ON_ARRIVAL(p));

  it.each(all)("%s renders a page", async (path) => {
    renderAt(path, true);
    await screen.findByTestId("shell-ops");
    expect(screen.queryByRole("heading", { name: "Not found" })).toBeNull();
  });

  it("sends /ops/templates to the Agent lab", async () => {
    renderAt("/ops/templates", true);
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/ops/lab"));
  });

  // UI-2c: the agent page's Workflow and Triggers tabs live under its splat route.
  it.each([
    OPS_PATHS.agentWorkflow(ID, "costs"),
    `${OPS_PATHS.agent(ID, "costs")}/workflows/main`,
    OPS_PATHS.agentTriggers(ID, "costs"),
    OPS_PATHS.newAgent(ID),
    OPS_PATHS.newTemplate,
  ])("%s renders a page", async (path) => {
    renderAt(path, true);
    await screen.findByTestId("shell-ops");
    expect(screen.queryByRole("heading", { name: "Not found" })).toBeNull();
  });

  it("keeps the template pages under /ops/templates", () => {
    expect(all).toContain(`/ops/templates/${ID}`);
    expect(all).toContain("/ops/templates/new");
  });

  it("has a route for each of the client page's tabs, and new client", () => {
    for (const tab of [
      "",
      "/agents",
      "/connections",
      "/messaging",
      "/knowledge",
      "/directory",
      "/documents",
      "/records",
      "/settings",
      "/exports",
    ]) {
      expect(all).toContain(`/ops/clients/${ID}${tab}`);
    }
    expect(all).toContain("/ops/clients");
    expect(all).toContain("/ops/clients/new");
  });
});
