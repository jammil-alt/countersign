// builder-plan.md B1: try the draft on real examples, in the POC test. The operator uploads a
// document to the Sandbox (a template) or gives an input, and it runs once as a test that writes
// nothing. The result shows in plain view: Right keeps it as a test case (its result the expected
// answer), Wrong starts "About “…”: " in the conversation so the operator says why and the
// Builder proposes the fix. Kept examples are the default way; model-made cases stay beside them.

import type { BuildDetail, BuildTryView, RouteSpec } from "@countersign/core";
import { useId, useState } from "react";
import type { CallOptions } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { sandboxUploadPath, uploadFiles } from "../../api/upload";
import { ErrorNotice } from "../../ui/ErrorState";
import { TextArea } from "../../ui/forms";
import { Badge, Button, Card } from "../../ui/primitives";

type Act = <R extends RouteSpec>(route: R, opts: CallOptions<R>) => Promise<boolean>;

/** Most lines of one result shown. */
const LINES_MAX = 40;
const VALUE_MAX = 160;

/** A result as lines a person reads: each field by its path, with its value. */
export function plainLines(value: unknown, max = LINES_MAX): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (v: unknown, path: string) => {
    if (out.length >= max) return;
    if (v !== null && typeof v === "object" && Object.keys(v).length > 0) {
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
        walk(child, path ? `${path}.${k}` : k);
      }
      return;
    }
    const text =
      v === null || v === undefined
        ? "nothing"
        : typeof v === "string"
          ? v
          : Array.isArray(v)
            ? "none"
            : typeof v === "object"
              ? "nothing"
              : String(v);
    out.push({
      path: path || "Result",
      text: text.length > VALUE_MAX ? `${text.slice(0, VALUE_MAX - 1)}…` : text,
    });
  };
  walk(value, "");
  return out;
}

