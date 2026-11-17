// The Feedback page's Dev queue tab (docs/plan.md §1.125): what the Builder (or an operator, or a
// Claude Code session) asked engineering to build, triaged before it's built and shipped back to
// the builds waiting on it. The list (number, title, kind, status, builds, owner, age, PR) with its
// filters; a request's page: the spec, the open questions, the reuse check with its verdicts (re-
// run, and judged here), the decision and its reason, the builds and steps waiting, the PR, where
// it shipped and its timeline. Every move's button shows; one its guard refuses is disabled with
// the server's own reason beside it (core's `requestMoves`). Shipped is the system's, so it has no
// button.
import {
  CLOSE_REASON_WORDS,
  CODE_REQUEST_CLOSE_REASONS,
  CODE_REQUEST_DECISIONS,
  CODE_REQUEST_KIND_WORDS,
  CODE_REQUEST_KINDS,
  CODE_REQUEST_STATUS_WORDS,
  type CodeRequestDetail,
  type CodeRequestMove,
  type CodeRequestSummary,
  DECISION_WORDS,
  type ReuseCandidate,
  type ReuseVerdict,
} from "@countersign/core";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ApiError } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { Field, Select, TextArea, TextInput } from "../../ui/forms";
import { Loaded } from "../../ui/page";
import { Badge, Button, Card, EmptyState, type Tone } from "../../ui/primitives";

type StatusFilter = "open" | "all" | CodeRequestSummary["status"];

const STATUS_FILTERS: [StatusFilter, string][] = [
  ["open", "Open"],
  ["triage", "Triage"],
  ["accepted", "Accepted"],
  ["in_progress", "In progress"],
  ["shipped", "Shipped"],
  ["closed", "Closed"],
  ["all", "All"],
];

/** In progress with a PR is "In review"; the pill's colour by how far along it is. */
export function statusPill(r: Pick<CodeRequestSummary, "status" | "inReview">): {
  label: string;
  tone: Tone;
} {
  if (r.inReview) return { label: "In review", tone: "accent" };
  const tone: Record<CodeRequestSummary["status"], Tone> = {
    triage: "warning",
    accepted: "accent",
    in_progress: "accent",
    shipped: "positive",
    closed: "neutral",
  };
  return { label: CODE_REQUEST_STATUS_WORDS[r.status], tone: tone[r.status] };
}

function age(iso: string, now = Date.now()): string {
  const days = Math.floor((now - Date.parse(iso)) / 86_400_000);
  if (days < 1) return "Today";
  return days === 1 ? "1 day" : `${days} days`;
}

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function messageOf(e: unknown): string {
  return e instanceof ApiError || e instanceof Error ? e.message : "That didn't work. Try again.";
}

export function DevQueue() {
  const [params, setParams] = useSearchParams();
  const selected = params.get("request");
  const open = (ref: string | null) => {
    const next = new URLSearchParams(params);
    if (ref) next.set("request", ref);
    else next.delete("request");
    setParams(next);
  };
  return selected ? (
    <RequestPage id={selected} onBack={() => open(null)} />
  ) : (
    <RequestList onOpen={open} />
  );
}

