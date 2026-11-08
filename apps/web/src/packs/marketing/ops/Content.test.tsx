// Content, a guide and Claims (M46, docs/plan.md §1.76): the list with each guide's state, a new
// guide at its fixed address, pointing the Website connection at the site; the editor's counters,
// the live check (what blocks publishing and what to check), the search-result preview, Publish
// waiting for the person's signature and sent once signed, a refusal shown in words, restore and
// preview links; the claims list viewed and saved as a new version.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../../App";
import { fakeApi, OPERATOR_SESSION, Reply } from "../../../test/fixtures";
import type { ClaimsReport } from "./Claims";
import type { ContentReport } from "./Content";
import type { CheckResult, GuideDetail } from "./ContentPage";

const CLIENT = "00000000-0000-4000-8000-00000000a046";
const SITE = "00000000-0000-4000-8000-00000000b046";
const PAGE = "00000000-0000-4000-8000-00000000c046";
const V2 = "00000000-0000-4000-8000-00000000d046";
const V1 = "00000000-0000-4000-8000-00000000e046";

const CLIENTS = {
  clients: [
    {
      id: CLIENT,
      name: "Mezonas",
      timezone: "America/Chicago",
      createdAt: "2026-11-01T00:00:00.000Z",
      agents: 0,
      openInbox: 0,
      needsUs: 0,
      waitingRuns: 0,
      sandbox: false,
      internal: true,
    },
  ],
};

const SITE_REF = { id: SITE, domain: "mezonas.com", name: "mezonas.com" };

const LIST: ContentReport = {
  site: SITE_REF,
  sites: [SITE_REF],
  pages: [
    {
      id: PAGE,
      siteId: SITE,
      path: "/guides/approvals",
      slug: "approvals",
      status: "published",
      title: "How approvals work",
      latestVersion: 2,
      liveVersion: 1,
      changedSinceLive: true,
      createdBy: "agent",
      createdAt: "2026-11-02T10:00:00.000Z",
      updatedAt: "2026-11-07T10:00:00.000Z",
      lastPublishedAt: "2026-11-03T10:00:00.000Z",
    },
  ],
  redirects: [{ from: "/guides/old", to: "/guides/approvals" }],
  website: { connected: true, domain: null, pointsHere: false },
};

const CLEAR: CheckResult = {
  html: '<h2 id="why">Why</h2><p>A change waits for you.</p>',
  headings: [{ level: 2, text: "Why", id: "why" }],
  problems: [],
  words: 5,
  publishable: true,
};

const DETAIL: GuideDetail = {
  page: {
    id: PAGE,
    siteId: SITE,
    path: "/guides/approvals",
    slug: "approvals",
    status: "draft",
    createdBy: "person",
    createdAt: "2026-11-02T10:00:00.000Z",
    addressFixed: true,
  },
  site: SITE_REF,
  liveVersion: null,
  versions: [
    {
      id: V2,
      version: 2,
      title: "How approvals work",
      description: "Every change waits for a person to sign it.",
      body: "## Why\n\nA change waits for you.",
      targetQueries: ["approval workflow"],
      author: "agent",
      why: "Answers a search with impressions.\n\nSources:\n- search_query_daily: approval workflow",
      createdAt: "2026-11-07T10:00:00.000Z",
      live: false,
    },
    {
      id: V1,
      version: 1,
      title: "Approvals",
      description: "",
      body: "",
      targetQueries: [],
      author: "person",
      why: null,
      createdAt: "2026-11-02T10:00:00.000Z",
      live: false,
    },
  ],
  publishes: [],
  check: CLEAR,
  queries: [
    { query: "approval workflow", impressions: 120, clicks: 4, position: "11.2", inTitle: false },
  ],
  website: { connected: true, domain: "mezonas.com", pointsHere: true },
};

function renderAt(path: string, routes: Parameters<typeof fakeApi>[0]) {
  const api = fakeApi({
    "GET /api/session": () => OPERATOR_SESSION,
    "GET /api/ops/clients": () => CLIENTS,
    ...routes,
  });
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
  return api;
}

const actionPath = (name: string) =>
  `POST /api/ops/clients/${CLIENT}/packs/marketing/actions/${name}`;

