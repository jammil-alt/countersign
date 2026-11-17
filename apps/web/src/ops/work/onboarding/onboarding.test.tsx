// Onboarding in the back office (docs/plan.md §1.126; docs/cases-plan.md §4): the client file on a
// deal's page (facts by section with their badges, ours marked "Only us", add, correct, history);
// Invite's five steps from a lead record, sending the draft the preview showed; Sign up now from
// Sales with a start and a price, and its "Review first" into Invite's questions; the saved
// starts; skipped stages and the intake's log on the deal's timeline; the client page's File tab.
import type {
  ClientFactView,
  ClientFileDetail,
  DealDetail,
  DealSummary,
  InvitePreview,
  OpsIntakeView,
  SalesStartView,
} from "@countersign/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../../App";
import { fakeApi, OPERATOR_SESSION, SANDBOX_DETAIL } from "../../../test/fixtures";
import { skippedStages } from "./timeline";

const at = "2026-11-17T09:00:00.000Z";
const CLIENT = "00000000-0000-4000-8000-00000000a001";
const LEAD = "00000000-0000-4000-8000-0000000d0001";
const FILE = "00000000-0000-4000-8000-0000000c0001";
const TEMPLATE = "00000000-0000-4000-8000-0000000b0001";
const START = "00000000-0000-4000-8000-000000050001";
const START_ACCOUNT = "00000000-0000-4000-8000-000000050002";
const INTAKE = "00000000-0000-4000-8000-000000060001";
const PERSON = "00000000-0000-4000-8000-000000070001";
const F1 = "00000000-0000-4000-8000-000000080001";
const F2 = "00000000-0000-4000-8000-000000080002";
const F0 = "00000000-0000-4000-8000-000000080000";

const STAGES = [
  ["lead", "Lead", "0.1"],
  ["qualified", "Qualified", "0.25"],
  ["diagnostic", "Diagnostic", "0.4"],
  ["proposal", "Proposal and contract", "0.6"],
  ["setup", "Set up the account", "0.9"],
  ["live", "First agent live", "1"],
] as const;

function summary(over: Partial<DealSummary> = {}): DealSummary {
  return {
    id: LEAD,
    kind: "new",
    client: null,
    company: "Ridgeline Dental Group",
    title: "Purchasing",
    description: "4 offices.",
    stage: "qualified",
    stageName: "Qualified",
    likelihood: "0.25",
    agentCount: 1,
    mrr: "2400.0000",
    currency: "USD",
    weighted: "600.0000",
    renewal: false,
    outcome: "open",
    waitingOn: "operator",
    statusLine: "Invite them",
    statusText: "Invite them",
    stuck: false,
    held: null,
    standing: "you",
    late: false,
    nextStep: "Invite them",
    nextDueOn: "2026-11-20",
    source: "site_form",
    origin: null,
    agreedMrr: null,
    stageAt: at,
    wonAt: null,
    closedAt: null,
    createdAt: at,
    updatedAt: at,
    ...over,
  };
}

function dealDetail(
  over: Partial<DealDetail["deal"]> = {},
  activity: DealDetail["activity"] = [],
): DealDetail {
  return {
    deal: {
      ...summary(),
      agentsSold: [{ name: "Vendor contracts", templateId: TEMPLATE }],
      outcomeReason: null,
      checkBackOn: null,
      sourceDetail: null,
      evidence: [],
      agreedFrom: null,
      signedCopy: null,
      people: [
        {
          id: "00000000-0000-4000-8000-0000000e0001",
          name: "Karen Lowe",
          email: "karen@ridgeline.example.com",
          phone: null,
          role: "Office manager",
          isPrimary: true,
        },
      ],
      fileId: FILE,
      ...over,
    },
    activity,
    builds: [],
    now: null,
    stages: STAGES.map(([id, name, p]) => ({ id, name, p })),
  };
}

function fact(over: Partial<ClientFactView>): ClientFactView {
  return {
    id: F1,
    fileId: FILE,
    section: "volumes",
    text: "About 300 supplier invoices a month.",
    sourceKind: "call",
    sources: [],
    sureness: "heard",
    audience: "theirs",
    replacesId: null,
    replacedById: null,
    actor: "operator",
    by: { id: OPERATOR_SESSION.user.id, name: "Jammil" },
    createdAt: at,
    ...over,
  };
}

