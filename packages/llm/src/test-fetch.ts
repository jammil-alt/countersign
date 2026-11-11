// Tests only (not exported from the package): a fetch that answers from a script and keeps what it
// was sent, and the provider-shaped answers hand-written in fixtures/llm/providers.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface SentRequest {
  url: string;
  init: RequestInit;
  headers: Record<string, string>;
  body: unknown;
}

export function scriptedFetch(...answers: (Response | Error)[]) {
  const calls: SentRequest[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      init,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)),
    });
    const next = answers.shift();
    if (!next) throw new Error("scriptedFetch: no answer left");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

/** `<repo>/fixtures/llm/providers`. */
export const PROVIDER_FIXTURE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/llm/providers",
);

export interface ProviderFixture {
  handWritten: true;
  about: string;
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

/** A hand-written provider answer, e.g. `providerFixture("xai", "plain")`. */
export function providerFixture(
  provider: "xai" | "gemini" | "openai",
  name: string,
): ProviderFixture {
  return JSON.parse(
    readFileSync(resolve(PROVIDER_FIXTURE_DIR, provider, `${name}.json`), "utf8"),
  ) as ProviderFixture;
}

/** The fixture as the HTTP response the provider would send. */
export function fixtureResponse(provider: "xai" | "gemini" | "openai", name: string): Response {
  const f = providerFixture(provider, name);
  return json(f.body, f.status, f.headers ?? {});
}

/** A sleep that doesn't wait, and the waits it was asked for. */
export function noSleep() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}
