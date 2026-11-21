// What a step is, at a glance (./BoxMark): a connector's own mark on a read or a write, "AI" or
// the gear on a skill, a person's icon in copper, and the key that says what each one means.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BoxMark, boxMark, chartKey } from "./BoxMark";
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
