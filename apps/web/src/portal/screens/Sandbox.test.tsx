// The portal's sandbox (docs/plan.md §1.243): pick an agent, start it on a recent document or with
// a form, then its run (read again while it runs): its steps, what it would do, and Send to me. A
// viewer reads only; an agent already running, or a day's runs used up, starts nothing. A run of
// ours reads "Mezonas". Every word in the reader's language.
import type { Locale, SandboxView } from "@countersign/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { CLIENT_SESSION, fakeApi } from "../../test/fixtures";
import { SANDBOX_EMAIL, SANDBOX_RUN, sandboxRun } from "../../test/sandbox";

const SLOW = 20_000;
const AGENT = "00000000-0000-4000-8000-0000000a0001";
const OTHER = "00000000-0000-4000-8000-0000000a0002";
const DOC = "00000000-0000-4000-8000-0000000dc001";
const OURS = "00000000-0000-4000-8000-0000000e5002";

function view(over: Partial<SandboxView> = {}): SandboxView {
  return {
    agents: [
      {
        id: AGENT,
        name: "Order desk",
        documents: [],
        forms: [
          {
            workflow: "orders",
            label: "Send an order",
            input: {
              type: "object",
              properties: { note: { type: "string", title: "Note" } },
            },
          },
        ],
        running: false,
      },
      {
        id: OTHER,
        name: "Bill clerk",
        documents: [
          {
            documentId: DOC,
            title: "Northside Lumber · $4,812.50",
            from: "ap@northside.example.com",
            at: "2026-11-23T15:00:00.000Z",
          },
        ],
        forms: [],
        running: false,
      },
    ],
    runs: [
      {
        runId: OURS,
        agentId: AGENT,
        agentName: "Order desk",
        title: "Send an order",
        status: "done",
        startedAt: "2026-11-23T09:00:00.000Z",
        side: "ops",
        byName: "Mezonas",
        changes: 3,
        messages: 2,
      },
    ],
    use: { runs: 3, maxRuns: 20, sends: 0, maxSends: 20 },
    canTry: true,
    ...over,
  };
}

