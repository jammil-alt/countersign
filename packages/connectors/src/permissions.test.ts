import { DEFAULT_PERMISSIONS, LOW_RISK_PERMISSIONS } from "@countersign/core";
import { describe, expect, it } from "vitest";
import {
  applyMatrixChange,
  askFirstProblems,
  connectionDefaults,
  describeAccess,
  lowRiskPermissions,
  manifestDefaultProblems,
  normalizeMatrix,
  stricter,
  tightenMatrix,
} from "./permissions";
import { createTestkitConnector } from "./testkit/index";

describe("defaults", () => {
  it("start a new connection low risk: read auto, every write off", () => {
    expect(connectionDefaults()).toEqual(LOW_RISK_PERMISSIONS);
    expect(LOW_RISK_PERMISSIONS).toEqual({
      read: "auto",
      create: "off",
      update: "off",
      delete: "off",
    });
    // The gate's fallback for a verb a stored matrix leaves out is unchanged.
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

describe("a connector's low-risk start (Connectors C2)", () => {
  const declared = [
    {
      id: "invoice",
      label: "Invoices",
      verbs: ["read", "create", "update"],
      scopes: [{ id: "notes_only", label: "Notes only", verb: "update" }],
    },
    { id: "bill", label: "Bills", verbs: ["read", "create", "update"] },
    { id: "attachment", label: "Attachments", verbs: ["read", "create"] },
    { id: "account", label: "Accounts", verbs: ["read"] },
  ] as const;
  const ents = declared as unknown as Parameters<typeof lowRiskPermissions>[1];

  it("is reads only with no rows", () => {
    expect(lowRiskPermissions([], ents)).toEqual(LOW_RISK_PERMISSIONS);
    expect(lowRiskPermissions([], undefined)).toEqual(LOW_RISK_PERMISSIONS);
  });

  it("asks first for each row and pins every other record type of that verb off", () => {
    expect(
      lowRiskPermissions(
        [
          { verb: "create", entity: "attachment" },
          { verb: "update", entity: "invoice", scope: "notes_only" },
        ],
        ents,
      ),
    ).toEqual({
      read: "auto",
      create: "approval",
      update: "approval",
      delete: "off",
      entities: {
        invoice: { create: "off", scope: { update: "notes_only" } },
        bill: { create: "off", update: "off" },
      },
    });
  });

  it("opens the whole verb where the connector declares no record types", () => {
    expect(lowRiskPermissions([{ verb: "create" }], undefined)).toEqual({
      ...LOW_RISK_PERMISSIONS,
      create: "approval",
    });
  });

  it("refuses rows that name what the connector doesn't declare", () => {
    expect(askFirstProblems([{ verb: "create", entity: "attachment" }], ents)).toEqual([]);
    expect(
      askFirstProblems(
        [
          { verb: "create" },
          { verb: "create", entity: "truck" },
          { verb: "update", entity: "attachment" },
          { verb: "update", entity: "invoice", scope: "everything" },
        ],
        ents,
      ),
    ).toEqual([
      "askFirst create: name a record type (the connector declares them)",
      "askFirst create truck: not a record type the connector declares",
      "askFirst update attachment: attachment has no update",
      "askFirst update invoice: no update scope everything",
    ]);
    expect(askFirstProblems([{ verb: "create" }], undefined)).toEqual([]);
  });
});
