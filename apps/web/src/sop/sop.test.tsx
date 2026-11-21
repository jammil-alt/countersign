// docs/sop-plan.md S1: the agent's SOP tab in the portal (in the Manual tab's place). It reads the
// portal's view made by code: document control with the revision, its date and what changed; the
// procedure as a list with how each step works (rules, AI with its model, a person) and why it is
// there; people and agents told apart by icon; nothing that waits on anyone. Find and the filters
// narrow it; "This is wrong" sends a request about a step; the old manual address opens the SOP.

import type { SopView } from "@countersign/core";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../App";
import { CLIENT_SESSION, fakeApi, Reply } from "../test/fixtures";

const SVC = "00000000-0000-4000-8000-00000000b501";
const ADA = { key: "ada", kind: "person" as const, name: "Ada Ruiz" };
const BEN = { key: "ben", kind: "person" as const, name: "Ben Ortiz" };
const CARA = { key: "cara", kind: "person" as const, name: "Cara Lin" };
const PIA = { key: "owner:purchasing", kind: "agent" as const, name: "Pia" };
const ME = { key: "agent:bills-in", kind: "agent" as const, name: "Bills in" };

const step = (
  s: Partial<SopView["procedure"][number] & { line: "step" }> & {
    id: string;
    number: string;
    name: string;
  },
) => ({
  line: "step" as const,
  depth: 0,
  workflow: null,
  kindWords: "Works it out",
  method: "rules" as const,
  model: null,
  purpose: "",
  purposeWritten: true,
  who: null,
  approval: null,
  told: [],
  systems: [],
  data: [],
  controls: [],
  onError: null,
  byWhen: null,
  ...s,
});

const REV = {
  number: "7.2",
  at: "2026-11-18T10:00:00.000Z",
  changes: [
    {
      section: "procedure" as const,
      ref: "6",
      words: "Step 6 is approved by Ada Ruiz over $5,000, Ben Ortiz up to $5,000",
      was: "Ada Ruiz over $10,000, Ben Ortiz up to $10,000",
    },
  ],
  by: "Ada Ruiz",
  where: "Approval rules",
};

