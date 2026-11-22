// `/i/:token` (docs/plan.md §1.217): the page a client's contact answers a process interview on.
// No sign-in: the signed link names one interview. It shows the client's name and the process, the
// questions so far with the answers, and the one question waiting. The person answers it, says a
// number is an estimate, or says they don't know; adds sample files; and finishes when the
// interviewer has what it needs (or whenever they want). Loaded on its own, never in the app.
// DECISION: the page reads in English for now; the six languages are a follow-up, as the form
// page's were.
import {
  buildPath,
  INTERVIEW_ANSWER_MAX,
  type InterviewPageView,
  interviewRoutes,
} from "@countersign/core";
import { type ReactNode, useState } from "react";
import { useParams } from "react-router-dom";
import { ApiError, isApiError } from "../api/client";
import { useApi, useApiClient } from "../api/useApi";
import { Logo } from "../ui/brand";
import { Field, TextArea } from "../ui/forms";
import { Button, Card, ErrorNotice, Loading } from "../ui/primitives";

function Frame({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex min-h-screen flex-col items-center gap-8 bg-paper px-4 py-10"
      data-testid="interview-page"
    >
      <Logo height={22} />
      <Card className="w-full max-w-xl" pad>
        {children}
      </Card>
    </div>
  );
}

async function uploadFile(token: string, file: File): Promise<void> {
  const spec = interviewRoutes.interviewFile;
  const route = `POST ${spec.path}`;
  const form = new FormData();
  form.append("file", file, file.name);
  let res: Response;
  try {
    res = await fetch(buildPath(spec.path, { token }), {
      method: "POST",
      body: form,
      headers: { accept: "application/json" },
    });
  } catch (cause) {
    throw new ApiError({ status: 0, code: "network", message: "Offline.", route, cause });
  }
  const json = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError({
      status: res.status,
      code: err?.code ?? `http_${res.status}`,
      message: err?.message ?? `The upload failed (${res.status}).`,
      route,
      body: json,
    });
  }
}

/** The questions and answers so far, oldest first. */
function Transcript({ v }: { v: InterviewPageView }) {
  // The waiting question is shown on its own below, not twice.
  const turns = v.question && v.turns.at(-1)?.role === "agent" ? v.turns.slice(0, -1) : v.turns;
  if (turns.length === 0) return null;
  return (
    <ol className="flex flex-col gap-3" data-testid="interview-transcript">
      {turns.map((t, i) =>
        t.role === "agent" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: turns are append-only, in order
          <li key={i} className="text-ink">
            {t.text}
          </li>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: turns are append-only, in order
          <li key={i} className="border-line border-l-2 pl-3 text-ink-muted">
            {t.skipped ? "I don't know." : t.text}
            {t.estimate ? <span className="ml-2 text-ink-faint">(an estimate)</span> : null}
          </li>
        ),
      )}
    </ol>
  );
}

