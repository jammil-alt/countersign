// QA PH3: a portal request says "Sent" until one of us picks it up, never "We're on it" the moment
// it is raised, and a problem carries its number.

import { appUser, clientAsk, message } from "@countersign/db";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { type ApiHarness, admin, createApiHarness, OPERATOR } from "./api.test-helper";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const h = await createApiHarness();
afterAll(() => h?.close());

describe.skipIf(!h)("where a portal request stands", () => {
  const H = h as ApiHarness;
  const state = async (id: string) =>
    j((await H.call(admin("a"), "GET", `/api/issues/${id}`)).json).request;

  it("a problem: Sent with its number, then On it once we answer", async () => {
    const raised = await H.call(admin("a"), "POST", "/api/requests", {
      subject: "The bill total is off",
      text: "The Ferguson bill came in at the wrong total.",
    });
    expect(raised.status, JSON.stringify(raised.json)).toBe(200);
    const id = j(raised.json).item.id as string;
    const before = await state(id);
    expect(before).toMatchObject({ kind: "problem", state: "sent" });
    expect(before.number).toBeGreaterThan(0);
    const list = j((await H.call(admin("a"), "GET", "/api/issues?status=all")).json).items;
    expect(list.find((r: { id: string }) => r.id === id)).toMatchObject({
      state: "sent",
      number: before.number,
    });

    const reply = await H.call(OPERATOR, "POST", `/api/ops/issues/${id}/messages`, {
      text: "We have it and are looking now.",
      audience: "client",
    });
    expect(reply.status, JSON.stringify(reply.json)).toBe(200);
    expect((await state(id)).state).toBe("on_it");
  });

  it("a problem we moved on without a word is picked up too", async () => {
    const raised = await H.call(admin("a"), "POST", "/api/requests", {
      text: "Vendor names are spelled wrong.",
    });
    const id = j(raised.json).item.id as string;
    expect((await state(id)).state).toBe("sent");
    const moved = await H.call(OPERATOR, "PATCH", `/api/ops/issues/${id}`, { stage: "cause" });
    expect(moved.status, JSON.stringify(moved.json)).toBe(200);
    expect((await state(id)).state).toBe("on_it");
  });

  it("an idea: Sent, then On it once one of us writes on it; the client's own words don't count", async () => {
    const raised = await H.call(admin("a"), "POST", "/api/requests", {
      kind: "idea",
      text: "Please watch Acme Lumber's prices too.",
    });
    expect(raised.status, JSON.stringify(raised.json)).toBe(200);
    const id = j(raised.json).item.id as string;
    expect(await state(id)).toMatchObject({ kind: "idea", state: "sent", number: null });

    const more = await H.call(admin("a"), "POST", `/api/issues/${id}/messages`, {
      text: "And Ferguson's.",
    });
    expect(more.status, JSON.stringify(more.json)).toBe(200);
    expect((await state(id)).state).toBe("sent");

    const [ask] = await H.t.db.select().from(clientAsk).where(eq(clientAsk.id, id));
    const [op] = await H.t.db.select().from(appUser).where(eq(appUser.email, OPERATOR));
    await H.t.db.insert(message).values({
      tenantId: H.A.tenantId,
      threadId: ask?.threadId as string,
      senderType: "user",
      senderId: op?.id as string,
      body: { text: "Good idea. We'll add it." },
      audience: "client",
    });
    expect((await state(id)).state).toBe("on_it");
  });
});
