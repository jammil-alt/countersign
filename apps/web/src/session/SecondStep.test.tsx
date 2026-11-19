// The sign-in's second step (docs/plan.md §1.100): an operator sets up an authenticator app and
// saves recovery codes; a client signs in with a texted code, gets a wrong code first, then
// passes; a recovery code instead; the app sends a pending session to the step, and the page goes
// back where the person was going; numbers and return addresses are checked; approving on the
// phone app (§1.154) comes first when a phone can, with a code a click away.
import type { SecondFactorStatus } from "@countersign/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AppProviders, AppRoutes } from "../App";
import { CLIENT_SESSION, fakeApi, OPERATOR_SESSION, Reply } from "../test/fixtures";
import { cleanCode, fullPageLoad, otpSecret, toE164 } from "./SecondStep";
import { safeReturnTo } from "./session";

const pending = (over: Partial<SecondFactorStatus> = {}): SecondFactorStatus => ({
  state: "pending",
  enabled: true,
  allowed: ["totp", "sms", "whatsapp"],
  methods: [],
  setupNeeded: true,
  recoveryCodesLeft: 0,
  phones: 0,
  ...over,
});

const REQUIRED = new Reply(401, {
  error: { code: "second_factor_required", message: "finish signing in with your second step" },
});

const CODES = Array.from({ length: 10 }, (_, i) => `ABCD-${2340 + i}`);

function Where() {
  const l = useLocation();
  return <div data-testid="where">{`${l.pathname}${l.search}`}</div>;
}

function renderAt(path: string, routes: Parameters<typeof fakeApi>[0]) {
  const api = fakeApi(routes);
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
        <Where />
      </AppProviders>
    </MemoryRouter>,
  );
  return api;
}

