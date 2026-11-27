// Sandbox inbound: a Sandbox agent's address, named and copied, and a test message from one of the
// Sandbox's people that links to the run it started, or says in plain words why nothing did.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ApiProvider } from "../../api/useApi";
import { fakeApi, Reply } from "../../test/fixtures";
import { SandboxInbound } from "./SandboxInbound";

const AGENT = "00000000-0000-4000-8000-0000000a0001";
const CLIENT = "00000000-0000-4000-8000-0000000c0001";
const ERIN = "00000000-0000-4000-8000-0000000e0001";
const RUN = "00000000-0000-4000-8000-0000000d0001";
const RECORD = "00000000-0000-4000-8000-0000000f0001";
const ADDRESS = "remy.sandbox-aaaaaaaaaaaaaaaaaaaaaaaaaa@in.mezonas.com";

const erin = {
  id: ERIN,
  name: "Erin Employee",
  phone: "+15557770011",
  whatsapp: null,
  email: "erin@sandbox.example",
  language: null,
  consent: {},
  optedOut: null,
  canMessage: { sms: false, whatsapp: false },
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
};

function setup(answer: unknown) {
  const sent: unknown[] = [];
  const named: unknown[] = [];
  let changed = 0;
  const api = fakeApi({
    [`GET /api/ops/clients/${CLIENT}/contacts`]: () => ({ items: [erin] }),
    [`PUT /api/ops/agents/${AGENT}/address`]: ({ init }) => {
      const body = JSON.parse(String(init.body));
      named.push(body);
      if (body.name === "pia") {
        return new Reply(409, {
          error: { code: "name_taken", message: "another of this client's agents answers to pia" },
        });
      }
      return { inboundName: body.name, commandName: body.name, address: ADDRESS };
    },
    "POST /api/ops/sandbox/test-messages": ({ init }) => {
      sent.push(JSON.parse(String(init.body)));
      return answer;
    },
  });
  render(
    <MemoryRouter>
      <ApiProvider client={api.client}>
        <SandboxInbound
          agentId={AGENT}
          clientId={CLIENT}
          name="Remy"
          fired={{ address: ADDRESS, inboundName: null, commandName: "remy" }}
          onChanged={() => {
            changed += 1;
          }}
          upload={async () => ({ results: [] })}
        />
      </ApiProvider>
    </MemoryRouter>,
  );
  return { sent, named, changed: () => changed, user: userEvent.setup() };
}

describe("Sandbox inbound", () => {
  it("shows the address with Copy, and saves a new first part", async () => {
    const t = setup({ status: "refused", reason: "x", message: "x", reply: null });
    expect(screen.getByTestId("sandbox-address-full")).toHaveTextContent(ADDRESS);
    const write = vi.spyOn(navigator.clipboard, "writeText");
    await t.user.click(screen.getByTestId("sandbox-address-copy"));
    expect(write).toHaveBeenCalledWith(ADDRESS);
    expect(screen.getByTestId("sandbox-address-copy")).toHaveTextContent("Copied");

    const input = screen.getByTestId("sandbox-address-name");
    await t.user.clear(input);
    await t.user.type(input, "pia");
    await t.user.click(screen.getByTestId("sandbox-address-save"));
    expect(await screen.findByTestId("sandbox-address-error")).toHaveTextContent(
      "another of this client's agents answers to pia",
    );
    await t.user.clear(input);
    await t.user.type(input, "AP-Inbox");
    await t.user.click(screen.getByTestId("sandbox-address-save"));
    await waitFor(() => expect(t.changed()).toBe(1));
    expect(t.named).toEqual([{ name: "pia" }, { name: "ap-inbox" }]);
  });

  it("sends a test email from one of the Sandbox's people and links to its run", async () => {
    const t = setup({ status: "started", runId: RUN, rawRecordId: RECORD, reply: "Got it." });
    await screen.findByRole("option", { name: "Erin Employee" });
    await t.user.type(screen.getByTestId("sandbox-test-subject"), "Receipts");
    await t.user.type(screen.getByTestId("sandbox-test-text"), "Two receipts");
    await t.user.click(screen.getByTestId("sandbox-test-send"));
    const done = await screen.findByTestId("sandbox-test-started");
    expect(done).toHaveTextContent(
      'Remy started a run. Open the run They\'d get this reply: "Got it."',
    );
    expect(screen.getByRole("link", { name: "Open the run" })).toHaveAttribute(
      "href",
      `/ops/runs/${RUN}`,
    );
    expect(t.sent).toEqual([
      {
        agentId: AGENT,
        channel: "email",
        fromContactId: ERIN,
        subject: "Receipts",
        text: "Two receipts",
      },
    ]);
  });

  it("says why nothing started, and sends a text with no subject", async () => {
    const t = setup({
      status: "refused",
      reason: "sender_not_allowed",
      message: "Erin Employee isn't one of the people its text trigger takes messages from",
      reply: null,
    });
    await screen.findByRole("option", { name: "Erin Employee" });
    await t.user.selectOptions(screen.getByTestId("sandbox-test-channel"), "sms");
    expect(screen.queryByTestId("sandbox-test-subject")).toBeNull();
    await t.user.type(screen.getByTestId("sandbox-test-text"), "Hi");
    await t.user.click(screen.getByTestId("sandbox-test-send"));
    expect(await screen.findByTestId("sandbox-test-refused")).toHaveTextContent(
      "Nothing started: Erin Employee isn't one of the people its text trigger takes messages from.",
    );
    expect(t.sent).toEqual([{ agentId: AGENT, channel: "sms", fromContactId: ERIN, text: "Hi" }]);
  });
});
