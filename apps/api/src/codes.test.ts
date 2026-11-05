// The code service from apps/api's side: the typed client over a fake `CODES` binding, and the
// cron step that turns its alerts into inbox items for the operator and the client admin.

import type { CodeAlert, CodesService } from "@countersign/core";
import { event, inboxItem, withTenant } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { admin, createApiHarness, OPERATOR } from "./api.test-helper";
import { CODE_ALERT_SUBJECT, raiseCodeAlerts } from "./codes/alerts";
import { CodesServiceError, codesClient, codesFor } from "./codes/client";
import { cronTick } from "./runs/dispatch";

const h = await createApiHarness();
afterAll(() => h?.close());

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

/** A fake binding: alerts per client, and a log of what was asked. */
function fakeCodes(alerts: CodeAlert[]) {
  const asked: { tenantId: string; since: string }[] = [];
  const binding = {
    async alerts(input: { tenantId: string; since: string }) {
      asked.push({ tenantId: input.tenantId, since: input.since });
      const since = Date.parse(input.since);
      return {
        ok: true as const,
        value: {
          alerts: alerts.filter(
            (a) => a.tenantId === input.tenantId && Date.parse(a.createdAt) >= since,
          ),
        },
      };
    },
    async claim() {
      return { ok: false as const, error: { code: "daily_cap" as const, message: "cap" } };
    },
    async openWait() {
      return { ok: true as const, value: { waitId: "not-a-uuid" } };
    },
  } as unknown as CodesService;
  return { binding, asked };
}

function alert(tenantId: string, over: Partial<CodeAlert> = {}): CodeAlert {
  const at = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    tenantId,
    identityId: "abcdefgh2345",
    identityLabel: "Acme supplier portal",
    kind: "unsolicited_code",
    channel: "email",
    sender: "no-reply@acme.example",
    receivedAt: at,
    createdAt: at,
    ...over,
  };
}

describe("the code service client", () => {
  it("is off without the CODES binding", () => {
    expect(codesFor({})).toBeNull();
  });

  it("throws the service's error code, and refuses an answer that doesn't fit", async () => {
    const codes = codesClient(fakeCodes([]).binding);
    const claim = codes.claim({
      tenantId: crypto.randomUUID(),
      identityId: "abcdefgh2345",
      waitId: crypto.randomUUID(),
    });
    await expect(claim).rejects.toMatchObject({ code: "daily_cap" });
    const wait = codes.openWait({
      tenantId: crypto.randomUUID(),
      identityId: "abcdefgh2345",
      siteKey: "acme",
      channel: "totp",
    });
    await expect(wait).rejects.toBeInstanceOf(CodesServiceError);
    await expect(wait).rejects.toMatchObject({ code: "bad_response" });
  });
});

describe.skipIf(!h)("code alerts in the inbox", () => {
  const H = h as NonNullable<typeof h>;

  async function items(tenantId: string) {
    return withTenant(H.db, tenantId, (tx) =>
      tx
        .select()
        .from(inboxItem)
        .where(
          and(eq(inboxItem.tenantId, tenantId), eq(inboxItem.subjectType, CODE_ALERT_SUBJECT)),
        ),
    );
  }

  it("raises one item for the operator and one for the client admin, once", async () => {
    const reset = alert(H.A.tenantId, { kind: "reset_attempt", sender: "accounts@acme.example" });
    const fake = fakeCodes([alert(H.A.tenantId), reset, alert(H.B.tenantId)]);
    const codes = codesClient(fake.binding);
    expect(await raiseCodeAlerts(H.db, codes, H.A.tenantId, new Date())).toBe(4);
    expect(await raiseCodeAlerts(H.db, codes, H.A.tenantId, new Date())).toBe(0);
    const a = await items(H.A.tenantId);
    expect(a).toHaveLength(4);
    // Each alert's items carry the supervisor's fingerprint, and each alert is announced once
    // (docs/plan.md §1.28).
    for (const i of a) expect(j(i.payload).fingerprint).toBe(`code_alert:${i.subjectId}`);
    const announced = await H.t.db
      .select()
      .from(event)
      .where(and(eq(event.tenantId, H.A.tenantId), eq(event.type, "connection.needs_attention")));
    expect(announced.map((e) => j(e.payload).sourceId).sort()).toEqual(
      [...new Set(a.map((i) => i.subjectId))].sort(),
    );
    expect(announced.every((e) => j(e.payload).reason === "code_alert")).toBe(true);
    expect(a.map((i) => i.assigneeRole).sort()).toEqual([
      "client_admin",
      "client_admin",
      "operator",
      "operator",
    ]);
    const resetItem = a.find((i) => i.subjectId === reset.id && i.assigneeRole === "client_admin");
    expect(resetItem).toMatchObject({
      kind: "review",
      status: "open",
      title: "Password reset message for Acme supplier portal",
    });
    expect(j(resetItem?.payload).alert).toMatchObject({
      kind: "reset_attempt",
      channel: "email",
      sender: "accounts@acme.example",
    });
    // The second read started from the newest alert already raised, not 30 days back.
    const second = fake.asked.at(-1);
    expect(Date.parse(second?.since ?? "")).toBeGreaterThan(Date.now() - 10 * 60_000);
    // Client B's alert is not A's, and B has none until its own turn.
    expect(await items(H.B.tenantId)).toHaveLength(0);
  });

  it("shows the client admin their item and the operator theirs", async () => {
    const portal = await H.call(admin("a"), "GET", "/api/inbox");
    const mine = j(portal.json).items.filter((i: { title: string }) =>
      i.title.includes("Acme supplier portal"),
    );
    // Four items exist; the client admin sees their own two, not the operator's.
    expect(mine.length).toBe(2);
    expect(JSON.stringify(mine)).not.toMatch(/\b\d{6}\b/);
    const ops = await H.call(
      OPERATOR,
      "GET",
      `/api/ops/inbox?client=${H.A.tenantId}&assigned=operator`,
    );
    expect(ops.status).toBe(200);
    const theirs = j(ops.json).items.filter((i: { title: string }) =>
      i.title.includes("Acme supplier portal"),
    );
    expect(theirs.length).toBe(2);
  });

  it("runs from the cron for every client when the binding exists", async () => {
    const fake = fakeCodes([alert(H.C.tenantId, { kind: "unexpected_message" })]);
    const codes = codesClient(fake.binding);
    await cronTick(
      {
        db: H.db,
        instances: H.instances,
        codesTick: (tenantId, at) => raiseCodeAlerts(H.db, codes, tenantId, at),
      },
      new Date(),
    );
    expect(new Set(fake.asked.map((a) => a.tenantId))).toEqual(
      new Set([H.A.tenantId, H.B.tenantId, H.C.tenantId]),
    );
    const c = await items(H.C.tenantId);
    expect(c.map((i) => i.title)).toEqual([
      "Unexpected message for Acme supplier portal",
      "Unexpected message for Acme supplier portal",
    ]);
  });
});
