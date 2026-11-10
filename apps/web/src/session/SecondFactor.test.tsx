// The second step of signing in (docs/plan.md §1.83), against a fake API shaped like apps/api:
// a pending session answers 401 `second_factor_required` everywhere but the step's own routes, so
// the app shows the step in place of the portal or the back office; setting up an authenticator
// app (QR code and key) or a phone (send, resend, verify); recovery codes shown once; later sign-ins
// with a code or a recovery code; operators kept to the authenticator app; refusals in plain words.
import type { SecondFactorState } from "@countersign/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../App";
import { CLIENT_SESSION, fakeApi, OPERATOR_SESSION, Reply } from "../test/fixtures";

const CODES = [..."abcdefghij"].map((c) => `${c.repeat(4)}-wxyz`);

function factorState(over: Partial<SecondFactorState> = {}): SecondFactorState {
  return {
    status: "pending",
    operator: false,
    allowed: ["totp", "sms", "whatsapp"],
    available: { totp: true, sms: true, whatsapp: true },
    methods: [],
    recoveryCodesLeft: 0,
    secondsLeft: 540,
    ...over,
  };
}

/** A pending sign-in that passes once a verify is accepted. */
function pending(state: SecondFactorState, operator = false) {
  let done = false;
  const bodies: Record<string, unknown[]> = {};
  const log = (key: string, init: RequestInit) => {
    bodies[key] ??= [];
    bodies[key].push(init.body === undefined ? undefined : JSON.parse(String(init.body)));
  };
  const api = fakeApi({
    "GET /api/session": () =>
      done
        ? operator
          ? OPERATOR_SESSION
          : CLIENT_SESSION
        : new Reply(401, {
            error: { code: "second_factor_required", message: "Finish signing in" },
          }),
    "GET /api/auth/second-factor": () => state,
    "GET /api/overview": () => ({
      client: { id: CLIENT_SESSION.activeTenantId, name: "Demo client" },
      services: [],
      needsYou: { inbox: 0 },
      recentRuns: [],
    }),
  });
  const on = (route: string, handler: (body: unknown) => unknown) =>
    api.on(route, ({ init }) => {
      log(route, init);
      return handler(init.body === undefined ? undefined : JSON.parse(String(init.body)));
    });
  return { api, bodies, on, pass: () => (done = true) };
}

function renderAt(path: string, api: ReturnType<typeof fakeApi>) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
}

describe("the session's second step", () => {
  it("shows the step instead of the app when the API says second_factor_required", async () => {
    const { api } = pending(factorState());
    renderAt("/settings", api);
    expect(await screen.findByTestId("second-factor-setup")).toBeInTheDocument();
    expect(screen.queryByTestId("shell-portal")).toBeNull();
    // Not sent to the sign-in page: the person is signed in, one step short.
    expect(screen.queryByTestId("signin-workos")).toBeNull();
    expect(screen.getByTestId("second-factor-sign-out")).toHaveTextContent("Sign out");
  });
});

