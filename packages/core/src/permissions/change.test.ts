// Connectors C4 (docs/connectors-plan.md §5.4, §7.1, §7.2): a change's rows and direction, the
// client admin's rule, our edits under the client's go-ahead, and a request's life.

import { describe, expect, it } from "vitest";
import type { MezonasMay } from "../schemas/connection-requests";
import type { PermissionEntity, PermissionMatrix } from "../schemas/permissions";
import {
  activeMezonasMay,
  changeDirection,
  clientMayAllow,
  describeRowChange,
  mezonasMayUntil,
  requestExpired,
  requestExpiresAt,
  requestStale,
  type SettingsLike,
  settingsEqual,
  withinAuthorization,
} from "./change";
import { allowNeeds, type ConnectorNeed } from "./needs";

const declared: PermissionEntity[] = [
  { id: "bill", label: "Bills", verbs: ["read", "create", "update"] },
  { id: "vendor", label: "Vendors", verbs: ["read", "create"] },
  {
    id: "invoice",
    label: "Invoices",
    verbs: ["read", "update"],
    scopes: [
      { id: "notes_only", label: "Notes only", verb: "update", tools: ["qbo.invoice.note"] },
      {
        id: "notes_and_memo",
        label: "Notes and memo",
        verb: "update",
        tools: ["qbo.invoice.note", "qbo.invoice.memo"],
      },
    ],
  },
];

const lowRisk: PermissionMatrix = { read: "auto", create: "off", update: "off", delete: "off" };
const settings = (permissions: Partial<PermissionMatrix>, config = {}): SettingsLike => ({
  permissions,
  config,
});

const need = (n: Partial<ConnectorNeed> & Pick<ConnectorNeed, "verb">): ConnectorNeed => ({
  connector: "qbo",
  level: n.verb === "read" ? "on" : "ask",
  wantsAuto: false,
  why: [],
  because: [],
  ...n,
});

const NOW = new Date("2026-11-20T12:00:00.000Z");
const may = (choice: MezonasMay["choice"], until: string | null = null): MezonasMay => ({
  choice,
  until,
  setBy: "0190f2a0-0000-7000-8000-000000000001",
  setAt: "2026-11-19T12:00:00.000Z",
});

describe("changeDirection", () => {
  it("is none for the same settings, whatever the key order or verbs left to their defaults", () => {
    const a = settings({ read: "auto", create: "approval" }, { folders: ["a", "b"] });
    const b = settings(
      { create: "approval", update: "approval", read: "auto" },
      { folders: ["b", "a"] },
    );
    expect(changeDirection(a, b)).toEqual({ direction: "none", rows: [] });
  });

  it("words a record type opened by allowNeeds and keeps the pinned ones out", () => {
    const { matrix } = allowNeeds(lowRisk, [need({ verb: "create", entity: "bill" })], declared);
    const r = changeDirection(settings(lowRisk), settings(matrix), declared);
    expect(r.direction).toBe("looser");
    expect(r.rows.map((row) => describeRowChange(row, declared))).toEqual([
      "Create: Off → Ask me first",
      "Create bills: Off → Ask me first",
    ]);
  });

  it("sees a verb opened without pins open every record type of it", () => {
    const r = changeDirection(
      settings(lowRisk),
      settings({ ...lowRisk, create: "approval" }),
      declared,
    );
    expect(r.rows.map((row) => describeRowChange(row, declared))).toEqual([
      "Create: Off → Ask me first",
      "Create bills: Off → Ask me first",
      "Create vendors: Off → Ask me first",
    ]);
  });

  it("is tighter for a write turned off or lowered from On its own", () => {
    const r = changeDirection(
      settings({ read: "auto", create: "auto", update: "approval", delete: "off" }),
      settings({ read: "auto", create: "approval", update: "off", delete: "off" }),
    );
    expect(r.direction).toBe("tighter");
    expect(r.rows).toEqual([
      {
        kind: "level",
        verb: "create",
        entity: null,
        from: "auto",
        to: "approval",
        direction: "tighter",
      },
      {
        kind: "level",
        verb: "update",
        entity: null,
        from: "approval",
        to: "off",
        direction: "tighter",
      },
    ]);
  });

  it("is mixed when one row opens and another closes", () => {
    const r = changeDirection(
      settings({ ...lowRisk, update: "approval" }),
      settings({ ...lowRisk, create: "approval" }),
    );
    expect(r.direction).toBe("mixed");
  });

  it("reads setup lists by item: more is looser, fewer is tighter, anything else looser", () => {
    const fewer = changeDirection(
      settings(lowRisk, {
        folders: [
          { id: "f1", name: "Bills" },
          { id: "f2", name: "Old" },
        ],
      }),
      settings(lowRisk, { folders: [{ id: "f1", name: "Bills (renamed)" }] }),
    );
    expect(fewer.direction).toBe("tighter");
    expect(describeRowChange(fewer.rows[0] as never)).toBe("Setup: folders: 1 removed");

    const more = changeDirection(
      settings(lowRisk, { channels: ["C1"] }),
      settings(lowRisk, { channels: ["C1", "C2"] }),
    );
    expect(more.direction).toBe("looser");
    expect(more.rows[0]).toMatchObject({
      kind: "setup",
      key: "channels",
      added: ["C2"],
      removed: [],
    });

    const query = changeDirection(
      settings(lowRisk, { query: "label:bills" }),
      settings(lowRisk, { query: "label:bills OR label:receipts" }),
    );
    expect(query.direction).toBe("looser");
    expect(describeRowChange(query.rows[0] as never)).toBe("Setup: query: changed");
    // A setting dropped is a change the platform can't judge: looser.
    expect(
      changeDirection(settings(lowRisk, { query: "x" }), settings(lowRisk, {})).direction,
    ).toBe("looser");
  });

  it("reads a record type's scope by the tools it lets through", () => {
    const withScope = (scope?: string): Partial<PermissionMatrix> => ({
      ...lowRisk,
      update: "approval",
      entities: scope ? { invoice: { scope: { update: scope } } } : {},
    });
    const narrower = changeDirection(
      settings(withScope("notes_and_memo")),
      settings(withScope("notes_only")),
      declared,
    );
    expect(narrower.direction).toBe("tighter");
    expect(describeRowChange(narrower.rows[0] as never, declared)).toBe(
      "Update invoices: scope: Notes and memo → Notes only",
    );
    expect(
      changeDirection(
        settings(withScope("notes_only")),
        settings(withScope("notes_and_memo")),
        declared,
      ).direction,
    ).toBe("looser");
    expect(
      changeDirection(settings(withScope("notes_only")), settings(withScope()), declared).direction,
    ).toBe("looser");
    expect(
      changeDirection(settings(withScope()), settings(withScope("notes_only")), declared).direction,
    ).toBe("tighter");
  });

  it("counts any change to the connection's own scope as looser", () => {
    expect(
      changeDirection(settings({ ...lowRisk, scope: "a" }), settings({ ...lowRisk, scope: "b" }))
        .direction,
    ).toBe("looser");
  });
});

