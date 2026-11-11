// R8: the Library (docs/plan.md §1.86; ARCHITECTURE §10.14 "The Library and the client's
// settings"): the index counts each bank and the sidebar opens it; the Processes bank lists
// templates with their workflows read as v4 and links into the builder; Skills say their method,
// reads and browsing, with tool wrappers on a Retired tab; Tools group by connector with their
// undo; Triggers show the six kinds and the events with the templates using them; Record types
// and Condition sets read and search; the connectors catalog and website logins live inside it.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { fakeApi, OPERATOR_SESSION } from "../../test/fixtures";

const TEMPLATE_ID = "00000000-0000-4000-8000-00000000d101";
const AUTO_ID = "00000000-0000-4000-8000-00000000d201";
const V1 = "00000000-0000-4000-8000-00000000d301";
const V2 = "00000000-0000-4000-8000-00000000d302";

function Probe() {
  const { pathname } = useLocation();
  return <span data-testid="location">{pathname}</span>;
}

function renderAt(path: string, routes: Parameters<typeof fakeApi>[0]) {
  const api = fakeApi({ "GET /api/session": () => OPERATOR_SESSION, ...routes });
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
        <Probe />
      </AppProviders>
    </MemoryRouter>,
  );
  return { api, user: userEvent.setup() };
}

const BILL_KEEPER = {
  id: TEMPLATE_ID,
  slug: "bill-keeper",
  name: "Bill keeper",
  description: "Enter every bill the day it arrives",
  liveVersion: 1,
  latestVersion: 2,
  shownVersion: 1,
  usedBy: 3,
  workflows: [
    {
      slug: "enter-bills",
      name: "Enter bills",
      enabled: true,
      schemaVersion: 3,
      triggers: [
        { id: "t1", kind: "event", event: "document.extracted" },
        { id: "t2", kind: "manual", event: null },
      ],
      steps: 5,
      kinds: { skill: 1, write: 1, person: 1, if: 1, notify: 1 },
      checks: { confer: 1, approval: 2, notify: 0 },
    },
  ],
  versions: [
    {
      id: V2,
      version: 2,
      status: "draft",
      changeNote: "Ask Dana on big bills",
      createdAt: "2026-11-09T10:00:00.000Z",
      schemaVersion: 4,
    },
    {
      id: V1,
      version: 1,
      status: "live",
      changeNote: "First",
      createdAt: "2026-11-01T10:00:00.000Z",
      schemaVersion: 3,
    },
  ],
};

const COLLECTOR = {
  ...BILL_KEEPER,
  id: "00000000-0000-4000-8000-00000000d102",
  slug: "collector",
  name: "Collector",
  description: "Chase overdue invoices",
  liveVersion: null,
  latestVersion: 1,
  shownVersion: 1,
  usedBy: 0,
  workflows: [
    {
      slug: "chase",
      name: "Chase",
      enabled: true,
      schemaVersion: 4,
      triggers: [{ id: "t1", kind: "schedule", event: null }],
      steps: 1,
      kinds: { conversation: 1 },
      checks: { confer: 0, approval: 0, notify: 0 },
    },
  ],
  versions: [BILL_KEEPER.versions[1]],
};

const skill = (over: Record<string, unknown>) => ({
  id: "docs.extract",
  ref: "docs.extract",
  name: "Read a document",
  description: "Reads an invoice or a receipt.",
  category: "documents",
  // main's list rows carry the skill's mode (its Clone needs it).
  mode: "task",
  source: "builtin",
  clientId: null,
  clientName: null,
  status: "active",
  liveVersion: null,
  latestVersion: null,
  latestStatus: null,
  inputs: ["documentId"],
  outputs: ["fields"],
  tools: [],
  connectors: [],
  usedBy: 0,
  ...over,
});

