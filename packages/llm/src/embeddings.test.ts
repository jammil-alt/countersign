// §1.88: embeddings through OpenAI's transport, routing, record/replay and the client, answered by
// hand-written provider-shaped fixtures (fixtures/llm/providers/openai): no API key here.

import { describe, expect, it } from "vitest";
import { createLlmClient, type LlmCallRecord, UnpricedModelError } from "./client";
import {
  DEFAULT_EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODELS,
  EmbeddingShapeError,
  EmbeddingsNotSupportedError,
  type EmbedRequest,
  embeddingCostOf,
} from "./embeddings";
import { OpenAIError, openaiTransport } from "./openai";
import { isRecordedEmbedding, memoryFixtureStore, ReplayMissError, withRecording } from "./record";
import { ProviderNotConfiguredError, routingTransport } from "./route";
import { fixtureResponse, scriptedFetch } from "./test-fetch";
import type { LlmTransport } from "./transport";

const REQUEST: EmbedRequest = {
  model: EMBEDDING_MODELS.large,
  input: ["3/4 baltic birch plywood 5x5", "#8 x 1-1/4 wood screw"],
  dimensions: 4,
};

describe("OpenAI embeddings", () => {
  it("sends the texts to /v1/embeddings and answers one vector per text, in order", async () => {
    const f = scriptedFetch(fixtureResponse("openai", "embeddings"));
    const t = openaiTransport({ apiKey: "test-key", fetch: f.fn });
    const r = await t.embed?.(REQUEST);
    expect(f.calls[0]?.url).toBe("https://api.openai.com/v1/embeddings");
    expect(f.calls[0]?.headers.authorization).toBe("Bearer test-key");
    expect(f.calls[0]?.body).toEqual({
      model: "text-embedding-3-large",
      input: REQUEST.input,
      dimensions: 4,
      encoding_format: "float",
    });
    expect(r).toEqual({
      model: "text-embedding-3-large",
      embeddings: [
        [0.1, 0.2, 0.3, 0.4],
        [0.5, -0.5, 0.5, -0.5],
      ],
      usage: { inputTokens: 12 },
    });
  });

  it("retries a rate limit, and says so when it gives up", async () => {
    const ok = scriptedFetch(
      fixtureResponse("openai", "embeddings-error-rate-limit"),
      fixtureResponse("openai", "embeddings"),
    );
    const t = openaiTransport({ apiKey: "k", fetch: ok.fn, sleep: async () => {} });
    expect((await t.embed?.(REQUEST))?.embeddings).toHaveLength(2);
    const fail = scriptedFetch(fixtureResponse("openai", "embeddings-error-rate-limit"));
    const t2 = openaiTransport({ apiKey: "k", fetch: fail.fn, maxRetries: 0 });
    const error = await t2.embed?.(REQUEST).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpenAIError);
    expect((error as OpenAIError).kind).toBe("rate_limited");
  });

  it("refuses an answer of the wrong size", async () => {
    const f = scriptedFetch(fixtureResponse("openai", "embeddings"));
    const t = openaiTransport({ apiKey: "k", fetch: f.fn });
    await expect(t.embed?.({ ...REQUEST, dimensions: 8 })).rejects.toBeInstanceOf(
      EmbeddingShapeError,
    );
  });
});

describe("routing and record/replay", () => {
  const fake = (): LlmTransport => ({
    create: () => Promise.reject(new Error("not a message call")),
    embed: async (request) => ({
      model: "text-embedding-3-large",
      embeddings: request.input.map((_, i) => Array.from({ length: request.dimensions }, () => i)),
      usage: { inputTokens: 7 },
    }),
  });

  it("routes an openai: embedding to OpenAI, and refuses where none is configured", async () => {
    const routed = routingTransport({ openai: fake() });
    expect((await routed.embed?.(REQUEST))?.usage.inputTokens).toBe(7);
    const none = routingTransport({ anthropic: { create: fake().create } });
    await expect(none.embed?.(REQUEST)).rejects.toBeInstanceOf(ProviderNotConfiguredError);
    const noEmbed = routingTransport({ openai: { create: fake().create } });
    await expect(noEmbed.embed?.(REQUEST)).rejects.toBeInstanceOf(EmbeddingsNotSupportedError);
  });

  it("records an embedding and replays it; a miss fails loudly", async () => {
    const store = memoryFixtureStore();
    const recorded = await withRecording(fake(), { mode: "record", store }).embed?.(REQUEST);
    expect([...store.calls.values()].every(isRecordedEmbedding)).toBe(true);
    const replay = withRecording(null, { mode: "replay", store });
    expect(await replay.embed?.(REQUEST)).toEqual(recorded);
    await expect(replay.embed?.({ ...REQUEST, input: ["other"] })).rejects.toBeInstanceOf(
      ReplayMissError,
    );
  });
});

describe("the client's embed", () => {
  const vectors = (n: number, dims: number) =>
    Array.from({ length: n }, () => Array.from({ length: dims }, () => 0.25));

  it("embeds at the catalog's size by default, and records its cost", async () => {
    const seen: EmbedRequest[] = [];
    const records: LlmCallRecord[] = [];
    const llm = createLlmClient({
      transport: {
        create: () => Promise.reject(new Error("no")),
        embed: async (request) => {
          seen.push(request);
          return {
            model: "text-embedding-3-large",
            embeddings: vectors(request.input.length, request.dimensions),
            usage: { inputTokens: 1000 },
          };
        },
      },
      onEmbed: (r) => {
        records.push(r);
      },
    });
    const r = await llm.embed({ texts: ["a", "b"], label: "materials.embeddings.write" });
    expect(seen[0]).toMatchObject({ model: DEFAULT_EMBEDDING_MODEL, dimensions: 1024 });
    expect(EMBEDDING_DIMENSIONS).toBe(1024);
    expect(r.embeddings).toHaveLength(2);
    expect(records[0]).toMatchObject({
      model: "openai:text-embedding-3-large",
      ok: true,
      costUsd: "0.000130",
      label: "materials.embeddings.write",
    });
    expect(records[0]?.usage.inputTokens).toBe(1000);
  });

  it("refuses an unpriced model before calling, and records a failed call", async () => {
    let calls = 0;
    const records: LlmCallRecord[] = [];
    const llm = createLlmClient({
      transport: {
        create: () => Promise.reject(new Error("no")),
        embed: async () => {
          calls++;
          throw new Error("boom");
        },
      },
      onEmbed: (r) => {
        records.push(r);
      },
    });
    await expect(llm.embed({ texts: ["a"], model: "openai:unknown" })).rejects.toBeInstanceOf(
      UnpricedModelError,
    );
    expect(calls).toBe(0);
    await expect(llm.embed({ texts: ["a"] })).rejects.toThrow("boom");
    expect(records).toMatchObject([{ ok: false, costUsd: null }]);
  });

  it("prices by input tokens only", () => {
    expect(embeddingCostOf(EMBEDDING_MODELS.small, 1_000_000)).toBe("0.020000");
    expect(embeddingCostOf("openai:nope", 10)).toBeNull();
  });
});
