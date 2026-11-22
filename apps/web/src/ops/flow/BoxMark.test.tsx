// What a step is, at a glance (./BoxMark): a connector's own mark on a read or a write, "AI" or
// the gear on a skill, a person's icon in copper, and the key that says what each one means.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  BoxMark,
  badgeWord,
  boxDoer,
  boxFamily,
  boxMark,
  boxTools,
  chartKey,
  modelShort,
} from "./BoxMark";
import type { Step } from "./types";

const step = (kind: string, over: Record<string, unknown> = {}) =>
  ({ id: "s", name: "A step", kind, ...over }) as unknown as Step;
const QBO = { id: "qbo", name: "QuickBooks Online" };

describe("boxMark", () => {
  it("shows the connector a read or a write is on, with what it does there", () => {
    expect(boxMark(step("read", { tool: "qbo.bill.query" }), { connector: QBO })).toEqual({
      type: "connector",
      id: "qbo",
      name: "QuickBooks Online",
      words: "Reads from QuickBooks Online",
    });
    expect(boxMark(step("write", { tool: "qbo.bill.create" }), { connector: QBO })).toMatchObject({
      type: "connector",
      words: "Changes QuickBooks Online",
    });
  });

  it("says AI for a skill a model does, and shows the gear for one that runs by rules", () => {
    expect(boxMark(step("skill"), { skillKind: "AI" })).toMatchObject({ type: "ai" });
    expect(boxMark(step("skill"), { skillKind: "Deterministic" })).toMatchObject({
      type: "icon",
      icon: "settings",
    });
    // A read whose tool calls a model inside, on no connector, says so too.
    expect(boxMark(step("read"), { skillKind: "AI" })).toMatchObject({ type: "ai" });
  });

  it("puts AI on a connector's logo when its tool calls a model, and an agent's avatar on a hand-off", () => {
    expect(
      boxMark(step("read", { tool: "qbo.bill.query" }), { connector: QBO, skillKind: "AI" }),
    ).toMatchObject({
      type: "connector",
      ai: true,
      words: "Reads from QuickBooks Online, with a model",
    });
    expect(boxMark(step("handoff"), { agent: { name: "Price checker" } })).toEqual({
      type: "agent",
      name: "Price checker",
      words: "Hands off to Price checker",
    });
    // A hand-off with no agent chosen yet keeps the arrow.
    expect(boxMark(step("handoff"))).toMatchObject({ icon: "arrow" });
  });

  it("gives every other kind its icon, a person's in copper, and none to a decision or a Stop", () => {
    expect(boxMark(step("person"))).toMatchObject({ icon: "lead", person: true });
    expect(boxMark(step("conversation"))).toMatchObject({ icon: "message", person: true });
    expect(boxMark(step("notify"))).toMatchObject({ icon: "notifications", person: false });
    expect(boxMark(step("read"))).toMatchObject({ icon: "search" });
    expect(boxMark(step("write"))).toMatchObject({ icon: "table" });
    expect(boxMark(step("missing"))).toMatchObject({ icon: "alert" });
    for (const kind of ["wait", "for_each", "repeat", "process", "handoff"]) {
      expect(boxMark(step(kind)), kind).not.toBeNull();
    }
    expect(boxMark(step("if"))).toBeNull();
    expect(boxMark(step("stop"))).toBeNull();
  });
});

describe("BoxMark", () => {
  it("draws the connector's own mark, AI as a word, and a person's icon in copper", () => {
    const qbo = boxMark(step("read"), { connector: QBO });
    const ai = boxMark(step("skill"), { skillKind: "AI" });
    const person = boxMark(step("person"));
    if (!qbo || !ai || !person) throw new Error("no mark");
    render(
      <>
        <BoxMark mark={qbo} testId="m-qbo" />
        <BoxMark mark={ai} testId="m-ai" />
        <BoxMark mark={person} testId="m-person" />
      </>,
    );
    expect(screen.getByTestId("m-qbo")).toHaveAttribute("data-connector", "qbo");
    expect(screen.getByTestId("m-qbo").querySelector('[data-mark="logo"]')).not.toBeNull();
    expect(screen.getByTestId("m-qbo")).toHaveAttribute("title", "Reads from QuickBooks Online");
    expect(screen.getByTestId("m-ai")).toHaveTextContent(/^AI$/);
    expect(screen.getByTestId("m-person")).toHaveClass("flow-box__mark--person");
  });
});