function fileDetail(facts: ClientFactView[]): ClientFileDetail {
  return {
    file: {
      id: FILE,
      name: "Ridgeline Dental Group",
      website: "ridgeline.example.com",
      status: "prospect",
      client: null,
      facts: facts.filter((f) => f.replacedById === null).length,
      openDeals: 1,
      lastFactAt: at,
      createdAt: at,
      updatedAt: at,
    },
    facts,
    deals: [{ id: LEAD, kind: "new", title: "Purchasing", stage: "qualified", outcome: "open" }],
    intakes: [],
  };
}

const TEMPLATES = {
  templates: [
    {
      id: TEMPLATE,
      tenantId: null,
      kind: "template" as const,
      slug: "vendor-contracts",
      name: "Vendor contracts and invoice review",
      role: null,
      templateId: null,
      linked: false,
      liveVersionId: null,
      status: "published",
      runStatus: null,
      serviceName: "Vendor contracts and invoice review",
      serviceDescription: "Checks each bill against the contract.",
      bindings: {},
      approver: null,
      testCopy: false,
      createdAt: at,
    },
  ],
};

function start(over: Partial<SalesStartView>): SalesStartView {
  return {
    id: START,
    name: "Purchasing starter",
    covers: { general: true, areas: ["purchasing"], templateIds: [TEMPLATE] },
    note: "We'll start with how your bills come in.",
    startMode: "point",
    seeded: false,
    archived: false,
    createdAt: at,
    updatedAt: at,
    ...over,
  };
}

const STARTS = {
  starts: [
    start({}),
    start({
      id: START_ACCOUNT,
      name: "Just the account",
      covers: { general: false, areas: [], templateIds: [] },
      note: "",
      seeded: true,
    }),
  ],
};

function preview(over: Partial<InvitePreview> = {}): InvitePreview {
  return {
    confirm: [
      "Makes Ridgeline Dental Group a client in Mezonas, with you serving it.",
      "Invites Karen Lowe as its admin.",
      "Opens the intake (general and Purchasing).",
      "Moves the deal to Set up the account.",
      "Emails Karen.",
    ],
    account: { clientId: null, name: "Ridgeline Dental Group" },
    intake: {
      covers: { general: true, areas: ["purchasing"], templateIds: [] },
      startMode: "point",
      guide: {
        version: 1,
        sections: [
          {
            key: "general",
            kind: "general",
            area: null,
            templateId: null,
            title: "The business",
            intro: "How Ridgeline works today.",
            fields: [
              {
                key: "general.volumes",
                sectionKey: "general",
                alsoIn: [],
                label: "How many supplier invoices a month?",
                kind: "number",
                hint: "",
                requiredToStart: false,
                state: "to_confirm",
                weThink: { value: 300, text: "About 300 a month", factIds: [F1] },
                fileSection: "volumes",
                connector: null,
                origin: "core",
              },
              {
                key: "general.approver",
                sectionKey: "general",
                alsoIn: ["area:purchasing"],
                label: "Who approves bills?",
                kind: "text",
                hint: "",
                requiredToStart: true,
                state: "to_ask",
                weThink: null,
                fileSection: "people",
                connector: null,
                origin: "core",
              },
            ],
          },
        ],
        totals: { known: 0, toConfirm: 1, toAsk: 1, later: 0, tools: 0, minutes: 5 },
      },
      totals: { known: 0, toConfirm: 1, toAsk: 1, later: 0, tools: 0, minutes: 5 },
    },
    emails: [
      {
        to: "karen@ridgeline.example.com",
        kind: "invite",
        from: "Jammil at Mezonas <hello@mezonas.com>",
        replyTo: "jammil@mezonas.com",
        subject: "Getting started with Mezonas",
        text: "Hi Karen",
        html: "<p>Hi Karen</p>",
        sendAt: null,
      },
    ],
    welcome: {
      state: "open",
      client: "Ridgeline Dental Group",
      lead: { name: "Jammil", photoUrl: null },
      note: "We'll start with how your bills come in.",
      summary: { general: true, areas: ["purchasing"], agents: 0, minutes: 5 },
      email: "karen@ridgeline.example.com",
      expiresAt: "2026-12-01T09:00:00.000Z",
      language: "en",
    },
    todos: [{ title: "Record Ridgeline Dental Group's agreed price", dueOn: "2026-11-24" }],
    problems: [],
    ...over,
  };
}

const GUIDE = (() => {
  const intake = preview().intake;
  if (!intake) throw new Error("the preview has a guide");
  return intake.guide;
})();

