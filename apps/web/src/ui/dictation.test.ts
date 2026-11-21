// Live dictation (docs/plan.md §1.109, 2026-11-21), against a fake recorder and a fake transcribe:
// segments of about five seconds, each a whole recording of its own, their words handed on in
// spoken order whatever order they come back in, and a failed segment stopping the rest.
import { VOICE_MAX_SECONDS } from "@countersign/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Dictation,
  InOrder,
  joinWords,
  type LiveState,
  type Meter,
  PAUSE_MS,
  SEGMENT_MAX_MS,
  SEGMENT_MS,
} from "./dictation";

class FakeRecorder {
  static all: FakeRecorder[] = [];
  readonly n = FakeRecorder.all.length;
  mimeType: string;
  state = "inactive";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(
    readonly stream: unknown,
    options?: { mimeType?: string },
  ) {
    this.mimeType = options?.mimeType ?? "";
    FakeRecorder.all.push(this);
  }
  start() {
    this.state = "recording";
  }
  stop() {
    if (this.state === "inactive") return;
    this.state = "inactive";
    // Each segment's bytes say which recorder made them.
    this.ondataavailable?.({ data: new Blob([`segment ${this.n}`], { type: "audio/webm" }) });
    this.onstop?.();
  }
}

function deferred() {
  let resolve!: (text: string) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const stopTrack = vi.fn();
const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;

beforeEach(() => {
  vi.useFakeTimers();
  FakeRecorder.all = [];
  stopTrack.mockReset();
  vi.stubGlobal("MediaRecorder", FakeRecorder);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A dictation whose segments wait, each, for the test to answer it. */
function dictate(meter?: Meter) {
  const calls: { audio: Blob; answer: ReturnType<typeof deferred> }[] = [];
  const words: string[] = [];
  const states: LiveState[] = [];
  const d = new Dictation({
    stream,
    type: "audio/webm;codecs=opus",
    meter,
    transcribe(audio) {
      const answer = deferred();
      calls.push({ audio, answer });
      return answer.promise;
    },
    onWords: (text) => words.push(text),
    onChange: (state) => states.push(state),
  });
  return { d, calls, words, states, last: () => states.at(-1) };
}

describe("joinWords", () => {
  it("puts one space between, none at the ends, and skips empty words", () => {
    expect(joinWords("", "  hello ")).toBe("hello");
    expect(joinWords("Please  ", "add a step")).toBe("Please add a step");
    expect(joinWords("Please\n", "add")).toBe("Please add");
    expect(joinWords("Please ", "   ")).toBe("Please ");
  });
});

describe("InOrder", () => {
  it("hands words on in spoken order, holding the ones that come back early", () => {
    const out: string[] = [];
    const q = new InOrder((t) => out.push(t));
    const [a, b, c] = [q.open(), q.open(), q.open()];
    q.sent(a);
    q.sent(b);
    q.sent(c);
    q.done(c, " three ");
    q.done(b, "two");
    expect(out).toEqual([]);
    expect(q.held).toBe("two three");
    expect(q.settled).toBe(false);
    q.done(a, "one");
    expect(out).toEqual(["one", "two", "three"]);
    expect(q.held).toBe("");
    expect(q.settled).toBe(true);
  });

  it("skips a segment with no words and hands each segment on once", () => {
    const out: string[] = [];
    const q = new InOrder((t) => out.push(t));
    const [a, b] = [q.open(), q.open()];
    q.done(a, "  ");
    q.done(b, "two");
    q.done(b, "again");
    expect(out).toEqual(["two"]);
  });

  it("keeps the words before a failed segment and drops the ones after it", () => {
    const out: string[] = [];
    const q = new InOrder((t) => out.push(t));
    const [a, b, c] = [q.open(), q.open(), q.open()];
    const error = new Error("voice typing isn't set up here");
    q.done(c, "three");
    q.fail(b, error);
    expect(q.failure).toBe(error);
    expect(q.broken).toBe(true);
    expect(q.held).toBe("");
    expect(q.settled).toBe(false);
    q.done(a, "one");
    expect(out).toEqual(["one"]);
    expect(q.settled).toBe(true);
  });
});

describe("Dictation", () => {
  it("records in segments of five seconds, each a whole recording, sent while recording goes on", async () => {
    const { d, calls, words, last } = dictate();
    expect(FakeRecorder.all).toHaveLength(1);
    expect(FakeRecorder.all[0]?.mimeType).toBe("audio/webm;codecs=opus");
    vi.advanceTimersByTime(SEGMENT_MS - 100);
    expect(calls).toHaveLength(0);
    vi.advanceTimersByTime(100);
    // A new recorder on the same microphone, the first one stopped and its recording sent.
    expect(FakeRecorder.all).toHaveLength(2);
    expect(FakeRecorder.all[1]?.stream).toBe(stream);
    expect(FakeRecorder.all[0]?.state).toBe("inactive");
    expect(FakeRecorder.all[1]?.state).toBe("recording");
    expect(calls).toHaveLength(1);
    expect(await calls[0]?.audio.text()).toBe("segment 0");
    expect(calls[0]?.audio.type).toBe("audio/webm");
    expect(stopTrack).not.toHaveBeenCalled();

    calls[0]?.answer.resolve("Add a step");
    await vi.advanceTimersByTimeAsync(0);
    expect(words).toEqual(["Add a step"]);
    expect(last()?.phase).toBe("recording");

    vi.advanceTimersByTime(SEGMENT_MS);
    expect(calls).toHaveLength(2);
    expect(await calls[1]?.audio.text()).toBe("segment 1");
    d.stop();
    // The last segment is sent and the microphone let go; it isn't over until its words are in.
    expect(calls).toHaveLength(3);
    expect(await calls[2]?.audio.text()).toBe("segment 2");
    expect(stopTrack).toHaveBeenCalled();
    expect(last()?.phase).toBe("writing");
    calls[1]?.answer.resolve("that emails AP");
    calls[2]?.answer.resolve("every Monday.");
    await vi.advanceTimersByTimeAsync(0);
    expect(words).toEqual(["Add a step", "that emails AP", "every Monday."]);
    expect(last()?.phase).toBe("done");
  });

  it("hands words on in spoken order when the answers come back out of order", async () => {
    const { d, calls, words, last } = dictate();
    vi.advanceTimersByTime(SEGMENT_MS * 2);
    d.stop();
    expect(calls).toHaveLength(3);
    calls[2]?.answer.resolve("three");
    await vi.advanceTimersByTimeAsync(0);
    expect(words).toEqual([]);
    expect(last()?.held).toBe("three");
    calls[1]?.answer.resolve("two");
    await vi.advanceTimersByTimeAsync(0);
    expect(last()?.held).toBe("two three");
    calls[0]?.answer.resolve("one");
    await vi.advanceTimersByTimeAsync(0);
    expect(words).toEqual(["one", "two", "three"]);
    expect(last()).toMatchObject({ phase: "done", held: "" });
  });

  it("stops at a failed segment: the words before it stay, the ones after it are dropped", async () => {
    const { calls, words, last } = dictate();
    vi.advanceTimersByTime(SEGMENT_MS * 2);
    expect(calls).toHaveLength(2);
    calls[1]?.answer.resolve("two");
    calls[0]?.answer.resolve("one");
    await vi.advanceTimersByTimeAsync(0);
    expect(words).toEqual(["one", "two"]);

    // The third segment fails after the fourth is sent: recording stops at once.
    vi.advanceTimersByTime(SEGMENT_MS * 2);
    expect(calls).toHaveLength(4);
    const refusal = new Error("voice typing sends data to OpenAI, which has no signed BAA");
    calls[2]?.answer.reject(refusal);
    await vi.advanceTimersByTimeAsync(0);
    expect(stopTrack).toHaveBeenCalled();
    expect(FakeRecorder.all.every((r) => r.state === "inactive")).toBe(true);
    // The segment recording when it failed isn't sent; the fourth's words never land.
    expect(calls).toHaveLength(4);
    calls[3]?.answer.resolve("four");
    await vi.advanceTimersByTimeAsync(0);
    expect(words).toEqual(["one", "two"]);
    expect(last()).toMatchObject({ phase: "done", error: refusal });
    // Nothing more is recorded.
    vi.advanceTimersByTime(SEGMENT_MS * 3);
    expect(FakeRecorder.all).toHaveLength(5);
  });

  it("keeps a failed segment's earlier words waiting until they come back", async () => {
    const { calls, words, last } = dictate();
    vi.advanceTimersByTime(SEGMENT_MS);
    vi.advanceTimersByTime(SEGMENT_MS);
    calls[1]?.answer.reject(new Error("we couldn't write that out: try again"));
    await vi.advanceTimersByTimeAsync(0);
    expect(last()?.phase).toBe("writing");
    expect(last()?.error).toBeInstanceOf(Error);
    expect(String((last()?.error as Error | undefined)?.message)).toMatch(/couldn't write/);
    calls[0]?.answer.resolve("one");
    await vi.advanceTimersByTimeAsync(0);
    expect(words).toEqual(["one"]);
    expect(last()?.phase).toBe("done");
  });

  it("stops itself after two minutes", async () => {
    const { calls, last } = dictate();
    vi.advanceTimersByTime(VOICE_MAX_SECONDS * 1000);
    expect(stopTrack).toHaveBeenCalled();
    expect(calls).toHaveLength(VOICE_MAX_SECONDS / (SEGMENT_MS / 1000));
    expect(last()?.phase).toBe("writing");
    for (const c of calls) c.answer.resolve("x");
    await vi.advanceTimersByTimeAsync(0);
    expect(last()?.phase).toBe("done");
  });

  it("with a meter: ends a segment at a pause, skips silence, and reports the level", async () => {
    let level: number | null = 0.1;
    const close = vi.fn();
    const levels: number[] = [];
    const meter: Meter = { read: () => level, close };
    const calls: Blob[] = [];
    const d = new Dictation({
      stream,
      meter,
      transcribe: async (audio) => {
        calls.push(audio);
        return "x";
      },
      onWords: () => {},
      onChange: () => {},
      onLevel: (l) => levels.push(l),
    });
    // Speaking without a pause: the segment runs on to its longest.
    vi.advanceTimersByTime(SEGMENT_MAX_MS - 100);
    expect(calls).toHaveLength(0);
    expect(levels.at(-1)).toBe(0.1);
    vi.advanceTimersByTime(100);
    expect(calls).toHaveLength(1);
    // Speech, then a pause after five seconds: the segment ends there.
    vi.advanceTimersByTime(SEGMENT_MS);
    expect(calls).toHaveLength(1);
    level = 0;
    vi.advanceTimersByTime(PAUSE_MS + 100);
    expect(calls).toHaveLength(2);
    // A segment of silence isn't sent.
    vi.advanceTimersByTime(SEGMENT_MS + 100);
    expect(FakeRecorder.all).toHaveLength(4);
    expect(calls).toHaveLength(2);
    // No reading (a suspended meter): the segment is sent, at five seconds. (The one under way
    // when the readings stopped had read silence, and isn't.)
    level = null;
    vi.advanceTimersByTime(SEGMENT_MS);
    expect(FakeRecorder.all).toHaveLength(5);
    expect(calls).toHaveLength(2);
    vi.advanceTimersByTime(SEGMENT_MS);
    expect(FakeRecorder.all).toHaveLength(6);
    expect(calls).toHaveLength(3);
    d.stop();
    expect(close).toHaveBeenCalled();
  });

  it("cancelled, it sends nothing more, hands nothing on and lets go of the microphone", async () => {
    const { d, calls, words, states } = dictate();
    vi.advanceTimersByTime(SEGMENT_MS);
    const before = states.length;
    d.cancel();
    expect(stopTrack).toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    calls[0]?.answer.resolve("late");
    await vi.advanceTimersByTimeAsync(SEGMENT_MS * 2);
    expect(words).toEqual([]);
    expect(states.length).toBe(before);
    expect(calls).toHaveLength(1);
  });
});
