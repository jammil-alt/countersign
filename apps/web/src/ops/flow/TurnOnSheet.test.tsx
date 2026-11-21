// Turn on's sheet (docs/builder-plan.md §12.4): the preview on open, the items in their colours,
// Try it and Go through them, the client picker for a template, Start the trial held while
// something of ours holds it, and the press with its answer.
import type { TurnOnAnswer, TurnOnItem } from "@countersign/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiProvider } from "../../api/useApi";
import { fakeApi, Reply } from "../../test/fixtures";
import { TurnOnSheet, type TurnOnSheetProps } from "./TurnOnSheet";

const AGENT = "00000000-0000-7000-8000-0000000000a1";
const CLIENT = "00000000-0000-7000-8000-0000000000c1";
const OTHER = "00000000-0000-7000-8000-0000000000c2";
const VERSION = "00000000-0000-7000-8000-0000000000f1";
const COPY = "00000000-0000-7000-8000-0000000000b1";

const item = (over: Partial<TurnOnItem> & Pick<TurnOnItem, "key" | "kind">): TurnOnItem => ({
  title: over.key,
  owner: "operator",
  holds: false,
  ...over,
});

const answer = (over: Partial<TurnOnAnswer> = {}): TurnOnAnswer => ({
  agentId: null,
  clientId: CLIENT,
  clientName: "Harbor Millwork",
  versionId: VERSION,
  version: 3,
  started: false,
  stage: "bench",
  items: [
    item({
      key: "decision:d1",
      kind: "decision",
      title: "It writes bills into QuickBooks",
      done: false,
    }),
    item({ key: "tried", kind: "tried", title: "Tried on a real example", done: true }),
    item({
      key: "connect:qbo",
      kind: "connect",
      title: "QuickBooks is connected",
      owner: "client",
      done: true,
    }),
    item({
      key: "connect:gmail",
      kind: "connect",
      title: "Connect Gmail",
      owner: "client",
      waits: true,
    }),
  ],
  ...over,
});

const untried = answer({
  items: [
    item({
      key: "tried",
      kind: "tried",
      title: "Not tried yet",
      detail: "Run it once at Harbor Millwork on a real example before they see it.",
      holds: true,
    }),
  ],
});

function setup(
  routes: Record<string, (req: { url: URL; init: RequestInit }) => unknown>,
  props: Partial<TurnOnSheetProps> = {},
) {
  const api = fakeApi(routes);
  const handlers = {
    onTry: vi.fn(),
    onNextOpen: vi.fn(),
    onStarted: vi.fn(),
    onChanged: vi.fn(),
    onClose: vi.fn(),
  };
  render(
    <ApiProvider client={api.client}>
      <TurnOnSheet agentId={AGENT} template={false} {...handlers} {...props} />
    </ApiProvider>,
  );
  return { api, ...handlers };
}

const path = `/api/ops/agents/${AGENT}/turn-on`;

