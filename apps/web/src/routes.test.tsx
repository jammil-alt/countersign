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
const YOURS = 8;

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
    // Your call's count, which the back office's frame shows on every page.
    "GET /api/ops/todos": () => ({
      items: [],
      counts: {
        yours: YOURS,
        reggie: 0,
        client: 0,
        doneToday: 0,
        dueToday: 0,
        criticalHeld: 0,
        lateClient: 0,
        questionsWeek: 0,
        medianAnswerMinutes: null,
      },
      holds: [],
      today: "2026-11-22",
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
  // Routes nested under a layout (the client page's frame) count too: a child's path is joined to
  // its parent's, and a layout without a path adds nothing.
  const walk = (routes: ReturnType<typeof createRoutesFromElements>, parent: string) => {
    for (const r of routes) {
      const p = r.index ? "" : (r.path ?? "");
      const joined = [parent, p].filter((x) => x !== "").join("/");
      if (r.children?.length) {
        walk(r.children, joined);
        if (r.path === undefined && !r.index) continue;
      }
      const filled = joined
        .split("/")
        .map((seg) => (seg.startsWith(":") ? ID : seg === "*" ? "" : seg))
        .filter((seg) => seg !== "")
        .join("/");
      out.push(`${prefix}/${filled}`.replace(/\/$/, "") || "/");
    }
  };
  walk(createRoutesFromElements(table), "");
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
      "/inbox",
      "/agents/x",
      "/agents/x/runs",
      "/agents/x/settings",
      "/connectors",
      "/connectors/x",
      "/contacts",
      "/settings",
      "/settings/approvals",
      "/settings/team",
      "/settings/hours",
      "/settings/channels",
      "/settings/billing",
      "/settings/exports",
      "/settings/conversations",
      "/settings/voice",
      "/runs",
      "/sloan",
      "/upload",
    ]) {
      const pattern = p.replace("/x", `/${ID}`);
      expect(all).toContain(pattern);
    }
  });

  it.each(all)("%s renders a page", async (path) => {
    renderAt(path, false);
    await screen.findByTestId("shell-portal");
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull(), { timeout: 10_000 });
    expect(screen.queryByTestId("page-not-found")).toBeNull();
  });

  it.each([
    [`/services/${ID}`, `/agents/${ID}`],
    ["/desk?status=open#top", "/inbox?status=open#top"],
    ["/connections", "/connectors"],
    ["/accounts", "/connectors"],
    ["/accounts#vault", "/connectors#vault"],
    ["/access", "/connectors#vault"],
    ["/accounts/access?x=1", "/connectors?x=1#vault"],
    ["/directory", "/contacts"],
    ["/people", "/contacts"],
    ["/people/directory", "/contacts"],
    ["/people/contacts", "/contacts"],
    ["/people/organizations", "/contacts?show=organizations"],
    ["/people/import", "/contacts?import=1"],
    ["/people/reach", "/"],
    ["/people/voice", "/settings/voice"],
    ["/conversations", "/settings/conversations"],
    ["/billing", "/settings/billing"],
  ])("%s redirects to %s", async (from, to) => {
    renderAt(from, false);
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(to));
    await screen.findByTestId("shell-portal");
    expect(screen.queryByTestId("page-not-found")).toBeNull();
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
    await screen.findByTestId("shell-ops", {}, { timeout: 10_000 });
    expect(screen.queryByTestId("page-not-found")).toBeNull();
    // Staging QA (2026-11-22): Your call's count is on every page of the back office, in the top
    // bar, the sidebar and the tab's title (it was reported gone on Library and New client).
    await waitFor(() => expect(screen.getByTestId("shell-inbox")).toHaveTextContent(`${YOURS}`));
    expect(screen.getByTestId("ops-nav-call")).toHaveTextContent(`${YOURS}`);
    expect(document.title.startsWith(`(${YOURS}) `)).toBe(true);
  });

  // Staging QA (2026-11-22): an unknown address is "Page not found" with the way Home, never
  // "Not built yet" (kept for a screen still to come).
  it.each([
    ["/ops/no-such-page", true, "/ops"],
    ["/no-such-page", false, "/"],
  ])("%s says the page is not found", async (path, operator, home) => {
    renderAt(path, operator);
    const page = await screen.findByTestId("page-not-found", {}, { timeout: 10_000 });
    expect(page).toHaveTextContent("Page not found");
    expect(page).not.toHaveTextContent("Not built yet");
    expect(screen.getByTestId("not-found-home")).toHaveAttribute("href", home);
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
    await screen.findByTestId("shell-ops", {}, { timeout: 10_000 });
    expect(screen.queryByTestId("page-not-found")).toBeNull();
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