describe("Content", () => {
  it("lists the guides with their state, the redirects, and points the website at the site", async () => {
    const posted: unknown[] = [];
    renderAt(`/ops/clients/${CLIENT}/marketing/content`, {
      [`GET /api/ops/clients/${CLIENT}/reports/marketing/content`]: () => ({ report: LIST }),
      [actionPath("set-website")]: ({ init }) => {
        posted.push(JSON.parse(String(init.body)));
        return { result: { website: { domain: "mezonas.com" } } };
      },
    });
    const row = await screen.findByTestId("marketing-content-row");
    expect(row).toHaveTextContent("How approvals work");
    expect(row).toHaveTextContent("/guides/approvals");
    expect(row).toHaveTextContent("Agent draft");
    expect(row).toHaveTextContent("Live, changes not published");
    expect(row).toHaveTextContent("2 (live: 1)");
    expect(screen.getByTestId("marketing-content-redirects")).toHaveTextContent("/guides/old");
    fireEvent.click(screen.getByTestId("marketing-content-website-point"));
    await waitFor(() => expect(posted).toEqual([{ site: SITE }]));
  });

  it("says what to do first when the client has no site", async () => {
    renderAt(`/ops/clients/${CLIENT}/marketing/content`, {
      [`GET /api/ops/clients/${CLIENT}/reports/marketing/content`]: () => ({
        report: { ...LIST, site: null, sites: [], pages: [], redirects: [] },
      }),
    });
    expect(await screen.findByTestId("marketing-content-no-site")).toHaveTextContent(
      "Add the client's website",
    );
  });

  it("starts a guide at a fixed address and opens it", async () => {
    const posted: unknown[] = [];
    renderAt(`/ops/clients/${CLIENT}/marketing/content`, {
      [`GET /api/ops/clients/${CLIENT}/reports/marketing/content`]: () => ({
        report: { ...LIST, pages: [] },
      }),
      [actionPath("create-page")]: ({ init }) => {
        posted.push(JSON.parse(String(init.body)));
        return { result: { pageId: PAGE, path: "/guides/month-end" } };
      },
      [`GET /api/ops/clients/${CLIENT}/reports/marketing/content/items/${PAGE}`]: () => ({
        report: DETAIL,
      }),
    });
    expect(await screen.findByTestId("marketing-content-empty")).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("marketing-content-new-slug-input"), {
      target: { value: "Month-End" },
    });
    fireEvent.click(screen.getByTestId("marketing-content-new-create"));
    await waitFor(() => expect(posted).toEqual([{ site: SITE, slug: "month-end", title: "" }]));
    expect(await screen.findByTestId("marketing-content-page-editor")).toBeInTheDocument();
  });
});

describe("a guide", () => {
  const detailPath = `GET /api/ops/clients/${CLIENT}/reports/marketing/content/items/${PAGE}`;

  it("counts the title and description, checks the words on screen, and previews the result", async () => {
    const checked: unknown[] = [];
    renderAt(`/ops/clients/${CLIENT}/marketing/content/${PAGE}`, {
      [detailPath]: () => ({ report: DETAIL }),
      [actionPath("check")]: ({ init }) => {
        checked.push(JSON.parse(String(init.body)));
        return {
          result: {
            ...CLEAR,
            problems: [
              {
                field: "title",
                code: "claims_exclamation",
                severity: "refuse",
                message: "No exclamation marks: plain words carry it.",
                match: "!",
              },
              {
                field: "body",
                code: "claims_named-product",
                severity: "check",
                message: "Only if: the owner approves each one",
                match: "Zapier",
              },
            ],
            publishable: false,
          },
        };
      },
    });
    expect(await screen.findByTestId("marketing-content-page-address")).toHaveTextContent(
      "https://mezonas.com/guides/approvals",
    );
    expect(screen.getByTestId("marketing-content-page-title-count")).toHaveTextContent("18 of 60");
    expect(screen.getByTestId("marketing-content-page-checks-clear")).toBeInTheDocument();
    expect(screen.getByTestId("marketing-content-page-serp")).toHaveTextContent(
      "How approvals work",
    );
    expect(screen.getByTestId("marketing-content-page-queries")).toHaveTextContent("11.2");
    expect(screen.getByTestId("marketing-content-page-versions")).toHaveTextContent(
      "search_query_daily: approval workflow",
    );

    fireEvent.change(screen.getByTestId("marketing-content-page-title-input"), {
      target: { value: "t".repeat(61) },
    });
    expect(screen.getByTestId("marketing-content-page-title-count")).toHaveTextContent("61 of 60");
    // Unsaved words can't be published.
    expect(screen.getByTestId("marketing-content-page-publish")).toBeDisabled();
    const problems = await screen.findByTestId("marketing-content-page-problems", undefined, {
      timeout: 3000,
    });
    expect(problems).toHaveTextContent("Blocks publishing");
    expect(problems).toHaveTextContent("Check before publishing");
    expect(checked[0]).toMatchObject({ page: PAGE, title: "t".repeat(61) });
  });

  it("publishes only once the person signs, and shows a refusal in words", async () => {
    const published: unknown[] = [];
    let refuse = true;
    renderAt(`/ops/clients/${CLIENT}/marketing/content/${PAGE}`, {
      [detailPath]: () => ({ report: DETAIL }),
      [actionPath("publish")]: ({ init }) => {
        published.push(JSON.parse(String(init.body)));
        if (refuse) {
          return new Reply(422, {
            error: { code: "refused", message: "Not published: publishing isn't set up." },
          });
        }
        return { result: { status: "published", url: "https://mezonas.com/guides/approvals" } };
      },
    });
    fireEvent.click(await screen.findByTestId("marketing-content-page-publish"));
    // Nothing is sent until the person signs.
    expect(published).toHaveLength(0);
    const confirm = screen.getByTestId("marketing-content-page-confirm");
    expect(confirm).toHaveTextContent(
      "Version 2 goes live at https://mezonas.com/guides/approvals",
    );
    fireEvent.click(within(confirm).getByTestId("marketing-content-page-confirm-sign"));
    expect(await screen.findByTestId("marketing-content-page-error")).toHaveTextContent(
      "publishing isn't set up",
    );
    expect(published).toEqual([{ page: PAGE, version: V2 }]);
    refuse = false;
    fireEvent.click(screen.getByTestId("marketing-content-page-confirm-sign"));
    expect(await screen.findByTestId("marketing-content-page-done")).toHaveTextContent(
      "Live at https://mezonas.com/guides/approvals",
    );
  });

  it("can't publish while a check blocks it or the website points elsewhere", async () => {
    renderAt(`/ops/clients/${CLIENT}/marketing/content/${PAGE}`, {
      [detailPath]: () => ({
        report: {
          ...DETAIL,
          check: { ...CLEAR, publishable: false },
          website: { connected: true, domain: "elsewhere.com", pointsHere: false },
        },
      }),
    });
    expect(await screen.findByTestId("marketing-content-page-publish")).toBeDisabled();
  });

  it("restores an old version as a new one, and gets a preview link", async () => {
    const saved: unknown[] = [];
    renderAt(`/ops/clients/${CLIENT}/marketing/content/${PAGE}`, {
      [detailPath]: () => ({ report: DETAIL }),
      [actionPath("save-version")]: ({ init }) => {
        saved.push(JSON.parse(String(init.body)));
        return { result: { version: 3 } };
      },
      [`POST /api/ops/clients/${CLIENT}/packs/marketing/previews`]: () => ({
        url: "https://app.example.com/api/preview/abc.def",
        expiresAt: "2026-11-09T10:00:00.000Z",
      }),
    });
    fireEvent.click(await screen.findByTestId("marketing-content-page-version-restore"));
    await waitFor(() =>
      expect(saved).toEqual([
        {
          page: PAGE,
          title: "Approvals",
          description: "",
          body: "",
          targetQueries: [],
          why: "Restored version 1.",
        },
      ]),
    );
    fireEvent.click(screen.getByTestId("marketing-content-page-preview-link"));
    expect(await screen.findByTestId("marketing-content-page-preview-url")).toHaveTextContent(
      "https://app.example.com/api/preview/abc.def",
    );
  });
});