describe("TurnOnSheet", () => {
  it("reads the preview on open and lists ours, the client's and what is done", async () => {
    setup({ [`GET ${path}`]: () => answer() }, { toSettle: 6, onNextOpen: vi.fn() });
    const sheet = await screen.findByTestId("flow-turn-on");
    expect(within(sheet).getByRole("heading")).toHaveTextContent(
      "Start the trial at Harbor Millwork",
    );
    expect(sheet).toHaveTextContent("Turn on");
    expect(sheet).toHaveTextContent("it publishes v3, binds Harbor Millwork's connections");
    await screen.findByTestId("flow-turn-on-item-tried");
    // Ours waits on you; the client's waits on them; what is done has no word.
    expect(screen.getByTestId("flow-turn-on-wait-decision:d1")).toHaveTextContent("Waiting on you");
    expect(screen.getByTestId("flow-turn-on-wait-connect:gmail")).toHaveTextContent(
      "Waiting on Harbor Millwork",
    );
    expect(screen.queryByTestId("flow-turn-on-wait-tried")).toBeNull();
    expect(screen.queryByTestId("flow-turn-on-wait-connect:qbo")).toBeNull();
    expect(screen.getByTestId("flow-turn-on-item-connect:gmail")).toHaveTextContent(
      "The trial starts once this is done",
    );
    expect(screen.getByTestId("flow-turn-on-settle")).toHaveTextContent(
      "6 still to settle on their steps",
    );
    // Nothing of ours holds it: the button is on.
    expect(screen.getByTestId("flow-turn-on-start")).toBeEnabled();
  });

  it("holds Start the trial while it was never tried, and offers Try it", async () => {
    const { onTry, onNextOpen } = setup(
      { [`GET ${path}`]: () => untried },
      { toSettle: 2, onNextOpen: vi.fn() },
    );
    const tryIt = await screen.findByTestId("flow-turn-on-try");
    expect(screen.getByTestId("flow-turn-on-start")).toBeDisabled();
    expect(screen.getByTestId("flow-turn-on-wait-tried")).toHaveTextContent("Waiting on you");
    await userEvent.click(tryIt);
    expect(onTry).toHaveBeenCalledWith(CLIENT);
    expect(onNextOpen).not.toHaveBeenCalled();
  });

  it("calls Go through them", async () => {
    const onNextOpen = vi.fn();
    setup({ [`GET ${path}`]: () => answer() }, { toSettle: 1, onNextOpen });
    await userEvent.click(await screen.findByTestId("flow-turn-on-next-open"));
    expect(onNextOpen).toHaveBeenCalled();
    expect(screen.getByTestId("flow-turn-on-settle")).toHaveTextContent(
      "1 still to settle on its step",
    );
  });

  it("starts the trial and tells the host", async () => {
    const started = answer({ agentId: COPY, started: true, stage: "trial" });
    let sent: unknown;
    const { onStarted, onChanged } = setup({
      [`GET ${path}`]: () => answer(),
      [`POST ${path}`]: ({ init }) => {
        sent = JSON.parse(String(init.body));
        return started;
      },
    });
    const start = await screen.findByTestId("flow-turn-on-start");
    await waitFor(() => expect(start).toBeEnabled());
    await userEvent.click(start);
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith(started));
    expect(onChanged).toHaveBeenCalledWith(started);
    expect(sent).toEqual({});
    expect(await screen.findByTestId("flow-turn-on-started")).toHaveTextContent(
      "in its trial at Harbor Millwork",
    );
  });

  it("shows what still waits when it set up without starting", async () => {
    const waiting = answer({ agentId: COPY, refused: ["connector gmail is not bound"] });
    const { onStarted, onChanged } = setup({
      [`GET ${path}`]: () => answer(),
      [`POST ${path}`]: () => waiting,
    });
    const start = await screen.findByTestId("flow-turn-on-start");
    await waitFor(() => expect(start).toBeEnabled());
    await userEvent.click(start);
    expect(await screen.findByTestId("flow-turn-on-refused")).toHaveTextContent(
      "the trial hasn't started: connector gmail is not bound",
    );
    expect(onStarted).not.toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalledWith(waiting);
  });

  it("shows the items a 409 holds it on", async () => {
    setup({
      [`GET ${path}`]: () => answer(),
      [`POST ${path}`]: () =>
        new Reply(409, {
          error: { code: "turn_on_held", message: "not yet: not tried yet", details: untried },
        }),
    });
    const start = await screen.findByTestId("flow-turn-on-start");
    await waitFor(() => expect(start).toBeEnabled());
    await userEvent.click(start);
    expect(await screen.findByTestId("flow-turn-on-held")).toHaveTextContent("Not yet");
    expect(screen.getByTestId("flow-turn-on-try")).toBeInTheDocument();
    expect(screen.getByTestId("flow-turn-on-start")).toBeDisabled();
  });

  it("asks a template's client first, then previews and starts there", async () => {
    let previewed: string | null = null;
    let sent: unknown;
    const { api } = setup(
      {
        [`GET ${path}`]: ({ url }) => {
          previewed = url.searchParams.get("client");
          return answer({ clientId: OTHER, clientName: "Oak Supply" });
        },
        [`POST ${path}`]: ({ init }) => {
          sent = JSON.parse(String(init.body));
          return answer({
            clientId: OTHER,
            clientName: "Oak Supply",
            started: true,
            stage: "trial",
          });
        },
      },
      {
        template: true,
        clients: [
          { id: CLIENT, name: "Harbor Millwork" },
          { id: OTHER, name: "Oak Supply" },
        ],
        versionId: VERSION,
      },
    );
    expect(await screen.findByText("Pick the client it starts at.")).toBeInTheDocument();
    expect(screen.getByTestId("flow-turn-on-start")).toBeDisabled();
    expect(api.calls).toEqual([]);
    await userEvent.selectOptions(screen.getByTestId("flow-turn-on-client"), OTHER);
    await waitFor(() => expect(previewed).toBe(OTHER));
    expect(screen.getByRole("heading")).toHaveTextContent("Start the trial at Oak Supply");
    expect(screen.getByTestId("flow-turn-on")).toHaveTextContent("copies it to Oak Supply");
    const start = screen.getByTestId("flow-turn-on-start");
    await waitFor(() => expect(start).toBeEnabled());
    await userEvent.click(start);
    await waitFor(() => expect(sent).toEqual({ clientId: OTHER, versionId: VERSION }));
  });

  it("closes on Not yet", async () => {
    const { onClose } = setup({ [`GET ${path}`]: () => answer() });
    await userEvent.click(await screen.findByTestId("flow-turn-on-not-yet"));
    expect(onClose).toHaveBeenCalled();
  });
});
