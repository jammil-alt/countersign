// v0.14 W4-E: the client admin's Google Chat card: the connected spaces (disconnect one), and a
// one-time code to mention the app with, shown once when it is made.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiProvider } from "../api/useApi";
import { fakeApi } from "../test/fixtures";
import { GchatSetup } from "./GchatSetup";

const CONN = "00000000-0000-4000-8000-00000000c201";
const BASE = `/api/connections/${CONN}/gchat`;
const SHOP = {
  name: "spaces/AAAAshop",
  displayName: "Shop floor",
  kind: "space" as const,
  boundAt: "2026-11-06T15:00:00.000Z",
  boundBy: "Ana Ruiz",
};

type Setup = {
  spaces: (typeof SHOP)[];
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
      setup = { ...setup, pendingCodeExpiresAt: "2026-11-06T15:15:00.000Z" };
      return { ...setup, newCode: "MZ-7K2Q-9XHD-4RTM" };
    },
    [`DELETE ${BASE}/spaces/AAAAshop`]: () => {
      calls.push("unbind");
      setup = { ...setup, spaces: [] };
      return setup;
    },
  });
  render(
    <ApiProvider client={api.client}>
      <GchatSetup connectionId={CONN} />
    </ApiProvider>,
  );
  return { calls, user: userEvent.setup() };
}

afterEach(() => vi.restoreAllMocks());

describe("GchatSetup", () => {
  it("lists the connected spaces and disconnects one", async () => {
    const { calls, user } = renderCard({
      spaces: [SHOP],
      pendingCodeExpiresAt: null,
      newCode: null,
    });
    const list = await screen.findByTestId("gchat-spaces");
    expect(within(list).getByText("Shop floor")).toBeInTheDocument();
    expect(within(list).getByText(/by Ana Ruiz/)).toBeInTheDocument();
    await user.click(screen.getByTestId("gchat-space-disconnect"));
    expect(calls).toEqual(["unbind"]);
    expect(await screen.findByText("No spaces connected yet.")).toBeInTheDocument();
  });

  it("shows a new code once, as the message to send", async () => {
    const { calls, user } = renderCard({ spaces: [], pendingCodeExpiresAt: null, newCode: null });
    await user.click(await screen.findByTestId("gchat-get-code"));
    expect(calls).toEqual(["code"]);
    expect(await screen.findByTestId("gchat-code")).toHaveTextContent("@Mezonas MZ-7K2Q-9XHD-4RTM");
    expect(screen.getByTestId("gchat-get-code")).toHaveTextContent("Get a new code");
  });
});
