// The Feedback page's Dev queue tab (docs/plan.md §1.125): the two tabs with their open counts,
// the list, and a request's page where every move's button shows and one its guard refuses is
// disabled with the server's reason beside it.
import type { CodeRequestDetail } from "@countersign/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { fakeApi, OPERATOR_SESSION } from "../../test/fixtures";

const RID = "00000000-0000-4000-8000-0000000dq012";
const BUILD = "00000000-0000-4000-8000-0000000b0001";

const request = (over: Partial<CodeRequestDetail> = {}): CodeRequestDetail => ({
  id: RID,
  number: 12,
  ref: "DQ-012",
  title: "Add date offsets to Reshape data",
  kind: "extend_existing",
  status: "triage",
  inReview: false,
  decision: "extend",
  owner: "Mezonas engineering",
  claimedBy: null,
  prUrl: null,
  expectedPartId: null,
  shippedPartId: null,
  shippedStagingAt: null,
  shippedProductionAt: null,
  builds: [{ id: BUILD, title: "Monthly report" }],
  coveredBy: null,
  createdBy: "builder",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  spec: {
    summary: "Run date minus N days, months or years.",
    inputs: ["a date"],
    outputs: ["a date"],
    rules: [],
    acceptance: ["Start of month of 17 November is 1 November"],
    parts: ["data.reshape#dateOffset"],
    packages: [],
  },
  openQuestions: [],
  reuseCheck: {
    ranAt: new Date().toISOString(),
    unjudged: true,
    candidates: [
      {
        partType: "operation",
        partId: "data.reshape#daysBetween",
        name: "Reshape data: daysBetween",
        score: 0.42,
        relevant: true,
        verdict: null,
        reason: "",
        missing: "",
        judgedBy: null,
        number: null,
        open: null,
      },
    ],
  },
  decisionReason: "Reshape's one-value operations are where a date offset belongs.",
  otherUses: ["Weekly AR aging summary"],
  oneOffApprovedAt: null,
  mergedInto: null,
  closeReason: null,
  closedAt: null,
  links: [
    {
      id: "l1",
      buildId: BUILD,
      buildTitle: "Monthly report",
      workflowId: "monthly",
      stepId: "offset",
      issueId: null,
      issueTitle: null,
      issueOpen: null,
      createdAt: new Date().toISOString(),
    },
  ],
  events: [
    {
      id: "e1",
      at: new Date().toISOString(),
      actor: "builder",
      userName: null,
      kind: "status",
      body: { to: "triage" },
    },
  ],
  moves: {
    accept: { allowed: false, reason: "“Reshape data: daysBetween” has no verdict yet." },
    claim: { allowed: false, reason: "Only an accepted request can be claimed." },
    attach_pr: { allowed: false, reason: "Claim it first: a PR goes on a request in progress." },
    close: { allowed: true, reason: "" },
    rerun_reuse: { allowed: true, reason: "" },
    approve_one_off: { allowed: false, reason: "It isn't decided as a one-off." },
  },
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

describe("the Dev queue tab", () => {
  it("shows both tabs with their open counts and lists the requests", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/feedback": () => ({ items: [] }),
      "GET /api/ops/code-requests": () => ({ requests: [request()], openCount: 1 }),
    });
    renderAt("/ops/utilities/feedback?tab=dev-queue", api);
    const tabs = await screen.findByTestId("ops-feedback-tabs");
    expect(within(tabs).getByTestId("ops-feedback-tab-user-feedback")).toHaveTextContent(
      "User feedback 0",
    );
    await waitFor(() =>
      expect(within(tabs).getByTestId("ops-feedback-tab-dev-queue")).toHaveTextContent(
        "Dev queue 1",
      ),
    );
    const row = await screen.findByTestId("dev-queue-row-DQ-012");
    expect(row).toHaveTextContent("Add date offsets to Reshape data");
    expect(row).toHaveTextContent("Extend a part");
    expect(row).toHaveTextContent("Triage");
    expect(row).toHaveTextContent("Monthly report");
  });

  it("disables a refused move with its reason, and closes only with a reason", async () => {
    const bodies: unknown[] = [];
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/feedback": () => ({ items: [] }),
      "GET /api/ops/code-requests": () => ({ requests: [request()], openCount: 1 }),
      "GET /api/ops/code-requests/DQ-012": () => request(),
      [`POST /api/ops/code-requests/${RID}/close`]: ({ init }) => {
        bodies.push(JSON.parse(String(init.body)));
        return request({ status: "closed", closeReason: "not_worth_it" });
      },
    });
    renderAt("/ops/utilities/feedback?tab=dev-queue&request=DQ-012", api);
    const accept = await screen.findByTestId("dev-queue-accept");
    expect(accept).toBeDisabled();
    expect(screen.getByTestId("dev-queue-why-accept")).toHaveTextContent(
      "“Reshape data: daysBetween” has no verdict yet.",
    );
    expect(screen.getByTestId("dev-queue-claim")).toBeDisabled();
    expect(screen.getByTestId("dev-queue-why-claim")).toHaveTextContent(
      "Only an accepted request can be claimed.",
    );
    // The reuse check's candidate, with its score, judged here while in triage.
    expect(screen.getByTestId("dev-queue-candidate-data.reshape#daysBetween")).toHaveTextContent(
      "0.42",
    );
    const user = userEvent.setup();
    await user.click(screen.getByTestId("dev-queue-close"));
    const confirm = screen.getByTestId("dev-queue-close-confirm");
    expect(confirm).toBeDisabled();
    await user.selectOptions(screen.getByTestId("dev-queue-close-reason"), "not_worth_it");
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await waitFor(() => expect(bodies).toEqual([{ reason: "not_worth_it" }]));
  });
});
