// Voice typing (docs/plan.md §1.109): the composer's Dictate button. A click asks for the
// microphone and records; the button shows a running timer and the sound level at once. The words
// arrive while the person speaks: the recording goes out in segments of about five seconds
// (./dictation.ts) and each one's words join the message box in spoken order, while the composer's
// live line shows "Listening…" and any words that wait for an earlier segment's. A second click
// (or two minutes) stops; the last segment is written out and the microphone let go. Nothing is
// sent without the person pressing Send. Hidden where the browser can't record.
import { useEffect, useRef, useState } from "react";
import { Dictation, openMeter } from "./dictation";

export interface VoiceWords {
  dictate: string;
  stop: string;
  listening: string;
  writing: string;
  blocked: string;
  failed: string;
}

export const ENGLISH_VOICE: VoiceWords = {
  dictate: "Dictate",
  stop: "Stop",
  listening: "Listening…",
  writing: "Writing it out…",
  blocked: "Your browser didn't let us use the microphone.",
  failed: "We couldn't write that out. Try again.",
};

export interface Voice {
  /** Writes out a recording; throws with words to show when it can't. */
  transcribe(audio: Blob): Promise<string>;
  words?: Partial<VoiceWords> | undefined;
}

/** What the composer shows under the box while dictating. */
export interface VoiceLive {
  /** Words back already that wait for an earlier segment's. */
  held: string;
  /** "Listening…" while recording, "Writing it out…" once stopped. */
  status: string;
}

/** The type to record in: opus in webm (Chrome, Firefox, Edge), else mp4 (Safari). */
function recordingType(): string | undefined {
  const MR = globalThis.MediaRecorder;
  if (!MR?.isTypeSupported) return undefined;
  return ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find((t) =>
    MR.isTypeSupported(t),
  );
}

export function canRecord(): boolean {
  return (
    typeof globalThis.MediaRecorder !== "undefined" &&
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia
  );
}

type State = { kind: "idle" } | { kind: "recording"; since: number } | { kind: "writing" };

/** The level bar's width for a sound level: speech (about 0.05–0.2) fills most of it. */
const shown = (level: number) => Math.max(0.08, Math.min(1, level * 5));

export function VoiceButton({
  voice,
  disabled,
  onText,
  onLive,
  onDone,
  testId = "voice",
}: {
  voice: Voice;
  disabled?: boolean | undefined;
  /** Each segment's words, in the order they were spoken. */
  onText(text: string): void;
  /** What to show under the box while dictating; null when it's over. */
  onLive?(live: VoiceLive | null): void;
  /** The dictation is over; `wrote` when any words were handed on. */
  onDone?(wrote: boolean): void;
  testId?: string;
}) {
  const w = { ...ENGLISH_VOICE, ...voice.words };
  const [state, setState] = useState<State>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [metered, setMetered] = useState(false);
  const dictation = useRef<Dictation | null>(null);
  const level = useRef<HTMLSpanElement | null>(null);
  // The composer's latest callbacks, for words that come back after it re-rendered.
  const calls = useRef({ onText, onLive, onDone });
  calls.current = { onText, onLive, onDone };

  // A recording left running when the composer goes away is dropped, never sent, and the
  // microphone is let go.
  const gone = useRef(false);
  useEffect(
    () => () => {
      gone.current = true;
      dictation.current?.cancel();
      dictation.current = null;
    },
    [],
  );

  const recording = state.kind === "recording";
  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [recording]);

  if (!canRecord()) return null;

  async function start() {
    setError(null);
    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError(w.blocked);
      return;
    }
    if (gone.current) {
      for (const track of media.getTracks()) track.stop();
      return;
    }
    const meter = openMeter(media);
    let wrote = false;
    let failed = false;
    const d: Dictation = new Dictation({
      stream: media,
      type: recordingType(),
      meter,
      transcribe: (audio) => voice.transcribe(audio),
      onWords(text) {
        wrote = true;
        calls.current.onText(text);
      },
      onLevel(l) {
        if (level.current) level.current.style.transform = `scaleX(${shown(l)})`;
      },
      onChange(live) {
        if (dictation.current !== d) return;
        if (live.error !== undefined && !failed) {
          failed = true;
          const e = live.error;
          setError(e instanceof Error && e.message ? sentence(e.message) : w.failed);
        }
        if (live.phase === "done") {
          dictation.current = null;
          setState({ kind: "idle" });
          calls.current.onLive?.(null);
          calls.current.onDone?.(wrote);
          return;
        }
        if (live.phase === "writing") setState({ kind: "writing" });
        calls.current.onLive?.({
          held: live.held,
          status: live.phase === "recording" ? w.listening : w.writing,
        });
      },
    });
    dictation.current = d;
    setMetered(meter !== null);
    setNow(Date.now());
    setState({ kind: "recording", since: d.since });
    calls.current.onLive?.({ held: "", status: w.listening });
  }

  const seconds = recording ? Math.max(0, Math.floor((now - state.since) / 1000)) : 0;
  return (
    <span className="ui-voice">
      <button
        type="button"
        className="ui-voice__button"
        data-testid={testId}
        data-state={state.kind}
        data-meter={recording && metered ? "on" : undefined}
        aria-pressed={recording}
        disabled={disabled || state.kind === "writing"}
        onClick={() => (recording ? dictation.current?.stop() : void start())}
      >
        {recording ? null : (
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
          >
            <rect x="9" y="3" width="6" height="11" rx="3" />
            <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
          </svg>
        )}
        {recording ? (
          <>
            <span className="ui-voice__dot" aria-hidden="true" />
            <span className="ui-voice__level" aria-hidden="true" data-testid={`${testId}-level`}>
              <span ref={level} />
            </span>
            {w.stop} ·{" "}
            <span className="figures">
              {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
            </span>
          </>
        ) : state.kind === "writing" ? (
          w.writing
        ) : (
          w.dictate
        )}
      </button>
      {error ? (
        <span className="ui-voice__error" role="alert" data-testid={`${testId}-error`}>
          {error}
        </span>
      ) : null}
    </span>
  );
}

/** An API's message as a sentence: capital first, full stop last. */
function sentence(message: string): string {
  const m = message.trim();
  const capped = m.charAt(0).toUpperCase() + m.slice(1);
  return /[.!?…]$/.test(capped) ? capped : `${capped}.`;
}
