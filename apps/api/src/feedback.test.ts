// The Feedback button's API (docs/plan.md §1.8): the back office always sends; a portal only when
// the operator switched feedback on for that client (with a reason, logged); the comment first,
// the JPEG after; only operators read feedback and screenshots, through a short-lived link.

import { DEV_USER_HEADER } from "@countersign/auth";
import { FEEDBACK_SCREENSHOT_MAX_BYTES } from "@countersign/core";
import { feedback, tenantChange } from "@countersign/db";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { admin, createApiHarness, OPERATOR, OTHER_OPERATOR, user } from "./api.test-helper";

const h = await createApiHarness();
afterAll(() => h?.close());

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
const submission = (comment: string, pin: { x: number; y: number } | null = { x: 40, y: 60 }) => ({
  comment,
  path: "/inbox?status=open",
  viewport: { width: 1280, height: 800 },
  pin,
  target: pin ? 'button "Approve"' : null,
});

describe.skipIf(!h)("feedback", () => {
  const harness = h as NonNullable<typeof h>;
  const call = harness.call.bind(harness);

  async function put(
    email: string,
    path: string,
    bytes: Uint8Array,
    type = "image/jpeg",
  ): Promise<{ status: number; json: unknown }> {
    const res = await harness.app.request(
      path,
      {
        method: "PUT",
        headers: { [DEV_USER_HEADER]: email, "content-type": type },
        body: bytes,
      },
      harness.env,
    );
    return { status: res.status, json: await res.json() };
  }

  it("is off for a client until the operator switches it on, and refused with 403", async () => {
    expect((await call(admin("a"), "GET", "/api/feedback/status")).json).toEqual({
      enabled: false,
    });
    const sent = await call(admin("a"), "POST", "/api/feedback", submission("Hi"));
    expect(sent.status).toBe(403);
    expect((sent.json as { error: { code: string } }).error.code).toBe("feedback_off");
  });

  it("switches it with or without a reason, logs who and why, and refuses a no-op", async () => {
    const path = `/api/ops/clients/${harness.A.tenantId}/feedback`;
    const on = await call(OPERATOR, "PUT", path, { enabled: true, reason: "Beta with Demo" });
    expect(on.status).toBe(200);
    const body = on.json as { enabled: boolean; changes: { reason: string; enabled: boolean }[] };
    expect(body.enabled).toBe(true);
    expect(body.changes).toMatchObject([{ enabled: true, reason: "Beta with Demo" }]);
    expect((await call(OPERATOR, "PUT", path, { enabled: true, reason: "again" })).status).toBe(
      409,
    );
    // Without a reason (the back office asks for none), the log says what changed.
    const off = await call(OPERATOR, "PUT", path, { enabled: false });
    expect(off.status).toBe(200);
    expect((off.json as typeof body).changes[0]).toMatchObject({
      enabled: false,
      reason: "Feedback button switched off",
    });
    expect((await call(OPERATOR, "PUT", path, { enabled: true, reason: " " })).status).toBe(200);
    const logged = await harness.t.db
      .select()
      .from(tenantChange)
      .where(eq(tenantChange.tenantId, harness.A.tenantId));
    expect(logged).toHaveLength(3);
    expect(logged[0]?.actorId).toBe(harness.operator);
    // A client can't change it, and an operator who doesn't serve the client can't either.
    expect((await call(admin("a"), "PUT", path, { enabled: false, reason: "x" })).status).toBe(403);
    expect((await call(OTHER_OPERATOR, "PUT", path, { enabled: false, reason: "x" })).status).toBe(
      404,
    );
    expect((await call(admin("a"), "GET", "/api/feedback/status")).json).toEqual({
      enabled: true,
    });
    // Client B is still off.
    expect((await call(admin("b"), "POST", "/api/feedback", submission("B"))).status).toBe(403);
  });

  it("saves a portal comment, then its screenshot, under the client's key", async () => {
    const sent = await call(admin("a"), "POST", "/api/feedback", submission("Approve is hidden"));
    expect(sent.status).toBe(200);
    const { id } = sent.json as { id: string };
    const up = await put(admin("a"), `/api/feedback/${id}/screenshot`, JPEG);
    expect(up).toEqual({ status: 200, json: { ok: true, bytes: JPEG.length } });
    const [row] = await harness.t.db.select().from(feedback).where(eq(feedback.id, id));
    expect(row).toMatchObject({
      tenantId: harness.A.tenantId,
      surface: "portal",
      userId: harness.A.admin,
      target: 'button "Approve"',
      screenshotKey: `tenants/${harness.A.tenantId}/feedback/${id}.jpg`,
    });
    expect(await harness.objects.head(row?.screenshotKey ?? "")).toMatchObject({
      contentType: "image/jpeg",
      size: JPEG.length,
    });
    // Once only, by the sender only, JPEG only, size-limited.
    expect((await put(admin("a"), `/api/feedback/${id}/screenshot`, JPEG)).status).toBe(409);
    const other = (await call(user("a"), "POST", "/api/feedback", submission("x"))).json as {
      id: string;
    };
    expect((await put(admin("a"), `/api/feedback/${other.id}/screenshot`, JPEG)).status).toBe(404);
    expect(
      (await put(user("a"), `/api/feedback/${other.id}/screenshot`, JPEG, "image/png")).status,
    ).toBe(422);
    expect(
      (await put(user("a"), `/api/feedback/${other.id}/screenshot`, new Uint8Array([1, 2, 3, 4])))
        .status,
    ).toBe(422);
    const big = new Uint8Array(FEEDBACK_SCREENSHOT_MAX_BYTES + 1);
    big.set([0xff, 0xd8, 0xff]);
    expect((await put(user("a"), `/api/feedback/${other.id}/screenshot`, big)).status).toBe(422);
    // Another client can't reach it.
    expect((await put(admin("b"), `/api/feedback/${id}/screenshot`, JPEG)).status).toBe(403);
  });

  it("sends from the back office always, with no client", async () => {
    const sent = await call(OPERATOR, "POST", "/api/ops/feedback", submission("Ops nit", null));
    expect(sent.status).toBe(200);
    const { id } = sent.json as { id: string };
    expect((await put(OPERATOR, `/api/ops/feedback/${id}/screenshot`, JPEG)).status).toBe(200);
    const [row] = await harness.t.db.select().from(feedback).where(eq(feedback.id, id));
    expect(row).toMatchObject({
      tenantId: null,
      surface: "ops",
      pin: null,
      target: null,
      screenshotKey: `operator/feedback/${id}.jpg`,
    });
  });

  it("lists for operators, newest first, with a 5-minute link to the picture", async () => {
    const list = await call(OPERATOR, "GET", "/api/ops/feedback");
    expect(list.status).toBe(200);
    const items = (list.json as { items: { id: string; comment: string; client: unknown }[] })
      .items;
    expect(items.map((i) => i.comment)).toEqual(["Ops nit", "x", "Approve is hidden"]);
    expect(items[0]?.client).toBeNull();
    expect(items[2]).toMatchObject({
      client: { id: harness.A.tenantId, name: "Client A" },
      from: { email: admin("a") },
      pin: { x: 40, y: 60 },
      hasScreenshot: true,
      status: "open",
    });
    const id = items[2]?.id as string;
    const link = await call(OPERATOR, "GET", `/api/ops/feedback/${id}/screenshot`);
    expect(link.status).toBe(200);
    const url = new URL((link.json as { url: string }).url);
    const file = await harness.app.request(url.pathname, {}, harness.env);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(JPEG);
    // No picture: 404.
    expect(
      (await call(OPERATOR, "GET", `/api/ops/feedback/${items[1]?.id}/screenshot`)).status,
    ).toBe(404);
    // An operator who serves only client C sees the back office's, not client A's.
    const other = (await call(OTHER_OPERATOR, "GET", "/api/ops/feedback?status=all")).json as {
      items: { comment: string }[];
    };
    expect(other.items.map((i) => i.comment)).toEqual(["Ops nit"]);
    expect((await call(OTHER_OPERATOR, "GET", `/api/ops/feedback/${id}/screenshot`)).status).toBe(
      404,
    );
  });

  it("resolves with a note and reopens", async () => {
    const items = (
      (await call(OPERATOR, "GET", "/api/ops/feedback")).json as { items: { id: string }[] }
    ).items;
    const id = items[2]?.id as string;
    const resolved = await call(OPERATOR, "POST", `/api/ops/feedback/${id}/resolve`, {
      note: "https://github.com/jammil-alt/countersign/pull/1",
    });
    expect(resolved.status).toBe(200);
    expect((resolved.json as { item: unknown }).item).toMatchObject({
      status: "resolved",
      resolvedBy: { email: OPERATOR },
      resolutionNote: "https://github.com/jammil-alt/countersign/pull/1",
    });
    expect((await call(OPERATOR, "POST", `/api/ops/feedback/${id}/resolve`, {})).status).toBe(409);
    const open = (await call(OPERATOR, "GET", "/api/ops/feedback")).json as {
      items: { id: string }[];
    };
    expect(open.items.map((i) => i.id)).not.toContain(id);
    const done = (await call(OPERATOR, "GET", "/api/ops/feedback?status=resolved")).json as {
      items: { id: string }[];
    };
    expect(done.items.map((i) => i.id)).toEqual([id]);
    const reopened = await call(OPERATOR, "POST", `/api/ops/feedback/${id}/reopen`);
    expect((reopened.json as { item: unknown }).item).toMatchObject({
      status: "open",
      resolvedAt: null,
      resolutionNote: null,
    });
    expect((await call(OPERATOR, "POST", `/api/ops/feedback/${id}/reopen`)).status).toBe(409);
  });

  it("never shows a client anyone's feedback", async () => {
    for (const who of [admin("a"), user("a")]) {
      for (const path of ["/api/ops/feedback", "/api/ops/feedback?status=all"]) {
        expect((await call(who, "GET", path)).status).toBe(403);
      }
    }
  });

  it("switching it off hides the button and refuses again", async () => {
    const path = `/api/ops/clients/${harness.A.tenantId}/feedback`;
    const off = await call(OPERATOR, "PUT", path, { enabled: false, reason: "Beta over" });
    expect((off.json as { changes: unknown[] }).changes).toMatchObject([
      { enabled: false, reason: "Beta over", by: { email: OPERATOR } },
      { enabled: true, reason: "Feedback button switched on" },
      { enabled: false, reason: "Feedback button switched off" },
      { enabled: true, reason: "Beta with Demo" },
    ]);
    expect((await call(admin("a"), "GET", "/api/feedback/status")).json).toEqual({
      enabled: false,
    });
    expect((await call(user("a"), "POST", "/api/feedback", submission("late"))).status).toBe(403);
  });
});