const VIEW: SopView = {
  agent: { id: SVC, name: "Bills in", key: ME.key },
  code: "SOP-PUR-03",
  client: "Harbor Millwork",
  area: { id: "purchasing", words: "Purchasing" },
  stage: { id: "live", words: "Live" },
  asOf: "2026-11-21T09:14:00.000Z",
  revision: REV,
  previous: { number: "7.1", at: "2026-11-15T10:00:00.000Z" },
  accountable: [ADA],
  owner: { party: PIA, model: "Claude Opus 5.5" },
  lead: { key: "lead", kind: "person", name: "Sam Patel" },
  purpose: "Enter every vendor bill into QuickBooks.",
  scope: {
    covers: ["A document arrives"],
    notCovered: ["Bills in another currency. A person handles it."],
    never: ["Moves money"],
  },
  roles: [
    {
      role: "Does the work",
      party: ME,
      words: "Does every step unless a step names a person or another agent.",
    },
  ],
  matrix: {
    parties: [PIA, ADA, BEN, CARA],
    rows: [
      {
        step: "1",
        name: "Read the bill",
        cells: ["checks", "", "", ""],
        notes: [null, null, null, null],
      },
      {
        step: "2.1",
        name: "Review the price alert",
        cells: ["", "", "", "does"],
        notes: [null, null, null, null],
      },
      {
        step: "3",
        name: "Create the bill",
        cells: ["checks", "approves", "approves", ""],
        notes: [null, "Over $5,000", "Up to $5,000", null],
      },
    ],
  },
  start: {
    triggers: ["A document arrives"],
    hours: "Monday to Friday, 08:00 to 18:00 (America/Chicago)",
    runByHand: null,
  },
  summary: { steps: 4, rules: 2, ai: 1, rulesThenAi: 0, person: 1, writesByRules: true },
  procedure: [
    step({
      id: "read",
      number: "1",
      name: "Read the bill",
      method: "ai",
      model: "Claude Sonnet 5.5",
      purpose: "Turns the PDF into lines and totals.",
    }),
    step({
      id: "look",
      number: "2",
      name: "Does a person need to look first?",
      purpose: "Sends a flagged bill to a person first.",
    }),
    { line: "path", depth: 1, label: "if", words: "a price alert or a new vendor", empty: false },
    step({
      id: "review",
      number: "2.1",
      depth: 1,
      name: "Review the price alert",
      method: "person",
      who: CARA,
      purpose: "Cara decides whether it goes ahead.",
      byWhen: "1 business day; if nobody answers, Sam Patel is asked",
    }),
    { line: "path", depth: 1, label: "otherwise", words: "", empty: true },
    step({
      id: "create",
      number: "3",
      name: "Create the bill in QuickBooks",
      purpose: "Writes the bill exactly as approved.",
      purposeWritten: false,
      approval: {
        level: "ask",
        approvers: [
          { party: ADA, condition: "over $5,000" },
          { party: BEN, condition: "up to $5,000" },
        ],
        byWhen: "2 business days",
        ifNoAnswer: "the run stops",
        ifRejected: "the change isn't made and the run stops",
      },
      systems: [{ id: "S1", name: "QuickBooks Online", verb: "Create", level: "ask" }],
      data: [{ id: "D1", words: "Creates bills" }],
      controls: ["C1", "C2"],
    }),
  ],
  controls: [
    {
      id: "C1",
      key: "approval:create",
      name: 'A person approves before "Create the bill in QuickBooks" changes QuickBooks Online',
      kind: "prevents",
      how: "person",
      model: null,
      steps: ["3"],
      allSteps: false,
      owner: BEN,
      evidence: "The approval in each run's audit trail",
    },
    {
      id: "C2",
      key: "owner",
      name: "Pia reviews failed steps and steps that lead to a change",
      kind: "catches",
      how: "ai",
      model: "Claude Opus 5.5",
      steps: ["1", "3"],
      allSteps: false,
      owner: PIA,
      evidence: "Pia's decisions in each run",
    },
  ],
  systems: [
    {
      id: "S1",
      key: "qbo",
      name: "QuickBooks Online",
      account: "Harbor Millwork LLC",
      connected: true,
      connectedBy: "Ada Ruiz",
      read: "auto",
      create: "ask",
      update: "auto",
      delete: "off",
      steps: ["3"],
    },
  ],
  data: [
    {
      id: "D1",
      key: "bill",
      record: "Bill",
      livesIn: "Your QuickBooks Online",
      agentDoes: "Changes",
      steps: ["3"],
      readByAi: null,
      kept: "In QuickBooks Online",
    },
  ],
  learned: null,
  exceptions: [{ id: "fails", words: "A step fails: the run stops and your team is told." }],
  decisions: [
    {
      id: "freight",
      what: "Freight stays out of the catalog",
      value: null,
      kind: "assumption",
      step: "1",
      setBy: "Us",
    },
  ],
  setup: [],
  settings: [],
  measures: [{ label: "Bills entered, this month", value: "142" }],
  references: {
    follows: ["How Mezonas agents work"],
    handsOverTo: [],
    takesOverFrom: [],
    knowledge: [],
  },
  history: [
    REV,
    {
      number: "7.1",
      at: "2026-11-15T10:00:00.000Z",
      changes: [{ section: "decisions", ref: null, words: "Price tolerance: 3%", was: "2%" }],
      by: "Ada Ruiz",
      where: "This agent's settings",
    },
  ],
};

const DETAIL = {
  service: {
    id: SVC,
    name: "Bills in",
    description: "Bills into QuickBooks",
    status: "active",
    stage: "live",
    templateSlug: null,
    kpis: [],
  },
  thisMonth: {
    from: "2026-11-01",
    to: "2026-11-04",
    runs: { total: 0, succeeded: 0, failed: 0, cancelled: 0, waiting: 0, going: 0 },
    documentsRead: 0,
    actions: 0,
  },
  recentRuns: [],
  packs: [],
};

