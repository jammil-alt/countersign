import { beforeEach, describe, expect, it, vi } from "vitest";

const captureException = vi.fn();
const captureMessage = vi.fn();
vi.mock("@sentry/cloudflare", () => ({ captureException, captureMessage }));

const { reportHandled, reportProblem } = await import("./report");

describe("reportHandled", () => {
  beforeEach(() => {
    captureException.mockClear();
    captureMessage.mockClear();
  });

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

  it("sends a problem that is not an exception as a warning, grouped by what it says", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    reportProblem("an agent version has an unreadable client view", { agent_version: "v1" });
    expect(captureMessage).toHaveBeenCalledWith("an agent version has an unreadable client view", {
      level: "warning",
      tags: { handled: "yes", agent_version: "v1" },
    });
    log.mockRestore();
  });
});
