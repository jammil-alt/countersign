// Live dictation (docs/plan.md §1.109, superseded 2026-11-21): the words appear while the person
// speaks. The recording is made in segments of about five seconds: the recorder is stopped and a
// new one started on the same microphone, so each segment is a whole file that can be written out
// on its own (a timeslice chunk of a running recorder isn't). Each finished segment goes to the
// same transcribe route while recording goes on, and its words are handed on in the order they
// were spoken, whatever order the answers come back in. No React here: `VoiceButton` drives it.
//
// DECISION: no second pass over the whole recording at the end. OpenAI prices transcription by the
// minute of audio, so writing the whole recording out again would double the cost of every
// dictation, and it would replace words the person may already have changed in the box. Instead a
// segment ends at a pause where it can (five seconds on, at the first 300 ms of quiet; eight at
// most), so few words are cut in two.
// DECISION: a segment the sound meter heard nothing in (no level over SOUND_LEVEL) isn't sent:
// silence costs a call and comes back as words nobody said ("Thank you."). Where there is no
// meter, or it gave no reading, every segment is sent.
// DECISION: a segment that fails stops the recording. The words before it stay in the box; the
// words after it are dropped, so the box never holds text with a hole in it, and the failure (the
// HIPAA refusal, voice off, a network error) is shown at once, as before.
import { VOICE_MAX_SECONDS } from "@countersign/core";

/** A segment ends at the first pause after this long. */
export const SEGMENT_MS = 5_000;
/** …and after this long, pause or not. At most 60 / 5 = 12 segments a minute. */
export const SEGMENT_MAX_MS = 8_000;
/** This long without sound is a pause. */
export const PAUSE_MS = 300;
/** A level (RMS of the waveform, 0–1) at or over this is someone speaking. */
export const SOUND_LEVEL = 0.01;
const TICK_MS = 100;

/** The words written out joined to what the box holds: one space between, none at the ends. */
export function joinWords(before: string, said: string): string {
  const words = said.trim();
  if (!words) return before;
  const now = before.trimEnd();
  return now ? `${now} ${words}` : words;
}

type Part =
  | { kind: "recording" }
  | { kind: "sent" }
  | { kind: "done"; text: string }
  | { kind: "failed"; error: unknown };

/** Segments' words, handed on in the order they were spoken whatever order they come back in. */
export class InOrder {
  private readonly parts: Part[] = [];
  private next = 0;

  constructor(private readonly onWords: (text: string) => void) {}

  /** A new segment, in spoken order; its place. */
  open(): number {
    this.parts.push({ kind: "recording" });
    return this.parts.length - 1;
  }

  sent(place: number): void {
    if (this.parts[place]?.kind === "recording") this.parts[place] = { kind: "sent" };
  }

  done(place: number, text: string): void {
    const part = this.parts[place];
    if (!part || part.kind === "done" || part.kind === "failed") return;
    this.parts[place] = { kind: "done", text: text.trim() };
    this.flush();
  }

  fail(place: number, error: unknown): void {
    const part = this.parts[place];
    if (!part || part.kind === "done" || part.kind === "failed") return;
    this.parts[place] = { kind: "failed", error };
  }

  /** Hands on every segment's words that no earlier segment is still waiting on. */
  private flush(): void {
    while (this.next < this.limit) {
      const part = this.parts[this.next];
      if (part?.kind !== "done") break;
      if (part.text) this.onWords(part.text);
      this.next++;
    }
  }

  /** The first failed segment: nothing from it on is handed on. */
  private get limit(): number {
    const failed = this.parts.findIndex((p) => p.kind === "failed");
    return failed < 0 ? this.parts.length : failed;
  }

  get broken(): boolean {
    return this.limit < this.parts.length;
  }

  /** What went wrong first, if anything did. */
  get failure(): unknown {
    const part = this.parts[this.limit];
    return part?.kind === "failed" ? part.error : undefined;
  }

  /** Words back already that wait for an earlier segment's, joined. */
  get held(): string {
    let words = "";
    for (let i = this.next; i < this.limit; i++) {
      const part = this.parts[i];
      if (part?.kind === "done") words = joinWords(words, part.text);
    }
    return words;
  }

  /** Every segment before a failure is written out and handed on. */
  get settled(): boolean {
    return this.next === this.limit;
  }
}

/** A sound level from the microphone, 0–1; null when there's no reading. */
export interface Meter {
  read(): number | null;
  close(): void;
}

