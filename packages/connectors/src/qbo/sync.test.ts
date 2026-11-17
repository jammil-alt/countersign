// QuickBooks sync on a busy company, against the fake (which, like Intuit, cuts a CDC answer off at
// 1,000 objects): attachments come a small page at a time after CDC, so new bills keep coming
// while a backlog of files catches up (audit 2.3); a CDC answer at the cap is read again entity
// by entity, by query where one entity alone reaches it, and nothing is lost (audit 2.5).

import { DEFAULT_PERMISSIONS, type JsonObject } from "@countersign/core";
import { describe, expect, it } from "vitest";
import type { RawRecordInput } from "../connector";
import { memoryCredentials } from "../credentials-accessor";
import { memoryLogger } from "../logger";
import { utf8 } from "../runtime";
import { FAKE_QBO_CLIENT, FAKE_QBO_REALM, fakeQbo } from "./fake";
import {
  createQboConnector,
  QBO_ATTACHMENT_PAGE_SIZE,
  type QboSyncCursor,
  type QboSyncPage,
  qboSyncPage,
} from "./index";

const NOW = new Date("2026-11-05T18:00:00.000Z");
const tenant = "0190f0c8-0000-7000-8000-000000000001";

async function setup(opts: { wholeSeconds?: boolean } = {}) {
  const clock = { now: NOW };
  const qbo = fakeQbo({ now: () => clock.now, ...opts });
  const connector = createQboConnector({
    ...FAKE_QBO_CLIENT,
    environment: "sandbox",
    fetch: qbo.fetch,
    sleep: async () => {},
    now: () => NOW,
  });
  const grant = await connector.handleCallback?.(
    { code: "fixture-code", realmId: FAKE_QBO_REALM, state: "x" },
    { tenantId: tenant, userId: tenant, redirectUri: "https://example.test/callback" },
  );
  if (!grant) throw new Error("no grant");
  const client = await connector.client({
    tenantId: tenant,
    connection: {
      id: tenant,
      tenantId: tenant,
      connector: "qbo",
      status: "connected",
      externalAccountId: FAKE_QBO_REALM,
      config: {},
      permissions: DEFAULT_PERMISSIONS,
    },
    credentials: memoryCredentials(grant.credentials as JsonObject),
    logger: memoryLogger(),
    now: () => NOW,
  });
  return { qbo, client, clock };
}

const key = (r: RawRecordInput) => `${r.entityType}:${r.externalId}:${r.externalVersion}`;

/** Pages until caught up; `between` runs before each page. */
async function syncAll(
  client: Awaited<ReturnType<typeof setup>>["client"],
  from: QboSyncCursor | null,
  now: Date,
  between: (i: number, pages: QboSyncPage[]) => void = () => {},
) {
  const pages: QboSyncPage[] = [];
  let cursor = from;
  for (let i = 0; i < 200; i++) {
    between(i, pages);
    // As the platform runs it: each sync's first page reads CDC.
    const page = await qboSyncPage(client, cursor, { now, cdcFirst: i === 0 });
    pages.push(page);
    cursor = page.next;
    if (page.done) return { pages, cursor };
  }
  throw new Error("the sync never caught up");
}

function bill(id: string): Record<string, unknown> & { Id: string } {
  return {
    Id: id,
    SyncToken: "0",
    TxnDate: "2026-11-04",
    VendorRef: { value: "56" },
    Line: [{ Id: "1", Amount: 10, DetailType: "AccountBasedExpenseLineDetail" }],
    TotalAmt: 10,
  };
}

