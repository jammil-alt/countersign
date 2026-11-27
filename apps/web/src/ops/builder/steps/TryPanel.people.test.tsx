// Try it's "People in this test" (owner, 2026-11-27): shown when the workflow has a Contact step or
// an approval; "Ask me" by default in the Sandbox, sent with the test run; off anywhere else, with
// a line saying why; while the run waits on you, its progress says on what, in words.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ApiProvider } from "../../../api/useApi";
import { fakeApi } from "../../../test/fixtures";
import { OpsClientsProvider } from "../../OpsLayout";
import { hasPeople, TryPanel, type TryPanelProps, type TryRun, waitingOnYou } from "./TryPanel";
import type { Workflow } from "./types";

const AGENT = "00000000-0000-4000-8000-0000000000a1";
const VERSION = "00000000-0000-4000-8000-0000000000b1";
const RUN = "00000000-0000-4000-8000-0000000000c1";
const SANDBOX = "00000000-0000-4000-8000-0000000000e1";
const CLIENT = "00000000-0000-4000-8000-0000000000e2";

const contact = {
  id: "talk",
  kind: "do",
  name: "Ask Dana",
  doneBy: "contact",
  contact: { with: "{{trigger.contactId}}", channel: "email", goal: "Ask" },
};
const flow = (steps: unknown[]) =>
  ({
    schemaVersion: 5,
    triggers: [],
    outputs: [],
    steps: [...steps, { id: "end", kind: "end", name: "", outputs: [] }],
  }) as unknown as Workflow;

/** The run as `GET /api/ops/runs/:id` answers it, with these steps. */
function runDetail(status: string, steps: unknown[] = []) {
  return {
    run: {
      id: RUN,
      tenantId: SANDBOX,
      agentId: AGENT,
      agentVersionId: VERSION,
      workflowSlug: "ask",
      mode: "test",
      status,
      trigger: { by: "operator" },
      costUsd: "0.0000",
      error: null,
      startedAt: "2026-11-27T10:00:00.000Z",
      finishedAt: null,
      createdAt: "2026-11-27T10:00:00.000Z",
    },
    steps,
    toolCalls: [],
    actions: [],
    inbox: [],
    agent: null,
    version: 1,
    workflow: null,
  };
}

function open(api: ReturnType<typeof fakeApi>, props: Partial<TryPanelProps> = {}) {
  render(
    <MemoryRouter>
      <ApiProvider client={api.client}>
        <OpsClientsProvider
          value={[
            { id: SANDBOX, name: "Sandbox", sandbox: true } as never,
            { id: CLIENT, name: "Northside", sandbox: false } as never,
          ]}
        >
          <TryPanel
            agent={{ id: AGENT, kind: "template", tenantId: null }}
            workflow={flow([contact])}
            slug="ask"
            sample={{}}
            name="Ask"
            triggerKind="json"
            prepare={async () => VERSION}
            onMarks={() => {}}
            onSelect={() => {}}
            onClose={() => {}}
            {...props}
          />
        </OpsClientsProvider>
      </ApiProvider>
    </MemoryRouter>,
  );
  return userEvent.setup();
}

describe("People in this test", () => {
  it("is shown for a Contact step or an approval only", () => {
    expect(hasPeople(flow([contact]))).toBe(true);
    expect(
      hasPeople(
        flow([{ id: "w", kind: "do", name: "W", uses: { type: "action", action: "bill.create" } }]),
      ),
    ).toBe(true);
    expect(
      hasPeople(
        flow([
          {
            id: "w",
            kind: "do",
            name: "W",
            uses: { type: "action", action: "bill.create" },
            checks: { approval: { required: "not_required" } },
          },
        ]),
      ),
    ).toBe(false);
    expect(hasPeople(flow([{ id: "r", kind: "do", name: "R", doneBy: "rules" }]))).toBe(false);
    open(fakeApi({}), { workflow: flow([{ id: "r", kind: "do", name: "R", doneBy: "rules" }]) });
    expect(screen.queryByTestId("steps-try-people")).toBeNull();
  });

  it("asks you by default in the Sandbox, follows the wait, and says what it waits on", async () => {
    const sent: unknown[] = [];
    let polls = 0;
    const api = fakeApi({
      [`POST /api/ops/agents/${AGENT}/versions/${VERSION}/test-run`]: ({ init }) => {
        sent.push(JSON.parse(String(init.body)));
        return { runId: RUN, agentId: AGENT, versionId: VERSION };
      },
      [`GET /api/ops/runs/${RUN}`]: () => {
        polls += 1;
        return runDetail("waiting", [
          {
            id: "00000000-0000-4000-8000-0000000000f1",
            nodeId: "talk",
            nodeType: "conversation",
            skillRef: null,
            status: "waiting",
            input: null,
            output: null,
            summary: "Ask Dana: waiting for a reply",
            costUsd: "0",
            tokensIn: 0,
            tokensOut: 0,
            startedAt: "2026-11-27T10:00:10.000Z",
            finishedAt: null,
          },
        ]);
      },
    });
    const user = open(api);
    expect(screen.getByTestId("steps-try-people-ask")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("steps-try-people-words")).toHaveTextContent(
      "its messages go to you, and it waits for your answers and approvals",
    );
    expect(
      screen.getByRole("link", { name: "where the Sandbox's Records page says" }),
    ).toHaveAttribute("href", `/ops/clients/${SANDBOX}/records`);
    await user.click(screen.getByTestId("steps-try-run"));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ workflow: "ask", clientId: SANDBOX, people: "ask_me" });
    expect(await screen.findByTestId("steps-try-waiting")).toHaveTextContent(
      "Waiting for your answer: check your email.",
    );
    // It keeps following the run while it waits on you.
    await waitFor(() => expect(polls).toBeGreaterThan(1), { timeout: 4000 });
  });

  it("skips them when asked, and can't ask outside the Sandbox", async () => {
    const sent: unknown[] = [];
    const api = fakeApi({
      [`POST /api/ops/agents/${AGENT}/versions/${VERSION}/test-run`]: ({ init }) => {
        sent.push(JSON.parse(String(init.body)));
        return { runId: RUN, agentId: AGENT, versionId: VERSION };
      },
      [`GET /api/ops/runs/${RUN}`]: () => runDetail("succeeded"),
    });
    const user = open(api);
    await user.click(screen.getByTestId("steps-try-people-skip"));
    expect(screen.getByTestId("steps-try-people-words")).toHaveTextContent(
      "Nobody is sent anything",
    );
    await user.click(screen.getByTestId("steps-try-run"));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).not.toHaveProperty("people");

    await user.selectOptions(screen.getByTestId("steps-try-client"), CLIENT);
    expect(screen.getByTestId("steps-try-people-ask")).toBeDisabled();
    expect(screen.getByTestId("steps-try-people-skip")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("steps-try-people-words")).toHaveTextContent(
      "Ask me works in the Sandbox only.",
    );
  });

  it("says when it waits for you to approve in Your call", () => {
    const run = {
      run: { status: "waiting", error: null },
      steps: [],
      actions: [],
      inbox: [{ id: "i1", status: "open" }],
    } as unknown as TryRun;
    expect(waitingOnYou(run, flow([contact]))).toEqual({
      words: "Waiting for you to approve in Your call",
      yourCall: true,
    });
    expect(waitingOnYou({ ...run, run: { ...run.run, status: "succeeded" } }, flow([]))).toBeNull();
  });
});
