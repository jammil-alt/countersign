// v0.14 W4-A (docs/plan.md §1.57): connecting the client's own WhatsApp number with Meta's Embedded
// Signup. The Connections card opens the signup page with a full load (Meta's SDK is allowed only
// there); the page opens Meta's window with the configuration's id, takes the chosen account and
// number only from facebook.com's own message (exact origins), and posts the code with the state
// to the usual callback route. Meta's script and frames are let in on that page only.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import headers from "../../../public/_headers?raw";
import { AppProviders, AppRoutes } from "../../App";
import { CLIENT_SESSION, fakeApi, Reply } from "../../test/fixtures";
import { META_SDK_SCRIPT, sessionInfoOf, WHATSAPP_META_SIGNUP_PATH } from "./WhatsappMetaSignup";

const TENANT = CLIENT_SESSION.activeTenantId as string;
const CARD = {
  connector: "whatsapp_meta",
  name: "WhatsApp (your own number)",
  description: "Connect your own WhatsApp Business number through Meta.",
  icon: "message",
  available: true,
  credentialForm: false,
  personal: false,
  connection: null,
};
const LINK = {
  provider: "meta",
  token: "4400550066",
  appId: "1100220033",
  graphVersion: "v26.0",
  expiresAt: null,
  state: "signed-state",
};

function renderAt(path: string, locale: "en" | "es" = "en") {
  const bodies: unknown[] = [];
  const api = fakeApi({
    "GET /api/session": () => ({
      ...CLIENT_SESSION,
      tenants: [{ id: TENANT, name: "Demo client", role: "client_admin" }],
      language: { effective: locale, user: locale, client: null },
    }),
    "GET /api/overview": () => new Reply(404, {}),
    "GET /api/feedback/status": () => ({ enabled: false }),
    "GET /api/connections": () => ({ connections: [CARD] }),
    "GET /api/connections/upload/forwarding": () => new Reply(404, {}),
    "GET /api/documents": () => ({ items: [] }),
    "GET /api/approver-rules": () => new Reply(404, {}),
    "POST /api/connections/whatsapp_meta/authorize": () => ({
      connection: CARD,
      redirectUrl: null,
      link: LINK,
    }),
    "POST /api/connections/whatsapp_meta/callback": ({ init }) => {
      bodies.push(JSON.parse(String(init.body)));
      return { connection: CARD };
    },
  });
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
  return { api, bodies };
}

afterEach(() => {
  vi.restoreAllMocks();
  (window as { FB?: unknown }).FB = undefined;
});

describe("the WhatsApp (your own number) card", () => {
  it("opens the signup page with a full load, and asks nothing of the API itself", async () => {
    const assign = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, assign });
    const { api } = renderAt("/connections", "es");
    const card = await screen.findByTestId("portal-connection-whatsapp_meta");
    expect(within(card).getByText(/Conecte su propio número de WhatsApp Business/)).toBeTruthy();
    await userEvent.click(within(card).getByTestId("portal-connection-connect"));
    expect(assign).toHaveBeenCalledWith(WHATSAPP_META_SIGNUP_PATH);
    expect(api.calls).not.toContain("POST /api/connections/whatsapp_meta/authorize");
  });
});