describe("the second step", () => {
  it("sends a pending session from any page to the step, keeping where it was going", async () => {
    renderAt("/ops/runs?status=waiting", {
      "GET /api/session": () => REQUIRED,
      "GET /api/auth/second-factor": () => pending(),
    });
    await waitFor(() =>
      expect(screen.getByTestId("where")).toHaveTextContent(
        `/sign-in/second-step?return_to=${encodeURIComponent("/ops/runs?status=waiting")}`,
      ),
    );
    expect(await screen.findByTestId("second-step")).toHaveAttribute("data-view", "choose");
  });

  it("sets up an operator's authenticator app, shows the recovery codes once, then goes on", async () => {
    let passed = false;
    const bodies: unknown[] = [];
    const api = renderAt("/sign-in/second-step?return_to=%2Fops%2Fclients", {
      "GET /api/session": () => (passed ? OPERATOR_SESSION : REQUIRED),
      "GET /api/auth/second-factor": () => pending({ allowed: ["totp"] }),
      "POST /api/auth/second-factor/setup": async ({ init }) => {
        bodies.push(JSON.parse(String(init?.body)));
        return {
          kind: "totp",
          otpauthUri:
            "otpauth://totp/Mezonas:ops%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Mezonas",
          phoneHint: null,
        };
      },
      "POST /api/auth/second-factor/verify": async ({ init }) => {
        bodies.push(JSON.parse(String(init?.body)));
        passed = true;
        return { ok: true, recoveryCodes: CODES, recoveryCodesLeft: 10 };
      },
    });
    const step = await screen.findByTestId("second-step");
    // Operators: an authenticator app only.
    expect(screen.queryByTestId("second-step-method-sms")).toBeNull();
    expect(screen.getByText("Mezonas staff use an authenticator app.")).toBeInTheDocument();
    await userEvent.click(within(step).getByTestId("second-step-continue"));

    expect(await screen.findByTestId("second-step-secret")).toHaveTextContent(
      "JBSW Y3DP EHPK 3PXP",
    );
    // The link as a QR code to scan, drawn here.
    const qr = screen.getByTestId("second-step-qr");
    expect(qr).toHaveAttribute("aria-label", "QR code to add Mezonas to your authenticator app");
    expect(qr.querySelector("path")?.getAttribute("d")).toMatch(/^M\d+ \d+h1v1h-1z/);
    expect(screen.getByTestId("second-step-open-app")).toHaveAttribute(
      "href",
      expect.stringMatching(/^otpauth:\/\/totp\//),
    );
    await userEvent.type(screen.getByTestId("second-step-code"), "123 456");
    await userEvent.click(screen.getByTestId("second-step-remember"));
    await userEvent.click(screen.getByTestId("second-step-verify"));

    const codes = await screen.findByTestId("second-step-codes");
    expect(within(codes).getAllByRole("listitem")).toHaveLength(10);
    expect(bodies).toEqual([{ kind: "totp" }, { kind: "totp", code: "123456", remember: true }]);
    // Not until the person says they saved them.
    expect(screen.getByTestId("where")).toHaveTextContent("/sign-in/second-step");
    await userEvent.click(screen.getByTestId("second-step-saved-continue"));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/ops\/clients$/));
    expect(api.calls).toContain("GET /api/session");
  });

  it("goes on to the phone app's handoff with a full page load (docs/plan.md §1.116)", async () => {
    const to = vi.spyOn(fullPageLoad, "to").mockImplementation(() => undefined);
    let passed = false;
    renderAt("/sign-in/second-step?return_to=%2Fapi%2Fmobile%2Fhandoff", {
      "GET /api/session": () => (passed ? CLIENT_SESSION : REQUIRED),
      "GET /api/auth/second-factor": () =>
        pending({
          setupNeeded: false,
          recoveryCodesLeft: 8,
          methods: [{ kind: "sms", phoneHint: "•••• 4567", verified: true }],
        }),
      "POST /api/auth/second-factor/send": () => ({ ok: true, phoneHint: "•••• 4567" }),
      "POST /api/auth/second-factor/verify": () => {
        passed = true;
        return { ok: true, recoveryCodes: null, recoveryCodesLeft: 8 };
      },
    });
    await userEvent.click(await screen.findByTestId("second-step-send"));
    await userEvent.type(await screen.findByTestId("second-step-code"), "123456");
    await userEvent.click(screen.getByTestId("second-step-verify"));
    await waitFor(() => expect(to).toHaveBeenCalledWith("/api/mobile/handoff"));
    // Not one of the app's own pages: the router stays where it was.
    expect(screen.getByTestId("where")).toHaveTextContent("/sign-in/second-step");
    to.mockRestore();
  });

  it("signs a client in with a texted code, after a wrong one", async () => {
    let passed = false;
    let tries = 0;
    renderAt("/sign-in/second-step?return_to=%2Fruns", {
      "GET /api/session": () => (passed ? CLIENT_SESSION : REQUIRED),
      "GET /api/auth/second-factor": () =>
        pending({
          setupNeeded: false,
          recoveryCodesLeft: 8,
          methods: [{ kind: "sms", phoneHint: "•••• 4567", verified: true }],
        }),
      "POST /api/auth/second-factor/send": () => ({ ok: true, phoneHint: "•••• 4567" }),
      "POST /api/auth/second-factor/verify": () => {
        tries++;
        if (tries === 1) {
          return new Reply(422, {
            error: { code: "wrong_code", message: "that code is not right, or has expired" },
          });
        }
        passed = true;
        return { ok: true, recoveryCodes: null, recoveryCodesLeft: 8 };
      },
    });
    expect(await screen.findByText(/•••• 4567/)).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("second-step-send"));
    await userEvent.type(await screen.findByTestId("second-step-code"), "111111");
    await userEvent.click(screen.getByTestId("second-step-verify"));
    expect(await screen.findByTestId("second-step-code-error")).toHaveTextContent(
      "that code is not right, or has expired",
    );
    await userEvent.clear(screen.getByTestId("second-step-code"));
    await userEvent.type(screen.getByTestId("second-step-code"), "222222");
    await userEvent.click(screen.getByTestId("second-step-verify"));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/runs$/));
  });

  it("takes a recovery code instead, and says how many are left", async () => {
    let passed = false;
    const bodies: unknown[] = [];
    renderAt("/sign-in/second-step", {
      "GET /api/session": () => (passed ? CLIENT_SESSION : REQUIRED),
      "GET /api/auth/second-factor": () =>
        pending({
          setupNeeded: false,
          recoveryCodesLeft: 3,
          methods: [{ kind: "totp", phoneHint: null, verified: true }],
        }),
      "POST /api/auth/second-factor/recovery": async ({ init }) => {
        bodies.push(JSON.parse(String(init?.body)));
        passed = true;
        return { ok: true, recoveryCodes: null, recoveryCodesLeft: 2 };
      },
    });
    await userEvent.click(await screen.findByTestId("second-step-use-recovery"));
    await userEvent.type(screen.getByTestId("second-step-recovery"), "abcd-2345");
    await userEvent.click(screen.getByTestId("second-step-recovery-use"));
    expect(await screen.findByTestId("second-step-recovery-left")).toHaveTextContent(
      "You have 2 recovery codes left.",
    );
    expect(bodies).toEqual([{ code: "abcd-2345", remember: false }]);
    await userEvent.click(screen.getByTestId("second-step-recovery-continue"));
    // No return address: the person's home.
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/$/));
  });

  it("goes straight on when the sign-in isn't waiting on a step", async () => {
    renderAt("/sign-in/second-step?return_to=%2Fops%2Finbox", {
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/auth/second-factor": () => ({ ...pending(), state: "done", setupNeeded: false }),
    });
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/ops\/inbox$/));
  });
});

