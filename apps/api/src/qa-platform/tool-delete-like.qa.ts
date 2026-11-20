// TOOL lens: delete-like writes under other verbs (invariant 8, "Delete is off"). A connection's
// matrix pins `delete` off, and no tool declares the `delete` verb; these tools take a record out of
// the client's system (an archive, BILL's void) under `update`, so `delete: off` never stops them.

import {
  BILLCOM_TOOLS,
  createBillcomConnector,
  createOdooConnector,
  executeWrite,
  memoryCredentials,
  memoryLogger,
  ODOO_TOOLS,
  type WriteContext,
} from "@countersign/connectors";
import { FAKE_ODOO, fakeOdoo } from "@countersign/connectors/testing";
import { DEFAULT_PERMISSIONS, decideToolCall, isAlwaysSigned } from "@countersign/core";
import { describe, expect, it } from "vitest";

const NOW = new Date("2026-11-10T15:00:00.000Z");
const tenant = "0190f0c8-0000-7000-8000-000000000001";
const connectionId = "0190f0c8-0000-7000-8000-0000000000c9";

describe("TOOL: delete-like writes", () => {
  it("TOOL-3: odoo.record.update refuses to archive a record (active: false) with delete off", async () => {
    const odoo = fakeOdoo({ now: () => NOW });
    const connector = createOdooConnector({ fetch: odoo.fetch });
    const ctx: WriteContext = {
      tenantId: tenant,
      connection: {
        id: connectionId,
        tenantId: tenant,
        connector: "odoo",
        status: "connected",
        externalAccountId: null,
        config: {},
        // The platform's defaults: delete is off.
        permissions: DEFAULT_PERMISSIONS,
      },
      credentials: memoryCredentials({
        url: FAKE_ODOO.url,
        database: FAKE_ODOO.database,
        login: FAKE_ODOO.login,
        apiKey: FAKE_ODOO.apiKey,
      }),
      logger: memoryLogger(),
      now: () => NOW,
      idempotencyKey: "run-1:step:0",
    };
    expect(DEFAULT_PERMISSIONS.delete).toBe("off");
    let refused: unknown = null;
    try {
      await executeWrite(
        connector,
        ODOO_TOOLS.update,
        { model: "res.partner", id: FAKE_ODOO.partners.harbor, values: { active: false } },
        ctx,
      );
    } catch (error) {
      refused = error;
    }
    // Expected: refused like any other protected field (archiving is Odoo's delete). Today the
    // client's customer is archived in Odoo under `update`.
    expect(odoo.row("res.partner", FAKE_ODOO.partners.harbor)?.active).toBe(true);
    expect(refused).not.toBeNull();
  });

  it("TOOL-4: billcom.bill.archive (BILL's void) never runs without a person's signature", () => {
    const connector = createBillcomConnector({ devKey: "dev-key", environment: "sandbox" });
    const spec = connector.manifest.tools.find((t) => t.id === BILLCOM_TOOLS.billArchive);
    if (!spec) throw new Error("no bill.archive");
    // Updates loosened for this client by the operator; delete stays off.
    const decision = decideToolCall({
      sideEffect: spec.sideEffect,
      verb: spec.verb,
      matrix: { read: "auto", create: "approval", update: "auto", delete: "off" },
      stepApproval: "not_required",
      agentMode: "act",
      entity: {
        tool: spec,
        input: { id: "00n01ABCDEFGHIJKLMN" },
        declared: connector.manifest.permissionEntities,
      },
      alwaysSigned: isAlwaysSigned(spec),
    });
    // Expected: a void is never automatic (as QBO's deactivate and the website's take-down are
    // always signed). Today it runs on its own under update: auto, though delete is off.
    expect(decision).not.toBe("run");
  });
});