describe("the signup page", () => {
  it("opens Meta's window with our configuration, and sends the code with the chosen number", async () => {
    const assign = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, assign });
    const login = vi.fn();
    (window as { FB?: unknown }).FB = { init: vi.fn(), login };
    const { bodies } = renderAt(WHATSAPP_META_SIGNUP_PATH);
    await userEvent.click(await screen.findByTestId("whatsapp-meta-open"));
    expect(login).toHaveBeenCalledTimes(1);
    expect(login.mock.calls[0]?.[1]).toEqual({
      config_id: "4400550066",
      response_type: "code",
      override_default_response_type: true,
      extras: { setup: {}, sessionInfoVersion: "3" },
    });
    // A look-alike origin's message is ignored; Meta's own is taken.
    const send = (origin: string, data: unknown) =>
      window.dispatchEvent(new MessageEvent("message", { origin, data: JSON.stringify(data) }));
    const info = (id: string) => ({
      type: "WA_EMBEDDED_SIGNUP",
      event: "FINISH",
      data: { waba_id: "102030405060", phone_number_id: id },
    });
    send("https://www.facebook.com.evil.example", info("666"));
    send("https://www.facebook.com", info("509876543210"));
    const callback = login.mock.calls[0]?.[0] as (r: unknown) => void;
    callback({ authResponse: { code: "fake-code-1" } });
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/connections"));
    expect(bodies).toEqual([
      {
        params: {
          code: "fake-code-1",
          state: "signed-state",
          waba_id: "102030405060",
          phone_number_id: "509876543210",
        },
      },
    ]);
  });

  it("says nothing was connected when the person closes Meta's window", async () => {
    const login = vi.fn();
    (window as { FB?: unknown }).FB = { init: vi.fn(), login };
    const { bodies } = renderAt(WHATSAPP_META_SIGNUP_PATH);
    await userEvent.click(await screen.findByTestId("whatsapp-meta-open"));
    (login.mock.calls[0] as [(r: unknown) => void])[0]({ authResponse: null });
    expect(await screen.findByText(/Nothing was connected/)).toBeTruthy();
    expect(bodies).toEqual([]);
  });
});

describe("Meta's session-info message", () => {
  const finish = JSON.stringify({
    type: "WA_EMBEDDED_SIGNUP",
    event: "FINISH",
    data: { waba_id: "1", phone_number_id: "2" },
  });
  it("is read only from facebook.com's exact origins, with ids of digits", () => {
    expect(sessionInfoOf("https://www.facebook.com", finish)).toEqual({
      kind: "finish",
      wabaId: "1",
      phoneNumberId: "2",
    });
    expect(sessionInfoOf("https://web.facebook.com", finish)?.kind).toBe("finish");
    expect(sessionInfoOf("https://facebook.com.evil.example", finish)).toBeNull();
    expect(sessionInfoOf("http://www.facebook.com", finish)).toBeNull();
    expect(sessionInfoOf("https://www.facebook.com", "not json")).toBeNull();
    expect(
      sessionInfoOf(
        "https://www.facebook.com",
        JSON.stringify({
          type: "WA_EMBEDDED_SIGNUP",
          event: "FINISH",
          data: { waba_id: "1", phone_number_id: "../2" },
        }),
      ),
    ).toBeNull();
    expect(
      sessionInfoOf(
        "https://www.facebook.com",
        JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: "CANCEL" }),
      ),
    ).toEqual({ kind: "cancel" });
  });
});

describe("the signup page's Content-Security-Policy", () => {
  const block = (path: string) =>
    headers
      .split("\n\n")
      .map((b) => b.split("\n").filter((l) => !l.startsWith("#")))
      .find((lines) => lines[0] === path) ?? [];
  const csp = (lines: string[]) =>
    lines.find((l) => l.trim().startsWith("Content-Security-Policy:"))?.trim() ?? "";

  it("lets Meta's SDK in on that page only, by its full path", () => {
    expect(csp(block("/*"))).not.toContain("facebook");
    expect(csp(block("/connections/gsheets/pick"))).not.toContain("facebook");
    const page = block(WHATSAPP_META_SIGNUP_PATH);
    expect(page.map((l) => l.trim())).toEqual(
      expect.arrayContaining([
        "! Content-Security-Policy",
        "! Cross-Origin-Opener-Policy",
        "Cross-Origin-Opener-Policy: same-origin-allow-popups",
      ]),
    );
    const policy = csp(page);
    expect(policy).toContain(`script-src 'self' ${META_SDK_SCRIPT};`);
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toContain("unsafe-eval");
    expect(policy).not.toContain("script-src 'self' https://connect.facebook.net;");
  });
});
