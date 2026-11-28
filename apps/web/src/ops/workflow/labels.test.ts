import { AgentBundle } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { FORK_BUNDLE } from "../../test/fixtures";
import { type BuilderData, paletteConnectors } from "../builder/catalog";
import { triggerDetail, triggerTitle } from "./describe";
import { cronText, eventKind, eventLabel, roleLabel, toolLabel, whenEvent } from "./labels";

describe("plain labels", () => {
  it("names events, tools and roles in words, never by id", () => {
    expect(whenEvent("document.extracted")).toBe("When a document has been read");
    expect(eventKind("document.extracted")).toBe("document");
    expect(eventKind("zoho_crm.record.changed")).toBe("record");
    // An event we have no words for reads as words, not its id.
    expect(eventLabel("acme.order.shipped")).toBe("order shipped");
    expect(eventKind("acme.order.shipped")).toBe("other");
    expect(toolLabel("qbo.bill.update_lines")).toBe("Itemize a bill");
    expect(toolLabel("acme.order.cancel")).toBe("Cancel order");
    expect(roleLabel("client_admin")).toBe("client admin");
    expect(roleLabel("0193-user")).toBe("a person");
  });

  it("reads common schedules", () => {
    expect(cronText("0 7 * * 1-5")).toBe("Weekdays at 7:00 AM");
    expect(cronText("30 18 * * *")).toBe("Every day at 6:30 PM");
    expect(cronText("0 9 * * 1")).toBe("Mondays at 9:00 AM");
    expect(cronText("*/5 * * * *")).toBe("*/5 * * * *");
  });

  it("describes triggers with labels", () => {
    const trigger = { id: "t", on: { type: "schedule" as const, cron: "0 7 * * 1-5" } };
    expect(triggerTitle(trigger)).toBe("On a schedule");
    expect(triggerDetail(trigger)).toBe("Weekdays at 7:00 AM, in the client's time zone");
  });
});

describe("the palette's connectors", () => {
  const data = {
    catalog: {
      skills: [],
      tools: [
        {
          id: "testkit.record.update",
          description: "",
          input: {},
          output: {},
          sideEffect: "external",
          verb: "update",
          source: "testkit",
          connector: "testkit",
        },
      ],
      connectors: [
        { id: "testkit", name: "Testkit", icon: null },
        { id: "qbo", name: "QuickBooks Online", icon: null },
      ],
      automations: [],
    },
    events: [],
  } as unknown as BuilderData;
  const bundle = AgentBundle.parse({ ...FORK_BUNDLE, workflows: [] });
  const client = { kind: "client" as const, testCopy: false };

  it("offers a client's connected tools, and the Testkit only in the Sandbox", () => {
    const connections = [
      { connector: "testkit", status: "connected" },
      { connector: "qbo", status: "connected" },
      { connector: "gmail", status: "disconnected" },
    ];
    const real = paletteConnectors({ agent: client, bundle, data, connections, sandbox: false });
    expect([...real].sort()).toEqual(["qbo", "upload"]);
    const sandbox = paletteConnectors({ agent: client, bundle, data, connections, sandbox: true });
    expect(sandbox.has("testkit")).toBe(true);
    const copy = paletteConnectors({
      agent: { kind: "client", testCopy: true },
      bundle,
      data,
      connections,
      sandbox: false,
    });
    expect(copy.has("testkit")).toBe(true);
  });

  it("offers a template what it uses plus what the operator adds, never the Testkit by choice", () => {
    const template = { kind: "template" as const, testCopy: false };
    const out = paletteConnectors({
      agent: template,
      bundle,
      data,
      connections: [],
      sandbox: false,
      extra: ["qbo", "testkit"],
    });
    expect([...out].sort()).toEqual(["qbo", "upload"]);
  });
});
