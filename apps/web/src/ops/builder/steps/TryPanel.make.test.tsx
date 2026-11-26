// Try it's Make up data (owner, 2026-11-26): JSON from the trigger's shape, or a made-up document
// kept in the Sandbox; a client's own agent is offered no document.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ApiProvider } from "../../../api/useApi";
import { fakeApi } from "../../../test/fixtures";
import { TryPanel, type TryPanelProps } from "./TryPanel";
import type { Workflow } from "./types";

const AGENT = "00000000-0000-4000-8000-0000000000a1";
const VERSION = "00000000-0000-4000-8000-0000000000b1";
const RUN = "00000000-0000-4000-8000-0000000000c1";
const workflow = { schemaVersion: 5, triggers: [], outputs: [], steps: [] } as unknown as Workflow;

function open(api: ReturnType<typeof fakeApi>, props: Partial<TryPanelProps> = {}) {
  render(
    <MemoryRouter>
      <ApiProvider client={api.client}>
        <TryPanel
          agent={{ id: AGENT, kind: "template", tenantId: null }}
          workflow={workflow}
          slug="bills"
          sample={{}}
          name="Bills"
          documentTrigger={false}
          prepare={async () => null}
          onMarks={() => {}}
          onSelect={() => {}}
          onClose={() => {}}
          {...props}
        />
      </ApiProvider>
    </MemoryRouter>,
  );
  return userEvent.setup();
}

describe("Make up data", () => {
  it("fills the input from what was made up, with the person's words sent along", async () => {
    const sent: unknown[] = [];
    const api = fakeApi({
      [`POST /api/ops/agents/${AGENT}/test-data`]: ({ init }) => {
        sent.push(JSON.parse(String(init.body)));
        return {
          trigger: { vendor: "Hartwell Supply", total: "640.40" },
          missing: false,
          document: null,
        };
      },
    });
    const user = open(api);
    await user.type(screen.getByTestId("steps-try-notes"), "a lumber bill");
    await user.click(screen.getByTestId("steps-try-make-up"));
    await waitFor(() =>
      expect(screen.getByTestId("steps-try-input")).toHaveValue(
        JSON.stringify({ vendor: "Hartwell Supply", total: "640.40" }, null, 2),
      ),
    );
    expect(sent).toEqual([{ workflow, name: "Bills", notes: "a lumber bill" }]);
    expect(screen.getByTestId("steps-try-made")).toHaveTextContent("Made up.");
  });

  it("makes up a document for a document trigger, and says where it is kept", async () => {
    const api = fakeApi({
      [`POST /api/ops/agents/${AGENT}/test-data`]: () => ({
        trigger: { documentId: "d1", filename: "receipt-hartwell-supply-1042.pdf" },
        missing: false,
        document: { id: "d1", filename: "receipt-hartwell-supply-1042.pdf", clientId: "c1" },
      }),
    });
    const user = open(api, { documentTrigger: true });
    expect(screen.getByTestId("steps-try-make-up")).toHaveTextContent("Make up a document");
    await user.click(screen.getByTestId("steps-try-make-up"));
    expect(await screen.findByTestId("steps-try-made")).toHaveTextContent(
      "Made receipt-hartwell-supply-1042.pdf, in the Sandbox.",
    );
    expect(screen.getByTestId("steps-try-input")).toHaveValue(
      JSON.stringify({ documentId: "d1", filename: "receipt-hartwell-supply-1042.pdf" }, null, 2),
    );
  });

  it("offers a client's own agent no made-up document", () => {
    open(fakeApi({}), {
      agent: { id: AGENT, kind: "client", tenantId: "c2" },
      documentTrigger: true,
    });
    expect(screen.queryByTestId("steps-try-make-up")).toBeNull();
    expect(screen.getByTestId("steps-try-make")).toHaveTextContent("kept in the Sandbox only");
  });
});

describe("Which steps", () => {
  const three = {
    schemaVersion: 5,
    triggers: [],
    outputs: [],
    steps: [
      { id: "one", kind: "do", name: "First" },
      { id: "two", kind: "do", name: "Second" },
      { id: "three", kind: "do", name: "Third", input: { a: "{{steps.two.output.sent}}" } },
      { id: "end", kind: "end", name: "", outputs: [] },
    ],
  } as unknown as Workflow;

  it("runs from one step to another, with what an earlier step gave", async () => {
    const sent: unknown[] = [];
    const api = fakeApi({
      [`POST /api/ops/agents/${AGENT}/versions/${VERSION}/test-run`]: ({ init }) => {
        sent.push(JSON.parse(String(init.body)));
        return { runId: RUN, agentId: AGENT, versionId: VERSION };
      },
      [`GET /api/ops/runs/${RUN}`]: () => ({
        run: { status: "succeeded", error: null },
        steps: [],
        actions: [],
      }),
    });
    const user = open(api, {
      agent: { id: AGENT, kind: "client", tenantId: "c1" },
      workflow: three,
      prepare: async () => VERSION,
    });
    await user.click(screen.getByTestId("steps-try-some"));
    await user.selectOptions(screen.getByTestId("steps-try-from"), "three");
    // The End isn't a step to pick.
    expect(screen.getByTestId("steps-try-to").querySelectorAll("option")).toHaveLength(3);
    const box = screen.getByTestId("steps-try-given-two");
    await user.clear(box);
    await user.type(box, '{{"sent": true}');
    expect(screen.getByTestId("steps-try-given-two")).toHaveValue('{"sent": true}');
    expect(screen.queryByTestId("steps-try-range-problem")).toBeNull();
    expect(screen.getByTestId("steps-try-run")).toBeEnabled();
    await user.click(screen.getByTestId("steps-try-run"));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({
      workflow: "bills",
      range: { from: "three", to: "three", given: { two: { sent: true } } },
    });
  });

  it("says why a range can't run", async () => {
    const user = open(fakeApi({}), {
      agent: { id: AGENT, kind: "client", tenantId: "c1" },
      workflow: three,
    });
    await user.click(screen.getByTestId("steps-try-some"));
    await user.selectOptions(screen.getByTestId("steps-try-from"), "three");
    await user.selectOptions(screen.getByTestId("steps-try-to"), "one");
    expect(screen.getByTestId("steps-try-range-problem")).toHaveTextContent(
      "The last step comes before the first.",
    );
    expect(screen.getByTestId("steps-try-run")).toBeDisabled();
  });
});
