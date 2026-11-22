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
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { admin, createApiHarness, OPERATOR } from "./api.test-helper";
import { clientModels, clientTranscriber } from "./compliance/models";

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error", "info"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const model = new FakeModel();
const transcribe = vi.fn(async () => ({
  text: "hello",
  model: "openai:gpt-4o-mini-transcribe",
  usage: null,
  costUsd: null,
  durationMs: 1,
}));
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

  it("refuses a template's build tested at a HIPAA client", async () => {
    const started = await H.call(OPERATOR, "POST", "/api/ops/builds", {
      kind: "agent",
      title: "Shared records",
    });
    const id = (started.json as BuildDetail).build.id;
    await H.t.db.execute(sql`update build set test_client_id = ${A.tenantId} where id = ${id}`);
    const turn = await H.call(OPERATOR, "POST", `/api/ops/builds/${id}/turns`, {
      text: "It reviews records",
    });
    expect(turn.status).toBe(200);
    expect(model.requests).toHaveLength(0);
    expect((turn.json as BuildDetail).messages.at(-1)?.text).toContain("HIPAA mode");
  });

  it("leaves a HIPAA client's builds out of another build's turn", async () => {
    await H.call(OPERATOR, "POST", "/api/ops/builds", {
      kind: "agent",
      title: "Clinic intake for A",
      clientId: A.tenantId,
    });
    const other = await H.call(OPERATOR, "POST", "/api/ops/builds", {
      kind: "agent",
      title: "Invoices for B",
      clientId: B.tenantId,
    });
    const id = (other.json as BuildDetail).build.id;
    await H.call(OPERATOR, "POST", `/api/ops/builds/${id}/turns`, { text: "It reads invoices" });
    expect(model.requests).toHaveLength(1);
    const sent = JSON.stringify(model.requests[0]);
    expect(sent).toContain("Invoices for B");
    expect(sent).not.toContain("Clinic intake for A");
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
    // Naming another client on the request doesn't narrow what Reggie can read.
    refused(
      await H.call(
        OPERATOR,
        "POST",
        `/api/ops/reggie/conversations/${allId}/turns?client=${B.tenantId}`,
        { text: "How is it going?" },
      ),
    );
    refused(
      await H.call(
        OPERATOR,
        "POST",
        `/api/ops/reggie/conversations/${allId}/turns`,
        { text: "How is it going?" },
        { "x-countersign-client": B.tenantId },
      ),
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

    // Several clients' HIPAA mode is read in one query.
    const select = vi.spyOn(H.db, "select");
    await clientModels(services, { clients: [B.tenantId, H.C.tenantId], read: H.db })
      .create(request)
      .catch(() => {});
    expect(select).toHaveBeenCalledTimes(1);
    select.mockRestore();

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

  /** Code lines (comments left out), with where each one is. */
  const lines = (src: { file: string; text: string }) =>
    src.text
      .split("\n")
      .map((line, i) => ({ line: line.trim(), at: `${src.file}:${i + 1}` }))
      .filter(({ line }) => !line.startsWith("//") && !line.startsWith("*"));

  it("makes transports and transcribers only in compliance/models.ts", () => {
    const raw =
      /\bworkerTransport\(|\.llm\??\.?\(|\.extractionTransport\??\.?\(|\.translationTransport\??\.?\(|\.transcriber\??\.?\(|\b(worker|anthropic|openai|xai|gemini|routing)Transport\(|\bcreateOpenAITranscriber\(/;
    // DECISION: outside compliance/models.ts, only the definitions themselves, line by line: the
    // Worker's transport and run deps' (execute.ts), and the app's default reader (http.ts).
    const allowed: Record<string, readonly string[]> = {
      "runs/execute.ts": [
        "export function workerTransport(",
        "return routingTransport({",
        "...(anthropicKey ? { anthropic: anthropicTransport(",
        "...(openaiKey ? { openai: openaiTransport(",
        "...(xaiKey ? { xai: xaiTransport(",
        "...(geminiKey ? { google: geminiTransport(",
        "transport: workerTransport(env),",
      ],
      "http.ts": [
        "extractionTransport: (env) => (env.ANTHROPIC_API_KEY?.trim() ? workerTransport(env)",
      ],
    };
    const offenders = sources
      .filter((s) => s.file !== "compliance/models.ts")
      .flatMap((s) =>
        lines(s)
          .filter(({ line }) => raw.test(line))
          .filter(({ line }) => !(allowed[s.file] ?? []).some((ok) => line.startsWith(ok)))
          .map(({ at }) => at),
      );
    expect(offenders).toEqual([]);
  });

  it("imports what makes a transport or transcriber only where it is allowed", () => {
    // Value imports (any alias, any line layout) of a transport maker, the transcriber maker or
    // a namespace that holds them. A guardrail, not a parser.
    const makers = /^(\w+Transport|createOpenAITranscriber)$/;
    // Names that end so but make nothing (a type; a pack tool's transport handed in).
    const types = new Set(["LlmTransport", "packToolTransport"]);
    const allowed: Record<string, readonly string[]> = {
      "compliance/models.ts": ["workerTransport", "createOpenAITranscriber"],
      "runs/execute.ts": [
        "anthropicTransport",
        "geminiTransport",
        "openaiTransport",
        "routingTransport",
        "xaiTransport",
      ],
      "http.ts": ["workerTransport"],
    };
    const offenders = sources.flatMap((s) => {
      const out: string[] = [];
      for (const m of s.text.matchAll(
        /import\s+(type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g,
      )) {
        if (m[1]) continue;
        for (const spec of (m[2] ?? "").split(",").map((x) => x.trim())) {
          if (!spec || spec.startsWith("type ")) continue;
          const name = spec.split(/\s+as\s+/)[0] as string;
          if (makers.test(name) && !types.has(name) && !(allowed[s.file] ?? []).includes(name)) {
            out.push(`${s.file}: ${name}`);
          }
        }
      }
      for (const m of s.text.matchAll(/import\s+\*\s+as\s+\w+\s+from\s*["']([^"']+)["']/g)) {
        if (/^@countersign\/llm$|runs\/execute$/.test(m[1] ?? ""))
          out.push(`${s.file}: * from ${m[1]}`);
      }
      for (const m of s.text.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) {
        if (/^@countersign\/llm$|runs\/execute$/.test(m[1] ?? ""))
          out.push(`${s.file}: import(${m[1]})`);
      }
      return out;
    });
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
