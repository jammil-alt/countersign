// The agent set's screens (M47–M48, docs/plan.md §1.77): the weekly reports listed with their
// week, whether they were read and where their actions stand; one report with what changed, the
// causes, what we can't know, its three actions marked Done or Not now, and the figures it was
// held to; the forum watch's queue, a reply approved naming the poster or turned down with a
// reason, an approved one marked posted, and a thread added for the watch.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../../App";
import { fakeApi, OPERATOR_SESSION } from "../../../test/fixtures";
import type { ForumReport } from "./Forum";
import type { ReportDetail } from "./Report";
import type { ReportsReport } from "./Reports";

const CLIENT = "00000000-0000-4000-8000-00000000a047";
const SITE = "00000000-0000-4000-8000-00000000b047";
const REPORT = "00000000-0000-4000-8000-00000000c047";
const REPLY = "00000000-0000-4000-8000-00000000d047";
const APPROVED = "00000000-0000-4000-8000-00000000e047";
const PERSON = "00000000-0000-4000-8000-00000000f047";

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

const SITE_ROW = {
  id: SITE,
  domain: "mezonas.com",
  name: "mezonas.com",
  goals: [],
  status: "on",
  createdAt: "2026-11-01T00:00:00.000Z",
};

const LIST: ReportsReport = {
  site: SITE_ROW,
  sites: [SITE_ROW],
  reports: [
    {
      id: REPORT,
      siteId: SITE,
      periodFrom: "2026-11-01",
      periodTo: "2026-11-07",
      createdAt: "2026-11-09T13:37:00.000Z",
      read: false,
      summary: "Visits rose to 105 from 70 (+50.0%).",
      actions: { open: 2, done: 1, notNow: 0 },
    },
  ],
};

const evidence = (page: string) => [
  { label: page, href: `/ops/clients/${CLIENT}/marketing/${page.toLowerCase()}` },
];

const DETAIL: ReportDetail = {
  id: REPORT,
  site: { id: SITE, domain: "mezonas.com", name: "mezonas.com" },
  periodFrom: "2026-11-01",
  periodTo: "2026-11-07",
  searchPeriod: { from: "2026-10-30", to: "2026-11-05" },
  createdAt: "2026-11-09T13:37:00.000Z",
  readAt: null,
  readBy: null,
  report: {
    summary: "Visits rose to 105 from 70 (+50.0%).",
    changes: [{ text: "Visits: 105 (was 70, +50.0%).", evidence: evidence("Overview") }],
    causes: [{ text: "Probably more people found /pricing in search." }],
    unknown: "Why visitors left the pricing page without getting in touch.",
    actions: [],
  },
  figures: ["Visits: 105 (was 70, +50.0%)", "Page views: 210 (was 140, +50.0%)"],
  sources: [SITE],
  runId: null,
  actions: [
    {
      id: "a0",
      idx: 0,
      text: "Answer the pricing question on /pricing first.",
      why: "It is seen in search far more than it is clicked.",
      evidence: [{ label: "Pricing", href: "/pricing" }],
      decision: "done",
      decidedBy: "Dana",
      decidedAt: "2026-11-09T15:00:00.000Z",
    },
    {
      id: "a1",
      idx: 1,
      text: "Add a guide on approval workflows.",
      why: "People search for it.",
      evidence: evidence("Search"),
      decision: "open",
      decidedBy: null,
      decidedAt: null,
    },
    {
      id: "a2",
      idx: 2,
      text: "Look at the sources next week.",
      why: "Most visits came from one source.",
      evidence: evidence("Sources"),
      decision: "open",
      decidedBy: null,
      decidedAt: null,
    },
  ],
};

const thread = {
  id: "t1",
  source: "hackernews",
  url: "https://news.ycombinator.com/item?id=4242",
  title: "Ask HN: How do you approve vendor bills?",
  externalId: "4242",
};