describe("qbo sync: attachments (audit 2.3)", () => {
  it("reads attachments after CDC in small pages, and new bills come while they catch up", async () => {
    const { qbo, client, clock } = await setup();
    // Sixty receipts attached in October: the initial sync's history.
    clock.now = new Date("2026-10-20T12:00:00.000Z");
    for (let i = 0; i < 60; i++) {
      qbo.attachFile("Bill", "146", {
        fileName: `receipt-${i}.pdf`,
        bytes: utf8(`%PDF-1.4\n% receipt ${i}\n%%EOF\n`),
        contentType: "application/pdf",
      });
    }
    clock.now = NOW;
    const { pages } = await syncAll(client, null, NOW, (i, done) => {
      // Two attachment pages in, a new bill is entered in QuickBooks.
      if (done.filter((p) => p.records[0]?.entityType === "Attachable").length === 2 && i > 0) {
        if (!qbo.get("Bill", "147")) {
          clock.now = new Date(NOW.getTime() + 1000);
          qbo.put("Bill", bill("147"));
        }
      }
    });
    const attachmentPages = pages.filter((p) => p.records[0]?.entityType === "Attachable");
    // 62 attachments (two from the fixtures), at most 25 to a page, as history. The sixty share
    // one second, which is read again from its start, so a few come twice (stored once).
    expect(attachmentPages.length).toBeGreaterThanOrEqual(3);
    for (const p of attachmentPages) {
      expect(p.records.length).toBeLessThanOrEqual(QBO_ATTACHMENT_PAGE_SIZE);
      expect(p.records.every((r) => r.entityType === "Attachable")).toBe(true);
      expect(p.initial).toBe(true);
    }
    const attachments = attachmentPages.flatMap((p) => p.records.map(key));
    expect(new Set(attachments).size).toBe(62);
    // No page before the attachments' read has any: the initial read leaves them out.
    const firstAttachments = pages.indexOf(attachmentPages[0] as QboSyncPage);
    expect(
      pages.slice(0, firstAttachments).flatMap((p) => p.records.map((r) => r.entityType)),
    ).not.toContain("Attachable");
    // The new bill came by CDC, as news, before the last attachments.
    const billPage = pages.findIndex((p) => p.records.some((r) => key(r) === "Bill:147:0"));
    expect(billPage).toBeGreaterThan(firstAttachments);
    expect(billPage).toBeLessThan(pages.indexOf(attachmentPages.at(-1) as QboSyncPage));
    expect(pages[billPage]?.initial).toBe(false);
  });

  it("resumes after the attachments a step stored when its budget ran out", async () => {
    const { qbo, client, clock } = await setup();
    clock.now = new Date("2026-10-20T12:00:00.000Z");
    for (let i = 0; i < 10; i++) {
      qbo.attachFile("Bill", "146", {
        fileName: `receipt-${i}.pdf`,
        bytes: utf8(`%PDF-1.4\n% receipt ${i}\n%%EOF\n`),
        contentType: "application/pdf",
      });
    }
    clock.now = NOW;
    let cursor: QboSyncCursor | null = null;
    let first: QboSyncPage | null = null;
    for (let i = 0; i < 40 && !first; i++) {
      const page: QboSyncPage = await qboSyncPage(client, cursor, { now: NOW });
      if (page.records[0]?.entityType === "Attachable") first = page;
      else cursor = page.next;
    }
    if (!first?.resumeAfter) throw new Error("no attachment page");
    expect(first.records).toHaveLength(12);
    // Only the first three were stored: the rest come in the next attachment page, after CDC.
    const rest = await syncAll(client, first.resumeAfter(3), NOW);
    const next = rest.pages.flatMap((p) =>
      p.records.filter((r) => r.entityType === "Attachable").map(key),
    );
    // The second they share is read again from its start: the three stored come again (and are
    // known), and the rest follow.
    expect(next).toEqual(expect.arrayContaining(first.records.slice(3).map(key)));
    expect(new Set(next).size).toBe(next.length);
    expect(rest.pages[0]?.records.some((r) => r.entityType === "Attachable")).toBe(false);
  });

  it("goes on from a cursor stored while an initial sync read attachments with the rest", async () => {
    const { client } = await setup();
    const stored: QboSyncCursor = {
      v: 1,
      phase: "initial",
      entity: "Attachable",
      start: 2,
      sinceDate: "2026-08-07",
      changedSince: "2026-11-05T17:59:00.000Z",
    };
    const { pages, cursor } = await syncAll(client, stored, NOW);
    // CDC first, then the attachments from the second on (the fixtures have two).
    expect(pages[0]?.initial).toBe(false);
    expect(pages.flatMap((p) => p.records.map(key))).toEqual(["Attachable:5000000000000401:0"]);
    expect(cursor).toMatchObject({ phase: "cdc", ar: true, ledger: true });
  });
});