const SENT = {
  clientId: CLIENT,
  fileId: FILE,
  dealId: LEAD,
  intakeId: INTAKE,
  agentIds: [],
  buildIds: [],
  people: [
    {
      personId: PERSON,
      userId: OPERATOR_SESSION.user.id,
      email: "karen@ridgeline.example.com",
      isAdmin: true,
    },
  ],
  emails: [{ to: "karen@ridgeline.example.com", status: "queued" as const }],
  todoIds: [],
};

const common = {
  "GET /api/session": () => OPERATOR_SESSION,
  "GET /api/ops/counts": () => ({ needsUs: 0, clients: [] }),
  "GET /api/ops/clients": () => ({
    clients: [
      {
        id: CLIENT,
        name: "Hartley Millwork",
        timezone: "UTC",
        createdAt: at,
        agents: 0,
        openInbox: 0,
      },
    ],
  }),
  "GET /api/ops/templates": () => TEMPLATES,
  "GET /api/ops/starts": () => STARTS,
};

function renderAt(path: string, api: ReturnType<typeof fakeApi>) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
}

const body = (init: RequestInit) => JSON.parse(String(init.body));

describe("the client file", () => {
  it("shows facts by section with their badges, adds one, corrects one and shows the history", async () => {
    const added: unknown[] = [];
    let facts = [
      fact({}),
      fact({
        id: F2,
        section: "notes",
        text: "The CFO is the real buyer.",
        sourceKind: "note",
        audience: "ours",
      }),
    ];
    const api = fakeApi({
      ...common,
      [`GET /api/ops/deals/${LEAD}`]: () => dealDetail(),
      [`GET /api/ops/client-files/${FILE}`]: ({ url }) =>
        fileDetail(
          url.searchParams.get("history") === "true"
            ? [
                ...facts,
                fact({
                  id: F0,
                  text: "About 200 invoices a month.",
                  replacedById: F1,
                  createdAt: "2026-11-10T09:00:00.000Z",
                }),
              ]
            : facts,
        ),
      [`POST /api/ops/client-files/${FILE}/facts`]: ({ init }) => {
        added.push(body(init));
        return fileDetail(facts);
      },
    });
    renderAt(`/ops/deals/${LEAD}`, api);
    await userEvent.click(await screen.findByTestId("deal-tab-file"));
    expect(await screen.findByTestId("client-file-name")).toHaveTextContent(
      "Ridgeline Dental Group",
    );
    const volumes = screen.getByTestId("client-file-section-volumes");
    expect(volumes).toHaveTextContent("About 300 supplier invoices a month.");
    expect(within(volumes).getByTestId(`fact-${F1}`)).toHaveTextContent("TheirsHeardCall");
    // Our notes are marked Only us.
    const notes = screen.getByTestId("client-file-section-notes");
    expect(within(notes).getByTestId("fact-ours")).toHaveTextContent("Only us");

    // A new fact starts Only us.
    await userEvent.click(screen.getByTestId("client-file-add-pains"));
    await userEvent.type(screen.getByTestId("fact-text"), "Price creep from two vendors.");
    expect(screen.getByTestId("fact-audience-ours")).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByTestId("fact-save"));
    await waitFor(() =>
      expect(added).toEqual([
        {
          facts: [
            {
              section: "pains",
              text: "Price creep from two vendors.",
              sourceKind: "call",
              sureness: "heard",
              audience: "ours",
            },
          ],
        },
      ]),
    );

    // A correction names the fact it replaces.
    await userEvent.click(screen.getByTestId(`fact-correct-${F1}`));
    const text = screen.getByTestId("fact-text");
    await userEvent.clear(text);
    await userEvent.type(text, "About 340 supplier invoices a month.");
    await userEvent.click(screen.getByTestId("fact-save"));
    await waitFor(() => expect(added).toHaveLength(2));
    expect(added[1]).toEqual({
      facts: [
        {
          section: "volumes",
          text: "About 340 supplier invoices a month.",
          sourceKind: "note",
          sureness: "heard",
          audience: "theirs",
          replacesId: F1,
        },
      ],
    });

    facts = [fact({ replacesId: F0 }), facts[1] as ClientFactView];
    await userEvent.click(screen.getByTestId("client-file-history"));
    expect(await screen.findByTestId(`fact-history-${F1}`)).toHaveTextContent(
      "About 200 invoices a month.",
    );
  });

  it("starts a file for a client that has none, on its File tab", async () => {
    const made: unknown[] = [];
    const api = fakeApi({
      ...common,
      [`GET /api/ops/clients/${CLIENT}`]: () => ({
        ...SANDBOX_DETAIL,
        client: { ...SANDBOX_DETAIL.client, id: CLIENT, name: "Hartley Millwork" },
      }),
      "GET /api/ops/client-files": ({ url }) => {
        expect(url.searchParams.get("client")).toBe(CLIENT);
        return { files: [] };
      },
      "POST /api/ops/client-files": ({ init }) => {
        made.push(body(init));
        return { ...fileDetail([]), file: { ...fileDetail([]).file, name: "Hartley Millwork" } };
      },
    });
    renderAt(`/ops/clients/${CLIENT}/file`, api);
    await userEvent.click(await screen.findByTestId("client-file-start"));
    await waitFor(() => expect(made).toEqual([{ name: "Hartley Millwork", clientId: CLIENT }]));
    // Invite is beside the client's name: more people for an existing client, no admin to pick.
    await userEvent.click(screen.getByTestId("ops-client-intake-invite"));
    const sheet = await screen.findByTestId("invite");
    expect(
      within(sheet).getByRole("heading", { name: "Invite to Hartley Millwork" }),
    ).toBeVisible();
    expect(within(sheet).queryByTestId("invite-person-0-admin")).toBeNull();
  });
});

