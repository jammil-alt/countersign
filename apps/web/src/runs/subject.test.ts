// How runs are named on both sides (by what they are about), raw ids in plain words, money with its
// currency, and the back office's one reading of what a run waits on.
import { describe, expect, it } from "vitest";
import { createI18n } from "../i18n/i18n";
import { runWaiting } from "../ops/run/waiting";
import { money } from "./format";
import { eventLabel, qualifiedToolLabel } from "./labels";
import { opsRunTitle, subjectTitle } from "./subject";

describe("run titles", () => {
  const doc = {
    kind: "document" as const,
    vendor: "Northline Panel Supply",
    number: "20418",
    filename: "northline-20418.pdf",
  };

  it("name the invoice that started the run, in the reader's language", () => {
    expect(subjectTitle(doc)).toBe("Northline Panel Supply · Invoice 20418");
    expect(subjectTitle(doc, createI18n("es"))).toBe("Northline Panel Supply · Factura 20418");
    expect(subjectTitle({ ...doc, vendor: null, number: null })).toBe("northline-20418.pdf");
  });

  it("else the run's first change, as its card heads it", () => {
    const change = {
      kind: "change" as const,
      name: { en: "QuickBooks bill", es: "Factura de QuickBooks" },
      number: "20418",
      with: "Northline Panel Supply",
    };
    expect(subjectTitle(change)).toBe("QuickBooks bill 20418 · Northline Panel Supply");
    expect(subjectTitle(change, createI18n("es"))).toBe(
      "Factura de QuickBooks 20418 · Northline Panel Supply",
    );
  });

  it("else, in the back office, the trigger in plain words", () => {
    const trigger = { kind: "trigger" as const, startedBy: "event" as const, event: null };
    expect(subjectTitle(trigger)).toBeNull();
    expect(opsRunTitle({ ...trigger, event: "document.extracted" })).toBe(
      "When a document has been read",
    );
    expect(opsRunTitle({ ...trigger, startedBy: "schedule" })).toBe("Scheduled run");
    expect(opsRunTitle(undefined, "Fix a record")).toBe("Fix a record");
  });
});

describe("plain names for ids", () => {
  it("never show an event, tool or skill id as it is", () => {
    expect(eventLabel("document.extracted")).toBe("a document has been read");
    expect(eventLabel("bill.created")).toBe("bill created");
    expect(qualifiedToolLabel("qbo.bill.update_lines")).toBe("QuickBooks · Itemize a bill");
    expect(qualifiedToolLabel("docs.match-bill")).toBe("Documents · Match bill");
    expect(qualifiedToolLabel("testkit.record.update", "Testkit")).toBe(
      "Testkit · Update a record",
    );
  });

  it("formats money with its currency, from the decimal string", () => {
    expect(money("9742.3500", "USD")).toBe("$9,742.35");
    expect(money("9742.3500", "EUR", createI18n("de"))).toMatch(/9\.742,35/);
  });
});

describe("what a run waits on", () => {
  const item = (over: Record<string, unknown> = {}) => ({
    id: "i1",
    kind: "external_action",
    status: "open",
    assigneeRole: "client_admin",
    assigneeUserId: null,
    createdAt: "2026-11-05T07:00:00.000Z",
    resolvableByOperator: false,
    ...over,
  });

  it("says on whom, since when and for how long, in one line every place uses", () => {
    const wait = runWaiting([item()], new Date("2026-11-06T22:00:00.000Z"));
    expect(wait).toMatchObject({
      line: "Waiting for approval · client admin",
      since: "2026-11-05T07:00:00.000Z",
      waited: "39 h",
      mine: false,
    });
  });

  it("puts the operator's own item first, and questions as waiting for an answer", () => {
    const wait = runWaiting([
      item({ id: "old" }),
      item({
        id: "ours",
        kind: "request",
        createdAt: "2026-11-05T08:00:00.000Z",
        resolvableByOperator: true,
      }),
    ]);
    expect(wait?.item.id).toBe("ours");
    expect(wait?.line).toBe("Waiting for an answer · you");
    expect(wait?.since).toBe("2026-11-05T07:00:00.000Z");
    expect(runWaiting([item({ status: "resolved" })])).toBeNull();
    expect(runWaiting([item({ assigneeRole: "client_user" })])?.who).toBe("client's team");
  });
});
