// Go live (docs/setup-plan.md §7; docs/plan.md §1.199, SU6): with one agent it opens; the scope as
// a list in the client's words; the sign card with Sign for the client admin; what happens next;
// a version signed before asks again; someone who isn't the admin reads it only.
import type { GettingStartedView, ScopeView } from "@countersign/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../../App";
import { CLIENT_SESSION, fakeApi } from "../../../test/fixtures";

const SLOW = 15_000;
const BILLS = "00000000-0000-4000-8000-0000000a0001";
const CONTRACTS = "00000000-0000-4000-8000-0000000a0002";

const line = (agentId: string, name: string, unsigned: boolean) => ({
  agentId,
  name,
  description: null,
  stage: "bench" as const,
  left: unsigned
    ? [
        {
          key: "scope",
          chapter: "live" as const,
          label: "Sign the scope",
          who: { userId: CLIENT_SESSION.user.id, name: "Dana Ruiz", me: true },
        },
      ]
    : [],
});

function overview(agents = [line(BILLS, "Bill clerk", true)]): GettingStartedView {
  return {
    agents,
    chapters: [
      { key: "business", state: "done", done: 6, total: 6 },
      { key: "tools", state: "done", done: 2, total: 2 },
      { key: "people", state: "done", done: 2, total: 2 },
      { key: "see", state: "done", done: 1, total: 1 },
      { key: "live", state: "not_started", done: 0, total: agents.length },
    ],
    lead: { name: "Ana Navarro" },
    minutesLeft: 2,
  };
}

function scope(over: Partial<ScopeView> = {}): ScopeView {
  return {
    agentId: BILLS,
    name: "Bill clerk",
    version: 1,
    does: "Reads bills sent to ap@ and makes draft bills in QuickBooks.",
    reads: ["Your QuickBooks Online: bills and vendors"],
    changes: ["Create bills in your QuickBooks Online. Each change waits for a signature."],
    signs: ["Approves bills: Dana Ruiz, with Luis Ortega as backup"],
    answers: ["Answers questions about job codes: Mark Lee"],
    choices: ["Approval amount: 5000"],
    open: [],
    signed: null,
    canSign: true,
    trialDays: 14,
    stage: "bench",
    ...over,
  };
}

function setup(path: string, view = overview(), first = scope()) {
  const sent: string[] = [];
  let current = first;
  const api = fakeApi({
    "GET /api/session": () => CLIENT_SESSION,
    "GET /api/feedback/status": () => ({ enabled: false }),
    "GET /api/getting-started": () => view,
    [`GET /api/getting-started/agents/${BILLS}/scope`]: () => ({ scope: current }),
    [`GET /api/getting-started/agents/${CONTRACTS}/scope`]: () => ({
      scope: scope({ agentId: CONTRACTS, name: "Vendor contracts" }),
    }),
    [`POST /api/getting-started/agents/${BILLS}/scope/sign`]: () => {
      sent.push("sign");
      current = {
        ...current,
        canSign: false,
        signed: { byName: "Dana Ruiz", at: "2026-11-22T10:00:00.000Z", version: current.version },
      };
      return { scope: current };
    },
  });
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
  return { api, sent };
}

describe("Go live", () => {
  it(
    "opens the one agent's scope, signs it, and says what happens next",
    async () => {
      const { sent } = setup("/getting-started/live");
      const list = await screen.findByTestId("start-live-scope");
      expect(list).toHaveTextContent("Scope · Bill clerk · version 1");
      for (const [key, label, text] of [
        ["does", "What it does", "Reads bills sent to ap@"],
        ["reads", "What it reads", "Your QuickBooks Online: bills and vendors"],
        ["changes", "What it may change", "Each change waits for a signature."],
        ["signs", "Who signs", "Dana Ruiz, with Luis Ortega as backup"],
        ["answers", "Who answers", "Mark Lee"],
        ["choices", "Your choices", "Approval amount: 5000"],
        ["open", "Still open", "Nothing"],
      ] as const) {
        const row = within(list).getByTestId(`start-live-${key}`);
        expect(row).toHaveTextContent(label);
        expect(row).toHaveTextContent(text);
      }
      const card = screen.getByTestId("start-live-sign");
      expect(card).toHaveTextContent("Waiting on you");
      expect(card).toHaveTextContent("Your Bill clerk is ready for its trial.");
      expect(card).toHaveTextContent("Sign the scope above and Ana Navarro starts the trial.");
      expect(card).toHaveTextContent("Checked by Ana Navarro, your lead");
      const next = screen.getByTestId("start-live-next");
      expect(next).toHaveTextContent("You sign the scope.");
      expect(next).toHaveTextContent("Ana Navarro starts the trial. It never starts by itself.");
      expect(next).toHaveTextContent("14 days");
      expect(next).toHaveTextContent("A check-in with Ana Navarro.");
      expect(next).toHaveTextContent("Approvals stay on unless you change them.");

      await userEvent.click(screen.getByTestId("start-live-sign-button"));
      await waitFor(() => expect(sent).toEqual(["sign"]));
      expect(await screen.findByTestId("start-live-signed")).toHaveTextContent("Signed");
      expect(screen.getByTestId("start-live-sign-body")).toHaveTextContent(
        "Signed by Dana Ruiz on Nov 22, 2026. Ana Navarro starts the trial.",
      );
      expect(screen.queryByTestId("start-live-sign-button")).toBeNull();
    },
    SLOW,
  );

  it(
    "picks among agents, each saying whether it is signed",
    async () => {
      setup(
        "/getting-started/live",
        overview([line(BILLS, "Bill clerk", true), line(CONTRACTS, "Vendor contracts", false)]),
      );
      expect(await screen.findByText("Pick an agent to read its scope.")).toBeInTheDocument();
      expect(screen.getByTestId(`start-live-agent-${BILLS}`)).toHaveTextContent("To sign");
      expect(screen.getByTestId(`start-live-agent-${CONTRACTS}`)).toHaveTextContent("Signed");
      expect(screen.queryByTestId("start-live-scope")).toBeNull();
      await userEvent.click(screen.getByTestId(`start-live-agent-${CONTRACTS}`));
      expect(await screen.findByTestId("start-live-scope")).toHaveTextContent(
        "Scope · Vendor contracts · version 1",
      );
    },
    SLOW,
  );

  it(
    "asks again for a version that changed after it was signed",
    async () => {
      setup(
        `/getting-started/live/${BILLS}`,
        overview(),
        scope({
          version: 2,
          signed: { byName: "Dana Ruiz", at: "2026-11-20T10:00:00.000Z", version: 1 },
        }),
      );
      const body = await screen.findByTestId("start-live-sign-body");
      expect(body).toHaveTextContent(
        "Version 1 was signed. This version changed, so it needs a signature again.",
      );
      expect(screen.getByTestId("start-live-sign-button")).toBeInTheDocument();
    },
    SLOW,
  );

  it(
    "reads only, for someone who isn't the admin",
    async () => {
      setup("/getting-started/live", overview(), scope({ canSign: false }));
      const card = await screen.findByTestId("start-live-sign");
      expect(card).toHaveTextContent("Waiting on your admin");
      expect(card).toHaveTextContent(
        "Your admin signs the scope. Then Ana Navarro starts the trial.",
      );
      expect(screen.queryByTestId("start-live-sign-button")).toBeNull();
    },
    SLOW,
  );
});
