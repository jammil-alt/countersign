// `/f/:token` (docs/plan.md §1.121): the page a contact answers a "Request info" form on. No
// sign-in: the signed link names one request. It shows the client's name, why we ask and the
// questions, saves a draft to finish later, takes files one at a time, lets the person review
// their answers and sends them once. The words are the person's language (the request's), the
// questions as the agent or the operator wrote them.
import {
  buildPath,
  FORM_PAGE_WORDS,
  type FormFile,
  type FormPageView,
  type FormPageWords,
  isEmptyAnswer,
  type Locale,
  type Question,
  routes,
} from "@countersign/core";
import { type ReactNode, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { ApiError, isApiError } from "../api/client";
import { apiRoutes } from "../api/routes";
import { useApi, useApiClient } from "../api/useApi";
import { dateLocaleFor } from "../i18n/format";
import { useI18n } from "../i18n/i18n";
import { Logo } from "../ui/brand";
import { Field, TextArea, TextInput } from "../ui/forms";
import { Button, Card, ErrorNotice, Loading } from "../ui/primitives";

type Answers = Record<string, unknown>;
type Problems = Record<string, string>;

function Frame({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex min-h-screen flex-col items-center gap-8 bg-paper px-4 py-10"
      data-testid="form-page"
    >
      <Logo height={22} />
      <Card className="w-full max-w-xl" pad>
        {children}
      </Card>
    </div>
  );
}

function dateText(iso: string, locale: Locale): string {
  try {
    return new Intl.DateTimeFormat(dateLocaleFor(locale), { dateStyle: "long" }).format(
      new Date(iso),
    );
  } catch {
    return iso.slice(0, 10);
  }
}

/** The server's problems by question, from a refused save or send. */
function problemsOf(error: unknown): Problems | null {
  if (!isApiError(error) || error.status !== 422) return null;
  const body = error.body as { error?: { details?: { problems?: unknown } } } | null;
  const list = body?.error?.details?.problems;
  if (!Array.isArray(list)) return null;
  const out: Problems = {};
  for (const p of list as { question?: string; message?: string }[]) {
    const key = (p.question ?? "").split(".")[0] ?? "";
    if (key && !out[key]) out[key] = p.message ?? "";
  }
  return out;
}

/** What is missing before sending, checked here too so the person sees it at once. */
function missing(questions: readonly Question[], answers: Answers, w: FormPageWords): Problems {
  const out: Problems = {};
  for (const q of questions) {
    if (q.required && isEmptyAnswer(answers[q.id])) out[q.id] = w.needed;
  }
  return out;
}

async function uploadFile(token: string, question: string, file: File): Promise<FormFile> {
  const path = `${buildPath(routes.formFile.path, { token })}?question=${encodeURIComponent(question)}`;
  const route = `POST ${routes.formFile.path}`;
  const form = new FormData();
  form.append("file", file, file.name);
  let res: Response;
  try {
    res = await fetch(path, {
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
  return routes.formFile.response.parse(json).file;
}

function shownAnswer(q: Question, v: unknown, w: FormPageWords): string {
  if (isEmptyAnswer(v)) return w.noAnswer;
  if (typeof v === "boolean") return v ? w.yes : w.no;
  if (q.type === "choice" || q.type === "choices") {
    const one = (x: unknown) =>
      typeof x === "string"
        ? (q.options.find((o) => o.id === x)?.label ?? x)
        : `${w.other}: ${(x as { other?: string }).other ?? ""}`;
    return Array.isArray(v) ? v.map(one).join(", ") : one(v);
  }
  if (q.type === "files") return (v as FormFile[]).map((f) => f.filename).join(", ");
  if (q.type === "rows") {
    return (v as Answers[])
      .map((row) => q.columns.map((c) => shownAnswer(c as Question, row[c.id], w)).join(" · "))
      .join("\n");
  }
  return String(v);
}

function QuestionInput({
  q,
  value,
  onChange,
  w,
  token,
  testId,
}: {
  q: Question;
  value: unknown;
  onChange: (v: unknown) => void;
  w: FormPageWords;
  token: string;
  testId: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  switch (q.type) {
    case "text":
      return (
        <TextInput
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          data-testid={testId}
        />
      );
    case "long_text":
      return (
        <TextArea
          rows={4}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          data-testid={testId}
        />
      );
    case "number":
    case "money":
    case "percent":
      return (
        <TextInput
          inputMode="decimal"
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value.replace(/[^\d.-]/g, ""))}
          data-testid={testId}
        />
      );
    case "date":
      return (
        <TextInput
          type="date"
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          data-testid={testId}
        />
      );
    case "yes_no":
      return (
        <div className="flex gap-4" data-testid={testId}>
          {[true, false].map((b) => (
            <label key={String(b)} className="flex items-center gap-2 text-ink">
              <input
                type="radio"
                className="accent-slate"
                checked={value === b}
                onChange={() => onChange(b)}
              />
              {b ? w.yes : w.no}
            </label>
          ))}
        </div>
      );
    case "choice":
    case "choices": {
      const many = q.type === "choices";
      const list = many ? (Array.isArray(value) ? value : []) : value === undefined ? [] : [value];
      const isOn = (id: string) => list.includes(id);
      const other = list.find((x) => typeof x === "object" && x !== null) as
        | { other: string }
        | undefined;
      const toggle = (id: string) =>
        many ? onChange(isOn(id) ? list.filter((x) => x !== id) : [...list, id]) : onChange(id);
      const setOther = (text: string | null) => {
        const rest = list.filter((x) => typeof x === "string");
        if (text === null) return onChange(many ? rest : undefined);
        return onChange(many ? [...rest, { other: text }] : { other: text });
      };
      return (
        <div className="flex flex-col gap-2" data-testid={testId}>
          {q.options.map((o) => (
            <label key={o.id} className="flex items-center gap-2 text-ink">
              <input
                type={many ? "checkbox" : "radio"}
                className="accent-slate"
                checked={isOn(o.id)}
                onChange={() => toggle(o.id)}
              />
              {o.label}
            </label>
          ))}
          {q.other ? (
            <label className="flex items-center gap-2 text-ink">
              <input
                type={many ? "checkbox" : "radio"}
                className="accent-slate"
                checked={other !== undefined}
                onChange={() => setOther(other ? null : "")}
              />
              {w.other}
              {other !== undefined ? (
                <TextInput
                  value={other.other}
                  placeholder={w.otherPlaceholder}
                  onChange={(e) => setOther(e.target.value)}
                />
              ) : null}
            </label>
          ) : null}
        </div>
      );
    }
    case "files": {
      const files = Array.isArray(value) ? (value as FormFile[]) : [];
      const accept = q.accept
        .map((k) =>
          k === "pdf"
            ? "application/pdf"
            : k === "spreadsheet"
              ? ".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              : "image/*",
        )
        .join(",");
      return (
        <div className="flex flex-col gap-2" data-testid={testId}>
          {files.map((f) => (
            <div key={f.documentId} className="flex items-center justify-between gap-3 text-ink">
              <span className="truncate">{f.filename}</span>
              <Button
                variant="ghost"
                onClick={() => onChange(files.filter((x) => x.documentId !== f.documentId))}
              >
                {w.remove}
              </Button>
            </div>
          ))}
          {files.length < q.max ? (
            <label className="ds-btn self-start">
              {busy ? w.uploading : w.addFiles}
              <input
                type="file"
                className="sr-only"
                accept={accept}
                disabled={busy}
                data-testid={`${testId}-input`}
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (!file) return;
                  setBusy(true);
                  setError(null);
                  try {
                    const added = await uploadFile(token, q.id, file);
                    onChange([...files, added]);
                  } catch (err) {
                    setError(err);
                  } finally {
                    setBusy(false);
                  }
                }}
              />
            </label>
          ) : null}
          {error ? <ErrorNotice error={error} /> : null}
        </div>
      );
    }
    case "rows": {
      const rows = Array.isArray(value) ? (value as Answers[]) : [];
      const set = (i: number, key: string, v: unknown) =>
        onChange(rows.map((r, j) => (j === i ? { ...r, [key]: v } : r)));
      return (
        <div className="flex flex-col gap-3" data-testid={testId}>
          {rows.map((row, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id of their own.
            <div key={i} className="flex flex-col gap-2 rounded-md border border-line p-3">
              {q.columns.map((c) => (
                <Field key={c.id} label={c.label}>
                  <QuestionInput
                    q={c as Question}
                    value={row[c.id]}
                    onChange={(v) => set(i, c.id, v)}
                    w={w}
                    token={token}
                    testId={`${testId}-${i}-${c.id}`}
                  />
                </Field>
              ))}
              <Button
                variant="ghost"
                className="self-start"
                onClick={() => onChange(rows.filter((_, j) => j !== i))}
              >
                {w.removeRow}
              </Button>
            </div>
          ))}
          {rows.length < q.max ? (
            <Button className="self-start" onClick={() => onChange([...rows, {}])}>
              {w.addRow}
            </Button>
          ) : null}
        </div>
      );
    }
  }
}

export function FormPageScreen() {
  const reader = useI18n().locale;
  const api = useApiClient();
  const { token = "" } = useParams();
  const wellFormed = token.length >= 10 && token.length <= 2000;
  const view = useApi(apiRoutes.formView, wellFormed ? { params: { token }, cache: "none" } : null);
  const [answers, setAnswers] = useState<Answers | null>(null);
  const [problems, setProblems] = useState<Problems>({});
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const [sent, setSent] = useState(false);

  const v: FormPageView | null = view.data ?? null;
  useEffect(() => {
    if (v && answers === null) setAnswers(v.answers);
  }, [v, answers]);

  const w = FORM_PAGE_WORDS[v?.language ?? reader] ?? FORM_PAGE_WORDS.en;

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
        <p className="text-ink" data-testid="form-gone">
          {gone ? w.notFound : null}
        </p>
        {!gone && view.error ? <ErrorNotice error={view.error} onRetry={view.reload} /> : null}
      </Frame>
    );
  }
  if (sent || v.state === "submitted") {
    return (
      <Frame>
        <h1 className="type-heading text-ink">{w.thanksTitle}</h1>
        <p className="mt-2 text-ink" data-testid="form-thanks">
          {w.thanksText(v.client)}
        </p>
      </Frame>
    );
  }
  if (v.state === "closed") {
    return (
      <Frame>
        <h1 className="type-heading text-ink">{w.closedTitle}</h1>
        <p className="mt-2 text-ink" data-testid="form-closed">
          {w.closedText(v.client)}
        </p>
      </Frame>
    );
  }

  const current = answers ?? v.answers;
  const set = (id: string, value: unknown) => {
    setSaved(false);
    setAnswers({ ...current, [id]: value });
    if (problems[id]) {
      const { [id]: _gone, ...rest } = problems;
      setProblems(rest);
    }
  };

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.call(apiRoutes.formSave, { params: { token }, body: { answers: current } });
      setSaved(true);
    } catch (err) {
      const p = problemsOf(err);
      if (p) setProblems(p);
      else setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    setBusy(true);
    setError(null);
    try {
      await api.call(apiRoutes.formSubmit, { params: { token }, body: { answers: current } });
      setSent(true);
    } catch (err) {
      const p = problemsOf(err);
      if (p) {
        setProblems(p);
        setReviewing(false);
      } else setError(err);
    } finally {
      setBusy(false);
    }
  }

  function review() {
    const p = missing(v?.questions ?? [], current, w);
    setProblems(p);
    if (Object.keys(p).length === 0) setReviewing(true);
  }

  const head = (
    <>
      <p className="eyebrow text-ink-muted">{w.askedBy(v.client)}</p>
      <h1 className="type-heading text-ink" data-testid="form-title">
        {v.title}
      </h1>
      <p className="mt-2 text-ink">{v.purpose}</p>
      {v.intro ? <p className="mt-2 text-ink">{v.intro}</p> : null}
      <p className="mt-2 text-sm text-ink-muted">{w.dueBy(dateText(v.dueAt, v.language))}</p>
    </>
  );

  if (reviewing) {
    return (
      <Frame>
        {head}
        <p className="mt-5 text-ink">{w.checkAnswers}</p>
        <dl className="mt-4 flex flex-col gap-3" data-testid="form-review">
          {v.questions.map((q) => (
            <div key={q.id}>
              <dt className="text-sm font-medium text-ink">{q.label}</dt>
              <dd className="whitespace-pre-line text-ink-muted">
                {shownAnswer(q, current[q.id], w)}
              </dd>
            </div>
          ))}
        </dl>
        {error ? (
          <div className="mt-4">
            <ErrorNotice error={error} />
          </div>
        ) : null}
        <div className="mt-5 flex flex-wrap gap-3">
          <Button
            variant="primary"
            onClick={() => void send()}
            disabled={busy}
            data-testid="form-send"
          >
            {w.submit}
          </Button>
          <Button variant="ghost" onClick={() => setReviewing(false)} disabled={busy}>
            {w.back}
          </Button>
        </div>
      </Frame>
    );
  }

  return (
    <Frame>
      {head}
      <div className="mt-5 flex flex-col gap-5">
        {v.questions.map((q) => (
          <Field
            key={q.id}
            label={
              <>
                {q.label}{" "}
                <span className="text-sm font-normal text-ink-muted">
                  {q.required ? w.required : w.optional}
                </span>
              </>
            }
            hint={q.help}
            error={problems[q.id]}
            testId={`form-q-${q.id}`}
          >
            <QuestionInput
              q={q}
              value={current[q.id]}
              onChange={(value) => set(q.id, value)}
              w={w}
              token={token}
              testId={`form-q-${q.id}`}
            />
          </Field>
        ))}
      </div>
      {error ? (
        <div className="mt-4">
          <ErrorNotice error={error} />
        </div>
      ) : null}
      {saved ? (
        <p className="mt-4 text-sm text-ink-muted" data-testid="form-saved">
          {w.saved}
        </p>
      ) : null}
      <div className="mt-5 flex flex-wrap gap-3">
        <Button variant="primary" onClick={review} disabled={busy} data-testid="form-review-button">
          {w.review}
        </Button>
        <Button variant="ghost" onClick={() => void save()} disabled={busy} data-testid="form-save">
          {w.save}
        </Button>
      </div>
    </Frame>
  );
}
