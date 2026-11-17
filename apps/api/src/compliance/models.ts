// The one way apps/api gets a model transport or speech-to-text outside a run's deps (HIPAA mode,
// docs/plan.md §1.35). Each one is held to the HIPAA mode of every client whose data its calls
// may carry: a call whose vendor isn't covered for one of them is refused (`ComplianceRefusal`,
// answered as 409 `hipaa`) before anything is sent. A run's own transport is held the same way by
// `forClient` (runs/execute.ts). A test in compliance-models.test.ts keeps every other file from
// making a transport of its own.

import { globalFetch } from "@countersign/connectors";
import { parseCoveredProcessors } from "@countersign/core";
import type { Db, Tx } from "@countersign/db";
import { createOpenAITranscriber, type LlmTransport, type Transcriber } from "@countersign/llm";
import type { Bindings } from "../env";
import type { AppDeps } from "../http";
import { workerTransport } from "../runs/execute";
import { guardModels, guardTranscriber, profileReader } from "./policy";

interface ModelServices {
  deps: AppDeps;
  env: Bindings;
}

export interface ModelScope {
  /**
   * Every client whose data the calls may carry. Empty only for work on no client's data (a
   * template, a shared skill, the back office's own words).
   */
  clients: readonly (string | null | undefined)[];
  /**
   * Where the clients' HIPAA mode is read, at the first call: the request's transaction when the
   * call is made inside it (a Worker's request has one connection), else the database.
   */
  read: Db | Tx;
}

function held<T>(
  services: ModelServices,
  scope: ModelScope,
  inner: T,
  guard: (
    inner: T,
    ids: readonly string[],
    profiles: ReturnType<typeof profileReader>,
    covered: ReturnType<typeof parseCoveredProcessors>,
  ) => T,
): T {
  const ids = [...new Set(scope.clients.filter((id): id is string => !!id))];
  if (ids.length === 0) return inner;
  return guard(
    inner,
    ids,
    profileReader(scope.read),
    parseCoveredProcessors(services.env.BAA_PROCESSORS),
  );
}

/**
 * The model transport for the Builder, Reggie, questions and the cron's own calls: the app's
 * (tests pass a FakeModel), else the Worker's live one.
 */
export function clientModels(
  services: ModelServices,
  scope: ModelScope,
  /** Audit 4.1: the cron's own calls pass a short time limit and no retries. */
  http: { timeoutMs?: number; maxRetries?: number } = {},
): LlmTransport {
  const inner = services.deps.llm?.(services.env) ?? workerTransport(services.env, http);
  return held(services, scope, inner, guardModels);
}

/** The transport that reads documents in the background; null when no model key is set. */
export function clientExtractionModels(
  services: ModelServices,
  scope: ModelScope,
): LlmTransport | null {
  const inner = services.deps.extractionTransport(services.env);
  return inner ? held(services, scope, inner, guardModels) : null;
}

/** Whether documents are read on arrival at all (a model key is set): nothing is sent. */
export function readsDocuments(services: ModelServices): boolean {
  return services.deps.extractionTransport(services.env) !== null;
}

/** The transport that translates messages outside a run; left out, the extraction transport. */
export function clientTranslationModels(
  services: ModelServices,
  scope: ModelScope,
): LlmTransport | null {
  const inner = services.deps.translationTransport
    ? services.deps.translationTransport(services.env)
    : services.deps.extractionTransport(services.env);
  return inner ? held(services, scope, inner, guardModels) : null;
}

/**
 * §1.109: voice typing's speech-to-text; default OpenAI's on OPENAI_API_KEY, null without it
 * (voice typing is then off).
 */
export function clientTranscriber(services: ModelServices, scope: ModelScope): Transcriber | null {
  const key = services.env.OPENAI_API_KEY?.trim();
  const inner = services.deps.transcriber
    ? services.deps.transcriber(services.env)
    : key
      ? createOpenAITranscriber({ apiKey: key, fetch: globalFetch() as unknown as typeof fetch })
      : null;
  return inner ? held(services, scope, inner, guardTranscriber) : null;
}
