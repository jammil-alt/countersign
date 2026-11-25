// O7 Triggers, the first part of the agent's Workflow tab: the latest version's triggers with when
// each last fired and their guards, the webhook and message settings on demand, adding a trigger
// from the dialog that explains the six kinds (saved as a new draft with a new id) and removing an
// added one.
import { AgentBundle, type AgentBundleInput } from "@countersign/core";
import { fireEvent, render, screen, within } from "@testing-library/react";
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
const INPUT = {
  ...FORK_BUNDLE_INPUT,
  workflows: [
    {
      ...(first as NonNullable<typeof first>),
      workflow: {
        ...(first as NonNullable<typeof first>).workflow,
        triggers: [
          ...((first as NonNullable<typeof first>).workflow as { triggers: unknown[] }).triggers,
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
} as unknown as AgentBundleInput;

const LATEST = { ...AGENT_DETAIL.latest, bundle: INPUT };

function setup(
  kind: "client" | "template" = "client",
  input: AgentBundleInput = INPUT,
  errors: { stepId: string | null; message: string; workflow?: string }[] = [],
) {
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
          bundle={AgentBundle.parse(input)}
          errors={errors}
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
  // S6.5: a draft's schedule of "99 99 99 99 99" in "Not/AZone" read On with no issue.
  it("says a trigger the draft's check stops won't start, and why", () => {
    setup("client", INPUT, [
      {
        stepId: "t-hook",
        workflow: "new-bill",
        message: "a schedule needs five cron fields, e.g. 0 7 * * 1-5",
      },
      { stepId: "t-hook", workflow: "other", message: "not this workflow's" },
      { stepId: "some-step", message: "a step's problem" },
    ]);
    const row = screen.getByTestId("trigger-row-t-hook");
    expect(row).toHaveTextContent("Won't start");
    expect(row).not.toHaveTextContent(/\bOn\b/);
    expect(within(row).getByTestId("trigger-problems-t-hook")).toHaveTextContent(
      "Fix before publishing: a schedule needs five cron fields, e.g. 0 7 * * 1-5.",
    );
    expect(row).not.toHaveTextContent("not this workflow's");
    // The other rows are as they were.
    expect(screen.getByTestId("trigger-row-t1")).toHaveTextContent("On");
    expect(screen.queryByTestId("trigger-problems-t1")).toBeNull();
  });

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

  it("refuses a cron line out of range and a time zone it doesn't know", async () => {
    const { saved, user } = setup();
    await user.click(screen.getByTestId("triggers-add"));
    // The schedule is picked in words; a cron line is written under Custom.
    expect(screen.getByTestId("trigger-form-schedule-words")).toHaveTextContent(
      "Runs: Weekdays at 8:00 AM, in the client's time zone.",
    );
    await user.selectOptions(screen.getByTestId("trigger-form-schedule-repeats"), "custom");
    await user.clear(screen.getByTestId("trigger-form-cron"));
    await user.type(screen.getByTestId("trigger-form-cron"), "99 99 99 99 99");
    await user.click(screen.getByTestId("trigger-form-save"));
    expect(screen.getByTestId("trigger-form-error")).toHaveTextContent(/cron line isn't one/);

    await user.clear(screen.getByTestId("trigger-form-cron"));
    await user.type(screen.getByTestId("trigger-form-cron"), "0 8 * * 1-5");
    await user.selectOptions(screen.getByTestId("trigger-form-schedule-zone"), "other");
    await user.type(screen.getByTestId("trigger-form-tz"), "Not/AZone");
    await user.click(screen.getByTestId("trigger-form-save"));
    expect(screen.getByTestId("trigger-form-error")).toHaveTextContent(/time zone/);
    expect(saved).toEqual([]);
  });

  it("adds a schedule trigger as a new draft, with a new id", async () => {
    const { saved, changed, user } = setup();
    await user.click(screen.getByTestId("triggers-add"));
    expect(screen.getByTestId("trigger-kind-schedule")).toHaveAttribute("aria-pressed", "true");
    await user.selectOptions(screen.getByTestId("trigger-form-schedule-repeats"), "custom");
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
      bundle: { workflows: { workflow: { triggers: { id: string; on: unknown }[] } }[] };
    };
    expect(body.parentVersionId).toBe(LATEST.id);
    const more = (body.bundle.workflows[0]?.workflow.triggers ?? []).slice(1);
    expect(more.map((t) => t.id).slice(0, 2)).toEqual(["t-msg", "t-hook"]);
    expect(more[2]?.on).toEqual({ type: "schedule", cron: "0 8 * * 1-5", skipHolidays: true });
    expect(more[2]?.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  // Owner, 2026-11-21 (docs/plan.md §1.177): "human readable time and days… the first Monday of
  // the month, or every other Monday or the third Thursday".
  it("picks a schedule in words: the third Thursday, then every other Monday", async () => {
    const { saved, user } = setup();
    await user.click(screen.getByTestId("triggers-add"));
    const words = () => screen.getByTestId("trigger-form-schedule-words");
    await user.selectOptions(screen.getByTestId("trigger-form-schedule-repeats"), "month");
    await user.selectOptions(screen.getByTestId("trigger-form-schedule-month-week"), "3");
    await user.selectOptions(screen.getByTestId("trigger-form-schedule-month-weekday"), "4");
    fireEvent.change(screen.getByTestId("trigger-form-schedule-time"), {
      target: { value: "14:30" },
    });
    await user.selectOptions(screen.getByTestId("trigger-form-schedule-zone"), "America/Chicago");
    expect(words()).toHaveTextContent(
      "Runs: The third Thursday of every month at 2:30 PM, Central Time.",
    );

    await user.selectOptions(screen.getByTestId("trigger-form-schedule-repeats"), "week");
    // It starts on Mondays; Thursday is added and taken off again.
    expect(screen.getByTestId("trigger-form-schedule-day-1")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(screen.getByTestId("trigger-form-schedule-day-4"));
    expect(words()).toHaveTextContent("Runs: Mondays and Thursdays at 2:30 PM, Central Time.");
    await user.click(screen.getByTestId("trigger-form-schedule-day-4"));
    await user.selectOptions(screen.getByTestId("trigger-form-schedule-weeks"), "2");
    fireEvent.change(screen.getByTestId("trigger-form-schedule-from"), {
      target: { value: "2026-11-25" },
    });
    expect(words()).toHaveTextContent("Runs: Every other Monday at 2:30 PM, Central Time.");
    await user.click(screen.getByTestId("trigger-form-save"));
    expect(await screen.findByTestId("triggers-saved")).toBeInTheDocument();
    const body = saved[0] as {
      bundle: { workflows: { workflow: { triggers: { on: unknown }[] } }[] };
    };
    // Stored as a cron and, beside it, the weeks it skips, counted from that week's Sunday.
    expect(body.bundle.workflows[0]?.workflow.triggers[3]?.on).toEqual({
      type: "schedule",
      cron: "30 14 * * 1",
      tz: "America/Chicago",
      every: { weeks: 2, from: "2026-11-22" },
    });
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
      bundle: { workflows: { workflow: { triggers: { on: unknown }[] } }[] };
    };
    expect(body.bundle.workflows[0]?.workflow.triggers[3]?.on).toEqual({
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
      bundle: { workflows: { workflow: { triggers: { id: string }[] } }[] };
    };
    expect(body.bundle.workflows[0]?.workflow.triggers.map((t) => t.id)).toEqual(["t1", "t-hook"]);
  });

  // Wave 3b: a version lists its `triggers`, and adds to and removes
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
    expect(added?.schemaVersion).toBe(5);
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