describe("qbo sync: time and ties (audit review)", () => {
  /** A caught-up connection whose last attachment, A, was read twice (CDC's overlap). */
  async function readTwice() {
    const s = await setup({ wholeSeconds: true });
    let { cursor } = await syncAll(s.client, null, NOW);
    s.clock.now = new Date("2026-11-05T18:10:00Z");
    const a = s.qbo.attachFile("Bill", "146", {
      fileName: "a.pdf",
      bytes: utf8("%PDF-1.4\n% a\n%%EOF\n"),
      contentType: "application/pdf",
    });
    ({ cursor } = await syncAll(s.client, cursor, new Date("2026-11-05T18:10:30Z")));
    ({ cursor } = await syncAll(s.client, cursor, new Date("2026-11-05T18:10:50Z")));
    // Read again, the second it ended on counts nothing into it.
    expect(cursor).toMatchObject({ attachments: { since: "2026-11-05T18:10:00Z", skip: 0 } });
    return { ...s, cursor, a };
  }
  const attachmentKeys = (pages: QboSyncPage[]) =>
    pages.flatMap((p) => p.records.filter((r) => r.entityType === "Attachable").map(key));

  it("reads a new attachment after the last one read is deleted", async () => {
    const { qbo, client, clock, cursor, a } = await readTwice();
    clock.now = new Date("2026-11-05T18:20:00Z");
    qbo.remove("Attachable", a);
    clock.now = new Date("2026-11-05T18:20:05Z");
    const b = qbo.attachFile("Bill", "146", {
      fileName: "b.pdf",
      bytes: utf8("%PDF-1.4\n% b\n%%EOF\n"),
      contentType: "application/pdf",
    });
    const { pages } = await syncAll(client, cursor, new Date("2026-11-05T18:20:30Z"));
    expect(attachmentKeys(pages)).toContain(`Attachable:${b}:0`);
    expect(pages.flatMap((p) => p.records.map(key))).toContain(`Attachable:${a}:deleted`);
  });

  it("reads an edit of the last attachment read, and a new one after it", async () => {
    const { qbo, client, clock, cursor, a } = await readTwice();
    clock.now = new Date("2026-11-05T18:20:00Z");
    const row = qbo.get("Attachable", a);
    qbo.put("Attachable", {
      ...row,
      Id: a,
      SyncToken: "1",
      AttachableRef: [{ EntityRef: { type: "Bill", value: "145" }, IncludeOnSend: false }],
    });
    const first = await syncAll(client, cursor, new Date("2026-11-05T18:20:30Z"));
    clock.now = new Date("2026-11-05T18:30:00Z");
    const b = qbo.attachFile("Bill", "146", {
      fileName: "b.pdf",
      bytes: utf8("%PDF-1.4\n% b\n%%EOF\n"),
      contentType: "application/pdf",
    });
    const second = await syncAll(client, first.cursor, new Date("2026-11-05T18:30:30Z"));
    const seen = attachmentKeys([...first.pages, ...second.pages]);
    expect(seen).toContain(`Attachable:${a}:1`);
    expect(seen).toContain(`Attachable:${b}:0`);
  });

  it("reads every row of a second shared across pages, though one changed in between", async () => {
    // QuickBooks keeps times in whole seconds: thirty receipts scanned in one second.
    const { qbo, client, clock } = await setup({ wholeSeconds: true });
    clock.now = new Date("2026-10-20T12:00:00.000Z");
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) {
      ids.push(
        qbo.attachFile("Bill", "146", {
          fileName: `receipt-${i}.pdf`,
          bytes: utf8(`%PDF-1.4\n% receipt ${i}\n%%EOF\n`),
          contentType: "application/pdf",
        }),
      );
    }
    clock.now = NOW;
    let edited = false;
    const { pages } = await syncAll(client, null, NOW, (_i, done) => {
      // After the first attachment page, someone renames one of the receipts it read.
      if (!edited && done.some((p) => p.records[0]?.entityType === "Attachable")) {
        edited = true;
        const row = qbo.get("Attachable", ids[3] as string);
        qbo.put("Attachable", { ...row, Id: ids[3] as string, SyncToken: "1", Note: "renamed" });
      }
    });
    const seen = new Set(
      pages.flatMap((p) =>
        p.records.filter((r) => r.entityType === "Attachable").map((r) => r.externalId),
      ),
    );
    for (const id of ids) expect(seen).toContain(id);
    expect(seen).toContain(`${ids[3]}`);
    expect(
      pages.flatMap((p) => p.records.map(key)).filter((k) => k === `Attachable:${ids[3]}:1`),
    ).not.toHaveLength(0);
  });

  it("sends whole seconds in query times, whatever the clock", async () => {
    const { qbo, client, clock } = await setup();
    // A connection in error for a week, read with a clock that has milliseconds.
    clock.now = new Date("2026-11-12T09:00:00.000Z");
    for (let i = 0; i < 1100; i++) qbo.put("Bill", bill(String(2000 + i)));
    const receipt = qbo.attachFile("Bill", "146", {
      fileName: "receipt.pdf",
      bytes: utf8("%PDF-1.4\n% receipt\n%%EOF\n"),
      contentType: "application/pdf",
    });
    const stored: QboSyncCursor = {
      v: 1,
      phase: "cdc",
      ar: true,
      ledger: true,
      changedSince: "2026-11-05T17:59:00.123Z",
    };
    const { pages } = await syncAll(client, stored, new Date("2026-11-13T10:00:00.456Z"));
    const seen = new Set(pages.flatMap((p) => p.records.map(key)));
    expect(seen).toContain("Bill:3099:0");
    expect(seen).toContain(`Attachable:${receipt}:0`);
    const literals = qbo
      .apiCalls("GET", "query")
      .map((r) => decodeURIComponent(r.url.replace(/\+/g, " ")))
      .flatMap((u) => [...u.matchAll(/LastUpdatedTime >= '([^']+)'/g)].map((m) => m[1]));
    expect(literals.length).toBeGreaterThan(0);
    for (const t of literals) expect(t).toMatch(/T\d{2}:\d{2}:\d{2}Z$/);
  });
});

