// The ledger's set-up in QuickBooks (docs/plan.md §1.79): accounts, classes and locations created
// and changed against the fake, each always signed (core's gate refuses to run one without a
// person whatever the matrix and the mode), a duplicate name refused before anyone is asked, a
// change on a version QuickBooks has moved past refused, and a retried write reported done.

import {
  DEFAULT_PERMISSIONS,
  decideToolCall,
  isAlwaysSigned,
  type JsonObject,
  type PermissionMatrix,
} from "@countersign/core";
import { describe, expect, it } from "vitest";
import type { ToolContext, WriteContext } from "../connector";
import { memoryCredentials } from "../credentials-accessor";
import { captureBefore, executeWrite, ToolCallError } from "../invoke";
import { memoryLogger } from "../logger";
import { FAKE_QBO_CLIENT, FAKE_QBO_REALM, fakeQbo } from "../testing";
import { createQboConnector, LEDGER_WRITE_TOOLS } from "./index";

const NOW = new Date("2026-11-05T18:00:00.000Z");
const tenant = "0190f0c8-0000-7000-8000-000000000001";
const user = "0190f0c8-0000-7000-8000-0000000000a1";
const connectionId = "0190f0c8-0000-7000-8000-0000000000c1";
const REDIRECT = "https://staging.mezonas.com/api/connections/qbo/callback";

async function setup() {
  const qbo = fakeQbo({ now: () => NOW });
  const connector = createQboConnector({
    ...FAKE_QBO_CLIENT,
    environment: "sandbox",
    fetch: qbo.fetch,
    sleep: async () => {},
    now: () => NOW,
  });
  const grant = await connector.handleCallback?.(
    { code: "fixture-code", realmId: FAKE_QBO_REALM, state: "x" },
    { tenantId: tenant, userId: user, redirectUri: REDIRECT },
  );
  if (!grant) throw new Error("no grant");
  const store = memoryCredentials(grant.credentials as JsonObject);
  const ctx = (key = "signed:ledger-1"): WriteContext => ({
    tenantId: tenant,
    connection: {
      id: connectionId,
      tenantId: tenant,
      connector: "qbo",
      status: "connected",
      externalAccountId: FAKE_QBO_REALM,
      config: {},
      permissions: DEFAULT_PERMISSIONS,
    },
    credentials: store,
    logger: memoryLogger(),
    now: () => NOW,
    idempotencyKey: key,
  });
  const propose = (): ToolContext => {
    const { idempotencyKey: _key, ...rest } = ctx();
    return rest;
  };
  return { qbo, connector, ctx, propose };
}

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (error) {
    // Bad input reads as its issues; a refusal as its message.
    if (error instanceof ToolCallError && error.code === "invalid_input") {
      return (error.issues ?? []).map((i) => i.message).join("; ");
    }
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("it was not refused");
}

describe("the ledger's writes are always signed", () => {
  it("each waits for a person whatever the matrix, the step and the mode say", async () => {
    const { connector } = await setup();
    const loose: PermissionMatrix = { ...DEFAULT_PERMISSIONS, create: "auto", update: "auto" };
    for (const id of Object.values(LEDGER_WRITE_TOOLS)) {
      const spec = connector.manifest.tools.find((t) => t.id === id);
      if (!spec) throw new Error(id);
      expect(isAlwaysSigned(spec), id).toBe(true);
      // The loosest everything else can be: the matrix on auto, the step not required, mode act.
      const decision = decideToolCall({
        sideEffect: spec.sideEffect,
        verb: spec.verb,
        matrix: loose,
        stepApproval: "not_required",
        agentMode: "act",
        alwaysSigned: isAlwaysSigned(spec),
      });
      expect(decision, id).toBe("approval");
    }
  });
});

