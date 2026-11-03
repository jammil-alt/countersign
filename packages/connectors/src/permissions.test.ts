import { DEFAULT_PERMISSIONS } from "@countersign/core";
import { describe, expect, it } from "vitest";
import {
  applyMatrixChange,
  connectionDefaults,
  describeAccess,
  manifestDefaultProblems,
  normalizeMatrix,
  stricter,
  tightenMatrix,
} from "./permissions";
import { createTestkitConnector } from "./testkit/index";

describe("defaults", () => {
  it("are read auto, create and update approval, delete off", () => {
    expect(connectionDefaults()).toEqual({
      read: "auto",
      create: "approval",
      update: "approval",
      delete: "off",
    });
    expect(normalizeMatrix(undefined)).toEqual(DEFAULT_PERMISSIONS);
    expect(normalizeMatrix({ update: "off" })).toEqual({ ...DEFAULT_PERMISSIONS, update: "off" });
  });

  it("let a connector start stricter, never looser", () => {
    const strict = { defaultPermissions: { ...DEFAULT_PERMISSIONS, create: "off" as const } };
    expect(connectionDefaults(strict).create).toBe("off");
    const loose = { defaultPermissions: { ...DEFAULT_PERMISSIONS, update: "auto" as const } };
    expect(manifestDefaultProblems(loose)).toHaveLength(1);
    expect(() => connectionDefaults(loose)).toThrow(/update is auto/);
  });

  it("orders levels off > approval > auto", () => {
    expect(stricter("auto", "approval")).toBe("approval");
    expect(stricter("off", "approval")).toBe("off");
    expect(stricter("auto", "auto")).toBe("auto");
  });
});

describe("applyMatrixChange", () => {
  const operatorSet = { ...DEFAULT_PERMISSIONS, update: "auto" as const, scope: "bills" };

  it("lets the operator loosen and set scope", () => {
    const r = applyMatrixChange({
      current: DEFAULT_PERMISSIONS,
      proposed: { update: "auto", scope: "bills" },
      by: "operator",
    });
    expect(r).toMatchObject({ ok: true, changed: true, matrix: operatorSet });
    if (r.ok)
      expect(r.change).toMatchObject({ loosened: ["update"], tightened: [], by: "operator" });
  });

  it("lets a client tighten, keeping unspecified verbs and the scope", () => {
    const r = applyMatrixChange({
      current: operatorSet,
      proposed: { update: "off" },
      by: "client",
    });
    expect(r).toMatchObject({
      ok: true,
      changed: true,
      matrix: { ...operatorSet, update: "off" },
      change: { tightened: ["update"], loosened: [] },
    });
  });

  it("refuses any loosening by a client, even mixed with tightening", () => {
    expect(
      applyMatrixChange({
        current: DEFAULT_PERMISSIONS,
        proposed: { update: "auto" },
        by: "client",
      }),
    ).toMatchObject({ ok: false, reason: "loosening", verbs: ["update"] });
    expect(
      applyMatrixChange({
        current: { ...DEFAULT_PERMISSIONS, read: "off" },
        proposed: { read: "auto", create: "off" },
        by: "client",
      }),
    ).toMatchObject({ ok: false, reason: "loosening", verbs: ["read"] });
  });

  it("refuses a client changing scope, and passes it through otherwise", () => {
    expect(
      applyMatrixChange({ current: operatorSet, proposed: { scope: "everything" }, by: "client" }),
    ).toMatchObject({ ok: false, reason: "scope" });
    expect(
      applyMatrixChange({ current: operatorSet, proposed: { scope: "bills" }, by: "client" }),
    ).toMatchObject({ ok: true, changed: false, matrix: { scope: "bills" } });
    const opaque = { folders: ["AP"], labels: ["invoices"] };
    expect(
      applyMatrixChange({ current: operatorSet, proposed: { scope: opaque }, by: "operator" }),
    ).toMatchObject({ ok: true, matrix: { scope: opaque } });
  });

  it("keeps delete off for everyone", () => {
    for (const by of ["operator", "client"] as const) {
      expect(
        applyMatrixChange({ current: DEFAULT_PERMISSIONS, proposed: { delete: "approval" }, by }),
      ).toMatchObject({ ok: false, reason: "delete_not_off" });
    }
  });

  it("reports no change for a no-op", () => {
    const r = applyMatrixChange({ current: undefined, proposed: {}, by: "client" });
    expect(r).toMatchObject({ ok: true, changed: false, matrix: DEFAULT_PERMISSIONS });
  });
});

describe("tightenMatrix", () => {
  it("takes the stricter level per verb and never loosens", () => {
    expect(
      tightenMatrix(
        { read: "auto", create: "auto", update: "approval", delete: "off", scope: "x" },
        { read: "approval", create: "off", update: "auto" },
      ),
    ).toEqual({
      read: "approval",
      create: "off",
      update: "approval",
      delete: "off",
      scope: "x",
    });
  });
});

describe("describeAccess", () => {
  it("says what each tool may do on a connection", () => {
    const { manifest } = createTestkitConnector();
    expect(describeAccess(manifest, DEFAULT_PERMISSIONS).map((a) => [a.toolId, a.access])).toEqual([
      ["testkit.record.query", "runs"],
      ["testkit.record.update", "asks_first"],
    ]);
    expect(describeAccess(manifest, { update: "auto" })[1]?.access).toBe("steps_may_skip_approval");
    expect(describeAccess(manifest, { read: "off", update: "off" }).map((a) => a.access)).toEqual([
      "not_allowed",
      "not_allowed",
    ]);
  });
});
