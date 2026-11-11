// Record/replay (plan §1.2 "LLM record/replay"). A request is identified by the hash of its
// canonical JSON; `record` stores the API's answer under that hash and `replay` answers from it,
// failing loudly when there is nothing recorded. Storage is an interface so this module stays
// free of Node APIs; the file-backed store is in ./node.ts.

import { canonicalJson, sha256Hex } from "@countersign/core";
import type { EmbedFn, EmbedRequest, EmbedResponse } from "./embeddings";
import type { LlmMessage, LlmRequest, LlmTransport } from "./transport";

export const LLM_MODES = ["live", "record", "replay"] as const;
export type LlmMode = (typeof LLM_MODES)[number];

/** `LLM_MODE` from the environment, or the fallback when it is unset. A typo is an error. */
export function parseLlmMode(value: string | undefined, fallback: LlmMode): LlmMode {
  const v = value?.trim();
  if (!v) return fallback;
  if ((LLM_MODES as readonly string[]).includes(v)) return v as LlmMode;
  throw new Error(`LLM_MODE must be one of ${LLM_MODES.join(", ")}; got ${JSON.stringify(v)}`);
}

/**
 * The parts of a request that decide the answer. `max_tokens`, metadata and other transport
 * settings are left out so tuning them does not invalidate every fixture.
 */
// DECISION: the hash covers (model, system, messages, tools, tool_choice) per plan §1.2, plus
// output_config, since a different structured-output format or effort changes the answer.
export function hashedPart(request: LlmRequest): Record<string, unknown> {
  return {
    model: request.model,
    system: request.system,
    messages: request.messages,
    tools: request.tools,
    tool_choice: request.tool_choice,
    output_config: request.output_config,
  };
}

export function requestHash(request: LlmRequest): Promise<string> {
  return sha256Hex(canonicalJson(hashedPart(request)));
}

export interface RecordedCall {
  readonly hash: string;
  readonly recordedAt: string;
  /** What was hashed, kept for reading a fixture and for diffing a miss. */
  readonly request: Record<string, unknown>;
  readonly response: LlmMessage;
  /** Written by hand (no API key), not recorded from the provider. */
  readonly handWritten?: boolean;
}

/**
 * §1.88: an embedding call, kept in the same store. Its hash covers `kind`, the model, the texts
 * and the size, so it never meets a message call's hash.
 */
export interface RecordedEmbedding {
  readonly hash: string;
  readonly recordedAt: string;
  readonly kind: "embedding";
  readonly request: EmbeddingHashedPart;
  readonly response: EmbedResponse;
  readonly handWritten?: boolean;
}

export type RecordedEntry = RecordedCall | RecordedEmbedding;

export function isRecordedEmbedding(entry: RecordedEntry): entry is RecordedEmbedding {
  return (entry as { kind?: unknown }).kind === "embedding";
}

export interface EmbeddingHashedPart {
  readonly kind: "embedding";
  readonly model: string;
  readonly input: readonly string[];
  readonly dimensions: number;
}

export function embeddingHashedPart(request: EmbedRequest): EmbeddingHashedPart {
  return {
    kind: "embedding",
    model: request.model,
    input: [...request.input],
    dimensions: request.dimensions,
  };
}

export function embeddingRequestHash(request: EmbedRequest): Promise<string> {
  return sha256Hex(canonicalJson(embeddingHashedPart(request)));
}

export interface FixtureStore {
  read(hash: string): Promise<RecordedEntry | null>;
  write(call: RecordedEntry): Promise<void>;
}

export function memoryFixtureStore(initial: readonly RecordedEntry[] = []): FixtureStore & {
  readonly calls: Map<string, RecordedEntry>;
} {
  const calls = new Map(initial.map((c) => [c.hash, c]));
  return {
    calls,
    async read(hash) {
      return calls.get(hash) ?? null;
    },
    async write(call) {
      calls.set(call.hash, call);
    },
  };
}

export class ReplayMissError extends Error {
  override name = "ReplayMissError";
  readonly hash: string;
  readonly model: string;
  constructor(hash: string, model: string) {
    super(
      `LLM replay miss: no recorded response for request ${hash} (model ${model}). ` +
        "Record it with LLM_MODE=record, or check what changed in the prompt.",
    );
    this.hash = hash;
    this.model = model;
  }
}

export interface RecordingOptions {
  readonly mode: LlmMode;
  readonly store?: FixtureStore;
  /** For `recordedAt`; tests pass a fixed clock. */
  readonly now?: () => Date;
}

/**
 * Wrap a transport in a mode. `live` returns it unchanged; `record` calls it and stores the
 * answer; `replay` never calls it (pass `null` when there is no live transport, as in tests).
 */
export function withRecording(inner: LlmTransport | null, options: RecordingOptions): LlmTransport {
  const { mode, store } = options;
  const now = options.now ?? (() => new Date());
  if (mode === "live") {
    if (!inner) throw new Error("LLM_MODE=live needs a live transport");
    return inner;
  }
  if (!store) throw new Error(`LLM_MODE=${mode} needs a fixture store`);
  if (mode === "replay") {
    return {
      async create(request) {
        const hash = await requestHash(request);
        const hit = await store.read(hash);
        if (!hit || isRecordedEmbedding(hit)) throw new ReplayMissError(hash, request.model);
        return structuredClone(hit.response);
      },
      // §1.88
      async embed(request) {
        const hash = await embeddingRequestHash(request);
        const hit = await store.read(hash);
        if (!hit || !isRecordedEmbedding(hit)) throw new ReplayMissError(hash, request.model);
        return structuredClone(hit.response);
      },
    };
  }
  if (!inner) throw new Error("LLM_MODE=record needs a live transport");
  return {
    async create(request, opts) {
      const hash = await requestHash(request);
      const response = await inner.create(request, opts);
      await store.write({
        hash,
        recordedAt: now().toISOString(),
        request: hashedPart(request),
        response,
      });
      return response;
    },
    ...(inner.embed
      ? {
          embed: async (request: EmbedRequest, opts?: { signal?: AbortSignal }) => {
            const hash = await embeddingRequestHash(request);
            const response = await (inner.embed as EmbedFn)(request, opts);
            await store.write({
              hash,
              recordedAt: now().toISOString(),
              kind: "embedding",
              request: embeddingHashedPart(request),
              response,
            });
            return response;
          },
        }
      : {}),
  };
}
