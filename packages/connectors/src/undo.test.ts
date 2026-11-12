// R5 (docs/plan.md §1.86, §9): every write tool a connector registers says how it is taken back,
// and an undo names only a write of the same connector, never a delete.
import { processes, type ToolUndo } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createBankfeedConnector } from "./bankfeed/index";
import { createBillcomConnector } from "./billcom/index";
import { createBingWebmasterConnector } from "./bing_webmaster/index";
import { createBrowserConnector } from "./browser/index";
import {
  type Connector,
  ConnectorDefinitionError,
  defineConnector,
  defineWriteTool,
  undoProblems,
} from "./connector";
import { createGchatConnector } from "./gchat/index";
import { createGdriveConnector } from "./gdrive/index";
import { createGmailConnector } from "./gmail/index";
import { createGscConnector } from "./gsc/index";
import { createGscOauthConnector } from "./gsc/oauth";
import { createGsheetsConnector } from "./gsheets/index";
import { createHackerNewsConnector } from "./hackernews/index";
import { createHubspotConnector } from "./hubspot/index";
import { createLinkedInConnector } from "./linkedin/index";
import { createOdooConnector } from "./odoo/index";
import { createOutlookConnector } from "./outlook/index";
import { createPodioConnector } from "./podio/index";
import { createQboConnector } from "./qbo/index";
import { createRampConnector } from "./ramp/index";
import { createResendConnector } from "./resend/index";
import { createSlackConnector } from "./slack/index";
import { createTestkitConnector } from "./testkit/index";
import { createTwilioConnector } from "./twilio/index";
import { createUploadConnector } from "./upload/index";
import { createWebhookConnector } from "./webhook/index";
import { createWebsiteConnector } from "./website/index";
import { createWhatsappMetaConnector } from "./whatsapp_meta/index";
import { createZohoCrmConnector } from "./zoho_crm/index";

// Every connector apps/api registers (apps/api/src/platform.ts), testkit included.
const ALL: Connector[] = [
  createUploadConnector(),
  createQboConnector(),
  createWebhookConnector(),
  createWebsiteConnector(),
  createZohoCrmConnector(),
  createPodioConnector(),
  createTwilioConnector(),
  createGmailConnector(),
  createGdriveConnector(),
  createGsheetsConnector(),
  createOutlookConnector(),
  createGchatConnector(),
  createSlackConnector(),
  createWhatsappMetaConnector(),
  createResendConnector(),
  createRampConnector(),
  createHubspotConnector(),
  createBankfeedConnector(),
  createBrowserConnector(),
  createGscConnector(),
  createGscOauthConnector(),
  createBingWebmasterConnector(),
  createHackerNewsConnector(),
  createLinkedInConnector(),
  // §1.87
  createBillcomConnector(),
  // Odoo: CRM, sales, purchasing, invoicing and inventory.
  createOdooConnector(),
  createTestkitConnector(),
];

const writes = ALL.flatMap((c) =>
  c.manifest.tools.filter((t) => t.sideEffect === "external").map((t) => [t.id, t] as const),
);
const undoOf = (id: string) => writes.find(([w]) => w === id)?.[1].undo;

