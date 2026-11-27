// Try it for a message trigger (owner, 2026-11-27): who the made-up message is from (one of the
// Sandbox's people, those the trigger takes first, or someone typed in), and Run it live in the
// Sandbox, which sends the same message to the template's Sandbox agent and links the run.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ApiProvider } from "../../../api/useApi";
import { AGENT_SUMMARY, fakeApi } from "../../../test/fixtures";
import { OpsClientsProvider } from "../../OpsLayout";
import { TryPanel, type TryPanelProps } from "./TryPanel";
import type { Workflow } from "./types";

const TEMPLATE = "00000000-0000-4000-8000-0000000000a1";
const SANDBOX = "00000000-0000-4000-8000-0000000000e1";
const COPY = "00000000-0000-4000-8000-0000000000a2";
const ERIN = "00000000-0000-4000-8000-0000000000c1";
const VIC = "00000000-0000-4000-8000-0000000000c2";
const NEW = "00000000-0000-4000-8000-0000000000c3";
const DOC = "00000000-0000-4000-8000-0000000000d1";
const RUN = "00000000-0000-4000-8000-0000000000f1";
const RECORD = "00000000-0000-4000-8000-0000000000f2";

const workflow = {
  schemaVersion: 5,
  triggers: [
    {
      id: "t1",
      on: { type: "message", channels: ["email", "sms"], from: { relationships: ["employee"] } },
    },
  ],
  outputs: [],
  steps: [],
} as unknown as Workflow;

const person = (id: string, name: string, more: Record<string, unknown>) => ({
  id,
  name,
  phone: null,
  whatsapp: null,
  email: null,
  language: null,
  consent: {},
  optedOut: null,
  canMessage: { sms: false, whatsapp: false },
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  ...more,
});
const vic = person(VIC, "Vic Vendor", { email: "vic@vendor.example", relationship: "vendor" });
const erin = person(ERIN, "Erin Employee", {
  email: "erin@sandbox.example",
  relationship: "employee",
});

const usedBy = (agents: { behind: number; baseVersion: number }[]) => ({
  templateLiveVersion: 3,
  agents: agents.map((a) => ({
    agent: { ...AGENT_SUMMARY, id: COPY, tenantId: SANDBOX, name: "Tess", templateId: TEMPLATE },
    client: { id: SANDBOX, name: "Sandbox" },
    version: 1,
    baseVersion: a.baseVersion,
    behind: a.behind,
    customizations: 0,
    conflicts: null,
  })),
});

const madeUp = (from: string, contactId: string, channel: "email" | "sms") => ({
  trigger: { channel, contactId, rawRecordId: RECORD, documents: [DOC] },
  missing: false,
  document: null,
  message: {
    subject: "Receipts from the site visit",
    from,
    attachments: [{ id: DOC, filename: "receipt.pdf" }],
    clientId: SANDBOX,
    text: "Two receipts attached.",
    contactId,
    channel,
  },
});

function open(routes: Parameters<typeof fakeApi>[0], props: Partial<TryPanelProps> = {}) {
  const api = fakeApi({
    [`GET /api/ops/clients/${SANDBOX}/contacts`]: () => ({ items: [vic, erin] }),
    "GET /api/ops/clients": () => ({
      clients: [
        {
          id: SANDBOX,
          name: "Sandbox",
          timezone: "UTC",
          createdAt: "2026-11-01T00:00:00.000Z",
          agents: 0,
          openInbox: 0,
          sandbox: true,
        },
      ],
    }),
    ...routes,
  });
  render(
    <MemoryRouter>
      <ApiProvider client={api.client}>
        <OpsClientsProvider value={[{ id: SANDBOX, name: "Sandbox", sandbox: true } as never]}>
          <TryPanel
            agent={{ id: TEMPLATE, kind: "template", tenantId: null }}
            workflow={workflow}
            slug="receipts"
            sample={{}}
            name="Receipts"
            triggerKind="message"
            prepare={async () => null}
            onMarks={() => {}}
            onSelect={() => {}}
            onClose={() => {}}
            {...props}
          />
        </OpsClientsProvider>
      </ApiProvider>
    </MemoryRouter>,
  );
  return { user: userEvent.setup(), api };
}