describe("the step's helpers", () => {
  it("writes numbers in E.164 from a country and what was typed", () => {
    expect(toE164("1", "(555) 123-4567")).toBe("+15551234567");
    expect(toE164("44", "07700 900123")).toBe("+447700900123");
    expect(toE164("1", "+34 612 345 678")).toBe("+34612345678");
    expect(toE164("1", "12")).toBeNull();
  });

  it("cleans codes and reads the authenticator key", () => {
    expect(cleanCode("123 456")).toBe("123456");
    expect(cleanCode("123-456")).toBe("123456");
    expect(otpSecret("otpauth://totp/x?secret=ABCDEFGHIJ")).toBe("ABCD EFGH IJ");
    expect(otpSecret("not a link")).toBeNull();
  });

  it("returns only to our own pages", () => {
    expect(safeReturnTo("/ops/runs?x=1", "/ops")).toBe("/ops/runs?x=1");
    expect(safeReturnTo("//evil.example", "/ops")).toBe("/ops");
    expect(safeReturnTo("/\\evil.example", "/ops")).toBe("/ops");
    expect(safeReturnTo("https://evil.example", "/")).toBe("/");
    expect(safeReturnTo("/sign-in/second-step", "/")).toBe("/");
    expect(safeReturnTo(null, "/")).toBe("/");
  });

  describe("approving on the phone (§1.154)", () => {
    const withPhone = () =>
      pending({
        setupNeeded: false,
        recoveryCodesLeft: 8,
        methods: [{ kind: "sms", phoneHint: "•••• 4567", verified: true }],
        phones: 1,
      });
    const STARTED = {
      id: "0190a1b2-0000-7000-8000-0000000000aa",
      key: "k".repeat(43),
      number: 47,
      expiresAt: "2026-11-18T12:02:00.000Z",
      phones: 1,
    };

    it("shows the number, waits on the phone, then goes on", async () => {
      let passed = false;
      let checks = 0;
      const bodies: unknown[] = [];
      renderAt("/sign-in/second-step?return_to=%2Finbox", {
        "GET /api/session": () => (passed ? CLIENT_SESSION : REQUIRED),
        "GET /api/auth/second-factor": () => withPhone(),
        "POST /api/auth/second-factor/phone": () => STARTED,
        "POST /api/auth/second-factor/phone/check": async ({ init }) => {
          bodies.push(JSON.parse(String(init?.body)));
          checks += 1;
          if (checks < 2) return { status: "pending", passed: null };
          passed = true;
          return {
            status: "approved",
            passed: { ok: true, recoveryCodes: null, recoveryCodesLeft: 8 },
          };
        },
      });
      expect(await screen.findByTestId("second-step")).toHaveAttribute("data-view", "phone");
      expect(await screen.findByTestId("second-step-phone-number")).toHaveTextContent("47");
      await userEvent.click(screen.getByTestId("second-step-remember"));
      await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/inbox$/), {
        timeout: 8000,
      });
      expect(bodies.at(-1)).toEqual({ id: STARTED.id, key: STARTED.key, remember: true });
    }, 15_000);

    it("says when the phone turned it down, asks again, and offers a code instead", async () => {
      let asks = 0;
      renderAt("/sign-in/second-step?return_to=%2Finbox", {
        "GET /api/session": () => REQUIRED,
        "GET /api/auth/second-factor": () => withPhone(),
        "POST /api/auth/second-factor/phone": () => {
          asks += 1;
          return STARTED;
        },
        "POST /api/auth/second-factor/phone/check": () => ({ status: "denied", passed: null }),
      });
      await waitFor(
        () =>
          expect(screen.getByTestId("second-step-phone")).toHaveAttribute("data-state", "denied"),
        { timeout: 5000 },
      );
      expect(screen.getByText(/turned down on your phone/)).toBeInTheDocument();
      await userEvent.click(screen.getByTestId("second-step-phone-again"));
      await waitFor(() => expect(asks).toBe(2));
      await userEvent.click(screen.getByTestId("second-step-use-code"));
      expect(screen.getByTestId("second-step")).toHaveAttribute("data-view", "code");
      // And back to the phone from the code.
      await userEvent.click(screen.getByTestId("second-step-use-phone"));
      expect(screen.getByTestId("second-step")).toHaveAttribute("data-view", "phone");
    }, 15_000);

    it("starts on a code when no phone can approve", async () => {
      renderAt("/sign-in/second-step?return_to=%2Finbox", {
        "GET /api/session": () => REQUIRED,
        "GET /api/auth/second-factor": () => ({ ...withPhone(), phones: 0 }),
      });
      expect(await screen.findByTestId("second-step")).toHaveAttribute("data-view", "code");
      expect(screen.queryByTestId("second-step-use-phone")).toBeNull();
    });
  });
});
