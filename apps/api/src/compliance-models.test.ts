// HIPAA mode's model guard outside a run (docs/plan.md §1.35): every model call apps/api makes for
// a client, run or not, is held to that client's HIPAA mode. Here no model vendor has a BAA, so a
// client in HIPAA mode is refused every model call before the model is reached (409 `hipaa`),
// while a client not in HIPAA mode reaches it as before. One test per kind of call site: plain-
// words questions (portal and back office), the Builder and builds, Reggie, and the calls made
// outside a request (summaries, background reads) through the one way apps/api gets a transport.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { type BuildDetail, ComplianceRefusal } from "@countersign/core";
import { tenant } from "@countersign/db";
import { FakeModel, type Transcriber } from "@countersign/llm";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { admin, createApiHarness, OPERATOR } from "./api.test-helper";
import { clientModels, clientTranscriber } from "./compliance/models";

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error", "info"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const model = new FakeModel();
const transcribe = vi.fn(async () => "hello");
const transcriber: Transcriber = { transcribe };
const h = await createApiHarness({
  llm: model,
  transcriber,
  // The infrastructure is covered (so HIPAA mode can be on); no model vendor is.
  env: { BAA_PROCESSORS: "cloudflare,neon,workos" },
  // As a deployed Worker: one connection per request, so a guard that read the client's profile
  // beside the request's open transaction would wait on itself.
  appDbMax: 1,
});
afterAll(() => h?.close());

describe.skipIf(!h)("HIPAA mode's model guard outside a run", () => {
  const H = h as NonNullable<typeof h>;
  const { A, B } = H;

  beforeAll(async () => {
    await H.t.db
      .update(tenant)
      .set({ settings: { compliance: { hipaa: true } } })
      .where(eq(tenant.id, A.tenantId));
  });
  beforeEach(() => {
    model.requests.length = 0;
  });

  const refused = (res: { status: number; json: unknown }) => {
    const error = (res.json as { error?: { code?: string; message?: string } }).error;
    expect([res.status, error?.code]).toEqual([409, "hipaa"]);
    expect(error?.message).toContain("no signed BAA");
  };

  it("refuses a HIPAA client's plain-words question before the model is reached", async () => {
    refused(await H.call(admin("a"), "POST", "/api/runs/ask", { text: "what failed today" }));
    refused(
      await H.call(OPERATOR, "POST", "/api/ops/runs/ask", {
        text: "what failed today",
        client: A.tenantId,
      }),
    );
    // Across every client served: one of them is in HIPAA mode, so the question can't go.
    refused(await H.call(OPERATOR, "POST", "/api/ops/runs/ask", { text: "what failed today" }));
    expect(model.requests).toHaveLength(0);
    // A client not in HIPAA mode reaches the model as before.
    await H.call(admin("b"), "POST", "/api/runs/ask", { text: "what failed today" });
    expect(model.requests).toHaveLength(1);
  });

  it("refuses the Builder for a HIPAA client's agent, and lets a template's through", async () => {
    refused(
      await H.call(OPERATOR, "POST", "/api/ops/agents/draft", {
        description: "Review records",
        clientId: A.tenantId,
      }),
    );
    const start = await H.call(OPERATOR, "POST", "/api/ops/builder/sessions", {
      kind: "skill",
      clientId: A.tenantId,
    });
    expect(start.status).toBe(200);
    const sessionId = (start.json as { session: { id: string } }).session.id;
    refused(
      await H.call(OPERATOR, "POST", `/api/ops/builder/sessions/${sessionId}/turns`, {
        text: "Read the record",
      }),
    );
    expect(model.requests).toHaveLength(0);
    // A template is no client's data.
    await H.call(OPERATOR, "POST", "/api/ops/agents/draft", { description: "Review records" });
    expect(model.requests.length).toBeGreaterThan(0);
  });

  it("refuses a HIPAA client's build turn, saying why in the conversation", async () => {
    const started = await H.call(OPERATOR, "POST", "/api/ops/builds", {
      kind: "agent",
      title: "Records",
      clientId: A.tenantId,
    });
    expect(started.status).toBe(200);
    const id = (started.json as BuildDetail).build.id;
    const turn = await H.call(OPERATOR, "POST", `/api/ops/builds/${id}/turns`, {
      text: "It reviews records",
    });
    expect(turn.status).toBe(200);
    expect(model.requests).toHaveLength(0);
    const last = (turn.json as BuildDetail).messages.at(-1);
    expect(last).toMatchObject({ role: "builder" });
    expect(last?.text).toContain("HIPAA mode");
  });

  it("refuses Reggie while a client it can read is in HIPAA mode", async () => {
    const about = await H.call(OPERATOR, "POST", "/api/ops/reggie/conversations", {
      clientId: A.tenantId,
    });
    const aboutId = (about.json as { conversation: { id: string } }).conversation.id;
    refused(
      await H.call(OPERATOR, "POST", `/api/ops/reggie/conversations/${aboutId}/turns`, {
        text: "How is it going?",
      }),
    );
    // About everything: its tools read every client served, A among them.
    const all = await H.call(OPERATOR, "POST", "/api/ops/reggie/conversations", {});
    const allId = (all.json as { conversation: { id: string } }).conversation.id;
    refused(
      await H.call(OPERATOR, "POST", `/api/ops/reggie/conversations/${allId}/turns`, {
        text: "How is it going?",
      }),
    );
    expect(model.requests).toHaveLength(0);
  });

  it("holds calls outside a request (summaries, background reads) to the clients named", async () => {
    const services = { deps: { llm: () => model }, env: H.env, db: H.db } as unknown as Parameters<
      typeof clientModels
    >[0];
    const request = { model: "claude-sonnet-5-5", max_tokens: 10, messages: [] };
    for (const clients of [[A.tenantId], [B.tenantId, A.tenantId]]) {
      const refusal = await clientModels(services, { clients, read: H.db })
        .create(request)
        .catch((e: unknown) => e);
      expect(refusal).toBeInstanceOf(ComplianceRefusal);
    }
    expect(model.requests).toHaveLength(0);
    for (const clients of [[B.tenantId], []]) {
      await clientModels(services, { clients, read: H.db })
        .create(request)
        .catch(() => {});
    }
    expect(model.requests).toHaveLength(2);

    const t = clientTranscriber(
      { ...services, deps: { transcriber: () => transcriber } } as never,
      {
        clients: [A.tenantId],
        read: H.db,
      },
    );
    const audio = { audio: new Uint8Array([1]), type: "audio/webm" };
    await expect(t?.transcribe(audio)).rejects.toBeInstanceOf(ComplianceRefusal);
    expect(transcribe).not.toHaveBeenCalled();
  });
});

