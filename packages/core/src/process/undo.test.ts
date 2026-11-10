import { describe, expect, it } from "vitest";
import { tools } from "../testing/fixtures";
import { canUndo, describeUndo, type UndoSpec, undoOf } from "./undo";

const restore: UndoSpec = {
  id: "testkit.record.update",
  sideEffect: "external",
  verb: "update",
  undo: { kind: "restore" },
};
const send: UndoSpec = {
  id: "gmail.send",
  sideEffect: "external",
  verb: "create",
  undo: { kind: "none" },
};
const reverse: UndoSpec = {
  id: "qbo.bill.create",
  sideEffect: "external",
  verb: "create",
  undo: { kind: "reverse", tool: "qbo.bill.void" },
};
const read: UndoSpec = { id: "qbo.bill.query", sideEffect: "none", verb: "read" };

const before = { id: "R-1", amount: "64.0000", syncToken: "0" };
const after = { id: "R-1", amount: "70.0000", syncToken: "1" };

describe("undoOf", () => {
  it("treats a write that says nothing as final, and a read as no write", () => {
    expect(undoOf({ sideEffect: "external" })).toEqual({ kind: "none" });
    expect(undoOf(restore)).toEqual({ kind: "restore" });
    expect(undoOf(read)).toBeNull();
    expect(undoOf({ sideEffect: "internal" })).toBeNull();
  });
});

describe("canUndo", () => {
  it("restores an update nobody touched since", () => {
    expect(canUndo(restore, before, after, after)).toEqual({ ok: true });
  });

  it("compares states by canonical JSON, not key order", () => {
    const reordered = { syncToken: "1", amount: "70.0000", id: "R-1", gone: undefined };
    expect(canUndo(restore, before, reordered, after)).toEqual({ ok: true });
  });

  it("refuses when the record changed since our write", () => {
    const changed = { ...after, amount: "71.0000", syncToken: "2" };
    expect(canUndo(restore, before, changed, after)).toMatchObject({
      ok: false,
      code: "changed_since",
    });
    // Only the version stamp moved: still someone else's write.
    expect(canUndo(restore, before, { ...after, syncToken: "2" }, after)).toMatchObject({
      ok: false,
      code: "changed_since",
    });
  });

  it("refuses without the record as our write left it", () => {
    expect(canUndo(restore, before, after)).toMatchObject({ ok: false, code: "after_unknown" });
  });

  it("refuses when the record is gone or there was nothing before", () => {
    expect(canUndo(restore, before, null, after)).toMatchObject({
      ok: false,
      code: "record_gone",
    });
    expect(canUndo(restore, null, after, after)).toMatchObject({
      ok: false,
      code: "nothing_before",
    });
  });

  it("refuses when the record already holds what was there before", () => {
    expect(canUndo(restore, before, before, before)).toMatchObject({
      ok: false,
      code: "already_undone",
    });
  });

  it("never undoes a send, a write that says nothing, or a read", () => {
    expect(canUndo(send, null, after, after)).toMatchObject({ ok: false, code: "cannot_undo" });
    const silent: UndoSpec = { ...restore, undo: undefined };
    const r = canUndo(silent, before, after, after);
    expect(r).toMatchObject({ ok: false, code: "cannot_undo" });
    expect(r.ok === false && r.reason).toContain("doesn't say");
    expect(canUndo(read, null, after, after)).toMatchObject({ ok: false, code: "not_a_write" });
  });

  it("reverses a create (no before state) that nobody touched since", () => {
    const created = { id: "B-9", syncToken: "0" };
    expect(canUndo(reverse, null, created, created)).toEqual({ ok: true });
    expect(canUndo(reverse, null, { ...created, syncToken: "1" }, created)).toMatchObject({
      ok: false,
      code: "changed_since",
    });
    expect(canUndo(reverse, null, null, created)).toMatchObject({
      ok: false,
      code: "record_gone",
    });
  });
});

describe("describeUndo", () => {
  it("warns that a send can't be taken back", () => {
    expect(describeUndo(send)).toEqual({
      kind: "none",
      undoable: false,
      tool: null,
      text: "Can't be taken back once it's done.",
      warning: "If nobody answers, this sends and can't be taken back.",
    });
  });

  it("words posts, publishes, calls and other final writes", () => {
    const w = (id: string) => describeUndo({ ...send, id })?.warning;
    expect(w("slack.message.post")).toBe("If nobody answers, this posts and can't be taken back.");
    expect(w("website.publish")).toBe("If nobody answers, this publishes and can't be taken back.");
    expect(w("call.place")).toBe(
      "If nobody answers, this places the call and can't be taken back.",
    );
    expect(w("hubspot.record.create")).toBe(
      "If nobody answers, this goes ahead and can't be taken back.",
    );
    expect(describeUndo({ ...restore, undo: undefined })?.kind).toBe("none");
  });

  it("gives no warning for writes that can be taken back, and nothing for reads", () => {
    expect(describeUndo(restore)).toMatchObject({ undoable: true, tool: null, warning: null });
    expect(
      describeUndo({ ...restore, undo: { kind: "restore", tool: "x.record.set" } }),
    ).toMatchObject({ tool: "x.record.set" });
    expect(describeUndo(reverse)).toMatchObject({
      kind: "reverse",
      undoable: true,
      tool: "qbo.bill.void",
      warning: null,
    });
    expect(describeUndo(read)).toBeNull();
    const q = tools["qbo.bill.query"];
    if (q) expect(describeUndo(q)).toBeNull();
  });
});