function TryRow({
  t,
  live,
  busy,
  act,
  buildId,
  onWrong,
}: {
  t: BuildTryView;
  live: boolean;
  busy: boolean;
  act: Act;
  buildId: string;
  onWrong?: ((name: string) => void) | undefined;
}) {
  const decide = (d: "keep" | "discard") =>
    void act(apiRoutes.opsBuildTryDecide, {
      params: { id: buildId, caseId: t.caseId },
      body: { decide: d },
    });
  const again = () =>
    void act(apiRoutes.opsBuildTry, { params: { id: buildId }, body: { caseId: t.caseId } });
  const lines = t.status === "done" ? plainLines(t.output) : [];
  return (
    <li
      className="flex flex-col gap-3 border-b border-line px-6 py-4 text-sm last:border-b-0"
      data-testid={`build-try-${t.caseId}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-ink">{t.name}</span>
        {t.status === "running" ? (
          <Badge tone="accent">Running</Badge>
        ) : t.status === "error" ? (
          <Badge tone="risk">Stopped</Badge>
        ) : t.current ? (
          <Badge tone="warning">Right or wrong?</Badge>
        ) : (
          <Badge tone="neutral">Older version</Badge>
        )}
      </div>
      {t.status === "running" ? (
        <p className="text-ink-muted">It's running as a test. Nothing is written anywhere.</p>
      ) : t.status === "error" ? (
        <p className="text-ink" data-testid={`build-try-why-${t.caseId}`}>
          {t.why}
        </p>
      ) : (
        <>
          <p className="text-ink-muted">
            {t.current
              ? "What the agent would do:"
              : "What the agent did on an older version. Try it again on this one:"}
          </p>
          <dl
            className="grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)] gap-x-4 gap-y-1 rounded-md border border-line bg-surface-subtle px-3.5 py-2.5"
            data-testid={`build-try-output-${t.caseId}`}
          >
            {lines.map((l) => (
              <div key={l.path} className="contents">
                <dt className="truncate font-mono text-xs text-ink-muted">{l.path}</dt>
                <dd className="m-0 break-words text-ink">{l.text}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
      {live ? (
        <div className="flex flex-wrap gap-2">
          {t.status === "done" && t.current ? (
            <>
              <Button
                size="sm"
                variant="primary"
                disabled={busy}
                onClick={() => decide("keep")}
                data-testid={`build-try-keep-${t.caseId}`}
              >
                Right, keep it
              </Button>
              {onWrong ? (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => onWrong(t.name)}
                  data-testid={`build-try-wrong-${t.caseId}`}
                >
                  Wrong
                </Button>
              ) : null}
            </>
          ) : null}
          {t.status !== "running" && !(t.status === "done" && t.current) ? (
            <Button
              size="sm"
              disabled={busy}
              onClick={again}
              data-testid={`build-try-again-${t.caseId}`}
            >
              Try it again
            </Button>
          ) : null}
          {t.status !== "running" ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => decide("discard")}
              data-testid={`build-try-discard-${t.caseId}`}
            >
              Discard
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export function TryCard({
  detail,
  live,
  busy,
  act,
  onWrong,
  upload = (file, clientId) =>
    uploadFiles([file], undefined, `${sandboxUploadPath(clientId)}?for=try`),
}: {
  detail: BuildDetail;
  /** The POC test is the build's current phase: examples can be tried. */
  live: boolean;
  busy: boolean;
  act: Act;
  onWrong?: ((name: string) => void) | undefined;
  /** The Sandbox upload (tests pass their own). */
  upload?: (file: File, clientId: string) => ReturnType<typeof uploadFiles>;
}) {
  const poc = detail.poc;
  const id = detail.build.id;
  const inputId = useId();
  const [input, setInput] = useState("");
  const [bad, setBad] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (poc?.mode !== "suite") return null;
  const template = detail.build.kind === "agent";
  const sandbox = poc.trySandbox;
  const off = busy || uploading;

  async function tryDocument(file: File) {
    if (!sandbox) return;
    setError(null);
    setUploading(true);
    try {
      const out = await upload(file, sandbox.id);
      const r = out.results[0];
      if (r?.kind !== "document" || !r.document) {
        setBad(r?.error ?? "That file can't be tried: use a PDF or an image.");
        return;
      }
      setBad(null);
      await act(apiRoutes.opsBuildTry, { params: { id }, body: { documentId: r.document.id } });
    } catch (e) {
      setError(e);
    } finally {
      setUploading(false);
    }
  }

  async function tryInput() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input);
    } catch {
      setBad("That isn't valid JSON.");
      return;
    }
    setBad(null);
    if (await act(apiRoutes.opsBuildTry, { params: { id }, body: { input: parsed } })) {
      setInput("");
    }
  }

  return (
    <Card
      testId="build-try"
      title={template ? "Try it on a document" : "Try it on an input"}
      meta={
        <span className="text-sm text-ink-muted">
          It runs once as a test. Nothing is written anywhere.
        </span>
      }
    >
      <div className="flex flex-col gap-3 px-6 py-5 text-sm">
        <p className="text-ink">
          {template
            ? "Upload a real document and see what the agent would do with it. If it's right, keep it as a test case; if it's wrong, tell the Builder why."
            : "Give the skill a real input and see what it answers. If it's right, keep it as a test case; if it's wrong, tell the Builder why."}
        </p>
        {live ? (
          <div className="flex flex-col gap-3">
            {template ? (
              sandbox ? (
                <div className="flex flex-wrap items-center gap-2">
                  <label
                    className={`ds-btn ds-btn--primary ds-btn--sm ${off ? "pointer-events-none opacity-60" : "cursor-pointer"}`}
                  >
                    {uploading ? "Uploading…" : "Upload a document"}
                    <input
                      type="file"
                      accept="application/pdf,image/png,image/jpeg,image/gif,image/webp"
                      className="sr-only"
                      disabled={off}
                      data-testid="build-try-file"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void tryDocument(f);
                        e.target.value = "";
                      }}
                    />
                  </label>
                  <span className="text-ink-muted">
                    It goes to {sandbox.name}, where the tests run.
                  </span>
                </div>
              ) : (
                <p className="text-ink-muted" data-testid="build-try-no-sandbox">
                  A document is tried in a Sandbox client you serve. There isn't one yet.
                </p>
              )
            ) : null}
            <div className="flex flex-col gap-1.5">
              <label htmlFor={inputId} className="text-ink-muted">
                {template ? "Or give the trigger's input (JSON)" : "The skill's input (JSON)"}
              </label>
              <TextArea
                id={inputId}
                rows={3}
                className="font-mono text-xs"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={template ? '{"documentId": "…"}' : '{"description": "Oak board 2x4"}'}
                data-testid="build-try-input"
              />
            </div>
            <div>
              <Button
                size="sm"
                variant={template ? "secondary" : "primary"}
                disabled={off || input.trim() === ""}
                onClick={() => void tryInput()}
                data-testid="build-try-run"
              >
                Try it
              </Button>
            </div>
            {bad ? (
              <p className="text-risk-ink" data-testid="build-try-bad">
                {bad}
              </p>
            ) : null}
            {error ? <ErrorNotice error={error} /> : null}
          </div>
        ) : null}
      </div>
      {poc.tries.length > 0 ? (
        <ul className="flex flex-col border-t border-line" data-testid="build-tries">
          {poc.tries.map((t) => (
            <TryRow
              key={t.caseId}
              t={t}
              live={live}
              busy={off}
              act={act}
              buildId={id}
              onWrong={onWrong}
            />
          ))}
        </ul>
      ) : null}
    </Card>
  );
}