const FORUM: ForumReport = {
  waiting: [
    {
      id: REPLY,
      status: "waiting",
      body: "I work at Mezonas. What worked for us: each bill waits for one named person.",
      createdAt: "2026-11-08T10:00:00.000Z",
      poster: null,
      decidedBy: null,
      decidedAt: null,
      postedAt: null,
      reason: null,
      runId: null,
      thread,
    },
  ],
  toPost: [
    {
      id: APPROVED,
      status: "approved",
      body: "I work at Mezonas. We keep the before and after of every change.",
      createdAt: "2026-11-07T10:00:00.000Z",
      poster: { id: PERSON, name: "Dana" },
      decidedBy: "Operator",
      decidedAt: "2026-11-07T11:00:00.000Z",
      postedAt: null,
      reason: null,
      runId: null,
      thread: { ...thread, id: "t2", title: "Show HN: An approvals inbox" },
    },
  ],
  done: [],
  threads: [
    {
      id: "t3",
      source: "hackernews",
      url: "https://news.ycombinator.com/item?id=4343",
      title: "Tell HN: Month-end is hard",
      seenAt: "2026-11-08T09:00:00.000Z",
      outcome: "passed",
      addedBy: null,
      byAgent: true,
    },
  ],
  people: [{ id: PERSON, name: "Dana", role: "client_admin" }],
  counts: { waiting: 1, toPost: 1, threads: 3 },
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

describe("the weekly reports", () => {
  it("lists each week with its summary, whether it was read and its actions", async () => {
    renderAt(`/ops/clients/${CLIENT}/marketing/reports`, {
      [`GET /api/ops/clients/${CLIENT}/reports/marketing/reports`]: () => ({ report: LIST }),
    });
    const row = await screen.findByTestId("marketing-reports-row");
    expect(row).toHaveTextContent("Week of Nov 1 to Nov 7, 2026");
    expect(row).toHaveTextContent("Visits rose to 105 from 70 (+50.0%).");
    expect(row).toHaveTextContent("Not read yet");
    expect(row).toHaveTextContent("Actions: 2 open, 1 done");
    expect(within(row).getByTestId("marketing-reports-row-open")).toHaveAttribute(
      "href",
      `/ops/clients/${CLIENT}/marketing/reports/${REPORT}`,
    );
    expect(screen.getByTestId("marketing-reports-csv-download")).toHaveAttribute(
      "href",
      `/api/ops/clients/${CLIENT}/reports/marketing/reports/csv?site=${SITE}`,
    );
  });

  it("says how the first report comes when there is none", async () => {
    renderAt(`/ops/clients/${CLIENT}/marketing/reports`, {
      [`GET /api/ops/clients/${CLIENT}/reports/marketing/reports`]: () => ({
        report: { ...LIST, reports: [] },
      }),
    });
    expect(await screen.findByTestId("marketing-reports-empty")).toHaveTextContent(
      "each Monday morning",
    );
  });
});

describe("one weekly report", () => {
  const itemPath = `GET /api/ops/clients/${CLIENT}/reports/marketing/reports/items/${REPORT}`;

  it("shows what changed, the causes, what we can't know, and the figures behind it", async () => {
    renderAt(`/ops/clients/${CLIENT}/marketing/reports/${REPORT}`, {
      [itemPath]: () => ({ report: DETAIL }),
    });
    expect(await screen.findByTestId("marketing-report-summary")).toHaveTextContent(
      "Visits rose to 105",
    );
    const changes = screen.getByTestId("marketing-report-changes");
    expect(changes).toHaveTextContent("Visits: 105 (was 70, +50.0%).");
    expect(within(changes).getByRole("link", { name: "Overview" })).toHaveAttribute(
      "href",
      `/ops/clients/${CLIENT}/marketing/overview`,
    );
    expect(screen.getByTestId("marketing-report-causes")).toHaveTextContent("Probably");
    expect(screen.getByTestId("marketing-report-unknown")).toHaveTextContent(
      "without getting in touch",
    );
    expect(screen.getByTestId("marketing-report-figures")).toHaveTextContent(
      "Page views: 210 (was 140, +50.0%)",
    );
    const actions = screen.getAllByTestId("marketing-report-action");
    expect(actions).toHaveLength(3);
    expect(actions[0]).toHaveTextContent("Done");
    expect(actions[0]).toHaveTextContent("By Dana");
    // A page of the site opens on the site itself.
    expect(within(actions[0] as HTMLElement).getByRole("link")).toHaveAttribute(
      "href",
      "https://mezonas.com/pricing",
    );
  });

  it("marks an action Done or Not now, opens one again, and marks the report read", async () => {
    const posted: { action: string; body: unknown }[] = [];
    const record =
      (action: string) =>
      ({ init }: { init: RequestInit }) => {
        posted.push({ action, body: JSON.parse(String(init.body)) });
        return { result: {} };
      };
    renderAt(`/ops/clients/${CLIENT}/marketing/reports/${REPORT}`, {
      [itemPath]: () => ({ report: DETAIL }),
      [actionPath("decide-report-action")]: record("decide"),
      [actionPath("mark-report-read")]: record("read"),
    });
    const actions = await screen.findAllByTestId("marketing-report-action");
    fireEvent.click(within(actions[1] as HTMLElement).getByTestId("marketing-report-action-done"));
    await waitFor(() => expect(posted).toHaveLength(1));
    fireEvent.click(
      within(actions[2] as HTMLElement).getByTestId("marketing-report-action-not-now"),
    );
    await waitFor(() => expect(posted).toHaveLength(2));
    fireEvent.click(
      within(actions[0] as HTMLElement).getByTestId("marketing-report-action-reopen"),
    );
    await waitFor(() => expect(posted).toHaveLength(3));
    fireEvent.click(screen.getByTestId("marketing-report-read-mark"));
    await waitFor(() => expect(posted).toHaveLength(4));
    expect(posted).toEqual([
      { action: "decide", body: { reportId: REPORT, idx: 1, decision: "done" } },
      { action: "decide", body: { reportId: REPORT, idx: 2, decision: "not_now" } },
      { action: "decide", body: { reportId: REPORT, idx: 0, decision: "open" } },
      { action: "read", body: { reportId: REPORT } },
    ]);
  });
});

describe("the forum watch", () => {
  const forumPath = `GET /api/ops/clients/${CLIENT}/reports/marketing/forum`;

  it("approves a reply naming who posts it, and marks an approved one posted", async () => {
    const posted: { action: string; body: unknown }[] = [];
    const record =
      (action: string) =>
      ({ init }: { init: RequestInit }) => {
        posted.push({ action, body: JSON.parse(String(init.body)) });
        return { result: {} };
      };
    renderAt(`/ops/clients/${CLIENT}/marketing/forum`, {
      [forumPath]: () => ({ report: FORUM }),
      [actionPath("decide-forum-reply")]: record("decide"),
      [actionPath("mark-forum-posted")]: record("posted"),
    });
    const waiting = await screen.findByTestId("marketing-forum-waiting-row");
    expect(waiting).toHaveTextContent("Ask HN: How do you approve vendor bills?");
    expect(waiting).toHaveTextContent("I work at Mezonas. What worked for us");
    const approve = within(waiting).getByTestId("marketing-forum-reply-approve");
    expect(approve).toBeDisabled();
    fireEvent.change(within(waiting).getByTestId("marketing-forum-poster-select"), {
      target: { value: PERSON },
    });
    fireEvent.click(approve);
    await waitFor(() => expect(posted).toHaveLength(1));
    const toPost = screen.getByTestId("marketing-forum-topost-row");
    expect(toPost).toHaveTextContent("For Dana to post");
    fireEvent.click(within(toPost).getByTestId("marketing-forum-reply-posted"));
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted).toEqual([
      { action: "decide", body: { replyId: REPLY, decision: "approve", posterUserId: PERSON } },
      { action: "posted", body: { replyId: APPROVED } },
    ]);
    expect(screen.getByTestId("marketing-forum-thread-row")).toHaveTextContent("Passed over");
  });

  it("turns a reply down with a reason, and adds a thread for the watch", async () => {
    const posted: { action: string; body: unknown }[] = [];
    const record =
      (action: string) =>
      ({ init }: { init: RequestInit }) => {
        posted.push({ action, body: JSON.parse(String(init.body)) });
        return { result: {} };
      };
    renderAt(`/ops/clients/${CLIENT}/marketing/forum`, {
      [forumPath]: () => ({ report: FORUM }),
      [actionPath("decide-forum-reply")]: record("decide"),
      [actionPath("add-forum-thread")]: record("add"),
    });
    const waiting = await screen.findByTestId("marketing-forum-waiting-row");
    fireEvent.click(within(waiting).getByTestId("marketing-forum-reply-reject"));
    fireEvent.change(within(waiting).getByTestId("marketing-forum-reason-input"), {
      target: { value: "Reads like an ad." },
    });
    fireEvent.click(within(waiting).getByTestId("marketing-forum-reply-reject-confirm"));
    await waitFor(() => expect(posted).toHaveLength(1));
    fireEvent.change(screen.getByTestId("marketing-forum-add-url-input"), {
      target: { value: " https://news.ycombinator.com/item?id=4545 " },
    });
    fireEvent.change(screen.getByTestId("marketing-forum-add-title-input"), {
      target: { value: "Ask HN: Approvals by email?" },
    });
    fireEvent.click(screen.getByTestId("marketing-forum-add-create"));
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted).toEqual([
      {
        action: "decide",
        body: { replyId: REPLY, decision: "reject", reason: "Reads like an ad." },
      },
      {
        action: "add",
        body: {
          url: "https://news.ycombinator.com/item?id=4545",
          title: "Ask HN: Approvals by email?",
        },
      },
    ]);
  });
});