function portal(path = `/agents/${SVC}/sop`, view: SopView = VIEW) {
  const api = fakeApi({
    "GET /api/session": () => CLIENT_SESSION,
    "GET /api/overview": () => new Reply(404, {}),
    "GET /api/feedback/status": () => ({ enabled: false }),
    [`GET /api/services/${SVC}`]: () => DETAIL,
    [`GET /api/services/${SVC}/sop`]: () => view,
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

describe("the portal's SOP tab", () => {
  it("replaces the Manual tab, and the manual's old address opens it", async () => {
    const api = portal(`/agents/${SVC}/manual`);
    await screen.findByTestId("sop");
    expect(api.calls).toContain(`GET /api/services/${SVC}/sop`);
    expect(screen.getByRole("link", { name: "SOP" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Manual" })).toBeNull();
  });

  it("heads with its revision, its date and what changed, with nothing waiting on anyone", async () => {
    portal();
    const control = await screen.findByTestId("sop-control");
    expect(within(control).getByTestId("sop-code")).toHaveTextContent("SOP-PUR-03");
    expect(within(control).getByTestId("sop-revision")).toHaveTextContent("7.2");
    expect(within(control).getByTestId("sop-revision-date")).not.toHaveTextContent("–");
    expect(within(control).getByTestId("sop-last-change")).toHaveTextContent(
      "What changed in revision 7.2",
    );
    expect(within(control).getByTestId("sop-last-change")).toHaveTextContent(
      "was Ada Ruiz over $10,000, Ben Ortiz up to $10,000",
    );
    expect(screen.getByTestId("sop")).not.toHaveTextContent(/Waiting on you|Never discussed/);
    expect(screen.getByTestId("sop-history")).toHaveTextContent("Price tolerance: 3%; was 2%");
  });

  it("lists the steps with how each works, its model, its purpose, and who only when not the agent", async () => {
    portal();
    const steps = await screen.findAllByTestId("sop-step");
    expect(steps).toHaveLength(4);
    expect(within(steps[0] as HTMLElement).getByTestId("sop-method")).toHaveTextContent(
      "AIClaude Sonnet 5.5",
    );
    expect(within(steps[0] as HTMLElement).getByTestId("sop-purpose")).toHaveTextContent(
      "Turns the PDF into lines and totals.",
    );
    // The agent's own name is said once, not on its steps.
    expect(within(steps[0] as HTMLElement).queryByText("Bills in")).toBeNull();
    expect(within(steps[2] as HTMLElement).getByTestId("sop-party")).toHaveTextContent("Cara Lin");
    expect(steps[3]).toHaveTextContent("Approves Ada Ruiz over $5,000 Ben Ortiz up to $5,000");
    expect(steps[3]).toHaveTextContent("Create: Ask me first");
    expect(screen.getByTestId("sop-summary")).toHaveTextContent(
      "Bills in does every step unless one names a person or another agent. 4 steps: 2 by rules, 1 by AI, 0 by rules then AI, 1 by a person. Every change to your tools is made by rules.",
    );
    // Who else takes part leaves the agent itself out.
    expect(within(screen.getByTestId("sop-matrix")).queryByText("Bills in")).toBeNull();
  });

  it("filters the procedure by a person, and Find narrows every section", async () => {
    portal();
    await screen.findByTestId("sop");
    const u = userEvent.setup();
    const cara = within(screen.getAllByTestId("sop-step")[2] as HTMLElement).getByTestId(
      "sop-party",
    );
    await u.click(cara);
    expect(screen.getAllByTestId("sop-step")).toHaveLength(1);
    expect(screen.getByTestId("sop-filter-note")).toHaveTextContent(
      "Showing the steps Cara Lin takes part in.",
    );
    await u.click(screen.getByTestId("sop-clear"));
    expect(screen.getAllByTestId("sop-step")).toHaveLength(4);
    await u.type(screen.getByTestId("sop-find"), "quickbooks");
    expect(screen.getAllByTestId("sop-step")).toHaveLength(1);
    expect(screen.getByTestId("sop-filter-note")).toHaveTextContent(/places match “quickbooks”/);
  });

  it("sends 'This is wrong because…' about a step, linked to it", async () => {
    const api = portal();
    let sent: unknown = null;
    api.on(`POST /api/services/${SVC}/manual/feedback`, ({ init }) => {
      sent = JSON.parse(String(init.body));
      return { request: { id: "00000000-0000-4000-8000-0000000d0002", number: 9 } };
    });
    const steps = await screen.findAllByTestId("sop-step");
    const create = steps[3] as HTMLElement;
    const u = userEvent.setup();
    await u.click(within(create).getByTestId("sop-wrong"));
    await u.type(within(create).getByTestId("manual-wrong-input"), "Ben approves up to $2,000.");
    await u.click(within(create).getByTestId("manual-wrong-send"));
    expect(await within(create).findByTestId("manual-wrong-sent")).toHaveTextContent("request #9");
    expect(sent).toEqual({
      section: "how",
      lineId: "create",
      line: "3. Create the bill in QuickBooks",
      because: "Ben approves up to $2,000.",
    });
  });

  it("prints from its own button", async () => {
    portal();
    await screen.findByTestId("sop");
    const printed: string[] = [];
    const original = window.print;
    window.print = () => printed.push("print");
    await userEvent.setup().click(screen.getByTestId("sop-print"));
    window.print = original;
    expect(printed).toEqual(["print"]);
  });
});
