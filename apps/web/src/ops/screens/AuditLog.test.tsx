// `/ops/audit`: the audit log with who, client, outcome and target; filters travel in the URL and
// the request; "Load older" pages with `before`; the access review with retired clients marked and
// its CSV.
import type { AccessReviewUser } from "@countersign/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { fakeApi, OPERATOR_SESSION, Reply } from "../../test/fixtures";
import { accessReviewCsv, dayBounds } from "./AuditLog";

const DEMO = "00000000-0000-4000-8000-00000000a002";
const OLD = "00000000-0000-4000-8000-00000000a009";
const USER = "00000000-0000-4000-8000-00000000d002";
const RUN = "00000000-0000-4000-8000-0000000e0001";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const row = (n: number, over: Record<string, unknown> = {}) => ({
  id: id(n),
  client: { id: DEMO, name: "Demo client" },
  actor: { kind: "user", id: USER, email: "admin@demo.example.com", role: "client_admin" },
  action: "GET /api/runs/:id",
  outcome: "ok",
  httpStatus: 200,
  target: { id: RUN },
  ip: "203.0.113.7",
  userAgent: "Mozilla/5.0",
  createdAt: "2026-11-05T09:14:03.000Z",
  ...over,
});

function renderAt(path: string, api: ReturnType<typeof fakeApi>) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe("ops audit log", () => {
  it("shows who did what, with outcomes, and pages back with Load older", async () => {
    const queries: URLSearchParams[] = [];
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/audit": ({ url }) => {
        queries.push(url.searchParams);
        if (url.searchParams.get("before") === id(3)) {
          return {
            events: [row(4, { action: "session.sign_in", client: null })],
            nextBefore: null,
          };
        }
        return {
          events: [
            row(1),
            row(2, {
              actor: { kind: "anonymous", id: null, email: null, role: null },
              client: null,
              outcome: "refused",
              httpStatus: 401,
              target: {},
              ip: null,
            }),
            row(3, {
              actor: { kind: "system", id: null, email: null, role: null },
              outcome: "error",
              httpStatus: 500,
            }),
          ],
          nextBefore: id(3),
        };
      },
    });
    renderAt("/ops/audit", api);
    expect(await screen.findByRole("heading", { name: "Audit log" })).toBeInTheDocument();
    // The old address lands on its Utilities tab, with the sidebar's Utilities current.
    expect(screen.getByTestId("ops-nav-utilities")).toHaveAttribute("aria-current", "page");
    const tabs = screen.getByTestId("utilities-tabs");
    expect(within(tabs).getByRole("link", { name: "Audit log" })).toHaveAttribute(
      "href",
      "/ops/utilities/audit",
    );
    expect(within(tabs).getByRole("link", { name: "Audit log" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(
      within(tabs)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual(["Feedback", "Audit log", "Requests", "Websites"]);

    const first = await screen.findByTestId(`ops-audit-row-${id(1)}`);
    expect(within(first).getByTestId("ops-audit-who")).toHaveTextContent(
      "admin@demo.example.comAdmin",
    );
    expect(within(first).getByTestId("ops-audit-client-name")).toHaveTextContent("Demo client");
    expect(within(first).getByTestId("ops-audit-action-name")).toHaveTextContent(
      "GET /api/runs/:id",
    );
    expect(within(first).getByTestId("ops-audit-outcome-mark")).toHaveTextContent("OK · 200");
    expect(within(first).getByText("00000000…")).toBeInTheDocument();
    expect(within(first).getByText("203.0.113.7")).toBeInTheDocument();

    const refused = screen.getByTestId(`ops-audit-row-${id(2)}`);
    expect(within(refused).getByTestId("ops-audit-who")).toHaveTextContent("Signed out");
    expect(within(refused).getByTestId("ops-audit-client-name")).toHaveTextContent("–");
    const refusedMark = within(refused).getByTestId("ops-audit-outcome-mark");
    expect(refusedMark).toHaveTextContent("Refused · 401");
    expect(refusedMark).toHaveClass("ds-pill--neutral");

    const failed = screen.getByTestId(`ops-audit-row-${id(3)}`);
    expect(within(failed).getByTestId("ops-audit-who")).toHaveTextContent("Mezonas");
    expect(within(failed).getByTestId("ops-audit-outcome-mark")).toHaveClass("text-risk-ink");

    expect(screen.getByTestId("ops-audit-count")).toHaveTextContent("3 entries");
    await userEvent.click(screen.getByTestId("ops-audit-older"));
    expect(await screen.findByTestId(`ops-audit-row-${id(4)}`)).toBeInTheDocument();
    expect(screen.getByTestId(`ops-audit-row-${id(1)}`)).toBeInTheDocument();
    expect(screen.queryByTestId("ops-audit-older")).toBeNull();
    expect(screen.getByTestId("ops-audit-count")).toHaveTextContent("4 entries. No older entries.");
    expect(queries.at(-1)?.get("before")).toBe(id(3));
  });

  it("sends the filters, from the URL and the form", async () => {
    const queries: URLSearchParams[] = [];
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/audit": ({ url }) => {
        queries.push(url.searchParams);
        return { events: [], nextBefore: null };
      },
    });
    renderAt(`/ops/audit?client=${DEMO}&outcome=refused&from=2026-11-01&to=2026-11-04`, api);
    expect(await screen.findByText("Nothing matches these filters.")).toBeInTheDocument();
    const q = queries[0];
    expect(q?.get("client")).toBe(DEMO);
    expect(q?.get("outcome")).toBe("refused");
    expect(q?.get("from")).toBe(new Date(2026, 10, 1).toISOString());
    expect(q?.get("to")).toBe(new Date(2026, 10, 5).toISOString());
    expect(screen.getByTestId("ops-audit-client")).toHaveValue(DEMO);

    await userEvent.type(screen.getByTestId("ops-audit-action"), "session.");
    await waitFor(() => expect(queries.at(-1)?.get("action")).toBe("session."));

    // A user id that isn't one stays in the box and isn't sent.
    await userEvent.type(screen.getByTestId("ops-audit-user"), "nobody");
    expect(await screen.findByText("Not a user id.")).toBeInTheDocument();
    await userEvent.clear(screen.getByTestId("ops-audit-user"));
    await userEvent.type(screen.getByTestId("ops-audit-user"), USER);
    await waitFor(() => expect(queries.at(-1)?.get("user")).toBe(USER));

    await userEvent.click(screen.getByTestId("ops-audit-clear"));
    await waitFor(() => expect([...(queries.at(-1)?.keys() ?? [])]).toEqual([]));
  });

  it("shows a failed load with a retry", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/audit": () => new Reply(500, { error: { code: "internal" } }),
    });
    renderAt("/ops/audit", api);
    expect(await screen.findByRole("alert")).toHaveTextContent("internal");
  });
});

