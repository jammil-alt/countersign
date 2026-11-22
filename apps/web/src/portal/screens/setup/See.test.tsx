// See it work (docs/setup-plan.md §6; docs/plan.md §1.185, SU4 and SU5): the one agent being set up
// opens at once (several: a picker); its steps from the SOP with how each works, who and why;
// Looks right and We do it differently (sent to the lead); the settings within bounds; then a try
// on a real document, its steps appearing as it runs (read again every two seconds), Right or Not
// right because…, and the tries left. A viewer reads only.
import type {
  AdjustRowView,
  GettingStartedView,
  SopView,
  TryView,
  WalkthroughView,
} from "@countersign/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../../App";
import { CLIENT_SESSION, fakeApi } from "../../../test/fixtures";

const SLOW = 20_000;
const AGENT = "00000000-0000-4000-8000-0000000a0001";
const OTHER = "00000000-0000-4000-8000-0000000a0002";
const DOC = "00000000-0000-4000-8000-0000000dc001";
const RUN = "00000000-0000-4000-8000-0000000e0001";
const LUIS = { key: "luis", kind: "person" as const, name: "Luis Ortega" };
const MARK = { key: "mark", kind: "person" as const, name: "Mark Lee" };

const line = (agentId: string, name: string) => ({
  agentId,
  name,
  description: null,
  stage: "bench" as const,
  left: [],
});

function overview(agents = [line(AGENT, "Bill clerk")]): GettingStartedView {
  return {
    agents,
    chapters: [],
    lead: { name: "Ana Navarro" },
    minutesLeft: 3,
  };
}

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

const SOP: SopView = {
  agent: { id: AGENT, name: "Bill clerk", key: "agent:bill-clerk" },
  format: 1,
  code: "SOP-PUR-01",
  client: "Hartley Millwork",
  area: { id: "purchasing", words: "Purchasing" },
  stage: { id: "bench", words: "Being set up" },
  asOf: "2026-11-22T09:00:00.000Z",
  revision: null,
  previous: null,
  accountable: [],
  owner: null,
  lead: null,
  purpose: "Enter every vendor bill into QuickBooks.",
  scope: { covers: [], notCovered: [], never: [] },
  roles: [],
  matrix: { parties: [], rows: [] },
  start: { triggers: ["A document has been read"], hours: null, runByHand: null },
  summary: { steps: 3, rules: 1, ai: 1, rulesThenAi: 0, person: 1, writesByRules: true },
  procedure: [
    step({
      id: "read",
      number: "1",
      name: "Read the bill",
      method: "ai",
      model: "Claude Sonnet 5.5",
      purpose: "Takes the vendor, lines and total from the PDF.",
    }),
    step({
      id: "code",
      number: "2",
      name: "Code each line to a job",
      purpose: "From your open jobs and this vendor's past bills.",
    }),
    { line: "path", depth: 1, label: "if", letter: "A", words: "it isn't sure", empty: false },
    step({
      id: "ask",
      number: "2 A1",
      depth: 1,
      name: "Ask about the job",
      method: "person",
      who: MARK,
    }),
    step({
      id: "create",
      number: "3",
      name: "Make a draft bill in QuickBooks",
      purpose: "With the PDF attached, once it's approved.",
      approval: {
        level: "ask",
        approvers: [{ party: LUIS, condition: null }],
        byWhen: null,
        ifNoAnswer: null,
        ifRejected: null,
      },
    }),
  ],
  outline: [],
  controls: [],
  systems: [],
  data: [],
  learned: null,
  exceptions: [],
  decisions: [],
  setup: [],
  settings: [],
  measures: [],
  references: { follows: [], handsOverTo: [], takesOverFrom: [], knowledge: [] },
  history: [],
};

const SETTING: AdjustRowView = {
  id: "param-amount",
  label: "Approval amount",
  hint: "Bills over it need Luis.",
  kind: "number",
  current: "5000",
  min: "0",
  max: "10000",
  options: null,
  tighter: "lower",
  changedBy: null,
  changedSide: null,
  changedAt: null,
};

function walk(over: Partial<WalkthroughView> = {}): WalkthroughView {
  return {
    agentId: AGENT,
    name: "Bill clerk",
    marks: [],
    tries: { used: 0, max: 3, recent: [] },
    candidates: [
      {
        documentId: DOC,
        title: "Northside Lumber · $4,812.50",
        from: "ap@northside.example.com",
        at: "2026-11-19T15:00:00.000Z",
      },
    ],
    canTry: true,
    canSign: true,
    ...over,
  };
}

