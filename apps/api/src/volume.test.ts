// Unusual read volume (docs/plan.md §1.245): a person's reads of a client past the limit raise one
// to-do for the operators who serve it and one email to the security officer per hour; polls and
// the security officer's investigation don't count; documents and exports have limits of their own;
// nothing is locked, and other clients are untouched.

import { withOperator } from "@countersign/db";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { admin, createApiHarness } from "./api.test-helper";
import { findUnusualVolume, volumeTick } from "./lockdown/volume";
import type { Mailer, MailMessage } from "./notify/mailer";

const h = await createApiHarness();
afterAll(() => h?.close());

const LIMITS = { readsPerHour: 10, documentReadsPerHour: 5, exportsPerDay: 2 };
/**
 * Each test's own pass, on the 5-minute beat, a day apart: audit rows are never deleted
 * (invariant 3), so a test's rows stay outside the others' windows.
 */
const passAt = (day: number) => new Date(`2026-10-${String(day).padStart(2, "0")}T14:05:00.000Z`);

describe.skipIf(!h)("unusual read volume", () => {
  const H = h as NonNullable<typeof h>;
  const owner = H.t.db;
  const sent: MailMessage[] = [];
  const mailer: Mailer = {
    isConfigured: true,
    send: async (m) => {
      sent.push(m);
      return `m${sent.length}`;
    },
  };
  const deps = { db: H.db, mailer, officers: ["officer@example.com"], origin: "https://app.test" };

  afterEach(async () => {
    sent.length = 0;
    await owner.$client`delete from todo where dedupe_key like 'volume:%'`;
  });

  const userId = async (email: string) =>
    (await owner.$client<{ id: string }[]>`select id from app_user where email = ${email}`)[0]
      ?.id as string;

  /** `n` audit rows for a person in a client, `minutesAgo` before the pass at `now`. */
  async function rows(
    now: Date,
    email: string,
    tenantId: string,
    n: number,
    over: { action?: string; target?: object; minutesAgo?: number; outcome?: string } = {},
  ) {
    const actor = await userId(email);
    const at = new Date(now.getTime() - (over.minutesAgo ?? 10) * 60_000).toISOString();
    await owner.$client`
      insert into audit_event (tenant_id, actor_kind, actor_user_id, actor_email, action, outcome,
        http_status, target, created_at)
      select ${tenantId}, 'user', ${actor}, ${email}, ${over.action ?? "GET /api/test-volume/:id"},
        ${over.outcome ?? "ok"}, 200, ${JSON.stringify(over.target ?? {})}::jsonb, ${at}::timestamptz
      from generate_series(1, ${n})`;
  }
  const todos = () =>
    owner.$client<{ title: string; client_id: string | null; dedupe_key: string }[]>`
      select title, client_id, dedupe_key from todo where dedupe_key like 'volume:%' order by title`;

  it("raises one alert per person, client and hour past the reads limit, and locks nothing", async () => {
    const now = passAt(1);
    await rows(now, admin("a"), H.A.tenantId, 11);
    await rows(now, admin("b"), H.B.tenantId, 10);
    expect(await volumeTick(deps, now, LIMITS)).toBe(1);
    expect(await todos()).toEqual([
      expect.objectContaining({
        title: `Unusual activity: ${admin("a")}, 11 reads`,
        client_id: H.A.tenantId,
      }),
    ]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: "officer@example.com",
      subject: `Unusual activity: ${admin("a")}`,
    });
    expect(sent[0]?.text).toContain("made 11 reads of");
    expect(sent[0]?.text).toContain("https://app.test/ops/security/audit");
    // Five minutes later, the same hour: nothing new.
    const later = new Date(now.getTime() + 5 * 60_000);
    await rows(later, admin("a"), H.A.tenantId, 5);
    expect(await volumeTick(deps, later, LIMITS)).toBe(0);
    expect(sent).toHaveLength(1);
    // Nothing locked.
    const [locked] = await owner.$client<{ n: number }[]>`
      select count(*)::int as n from tenant where locked_at is not null`;
    expect(locked?.n).toBe(0);
  });

  it("runs only on the 5-minute beat", async () => {
    const now = passAt(2);
    await rows(now, admin("a"), H.A.tenantId, 50);
    expect(await volumeTick(deps, new Date(now.getTime() + 60_000), LIMITS)).toBe(0);
    expect(await todos()).toEqual([]);
  });

  it("doesn't count polls, the officer's investigation, older reads or refused ones", async () => {
    const now = passAt(3);
    await rows(now, admin("a"), H.A.tenantId, 8);
    await rows(now, admin("a"), H.A.tenantId, 20, { target: { refresh: "1" } });
    await rows(now, admin("a"), H.A.tenantId, 20, { target: { investigate: "1" } });
    await rows(now, admin("a"), H.A.tenantId, 20, { minutesAgo: 90 });
    await rows(now, admin("a"), H.A.tenantId, 20, { outcome: "refused" });
    expect(await volumeTick(deps, now, LIMITS)).toBe(0);
  });

  it("has its own limits for document reads and for exports", async () => {
    const now = passAt(4);
    await rows(now, admin("a"), H.A.tenantId, 6, { action: "GET /api/test-volume/documents/:id" });
    await rows(now, admin("a"), H.A.tenantId, 3, { action: "POST /api/test-volume/exports" });
    const found = await withOperator(H.db, [H.A.tenantId], (tx) =>
      findUnusualVolume(tx, now, LIMITS),
    );
    expect(found.map((f) => [f.kind, f.count, f.hours]).sort()).toEqual([
      ["documents", 6, 1],
      ["exports", 3, 24],
    ]);
    expect(await volumeTick(deps, now, LIMITS)).toBe(2);
    expect((await todos()).map((t) => t.title)).toEqual([
      `Unusual activity: ${admin("a")}, 3 exports`,
      `Unusual activity: ${admin("a")}, 6 document reads`,
    ]);
  });
});