describe("qbo.account.create", () => {
  it("adds an account with its type, detail type, number and description, once", async () => {
    const s = await setup();
    const input = {
      name: "Fuel",
      accountType: "Expense",
      accountSubType: "Auto",
      number: "6120",
      description: "Gas for the delivery vans",
    };
    const proposed = await captureBefore(
      s.connector,
      LEDGER_WRITE_TOOLS.accountCreate,
      input,
      s.propose(),
    );
    expect(proposed.before).toEqual({ parent: null });
    const out = await executeWrite(s.connector, LEDGER_WRITE_TOOLS.accountCreate, input, s.ctx());
    const id = (out.output as { id: string }).id;
    expect(out.output).toMatchObject({ name: "Fuel", fullName: "Fuel", alreadyDone: false });
    expect(s.qbo.get("Account", id)).toMatchObject({
      Name: "Fuel",
      AccountType: "Expense",
      AccountSubType: "Auto",
      AcctNum: "6120",
      Description: "Gas for the delivery vans",
      Active: true,
    });
    // The same signed action again (a lost answer): QuickBooks answers its first result by the
    // request id, so nothing is made twice.
    const again = await executeWrite(s.connector, LEDGER_WRITE_TOOLS.accountCreate, input, s.ctx());
    expect(again.output).toMatchObject({ id });
    // Another signed action with the name in use: refused, nothing made.
    expect(
      await refusal(
        executeWrite(s.connector, LEDGER_WRITE_TOOLS.accountCreate, input, s.ctx("signed:other")),
      ),
    ).toContain("already an account named Fuel");
    // Proposed again as a new change: refused, the name is taken.
    expect(
      await refusal(
        captureBefore(s.connector, LEDGER_WRITE_TOOLS.accountCreate, input, s.propose()),
      ),
    ).toContain("already an account named Fuel");
  });

  it("adds a sub-account under a parent of the same type; refuses another type or an unknown parent", async () => {
    const s = await setup();
    const sub = { name: "Plywood", accountType: "Cost of Goods Sold", parentId: "80" };
    const proposed = await captureBefore(
      s.connector,
      LEDGER_WRITE_TOOLS.accountCreate,
      sub,
      s.propose(),
    );
    expect(proposed.before).toEqual({ parent: { id: "80", name: "Job Materials" } });
    const out = await executeWrite(s.connector, LEDGER_WRITE_TOOLS.accountCreate, sub, s.ctx());
    expect(out.output).toMatchObject({ fullName: "Job Materials:Plywood" });
    expect(
      await refusal(
        captureBefore(
          s.connector,
          LEDGER_WRITE_TOOLS.accountCreate,
          { ...sub, name: "Glue", accountType: "Expense" },
          s.propose(),
        ),
      ),
    ).toContain("its parent's type");
    expect(
      await refusal(
        captureBefore(
          s.connector,
          LEDGER_WRITE_TOOLS.accountCreate,
          { ...sub, name: "Glue", parentId: "9999" },
          s.propose(),
        ),
      ),
    ).toContain("isn't one of this company's active accounts");
  });
});