const SKILLS = {
  skills: [
    skill({ method: "ai", reads: ["docs.get"], browse: null, retired: false, wraps: null }),
    skill({
      id: "materials.match",
      ref: "materials.match",
      name: "Match items",
      description: "Matches a line to the master list.",
      category: "data",
      method: "rules_then_ai",
      reads: [],
      browse: { sites: ["supplier-portal"], pages: ["/orders/*", "/invoices/*"] },
      retired: false,
      wraps: null,
    }),
    skill({
      id: "qbo.bill.query",
      ref: "qbo.bill.query",
      name: "Query bill",
      description: "Finds bills.",
      category: "QuickBooks Online",
      method: "rules",
      reads: [],
      browse: null,
      retired: true,
      wraps: "qbo.bill.query",
    }),
    // Skill model (2026-11-10): the API says the kind; the aging skill is rule rows.
    skill({
      id: "age.receivables",
      ref: "age.receivables",
      name: "Age receivables",
      description: "Puts each open invoice in an aging bucket.",
      category: "data",
      method: "rules",
      kind: "deterministic",
      kindLabel: "Deterministic",
      reads: [],
      browse: null,
      retired: false,
      wraps: null,
    }),
  ],
  tools: [],
  connectors: [],
};

const tool = (over: Record<string, unknown>) => ({
  id: "qbo.bill.query",
  description: "Finds bills",
  source: "qbo",
  sourceName: "QuickBooks Online",
  connector: "qbo",
  sideEffect: "none",
  verb: "read",
  entities: ["bill"],
  undo: null,
  undoDeclared: false,
  alwaysSigned: false,
  wrappedBy: ["qbo.bill.query"],
  ...over,
});

const TOOLS = {
  tools: [
    tool({}),
    tool({
      id: "qbo.bill.update",
      description: "Changes a bill",
      sideEffect: "external",
      verb: "update",
      undo: { kind: "restore" },
      undoDeclared: true,
      wrappedBy: [],
    }),
    tool({
      id: "website.page.publish",
      description: "Publishes a page",
      source: "website",
      sourceName: "Website",
      connector: "website",
      sideEffect: "external",
      verb: "create",
      entities: [],
      undo: { kind: "none" },
      undoDeclared: true,
      alwaysSigned: true,
      wrappedBy: [],
    }),
    tool({
      id: "alerts.raise",
      description: "Raises an alert",
      source: "platform",
      sourceName: "Platform",
      connector: null,
      sideEffect: "internal",
      verb: "create",
      entities: [],
      wrappedBy: [],
    }),
  ],
};

const EVENTS = {
  events: [
    {
      type: "document.extracted",
      description: "A document was read",
      subjectType: null,
      payload: { type: "object" },
      sample: {},
      connector: null,
    },
    {
      type: "zoho_crm.record.changed",
      description: "A CRM record changed",
      subjectType: null,
      payload: { type: "object" },
      sample: {},
      connector: "zoho_crm",
    },
  ],
};

const BIG = { match: "all", rules: [{ field: "{{trigger.total}}", op: ">", value: 5000 }] };

const CONDITIONS = {
  source: "derived",
  sets: [
    {
      key: "0123456789abcdef",
      name: "Big bills",
      when: BIG,
      uses: [
        {
          processKind: "template",
          processId: TEMPLATE_ID,
          processSlug: "bill-keeper",
          processName: "Bill keeper",
          version: 1,
          workflow: "enter-bills",
          place: "if_path",
          stepId: "size",
          stepName: "How big",
          label: "Big bills",
        },
        {
          processKind: "template",
          processId: TEMPLATE_ID,
          processSlug: "bill-keeper",
          processName: "Bill keeper",
          version: 1,
          workflow: "enter-bills",
          place: "approval",
          stepId: "enter",
          stepName: "Enter the bill",
          label: null,
        },
        {
          processKind: "automation",
          processId: AUTO_ID,
          processSlug: "big-check",
          processName: "Big check",
          version: 2,
          workflow: null,
          place: "confer",
          stepId: "check",
          stepName: "Check it",
          label: null,
        },
      ],
    },
    {
      key: "fedcba9876543210",
      name: null,
      when: { match: "any", rules: [{ field: "{{trigger.vendor}}", op: "=", value: "Acme" }] },
      uses: [
        {
          processKind: "template",
          processId: TEMPLATE_ID,
          processSlug: "bill-keeper",
          processName: "Bill keeper",
          version: 1,
          workflow: "enter-bills",
          place: "trigger",
          stepId: null,
          stepName: null,
          label: "t1",
        },
      ],
    },
  ],
};

