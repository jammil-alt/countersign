// O7 Triggers, the first part of the agent's Workflow tab: the latest version's triggers with when
// each last fired and their guards, the webhook and message settings on demand, adding a trigger
// from the dialog that explains the six kinds (saved as a new draft with a new id) and removing an
// added one.
import { type AgentBundleInput, AnyAgentBundle, type AnyAgentBundleInput } from "@countersign/core";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ApiProvider } from "../../api/useApi";
import {
  AGENT_DETAIL,
  AGENT_SUMMARY,
  FORK_BUNDLE_INPUT,
  fakeApi,
  PROCESS_BUNDLE_INPUT,
} from "../../test/fixtures";
import { TriggersPanel } from "./TriggersScreen";

const ID = AGENT_SUMMARY.id;
const HOOK = "00000000-0000-4000-8000-0000000a7001";
const RUN = "00000000-0000-4000-8000-0000000d0001";

const [first] = FORK_BUNDLE_INPUT.workflows ?? [];
const INPUT: AgentBundleInput = {
  ...FORK_BUNDLE_INPUT,
  workflows: [
    {
      ...(first as NonNullable<typeof first>),
      workflow: {
        ...(first as NonNullable<typeof first>).workflow,
        moreTriggers: [
          {
            id: "t-msg",
            on: {
              type: "message",
              channels: ["email", "command"],
              from: { tags: ["cardholder"], clientRoles: ["client_admin"] },
              reply: { confirm: "Got it." },
            },
          },
          {
            id: "t-hook",
            on: {
              type: "webhook",
              hookId: HOOK,
              dedupeKey: "{{trigger.data.id}}",
              rateLimit: { max: 60, per: "hour" },
            },
          },
        ],
      },
    },
  ],
};

const LATEST = { ...AGENT_DETAIL.latest, bundle: INPUT };

function setup(kind: "client" | "template" = "client", input: AnyAgentBundleInput = INPUT) {
  const saved: Record<string, unknown>[] = [];
  let changed = 0;
  const api = fakeApi({
    [`GET /api/ops/agents/${ID}/triggers`]: () => ({
      agentId: ID,
      versionId: AGENT_DETAIL.live.id,
      live: true,
      commandName: "costs",
      address: "costs@sandbox.agents.example.com",
      triggers: [
        {
          workflow: "new-bill",
          workflowName: "New bill",
          enabled: true,
          triggerId: "t1",
          type: "event",
          first: true,
          summary: "When bill.created",
          guards: { event: "bill.created" },
          lastFired: {
            at: "2026-11-05T08:00:00.000Z",
            runId: RUN,
            status: "succeeded",
            mode: "test",
          },
        },
      ],
    }),
    [`POST /api/ops/agents/${ID}/versions`]: ({ init }) => {
      saved.push(JSON.parse(String(init.body)));
      return {
        version: { ...AGENT_DETAIL.versions[0], version: 3, status: "draft" },
        errors: [],
      };
    },
    "GET /api/ops/catalog/events": () => ({ events: [] }),
  });
  const agent =
    kind === "client"
      ? AGENT_SUMMARY
      : { ...AGENT_SUMMARY, kind: "template" as const, tenantId: null };
  render(
    <MemoryRouter>
      <ApiProvider client={api.client}>
        <TriggersPanel
          agent={agent}
          latest={{ ...LATEST, bundle: input }}
          bundle={AnyAgentBundle.parse(input)}
          onChanged={() => {
            changed += 1;
          }}
        />
      </ApiProvider>
    </MemoryRouter>,
  );
  return { api, saved, changed: () => changed, user: userEvent.setup() };
}