describe("undo on connector writes", () => {
  it("covers every write tool", () => {
    expect(writes.length).toBeGreaterThan(40);
  });

  it.each(writes)("%s declares its undo", (_id, tool) => {
    expect(tool.undo, `${tool.id} declares no undo`).toBeDefined();
    if (tool.undo?.kind === "restore") expect(tool.verb).toBe("update");
  });

  it("names only writes of its own connector, never a delete", () => {
    for (const c of ALL) expect(undoProblems(c.manifest.tools), c.manifest.id).toEqual([]);
  });

  it("says sends, posts and calls can't be taken back", () => {
    for (const id of [
      "gmail.send",
      "outlook.send",
      "email.send",
      "sms.send",
      "whatsapp.send",
      "call.place",
      "call.answer",
      "slack.message.post",
      "gchat.message.post",
      "linkedin.post",
      "webhook.event.send",
      "website.publish",
    ]) {
      expect(undoOf(id), id).toEqual({ kind: "none" });
    }
  });

  it("restores updates that keep a before state", () => {
    for (const id of [
      "qbo.bill.update_lines",
      "qbo.purchase.update_lines",
      "qbo.bill.update_memo",
      "qbo.purchase.update_memo",
      "qbo.item.update_purchase_cost",
      "qbo.account.update",
      "qbo.class.update",
      "qbo.location.update",
      "hubspot.record.update",
      "zoho_crm.record.update",
      "podio.item.update",
      "sheets.range.update",
      "website.meta",
      "testkit.record.update",
      "billcom.vendor.update",
      "billcom.bill.update",
      "odoo.record.update",
    ]) {
      expect(undoOf(id), id).toEqual({ kind: "restore" });
    }
  });

  it("reverses QuickBooks names by making them inactive; other creates are final for now", () => {
    expect(undoOf("qbo.account.create")).toEqual({ kind: "reverse", tool: "qbo.account.update" });
    expect(undoOf("qbo.class.create")).toEqual({ kind: "reverse", tool: "qbo.class.update" });
    expect(undoOf("qbo.location.create")).toEqual({
      kind: "reverse",
      tool: "qbo.location.update",
    });
    for (const id of ["qbo.bill.create", "qbo.vendor.create", "qbo.purchaseorder.create"]) {
      expect(undoOf(id), id).toEqual({ kind: "none" });
    }
    // §1.87: a BILL bill is taken back by archiving it, BILL's own void.
    expect(undoOf("billcom.bill.create")).toEqual({
      kind: "reverse",
      tool: "billcom.bill.archive",
    });
  });

  it("gives the builder its warning for every write that can't be taken back", () => {
    for (const [id, tool] of writes) {
      const d = processes.describeUndo(tool);
      expect(d, id).not.toBeNull();
      expect(d?.warning === null, id).toBe(d?.undoable);
    }
    const gmail = writes.find(([id]) => id === "gmail.send")?.[1];
    expect(gmail && processes.describeUndo(gmail)?.warning).toBe(
      "If nobody answers, this sends and can't be taken back.",
    );
  });
});

describe("defineConnector checks an undo", () => {
  const write = (id: string, verb: "create" | "update" | "delete", undo?: unknown) =>
    defineWriteTool({
      id,
      description: id,
      verb,
      ...(undo === undefined ? {} : { undo: undo as ToolUndo }),
      input: z.object({}),
      output: z.object({}),
      beforeSchema: z.object({}),
      before: async () => null,
      run: async () => ({}),
    });
  const define = (tools: ReturnType<typeof write>[]) =>
    defineConnector({
      id: "undoc",
      name: "Undo check",
      description: "",
      icon: "plug",
      auth: "none",
      entities: [],
      tools,
    });

  it("refuses an undo naming a tool it doesn't have, a delete, or a non-update restore", () => {
    expect(() =>
      define([
        write("undoc.thing.create", "create", { kind: "reverse", tool: "undoc.thing.void" }),
      ]),
    ).toThrow(ConnectorDefinitionError);
    expect(() =>
      define([
        write("undoc.thing.create", "create", { kind: "reverse", tool: "undoc.thing.delete" }),
        write("undoc.thing.delete", "delete", { kind: "none" }),
      ]),
    ).toThrow(/can't be a delete/);
    expect(() =>
      define([
        write("undoc.thing.update", "update", { kind: "restore", tool: "undoc.thing.create" }),
        write("undoc.thing.create", "create", { kind: "none" }),
      ]),
    ).toThrow(/restored with an update/);
  });

  it("accepts a reverse by a void and a restore by a named update", () => {
    expect(() =>
      define([
        write("undoc.thing.create", "create", { kind: "reverse", tool: "undoc.thing.void" }),
        write("undoc.thing.void", "update", { kind: "none" }),
        write("undoc.thing.set", "update", { kind: "restore", tool: "undoc.thing.put" }),
        write("undoc.thing.put", "update", { kind: "restore" }),
      ]),
    ).not.toThrow();
  });
});