// A new call site can't skip the guard: apps/api gets a model transport (or speech-to-text) only
// through `compliance/models.ts`. Run deps (`runDepsFromEnv`) carry the Worker's transport, and
// each file that builds them holds them to the client (`forClient`) or hands them to code that
// does (`executeRun`, `executeSuite`).
describe("where apps/api gets a model", () => {
  const src = fileURLToPath(new URL(".", import.meta.url).href);
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return files(path);
      return /\.ts$/.test(name) && !/\.test(-helper)?\.ts$/.test(name) && !/\.eval\.ts$/.test(name)
        ? [path]
        : [];
    });
  const sources = files(src).map((path) => ({
    file: relative(src, path),
    text: readFileSync(path, "utf8"),
  }));

  it("makes transports and transcribers only in compliance/models.ts", () => {
    const raw =
      /\bworkerTransport\(|\.llm\??\.\(|\.llm\(|\.extractionTransport\??\.?\(|\.translationTransport\??\.?\(|\.transcriber\??\.?\(|\b(anthropic|openai|xai|gemini|routing)Transport\(|\bcreateOpenAITranscriber\(/;
    // DECISION: the definitions themselves: the Worker's transport and run deps (execute.ts),
    // and the app's default dependencies (http.ts).
    const allowed = new Set(["compliance/models.ts", "runs/execute.ts", "http.ts"]);
    const offenders = sources
      .filter((s) => !allowed.has(s.file))
      .flatMap((s) =>
        s.text
          .split("\n")
          .map((line, i) => ({ line, at: `${s.file}:${i + 1}` }))
          .filter(({ line }) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
          .filter(({ line }) => raw.test(line))
          .map(({ at }) => at),
      );
    expect(offenders).toEqual([]);
  });

  it("holds run deps to a client wherever they are built", () => {
    const unheld = sources
      .filter((s) => s.file !== "runs/execute.ts" && /\brunDepsFromEnv\(/.test(s.text))
      .filter((s) => !/\b(forClient|executeRun|executeSuite)\(/.test(s.text))
      .map((s) => s.file);
    expect(unheld).toEqual([]);
  });
});