describe("Try it's From", () => {
  it("lists the people the trigger takes first, and makes the email up from the one picked", async () => {
    const sent: unknown[] = [];
    const { user } = open({
      [`POST /api/ops/agents/${TEMPLATE}/test-data`]: ({ init }) => {
        sent.push(JSON.parse(String(init.body)));
        return madeUp("Erin Employee <erin@sandbox.example>", ERIN, "email");
      },
      [`GET /api/ops/templates/${TEMPLATE}/used-by`]: () => usedBy([]),
    });
    const from = await screen.findByTestId("steps-try-sender");
    await waitFor(() => expect(from).toHaveValue(ERIN));
    const groups = from.querySelectorAll("optgroup");
    expect(groups[0]).toHaveAttribute("label", "Who it takes");
    expect(within(groups[0] as HTMLElement).getByRole("option")).toHaveTextContent(
      "Erin Employee · erin@sandbox.example",
    );
    expect(groups[1]).toHaveAttribute("label", "Others in the Sandbox");
    await user.click(screen.getByTestId("steps-try-make-up"));
    expect(await screen.findByTestId("steps-try-made")).toHaveTextContent(
      "Made “Receipts from the site visit” from Erin Employee <erin@sandbox.example>",
    );
    expect(sent[0]).toMatchObject({ fromContactId: ERIN, channel: "email" });
  });

  it("adds someone typed in to the Sandbox's people as the trigger takes them, a number as a text", async () => {
    const added: unknown[] = [];
    const sent: unknown[] = [];
    const { user } = open({
      "POST /api/ops/sandbox/senders": ({ init }) => {
        added.push(JSON.parse(String(init.body)));
        return {
          contactId: NEW,
          name: "+15550104477",
          email: null,
          phone: "+15550104477",
          created: true,
        };
      },
      [`POST /api/ops/agents/${TEMPLATE}/test-data`]: ({ init }) => {
        sent.push(JSON.parse(String(init.body)));
        return madeUp("+15550104477 <+15550104477>", NEW, "sms");
      },
      [`GET /api/ops/templates/${TEMPLATE}/used-by`]: () => usedBy([]),
    });
    const from = await screen.findByTestId("steps-try-sender");
    await waitFor(() => expect(from).toHaveValue(ERIN));
    await user.selectOptions(from, "other");
    expect(screen.getByTestId("steps-try-make")).toHaveTextContent(
      "We add them to the Sandbox's people as an employee",
    );
    await user.type(screen.getByTestId("steps-try-sender-address"), "555 010 4477");
    await user.click(screen.getByTestId("steps-try-make-up"));
    expect(await screen.findByTestId("steps-try-made")).toHaveTextContent(
      "Made a text from +15550104477",
    );
    expect(added).toEqual([
      { clientId: SANDBOX, address: "555 010 4477", relationship: "employee" },
    ]);
    expect(sent[0]).toMatchObject({ fromContactId: NEW, channel: "sms" });
  });
});

