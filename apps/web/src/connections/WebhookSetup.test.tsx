// The client admin's Webhooks panel: hooks with their URLs (copy, remove), making a hook, and the
// outbound URL with its signing secret. Each action sends the right request and shows the answer.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiProvider } from "../api/useApi";
import { fakeApi, Reply } from "../test/fixtures";
import { WebhookSetup } from "./WebhookSetup";

const CONN = "00000000-0000-4000-8000-00000000c101";
const HOOK = "00000000-0000-4000-8000-00000000e101";
const BASE = `/api/connections/${CONN}/webhook`;
const URL_A = `https://app.mezonas.com/api/hooks/00000000-0000-4000-8000-00000000a002/${HOOK}?token=${"t".repeat(43)}`;

const HOOK_A = {
  id: HOOK,
  name: "Website form entries",
  url: URL_A,
  createdAt: "2026-11-04T15:00:00.000Z",
};
const OUTBOUND = {
  url: "https://hooks.zapier.com/hooks/catch/123/abc/",
  host: "hooks.zapier.com",
  signingSecret: "s".repeat(43),
  setAt: "2026-11-04T15:05:00.000Z",
};

type Setup = { hooks: (typeof HOOK_A)[]; outbound: typeof OUTBOUND | null };

function renderPanel(initial: Setup, extra: Parameters<typeof fakeApi>[0] = {}) {
  let setup = initial;
  const bodies: { route: string; body: unknown }[] = [];
  const api = fakeApi({
    [`GET ${BASE}`]: () => setup,
    [`POST ${BASE}/hooks`]: ({ init }) => {
      const body = JSON.parse(String(init.body)) as { name: string };
      bodies.push({ route: "add", body });
      setup = {
        ...setup,
        hooks: [
          ...setup.hooks,
          { ...HOOK_A, id: "00000000-0000-4000-8000-00000000e102", name: body.name },
        ],
      };
      return setup;
    },
    [`DELETE ${BASE}/hooks/${HOOK}`]: () => {
      bodies.push({ route: "remove", body: null });
      setup = { ...setup, hooks: setup.hooks.filter((h) => h.id !== HOOK) };
      return setup;
    },
    [`PUT ${BASE}/outbound`]: ({ init }) => {
      const body = JSON.parse(String(init.body)) as { url: string | null };
      bodies.push({ route: "outbound", body });
      setup = { ...setup, outbound: body.url ? { ...OUTBOUND, url: body.url } : null };
      return setup;
    },
    ...extra,
  });
  render(
    <ApiProvider client={api.client}>
      <WebhookSetup connectionId={CONN} />
    </ApiProvider>,
  );
  return { api, bodies, user: userEvent.setup() };
}

afterEach(() => vi.restoreAllMocks());