describe("clientMayAllow", () => {
  it("lets a client admin turn reads on and off and writes between Off and Ask me first", () => {
    const { matrix } = allowNeeds(lowRisk, [need({ verb: "create", entity: "bill" })], declared);
    expect(clientMayAllow(settings(lowRisk), settings(matrix), declared)).toEqual({ ok: true });
    expect(clientMayAllow(settings(lowRisk), settings({ ...lowRisk, read: "off" }))).toEqual({
      ok: true,
    });
    expect(clientMayAllow(settings({ ...lowRisk, update: "approval" }), settings(lowRisk))).toEqual(
      {
        ok: true,
      },
    );
  });

  it("never lets a client set On its own, but lets them lower it and keep it", () => {
    const r = clientMayAllow(settings(lowRisk), settings({ ...lowRisk, create: "auto" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refused[0]?.reason).toMatch(/On its own/);
    const auto = settings({ ...lowRisk, create: "auto", update: "approval" });
    expect(clientMayAllow(auto, settings({ ...lowRisk, create: "approval" }))).toEqual({
      ok: true,
    });
    // Already On its own, unchanged, while another row changes.
    expect(clientMayAllow(auto, settings({ ...lowRisk, create: "auto" }))).toEqual({ ok: true });
  });

  it("refuses an On its own reached by dropping a record type's pin", () => {
    const before = settings({
      ...lowRisk,
      create: "auto",
      entities: { bill: { create: "approval" } },
    });
    const after = settings({ ...lowRisk, create: "auto", entities: {} });
    const r = clientMayAllow(before, after, declared);
    expect(r.ok).toBe(false);
  });

  it("never lets delete on, nor the connection's own scope change", () => {
    expect(clientMayAllow(settings(lowRisk), settings({ ...lowRisk, delete: "approval" })).ok).toBe(
      false,
    );
    expect(clientMayAllow(settings(lowRisk), settings({ ...lowRisk, scope: "x" })).ok).toBe(false);
  });

  it("lets the client set the tool's setup", () => {
    expect(
      clientMayAllow(settings(lowRisk, { folders: [] }), settings(lowRisk, { folders: ["a"] })),
    ).toEqual({
      ok: true,
    });
  });
});

describe("withinAuthorization", () => {
  const before = settings(lowRisk);
  const billsOpen = allowNeeds(
    lowRisk,
    [need({ verb: "create", entity: "bill" })],
    declared,
  ).matrix;
  const needs = [need({ verb: "create", entity: "bill" })];

  it("always fits a change that is only tighter", () => {
    const r = withinAuthorization(
      { before: settings({ ...lowRisk, update: "approval" }), after: before },
      null,
      [],
      NOW,
    );
    expect(r).toEqual({ fits: true });
  });

  it("covers nothing when the client asks each time, or after the go-ahead ended", () => {
    const change = { before, after: settings(billsOpen), declared };
    expect(withinAuthorization(change, null, needs, NOW)).toMatchObject({ fits: false });
    const ended = withinAuthorization(change, may("any", "2026-11-20T11:59:59.000Z"), needs, NOW);
    expect(ended).toMatchObject({
      fits: false,
      reason: "The client's go-ahead ended on 2026-11-20.",
    });
    expect(activeMezonasMay(may("any", "2026-11-20T12:00:00.000Z"), NOW)).toBeNull();
    expect(activeMezonasMay(may("any", "2026-11-21T12:00:00.000Z"), NOW)).not.toBeNull();
  });

  it("covers what an agent needs under `needs`, and nothing else", () => {
    const change = { before, after: settings(billsOpen), declared };
    expect(withinAuthorization(change, may("needs"), needs, NOW)).toEqual({ fits: true });
    const vendors = allowNeeds(
      lowRisk,
      [need({ verb: "create", entity: "vendor" })],
      declared,
    ).matrix;
    const r = withinAuthorization(
      { before, after: settings(vendors), declared },
      may("needs"),
      needs,
      NOW,
    );
    expect(r).toMatchObject({
      fits: false,
      reason: "Create vendors isn't something an agent needs.",
    });
    // Opening the verb without pins opens vendors too.
    const wide = withinAuthorization(
      { before, after: settings({ ...lowRisk, create: "approval" }), declared },
      may("needs"),
      needs,
      NOW,
    );
    expect(wide.fits).toBe(false);
    // A setup change isn't a need.
    const setup = withinAuthorization(
      { before: settings(lowRisk, { folders: [] }), after: settings(lowRisk, { folders: ["x"] }) },
      may("needs"),
      needs,
      NOW,
    );
    expect(setup.fits).toBe(false);
  });

  it("covers any row and the setup under `any`, up to Ask me first", () => {
    expect(
      withinAuthorization(
        {
          before: settings(lowRisk, { folders: [] }),
          after: settings({ ...lowRisk, create: "approval" }, { folders: ["x"] }),
          declared,
        },
        may("any"),
        [],
        NOW,
      ),
    ).toEqual({ fits: true });
  });

  it("never covers On its own or delete, whatever the go-ahead", () => {
    const auto = withinAuthorization(
      { before, after: settings({ ...lowRisk, create: "auto" }) },
      may("any"),
      [need({ verb: "create" })],
      NOW,
    );
    expect(auto).toMatchObject({
      fits: false,
      reason: "On its own always goes to the client to approve.",
    });
    const del = withinAuthorization(
      { before, after: settings({ ...lowRisk, delete: "approval" }) },
      may("any"),
      [],
      NOW,
    );
    expect(del).toMatchObject({ fits: false, reason: "Delete stays off." });
  });
});

describe("change requests", () => {
  it("is stale once the settings are no longer what it was made against", () => {
    const against = settings({ ...lowRisk, entities: {} }, { folders: ["a"] });
    expect(
      requestStale(
        { against },
        settings({ create: "off", read: "auto", update: "off" }, { folders: ["a"] }),
      ),
    ).toBe(false);
    expect(
      requestStale({ against }, settings({ ...lowRisk, update: "approval" }, { folders: ["a"] })),
    ).toBe(true);
    expect(requestStale({ against }, settings(lowRisk, { folders: ["a", "b"] }))).toBe(true);
    expect(
      settingsEqual(
        settings({}, {}),
        settings({ read: "auto", create: "approval", update: "approval", delete: "off" }, {}),
      ),
    ).toBe(true);
  });

  it("ends 14 days after it was made, and only while open", () => {
    const created = new Date("2026-11-01T09:00:00.000Z");
    const ends = requestExpiresAt(created);
    expect(ends.toISOString()).toBe("2026-11-15T09:00:00.000Z");
    expect(
      requestExpired({ status: "open", expiresAt: ends }, new Date("2026-11-15T08:59:59.000Z")),
    ).toBe(false);
    expect(
      requestExpired(
        { status: "open", expiresAt: ends.toISOString() },
        new Date("2026-11-15T09:00:00.000Z"),
      ),
    ).toBe(true);
    expect(requestExpired({ status: "approved", expiresAt: ends }, NOW)).toBe(false);
  });

  it("sets a 30-day go-ahead's end, and none for until turned off", () => {
    expect(mezonasMayUntil("30_days", NOW)).toBe("2026-12-20T12:00:00.000Z");
    expect(mezonasMayUntil("until_off", NOW)).toBeNull();
  });
});
