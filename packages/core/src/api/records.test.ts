import { describe, expect, it } from "vitest";
import { connectionLabel } from "./records";

describe("connectionLabel", () => {
  it("names an account as a client knows it, never by a bare id", () => {
    // The company name the connector set wins.
    expect(connectionLabel({ accountName: " Harbor Millwork " }, "9341455130122716")).toBe(
      "Harbor Millwork",
    );
    // A mail account is known by its address.
    expect(connectionLabel({}, "pat.lee@gmail.test")).toBe("pat.lee@gmail.test");
    // A QuickBooks realm id, a workspace id or nothing: no name.
    expect(connectionLabel({}, "9341455130122716")).toBeNull();
    expect(connectionLabel(null, "T0ACMEMILL")).toBeNull();
    expect(connectionLabel({ accountName: "  " }, null)).toBeNull();
    expect(connectionLabel({}, "two@at@signs")).toBeNull();
  });
});
