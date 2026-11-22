// The setup checklist on a client copy's page (docs/builder-plan.md §6, B4), in the go-live panel:
// what holds the trial, each item with who did what, and recording an item for the client.
import type { SetupRowView, SetupView } from "@countersign/core";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ApiProvider } from "../../api/useApi";
import { AGENT_SUMMARY, FORK_BUNDLE, fakeApi } from "../../test/fixtures";
import { GoLivePanel } from "./GoLivePanel";
import { setupWho } from "./SetupChecklist";

const AGENT = { ...AGENT_SUMMARY, kind: "client" as const, runStatus: "testing", status: "active" };

const row = (over: Partial<SetupRowView>): SetupRowView => ({
  id: "x",
  label: "x",
  kind: "answer",
  hint: "",
  guards: "setup",
  done: false,
  byConnection: false,
  setsValue: false,
  suggested: null,
  options: null,
  min: null,
  max: null,
  connector: null,
  value: null,
  files: 0,
  byName: null,
  side: null,
  at: null,
  ...over,
});

const SETUP: SetupView = {
  items: [
    row({
      id: "connect-qbo",
      label: "Connect QuickBooks Online",
      kind: "connect",
      byConnection: true,
      done: true,
    }),
    row({
      id: "decision-tol",
      label: "How far may a price move?",
      setsValue: true,
      done: true,
      value: "2",
      byName: "Dana Admin",
      side: "client",
      at: "2026-11-18T10:00:00.000Z",
    }),
    row({ id: "form-list", label: "Your vendor list", kind: "file" }),
    row({
      id: "write-start-qbo",
      label: "When do we start writing into QuickBooks Online?",
      kind: "confirm",
      guards: "trial",
    }),
  ],
  holds: {
    trial:
      "The setup checklist isn't done: Your vendor list; When do we start writing into QuickBooks Online.",
    live: "The setup checklist isn't done: Your vendor list; When do we start writing into QuickBooks Online.",
  },
  done: 2,
  total: 4,
};

const BENCH = {
  stage: "bench",
  writes: true,
  trial: null,
  signoff: null,
  skipped: [],
  rejections: [],
  pause: null,
  setup: SETUP,
};

describe("the setup checklist on a client copy's page", () => {
  it("says what holds the trial and who did each item", async () => {
    const recorded: unknown[] = [];
    const api = fakeApi({
      [`GET /api/ops/agents/${AGENT.id}/go-live`]: () => ({ goLive: BENCH }),
      [`POST /api/ops/agents/${AGENT.id}/setup/write-start-qbo`]: ({ init }) => {
        recorded.push(JSON.parse(String(init.body)));
        return { goLive: BENCH };
      },
    });
    render(
      <ApiProvider client={api.client}>
        <MemoryRouter>
          <GoLivePanel agent={AGENT} liveBundle={FORK_BUNDLE} onChanged={() => {}} />
        </MemoryRouter>
      </ApiProvider>,
    );
    expect(await screen.findByTestId("setup-count")).toHaveTextContent("2 of 4 done");
    expect(screen.getByTestId("setup-holds-trial")).toHaveTextContent(
      "Waiting on the client The trial can't start yet. The setup checklist isn't done: Your vendor list",
    );
    expect(screen.getByTestId("setup-who-connect-qbo")).toHaveTextContent("Connected and bound");
    expect(screen.getByTestId("setup-who-decision-tol")).toHaveTextContent(
      /^Answered by Dana Admin \(client\) on .+: 2$/,
    );
    expect(screen.getByTestId("setup-item-write-start-qbo")).toHaveTextContent(
      "Waiting on the client",
    );
    // A connect item is the client's to connect; a file we send for them, not "record" (G10).
    expect(screen.queryByTestId("setup-record-connect-qbo")).toBeNull();
    expect(screen.queryByTestId("setup-record-form-list")).toBeNull();
    expect(screen.queryByTestId("setup-file-connect-qbo")).toBeNull();
    expect(screen.getByTestId("setup-file-form-list")).toBeInTheDocument();

    // We record a confirm for the client, with a note.
    const user = userEvent.setup();
    await user.click(screen.getByTestId("setup-record-write-start-qbo"));
    await user.type(screen.getByTestId("setup-value-write-start-qbo"), "Agreed on the call");
    await user.click(screen.getByTestId("setup-save-write-start-qbo"));
    await waitFor(() => expect(recorded).toEqual([{ value: "Agreed on the call" }]));
  });

  it("sends a file item's files for the client (G10)", async () => {
    const api = fakeApi({
      [`GET /api/ops/agents/${AGENT.id}/go-live`]: () => ({ goLive: BENCH }),
    });
    const sent: string[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(`${init?.method} ${String(input)}`);
      const files = (init?.body as FormData | undefined)?.getAll("files") as File[];
      sent.push(...files.map((f) => f.name));
      return new Response(JSON.stringify({ goLive: BENCH, refused: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetch);
    try {
      render(
        <ApiProvider client={api.client}>
          <MemoryRouter>
            <GoLivePanel agent={AGENT} liveBundle={FORK_BUNDLE} onChanged={() => {}} />
          </MemoryRouter>
        </ApiProvider>,
      );
      const input = await screen.findByTestId("setup-file-form-list");
      const user = userEvent.setup();
      await user.upload(input, new File(["a"], "vendors.pdf", { type: "application/pdf" }));
      await waitFor(() =>
        expect(sent).toEqual([
          `POST /api/ops/agents/${AGENT.id}/setup/form-list/files`,
          "vendors.pdf",
        ]),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("says who did an item in plain words", () => {
    expect(setupWho(row({}))).toBeNull();
    expect(
      setupWho(
        row({
          kind: "confirm",
          done: true,
          side: "operator",
          byName: "Sam Ops",
          at: "2026-11-18T10:00:00.000Z",
        }),
      ),
    ).toMatch(/^Confirmed by Sam Ops \(us\) on /);
    expect(
      setupWho(row({ kind: "file", done: true, files: 2, side: "client", byName: "Dana" })),
    ).toBe("Sent by Dana (client): 2 files");
  });
});
