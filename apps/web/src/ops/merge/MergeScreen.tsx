// The merge view (ARCHITECTURE §10.5, §15 `/ops/agents/[id]/merge`): a template update into a
// client agent (`?mode=update`), or a client agent's changes promoted into its template
// (`?mode=promote`). It shows the merged workflow as the builder lays it out, each step marked
// added, removed, changed or moved per side; the conflicts, each resolved as one side, the
// original or an edited value; the agent fields and settings side by side; and, for a promotion,
// which changes go (client-specific values never do). Merging and validation run in the browser
// with core's code on every change; Save asks the server, which runs both again.
import {
  type AgentBundle,
  AgentBundle as AgentBundleSchema,
  diffBundles,
  type MergeConflict,
  mergeBundles,
  type Resolution,
  selectableBetween,
  selectChanges,
  type ValidationError,
} from "@countersign/core";
import { type ReactNode, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import { type AgentSummary, apiRoutes, type VersionDetail } from "../../api/routes";
import { useApi } from "../../api/useApi";
import {
  AgentAvatar,
  Badge,
  Button,
  buttonClass,
  Card,
  cx,
  ErrorNotice,
  Loading,
  PageHeader,
  SectionLabel,
} from "../../ui/primitives";
import { ChangeList } from "../agents/ChangeList";
import { describeChange } from "../agents/changes";
import {
  detailMessages,
  errorText,
  Field,
  Notice,
  plural,
  TextArea,
  TextInput,
  useAction,
} from "../agents/ui";
import { typingContext, validateLikeServer } from "../builder/catalog";
import { JsonInput } from "../builder/fields";
import { StepList, type StepMark } from "../workflow/StepList";
import {
  activeResolutions,
  conflictChoices,
  conflictTarget,
  conflictText,
  conflictValue,
  fieldRows,
  type Mark,
  type Mode,
  removedSteps,
  type Side,
  sideMarks,
  sideNames,
} from "./model";

type Preview =
  | ResponseOf<typeof apiRoutes.opsUpdatePreview>
  | ResponseOf<typeof apiRoutes.opsPromotePreview>;

/** The agent page's URL for an agent. */
export function agentBase(agent: Pick<AgentSummary, "kind" | "slug" | "tenantId">): string {
  return agent.kind === "template"
    ? `/ops/templates/${agent.slug}`
    : `/ops/clients/${agent.tenantId}/agents/${agent.slug}`;
}

function parse(v: VersionDetail): AgentBundle | null {
  const r = AgentBundleSchema.safeParse(v.bundle);
  return r.success ? r.data : null;
}

// DECISION: the merge view merges and validates in the browser with core's shared code on every
// resolution (plan §1.6 "Merge view"); the server repeats both on save and is the one that decides.
export function MergeScreen() {
  const { id = "" } = useParams();
  const [search] = useSearchParams();
  const mode: Mode = search.get("mode") === "promote" ? "promote" : "update";
  const agent = useApi(apiRoutes.opsAgent, { params: { id } });
  const update = useApi(apiRoutes.opsUpdatePreview, mode === "update" ? { params: { id } } : null);
  const promote = useApi(
    apiRoutes.opsPromotePreview,
    mode === "promote" ? { params: { id } } : null,
  );
  const preview = mode === "update" ? update : promote;
  // The draft lands on the client agent (update) or the template (promotion): validate as that.
  const targetId = mode === "update" ? id : preview.data?.template.id;
  const catalog = useApi(
    apiRoutes.opsBuilderCatalog,
    targetId ? { params: { id: targetId } } : null,
  );
  const events = useApi(apiRoutes.opsEventCatalog);

  const failed = agent.error ?? preview.error ?? catalog.error ?? events.error;
  const header = agent.data ? <Header agent={agent.data.agent} mode={mode} /> : null;
  if (failed) {
    return (
      <div>
        {header}
        <ErrorNotice
          error={failed}
          onRetry={() => {
            agent.reload();
            preview.reload();
            catalog.reload();
            events.reload();
          }}
        />
        {agent.data ? (
          <p className="mt-4 text-sm">
            <Link
              to={`${agentBase(agent.data.agent)}/versions`}
              className="text-link hover:underline"
            >
              Back to versions
            </Link>
          </p>
        ) : null}
      </div>
    );
  }
  if (!agent.data || !preview.data || !catalog.data || !events.data) {
    return (
      <div>
        {header}
        <Loading label="Merging…" />
      </div>
    );
  }
  const bundles = {
    base: parse(preview.data.base),
    ours: parse(preview.data.ours),
    theirs: parse(preview.data.theirs),
  };
  if (!bundles.base || !bundles.ours || !bundles.theirs) {
    return (
      <div>
        {header}
        <ErrorNotice error={new Error("One of the versions can't be read.")} />
      </div>
    );
  }
  return (
    <div>
      {header}
      <MergeBody
        mode={mode}
        agent={agent.data.agent}
        preview={preview.data}
        base={bundles.base}
        ours={bundles.ours}
        theirs={bundles.theirs}
        ctx={typingContext({ catalog: catalog.data, events: events.data.events })}
      />
    </div>
  );
}

function Header({ agent, mode }: { agent: AgentSummary; mode: Mode }) {
  return (
    <PageHeader
      leading={<AgentAvatar name={agent.name} seed={agent.slug} size="lg" />}
      title={
        mode === "update"
          ? `Update ${agent.serviceName ?? agent.name}`
          : `Promote ${agent.serviceName ?? agent.name}'s changes`
      }
      subtitle={
        mode === "update"
          ? "Merge the template's new version with this client's customizations."
          : "Fold this client's changes into a new template draft. Client-specific values stay with the client."
      }
      actions={
        <Link to={`${agentBase(agent)}/versions`} className={buttonClass("ghost")}>
          Back to versions
        </Link>
      }
    />
  );
}

const MARK_WORD: Record<Mark, string> = {
  added: "added",
  removed: "removed",
  changed: "changed",
  moved: "moved",
};

function MergeBody({
  mode,
  agent,
  preview,
  base,
  ours,
  theirs: offered,
  ctx,
}: {
  mode: Mode;
  agent: AgentSummary;
  preview: Preview;
  base: AgentBundle;
  ours: AgentBundle;
  theirs: AgentBundle;
  ctx: ReturnType<typeof typingContext>;
}) {
  const names = sideNames(mode);
  const labels = preview.labels;

  // A promotion carries the selected changes only; all by default.
  const selectable = useMemo(
    () => (mode === "promote" ? selectableBetween(base, offered) : []),
    [mode, base, offered],
  );
  const [unselected, setUnselected] = useState<ReadonlySet<string>>(new Set());
  const selected = useMemo(
    () => selectable.filter((g) => !unselected.has(g.id)).map((g) => g.id),
    [selectable, unselected],
  );
  const theirs = useMemo(
    () =>
      selected.length === selectable.length ? offered : selectChanges(base, offered, selected),
    [base, offered, selected, selectable],
  );

  const [picked, setPicked] = useState<Record<string, Resolution>>({});
  const raw = useMemo(() => mergeBundles(base, ours, theirs), [base, ours, theirs]);
  const resolutions = useMemo(() => activeResolutions(raw.conflicts, picked), [raw, picked]);
  const result = useMemo(
    () => mergeBundles(base, ours, theirs, resolutions),
    [base, ours, theirs, resolutions],
  );
  const validation = useMemo(() => validateLikeServer(result.bundle, ctx), [result.bundle, ctx]);
  const open = result.conflicts.length;

  const oursChanges = useMemo(() => diffBundles(base, ours), [base, ours]);
  const theirsChanges = useMemo(() => diffBundles(base, theirs), [base, theirs]);
  const marks = useMemo(
    () => ({ ours: sideMarks(oursChanges, ours), theirs: sideMarks(theirsChanges, theirs) }),
    [oursChanges, theirsChanges, ours, theirs],
  );
  const conflictAt = useMemo(() => {
    const m = new Map<string, MergeConflict[]>();
    for (const c of raw.conflicts) {
      const t = conflictTarget(c);
      if (t) m.set(t, [...(m.get(t) ?? []), c]);
    }
    return m;
  }, [raw.conflicts]);
  const [focus, setFocus] = useState<string | null>(null);

  const stepMark = (stepId: string): StepMark | undefined => {
    const badges: ReactNode[] = [];
    for (const side of ["ours", "theirs"] as const) {
      const m = marks[side].get(stepId);
      if (m) {
        badges.push(
          <Badge key={side} tone={m === "added" ? "positive" : "neutral"}>
            {names[side]}: {MARK_WORD[m]}
          </Badge>,
        );
      }
    }
    const here = conflictAt.get(stepId) ?? [];
    const waiting = here.filter((c) => !picked[c.path]).length;
    if (here.length > 0) {
      badges.push(
        <button key="conflict" type="button" onClick={() => setFocus(here[0]?.path ?? null)}>
          <Badge tone={waiting > 0 ? "warning" : "positive"}>
            {waiting > 0 ? plural(waiting, "conflict") : "Resolved"}
          </Badge>
        </button>,
      );
    }
    return badges.length ? { badges, attention: waiting > 0 } : undefined;
  };

  const [slug, setSlug] = useState<string | null>(null);
  const workflows = result.bundle.workflows;
  const shownWorkflow = workflows.find((w) => w.slug === slug) ?? workflows[0];
  const removed = [
    ...removedSteps(oursChanges, result.bundle, labels).map((r) => ({
      ...r,
      side: "ours" as Side,
    })),
    ...removedSteps(theirsChanges, result.bundle, labels).map((r) => ({
      ...r,
      side: "theirs" as Side,
    })),
  ];
  const rows = fieldRows({
    base,
    ours,
    theirs,
    merged: result.bundle,
    conflicts: raw.conflicts,
    open: result.conflicts,
    labels,
  });

  // ── Save ──
  const action = useAction();
  const [changeNote, setChangeNote] = useState("");
  const [releaseNote, setReleaseNote] = useState("");
  const [saved, setSaved] = useState<{ version: number; to: AgentSummary } | null>(null);
  const nothing = mode === "promote" && selected.length === 0;
  const canSave = open === 0 && validation.valid && !nothing && !action.busy && !saved;
  async function save() {
    const note = changeNote.trim() ? { changeNote: changeNote.trim() } : {};
    if (mode === "update") {
      const res = await action.call(apiRoutes.opsUpdate, {
        params: { id: agent.id },
        body: { resolutions, ...note },
      });
      if (res.ok) setSaved({ version: res.data.version.version, to: agent });
    } else {
      const p = preview as ResponseOf<typeof apiRoutes.opsPromotePreview>;
      const res = await action.call(apiRoutes.opsPromote, {
        params: { id: agent.id },
        body: {
          versionId: p.client.id,
          ...(unselected.size > 0 ? { changes: selected } : {}),
          resolutions,
          ...note,
          ...(releaseNote.trim() ? { releaseNote: releaseNote.trim() } : {}),
        },
      });
      if (res.ok) setSaved({ version: res.data.version.version, to: res.data.template });
    }
  }

  const from =
    mode === "update"
      ? `template v${preview.base.version} → v${preview.theirs.version}`
      : `client v${preview.theirs.version} into template v${preview.ours.version}`;

  return (
    <div className="flex flex-col gap-5 pt-2" data-testid="merge-view">
      <div className="flex flex-wrap items-center gap-3" data-testid="merge-summary">
        <span className="text-ink">Merging {from}</span>
        {open > 0 ? (
          <Badge tone="warning" testId="merge-open-conflicts">
            {plural(open, "conflict")} to resolve
          </Badge>
        ) : raw.conflicts.length > 0 ? (
          <Badge tone="positive">Every conflict resolved</Badge>
        ) : (
          <Badge tone="positive">No conflicts</Badge>
        )}
        {validation.valid ? (
          <Badge tone="positive" testId="merge-valid">
            Valid
          </Badge>
        ) : (
          <Badge tone="risk" testId="merge-invalid">
            {plural(validation.errors.length, "problem")}
          </Badge>
        )}
      </div>

      {mode === "update" && preview.theirs.releaseNote ? (
        <p className="text-sm text-ink-muted">Release note: {preview.theirs.releaseNote}</p>
      ) : null}

      {mode === "promote" ? (
        <PromoteChoices
          groups={selectable}
          labels={labels}
          unselected={unselected}
          onToggle={(gid) =>
            setUnselected((s) => {
              const next = new Set(s);
              if (next.has(gid)) next.delete(gid);
              else next.add(gid);
              return next;
            })
          }
          leftOut={(preview as ResponseOf<typeof apiRoutes.opsPromotePreview>).leftOut}
        />
      ) : null}

      {raw.conflicts.length > 0 ? (
        <Card className="p-5" testId="merge-conflicts">
          <SectionLabel>Conflicts · {plural(raw.conflicts.length, "conflict")}</SectionLabel>
          <ul className="flex flex-col divide-y divide-line">
            {raw.conflicts.map((c, i) => (
              <ConflictRow
                key={c.path}
                index={i}
                conflict={c}
                labels={labels}
                names={names}
                picked={picked[c.path]}
                focused={focus === c.path}
                onPick={(r) =>
                  setPicked((p) => {
                    const next = { ...p };
                    if (r) next[c.path] = r;
                    else delete next[c.path];
                    return next;
                  })
                }
              />
            ))}
          </ul>
        </Card>
      ) : null}

      {rows.length > 0 ? (
        <div className="dt dt-ana" data-testid="merge-fields">
          <table>
            <thead>
              <tr className="dt-cols">
                <th>Agent and settings</th>
                <th>{names.base}</th>
                <th>{names.ours}</th>
                <th>{names.theirs}</th>
                <th>Merged</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.path} data-testid={`merge-field-${r.path}`}>
                  <td className="text-ink">
                    {r.label}
                    {r.conflict ? (
                      <Badge tone={r.waiting ? "warning" : "positive"} className="ml-2">
                        {r.waiting ? "Conflict" : "Resolved"}
                      </Badge>
                    ) : null}
                  </td>
                  <td className="reference break-words text-ink-muted">{r.base}</td>
                  <td className="reference break-words">{r.ours ?? <Same />}</td>
                  <td className="reference break-words">{r.theirs ?? <Same />}</td>
                  <td className="reference break-words text-ink">{r.result}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card className="p-5" testId="merge-steps">
          <SectionLabel
            action={
              workflows.length > 1 ? (
                <span className="flex flex-wrap gap-1">
                  {workflows.map((w) => (
                    <Button
                      key={w.slug}
                      size="sm"
                      variant={w.slug === shownWorkflow?.slug ? "secondary" : "ghost"}
                      onClick={() => setSlug(w.slug)}
                      data-testid={`merge-workflow-${w.slug}`}
                    >
                      {w.name}
                    </Button>
                  ))}
                </span>
              ) : null
            }
          >
            Merged workflow{shownWorkflow ? ` · ${shownWorkflow.name}` : ""}
          </SectionLabel>
          {shownWorkflow ? (
            <StepList workflow={shownWorkflow.workflow} marks={stepMark} />
          ) : (
            <p className="text-sm text-ink-muted">No workflows.</p>
          )}
          {removed.length > 0 ? (
            <div className="mt-5" data-testid="merge-removed">
              <p className="eyebrow mb-2 text-ink-muted">Removed</p>
              <ul className="flex flex-col gap-1 text-sm">
                {removed.map((r) => (
                  <li key={`${r.side}:${r.key}`}>
                    {r.name}{" "}
                    <span className="text-ink-muted">· by {names[r.side].toLowerCase()}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Card>

        <div className="flex flex-col gap-5 self-start">
          <Problems errors={validation.errors} bundle={result.bundle} />
          <Card className="p-5" testId="merge-save">
            <SectionLabel>Save the merge</SectionLabel>
            {saved ? (
              <Saved mode={mode} saved={saved} bundle={result.bundle} />
            ) : (
              <div className="flex flex-col gap-3">
                <Field label="Change note">
                  <TextInput
                    value={changeNote}
                    onChange={(e) => setChangeNote(e.target.value)}
                    placeholder={
                      mode === "update"
                        ? `Update from template v${preview.theirs.version}`
                        : "Promoted from a client"
                    }
                    data-testid="merge-change-note"
                  />
                </Field>
                {mode === "promote" ? (
                  <Field label="Release note" hint="Clients' update reviews show it.">
                    <TextInput
                      value={releaseNote}
                      onChange={(e) => setReleaseNote(e.target.value)}
                      data-testid="merge-release-note"
                    />
                  </Field>
                ) : null}
                <p className="text-sm text-ink-muted">
                  {open > 0
                    ? `Resolve ${plural(open, "conflict")} first.`
                    : !validation.valid
                      ? "Fix the problems first."
                      : nothing
                        ? "Pick at least one change to promote."
                        : mode === "update"
                          ? "Saves a draft of this client's agent. Nothing goes live until you publish it."
                          : "Saves a template draft. No client agent changes."}
                </p>
                {action.error ? (
                  <Notice tone="warning" testId="merge-save-error">
                    {errorText(action.error)}
                    {detailMessages(action.error).length > 0 ? (
                      <ul className="mt-2 list-disc pl-5">
                        {detailMessages(action.error).map((m) => (
                          <li key={m}>{m}</li>
                        ))}
                      </ul>
                    ) : null}
                  </Notice>
                ) : null}
                <Button
                  variant="primary"
                  disabled={!canSave}
                  onClick={save}
                  data-testid="merge-save-button"
                >
                  {mode === "update" ? "Save merge draft" : "Save template draft"}
                </Button>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function Same() {
  return <span className="text-ink-muted">unchanged</span>;
}

function Saved({
  mode,
  saved,
  bundle,
}: {
  mode: Mode;
  saved: { version: number; to: AgentSummary };
  bundle: AgentBundle;
}) {
  const base = agentBase(saved.to);
  const first = bundle.workflows[0]?.slug;
  return (
    <div className="flex flex-col gap-3" data-testid="merge-saved">
      <Notice tone="positive">
        Saved v{saved.version} as a draft of{" "}
        {mode === "update" ? "this client's agent" : `template “${saved.to.name}”`}. Test-run it,
        then publish it from Versions.
      </Notice>
      <div className="flex flex-wrap gap-2">
        {first ? (
          <Link
            to={`${base}/workflows/${first}`}
            className={buttonClass("primary")}
            data-testid="merge-open-builder"
          >
            Open to test-run
          </Link>
        ) : null}
        <Link
          to={`${base}/versions`}
          className={buttonClass("secondary")}
          data-testid="merge-open-versions"
        >
          Versions
        </Link>
      </div>
    </div>
  );
}

function ConflictRow({
  conflict: c,
  index,
  labels,
  names,
  picked,
  focused,
  onPick,
}: {
  conflict: MergeConflict;
  index: number;
  labels: Record<string, string>;
  names: Record<Side | "base", string>;
  picked: Resolution | undefined;
  focused: boolean;
  onPick(r: Resolution | null): void;
}) {
  const [editing, setEditing] = useState(picked?.choice === "value");
  const editValue = picked?.choice === "value" ? picked.value : c.ours;
  const textual = [c.base, c.ours, c.theirs].every((v) => v === undefined || typeof v === "string");
  const choices = conflictChoices(c);
  return (
    <li
      className={cx("py-3", focused && "rounded-sm bg-slate-tint px-3")}
      data-testid={`merge-conflict-${index}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-medium text-ink">{conflictText(c, labels)}</p>
        {picked ? (
          <Badge tone="positive">
            Resolved:{" "}
            {picked.choice === "value"
              ? "edited"
              : picked.choice === "base"
                ? names.base.toLowerCase()
                : names[picked.choice].toLowerCase()}
          </Badge>
        ) : (
          <Badge tone="warning">Waiting on you</Badge>
        )}
      </div>
      <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-3">
        {(["base", "ours", "theirs"] as const).map((side) => (
          <div key={side} className="rounded-sm border border-line px-3 py-2">
            <p className="eyebrow text-ink-muted">{names[side]}</p>
            <p className="reference break-words text-ink">{conflictValue(c, c[side], labels)}</p>
          </div>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {choices.map((choice) => (
          <Button
            key={choice}
            size="sm"
            variant={picked?.choice === choice ? "primary" : "secondary"}
            data-testid={`merge-conflict-${index}-${choice}`}
            onClick={() => {
              setEditing(false);
              onPick({ path: c.path, choice });
            }}
          >
            Use {names[choice].toLowerCase()}
          </Button>
        ))}
        {c.kind === "field" ? (
          <Button
            size="sm"
            variant={editing ? "primary" : "secondary"}
            data-testid={`merge-conflict-${index}-edit`}
            onClick={() => {
              setEditing(true);
              onPick({ path: c.path, choice: "value", value: editValue });
            }}
          >
            Edit
          </Button>
        ) : null}
        {picked ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setEditing(false);
              onPick(null);
            }}
          >
            Undo
          </Button>
        ) : null}
      </div>
      {editing && c.kind === "field" ? (
        <div className="mt-2">
          {textual ? (
            <TextArea
              rows={3}
              value={typeof editValue === "string" ? editValue : ""}
              onChange={(e) => onPick({ path: c.path, choice: "value", value: e.target.value })}
              data-testid={`merge-conflict-${index}-value`}
            />
          ) : (
            <JsonInput
              value={editValue}
              field={c.path}
              testId={`merge-conflict-${index}-value`}
              onChange={(value) => onPick({ path: c.path, choice: "value", value })}
            />
          )}
        </div>
      ) : null}
    </li>
  );
}

function PromoteChoices({
  groups,
  labels,
  unselected,
  onToggle,
  leftOut,
}: {
  groups: ReturnType<typeof selectableBetween>;
  labels: Record<string, string>;
  unselected: ReadonlySet<string>;
  onToggle(id: string): void;
  leftOut: ResponseOf<typeof apiRoutes.opsPromotePreview>["leftOut"];
}) {
  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
      <Card className="p-5" testId="merge-promote-changes">
        <SectionLabel>
          Changes to promote · {groups.length - unselected.size} of {groups.length}
        </SectionLabel>
        {groups.length === 0 ? (
          <p className="text-sm text-ink-muted">
            This client's agent has no changes to promote beyond its client-specific values.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {groups.map((g, i) => {
              const first = describeChange(g.changes[0] as (typeof g.changes)[number], labels);
              const more = g.changes.length - 1;
              return (
                <li key={g.id} className="py-2">
                  <label className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={!unselected.has(g.id)}
                      onChange={() => onToggle(g.id)}
                      data-testid={`merge-promote-${i}`}
                    />
                    <span>
                      <span className="text-ink">{first.text}</span>
                      {more > 0 ? (
                        <span className="text-sm text-ink-muted">
                          {" "}
                          and {plural(more, "more change")}
                        </span>
                      ) : null}
                      {first.after !== undefined ? (
                        <span className="block reference break-words text-ink-muted">
                          {first.after}
                        </span>
                      ) : null}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <Card className="p-5" testId="merge-left-out">
        <SectionLabel>Stays with the client · {plural(leftOut.length, "value")}</SectionLabel>
        <p className="mb-2 text-sm text-ink-muted">
          Settings marked client-specific and ids of the client's records are never promoted.
          Bindings, memory, records and connections are not part of an agent's versions.
        </p>
        <ChangeList
          changes={leftOut}
          labels={labels}
          empty="Nothing client-specific to leave out."
        />
      </Card>
    </div>
  );
}

function Problems({ errors, bundle }: { errors: ValidationError[]; bundle: AgentBundle }) {
  if (errors.length === 0) {
    return (
      <p className="text-sm text-ink-muted" data-testid="merge-problems-none">
        The merged agent validates.
      </p>
    );
  }
  const where = (e: ValidationError) => {
    const w = e.workflow ? bundle.workflows.find((x) => x.slug === e.workflow) : undefined;
    return w ? w.name : "Agent";
  };
  return (
    <div className="ds-banner block" data-testid="merge-problems">
      <p className="text-sm font-medium">{plural(errors.length, "problem")} in the merged agent</p>
      <ul className="mt-2 flex flex-col gap-1 text-sm">
        {errors.map((e) => (
          <li key={`${e.workflow}:${e.stepId}:${e.field}:${e.code}:${e.message}`}>
            <span className="font-medium">{where(e)}</span>: {e.message}
          </li>
        ))}
      </ul>
    </div>
  );
}
