// v0.14 W4-A (docs/plan.md §1.57): one tool id from two connectors. `whatsapp.send`,
// `messages.search` and `message.get` come from Twilio and from Meta; a workflow names the id, and
// the agent's binding decides which connector answers it (its channel where both are bound). The
// shared id is registered once; publishing checks the bound connector's spec; a call that can't be
// told apart is refused, never sent through a default.

import {
  ConnectorRegistry,
  createTwilioConnector,
  createWhatsappMetaConnector,
  defineConnector,
  defineReadTool,
} from "@countersign/connectors";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "./tools";

const META = { appId: "1", appSecret: "s", configId: "2", verifyToken: "v" };
const tools = () =>
  new ToolRegistry({
    connectors: new ConnectorRegistry([createTwilioConnector(), createWhatsappMetaConnector(META)]),
  });
const send = { to: "+15555550100", text: "hi" };
const id = (r: ReturnType<ToolRegistry["resolve"]>) =>
  "refused" in r ? r.refused : r.kind === "connector" ? r.connector.manifest.id : "internal";

describe("shared tool ids", () => {
  it("registers each shared id once, from both connectors", () => {
    const t = tools();
    expect(t.list().filter((x) => x.spec.id === "whatsapp.send")).toHaveLength(1);
    expect(t.providers("whatsapp.send").map((c) => c.manifest.id)).toEqual([
      "twilio",
      "whatsapp_meta",
    ]);
    expect(t.providers("sms.send").map((c) => c.manifest.id)).toEqual(["twilio"]);
  });

  it("resolves by the agent's binding, so the same workflow runs on either", () => {
    const t = tools();
    expect(id(t.resolve("whatsapp.send", { bindings: { twilio: "c-tw" } }, send))).toBe("twilio");
    expect(id(t.resolve("whatsapp.send", { bindings: { whatsapp_meta: "c-meta" } }, send))).toBe(
      "whatsapp_meta",
    );
    expect(id(t.resolve("whatsapp.send", { bindings: { testkit: "x" } }, send))).toBe(
      "no twilio or whatsapp_meta connection is bound",
    );
    // sms.send is Twilio's alone, as before.
    expect(id(t.resolve("sms.send", { bindings: {} }, send))).toBe("twilio");
  });

  it("with both bound, the agent's WhatsApp channel decides, and nothing is guessed", () => {
    const t = tools();
    const bindings = { twilio: "c-tw", whatsapp_meta: "c-meta" };
    expect(
      id(t.resolve("whatsapp.send", { bindings, channels: { whatsapp: "c-meta" } }, send)),
    ).toBe("whatsapp_meta");
    expect(id(t.resolve("whatsapp.send", { bindings, channels: { whatsapp: "c-tw" } }, send))).toBe(
      "twilio",
    );
    expect(id(t.resolve("whatsapp.send", { bindings }, send))).toContain(
      "set the agent's whatsapp channel",
    );
    // A message id names its provider; texts are Twilio's.
    expect(id(t.resolve("message.get", { bindings }, { sid: "wamid.ABC" }))).toBe("whatsapp_meta");
    expect(id(t.resolve("message.get", { bindings }, { sid: `SM${"a".repeat(32)}` }))).toBe(
      "twilio",
    );
    expect(id(t.resolve("messages.search", { bindings }, { channel: "sms" }))).toBe("twilio");
  });

  it("checks a client agent's shared ids against the connector it is bound to", () => {
    const t = tools();
    expect(t.specs({ whatsapp_meta: "c" })["whatsapp.send"]?.connector).toBe("whatsapp_meta");
    expect(t.specs({ twilio: "c" })["whatsapp.send"]?.connector).toBe("twilio");
    expect(t.specs()["whatsapp.send"]?.connector).toBe("twilio");
    expect(t.connectorFor("whatsapp.send", { whatsapp_meta: "c" })).toBe("whatsapp_meta");
    expect(t.connectorFor("whatsapp.send")).toBe("twilio");
  });

  it("still refuses an id two connectors register outside a shared namespace or with other shapes", () => {
    const other = (cid: string, output: z.ZodType) =>
      defineConnector({
        id: cid,
        name: cid,
        description: cid,
        icon: "message",
        auth: "none",
        entities: [],
        sharedNamespaces: ["messages"],
        tools: [
          defineReadTool({
            id: "messages.search",
            description: "search",
            input: z.object({}),
            output,
            run: async () => ({}),
          }),
        ],
      });
    expect(
      () =>
        new ConnectorRegistry([
          createTwilioConnector(),
          other("lookalike", z.object({ x: z.string() })),
        ]),
    ).toThrow("already registered");
  });
});