describe("Claims", () => {
  const REPORT: ClaimsReport = {
    latest: {
      id: "c1",
      version: 1,
      createdByUserId: "u1",
      createdAt: "2026-11-08T10:00:00.000Z",
      list: {
        title: "What Mezonas may claim in public",
        status: "draft",
        approved: [{ id: "approval-default", text: "Every change waits for approval by default." }],
        conditional: [
          {
            id: "named-product",
            text: "A comparison that names a product.",
            condition: "the owner approves each one",
            phrases: ["Zapier"],
          },
        ],
        never: [{ id: "unlimited", text: "Unlimited anything.", phrases: ["unlimited"] }],
      },
    },
    versions: [
      { id: "c1", version: 1, createdByUserId: "u1", createdAt: "2026-11-08T10:00:00.000Z" },
    ],
  };

  it("shows the list in force and saves a change as a new version", async () => {
    const posted: { list: { title: string } }[] = [];
    renderAt(`/ops/clients/${CLIENT}/marketing/claims`, {
      [`GET /api/ops/clients/${CLIENT}/reports/marketing/claims`]: () => ({ report: REPORT }),
      [actionPath("save-claims")]: ({ init }) => {
        posted.push(JSON.parse(String(init.body)));
        return { result: { claims: { version: 2 } } };
      },
    });
    const list = await screen.findByTestId("marketing-claims-list");
    expect(list).toHaveTextContent("Every change waits for approval by default.");
    expect(list).toHaveTextContent("Only if the owner approves each one");
    expect(list).toHaveTextContent("Refuses: unlimited");
    fireEvent.click(screen.getByTestId("marketing-claims-edit"));
    const input = screen.getByTestId("marketing-claims-json-input") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "{not json" } });
    fireEvent.click(screen.getByTestId("marketing-claims-save"));
    expect(await screen.findByTestId("marketing-claims-error")).toHaveTextContent("valid JSON");
    fireEvent.change(input, {
      target: { value: JSON.stringify({ ...REPORT.latest?.list, title: "Version two" }) },
    });
    fireEvent.click(screen.getByTestId("marketing-claims-save"));
    await waitFor(() => expect(posted[0]?.list.title).toBe("Version two"));
    expect(await screen.findByTestId("marketing-claims-done")).toHaveTextContent("version 2");
  });

  it("offers to load the first list when there is none", async () => {
    renderAt(`/ops/clients/${CLIENT}/marketing/claims`, {
      [`GET /api/ops/clients/${CLIENT}/reports/marketing/claims`]: () => ({
        report: { latest: null, versions: [] },
      }),
    });
    expect(await screen.findByTestId("marketing-claims-empty")).toHaveTextContent(
      "mezonas-claims.json",
    );
    expect(screen.getByTestId("marketing-claims-edit")).toHaveTextContent("Load a list");
  });
});
