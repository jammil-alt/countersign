// §1.97: the client admin's Microsoft Teams card: the connected channels (disconnect one), and a
// one-time code to mention the bot with, shown once when it is made.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiProvider } from "../api/useApi";
import { fakeApi } from "../test/fixtures";
import { TeamsSetup } from "./TeamsSetup";

const CONN = "00000000-0000-4000-8000-00000000c301";
const BASE = `/api/connections/${CONN}/teams`;
const ORDERS = {
  channelId: "19:fakeChannelOrders00000000000000@thread.tacv2",
  teamName: "Acme Millwork",
  channelName: "Orders",
  label: "Acme Millwork › Orders",
  boundAt: "2026-11-12T15:00:00.000Z",
  boundBy: "Ana Ruiz",
};

type Setup = {
  channels: (typeof ORDERS)[];
  pendingCodeExpiresAt: string | null;
  newCode: string | null;
};

function renderCard(initial: Setup) {
  let setup = initial;
  const calls: string[] = [];
  const api = fakeApi({
    [`GET ${BASE}`]: () => ({ ...setup, newCode: null }),
    [`POST ${BASE}/code`]: () => {
      calls.push("code");
      setup = { ...setup, pendingCodeExpiresAt: "2026-11-12T15:15:00.000Z" };
      return { ...setup, newCode: "MZ-7K2Q-9XHD-4RTM" };
    },
    [`DELETE ${BASE}/channels/${encodeURIComponent(ORDERS.channelId)}`]: () => {
      calls.push("unbind");
      setup = { ...setup, channels: [] };
      return setup;
    },
  });
  render(
    <ApiProvider client={api.client}>
      <TeamsSetup connectionId={CONN} />
    </ApiProvider>,
  );
  return { calls, user: userEvent.setup() };
}

afterEach(() => vi.restoreAllMocks());

describe("TeamsSetup", () => {
  it("lists the connected channels and disconnects one", async () => {
    const { calls, user } = renderCard({
      channels: [ORDERS],
      pendingCodeExpiresAt: null,
      newCode: null,
    });
    const list = await screen.findByTestId("teams-channels");
    expect(within(list).getByText("Acme Millwork › Orders")).toBeInTheDocument();
    expect(within(list).getByText(/by Ana Ruiz/)).toBeInTheDocument();
    await user.click(screen.getByTestId("teams-channel-disconnect"));
    expect(calls).toEqual(["unbind"]);
    expect(await screen.findByText("No channels connected yet.")).toBeInTheDocument();
  });

  it("shows a new code once, as the message to send", async () => {
    const { calls, user } = renderCard({ channels: [], pendingCodeExpiresAt: null, newCode: null });
    await user.click(await screen.findByTestId("teams-get-code"));
    expect(calls).toEqual(["code"]);
    expect(await screen.findByTestId("teams-code")).toHaveTextContent("@Mezonas MZ-7K2Q-9XHD-4RTM");
    expect(screen.getByTestId("teams-get-code")).toHaveTextContent("Get a new code");
  });
});