describe("WebhookSetup", () => {
  it("shows each hook's URL with its secret, and says when there are none", async () => {
    renderPanel({ hooks: [HOOK_A], outbound: null });
    const hooks = await screen.findByTestId("webhook-hooks");
    expect(within(hooks).getByText("Website form entries")).toBeInTheDocument();
    expect(within(hooks).getByTestId("webhook-hook-url")).toHaveValue(URL_A);
    expect(screen.getByText(/No outbound URL yet/)).toBeInTheDocument();
    expect(screen.queryByTestId("webhook-signing-secret")).toBeNull();
  });

  it("says there are no hooks yet", async () => {
    renderPanel({ hooks: [], outbound: null });
    expect(await screen.findByText("No hooks yet.")).toBeInTheDocument();
    expect(screen.queryByTestId("webhook-hooks")).toBeNull();
  });

  it("copies a hook's URL", async () => {
    const { user } = renderPanel({ hooks: [HOOK_A], outbound: null });
    // user-event installs its own clipboard; spy on it after setup.
    const write = vi.spyOn(navigator.clipboard, "writeText");
    await user.click(await screen.findByTestId("webhook-hook-copy"));
    expect(write).toHaveBeenCalledWith(URL_A);
    expect(await screen.findByText("Copied")).toBeInTheDocument();
  });

  it("makes a hook with a trimmed name, and only with a name", async () => {
    const { bodies, user } = renderPanel({ hooks: [], outbound: null });
    const add = await screen.findByTestId("webhook-hook-add");
    expect(add).toBeDisabled();
    await user.type(screen.getByTestId("webhook-hook-name"), "   ");
    expect(add).toBeDisabled();
    await user.clear(screen.getByTestId("webhook-hook-name"));
    await user.type(screen.getByTestId("webhook-hook-name"), "  Paid orders  ");
    await user.click(add);
    expect(bodies).toEqual([{ route: "add", body: { name: "Paid orders" } }]);
    const hooks = await screen.findByTestId("webhook-hooks");
    expect(within(hooks).getByText("Paid orders")).toBeInTheDocument();
    expect(screen.getByTestId("webhook-hook-name")).toHaveValue("");
  });

  it("removes a hook", async () => {
    const { bodies, user } = renderPanel({ hooks: [HOOK_A], outbound: null });
    await user.click(await screen.findByTestId("webhook-hook-remove"));
    expect(bodies).toEqual([{ route: "remove", body: null }]);
    expect(await screen.findByText("No hooks yet.")).toBeInTheDocument();
  });

  it("saves the outbound URL and then shows where events go and the signing secret", async () => {
    const { bodies, user } = renderPanel({ hooks: [], outbound: null });
    const input = await screen.findByTestId("webhook-outbound-url");
    await user.type(input, "  https://hook.eu1.make.com/xyz  ");
    await user.click(screen.getByTestId("webhook-outbound-save"));
    expect(bodies).toEqual([{ route: "outbound", body: { url: "https://hook.eu1.make.com/xyz" } }]);
    expect(await screen.findByTestId("webhook-signing-secret")).toHaveValue(OUTBOUND.signingSecret);
    expect(screen.getByText(/Sending to hooks\.zapier\.com/)).toBeInTheDocument();
    expect(screen.getByTestId("webhook-outbound-url")).toHaveValue("https://hook.eu1.make.com/xyz");
  });

  it("clears the outbound URL when saved empty", async () => {
    const { bodies, user } = renderPanel({ hooks: [], outbound: OUTBOUND });
    const input = await screen.findByTestId("webhook-outbound-url");
    expect(input).toHaveValue(OUTBOUND.url);
    await user.clear(input);
    await user.click(screen.getByTestId("webhook-outbound-save"));
    expect(bodies).toEqual([{ route: "outbound", body: { url: null } }]);
    expect(await screen.findByText(/No outbound URL yet/)).toBeInTheDocument();
  });

  it("shows the API's refusal of a URL and keeps what was typed", async () => {
    const { user } = renderPanel(
      { hooks: [], outbound: null },
      {
        [`PUT ${BASE}/outbound`]: () =>
          new Reply(422, {
            error: { code: "invalid_url", message: "the URL must point at a public host" },
          }),
      },
    );
    const input = await screen.findByTestId("webhook-outbound-url");
    await user.type(input, "https://10.0.0.5/hook");
    await user.click(screen.getByTestId("webhook-outbound-save"));
    expect(await screen.findByText(/must point at a public host/)).toBeInTheDocument();
    expect(input).toHaveValue("https://10.0.0.5/hook");
    expect(screen.queryByTestId("webhook-signing-secret")).toBeNull();
  });

  it("shows a load failure with a retry", async () => {
    let fail = true;
    const { user } = renderPanel(
      { hooks: [HOOK_A], outbound: null },
      {
        [`GET ${BASE}`]: () =>
          fail
            ? new Reply(409, {
                error: { code: "not_connected", message: "connect webhooks first" },
              })
            : { hooks: [HOOK_A], outbound: null },
      },
    );
    expect(await screen.findByText(/connect webhooks first/)).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: /try again|retry/i }));
    await waitFor(() => expect(screen.getByTestId("webhook-hooks")).toBeInTheDocument());
  });
});
