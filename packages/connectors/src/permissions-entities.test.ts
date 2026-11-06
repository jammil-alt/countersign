// v0.12 W2-A: permissions per record type on the connectors' side (docs/plan.md §1.44, M21):
// every manifest declares an entity for every tool; the matrix editor is tighten-only per entity
// for clients; default access for new clients; the framework's last line counts entities.
import { DEFAULT_PERMISSIONS, type PermissionMatrix } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { createBankfeedConnector } from "./bankfeed/index";
import { createBrowserConnector } from "./browser/index";
import type { Connector } from "./connector";
import { createGchatConnector } from "./gchat/index";
import { createGdriveConnector } from "./gdrive/index";
import { createGmailConnector } from "./gmail/index";
import { createOutlookConnector } from "./outlook/index";
import {
  applyMatrixChange,
  connectionDefaults,
  connectionLevel,
  defaultAccessProblems,
  describeAccess,
  normalizeMatrix,
} from "./permissions";
import { createPodioConnector } from "./podio/index";
import { createQboConnector } from "./qbo/index";
import { QBO_TOOLS } from "./qbo/tool-kit";
import { createResendConnector } from "./resend/index";
import { createTestkitConnector } from "./testkit/index";
import { createTwilioConnector } from "./twilio/index";
import { createUploadConnector } from "./upload/index";
import { createWebhookConnector } from "./webhook/index";
import { createZohoCrmConnector, ZOHO_TOOLS } from "./zoho_crm/index";

const ALL: Connector[] = [
  createUploadConnector(),
  createQboConnector(),
  createWebhookConnector(),
  createZohoCrmConnector(),
  createPodioConnector(),
  createTwilioConnector(),
  createGmailConnector(),
  createResendConnector(),
  createBrowserConnector(),
  createTestkitConnector(),
  // v0.12 W3-B
  createGdriveConnector(),
  createOutlookConnector(),
  // v0.14 W4-E
  createGchatConnector(),
  // v0.12 bankfeed
  createBankfeedConnector(),
];

const qbo = createQboConnector().manifest;
const declared = qbo.permissionEntities;

describe("manifests", () => {
  it.each(ALL.map((c) => [c.manifest.id, c] as const))(
    "%s declares an entity for every tool, from its own permissionEntities",
    (_id, connector) => {
      const m = connector.manifest;
      const ids = (m.permissionEntities ?? []).map((e) => e.id);
      for (const t of m.tools) {
        const named = t.entity ? [t.entity] : Object.values(t.entityInput?.values ?? {});
        expect(named.length, `${t.id} names no entity`).toBeGreaterThan(0);
        for (const e of named) expect(ids, `${t.id}: ${e}`).toContain(e);
      }
      // Every scope's tools are the connector's own.
      for (const e of m.permissionEntities ?? []) {
        for (const s of e.scopes ?? []) {
          for (const tool of s.tools) expect(m.tools.map((t) => t.id)).toContain(tool);
        }
      }
    },
  );

  it("QuickBooks declares the plan's entities, invoices with notes only on update", () => {
    expect(declared?.map((e) => e.id)).toEqual([
      "bill",
      "purchase",
      "item",
      "vendor",
      "invoice",
      "customer",
      "payment",
      "attachment",
    ]);
    expect(declared?.find((e) => e.id === "invoice")?.scopes).toEqual([
      { id: "notes_only", label: "Notes only", verb: "update", tools: [QBO_TOOLS.invoiceAddNote] },
    ]);
  });
});

describe("the prototype's QuickBooks matrix", () => {
  // Bills, items, vendors; invoices notes only; customers read only.
  const matrix: PermissionMatrix = {
    read: "auto",
    create: "approval",
    update: "approval",
    delete: "off",
    entities: {
      invoice: { scope: { update: "notes_only" } },
      customer: { read: "auto" },
    },
  };
  const level = (toolId: string) => {
    const spec = qbo.tools.find((t) => t.id === toolId);
    if (!spec) throw new Error(toolId);
    return connectionLevel(qbo, spec, matrix);
  };

  it("behaves as shown", () => {
    expect(level(QBO_TOOLS.billCreate)).toBe("approval");
    expect(level(QBO_TOOLS.billUpdateLines)).toBe("approval");
    expect(level(QBO_TOOLS.itemUpdatePurchaseCost)).toBe("approval");
    expect(level(QBO_TOOLS.vendorQuery)).toBe("auto");
    expect(level(QBO_TOOLS.invoiceAddNote)).toBe("approval");
    expect(level(QBO_TOOLS.customerQuery)).toBe("auto");
    const access = describeAccess(qbo, matrix);
    expect(access.find((a) => a.toolId === QBO_TOOLS.invoiceAddNote)).toMatchObject({
      entity: "invoice",
      access: "asks_first",
    });
  });

  it("an entity off blocks its tools while another entity's still work", () => {
    const off = { ...matrix, entities: { ...matrix.entities, item: { update: "off" as const } } };
    const spec = (id: string) => qbo.tools.find((t) => t.id === id) as (typeof qbo.tools)[number];
    expect(connectionLevel(qbo, spec(QBO_TOOLS.itemUpdatePurchaseCost), off)).toBe("off");
    expect(connectionLevel(qbo, spec(QBO_TOOLS.billUpdateLines), off)).toBe("approval");
    expect(
      describeAccess(qbo, off).find((a) => a.toolId === QBO_TOOLS.itemUpdatePurchaseCost)?.access,
    ).toBe("not_allowed");
  });
});

