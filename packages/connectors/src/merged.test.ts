// The three merges (docs/step-model-plan.md §10c) against the real connectors: every tool a merged
// action names exists and is the same kind of call, and the action's input and output, mapped, fit
// each tool's own, so a template works for any client.
import { steps } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { createExcelConnector } from "./excel/index";
import { createGchatConnector } from "./gchat/index";
import { createGmailConnector } from "./gmail/index";
import { createGsheetsConnector } from "./gsheets/index";
import { MAPPED_MERGED_ACTIONS, mergedOutput, resolveMergedCall } from "./merged";
import { createOutlookConnector } from "./outlook/index";
import { createResendConnector } from "./resend/index";
import { createSlackConnector } from "./slack/index";
import { createTeamsConnector } from "./teams/index";

const connectors = [
  createResendConnector(),
  createGmailConnector(),
  createOutlookConnector(),
  createSlackConnector(),
  createTeamsConnector(),
  createGchatConnector(),
  createGsheetsConnector(),
  createExcelConnector(),
];
const specOf = (connector: string, tool: string) =>
  connectors.find((c) => c.manifest.id === connector)?.manifest.tools.find((t) => t.id === tool);
const props = (schema: unknown) =>
  Object.keys(((schema ?? {}) as { properties?: object }).properties ?? {});
const required = (schema: unknown) => ((schema ?? {}) as { required?: string[] }).required ?? [];

describe("merged connectors", () => {
  it("no merged action id is also a tool's (Resend's own tool was renamed)", () => {
    const toolIds = new Set(connectors.flatMap((c) => c.manifest.tools.map((t) => t.id)));
    for (const c of steps.MERGED_CONNECTORS) {
      for (const a of c.actions) {
        if (c.id !== "accounting") expect(toolIds.has(a.id), a.id).toBe(false);
      }
    }
    expect(toolIds.has("resend.send")).toBe(true);
  });

  for (const merged of steps.MERGED_CONNECTORS.filter((c) => c.id !== "accounting")) {
    for (const action of merged.actions) {
      it(`${action.id}: every connector's tool exists and is the same kind of call`, () => {
        const specs = Object.entries(action.tools).map(([connector, tool]) => {
          const spec = specOf(connector, tool);
          expect(spec, `${connector} ${tool}`).toBeDefined();
          return spec;
        });
        const kinds = new Set(specs.map((s) => s && steps.actionKind(s)));
        expect(kinds.size, JSON.stringify([...kinds])).toBe(1);
      });
    }
  }

  for (const id of MAPPED_MERGED_ACTIONS) {
    it(`${id}: the action's input fits each connector's tool once mapped`, () => {
      const action = steps.mergedAction(id);
      if (!action) throw new Error(id);
      const [firstConnector, firstTool] = Object.entries(action.tools)[0] ?? [];
      const first = specOf(firstConnector ?? "", firstTool ?? "");
      // A full input of the action's own fields.
      const input = Object.fromEntries(props(first?.input).map((k) => [k, k]));
      for (const [connector, tool] of Object.entries(action.tools)) {
        const spec = specOf(connector, tool);
        const resolved = resolveMergedCall(id, [connector], input);
        expect(resolved).toMatchObject({ connector, tool });
        const keys = Object.keys(resolved?.input as object);
        // Every key the tool takes that is in the action's input, and no key it doesn't know.
        for (const k of keys) expect(props(spec?.input), `${connector} ${k}`).toContain(k);
        // Every field the tool requires is given.
        for (const k of required(spec?.input))
          expect(keys, `${connector} requires ${k}`).toContain(k);
      }
    });
  }

  it("takes the first of the merge's connectors the client has, in the merge's order", () => {
    expect(resolveMergedCall("email.send", ["gmail", "resend"], {})?.tool).toBe("resend.send");
    expect(resolveMergedCall("email.send", ["outlook"], {})?.tool).toBe("outlook.send");
    expect(resolveMergedCall("email.send", ["qbo"], {})).toBeUndefined();
    expect(resolveMergedCall("nope", ["gmail"], {})).toBeUndefined();
  });

  it("maps Google Chat's space and Excel's workbook onto the action's words, and back", () => {
    expect(
      resolveMergedCall("teamchat.message.post", ["gchat"], { channel: "spaces/AAA", text: "hi" }),
    ).toEqual({
      connector: "gchat",
      tool: "gchat.message.post",
      input: { space: "spaces/AAA", text: "hi" },
    });
    expect(
      resolveMergedCall("spreadsheet.rows.append", ["excel"], { spreadsheetId: "w1", rows: [[1]] })
        ?.input,
    ).toEqual({ workbookId: "w1", rows: [[1]] });
    expect(
      mergedOutput("teamchat.message.post", "gchat", {
        name: "spaces/AAA/messages/1",
        space: "spaces/AAA",
        spaceLabel: "Ops",
        messageId: "client-1",
        createTime: "2026-11-25T10:00:00Z",
        text: "hi",
      }),
    ).toMatchObject({ channel: "spaces/AAA", channelName: "Ops", ts: "2026-11-25T10:00:00Z" });
    expect(
      mergedOutput("spreadsheet.range.read", "excel", {
        workbookId: "w1",
        workbook: "Budget",
        sheet: "Sheet1",
        range: "A1:B2",
        values: [],
        truncated: false,
      }),
    ).toMatchObject({ spreadsheetId: "w1", spreadsheet: "Budget" });
    // Slack and Google Sheets are the action's own shape.
    const out = { channel: "C1", channelName: "orders", ts: "1", workspace: "W" };
    expect(mergedOutput("teamchat.message.post", "slack", out)).toBe(out);
  });
});
