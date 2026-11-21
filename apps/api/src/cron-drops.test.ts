// Staging and production, 2026-11-13 to 2026-11-21 (Sentry MEZONAS-API-3, -A, -B): the database
// went away under one client's cron pass ("Node shutting down.", then CONNECTION_CLOSED). The next
// tick does that pass's work, so a drop is a warning, not an error that pages the security officer;
// any other failure is still an error.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiHarness } from "./api.test-helper";
import { reportDrop, reportHandled } from "./observability/report";
import { cronTick } from "./runs/dispatch";

vi.mock("./observability/report", async (load) => ({
  ...(await load<typeof import("./observability/report")>()),
  reportDrop: vi.fn(),
  reportHandled: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(reportDrop).mockClear();
  vi.mocked(reportHandled).mockClear();
});

const h = await createApiHarness();
afterAll(() => h?.close());

/** As postgres.js makes one (`Errors.connection`). */
const dropped = () =>
  Object.assign(new Error("write CONNECTION_CLOSED abc.hyperdrive.local:5432"), {
    code: "CONNECTION_CLOSED",
  });

describe.skipIf(!h)("a client's cron pass that fails", () => {
  const H = h as NonNullable<typeof h>;
  const at = new Date("2026-11-21T09:31:20Z");

  it("reports a dropped database connection as a warning and goes on to the next client", async () => {
    const seen: string[] = [];
    await cronTick(
      {
        db: H.db,
        instances: H.instances,
        healthTick: async (tenantId) => {
          seen.push(tenantId);
          if (tenantId === H.A.tenantId) throw dropped();
        },
      },
      at,
    );
    expect(seen).toEqual(expect.arrayContaining([H.A.tenantId, H.B.tenantId]));
    expect(reportDrop).toHaveBeenCalledWith(
      expect.stringContaining("the next tick catches up"),
      expect.objectContaining({ code: "CONNECTION_CLOSED" }),
      { job: "schedules", client: H.A.tenantId },
    );
    expect(reportHandled).not.toHaveBeenCalledWith(
      `cron for client ${H.A.tenantId} failed`,
      expect.anything(),
      expect.anything(),
    );
  });

  it("still reports any other failure as an error", async () => {
    await cronTick(
      {
        db: H.db,
        instances: H.instances,
        healthTick: async (tenantId) => {
          if (tenantId === H.A.tenantId) throw new TypeError("x is undefined");
        },
      },
      at,
    );
    expect(reportDrop).not.toHaveBeenCalled();
    expect(reportHandled).toHaveBeenCalledWith(
      `cron for client ${H.A.tenantId} failed`,
      expect.any(TypeError),
      { job: "schedules", client: H.A.tenantId },
    );
  });
});