describe("qbo sync: CDC at the cap (audit 2.5)", () => {
  async function caughtUp() {
    const s = await setup();
    const { cursor } = await syncAll(s.client, null, NOW);
    return { ...s, cursor };
  }

  it("reads every change when a CDC answer is cut off at 1,000 objects", async () => {
    const { qbo, client, clock, cursor } = await caughtUp();
    // Two weeks in error at a busy company: 700 new bills, 600 purchases, and a deletion.
    clock.now = new Date("2026-11-12T09:00:00.000Z");
    for (let i = 0; i < 700; i++) qbo.put("Bill", bill(String(2000 + i)));
    for (let i = 0; i < 600; i++) {
      qbo.put("Purchase", { Id: String(5000 + i), SyncToken: "0", TxnDate: "2026-11-10" });
    }
    qbo.remove("Bill", "145");
    const later = new Date("2026-11-19T10:00:00.000Z");
    const { pages, cursor: after } = await syncAll(client, cursor, later);
    const seen = new Set(pages.flatMap((p) => p.records.map(key)));
    for (let i = 0; i < 700; i++) expect(seen).toContain(`Bill:${2000 + i}:0`);
    for (let i = 0; i < 600; i++) expect(seen).toContain(`Purchase:${5000 + i}:0`);
    expect(seen).toContain("Bill:145:deleted");
    expect(
      pages
        .filter((p) => p.records.some((r) => r.entityType !== "Attachable"))
        .every((p) => !p.initial),
    ).toBe(true);
    // The CDC point moves on only once every entity is read.
    expect(after).toMatchObject({ phase: "cdc", changedSince: "2026-11-19T09:59:00.000Z" });
    expect(after).not.toHaveProperty("catchUp");
  });

  it("pages an entity by query when it alone reaches the cap", async () => {
    const { qbo, client, clock, cursor } = await caughtUp();
    clock.now = new Date("2026-11-12T09:00:00.000Z");
    qbo.remove("Bill", "146");
    for (let i = 0; i < 1100; i++) qbo.put("Bill", bill(String(2000 + i)));
    const later = new Date("2026-11-19T10:00:00.000Z");
    const { pages } = await syncAll(client, cursor, later);
    const seen = pages.flatMap((p) => p.records.map(key));
    const bills = seen.filter((k) => /^Bill:[23]\d{3}:0$/.test(k));
    expect(new Set(bills).size).toBe(1100);
    const queries = qbo
      .apiCalls("GET", "query")
      .map((r) => decodeURIComponent(r.url.replace(/\+/g, " ")))
      .filter((u) => u.includes("from Bill where Metadata.LastUpdatedTime"));
    expect(queries.length).toBeGreaterThanOrEqual(2);
    expect(queries[0]).toContain("maxresults 1000");
    // The deletions Bill's own answer cut off can't be seen: the page says so, for a report.
    expect(pages.filter((p) => p.deletionsMayBeMissed).map((p) => p.deletionsMayBeMissed)).toEqual([
      "Bill",
    ]);
    // A query can't see deletions, and Bill's own CDC answer, at the cap, may have cut this one
    // off (NOTES.md "To verify"); the CDC point still moves on, past every bill.
    expect(pages.at(-1)?.next).toMatchObject({ changedSince: "2026-11-19T09:59:00.000Z" });
  });
});
