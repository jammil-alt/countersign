import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLlmClient } from "./client";
import { FakeModel } from "./fake";
import { fileFixtureStore } from "./node";
import {
  memoryFixtureStore,
  parseLlmMode,
  ReplayMissError,
  requestHash,
  withRecording,
} from "./record";
import type { LlmRequest } from "./transport";

const request: LlmRequest = {
  model: "claude-sonnet-5-5",
  max_tokens: 1000,
  system: "You are terse.",
  messages: [{ role: "user", content: "Say hi." }],
};

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("requestHash", () => {
  it("ignores key order and transport settings, but not the prompt", async () => {
    const reordered = {
      messages: request.messages,
      system: request.system,
      max_tokens: 5,
      model: request.model,
    } as LlmRequest;
    expect(await requestHash(reordered)).toBe(await requestHash(request));
    expect(await requestHash({ ...request, system: "You are verbose." })).not.toBe(
      await requestHash(request),
    );
  });
});

describe("record and replay", () => {
  it("round-trips through the file store: record writes, replay answers without the model", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cs-llm-"));
    dirs.push(dir);
    const store = fileFixtureStore(dir);
    const live = new FakeModel([{ text: "hi", usage: { input: 12, output: 3 } }]);

    const recorder = withRecording(live, { mode: "record", store });
    const recorded = await recorder.create(request);
    expect(live.requests).toHaveLength(1);

    const hash = await requestHash(request);
    expect(await readdir(dir)).toEqual([`${hash}.json`]);

    const replayer = withRecording(null, { mode: "replay", store });
    const replayed = await replayer.create(request);
    expect(replayed).toEqual(recorded);
    expect(live.requests).toHaveLength(1);
  });

  it("gives the same answer and cost through the client in replay as in record", async () => {
    const store = memoryFixtureStore();
    const calls: (string | null)[] = [];
    const record = createLlmClient({
      transport: withRecording(
        new FakeModel([{ text: "hello", usage: { input: 1000, output: 100 } }]),
        {
          mode: "record",
          store,
        },
      ),
      onCall: (r) => void calls.push(r.costUsd),
    });
    const replay = createLlmClient({
      transport: withRecording(null, { mode: "replay", store }),
      onCall: (r) => void calls.push(r.costUsd),
    });
    const input = { system: "You are terse.", messages: request.messages };
    const a = await record.message(input);
    const b = await replay.message(input);
    expect(b.message.content).toEqual(a.message.content);
    expect(calls).toEqual(["0.003000", "0.003000"]);
  });

  it("fails loudly on a replay miss, naming the hash", async () => {
    const store = memoryFixtureStore();
    const replayer = withRecording(null, { mode: "replay", store });
    const hash = await requestHash(request);
    await expect(replayer.create(request)).rejects.toBeInstanceOf(ReplayMissError);
    await expect(replayer.create(request)).rejects.toThrow(hash);
  });

  it("live mode passes straight through and needs a transport", () => {
    const live = new FakeModel();
    expect(withRecording(live, { mode: "live" })).toBe(live);
    expect(() => withRecording(null, { mode: "live" })).toThrow();
    expect(() => withRecording(live, { mode: "record" })).toThrow(/fixture store/);
  });
});

describe("parseLlmMode", () => {
  it("defaults when unset and refuses a typo", () => {
    expect(parseLlmMode(undefined, "replay")).toBe("replay");
    expect(parseLlmMode("", "live")).toBe("live");
    expect(parseLlmMode("record", "replay")).toBe("record");
    expect(() => parseLlmMode("replya", "replay")).toThrow(/LLM_MODE/);
  });
});