describe("qbo.account.update", () => {
  it("renames, renumbers, re-describes and changes the type, with the before state for the card", async () => {
    const s = await setup();
    const change = {
      id: "84",
      syncToken: "1",
      name: "Shop supplies and tools",
      number: "6400",
      description: "Glue, blades, sandpaper, small tools",
      accountType: "Cost of Goods Sold",
    };
    const proposed = await captureBefore(
      s.connector,
      LEDGER_WRITE_TOOLS.accountUpdate,
      change,
      s.propose(),
    );
    expect(proposed.before).toMatchObject({
      current: {
        id: "84",
        syncToken: "1",
        name: "Shop Supplies",
        accountType: "Expense",
        active: true,
      },
      newParent: null,
    });
    const out = await executeWrite(s.connector, LEDGER_WRITE_TOOLS.accountUpdate, change, s.ctx());
    expect(out.output).toMatchObject({ name: "Shop supplies and tools", alreadyDone: false });
    expect(s.qbo.get("Account", "84")).toMatchObject({
      Name: "Shop supplies and tools",
      AcctNum: "6400",
      Description: "Glue, blades, sandpaper, small tools",
      AccountType: "Cost of Goods Sold",
      SyncToken: "2",
    });
    // The same action again finds it done.
    const again = await executeWrite(
      s.connector,
      LEDGER_WRITE_TOOLS.accountUpdate,
      change,
      s.ctx(),
    );
    expect(again.output).toMatchObject({ alreadyDone: true });
  });

  it("makes an account inactive (QuickBooks' delete) and active again, moves it under a parent and back", async () => {
    const s = await setup();
    await executeWrite(
      s.connector,
      LEDGER_WRITE_TOOLS.accountUpdate,
      { id: "85", syncToken: "2", active: true },
      s.ctx("k1"),
    );
    await executeWrite(
      s.connector,
      LEDGER_WRITE_TOOLS.accountUpdate,
      { id: "85", syncToken: "3", active: false },
      s.ctx("k2"),
    );
    expect(s.qbo.get("Account", "85")?.Active).toBe(false);
    const moved = await executeWrite(
      s.connector,
      LEDGER_WRITE_TOOLS.accountUpdate,
      { id: "81", syncToken: "0", parentId: "80" },
      s.ctx("k3"),
    );
    expect(moved.output).toMatchObject({ fullName: "Job Materials:Freight In" });
    const back = await executeWrite(
      s.connector,
      LEDGER_WRITE_TOOLS.accountUpdate,
      { id: "81", syncToken: "1", parentId: null },
      s.ctx("k4"),
    );
    expect(back.output).toMatchObject({ fullName: "Freight In" });
  });

  it("refuses a change on a version QuickBooks has moved past, a name in use, its own parent, and nothing to change", async () => {
    const s = await setup();
    expect(
      await refusal(
        executeWrite(
          s.connector,
          LEDGER_WRITE_TOOLS.accountUpdate,
          { id: "84", syncToken: "0", name: "Supplies" },
          s.ctx(),
        ),
      ),
    ).toContain("changed in QuickBooks since it was read");
    expect(
      await refusal(
        captureBefore(
          s.connector,
          LEDGER_WRITE_TOOLS.accountUpdate,
          { id: "84", syncToken: "1", name: "Job Materials" },
          s.propose(),
        ),
      ),
    ).toContain("already");
    expect(
      await refusal(
        captureBefore(
          s.connector,
          LEDGER_WRITE_TOOLS.accountUpdate,
          { id: "84", syncToken: "1", parentId: "84" },
          s.propose(),
        ),
      ),
    ).toContain("its own parent");
    expect(
      await refusal(
        captureBefore(
          s.connector,
          LEDGER_WRITE_TOOLS.accountUpdate,
          { id: "84", syncToken: "1" },
          s.propose(),
        ),
      ),
    ).toContain("say what changes");
  });
});

describe("classes and locations", () => {
  it("adds a class and a location, renames the class and makes the location inactive", async () => {
    const s = await setup();
    const cls = await executeWrite(
      s.connector,
      LEDGER_WRITE_TOOLS.classCreate,
      { name: "Remodels" },
      s.ctx("c1"),
    );
    const classId = (cls.output as { id: string }).id;
    expect(s.qbo.get("Class", classId)).toMatchObject({ Name: "Remodels", Active: true });
    expect(
      await refusal(
        captureBefore(s.connector, LEDGER_WRITE_TOOLS.classCreate, { name: "Shop" }, s.propose()),
      ),
    ).toContain("already a class named Shop");
    const loc = await executeWrite(
      s.connector,
      LEDGER_WRITE_TOOLS.locationCreate,
      { name: "Dallas yard" },
      s.ctx("l1"),
    );
    const locId = (loc.output as { id: string }).id;
    expect(s.qbo.get("Department", locId)).toMatchObject({ Name: "Dallas yard" });
    await executeWrite(
      s.connector,
      LEDGER_WRITE_TOOLS.classUpdate,
      { id: classId, syncToken: "0", name: "Remodeling" },
      s.ctx("c2"),
    );
    expect(s.qbo.get("Class", classId)?.Name).toBe("Remodeling");
    await executeWrite(
      s.connector,
      LEDGER_WRITE_TOOLS.locationUpdate,
      { id: locId, syncToken: "0", active: false },
      s.ctx("l2"),
    );
    expect(s.qbo.get("Department", locId)?.Active).toBe(false);
  });
});
