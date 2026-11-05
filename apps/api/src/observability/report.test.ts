import { beforeEach, describe, expect, it, vi } from "vitest";

const captureException = vi.fn();
vi.mock("@sentry/cloudflare", () => ({ captureException }));

const { reportHandled } = await import("./report");

describe("reportHandled", () => {
  beforeEach(() => captureException.mockClear());

  it("logs a handled error and sends it to Sentry, tagged as handled", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error("Intuit refused the sign-in: invalid_grant");
    reportHandled("sign-in to qbo failed", error, { connector: "qbo" });
    expect(log).toHaveBeenCalledWith("sign-in to qbo failed", error);
    expect(captureException).toHaveBeenCalledWith(error, {
      tags: { handled: "yes", connector: "qbo" },
      extra: { what: "sign-in to qbo failed" },
    });
    log.mockRestore();
  });
});
