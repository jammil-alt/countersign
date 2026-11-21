import { describe, expect, it } from "vitest";
import { isDatabaseDrop } from "./drops";

/** As postgres.js makes them (`Errors.connection`, `Errors.postgres`). */
function clientDrop(code: string): Error {
  return Object.assign(new Error(`write ${code} abc.hyperdrive.local:5432`), { code, errno: code });
}
function serverError(message: string, code: string): Error {
  const e = Object.assign(new Error(message), { code, severity: "FATAL" });
  e.name = "PostgresError";
  return e;
}

describe("isDatabaseDrop", () => {
  it("knows a closed or timed-out connection (MEZONAS-API-A, -B)", () => {
    for (const code of [
      "CONNECTION_CLOSED",
      "CONNECTION_ENDED",
      "CONNECTION_DESTROYED",
      "CONNECT_TIMEOUT",
    ]) {
      expect(isDatabaseDrop(clientDrop(code))).toBe(true);
    }
  });

  it("knows a server that is shutting down (MEZONAS-API-3), by its code or its words", () => {
    expect(
      isDatabaseDrop(serverError("terminating connection due to administrator command", "57P01")),
    ).toBe(true);
    expect(isDatabaseDrop(serverError("Node shutting down.", "XX000"))).toBe(true);
    expect(isDatabaseDrop(serverError("shutting down", "XX000"))).toBe(true);
  });

  it("looks through a wrapper's cause", () => {
    expect(
      isDatabaseDrop(new Error("query failed", { cause: clientDrop("CONNECTION_CLOSED") })),
    ).toBe(true);
  });

  it("leaves real faults alone", () => {
    expect(
      isDatabaseDrop(
        serverError('duplicate key value violates unique constraint "run_pkey"', "23505"),
      ),
    ).toBe(false);
    expect(isDatabaseDrop(serverError("permission denied for table run", "42501"))).toBe(false);
    expect(isDatabaseDrop(new Error("Node shutting down."))).toBe(false);
    expect(isDatabaseDrop(new TypeError("x is undefined"))).toBe(false);
    expect(isDatabaseDrop(undefined)).toBe(false);
    expect(isDatabaseDrop("CONNECTION_CLOSED")).toBe(false);
  });
});