function tried(over: Partial<TryView> = {}): TryView {
  return {
    runId: RUN,
    title: "Northside Lumber · $4,812.50",
    status: "running",
    startedAt: "2026-11-22T10:00:00.000Z",
    steps: [],
    ...over,
  };
}

const WOULD = {
  id: "create",
  name: "Make a draft bill in QuickBooks",
  state: "done" as const,
  summary:
    "Would make a draft bill in QuickBooks (test run, not written). Would ask Luis Ortega first.",
  person: true,
  verdict: null,
};

function setup(path: string, view = walk(), agents = overview()) {
  const sent: { route: string; body: unknown }[] = [];
  let current = view;
  let polls = 0;
  const api = fakeApi({
    "GET /api/session": () => CLIENT_SESSION,
    "GET /api/feedback/status": () => ({ enabled: false }),
    "GET /api/intake": () => ({ intake: null }),
    "GET /api/setup": () => ({ agents: [] }),
    "GET /api/getting-started": () => agents,
    [`GET /api/services/${AGENT}/sop`]: () => SOP,
    [`GET /api/services/${AGENT}/adjustable`]: () => ({ settings: [SETTING] }),
    [`GET /api/getting-started/agents/${AGENT}/walkthrough`]: () => current,
    [`POST /api/getting-started/agents/${AGENT}/steps/read`]: ({ init }) => {
      const body = JSON.parse(String(init.body));
      sent.push({ route: "mark:read", body });
      current = walk({
        marks: [
          {
            stepId: "read",
            state: "ok",
            byName: "Demo admin",
            at: "2026-11-22T10:00:00.000Z",
            text: null,
            request: null,
          },
        ],
      });
      return current;
    },
    [`POST /api/getting-started/agents/${AGENT}/steps/code`]: ({ init }) => {
      const body = JSON.parse(String(init.body));
      sent.push({ route: "mark:code", body });
      current = walk({
        marks: [
          {
            stepId: "code",
            state: "asked",
            byName: "Demo admin",
            at: "2026-11-22T10:00:00.000Z",
            text: body.different,
            request: { id: "00000000-0000-4000-8000-0000000f0001", number: 12 },
          },
        ],
      });
      return current;
    },
    [`POST /api/getting-started/agents/${AGENT}/try`]: ({ init }) => {
      sent.push({ route: "try", body: JSON.parse(String(init.body)) });
      return { try: tried() };
    },
    [`GET /api/getting-started/agents/${AGENT}/tries/${RUN}`]: () => {
      polls += 1;
      if (polls === 1) return { try: tried({ steps: [{ ...WOULD, state: "running" }] }) };
      current = walk({
        canTry: true,
        tries: { used: 1, max: 3, recent: [tried({ status: "done", steps: [WOULD] })] },
      });
      return { try: tried({ status: "done", steps: [WOULD] }) };
    },
    [`POST /api/getting-started/agents/${AGENT}/tries/${RUN}/steps/create`]: ({ init }) => {
      const body = JSON.parse(String(init.body));
      sent.push({ route: "verdict", body });
      return {
        try: tried({
          status: "done",
          steps: [{ ...WOULD, verdict: body.right ? "right" : "not_right" }],
        }),
      };
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

describe("See it work", () => {
  it(
    "opens the one agent being set up with its steps: how each works, who and why",
    async () => {
      setup("/getting-started/see");
      const read = await screen.findByTestId("see-step-read");
      expect(read).toHaveTextContent("Read the bill");
      expect(read).toHaveTextContent("AI · Claude Sonnet 5.5");
      expect(read).toHaveTextContent("Takes the vendor, lines and total from the PDF.");
      const code = screen.getByTestId("see-step-code");
      // What a step holds is read with it: the path and the person who answers.
      expect(code).toHaveTextContent("it isn't sure");
      expect(code).toHaveTextContent("2 A1 Ask about the job");
      expect(screen.queryByTestId("see-step-ask")).toBeNull();
      expect(screen.getByTestId("see-step-create")).toHaveTextContent("Asks Luis Ortega first");
      // The settings within bounds are the agent's own Settings card.
      expect(await screen.findByTestId("agent-adjust")).toHaveTextContent("Approval amount");
      expect(screen.getByTestId("start-see-tries-left")).toHaveTextContent("3 of 3 tries left.");
      expect(screen.getByTestId(`see-candidate-${DOC}`)).toHaveTextContent(
        "Northside Lumber · $4,812.50",
      );
      expect(screen.queryByTestId("start-see-agents")).toBeNull();
    },
    SLOW,
  );

  it(
    "picks among several agents",
    async () => {
      setup(
        "/getting-started/see",
        walk(),
        overview([line(AGENT, "Bill clerk"), line(OTHER, "Vendor contracts")]),
      );
      const picker = await screen.findByTestId("start-see-agents");
      expect(screen.getByText("Pick an agent to see how it works.")).toBeInTheDocument();
      await userEvent.click(within(picker).getByRole("button", { name: "Bill clerk" }));
      expect(await screen.findByTestId("see-step-read")).toBeInTheDocument();
      expect(within(picker).getByRole("button", { name: "Bill clerk" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    },
    SLOW,
  );

  it(
    "says Looks right, and sends a different way to the lead",
    async () => {
      const { sent } = setup(`/getting-started/see/${AGENT}`);
      const read = await screen.findByTestId("see-step-read");
      await userEvent.click(within(read).getByRole("button", { name: "Looks right" }));
      await waitFor(() => expect(sent[0]).toEqual({ route: "mark:read", body: { ok: true } }));
      expect(await screen.findByTestId("see-step-read-ok")).toHaveTextContent(
        "Looks right · Demo admin",
      );

      const code = screen.getByTestId("see-step-code");
      await userEvent.click(within(code).getByRole("button", { name: "We do it differently" }));
      await userEvent.type(
        screen.getByTestId("see-step-code-text"),
        "Freight goes to overhead, not the job.",
      );
      await userEvent.click(screen.getByRole("button", { name: "Send to Ana" }));
      await waitFor(() =>
        expect(sent[1]).toEqual({
          route: "mark:code",
          body: { different: "Freight goes to overhead, not the job." },
        }),
      );
      const asked = await screen.findByTestId("see-step-code-asked");
      expect(asked).toHaveTextContent("You said: “Freight goes to overhead, not the job.”");
      expect(asked).toHaveTextContent("Ana has this. We'll show you the change before it's used.");
      expect(asked).toHaveTextContent("Request #12");
    },
    SLOW,
  );

  it(
    "tries it on a real one: its steps appear as it runs, then a step is not right",
    async () => {
      const { sent } = setup(`/getting-started/see/${AGENT}`);
      await userEvent.click(await screen.findByRole("button", { name: "Try this one" }));
      await waitFor(() => expect(sent[0]).toEqual({ route: "try", body: { documentId: DOC } }));
      const card = await screen.findByTestId(`see-try-${RUN}`);
      expect(card).toHaveTextContent("Test run · nothing written or sent");
      expect(within(card).getByTestId(`see-try-${RUN}-status`)).toHaveTextContent("Running");
      // Read again every two seconds: the write appears, worded as what it would do.
      const row = await screen.findByTestId("see-try-step-create", {}, { timeout: 4000 });
      expect(row).toHaveTextContent(
        "Would make a draft bill in QuickBooks (test run, not written). Would ask Luis Ortega first.",
      );
      expect(screen.getByTestId("start-see-tries-left")).toHaveTextContent("2 of 3 tries left.");
      expect(within(row).queryByRole("button", { name: "Right" })).toBeNull();
      // Once done, the view is read again, and each step can be judged.
      await waitFor(
        () => expect(screen.getByTestId(`see-try-${RUN}-status`)).toHaveTextContent("Done"),
        { timeout: 5000 },
      );
      const done = screen.getByTestId("see-try-step-create");
      await userEvent.click(within(done).getByRole("button", { name: "Not right because…" }));
      await userEvent.type(
        screen.getByTestId("see-try-step-create-because"),
        "Luis doesn't sign bills under $5,000.",
      );
      await userEvent.click(within(done).getByRole("button", { name: "Send to Ana" }));
      await waitFor(() =>
        expect(sent.at(-1)).toEqual({
          route: "verdict",
          body: { right: false, because: "Luis doesn't sign bills under $5,000." },
        }),
      );
      expect(await screen.findByText("You said: not right.")).toBeInTheDocument();
    },
    SLOW,
  );

  it("reads only, for a viewer", async () => {
    setup(`/getting-started/see/${AGENT}`, walk({ canSign: false, canTry: false }));
    const read = await screen.findByTestId("see-step-read");
    expect(screen.getByTestId("start-see-read-only")).toBeInTheDocument();
    expect(within(read).queryByRole("button", { name: "Looks right" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Try this one" })).toBeNull();
  });
});