describe("setting up the second step", () => {
  it("sets up an authenticator app: QR code, the key to type, a code, then the recovery codes once", async () => {
    const fake = pending(factorState());
    fake.on("POST /api/auth/second-factor/totp", () => ({
      uri: "otpauth://totp/Mezonas:admin%40demo.example?secret=JBSWY3DPEHPK3PXP&issuer=Mezonas",
      secret: "JBSWY3DPEHPK3PXP",
    }));
    fake.on("POST /api/auth/second-factor/verify", () => {
      fake.pass();
      return { ok: true, recoveryCodes: CODES };
    });
    renderAt("/", fake.api);
    const user = userEvent.setup();

    const setup = await screen.findByTestId("second-factor-setup");
    expect(within(setup).getByTestId("second-factor-pick-sms")).toHaveTextContent("Text message");
    expect(within(setup).getByTestId("second-factor-pick-whatsapp")).toBeInTheDocument();
    expect(screen.queryByTestId("second-factor-operator")).toBeNull();
    await user.click(within(setup).getByTestId("second-factor-pick-totp"));

    const qr = await screen.findByTestId("second-factor-qr");
    expect(qr.getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
    expect(qr).toHaveAccessibleName("QR code to scan with your authenticator app");
    expect(screen.getByTestId("second-factor-secret")).toHaveTextContent("JBSW Y3DP EHPK 3PXP");

    // A code that isn't 6 digits is caught before it is sent.
    const code = screen.getByLabelText("6-digit code");
    expect(code).toHaveAttribute("id", "second-factor-code");
    expect(code).toHaveAttribute("inputmode", "numeric");
    expect(code).toHaveAttribute("autocomplete", "one-time-code");
    await user.type(code, "1234");
    await user.click(screen.getByTestId("second-factor-verify"));
    expect(await screen.findByTestId("second-factor-code-error")).toHaveTextContent("numbers only");
    expect(fake.bodies["POST /api/auth/second-factor/verify"]).toBeUndefined();

    await user.clear(code);
    await user.type(code, "123 456");
    await user.click(screen.getByTestId("second-factor-verify"));
    expect(fake.bodies["POST /api/auth/second-factor/verify"]).toEqual([
      { method: "totp", code: "123456" },
    ]);

    // The recovery codes, once: Continue waits for "I've saved these codes".
    const codes = await screen.findByTestId("second-factor-codes");
    expect(within(codes).getByText("Save your recovery codes")).toBeInTheDocument();
    expect(within(codes).getAllByRole("listitem")).toHaveLength(10);
    expect(within(codes).getByTestId("second-factor-codes-download")).toHaveTextContent(
      "Download as text",
    );
    const next = within(codes).getByTestId("second-factor-codes-continue");
    expect(next).toBeDisabled();
    await user.click(within(codes).getByLabelText("I've saved these codes"));
    expect(next).toBeEnabled();
    await user.click(next);

    expect(await screen.findByTestId("shell-portal")).toBeInTheDocument();
    expect(screen.queryByTestId("second-factor-codes")).toBeNull();
  });

  it("sets up texts: the number in the person's country, send, a new code, verify", async () => {
    const fake = pending(factorState());
    fake.on("POST /api/auth/second-factor/phone", () => ({ sent: true, phoneHint: "•••• 4242" }));
    fake.on("POST /api/auth/second-factor/send", () => ({ sent: true, phoneHint: "•••• 4242" }));
    fake.on("POST /api/auth/second-factor/verify", () => {
      fake.pass();
      return { ok: true, recoveryCodes: CODES };
    });
    renderAt("/", fake.api);
    const user = userEvent.setup();

    await user.click(await screen.findByTestId("second-factor-pick-sms"));
    const country = screen.getByLabelText("Country");
    expect(country).toHaveAttribute("id", "second-factor-country");
    // jsdom's browser language is en-US.
    expect(country).toHaveValue("US");
    const phone = screen.getByLabelText(/^Mobile number/);
    expect(phone).toHaveAttribute("id", "second-factor-phone");

    await user.type(phone, "555 12");
    await user.click(screen.getByTestId("second-factor-phone-send"));
    expect(await screen.findByTestId("second-factor-phone-error")).toHaveTextContent(
      "That isn't a valid phone number.",
    );
    expect(fake.bodies["POST /api/auth/second-factor/phone"]).toBeUndefined();

    await user.selectOptions(country, "GB");
    await user.clear(phone);
    await user.type(phone, "07700 900123");
    await user.click(screen.getByTestId("second-factor-phone-send"));
    expect(await screen.findByTestId("second-factor-sent")).toHaveTextContent(
      "We sent a code to •••• 4242.",
    );
    expect(fake.bodies["POST /api/auth/second-factor/phone"]).toEqual([
      { method: "sms", phone: "+447700900123" },
    ]);

    await user.click(screen.getByTestId("second-factor-resend"));
    await waitFor(() =>
      expect(fake.bodies["POST /api/auth/second-factor/send"]).toEqual([{ method: "sms" }]),
    );

    await user.type(screen.getByLabelText("6-digit code"), "654321");
    await user.click(screen.getByTestId("second-factor-verify"));
    expect(fake.bodies["POST /api/auth/second-factor/verify"]).toEqual([
      { method: "sms", code: "654321" },
    ]);
    expect(await screen.findByTestId("second-factor-codes")).toBeInTheDocument();
  });

  it("offers operators the authenticator app only, and says why", async () => {
    const fake = pending(
      factorState({
        operator: true,
        allowed: ["totp"],
        // An operator's phone method from before doesn't count.
        methods: [{ method: "sms", verified: true, phoneHint: "•••• 1111" }],
      }),
      true,
    );
    renderAt("/ops", fake.api);
    const setup = await screen.findByTestId("second-factor-setup");
    expect(within(setup).getByTestId("second-factor-operator")).toHaveTextContent(
      "You can reach every client, so you sign in with an authenticator app.",
    );
    expect(within(setup).getByTestId("second-factor-pick-totp")).toBeInTheDocument();
    expect(within(setup).queryByTestId("second-factor-pick-sms")).toBeNull();
    expect(within(setup).queryByTestId("second-factor-pick-whatsapp")).toBeNull();
  });

  it("leaves out texts and WhatsApp when the site can't send them", async () => {
    const fake = pending(factorState({ available: { totp: true, sms: false, whatsapp: false } }));
    renderAt("/", fake.api);
    const setup = await screen.findByTestId("second-factor-setup");
    expect(within(setup).getByTestId("second-factor-pick-totp")).toBeInTheDocument();
    expect(within(setup).queryByTestId("second-factor-pick-sms")).toBeNull();
  });
});

describe("signing in with a method set up", () => {
  it("asks for the authenticator's code, and says when it's wrong or there were too many tries", async () => {
    const fake = pending(
      factorState({
        methods: [{ method: "totp", verified: true, phoneHint: null }],
        recoveryCodesLeft: 9,
      }),
    );
    let reply: Reply = new Reply(422, { error: { code: "wrong_code", message: "Wrong code" } });
    fake.on("POST /api/auth/second-factor/verify", () => reply);
    renderAt("/", fake.api);
    const user = userEvent.setup();

    const step = await screen.findByTestId("second-factor-sign-in");
    expect(within(step).getByText("Enter your sign-in code")).toBeInTheDocument();
    const code = screen.getByLabelText("6-digit code");
    await user.type(code, "111111");
    await user.click(screen.getByTestId("second-factor-verify"));
    const problem = await screen.findByTestId("second-factor-problem");
    expect(problem).toHaveTextContent("That code isn't right. Check it and try again.");
    expect(problem).toHaveAttribute("data-error-code", "wrong_code");

    reply = new Reply(429, { error: { code: "too_many_attempts", message: "Slow down" } });
    await user.click(screen.getByTestId("second-factor-verify"));
    await waitFor(() =>
      expect(screen.getByTestId("second-factor-problem")).toHaveTextContent(
        "Too many tries. Wait 15 minutes, then try again.",
      ),
    );
    // Nothing to switch to but a recovery code.
    expect(screen.queryByTestId("second-factor-use-sms")).toBeNull();
    expect(screen.getByTestId("second-factor-use-recovery")).toBeInTheDocument();
  });

  it("sends a text first, and switches between the methods set up", async () => {
    const fake = pending(
      factorState({
        methods: [
          { method: "sms", verified: true, phoneHint: "•••• 4242" },
          { method: "totp", verified: true, phoneHint: null },
        ],
      }),
    );
    fake.on("POST /api/auth/second-factor/send", () => ({ sent: true, phoneHint: "•••• 4242" }));
    renderAt("/", fake.api);
    const user = userEvent.setup();

    // In the order the API lists them: texts first.
    expect(await screen.findByText("We'll text a code to •••• 4242.")).toBeInTheDocument();
    expect(screen.queryByLabelText("6-digit code")).toBeNull();
    await user.click(screen.getByTestId("second-factor-send"));
    expect(await screen.findByTestId("second-factor-sent")).toHaveTextContent("•••• 4242");
    expect(fake.bodies["POST /api/auth/second-factor/send"]).toEqual([{ method: "sms" }]);
    expect(screen.getByLabelText("6-digit code")).toBeInTheDocument();

    await user.click(screen.getByTestId("second-factor-use-totp"));
    expect(
      await screen.findByText(
        "Open your authenticator app and enter the 6-digit code for Mezonas.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId("second-factor-use-sms")).toHaveTextContent(
      "Get a text message instead",
    );
  });

  it("finishes with a recovery code", async () => {
    const fake = pending(
      factorState({
        methods: [{ method: "whatsapp", verified: true, phoneHint: "•••• 7777" }],
        recoveryCodesLeft: 3,
      }),
    );
    fake.on("POST /api/auth/second-factor/verify", () => {
      fake.pass();
      return { ok: true, recoveryCodes: null };
    });
    renderAt("/", fake.api);
    const user = userEvent.setup();

    await user.click(await screen.findByTestId("second-factor-use-recovery"));
    expect(screen.getByTestId("second-factor-recovery-left")).toHaveTextContent(
      "You have 3 recovery codes left.",
    );
    const input = screen.getByLabelText("Recovery code");
    expect(input).toHaveAttribute("id", "second-factor-recovery");
    await user.type(input, "abcd");
    await user.click(screen.getByTestId("second-factor-recovery-submit"));
    expect(await screen.findByTestId("second-factor-recovery-error")).toHaveTextContent(
      "A recovery code has 8 letters and numbers, like abcd-efgh.",
    );

    await user.clear(input);
    await user.type(input, "ABCD-EFGH");
    await user.click(screen.getByTestId("second-factor-recovery-submit"));
    expect(await screen.findByTestId("shell-portal")).toBeInTheDocument();
    expect(fake.bodies["POST /api/auth/second-factor/verify"]).toEqual([
      { method: "recovery", code: "abcdefgh" },
    ]);
    // No new codes to show after a sign-in.
    expect(screen.queryByTestId("second-factor-codes")).toBeNull();
  });

  it("says when the 10 minutes ran out, and goes back to sign-in", async () => {
    const fake = pending(
      factorState({ methods: [{ method: "totp", verified: true, phoneHint: null }] }),
    );
    fake.on(
      "POST /api/auth/second-factor/verify",
      () => new Reply(401, { error: { code: "second_factor_expired", message: "Too late" } }),
    );
    fake.api.on("GET /api/auth/provider", () => ({ provider: "workos", message: null }));
    renderAt("/inbox", fake.api);
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText("6-digit code"), "123456");
    await user.click(screen.getByTestId("second-factor-verify"));
    const ended = await screen.findByTestId("second-factor-ended");
    expect(ended).toHaveTextContent("You have 10 minutes to finish this step.");
    await user.click(within(ended).getByTestId("second-factor-sign-in-again"));
    const link = await screen.findByTestId("signin-workos");
    expect(link.getAttribute("href")).toBe("/api/auth/sign-in?return_to=%2Finbox");
  });
});

describe("the step in another language", () => {
  it("reads in the browser's language before a session", async () => {
    const languages = Object.getOwnPropertyDescriptor(Navigator.prototype, "languages");
    Object.defineProperty(navigator, "languages", { value: ["de-DE"], configurable: true });
    try {
      const fake = pending(factorState({ allowed: ["totp"], operator: true }));
      renderAt("/ops", fake.api);
      expect(await screen.findByTestId("second-factor-operator")).toHaveTextContent(
        "Sie haben Zugriff auf alle Kunden",
      );
      expect(screen.getByTestId("second-factor-pick-totp")).toHaveTextContent("Authenticator-App");
    } finally {
      delete (navigator as { languages?: unknown }).languages;
      if (languages) Object.defineProperty(Navigator.prototype, "languages", languages);
    }
  });
});