function RequestList({ onOpen }: { onOpen(ref: string): void }) {
  const [status, setStatus] = useState<StatusFilter>("open");
  const [kind, setKind] = useState<string>("");
  const [buildId, setBuildId] = useState<string>("");
  const [environment, setEnvironment] = useState<string>("");
  const list = useApi(apiRoutes.opsCodeRequests, {
    query: {
      status,
      ...(kind ? { kind: kind as CodeRequestSummary["kind"] } : {}),
      ...(buildId ? { build: buildId } : {}),
      ...(environment ? { environment: environment as "staging" | "production" } : {}),
    },
  });
  const builds = new Map<string, string>();
  for (const r of list.data?.requests ?? []) for (const b of r.builds) builds.set(b.id, b.title);
  return (
    <div className="flex flex-col gap-4" data-testid="dev-queue">
      <div className="flex flex-wrap items-end gap-3">
        <div className="max-w-full overflow-x-auto">
          <div className="ds-seg" data-testid="dev-queue-status">
            {STATUS_FILTERS.map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={status === value}
                data-testid={`dev-queue-status-${value}`}
                onClick={() => setStatus(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <Select
          aria-label="Kind"
          className="w-44"
          value={kind}
          data-testid="dev-queue-kind"
          onChange={(e) => setKind(e.target.value)}
        >
          <option value="">Any kind</option>
          {CODE_REQUEST_KINDS.map((k) => (
            <option key={k} value={k}>
              {CODE_REQUEST_KIND_WORDS[k]}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Build"
          className="w-52"
          value={buildId}
          data-testid="dev-queue-build"
          onChange={(e) => setBuildId(e.target.value)}
        >
          <option value="">Any build</option>
          {[...builds].map(([id, title]) => (
            <option key={id} value={id}>
              {title}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Shipped to"
          className="w-44"
          value={environment}
          data-testid="dev-queue-environment"
          onChange={(e) => setEnvironment(e.target.value)}
        >
          <option value="">Any environment</option>
          <option value="staging">Shipped to staging</option>
          <option value="production">In production</option>
        </Select>
      </div>
      <Loaded state={list}>
        {(data) =>
          data.requests.length === 0 ? (
            <EmptyState>
              {status === "open"
                ? "Nothing open. The Builder files a request here when a step needs new code."
                : "No requests here."}
            </EmptyState>
          ) : (
            <div className="ds-card overflow-x-auto" data-testid="dev-queue-list">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line bg-surface-subtle text-left text-xs text-ink-muted">
                    <th className="px-4 py-2.5 font-medium">#</th>
                    <th className="px-4 py-2.5 font-medium">Request</th>
                    <th className="px-4 py-2.5 font-medium">Kind</th>
                    <th className="px-4 py-2.5 font-medium">Status</th>
                    <th className="px-4 py-2.5 font-medium">Builds</th>
                    <th className="px-4 py-2.5 font-medium">Owner</th>
                    <th className="px-4 py-2.5 font-medium">Age</th>
                    <th className="px-4 py-2.5 font-medium">PR</th>
                  </tr>
                </thead>
                <tbody>
                  {data.requests.map((r) => {
                    const pill = statusPill(r);
                    return (
                      <tr
                        key={r.id}
                        className="border-b border-line align-top last:border-b-0"
                        data-testid={`dev-queue-row-${r.ref}`}
                      >
                        <td className="figures whitespace-nowrap px-4 py-3 text-ink-muted">
                          {r.ref}
                        </td>
                        <td className="px-4 py-3">
                          <button
                            type="button"
                            className="text-left font-medium text-ink hover:text-slate hover:underline"
                            data-testid={`dev-queue-open-${r.ref}`}
                            onClick={() => onOpen(r.ref)}
                          >
                            {r.title}
                          </button>
                          {r.coveredBy ? (
                            <p className="mt-0.5 text-xs text-ink-muted">
                              May exist already: {r.coveredBy.name}
                            </p>
                          ) : null}
                        </td>
                        <td className="px-4 py-3 text-ink-muted">
                          {CODE_REQUEST_KIND_WORDS[r.kind]}
                        </td>
                        <td className="px-4 py-3">
                          <Badge tone={pill.tone}>{pill.label}</Badge>
                        </td>
                        <td className="px-4 py-3 text-ink-muted">
                          {r.builds.length === 0 ? "None" : r.builds.map((b) => b.title).join(", ")}
                        </td>
                        <td className="px-4 py-3 text-ink-muted">
                          {r.claimedBy?.name ?? r.owner ?? "Not set"}
                        </td>
                        <td className="figures whitespace-nowrap px-4 py-3 text-ink-muted">
                          {age(r.createdAt)}
                        </td>
                        <td className="px-4 py-3">
                          {r.prUrl ? (
                            <a
                              href={r.prUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="text-slate hover:underline"
                            >
                              PR
                            </a>
                          ) : (
                            <span className="text-ink-muted">None</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        }
      </Loaded>
    </div>
  );
}

/** A move's button: disabled with its reason beside it when the guard refuses. */
function MoveButton({
  request,
  move,
  label,
  onClick,
  primary = false,
  busy,
}: {
  request: CodeRequestDetail;
  move: CodeRequestMove;
  label: string;
  onClick(): void;
  primary?: boolean;
  busy: boolean;
}) {
  const state = request.moves[move];
  return (
    <div className="flex flex-col gap-1" data-testid={`dev-queue-move-${move}`}>
      <Button
        variant={primary ? "primary" : "secondary"}
        disabled={!state.allowed || busy}
        title={state.allowed ? undefined : state.reason}
        data-testid={`dev-queue-${move}`}
        onClick={onClick}
      >
        {label}
      </Button>
      {!state.allowed && state.reason ? (
        <span className="max-w-72 text-xs text-ink-muted" data-testid={`dev-queue-why-${move}`}>
          {state.reason}
        </span>
      ) : null}
    </div>
  );
}

function RequestPage({ id, onBack }: { id: string; onBack(): void }) {
  const state = useApi(apiRoutes.opsCodeRequest, { params: { id } });
  return (
    <div className="flex flex-col gap-4" data-testid="dev-queue-request">
      <div>
        <Button variant="link" onClick={onBack} data-testid="dev-queue-back">
          All requests
        </Button>
      </div>
      <Loaded state={state}>{(r) => <RequestBody request={r} onChanged={state.reload} />}</Loaded>
    </div>
  );
}

function RequestBody({ request: r, onChanged }: { request: CodeRequestDetail; onChanged(): void }) {
  const client = useApiClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [closeReason, setCloseReason] = useState<string>("");
  const [mergedInto, setMergedInto] = useState("");
  const [closeNote, setCloseNote] = useState("");
  const [note, setNote] = useState("");
  const [pr, setPr] = useState({
    url: r.prUrl ?? "",
    part: r.expectedPartId ?? r.spec.parts[0] ?? "",
  });

  async function run(work: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await work();
      onChanged();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }
  const params = { id: r.id };
  const pill = statusPill(r);
  const triage = r.status === "triage";

  return (
    <>
      <Card
        pad
        testId="dev-queue-head"
        title={
          <span>
            <span className="figures text-ink-muted">{r.ref}</span> {r.title}
          </span>
        }
        meta={<Badge tone={pill.tone}>{pill.label}</Badge>}
      >
        <div className="flex flex-col gap-4">
          {r.coveredBy && triage ? (
            <p className="ds-callout text-sm" data-testid="dev-queue-covered">
              The reuse check thinks “{r.coveredBy.name}” may already do this, so the decision is
              suggested as “It exists”. Look at it before anything is built.
            </p>
          ) : null}
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-ink-muted">Kind</dt>
              <dd>{CODE_REQUEST_KIND_WORDS[r.kind]}</dd>
            </div>
            <div>
              <dt className="text-ink-muted">Owner</dt>
              <dd>{r.claimedBy ? `${r.claimedBy.name} has it` : (r.owner ?? "Not set")}</dd>
            </div>
            <div>
              <dt className="text-ink-muted">Shipped to staging</dt>
              <dd data-testid="dev-queue-staging">
                {r.shippedStagingAt ? when(r.shippedStagingAt) : "Not yet"}
              </dd>
            </div>
            <div>
              <dt className="text-ink-muted">In production</dt>
              <dd data-testid="dev-queue-production">
                {r.shippedProductionAt
                  ? when(r.shippedProductionAt)
                  : "Not yet: production ships on its next release"}
              </dd>
            </div>
            <div>
              <dt className="text-ink-muted">PR</dt>
              <dd>
                {r.prUrl ? (
                  <a
                    href={r.prUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-slate hover:underline"
                  >
                    {r.prUrl.replace("https://github.com/", "")}
                  </a>
                ) : (
                  "None yet"
                )}
                {r.expectedPartId ? (
                  <span className="text-ink-muted"> · adds {r.expectedPartId}</span>
                ) : null}
              </dd>
            </div>
            {r.closeReason ? (
              <div>
                <dt className="text-ink-muted">Closed</dt>
                <dd>
                  {CLOSE_REASON_WORDS[r.closeReason]}
                  {r.mergedInto ? ` (${r.mergedInto.ref})` : ""}
                </dd>
              </div>
            ) : null}
          </dl>
          <div className="flex flex-wrap items-start gap-3" data-testid="dev-queue-actions">
            <MoveButton
              request={r}
              move="accept"
              label="Accept"
              primary
              busy={busy}
              onClick={() =>
                void run(() => client.call(apiRoutes.opsAcceptCodeRequest, { params }))
              }
            />
            {r.decision === "one_off" ? (
              <MoveButton
                request={r}
                move="approve_one_off"
                label="Approve as a one-off"
                busy={busy}
                onClick={() => void run(() => client.call(apiRoutes.opsApproveOneOff, { params }))}
              />
            ) : null}
            <MoveButton
              request={r}
              move="claim"
              label="Claim"
              busy={busy}
              onClick={() => void run(() => client.call(apiRoutes.opsClaimCodeRequest, { params }))}
            />
            <MoveButton
              request={r}
              move="close"
              label="Close"
              busy={busy}
              onClick={() => setClosing(true)}
            />
          </div>
          {closing ? (
            <div className="flex flex-wrap items-end gap-3" data-testid="dev-queue-close-form">
              <Field label="Why it closes">
                <Select
                  value={closeReason}
                  data-testid="dev-queue-close-reason"
                  onChange={(e) => setCloseReason(e.target.value)}
                  className="w-72"
                >
                  <option value="">Pick a reason</option>
                  {CODE_REQUEST_CLOSE_REASONS.map((c) => (
                    <option key={c} value={c}>
                      {CLOSE_REASON_WORDS[c]}
                    </option>
                  ))}
                </Select>
              </Field>
              {closeReason === "merged" ? (
                <Field label="Merged into">
                  <TextInput
                    value={mergedInto}
                    placeholder="DQ-012"
                    data-testid="dev-queue-merged-into"
                    onChange={(e) => setMergedInto(e.target.value)}
                    className="w-32"
                  />
                </Field>
              ) : null}
              <Field label={closeReason === "config" ? "The recipe" : "Note (optional)"}>
                <TextInput
                  value={closeNote}
                  data-testid="dev-queue-close-note"
                  onChange={(e) => setCloseNote(e.target.value)}
                  className="w-80 max-w-full"
                />
              </Field>
              <Button
                variant="primary"
                disabled={busy || !closeReason || (closeReason === "merged" && !mergedInto.trim())}
                title={!closeReason ? "Pick a reason first." : undefined}
                data-testid="dev-queue-close-confirm"
                onClick={() =>
                  void run(async () => {
                    await client.call(apiRoutes.opsCloseCodeRequest, {
                      params,
                      body: {
                        reason: closeReason as (typeof CODE_REQUEST_CLOSE_REASONS)[number],
                        ...(closeReason === "merged" ? { mergedInto: mergedInto.trim() } : {}),
                        ...(closeNote.trim() ? { note: closeNote.trim() } : {}),
                      },
                    });
                    setClosing(false);
                  })
                }
              >
                Close it
              </Button>
              <Button variant="ghost" onClick={() => setClosing(false)}>
                Cancel
              </Button>
            </div>
          ) : null}
          {r.status === "in_progress" ? (
            <div className="flex flex-wrap items-end gap-3" data-testid="dev-queue-pr-form">
              <Field label="Pull request">
                <TextInput
                  value={pr.url}
                  placeholder="https://github.com/…/pull/123"
                  data-testid="dev-queue-pr-url"
                  onChange={(e) => setPr({ ...pr, url: e.target.value })}
                  className="w-80 max-w-full"
                />
              </Field>
              <Field label="Catalog part it adds">
                <TextInput
                  value={pr.part}
                  data-testid="dev-queue-pr-part"
                  onChange={(e) => setPr({ ...pr, part: e.target.value })}
                  className="w-64 max-w-full"
                />
              </Field>
              <MoveButton
                request={r}
                move="attach_pr"
                label="Attach the PR"
                busy={busy || !pr.url.trim() || !pr.part.trim()}
                onClick={() =>
                  void run(() =>
                    client.call(apiRoutes.opsCodeRequestPr, {
                      params,
                      body: { prUrl: pr.url.trim(), expectedPartId: pr.part.trim() },
                    }),
                  )
                }
              />
            </div>
          ) : null}
          {error ? (
            <p className="ds-error text-sm" data-testid="dev-queue-error">
              {error}
            </p>
          ) : null}
        </div>
      </Card>

      <Card pad title="What it must do" testId="dev-queue-spec">
        <div className="flex flex-col gap-3 text-sm">
          {r.spec.summary ? <p className="text-ink">{r.spec.summary}</p> : null}
          <SpecList label="Inputs" items={r.spec.inputs} />
          <SpecList label="Outputs" items={r.spec.outputs} />
          <SpecList label="Rules" items={r.spec.rules} />
          <SpecList label="How to check it's right" items={r.spec.acceptance} />
          <SpecList label="The part it adds or changes" items={r.spec.parts} />
        </div>
      </Card>

      <Card pad title="Open questions" testId="dev-queue-questions">
        {r.openQuestions.length === 0 ? (
          <p className="text-sm text-ink-muted">None.</p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm">
            {r.openQuestions.map((q) => (
              <li key={q.question}>
                <p className="text-ink">{q.question}</p>
                <p className="text-ink-muted">
                  {q.answer
                    ? `Answer: ${q.answer}`
                    : q.mode === "investigate_during_build"
                      ? "Settled while building."
                      : "Must be answered first."}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <ReuseCheckCard request={r} busy={busy} run={run} />
      <DecisionCard request={r} busy={busy} run={run} />

      <Card pad title="Builds waiting on it" testId="dev-queue-links">
        {r.links.length === 0 ? (
          <p className="text-sm text-ink-muted">No build is linked.</p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm">
            {r.links.map((l) => (
              <li key={l.id}>
                <Link to={`/ops/builds/${l.buildId}`} className="text-slate hover:underline">
                  {l.buildTitle}
                </Link>
                <span className="text-ink-muted">
                  {l.stepId ? ` · step ${l.stepId}` : ""}
                  {l.issueTitle
                    ? ` · “${l.issueTitle}” ${l.issueOpen ? "is open" : "is closed"}`
                    : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card pad title="Timeline" testId="dev-queue-events">
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <Field label="Add a note" className="grow">
            <TextInput
              value={note}
              data-testid="dev-queue-note"
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
          <Button
            disabled={busy || !note.trim()}
            data-testid="dev-queue-note-add"
            onClick={() =>
              void run(async () => {
                await client.call(apiRoutes.opsCodeRequestNote, {
                  params,
                  body: { body: note.trim() },
                });
                setNote("");
              })
            }
          >
            Add
          </Button>
        </div>
        <ol className="flex flex-col gap-2 text-sm">
          {r.events.map((e) => (
            <li key={e.id} className="flex flex-wrap gap-x-2">
              <span className="figures text-ink-muted">{when(e.at)}</span>
              <span className="text-ink">{eventWords(e)}</span>
              <span className="text-ink-muted">
                {e.userName ??
                  (e.actor === "system" ? "Mezonas" : e.actor === "builder" ? "Builder" : "")}
              </span>
            </li>
          ))}
        </ol>
      </Card>
    </>
  );
}

function SpecList({ label, items }: { label: string; items: readonly string[] }) {
  return (
    <div>
      <p className="text-ink-muted">{label}</p>
      {items.length === 0 ? (
        <p className="text-ink-muted">None yet.</p>
      ) : (
        <ul className="list-disc pl-5 text-ink">
          {items.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One event in plain words. */
export function eventWords(e: CodeRequestDetail["events"][number]): string {
  const b = e.body as Record<string, unknown>;
  const s = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : "");
  switch (e.kind) {
    case "status":
      if (s("approved")) return "Approved as a one-off.";
      if (s("to") === "triage") return "Filed. In triage.";
      if (s("reason") && s("to") === "accepted") return `Back to accepted: ${s("reason")}`;
      if (s("to") === "closed")
        return `Closed: ${s("reason").replace(/_/g, " ")}.${s("note") ? ` ${s("note")}` : ""}`;
      return `${CODE_REQUEST_STATUS_WORDS[(s("to") || "triage") as CodeRequestDetail["status"]] ?? s("to")}.`;
    case "note":
      return (
        s("text") ||
        (Array.isArray(b.edited)
          ? `Triage changed: ${(b.edited as string[]).join(", ")}.`
          : "Note.")
      );
    case "reuse_check":
      return `Reuse check: ${b.candidates ?? 0} candidates${b.unjudged ? ", not judged yet" : ""}.`;
    case "merge":
      return s("from") ? `${s("from")} merged into it.` : "A build was linked to it.";
    case "claim":
      return "Claimed.";
    case "pr":
      return `PR attached: ${s("prUrl")}.`;
    case "shipped":
      return `In the ${s("environment")} catalog: ${s("name") || s("part")}.`;
    case "notified":
      return `Told everyone: ${s("text")}`;
  }
}

function ReuseCheckCard({
  request: r,
  busy,
  run,
}: {
  request: CodeRequestDetail;
  busy: boolean;
  run(work: () => Promise<unknown>): Promise<void>;
}) {
  const client = useApiClient();
  const candidates = r.reuseCheck?.candidates ?? [];
  const [edits, setEdits] = useState<
    Record<string, Pick<ReuseCandidate, "verdict" | "reason" | "missing">>
  >({});
  const edited = (c: ReuseCandidate) => edits[c.partId] ?? c;
  const set = (
    c: ReuseCandidate,
    patch: Partial<Pick<ReuseCandidate, "verdict" | "reason" | "missing">>,
  ) => setEdits({ ...edits, [c.partId]: { ...edited(c), ...patch } });
  const triage = r.status === "triage";
  return (
    <Card
      pad
      title="Reuse check"
      testId="dev-queue-reuse"
      meta={
        <span className="flex items-center gap-3">
          {r.reuseCheck ? (
            <span className="text-xs text-ink-muted">Ran {when(r.reuseCheck.ranAt)}</span>
          ) : null}
          <MoveButton
            request={r}
            move="rerun_reuse"
            label="Run again"
            busy={busy}
            onClick={() =>
              void run(() => client.call(apiRoutes.opsCodeRequestReuse, { params: { id: r.id } }))
            }
          />
        </span>
      }
    >
      {candidates.length === 0 ? (
        <p className="text-sm text-ink-muted">Nothing in the catalog looks like it.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-ink-muted">
                <th className="py-2 pr-4 font-medium">Candidate</th>
                <th className="py-2 pr-4 font-medium">Type</th>
                <th className="py-2 pr-4 font-medium">Score</th>
                <th className="py-2 pr-4 font-medium">Verdict</th>
                <th className="py-2 font-medium">Reason</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((c) => {
                const e = edited(c);
                return (
                  <tr
                    key={c.partId}
                    className="border-b border-line align-top last:border-b-0"
                    data-testid={`dev-queue-candidate-${c.partId}`}
                  >
                    <td className="py-2 pr-4">
                      <span className="text-ink">{c.name}</span>
                      {c.relevant ? null : (
                        <span className="block text-xs text-ink-muted">Not relevant</span>
                      )}
                    </td>
                    <td className="py-2 pr-4 text-ink-muted">{c.partType}</td>
                    <td className="figures py-2 pr-4 text-ink-muted">{c.score.toFixed(2)}</td>
                    <td className="py-2 pr-4">
                      {triage ? (
                        <Select
                          aria-label={`Verdict on ${c.name}`}
                          value={e.verdict ?? ""}
                          className="w-28"
                          onChange={(ev) =>
                            set(c, { verdict: (ev.target.value || null) as ReuseVerdict | null })
                          }
                        >
                          <option value="">None</option>
                          <option value="use">Use</option>
                          <option value="extend">Extend</option>
                          <option value="reject">Reject</option>
                        </Select>
                      ) : (
                        <span>{c.verdict ?? "None"}</span>
                      )}
                    </td>
                    <td className="py-2">
                      {triage ? (
                        <div className="flex flex-col gap-1">
                          <TextInput
                            aria-label={`Why, for ${c.name}`}
                            value={e.reason}
                            placeholder="Why"
                            onChange={(ev) => set(c, { reason: ev.target.value })}
                          />
                          {e.verdict !== "use" ? (
                            <TextInput
                              aria-label={`What ${c.name} lacks`}
                              value={e.missing}
                              placeholder="What it lacks: an input, output or behaviour"
                              onChange={(ev) => set(c, { missing: ev.target.value })}
                            />
                          ) : null}
                        </div>
                      ) : (
                        <span className="text-ink-muted">
                          {c.reason}
                          {c.missing ? ` Lacks: ${c.missing}` : ""}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {triage ? (
            <div className="mt-3">
              <Button
                disabled={busy || Object.keys(edits).length === 0}
                data-testid="dev-queue-verdicts-save"
                onClick={() =>
                  void run(async () => {
                    await client.call(apiRoutes.opsUpdateCodeRequest, {
                      params: { id: r.id },
                      body: {
                        verdicts: Object.entries(edits)
                          .filter(([, v]) => v.verdict)
                          .map(([partId, v]) => ({
                            partId,
                            verdict: v.verdict as ReuseVerdict,
                            reason: v.reason,
                            missing: v.missing,
                          })),
                      },
                    });
                    setEdits({});
                  })
                }
              >
                Save verdicts
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </Card>
  );
}

function DecisionCard({
  request: r,
  busy,
  run,
}: {
  request: CodeRequestDetail;
  busy: boolean;
  run(work: () => Promise<unknown>): Promise<void>;
}) {
  const client = useApiClient();
  const [decision, setDecision] = useState<string>(r.decision ?? "");
  const [reason, setReason] = useState(r.decisionReason ?? "");
  const triage = r.status === "triage";
  const changed = decision !== (r.decision ?? "") || reason !== (r.decisionReason ?? "");
  return (
    <Card pad title="Decision" testId="dev-queue-decision">
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-ink-muted">
          Most reuse first. Each step down says why the step above won't do.
        </p>
        {triage ? (
          <>
            <Field label="Decision">
              <Select
                value={decision}
                className="w-64"
                data-testid="dev-queue-decision-select"
                onChange={(e) => setDecision(e.target.value)}
              >
                <option value="">None yet</option>
                {CODE_REQUEST_DECISIONS.map((d) => (
                  <option key={d} value={d}>
                    {DECISION_WORDS[d]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Why the step above won't do">
              <TextArea
                rows={3}
                value={reason}
                data-testid="dev-queue-decision-reason"
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
            <div>
              <Button
                disabled={busy || !changed}
                data-testid="dev-queue-decision-save"
                onClick={() =>
                  void run(() =>
                    client.call(apiRoutes.opsUpdateCodeRequest, {
                      params: { id: r.id },
                      body: {
                        decision: (decision || null) as CodeRequestDetail["decision"],
                        decisionReason: reason.trim() || null,
                      },
                    }),
                  )
                }
              >
                Save the decision
              </Button>
            </div>
          </>
        ) : (
          <p className="text-ink">
            {r.decision ? DECISION_WORDS[r.decision] : "None"}
            {r.decisionReason ? `: ${r.decisionReason}` : ""}
          </p>
        )}
        {r.otherUses.length > 0 ? (
          <p className="text-ink-muted">Also used by: {r.otherUses.join("; ")}</p>
        ) : (
          <p className="text-ink-muted">No other uses named: it's a one-off unless one is.</p>
        )}
      </div>
    </Card>
  );
}