export function InterviewPageScreen() {
  const api = useApiClient();
  const { token = "" } = useParams();
  const wellFormed = token.length >= 10 && token.length <= 2000;
  const view = useApi(
    interviewRoutes.interviewView,
    wellFormed ? { params: { token }, cache: "none" } : null,
  );
  const [latest, setLatest] = useState<InterviewPageView | null>(null);
  const [text, setText] = useState("");
  const [estimate, setEstimate] = useState(false);
  const [busy, setBusy] = useState<"answer" | "skip" | "finish" | "file" | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [added, setAdded] = useState<string[]>([]);

  const v = latest ?? view.data ?? null;

  if (wellFormed && view.loading && !v) {
    return (
      <Frame>
        <Loading />
      </Frame>
    );
  }
  if (!v) {
    const gone = !wellFormed || (isApiError(view.error) && view.error.status === 404);
    return (
      <Frame>
        <p className="text-ink" data-testid="interview-gone">
          {gone ? "This link has expired or doesn't exist." : null}
        </p>
        {!gone && view.error ? <ErrorNotice error={view.error} onRetry={view.reload} /> : null}
      </Frame>
    );
  }
  if (v.state === "finished") {
    return (
      <Frame>
        <h1 className="type-heading text-ink">Thank you</h1>
        <p className="mt-2 text-ink" data-testid="interview-thanks">
          We have what we need about {v.process.toLowerCase()}. {v.client} will be in touch if
          anything is still open.
        </p>
      </Frame>
    );
  }
  if (v.state === "closed") {
    return (
      <Frame>
        <h1 className="type-heading text-ink">This interview is closed</h1>
        <p className="mt-2 text-ink" data-testid="interview-closed">
          It no longer takes answers. Ask {v.client} if you'd like to add something.
        </p>
      </Frame>
    );
  }

  async function act(kind: "answer" | "skip" | "finish") {
    setBusy(kind);
    setError(null);
    try {
      const next =
        kind === "finish"
          ? await api.call(interviewRoutes.interviewFinish, { params: { token } })
          : await api.call(interviewRoutes.interviewAnswer, {
              params: { token },
              body: kind === "skip" ? { skip: true } : { text, estimate },
            });
      setLatest(next);
      setText("");
      setEstimate(false);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  async function addFile(file: File) {
    setBusy("file");
    setError(null);
    try {
      await uploadFile(token, file);
      setAdded((a) => [...a, file.name]);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  const files = [...v.files.map((f) => f.filename), ...added];
  const working = busy !== null;
  return (
    <Frame>
      <p className="text-ink-muted text-sm">{v.client}</p>
      <h1 className="type-heading text-ink">{v.process}</h1>
      <p className="mt-2 text-ink">
        A few questions about how this works today, one at a time. A rough number is fine, and so is
        "I don't know".
      </p>
      <div className="mt-6 flex flex-col gap-6">
        <Transcript v={v} />
        {v.question ? (
          <div className="flex flex-col gap-3" data-testid="interview-question">
            <Field label={v.question}>
              <TextArea
                value={text}
                maxLength={INTERVIEW_ANSWER_MAX}
                rows={4}
                autoSize
                onChange={(e) => setText(e.target.value)}
                disabled={working}
                data-testid="interview-answer"
              />
            </Field>
            <label className="flex items-start gap-2 text-ink">
              <input
                type="checkbox"
                className="mt-0.5 size-4 shrink-0 accent-slate"
                checked={estimate}
                onChange={(e) => setEstimate(e.target.checked)}
                disabled={working}
              />
              The numbers are an estimate
            </label>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                onClick={() => void act("answer")}
                disabled={!text.trim()}
                working={busy === "answer"}
              >
                Answer
              </Button>
              <Button onClick={() => void act("skip")} working={busy === "skip"} disabled={working}>
                I don't know
              </Button>
            </div>
          </div>
        ) : (
          <p className="text-ink" data-testid="interview-done">
            That's everything we need. Finish to send it.
          </p>
        )}
        <div className="flex flex-col gap-2">
          <p className="text-ink">
            Have an example? Add a sample file: a PDF, an image or a spreadsheet.
          </p>
          {files.length > 0 ? (
            <ul className="text-ink-muted text-sm" data-testid="interview-files">
              {files.map((f, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: two files may share a name
                <li key={i}>{f}</li>
              ))}
            </ul>
          ) : null}
          {files.length < v.maxFiles ? (
            <input
              type="file"
              accept=".pdf,image/*,.csv,.xlsx,.json"
              disabled={working}
              data-testid="interview-file"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void addFile(f);
              }}
            />
          ) : null}
        </div>
        {error ? <ErrorNotice error={error} /> : null}
        <div className="flex items-center justify-between gap-2 border-line border-t pt-4">
          <span className="text-ink-muted text-sm">
            {v.answered} of at most {v.maxAnswers} answered
          </span>
          <Button
            variant={v.question ? "secondary" : "primary"}
            onClick={() => void act("finish")}
            working={busy === "finish"}
            disabled={working || v.answered === 0}
          >
            Finish
          </Button>
        </div>
      </div>
    </Frame>
  );
}
