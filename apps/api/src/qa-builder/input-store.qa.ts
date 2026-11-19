// QA (input abuse, 2026-11-19): values the build routes' Zod schemas let through but Postgres
// refuses. Each answer should be a 400 with a clear message (or the value saved), never a 500.
// A model answer whose text is cut inside a surrogate pair must not lose the Builder's turn.
import type { BuildDetail } from "@countersign/core";
import { build, buildMessage } from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { asc, eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createApiHarness, OPERATOR } from "../api.test-helper";

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const model = new FakeModel();
const h = await createApiHarness({ llm: model });
afterAll(() => h?.close());

const turnAnswer = (input: Record<string, unknown>) => ({
  toolUse: { name: "submit_build_turn", input: { chips: [], items: [], ...input } },
});

describe.skipIf(!h)("input abuse: what Postgres refuses after Zod passed it", () => {
  const H = h as NonNullable<typeof h>;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await H.call(OPERATOR, method, path, body);
    return { status: res.status, json: res.json as BuildDetail & { error?: { message: string } } };
  };
  const start = async (title = "Input abuse") => {
    const res = await call("POST", "/api/ops/builds", { kind: "agent", title });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json.build.id;
  };

  it("INPUT-1a refuses a NUL byte in a build's title with a 400, not a 500", async () => {
    const res = await call("POST", "/api/ops/builds", {
      kind: "agent",
      title: "Invoice\u0000 review",
    });
    expect(res.status, JSON.stringify(res.json)).toBe(400);
  });

  it("INPUT-1b refuses a NUL byte in a brief field with a 400, not a 500", async () => {
    const id = await start();
    const res = await call("PATCH", `/api/ops/builds/${id}`, {
      brief: { goal: { text: "Check invoices\u0000 against contracts", state: "confirmed" } },
    });
    expect(res.status, JSON.stringify(res.json)).toBe(400);
  });

  it("INPUT-1c refuses a NUL byte in the operator's words to the Builder with a 400, not a 500", async () => {
    const id = await start();
    const res = await call("POST", `/api/ops/builds/${id}/turns`, {
      text: "Pasted from the PDF:\u0000 vendor terms",
    });
    expect(res.status, JSON.stringify(res.json)).toBe(400);
  });

  it("INPUT-1d refuses a lone surrogate in a brief field with a 400, not a 500", async () => {
    const id = await start();
    // What a browser sends for text cut inside an emoji: JSON allows the escape on its own.
    const res = await H.call(OPERATOR, "PATCH", `/api/ops/builds/${id}`, {
      brief: { goal: { text: "Flag late invoices \ud83d", state: "confirmed" } },
    });
    expect(res.status, JSON.stringify(res.json)).toBe(400);
  });

  it("INPUT-2 refuses a promised date that isn't a calendar date with a 400, not a 500", async () => {
    const res = await call("POST", "/api/ops/builds", {
      kind: "agent",
      title: "Promised on a day that doesn't exist",
      promisedOn: "2026-02-30",
    });
    expect(res.status, JSON.stringify(res.json)).toBe(400);
    const id = await start();
    const patched = await call("PATCH", `/api/ops/builds/${id}`, { promisedOn: "2026-13-01" });
    expect(patched.status, JSON.stringify(patched.json)).toBe(400);
  });

  it("INPUT-8 refuses changing an open item's words on a stopped build (409)", async () => {
    const id = await start("Stopped with an item");
    const added = await call("POST", `/api/ops/builds/${id}/items`, { title: "Check the W-9" });
    expect(added.status, JSON.stringify(added.json)).toBe(200);
    const itemId = added.json.items[0]?.id as string;
    const stopped = await call("POST", `/api/ops/builds/${id}/stop`, { reason: "Client left" });
    expect(stopped.json.build.status).toBe("stopped");
    const res = await call("PATCH", `/api/ops/builds/${id}/items/${itemId}`, {
      title: "Rewritten after the build stopped",
      state: "done",
    });
    expect(res.status, JSON.stringify(res.json.items ?? res.json)).toBe(409);
  });

  it("INPUT-3 keeps the Builder's fit-gap when a long 'how' is cut inside a surrogate pair", async () => {
    const id = await start("Japanese vendor contracts");
    await H.t.db.update(build).set({ phase: "fitgap" }).where(eq(build.id, id));
    // Japanese has no spaces and no ". ": clampText cuts at 499 code units, here between the two
    // halves of 𠮷 (U+20BB7, as in the vendor name 𠮷野家), and appends "…".
    const phrase = "契約書の単価を請求書と照合する";
    const lead = phrase.repeat(Math.floor(498 / phrase.length));
    const how = `${lead}${"あ".repeat(498 - lead.length)}𠮷野家の請求書も同じく照合する`;
    expect(how.length).toBeGreaterThan(500);
    expect(how.charCodeAt(498)).toBe(0xd842);
    model.push(
      turnAnswer({
        text: "Here is the fit-gap.",
        fitgap: {
          rows: [{ id: "match", need: "Match prices", verdict: "native", how }],
          needsTrue: [],
          setup: [],
        },
      }),
    );
    const res = await call("POST", `/api/ops/builds/${id}/turns`, { text: "Write the fit-gap." });
    expect.soft(res.status, JSON.stringify(res.json)).toBe(200);
    const [stored] = await H.t.db
      .select({ fitgap: build.fitgap })
      .from(build)
      .where(eq(build.id, id));
    expect
      .soft((stored?.fitgap as { rows?: { id: string }[] } | undefined)?.rows?.map((r) => r.id))
      .toEqual(["match"]);
    const messages = await H.t.db
      .select({ role: buildMessage.role })
      .from(buildMessage)
      .where(eq(buildMessage.buildId, id))
      .orderBy(asc(buildMessage.createdAt));
    // The operator's words have the Builder's answer after them.
    expect(messages.map((m) => m.role)).toEqual(["operator", "builder"]);
  });
});