describe("Invite", () => {
  it("walks the five steps from a lead record and sends what the preview showed", async () => {
    const previews: Record<string, unknown>[] = [];
    const sends: unknown[] = [];
    const api = fakeApi({
      ...common,
      [`GET /api/ops/deals/${LEAD}`]: () => dealDetail(),
      "POST /api/ops/onboarding/invite/preview": ({ init }) => {
        previews.push(body(init));
        return preview();
      },
      "POST /api/ops/onboarding/invite": ({ init }) => {
        sends.push(body(init));
        return SENT;
      },
    });
    renderAt(`/ops/deals/${LEAD}`, api);
    await userEvent.click(await screen.findByTestId("deal-invite"));
    const sheet = await screen.findByTestId("invite");
    // 1 Who: the deal's main contact, as the admin.
    expect(within(sheet).getByTestId("invite-person-0-name")).toHaveValue("Karen Lowe");
    expect(within(sheet).getByTestId("invite-person-0-admin")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await userEvent.click(within(sheet).getByTestId("invite-next"));
    // 2 What it covers: general and the agent sold, from the deal; add Purchasing.
    expect(await within(sheet).findByTestId(`invite-cover-template-${TEMPLATE}`)).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(within(sheet).getByTestId("invite-cover-general")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await userEvent.click(within(sheet).getByTestId("invite-cover-area-purchasing"));
    expect(within(sheet).getByTestId("invite-covers-line")).toHaveTextContent(
      "The intake covers General, Purchasing and 1 agent.",
    );
    await userEvent.click(within(sheet).getByTestId("invite-next"));
    // 3 The questions: the preview's guide, its totals; drop one, ask the other later.
    await waitFor(() =>
      expect(within(sheet).getByTestId("invite-totals")).toHaveTextContent(
        "1 to confirm, 1 question, about 5 minutes.",
      ),
    );
    expect(within(sheet).getByTestId("invite-field-general.volumes")).toHaveTextContent(
      "We think: About 300 a month",
    );
    expect(within(sheet).getByTestId("invite-field-general.approver")).toHaveTextContent(
      "Asked once for 2 parts",
    );
    await userEvent.click(within(sheet).getByTestId("invite-field-general.volumes-drop"));
    expect(within(sheet).getByTestId("invite-dropped")).toHaveTextContent(
      "How many supplier invoices a month?",
    );
    await userEvent.click(within(sheet).getByTestId("invite-field-general.approver-later"));
    await userEvent.click(within(sheet).getByTestId("invite-mode-talk"));
    await waitFor(() =>
      expect(previews.at(-1)).toMatchObject({
        edits: { drop: ["general.volumes"], later: ["general.approver"] },
        startMode: "talk",
      }),
    );
    await userEvent.click(within(sheet).getByTestId("invite-next"));
    // 4 The email: the note, then the email and the welcome page as they'll be seen.
    await userEvent.type(within(sheet).getByTestId("invite-note"), "Karen, here's the start.");
    expect(within(sheet).getByTestId("invite-email-subject")).toHaveTextContent(
      "Getting started with Mezonas",
    );
    await userEvent.click(within(sheet).getByTestId("invite-preview-welcome"));
    expect(within(sheet).getByTestId("invite-welcome-preview")).toHaveTextContent(
      "Sign-in is filled in with karen@ridgeline.example.com.",
    );
    await userEvent.click(within(sheet).getByTestId("invite-next"));
    // 5 Send: the confirmation's words from the preview.
    expect(within(sheet).getByTestId("invite-confirm-lines")).toHaveTextContent(
      "Invites Karen Lowe as its admin.",
    );
    expect(within(sheet).getByTestId("invite-todos")).toHaveTextContent(
      "Record Ridgeline Dental Group's agreed price",
    );
    await waitFor(() => expect(within(sheet).getByTestId("invite-send")).toBeEnabled());
    await userEvent.click(within(sheet).getByTestId("invite-send"));
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toEqual({
      fileId: FILE,
      dealId: LEAD,
      people: [{ name: "Karen Lowe", email: "karen@ridgeline.example.com", isAdmin: true }],
      covers: { general: true, areas: ["purchasing"], templateIds: [TEMPLATE] },
      edits: { drop: ["general.volumes"], later: ["general.approver"], reword: [], add: [] },
      startMode: "talk",
      note: "Karen, here's the start.",
    });
    expect(await screen.findByTestId("invite-sent")).toHaveTextContent(
      "karen@ridgeline.example.com: sending",
    );
  });

  it("won't send while the preview has a refusal", async () => {
    const api = fakeApi({
      ...common,
      [`GET /api/ops/deals/${LEAD}`]: () => dealDetail(),
      "POST /api/ops/onboarding/invite/preview": () =>
        preview({
          problems: [
            {
              email: "karen@ridgeline.example.com",
              code: "in_another_client",
              message: "Karen is already in another client.",
            },
          ],
        }),
    });
    renderAt(`/ops/deals/${LEAD}`, api);
    await userEvent.click(await screen.findByTestId("deal-invite"));
    const sheet = await screen.findByTestId("invite");
    expect(await within(sheet).findByText("Karen is already in another client.")).toBeVisible();
    for (let i = 0; i < 4; i += 1) await userEvent.click(within(sheet).getByTestId("invite-next"));
    expect(await within(sheet).findByTestId("invite-problems")).toHaveTextContent(
      "Karen is already in another client.",
    );
    expect(within(sheet).getByTestId("invite-send")).toBeDisabled();
  });
});

describe("Sign up now", () => {
  it("signs a company up from Sales with a start and a price, after one confirm", async () => {
    const previews: unknown[] = [];
    const signups: unknown[] = [];
    const api = fakeApi({
      ...common,
      "GET /api/ops/deals": () => ({
        deals: [],
        kpis: {
          potential: "0",
          weighted: "0",
          open: 0,
          openNew: 0,
          openExpansion: 0,
          agentsInPlay: 0,
          needYou: 0,
          lateOrStuck: 0,
          late: 0,
          wonThisMonth: "0",
          wonCount: 0,
        },
        today: "2026-11-17",
      }),
      "POST /api/ops/onboarding/sign-up/preview": ({ init }) => {
        previews.push(body(init));
        return preview();
      },
      "POST /api/ops/onboarding/sign-up": ({ init }) => {
        signups.push(body(init));
        return SENT;
      },
    });
    renderAt("/ops/sales", api);
    await userEvent.click(await screen.findByTestId("sales-signup"));
    const sheet = await screen.findByTestId("signup");
    await userEvent.type(within(sheet).getByTestId("signup-company"), "Ridgeline Dental Group");
    await userEvent.type(within(sheet).getByTestId("signup-name"), "Karen Lowe");
    await userEvent.type(within(sheet).getByTestId("signup-email"), "Karen@Ridgeline.example.com");
    expect(within(sheet).getByTestId("signup-continue")).toBeDisabled();
    await userEvent.selectOptions(await within(sheet).findByTestId("signup-start"), START);
    await userEvent.type(within(sheet).getByTestId("signup-price"), "$2,400.50");
    await userEvent.click(within(sheet).getByTestId("signup-continue"));
    expect(await within(sheet).findByTestId("signup-confirm-lines")).toHaveTextContent(
      "Moves the deal to Set up the account.",
    );
    await userEvent.click(within(sheet).getByTestId("signup-go"));
    await waitFor(() => expect(signups).toHaveLength(1));
    const sent = {
      company: "Ridgeline Dental Group",
      person: { name: "Karen Lowe", email: "karen@ridgeline.example.com" },
      startId: START,
      agreedMrr: "2400.50",
      currency: "USD",
    };
    expect(previews).toEqual([sent]);
    expect(signups).toEqual([sent]);
    expect(await within(sheet).findByTestId("signup-sent")).toHaveTextContent(
      "Ridgeline Dental Group is a client",
    );
  });

  it("reviews first: a lead's Sign up now opens Invite at the questions", async () => {
    const previews: Record<string, unknown>[] = [];
    const api = fakeApi({
      ...common,
      [`GET /api/ops/deals/${LEAD}`]: () => dealDetail(),
      "POST /api/ops/onboarding/invite/preview": ({ init }) => {
        previews.push(body(init));
        return preview();
      },
    });
    renderAt(`/ops/deals/${LEAD}`, api);
    await userEvent.click(await screen.findByTestId("deal-signup"));
    const sheet = await screen.findByTestId("signup");
    expect(within(sheet).getByTestId("signup-company")).toHaveValue("Ridgeline Dental Group");
    expect(within(sheet).getByTestId("signup-company")).toBeDisabled();
    expect(within(sheet).getByTestId("signup-email")).toHaveValue("karen@ridgeline.example.com");
    await userEvent.selectOptions(await within(sheet).findByTestId("signup-start"), START);
    await userEvent.click(within(sheet).getByTestId("signup-review"));
    const invite = await screen.findByTestId("invite");
    expect(within(invite).getByTestId("invite-steps-3")).toHaveAttribute("aria-current", "step");
    expect(await within(invite).findByTestId("invite-totals")).toBeInTheDocument();
    await waitFor(() =>
      expect(previews[0]).toEqual({
        fileId: FILE,
        dealId: LEAD,
        people: [{ name: "Karen Lowe", email: "karen@ridgeline.example.com", isAdmin: true }],
        covers: { general: true, areas: ["purchasing"], templateIds: [TEMPLATE] },
        startId: START,
        startMode: "point",
        note: "We'll start with how your bills come in.",
      }),
    );
  });
});

describe("Starts", () => {
  it("lists the starts, adds one and archives one", async () => {
    const created: unknown[] = [];
    const updated: unknown[] = [];
    const api = fakeApi({
      ...common,
      "GET /api/ops/deals": () => ({
        deals: [],
        kpis: {
          potential: "0",
          weighted: "0",
          open: 0,
          openNew: 0,
          openExpansion: 0,
          agentsInPlay: 0,
          needYou: 0,
          lateOrStuck: 0,
          late: 0,
          wonThisMonth: "0",
          wonCount: 0,
        },
        today: "2026-11-17",
      }),
      "POST /api/ops/starts": ({ init }) => {
        created.push(body(init));
        return { start: start({ id: "00000000-0000-4000-8000-000000050003" }) };
      },
      [`PATCH /api/ops/starts/${START}`]: ({ init }) => {
        updated.push(body(init));
        return { start: start({ archived: true }) };
      },
    });
    renderAt("/ops/sales", api);
    await userEvent.click(await screen.findByTestId("sales-starts"));
    const sheet = await screen.findByTestId("starts");
    expect(await within(sheet).findByTestId(`start-${START}`)).toHaveTextContent(
      "General, Purchasing and 1 agent · Get to the point",
    );
    expect(within(sheet).getByTestId(`start-${START_ACCOUNT}`)).toHaveTextContent(
      "Just the account",
    );
    expect(within(sheet).getByTestId(`start-${START_ACCOUNT}`)).toHaveTextContent("From Mezonas");

    await userEvent.click(within(sheet).getByTestId(`start-${START}-archive`));
    await waitFor(() => expect(updated).toEqual([{ archived: true }]));

    await userEvent.click(within(sheet).getByTestId("starts-new"));
    await userEvent.type(within(sheet).getByTestId("start-name"), "Bookkeeper");
    await userEvent.click(within(sheet).getByTestId("start-cover-area-bookkeeping"));
    await userEvent.click(within(sheet).getByTestId("start-mode-talk"));
    await userEvent.click(within(sheet).getByTestId("start-save"));
    await waitFor(() =>
      expect(created).toEqual([
        {
          name: "Bookkeeper",
          covers: { general: false, areas: ["bookkeeping"], templateIds: [] },
          note: "",
          startMode: "talk",
        },
      ]),
    );
  });
});

describe("the deal's timeline", () => {
  const activity: DealDetail["activity"] = [
    {
      id: "00000000-0000-4000-8000-0000000f0002",
      kind: "stage",
      actor: "operator",
      who: "Jammil",
      subject: null,
      body: "Moved from Lead to Set up the account. Signed up directly.",
      sources: [],
      createdAt: "2026-11-17T09:00:03.000Z",
    },
    {
      id: "00000000-0000-4000-8000-0000000f0003",
      kind: "stage",
      actor: "operator",
      who: "Jammil",
      subject: null,
      body: "Skipped Proposal and contract: signed up directly.",
      sources: [],
      createdAt: "2026-11-17T09:00:02.000Z",
    },
    {
      id: "00000000-0000-4000-8000-0000000f0004",
      kind: "stage",
      actor: "operator",
      who: "Jammil",
      subject: null,
      body: "Skipped Diagnostic: signed up directly.",
      sources: [],
      createdAt: "2026-11-17T09:00:01.000Z",
    },
  ];

  it("reads the skipped stages off the deal's lines", () => {
    const d = dealDetail({}, activity);
    expect([...skippedStages(d)].sort()).toEqual(["diagnostic", "proposal"]);
  });

  it("marks skipped stages and puts the intake's log among the deal's lines", async () => {
    const view: OpsIntakeView = {
      intake: {
        id: INTAKE,
        client: { id: CLIENT, name: "Ridgeline Dental Group" },
        fileId: FILE,
        dealId: LEAD,
        status: "open",
        covers: { general: true, areas: [], templateIds: [] },
        startMode: "point",
        people: 1,
        answered: 0,
        total: 2,
        sendAt: null,
        createdAt: at,
        updatedAt: at,
        leadNote: "",
        lead: null,
      },
      guide: GUIDE,
      people: [
        {
          id: PERSON,
          userId: null,
          email: "karen@ridgeline.example.com",
          name: "Karen Lowe",
          sections: null,
          isAdmin: true,
          invitedBy: null,
          createdAt: at,
        },
      ],
      answers: [],
      progress: [],
      events: [
        { id: "e2", kind: "opened", personId: PERSON, meta: {}, at: "2026-11-17T12:00:00.000Z" },
        {
          id: "e3",
          kind: "section_started",
          personId: PERSON,
          meta: { sectionKey: "general" },
          at: "2026-11-17T13:00:00.000Z",
        },
        { id: "e1", kind: "sent", personId: PERSON, meta: {}, at: "2026-11-17T09:00:04.000Z" },
      ],
    };
    const api = fakeApi({
      ...common,
      [`GET /api/ops/deals/${LEAD}`]: () =>
        dealDetail(
          {
            client: { id: CLIENT, name: "Ridgeline Dental Group" },
            stage: "setup",
            stageName: "Set up the account",
          },
          activity,
        ),
      "GET /api/ops/intakes": () => ({ intakes: [view.intake] }),
      [`GET /api/ops/intakes/${INTAKE}`]: () => view,
    });
    renderAt(`/ops/deals/${LEAD}`, api);
    expect(await screen.findByTestId("deal-stage-diagnostic-skipped")).toHaveTextContent("Skipped");
    expect(screen.getByTestId("deal-stage-proposal-skipped")).toBeInTheDocument();
    expect(screen.queryByTestId("deal-stage-qualified-skipped")).toBeNull();
    const timeline = screen.getByTestId("deal-timeline");
    expect(await within(timeline).findByTestId("deal-activity-intake:e3")).toHaveTextContent(
      "Karen Lowe said start with The business.",
    );
    const lines = within(timeline)
      .getAllByRole("listitem")
      .map((li) => li.textContent ?? "");
    expect(lines.map((l) => l.replace(/^.*?(\d\d:\d\d)/, ""))).toEqual([
      "Karen Lowe said start with The business.",
      "Karen Lowe opened the welcome page.",
      "Invite sent to Karen Lowe.",
      "Moved from Lead to Set up the account. Signed up directly.",
      "Skipped Proposal and contract: signed up directly.",
      "Skipped Diagnostic: signed up directly.",
    ]);
    expect(lines[4]).toContain("Skipped");
  });
});