describe("Zoho's record tools read their entity from the input", () => {
  const zoho = createZohoCrmConnector().manifest;
  const create = zoho.tools.find((t) => t.id === ZOHO_TOOLS.create);

  it("so leads can be off while deals still go", () => {
    if (!create) throw new Error("no create tool");
    const matrix = { ...DEFAULT_PERMISSIONS, entities: { lead: { create: "off" as const } } };
    expect(connectionLevel(zoho, create, matrix, { module: "Leads", fields: {} })).toBe("off");
    expect(connectionLevel(zoho, create, matrix, { module: "Deals", fields: {} })).toBe("approval");
  });
});

describe("applyMatrixChange with entities", () => {
  const current: PermissionMatrix = {
    ...DEFAULT_PERMISSIONS,
    entities: { bill: { create: "off" }, invoice: { scope: { update: "notes_only" } } },
  };

  it("keeps entity levels when the old editor sends verb levels only", () => {
    const r = applyMatrixChange({ current, proposed: { update: "off" }, by: "client", declared });
    expect(r.ok && r.matrix.entities).toEqual(current.entities);
  });

  it("lets a client tighten an entity", () => {
    const r = applyMatrixChange({
      current,
      proposed: { entities: { ...current.entities, item: { update: "off" } } },
      by: "client",
      declared,
    });
    expect(r.ok).toBe(true);
    expect(r.ok && r.changed).toBe(true);
    expect(r.ok && r.matrix.entities?.item).toEqual({ update: "off" });
  });

  it("refuses a client loosening an entity: an entry raised or dropped, a scope dropped", () => {
    for (const entities of [
      { bill: { create: "approval" as const }, invoice: current.entities?.invoice ?? {} },
      { invoice: current.entities?.invoice ?? {} },
      { bill: { create: "off" as const } },
      {},
    ]) {
      const r = applyMatrixChange({ current, proposed: { entities }, by: "client", declared });
      expect(r.ok, JSON.stringify(entities)).toBe(false);
      expect(!r.ok && r.reason).toBe("loosening");
    }
    // The operator may.
    const op = applyMatrixChange({ current, proposed: { entities: {} }, by: "operator", declared });
    expect(op.ok && op.change.loosenedEntities).toEqual(["bill.create", "invoice.update scope"]);
  });

  it("refuses entities the connector doesn't have, and an entity delete that isn't off", () => {
    const unknown = applyMatrixChange({
      current,
      proposed: { entities: { truck: { read: "off" } } },
      by: "operator",
      declared,
    });
    expect(!unknown.ok && unknown.reason).toBe("invalid_entities");
    const del = applyMatrixChange({
      current,
      proposed: { entities: { bill: { delete: "auto" } } },
      by: "operator",
      declared,
    });
    expect(!del.ok && del.reason).toBe("delete_not_off");
  });

  it("an old matrix (no entities) stays one", () => {
    expect(normalizeMatrix({ update: "off" })).toEqual({ ...DEFAULT_PERMISSIONS, update: "off" });
    const r = applyMatrixChange({ current: undefined, proposed: { update: "off" }, by: "client" });
    expect(r.ok && "entities" in r.matrix).toBe(false);
  });
});

describe("default access for new clients", () => {
  it("is the operator's when set and valid, else the connector's", () => {
    const operator: PermissionMatrix = {
      ...DEFAULT_PERMISSIONS,
      entities: { customer: { read: "off" } },
    };
    expect(connectionDefaults(qbo, operator)).toEqual(operator);
    expect(connectionDefaults(qbo, null)).toEqual(DEFAULT_PERMISSIONS);
    // Never looser than the platform's defaults; entities the connector's own.
    expect(defaultAccessProblems(qbo, { ...DEFAULT_PERMISSIONS, create: "auto" })).toHaveLength(1);
    expect(
      defaultAccessProblems(qbo, { ...DEFAULT_PERMISSIONS, entities: { truck: { read: "off" } } }),
    ).toEqual(["truck is not one of this connector's record types"]);
    // A default that no longer fits is passed over for the connector's.
    expect(connectionDefaults(qbo, { ...DEFAULT_PERMISSIONS, create: "auto" })).toEqual(
      DEFAULT_PERMISSIONS,
    );
  });
});