describe("Run it live in the Sandbox", () => {
  it("sends the same message to the template's Sandbox agent and links the run it started", async () => {
    const sent: unknown[] = [];
    const { user } = open({
      [`POST /api/ops/agents/${TEMPLATE}/test-data`]: () =>
        madeUp("Erin Employee <erin@sandbox.example>", ERIN, "email"),
      [`GET /api/ops/templates/${TEMPLATE}/used-by`]: () => usedBy([{ behind: 0, baseVersion: 3 }]),
      "POST /api/ops/sandbox/test-messages": ({ init }) => {
        sent.push(JSON.parse(String(init.body)));
        return { status: "started", runId: RUN, rawRecordId: RECORD, reply: null };
      },
    });
    expect(screen.queryByTestId("steps-try-live-run")).toBeNull();
    await user.click(await screen.findByTestId("steps-try-make-up"));
    await screen.findByTestId("steps-try-made");
    expect(screen.getByTestId("steps-try-live")).toHaveTextContent(
      "the version that is on in the Sandbox, not this draft",
    );
    const run = screen.getByTestId("steps-try-live-run");
    await waitFor(() => expect(run).toBeEnabled());
    await user.click(run);
    expect(await screen.findByTestId("sandbox-test-started")).toHaveTextContent(
      "Tess started a run.",
    );
    expect(screen.getByRole("link", { name: "Open the run" })).toHaveAttribute(
      "href",
      `/ops/runs/${RUN}`,
    );
    expect(sent).toEqual([
      {
        agentId: COPY,
        channel: "email",
        fromContactId: ERIN,
        subject: "Receipts from the site visit",
        text: "Two receipts attached.",
        documentIds: [DOC],
      },
    ]);
    expect(screen.queryByTestId("steps-try-live-behind")).toBeNull();
  });

  it("says why nothing started, and the reply the sender would get", async () => {
    const { user } = open({
      [`POST /api/ops/agents/${TEMPLATE}/test-data`]: () =>
        madeUp("Vic Vendor <vic@vendor.example>", VIC, "email"),
      [`GET /api/ops/templates/${TEMPLATE}/used-by`]: () => usedBy([{ behind: 0, baseVersion: 3 }]),
      "POST /api/ops/sandbox/test-messages": () => ({
        status: "refused",
        reason: "sender_not_allowed",
        message: "Vic Vendor isn't one of the people its email trigger takes messages from",
        reply: "We can only take requests from people the business knows.",
      }),
    });
    await user.click(await screen.findByTestId("steps-try-make-up"));
    const run = await screen.findByTestId("steps-try-live-run");
    await waitFor(() => expect(run).toBeEnabled());
    await user.click(run);
    expect(await screen.findByTestId("sandbox-test-refused")).toHaveTextContent(
      "Nothing started: Vic Vendor isn't one of the people its email trigger takes messages from. They'd get this reply",
    );
  });

  it("offers Turn on in the Sandbox when the template isn't on there", async () => {
    const { user } = open({
      [`POST /api/ops/agents/${TEMPLATE}/test-data`]: () =>
        madeUp("Erin Employee <erin@sandbox.example>", ERIN, "email"),
      [`GET /api/ops/templates/${TEMPLATE}/used-by`]: () => usedBy([]),
    });
    await user.click(await screen.findByTestId("steps-try-make-up"));
    const off = await screen.findByTestId("steps-try-live-off");
    expect(off).toHaveTextContent("This template isn't on in the Sandbox yet.");
    expect(await within(off).findByTestId("lab-turn-on-sandbox")).toBeInTheDocument();
    expect(screen.getByTestId("steps-try-live-run")).toBeDisabled();
  });

  it("says when the Sandbox's copy is behind the template", async () => {
    const { user } = open({
      [`POST /api/ops/agents/${TEMPLATE}/test-data`]: () =>
        madeUp("Erin Employee <erin@sandbox.example>", ERIN, "email"),
      [`GET /api/ops/templates/${TEMPLATE}/used-by`]: () => usedBy([{ behind: 2, baseVersion: 1 }]),
    });
    await user.click(await screen.findByTestId("steps-try-make-up"));
    const behind = await screen.findByTestId("steps-try-live-behind");
    expect(behind).toHaveTextContent("The Sandbox runs v1, 2 behind the template's v3.");
    expect(await within(behind).findByTestId("lab-turn-on-sandbox")).toBeInTheDocument();
  });

  it("sends a Sandbox agent's message to the agent itself", async () => {
    const sent: unknown[] = [];
    const { user, api } = open(
      {
        [`POST /api/ops/agents/${COPY}/test-data`]: () =>
          madeUp("Erin Employee <erin@sandbox.example>", ERIN, "email"),
        "POST /api/ops/sandbox/test-messages": ({ init }) => {
          sent.push(JSON.parse(String(init.body)));
          return { status: "started", runId: RUN, rawRecordId: RECORD, reply: null };
        },
      },
      { agent: { id: COPY, kind: "client", tenantId: SANDBOX } },
    );
    await user.click(await screen.findByTestId("steps-try-make-up"));
    const run = await screen.findByTestId("steps-try-live-run");
    await waitFor(() => expect(run).toBeEnabled());
    await user.click(run);
    await screen.findByTestId("sandbox-test-started");
    expect(sent[0]).toMatchObject({ agentId: COPY, fromContactId: ERIN });
    expect(api.calls.some((c) => c.includes("used-by"))).toBe(false);
  });
});