describe("the Library", () => {
  it("counts each bank on its index, and the sidebar opens it", async () => {
    const { user } = renderAt("/ops", {
      "GET /api/ops/library": () => ({
        banks: [
          { bank: "processes", count: 3, retired: 0 },
          { bank: "skills", count: 15, retired: 85 },
          { bank: "tools", count: 188, retired: 0 },
          { bank: "connectors", count: 24, retired: 0 },
          { bank: "triggers", count: 40, retired: 0 },
          { bank: "record_types", count: 61, retired: 0 },
          { bank: "conditions", count: 1, retired: 0 },
        ],
      }),
    });
    await user.click(await screen.findByTestId("ops-nav-library"));
    expect(screen.getByTestId("location")).toHaveTextContent("/ops/library");
    expect(await screen.findByTestId("library-bank-processes-count")).toHaveTextContent(
      "3 processes",
    );
    expect(screen.getByTestId("library-bank-skills-count")).toHaveTextContent(
      "15 skills · 85 tool wrappers retiring",
    );
    expect(screen.getByTestId("library-bank-triggers-count")).toHaveTextContent(
      "6 kinds · 40 events",
    );
    expect(screen.getByTestId("library-bank-conditions-count")).toHaveTextContent(
      "1 condition set",
    );
    // Each bank's card and tab open the bank.
    const bank = screen.getByTestId("library-bank-record_types");
    expect(within(bank).getByRole("link", { name: "Record types" })).toHaveAttribute(
      "href",
      "/ops/library/record-types",
    );
    const tabs = screen.getByRole("navigation", { name: /sections/i });
    expect(within(tabs).getByRole("link", { name: "Condition sets" })).toHaveAttribute(
      "href",
      "/ops/library/conditions",
    );
  });

  it("lists templates with their workflows read as processes, and opens the builder", async () => {
    const { user } = renderAt("/ops/library/processes", {
      "GET /api/ops/library/processes": () => ({ processes: [BILL_KEEPER, COLLECTOR] }),
      "GET /api/ops/automations": () => ({ automations: [] }),
    });
    const card = await screen.findByTestId("process-bill-keeper");
    expect(within(card).getByTestId("process-bill-keeper-live")).toHaveTextContent("Live · v1");
    expect(within(card).getByText("Draft v2")).toBeInTheDocument();
    expect(within(card).getByTestId("process-bill-keeper-used-by")).toHaveTextContent(
      "3 client agents",
    );
    const row = within(card).getByTestId("process-bill-keeper-workflow-enter-bills");
    expect(row).toHaveTextContent("Event: document.extracted · Manual");
    expect(row).toHaveTextContent("5 steps");
    expect(within(row).getByText("Person 1")).toBeInTheDocument();
    expect(within(row).getByText("If 1")).toBeInTheDocument();
    expect(row).toHaveTextContent("1 confer · 2 approvals");
    expect(row).toHaveTextContent("Stored as a v3 workflow");
    expect(within(row).getByTestId("process-bill-keeper-open-enter-bills")).toHaveAttribute(
      "href",
      "/ops/templates/bill-keeper/workflows/enter-bills",
    );
    expect(within(card).getByTestId("process-bill-keeper-versions")).toHaveTextContent(
      "2 versions",
    );
    expect(within(card).getByText("Ask Dana on big bills")).toBeInTheDocument();
    // A template never published is a draft, with no client agents.
    const draft = screen.getByTestId("process-collector");
    expect(within(draft).getByText("Draft")).toBeInTheDocument();
    expect(within(draft).getByText("No client agents yet")).toBeInTheDocument();
    // Processes used inside others: the automations, empty here.
    expect(screen.getByTestId("automations")).toHaveTextContent("Used inside other processes");

    await user.type(screen.getByTestId("processes-search"), "overdue");
    expect(screen.queryByTestId("process-bill-keeper")).toBeNull();
    expect(screen.getByTestId("process-collector")).toBeInTheDocument();
  });

  // Skill model (2026-11-10): two kinds only, each card labelled, the list filtered by kind;
  // tool wrappers are not listed at all.
  it("says each skill's kind, reads and browsing, filters by kind, and lists no tool wrapper", async () => {
    const { user } = renderAt("/ops/library/skills", { "GET /api/ops/skills": () => SKILLS });
    const ai = await screen.findByTestId("skills-card-docs.extract");
    expect(within(ai).getByTestId("skills-card-docs.extract-kind")).toHaveTextContent("AI");
    expect(within(ai).getByTestId("skills-card-docs.extract-reach")).toHaveTextContent(
      /Reads\s*docs\.get/,
    );
    const match = screen.getByTestId("skills-card-materials.match");
    // A stored rules-then-AI skill runs a model: AI.
    expect(within(match).getByTestId("skills-card-materials.match-kind")).toHaveTextContent("AI");
    expect(within(match).getByTestId("skills-card-materials.match-reach")).toHaveTextContent(
      /Browses\s*supplier-portal · 2 pages/,
    );
    // The wrapper is gone: a process reads through the tool directly.
    expect(screen.queryByTestId("skills-card-qbo.bill.query")).toBeNull();
    expect(screen.queryByTestId("skills-tab-retired")).toBeNull();
    // The kind filter: AI only, then deterministic only.
    await user.click(screen.getByTestId("skills-kind-ai"));
    expect(screen.getByTestId("skills-card-docs.extract")).toBeInTheDocument();
    expect(screen.queryByTestId("skills-card-age.receivables")).toBeNull();
    await user.click(screen.getByTestId("skills-kind-deterministic"));
    expect(screen.queryByTestId("skills-card-docs.extract")).toBeNull();
    expect(
      within(screen.getByTestId("skills-card-age.receivables")).getByTestId(
        "skills-card-age.receivables-kind",
      ),
    ).toHaveTextContent("Deterministic");
    await user.click(screen.getByTestId("skills-kind-all"));
    expect(screen.getByTestId("skills-card-docs.extract")).toBeInTheDocument();
    expect(screen.getByTestId("skills-card-age.receivables")).toBeInTheDocument();
  });

  it("groups tools by connector with what each does and how a write is undone", async () => {
    const { user } = renderAt("/ops/library/tools", {
      "GET /api/ops/library/tools": () => TOOLS,
    });
    const qbo = await screen.findByTestId("tools-group-qbo");
    expect(within(qbo).getByTestId("tool-qbo.bill.query-does")).toHaveTextContent("Reads · read");
    expect(within(qbo).getByTestId("tool-qbo.bill.query-undo")).toHaveTextContent(
      "Nothing to undo",
    );
    expect(within(qbo).getByTestId("tool-qbo.bill.query-wrapped")).toHaveTextContent("retiring");
    expect(within(qbo).getByTestId("tool-qbo.bill.update-does")).toHaveTextContent(
      "Changes the client's tool · update",
    );
    expect(within(qbo).getByTestId("tool-qbo.bill.update")).toHaveTextContent(
      "Approval on by default",
    );
    expect(within(qbo).getByTestId("tool-qbo.bill.update-undo")).toHaveTextContent(
      "Restored from the before state",
    );
    expect(screen.getByTestId("tool-website.page.publish-signed")).toHaveTextContent(
      "A person always signs",
    );
    expect(screen.getByTestId("tool-website.page.publish-undo")).toHaveTextContent("No undo");
    expect(screen.getByTestId("tool-alerts.raise-undo")).toHaveTextContent("Our records only");

    await user.click(screen.getByTestId("tools-filter-writes"));
    expect(screen.queryByTestId("tool-qbo.bill.query")).toBeNull();
    expect(screen.queryByTestId("tool-alerts.raise")).toBeNull();
    expect(screen.getByTestId("tool-qbo.bill.update")).toBeInTheDocument();
    await user.type(screen.getByTestId("tools-search"), "publish");
    expect(screen.queryByTestId("tool-qbo.bill.update")).toBeNull();
    expect(screen.getByTestId("tool-website.page.publish")).toBeInTheDocument();
  });

  it("shows the six trigger kinds and the events, with the templates that use them", async () => {
    const { user } = renderAt("/ops/library/triggers", {
      "GET /api/ops/catalog/events": () => EVENTS,
      "GET /api/ops/library/processes": () => ({ processes: [BILL_KEEPER, COLLECTOR] }),
    });
    const uses = await screen.findByTestId("trigger-event-document.extracted-uses");
    expect(within(uses).getByRole("link", { name: "Bill keeper" })).toHaveAttribute(
      "href",
      "/ops/templates/bill-keeper/workflows/enter-bills",
    );
    expect(screen.getByTestId("trigger-event-zoho_crm.record.changed")).toHaveTextContent(
      "No template yet",
    );
    expect(screen.getByTestId("trigger-kind-schedule-uses")).toHaveTextContent("Collector");
    expect(screen.getByTestId("trigger-kind-manual-uses")).toHaveTextContent("Bill keeper");
    expect(screen.getByTestId("trigger-kind-webhook")).toHaveTextContent("No template yet");

    await user.type(screen.getByTestId("triggers-search"), "crm");
    expect(screen.queryByTestId("trigger-event-document.extracted")).toBeNull();
    expect(screen.getByTestId("trigger-event-zoho_crm.record.changed")).toBeInTheDocument();
  });

  it("lists record types with their verbs, narrower access and tools", async () => {
    const { user } = renderAt("/ops/library/record-types", {
      "GET /api/ops/library/record-types": () => ({
        recordTypes: [
          {
            id: "qbo.invoice",
            connector: "qbo",
            sourceName: "QuickBooks Online",
            entity: "invoice",
            label: "Invoices",
            verbs: ["read", "update"],
            scopes: [
              {
                id: "notes_only",
                label: "Notes only",
                verb: "update",
                tools: ["qbo.invoice.add_note"],
              },
            ],
            tools: [
              { id: "qbo.invoice.query", verb: "read", sideEffect: "none" },
              { id: "qbo.invoice.add_note", verb: "update", sideEffect: "external" },
            ],
          },
          {
            id: "document",
            connector: null,
            sourceName: "Platform",
            entity: "document",
            label: "Document",
            verbs: ["read"],
            scopes: [],
            tools: [],
          },
        ],
      }),
    });
    const row = await screen.findByTestId("record-type-qbo.invoice");
    expect(row).toHaveTextContent("Invoices");
    expect(row).toHaveTextContent("read, update");
    expect(row).toHaveTextContent("Notes only (update: qbo.invoice.add_note)");
    expect(row).toHaveTextContent("qbo.invoice.query, qbo.invoice.add_note");
    expect(screen.getByTestId("record-types-platform")).toHaveTextContent("Document");

    await user.type(screen.getByTestId("record-types-search"), "add_note");
    expect(screen.queryByTestId("record-type-document")).toBeNull();
    expect(screen.getByTestId("record-type-qbo.invoice")).toBeInTheDocument();
  });

  it("shows the conditions the processes use, derived and read only, with where each is used", async () => {
    const { user } = renderAt("/ops/library/conditions", {
      "GET /api/ops/library/conditions": () => CONDITIONS,
    });
    expect(await screen.findByTestId("conditions-derived")).toHaveTextContent("isn't built yet");
    const big = await screen.findByTestId("condition-0123456789abcdef");
    expect(within(big).getByText("Big bills")).toBeInTheDocument();
    expect(within(big).getByTestId("condition-0123456789abcdef-rules")).toHaveTextContent(
      "When trigger · total > 5000",
    );
    expect(big).toHaveTextContent("3 uses · 2 processes");
    const links = within(big).getAllByRole("link");
    expect(links[0]).toHaveAttribute("href", "/ops/templates/bill-keeper/workflows/enter-bills");
    expect(links[2]).toHaveAttribute("href", `/ops/skills/automations/${AUTO_ID}`);
    expect(within(big).getByText("If path")).toBeInTheDocument();
    expect(within(big).getByText("Approval")).toBeInTheDocument();
    expect(within(big).getByText("Used inside others")).toBeInTheDocument();
    const filter = screen.getByTestId("condition-fedcba9876543210");
    expect(within(filter).getByText("Unnamed condition")).toBeInTheDocument();
    expect(within(filter).getByText("Trigger filter")).toBeInTheDocument();

    await user.type(screen.getByTestId("conditions-search"), "acme");
    expect(screen.queryByTestId("condition-0123456789abcdef")).toBeNull();
    expect(screen.getByTestId("condition-fedcba9876543210")).toBeInTheDocument();
  });

  it("keeps the connectors catalog and website logins inside it, from their old addresses too", async () => {
    const { user } = renderAt("/ops/connectors", {
      "GET /api/ops/connectors": () => ({ connectors: [] }),
      "GET /api/ops/browser-sites": () => ({ sites: [] }),
    });
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent("/ops/library/connectors"),
    );
    expect(await screen.findByTestId("library")).toBeInTheDocument();
    expect(await screen.findByTestId("connectors-search")).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "Allowed browser sites" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/ops/library/browser-sites");
    expect(await screen.findByTestId("ops-browser-sites")).toBeInTheDocument();
    // The Connectors tab stays current for the website logins.
    const tabs = screen.getByRole("navigation", { name: /sections/i });
    expect(within(tabs).getByRole("link", { name: "Connectors" })).toHaveClass("border-slate");
  });
});