describe("chartKey", () => {
  it("has one line per kind of mark on the chart, every connector under one", () => {
    const marks = [
      boxMark(step("read"), { connector: QBO }),
      boxMark(step("write"), { connector: { id: "gmail", name: "Gmail" } }),
      boxMark(step("skill"), { skillKind: "AI" }),
      boxMark(step("skill"), { skillKind: "Deterministic" }),
      boxMark(step("person")),
      boxMark(step("person")),
    ].flatMap((m) => (m ? [m] : []));
    expect(chartKey(marks).map((l) => [l.key, l.words])).toEqual([
      ["connector", "Reads from or changes a connected tool"],
      ["ai", "A model does it"],
      ["settings", "Runs by rules, no model"],
      ["lead", "A person does this"],
    ]);
  });
});

// D2 (owner, 2026-11-21, "let's go with D2"; docs/plan.md §1.178): the colour of whose work a
// step is, who does it, and what it works through.
describe("a box's family, doer and tools", () => {
  it("sorts every kind into whose work it is", () => {
    expect(boxFamily(step("skill"), { skillKind: "AI" })).toBe("agent");
    expect(boxFamily(step("skill"), { skillKind: "Deterministic" })).toBe("rules");
    expect(boxFamily(step("read"))).toBe("read");
    // A write is a write, whoever does it: the edge says a client's tool changes.
    expect(boxFamily(step("write"), { skillKind: "AI" })).toBe("write");
    for (const kind of ["person", "conversation", "notify"]) {
      expect(boxFamily(step(kind))).toBe("people");
    }
    for (const kind of ["wait", "for_each", "repeat", "process", "handoff", "missing"]) {
      expect(boxFamily(step(kind))).toBe("flow");
    }
  });

  it("names the model in a word, else code or a person, and nothing for plumbing", () => {
    expect(modelShort("claude-sonnet-5-5")).toBe("Sonnet");
    expect(modelShort("claude-haiku-5-5")).toBe("Haiku");
    expect(modelShort("openai:gpt-5")).toBe("GPT");
    expect(modelShort("some-model")).toBe("some-model");
    expect(boxDoer(step("skill"), { model: "claude-sonnet-5-5", skillKind: "AI" })).toEqual({
      word: "Sonnet",
      title: "Runs on claude-sonnet-5-5",
      model: true,
    });
    expect(boxDoer(step("skill"), { skillKind: "Deterministic" })?.word).toBe("code");
    expect(boxDoer(step("read"))?.word).toBe("code");
    expect(boxDoer(step("person"))?.word).toBe("person");
    // A model does it but we don't know which: no chip, never "code".
    expect(boxDoer(step("skill"), { skillKind: "AI" })).toBeNull();
    expect(boxDoer(step("wait"))).toBeNull();
    expect(boxDoer(step("notify"))).toBeNull();
  });

  it("lists what a step works through: its connector, or its channel", () => {
    expect(boxTools(step("write"), { connector: QBO })).toEqual([
      { key: "qbo", name: "QuickBooks Online", connector: "qbo" },
    ]);
    expect(boxTools(step("read"))).toEqual([]);
    expect(boxTools(step("conversation", { channel: "whatsapp" }))).toEqual([
      { key: "whatsapp", name: "WhatsApp", connector: "whatsapp_meta" },
    ]);
    expect(boxTools(step("conversation", { channel: "call" }))[0]?.icon).toBe("phone");
    expect(boxTools(step("person", { channel: "inbox" }))[0]?.icon).toBe("desk");
    expect(boxTools(step("wait"))).toEqual([]);
  });

  it("keeps the badge to a word or two", () => {
    expect(badgeWord(step("write"), { kind: "Change in QuickBooks Online" })).toBe("Change");
    expect(badgeWord(step("write"), { kind: "Save to records" })).toBe("Save");
    expect(badgeWord(step("skill"), { kind: "Skill · AI", skillKind: "AI" })).toBe("AI skill");
    expect(
      badgeWord(step("skill"), { kind: "Skill · Deterministic", skillKind: "Deterministic" }),
    ).toBe("Rules skill");
    expect(badgeWord(step("person"), { kind: "Person" })).toBe("Person");
  });
});