describe("Triggers", () => {
  it("lists every trigger with its guards and last fired, and the message and webhook settings", async () => {
    const { user } = setup();
    expect(screen.getByTestId("triggers-table")).toHaveTextContent("Starts when · 3 triggers");
    const event = screen.getByTestId("trigger-row-t1");
    expect(await within(event).findByText(/Test ·/)).toBeInTheDocument();
    // Event ids never show: the catalog's words, else the id made readable.
    expect(event).toHaveTextContent("When bill created");
    expect(event).not.toHaveTextContent("bill.created");
    const message = screen.getByTestId("trigger-row-t-msg");
    expect(message).toHaveTextContent("Message");
    expect(message).toHaveTextContent(
      "Guards (limits on when it starts): from contacts tagged cardholder, the client's admins",
    );
    expect(message).toHaveTextContent("Never fired");
    expect(screen.getByTestId("trigger-row-t-hook")).toHaveTextContent(
      "once per {{trigger.data.id}} · at most 60 an hour",
    );
    // The first trigger of a workflow stays; added ones can be removed.
    expect(screen.queryByTestId("trigger-remove-t1")).toBeNull();
    expect(screen.getByTestId("trigger-remove-t-msg")).toBeInTheDocument();

    // Settings open on demand; the six kinds are explained in the Add a trigger dialog only.
    expect(screen.queryByTestId("trigger-message-t-msg")).toBeNull();
    expect(screen.queryByTestId("trigger-kind-schedule")).toBeNull();
    await user.click(screen.getByTestId("trigger-details-t-msg"));
    const settings = screen.getByTestId("trigger-message-t-msg");
    expect(settings).toHaveTextContent("Email · costs@sandbox.agents.example.com");
    expect(settings).toHaveTextContent("/costs in a thread");
    expect(settings).toHaveTextContent('Confirms: "Got it."');
    await user.click(screen.getByTestId("trigger-details-t-hook"));
    expect(screen.getByTestId("trigger-webhook-t-hook")).toHaveTextContent("60 runs per hour");
    expect(screen.getByTestId("trigger-webhook-t-hook")).not.toHaveTextContent(HOOK);

    await user.click(screen.getByTestId("triggers-add"));
    const dialog = screen.getByRole("dialog", { name: "Add a trigger" });
    expect(dialog).toHaveTextContent("Six ways an agent can start");
    for (const k of ["schedule", "event", "webhook", "manual", "message", "handoff"]) {
      expect(within(dialog).getByTestId(`trigger-kind-${k}`)).toBeInTheDocument();
    }
  });

  it("adds a schedule trigger as a new draft, with a new id", async () => {
    const { saved, changed, user } = setup();
    await user.click(screen.getByTestId("triggers-add"));
    expect(screen.getByTestId("trigger-kind-schedule")).toHaveAttribute("aria-pressed", "true");
    await user.clear(screen.getByTestId("trigger-form-cron"));
    await user.click(screen.getByTestId("trigger-form-save"));
    expect(screen.getByTestId("trigger-form-error")).toHaveTextContent(/cron/);
    expect(saved).toEqual([]);

    await user.type(screen.getByTestId("trigger-form-cron"), "0 8 * * 1-5");
    await user.click(screen.getByTestId("trigger-form-holidays"));
    await user.click(screen.getByTestId("trigger-form-save"));
    expect(await screen.findByTestId("triggers-saved")).toHaveTextContent("saved v3 as a draft");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(changed()).toBe(1);
    const body = saved[0] as {
      parentVersionId: string;
      bundle: { workflows: { workflow: { moreTriggers: { id: string; on: unknown }[] } }[] };
    };
    expect(body.parentVersionId).toBe(LATEST.id);
    const more = body.bundle.workflows[0]?.workflow.moreTriggers ?? [];
    expect(more.map((t) => t.id).slice(0, 2)).toEqual(["t-msg", "t-hook"]);
    expect(more[2]?.on).toEqual({ type: "schedule", cron: "0 8 * * 1-5", skipHolidays: true });
    expect(more[2]?.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("won't add a message trigger nobody may start", async () => {
    const { saved, user } = setup();
    await user.click(screen.getByTestId("triggers-add"));
    await user.click(screen.getByTestId("trigger-kind-message"));
    await user.click(screen.getByTestId("trigger-form-save"));
    expect(screen.getByTestId("trigger-form-error")).toHaveTextContent(/who may start it/);
    await user.click(screen.getByTestId("trigger-form-admins"));
    await user.click(screen.getByTestId("trigger-form-save"));
    expect(await screen.findByTestId("triggers-saved")).toBeInTheDocument();
    const body = saved[0] as {
      bundle: { workflows: { workflow: { moreTriggers: { on: unknown }[] } }[] };
    };
    expect(body.bundle.workflows[0]?.workflow.moreTriggers[2]?.on).toEqual({
      type: "message",
      channels: ["email"],
      from: { clientRoles: ["client_admin"] },
    });
  });

  it("removes an added trigger", async () => {
    const { saved, user } = setup();
    await user.click(screen.getByTestId("trigger-remove-t-msg"));
    expect(await screen.findByTestId("triggers-saved")).toHaveTextContent(
      "Removed a message trigger",
    );
    const body = saved[0] as {
      bundle: { workflows: { workflow: { moreTriggers: { id: string }[] } }[] };
    };
    expect(body.bundle.workflows[0]?.workflow.moreTriggers.map((t) => t.id)).toEqual(["t-hook"]);
  });

  // Wave 3b: a version that holds a v4 process lists its `triggers`, and adds to and removes
  // from them (its first stays), every id kept.
  it("lists, adds to and removes from a process's triggers", async () => {
    const { saved, user } = setup("client", PROCESS_BUNDLE_INPUT);
    expect(screen.getByTestId("triggers-table")).toHaveTextContent("Starts when · 2 triggers");
    expect(screen.getByTestId("trigger-row-t0")).toHaveTextContent("Manual");
    expect(screen.getByTestId("trigger-row-t1")).toHaveTextContent("When bill created");
    expect(screen.queryByTestId("trigger-remove-t0")).toBeNull();

    await user.click(screen.getByTestId("triggers-add"));
    await user.click(screen.getByTestId("trigger-form-save"));
    expect(await screen.findByTestId("triggers-saved")).toHaveTextContent("saved v3 as a draft");
    type Saved = { bundle: { workflows: { workflow: Record<string, unknown> }[] } };
    const added = (saved[0] as Saved).bundle.workflows[0]?.workflow;
    expect(added?.schemaVersion).toBe(4);
    expect(added).not.toHaveProperty("moreTriggers");
    const triggers = added?.triggers as { id: string; on: { type: string } }[];
    expect(triggers.map((t) => t.id).slice(0, 2)).toEqual(["t0", "t1"]);
    expect(triggers[2]?.on.type).toBe("schedule");

    await user.click(screen.getByTestId("trigger-remove-t1"));
    await screen.findByText(/Removed an? event trigger/);
    const removed = (saved[1] as Saved).bundle.workflows[0]?.workflow;
    const left = (removed?.triggers ?? []) as { id: string }[];
    expect(left.map((t) => t.id)).toEqual(["t0"]);
  });

  it("shows a template's triggers without asking when they fired", () => {
    const { api } = setup("template");
    expect(screen.getByTestId("trigger-row-t1")).not.toHaveTextContent("Never fired");
    expect(api.calls).not.toContain(`GET /api/ops/agents/${ID}/triggers`);
  });
});