/** An AnalyserNode on the stream, or null where the browser has none. */
export function openMeter(stream: MediaStream): Meter | null {
  const AC =
    globalThis.AudioContext ??
    (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  try {
    const context = new AC();
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    context.createMediaStreamSource(stream).connect(analyser);
    // Started after the microphone prompt, outside the click: some browsers start it suspended.
    void context.resume().catch(() => {});
    const wave = new Uint8Array(analyser.fftSize);
    return {
      read() {
        // A suspended context reads as silence it didn't hear: no reading.
        if (context.state !== "running") return null;
        analyser.getByteTimeDomainData(wave);
        let sum = 0;
        for (const v of wave) {
          const x = (v - 128) / 128;
          sum += x * x;
        }
        return Math.sqrt(sum / wave.length);
      },
      close() {
        void context.close().catch(() => {});
      },
    };
  } catch {
    return null;
  }
}

export interface LiveState {
  /** Recording; stopped and writing out the rest; or finished (the microphone let go). */
  phase: "recording" | "writing" | "done";
  /** Words back already that wait for an earlier segment's. */
  held: string;
  /** The first segment that failed, if one did. */
  error: unknown;
}

export interface DictationOptions {
  stream: MediaStream;
  /** The recorder's type, when the browser takes one we ask for. */
  type?: string | undefined;
  transcribe(audio: Blob): Promise<string>;
  /** Each segment's words, in spoken order. */
  onWords(text: string): void;
  onChange(state: LiveState): void;
  /** The sound level, about ten times a second, while there's a meter. */
  onLevel?(level: number): void;
  meter?: Meter | null | undefined;
}

interface Segment {
  place: number;
  start: number;
  /** null: no reading from the meter yet. */
  heard: boolean | null;
}

/**
 * One dictation, from the first segment to the last segment's words. Stops itself after
 * VOICE_MAX_SECONDS or when a segment fails; `cancel` drops everything not yet handed on.
 */
export class Dictation {
  readonly since = Date.now();
  private readonly queue: InOrder;
  private recorder: MediaRecorder | null = null;
  private segment: Segment | null = null;
  private lastSound = Number.NEGATIVE_INFINITY;
  private stopping = false;
  private cancelled = false;
  private released = false;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly o: DictationOptions) {
    this.queue = new InOrder((text) => o.onWords(text));
    this.begin();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  get state(): LiveState {
    const phase = !this.stopping
      ? "recording"
      : this.released && this.queue.settled
        ? "done"
        : "writing";
    return { phase, held: this.queue.held, error: this.queue.failure };
  }

  /** The person is done: the last segment is sent, then the microphone is let go. */
  stop(): void {
    if (this.stopping || this.cancelled) return;
    this.stopping = true;
    clearInterval(this.timer);
    if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop();
    else this.release();
    this.changed();
  }

  /** The composer went away: nothing more is sent or handed on, and the microphone is let go. */
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.stopping = true;
    clearInterval(this.timer);
    if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop();
    this.release();
  }

  private tick(): void {
    const now = Date.now();
    const level = this.o.meter?.read() ?? null;
    const segment = this.segment;
    if (level !== null) {
      const sound = level >= SOUND_LEVEL;
      if (sound) this.lastSound = now;
      if (segment) segment.heard = segment.heard === true || sound;
      this.o.onLevel?.(level);
    }
    if (now - this.since >= VOICE_MAX_SECONDS * 1000) {
      this.stop();
      return;
    }
    if (!segment) return;
    const age = now - segment.start;
    const quiet = level === null || now - this.lastSound >= PAUSE_MS;
    if (age >= SEGMENT_MAX_MS || (age >= SEGMENT_MS && quiet)) this.rotate();
  }

  /** A new recorder on the same microphone, then the old one stopped: no gap between them. */
  private rotate(): void {
    const old = this.recorder;
    this.begin();
    old?.stop();
  }

  private begin(): void {
    const rec = new MediaRecorder(
      this.o.stream,
      this.o.type ? { mimeType: this.o.type } : undefined,
    );
    const segment: Segment = { place: this.queue.open(), start: Date.now(), heard: null };
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    rec.onstop = () => this.finished(rec, segment, chunks);
    this.recorder = rec;
    this.segment = segment;
    rec.start();
  }

  private finished(rec: MediaRecorder, segment: Segment, chunks: Blob[]): void {
    if (this.cancelled) return;
    const type = (rec.mimeType || this.o.type || "audio/webm").split(";")[0] || "audio/webm";
    const audio = new Blob(chunks, { type });
    if (audio.size === 0 || segment.heard === false || this.queue.broken) {
      this.queue.done(segment.place, "");
    } else {
      this.queue.sent(segment.place);
      this.o.transcribe(audio).then(
        (text) => {
          if (this.cancelled) return;
          this.queue.done(segment.place, text);
          this.changed();
        },
        (error: unknown) => {
          if (this.cancelled) return;
          this.queue.fail(segment.place, error);
          this.stop();
          this.changed();
        },
      );
    }
    if (this.stopping && rec === this.recorder) this.release();
    this.changed();
  }

  private release(): void {
    if (this.released) return;
    this.released = true;
    for (const track of this.o.stream.getTracks()) track.stop();
    this.o.meter?.close();
  }

  private changed(): void {
    if (!this.cancelled) this.o.onChange(this.state);
  }
}