function setup(path: string, current = view(), locale: Locale = "en") {
  const sent: { route: string; body: unknown }[] = [];
  let reads = 0;
  const api = fakeApi({
    "GET /api/session": () => ({
      ...CLIENT_SESSION,
      language: { effective: locale, user: locale, client: null },
    }),
    "GET /api/feedback/status": () => ({ enabled: false }),
    "GET /api/sandbox": () => current,
    "POST /api/sandbox/runs": ({ init }) => {
      sent.push({ route: "start", body: JSON.parse(String(init.body)) });
      return { run: sandboxRun({ status: "running", steps: [], changes: [], notices: [] }) };
    },
    [`GET /api/sandbox/runs/${SANDBOX_RUN}`]: () => {
      reads += 1;
      // The first read is still running; the next has finished.
      return reads === 1
        ? { run: sandboxRun({ status: "running", changes: [], notices: [] }) }
        : { run: sandboxRun() };
    },
    [`POST /api/sandbox/runs/${SANDBOX_RUN}/changes/${SANDBOX_EMAIL}/send`]: () => {
      sent.push({ route: "send", body: null });
      const run = sandboxRun();
      return {
        run: {
          ...run,
          changes: run.changes.map((c) =>
            c.id === SANDBOX_EMAIL
              ? {
                  ...c,
                  sent: [
                    {
                      at: "2026-11-24T10:05:00.000Z",
                      byName: "Demo admin",
                      channel: "email" as const,
                      to: "admin@demo-client.example.com",
                    },
                  ],
                }
              : c,
          ),
        },
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

describe("the portal's sandbox", () => {
  it(
    "is in the sidebar, lists the runs and today's use, and draws an agent's forms",
    async () => {
      setup("/sandbox");
      expect(await screen.findByTestId("sandbox-use")).toHaveTextContent("3 of 20 runs today.");
      expect(screen.getByTestId("portal-nav-sandbox")).toHaveAttribute("aria-current", "page");
      const form = screen.getByTestId("sandbox-form-orders");
      expect(form).toHaveTextContent("Send an order");
      expect(within(form).getByLabelText("Note")).toBeInTheDocument();
      expect(within(form).getByTestId("sandbox-form-orders-run")).toBeEnabled();
      // A run of ours reads as ours, with what it would do.
      const row = screen.getByTestId(`sandbox-run-row-${OURS}`);
      expect(row).toHaveTextContent("By Mezonas");
      expect(row).toHaveTextContent("3 changes · 2 messages");
      expect(row).toHaveAttribute("href", `/sandbox/${OURS}`);

      // The other agent starts from a recent document.
      await userEvent.click(screen.getByTestId(`sandbox-agent-${OTHER}`));
      expect(await screen.findByTestId(`sandbox-document-${DOC}`)).toHaveTextContent(
        "Northside Lumber · $4,812.50",
      );
      expect(screen.queryByTestId("sandbox-form-orders")).toBeNull();
    },
    SLOW,
  );

  it(
    "starts a run with a form, shows it as it runs, and sends the email to the reader",
    async () => {
      const { sent } = setup("/sandbox");
      const form = await screen.findByTestId("sandbox-form-orders");
      await userEvent.type(within(form).getByLabelText("Note"), "rush");
      await userEvent.click(within(form).getByTestId("sandbox-form-orders-run"));
      expect(sent[0]).toEqual({
        route: "start",
        body: { agentId: AGENT, workflow: "orders", input: { note: "rush" } },
      });
      // The run's page, read again until it has finished.
      expect(await screen.findByTestId("portal-sandbox-run")).toBeInTheDocument();
      expect(await screen.findByTestId("sandbox-run-status")).toHaveTextContent("Running");
      await waitFor(
        () => expect(screen.getByTestId("sandbox-run-status")).toHaveTextContent("Done"),
        { timeout: 5_000 },
      );
      expect(screen.getByTestId("sandbox-run-not-written")).toBeInTheDocument();
      const email = screen.getByTestId(`sandbox-change-${SANDBOX_EMAIL}`);
      await userEvent.click(within(email).getByTestId(`sandbox-change-${SANDBOX_EMAIL}-send`));
      await waitFor(() => expect(sent.map((s) => s.route)).toEqual(["start", "send"]));
      expect(
        await within(email).findByTestId(`sandbox-change-${SANDBOX_EMAIL}-sent`),
      ).toHaveTextContent("Sent to Demo admin");
    },
    SLOW,
  );

  it(
    "starts nothing for a viewer, says why, and reads in the reader's language",
    async () => {
      setup("/sandbox", view({ canTry: false }), "de");
      expect(await screen.findByTestId("sandbox-read-only")).toHaveTextContent(
        "Nur wer unterschreiben darf",
      );
      expect(screen.getByTestId("sandbox-use")).toHaveTextContent("Heute 3 von 20 Läufen.");
      expect(screen.getByTestId("sandbox-form-orders-run")).toBeDisabled();
      expect(screen.getByTestId(`sandbox-run-row-${OURS}`)).toHaveTextContent(
        "3 Änderungen · 2 Nachrichten",
      );
    },
    SLOW,
  );

  it(
    "waits while the agent is running or today's runs are used up",
    async () => {
      const running = view();
      const [first] = running.agents;
      if (first) first.running = true;
      setup("/sandbox", { ...running, use: { runs: 20, maxRuns: 20, sends: 0, maxSends: 20 } });
      expect(await screen.findByTestId("sandbox-agent-running")).toHaveTextContent(
        "Order desk is running in the sandbox.",
      );
      expect(screen.getByTestId("sandbox-use")).toHaveTextContent("That's all for today.");
      expect(screen.getByTestId("sandbox-form-orders-run")).toBeDisabled();
    },
    SLOW,
  );
});
