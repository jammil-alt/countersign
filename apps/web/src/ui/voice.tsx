// Voice typing (docs/plan.md §1.109): the composer's Dictate button. A click asks for the
// microphone and records; a second click (or two minutes) stops, the recording is written out, and
// the words land in the message box to read and change before they're sent. Nothing is sent
// without the person pressing Send. Hidden where the browser can't record.
import { VOICE_MAX_SECONDS } from "@countersign/core";
import { useEffect, useRef, useState } from "react";

export interface VoiceWords {
  dictate: string;
  stop: string;
  writing: string;
  blocked: string;
  failed: string;
}

export const ENGLISH_VOICE: VoiceWords = {
  dictate: "Dictate",
  stop: "Stop",
  writing: "Writing it out…",
  blocked: "Your browser didn't let us use the microphone.",
  failed: "We couldn't write that out. Try again.",
};

export interface Voice {
  /** Writes out a recording; throws with words to show when it can't. */
  transcribe(audio: Blob): Promise<string>;
  words?: Partial<VoiceWords> | undefined;
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

export function VoiceButton({
  voice,
  disabled,
  onText,
  testId = "voice",
}: {
  voice: Voice;
  disabled?: boolean | undefined;
  onText(text: string): void;
  testId?: string;
}) {
  const w = { ...ENGLISH_VOICE, ...voice.words };
  const [state, setState] = useState<State>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);

  const release = () => {
    for (const track of stream.current?.getTracks() ?? []) track.stop();
    stream.current = null;
  };
  // A recording left running when the composer goes away is dropped, never sent, and the
  // microphone is let go.
  const gone = useRef(false);
  useEffect(
    () => () => {
      gone.current = true;
      if (recorder.current?.state === "recording") recorder.current.stop();
      for (const track of stream.current?.getTracks() ?? []) track.stop();
      stream.current = null;
    },
    [],
  );

  const recording = state.kind === "recording";
  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => {
      setNow(Date.now());
      if (state.kind === "recording" && Date.now() - state.since >= VOICE_MAX_SECONDS * 1000) {
        recorder.current?.stop();
      }
    }, 250);
    return () => clearInterval(t);
  }, [recording, state]);

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
    stream.current = media;
    const type = recordingType();
    const rec = new MediaRecorder(media, type ? { mimeType: type } : undefined);
    chunks.current = [];
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.current.push(e.data);
    };
    rec.onstop = async () => {
      release();
      const audio = new Blob(chunks.current, {
        type: (rec.mimeType || type || "audio/webm").split(";")[0] ?? "audio/webm",
      });
      chunks.current = [];
      if (gone.current) return;
      if (audio.size === 0) {
        setState({ kind: "idle" });
        return;
      }
      setState({ kind: "writing" });
      try {
        const text = (await voice.transcribe(audio)).trim();
        if (text) onText(text);
      } catch (e) {
        setError(e instanceof Error && e.message ? sentence(e.message) : w.failed);
      } finally {
        setState({ kind: "idle" });
      }
    };
    recorder.current = rec;
    rec.start();
    setNow(Date.now());
    setState({ kind: "recording", since: Date.now() });
  }

  const seconds = recording ? Math.max(0, Math.floor((now - state.since) / 1000)) : 0;
  return (
    <span className="ui-voice">
      <button
        type="button"
        className="ui-voice__button"
        data-testid={testId}
        data-state={state.kind}
        aria-pressed={recording}
        disabled={disabled || state.kind === "writing"}
        onClick={() => (recording ? recorder.current?.stop() : void start())}
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