const REVIEW = {
  generatedAt: "2026-11-05T12:00:00.000Z",
  users: [
    {
      id: USER,
      email: "admin@demo.example.com",
      name: "Demo admin",
      memberships: [
        { client: { id: DEMO, name: "Demo client", retired: false }, role: "client_admin" },
        { client: { id: OLD, name: "Old client", retired: true }, role: "client_user" },
      ],
      lastSignInAt: "2026-11-04T08:00:00.000Z",
      lastSeenAt: "2026-11-04T09:30:00.000Z",
    },
    {
      id: id(77),
      email: "new@demo.example.com",
      name: null,
      memberships: [],
      lastSignInAt: null,
      lastSeenAt: null,
    },
  ],
};

describe("access review", () => {
  it("lists users, roles per client with retired clients marked, and links to their activity", async () => {
    const queries: URLSearchParams[] = [];
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/access-review": () => REVIEW,
      "GET /api/ops/audit": ({ url }) => {
        queries.push(url.searchParams);
        return { events: [], nextBefore: null };
      },
    });
    renderAt("/ops/audit", api);
    await userEvent.click(await screen.findByTestId("ops-audit-view-filter-access"));
    const row = await screen.findByTestId(`ops-access-review-row-${USER}`);
    const memberships = within(row).getAllByTestId("ops-access-review-membership");
    expect(memberships[0]).toHaveTextContent("Demo client · Admin");
    expect(memberships[0]).not.toHaveTextContent("Retired");
    expect(memberships[1]).toHaveTextContent("Old client · UserRetired");
    expect(screen.getByTestId(`ops-access-review-row-${id(77)}`)).toHaveTextContent(
      "No clientsNeverNever",
    );
    expect(screen.getByTestId("ops-access-review-generated")).toHaveTextContent("Generated");

    const created = vi.fn((_: Blob) => "blob:csv");
    URL.createObjectURL = created;
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await userEvent.click(screen.getByTestId("ops-access-review-csv"));
    expect(created).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);

    await userEvent.click(within(row).getByTestId(`ops-access-review-activity-${USER}`));
    await waitFor(() => expect(queries.at(-1)?.get("user")).toBe(USER));
    expect(screen.getByTestId("ops-audit-user")).toHaveValue(USER);
  });

  it("builds a CSV with one line per user and client", () => {
    const [admin, newcomer] = REVIEW.users as AccessReviewUser[];
    const csv = accessReviewCsv([
      { ...(admin as AccessReviewUser), name: 'Admin, "Demo"' },
      newcomer as AccessReviewUser,
    ]);
    expect(csv.split("\r\n")).toEqual([
      "Email,Name,Client,Role,Client retired,Last sign-in,Last seen",
      'admin@demo.example.com,"Admin, ""Demo""",Demo client,Admin,no,2026-11-04T08:00:00.000Z,2026-11-04T09:30:00.000Z',
      'admin@demo.example.com,"Admin, ""Demo""",Old client,User,yes,2026-11-04T08:00:00.000Z,2026-11-04T09:30:00.000Z',
      "new@demo.example.com,,,,,,",
      "",
    ]);
  });

  it("turns dates into the day's bounds", () => {
    expect(dayBounds("", "")).toEqual({});
    expect(dayBounds("2026-11-01", "")).toEqual({ from: new Date(2026, 10, 1).toISOString() });
    expect(dayBounds("", "2026-11-30")).toEqual({ to: new Date(2026, 11, 1).toISOString() });
  });
});
