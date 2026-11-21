// Reshape data (owner, 2026-11-11) in the builder's inspector: the step's output fields with their
// mapping and the value each would hold (the latest test or live run's real output of the step
// before, else a sample made from the types), each field editable; "Propose a mapping" (by name
// and type, then the Builder AI for what is left, every suggestion checked by the server) and,
// when the validator flags the mapping, "Propose an updated mapping" that keeps what still fits.
import {
  processes,
  type ReshapeProposalView,
  type ReshapeSampleView,
  type TypingContext,
} from "@countersign/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiRoutes } from "../../api/routes";
import { Button, cx } from "../../ui/primitives";
import { errorText, TextArea, useAction } from "../agents/ui";
import type { BuilderProblem } from "./catalog";
import { SmallInput, SmallSelect } from "./fields";
import type { Process, Step } from "./model";
import {
  applyProposal,
  copyPaths,
  exprText,
  recordFields,
  recordSchema,
  sampleText,
} from "./reshape";

type SkillStep = Extract<Step, { kind: "skill" }>;
type Field = processes.ReshapeField;
type EditKind = "none" | "copy" | "value" | "record" | "expression";

/** §1.164: the agent's skills with their parameters, so the server types Read table's rows too. */
function agentSkillsOf(ctx: TypingContext) {
  return ctx.agentSkills
    ? {
        agentSkills: ctx.agentSkills.map((s) => ({
          skill: s.skill,
          ...(s.parameters ? { parameters: { ...s.parameters } } : {}),
        })),
      }
    : {};
}

const HOW_WORDS: Record<string, string> = {
  exact: "same name",
  name: "same name, other spelling",
  synonym: "a name that means the same",
  kept: "kept: it still fits",
  fields: "built field by field",
  ai: "suggested by the Builder AI",
};

function kindOf(e: processes.ReshapeExpr | undefined): EditKind {
  if (!e) return "none";
  if ("input" in e) return "copy";
  if ("value" in e) return "value";
  if ("object" in e) return "record";
  return "expression";
}

/** A typed value from what the operator wrote: a number, true or false, or text. */
function literal(text: string): processes.ReshapeExpr {
  const t = text.trim();
  if (/^-?\d+(\.\d+)?$/.test(t) && !/^0\d/.test(t)) return { value: Number(t) };
  if (t === "true" || t === "false") return { value: t === "true" };
  return { value: text };
}

function FieldEditor({
  field,
  paths,
  path: at = field.name,
  depth = 0,
  onSave,
  onCancel,
}: {
  field: Field;
  paths: readonly { path: string }[];
  /** The field's path in the output (`customer.email` inside a record). */
  path?: string;
  /** How many records deep the field sits. */
  depth?: number;
  onSave(from: processes.ReshapeExpr | undefined): void;
  onCancel(): void;
}) {
  const [kind, setKind] = useState<EditKind>(kindOf(field.from));
  // §1.164: a field that takes a record (or is built as one) is built field by field.
  const [record, setRecord] = useState<Record<string, processes.ReshapeExpr>>(
    field.from && "object" in field.from ? field.from.object.fields : {},
  );
  const canRecord =
    (recordSchema(field.schema) !== null || kind === "record") &&
    depth < processes.RESHAPE_MAX_NESTING;
  const [path, setPath] = useState(
    field.from && "input" in field.from ? field.from.input : (paths[0]?.path ?? ""),
  );
  const [value, setValue] = useState(
    field.from && "value" in field.from
      ? typeof field.from.value === "string"
        ? field.from.value
        : JSON.stringify(field.from.value)
      : "",
  );
  const [json, setJson] = useState(field.from ? JSON.stringify(field.from, null, 2) : "");
  const parsed = useMemo(() => {
    if (kind !== "expression") return null;
    try {
      const r = processes.ReshapeExpr.safeParse(JSON.parse(json));
      return r.success ? { ok: true as const, expr: r.data } : { ok: false as const };
    } catch {
      return { ok: false as const };
    }
  }, [kind, json]);
  const save = () => {
    if (kind === "none") return onSave(undefined);
    if (kind === "copy") return onSave(path ? { input: path } : undefined);
    if (kind === "value") return onSave(literal(value));
    if (kind === "record") return onSave({ object: { fields: record } });
    if (parsed?.ok) onSave(parsed.expr);
  };
  return (
    <div className="flex flex-col gap-2" data-testid={`builder-reshape-editor-${at}`}>
      <SmallSelect
        aria-label={`How ${at} is filled`}
        data-testid="builder-reshape-kind"
        value={kind}
        onChange={(e) => setKind(e.target.value as EditKind)}
      >
        <option value="none">Not mapped</option>
        <option value="copy">Copy a field</option>
        <option value="value">A fixed value</option>
        {canRecord ? <option value="record">Field by field (a record)</option> : null}
        <option value="expression">Worked out (an expression)</option>
      </SmallSelect>
      {kind === "copy" ? (
        <SmallSelect
          aria-label="Field to copy"
          data-testid="builder-reshape-path"
          value={path}
          onChange={(e) => setPath(e.target.value)}
        >
          {paths.map((p) => (
            <option key={p.path} value={p.path}>
              {p.path}
            </option>
          ))}
        </SmallSelect>
      ) : null}
      {kind === "value" ? (
        <SmallInput
          aria-label="Fixed value"
          data-testid="builder-reshape-value"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      ) : null}
      {kind === "record" ? (
        <RecordEditor
          schema={field.schema}
          fields={record}
          paths={paths}
          path={at}
          depth={depth + 1}
          onChange={setRecord}
        />
      ) : null}
      {kind === "expression" ? (
        <>
          <TextArea
            aria-label="Expression"
            data-testid="builder-reshape-json"
            rows={5}
            value={json}
            invalid={parsed?.ok === false}
            onChange={(e) => setJson(e.target.value)}
          />
          <p className="text-xs text-ink-muted">
            JSON from the allowed set: input, value, today, sum, difference, percentChange,
            daysBetween, bucket, formatDate, formatNumber, formatMoney, join, split, pick, pluck,
            mapList, object, convertUnit.
          </p>
          {parsed?.ok === false ? (
            <p className="ds-error text-xs">Not an expression from the allowed set.</p>
          ) : null}
        </>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          data-testid="builder-reshape-save-field"
          disabled={
            (kind === "expression" && parsed?.ok !== true) ||
            (kind === "record" && Object.keys(record).length === 0)
          }
          onClick={save}
        >
          Use this
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** §1.164: a record's fields, each mapped like a field of its own. */
function RecordEditor({
  schema,
  fields,
  paths,
  path,
  depth,
  onChange,
}: {
  schema: Field["schema"];
  fields: Record<string, processes.ReshapeExpr>;
  paths: readonly { path: string }[];
  path: string;
  depth: number;
  onChange(fields: Record<string, processes.ReshapeExpr>): void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const rows = recordFields(schema, fields);
  const set = (name: string, from: processes.ReshapeExpr | undefined) => {
    const { [name]: _old, ...rest } = fields;
    onChange(from ? { ...rest, [name]: from } : rest);
    setEditing(null);
  };
  return (
    <ul
      className="flex flex-col border-l-2 border-line pl-3"
      data-testid={`builder-reshape-record-${path}`}
    >
      {rows.length === 0 ? (
        <li className="text-sm text-ink-muted">This record names no fields.</li>
      ) : null}
      {rows.map((r) => {
        const sub = `${path}.${r.name}`;
        const from = fields[r.name];
        return (
          <li
            key={r.name}
            className="flex flex-col gap-1 py-1"
            data-testid={`builder-reshape-field-${sub}`}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-sm text-ink">
                <span className="reference">{r.name}</span>{" "}
                <span className="text-xs text-ink-muted">
                  {processes.typeWords(processes.schemaTypeNames(r.schema)) || "anything"}
                  {r.required ? "" : ", optional"}
                </span>
              </span>
              {editing === r.name ? null : (
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid={`builder-reshape-edit-${sub}`}
                  onClick={() => setEditing(r.name)}
                >
                  Edit
                </Button>
              )}
            </div>
            {editing === r.name ? (
              <FieldEditor
                field={{
                  name: r.name,
                  schema: r.schema,
                  ...(r.required ? {} : { required: false }),
                  ...(from ? { from } : {}),
                }}
                paths={paths}
                path={sub}
                depth={depth}
                onSave={(f) => set(r.name, f)}
                onCancel={() => setEditing(null)}
              />
            ) : (
              <p
                className={cx("text-sm break-words", from ? "text-ink" : "text-ink-muted")}
                data-testid={`builder-reshape-from-${sub}`}
              >
                {from ? exprText(from) : r.required ? "Not mapped" : "Not mapped (left out)"}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function ReshapeFields({
  step,
  workflow,
  ctx,
  agentId,
  errors,
  onProcess,
}: {
  step: SkillStep;
  workflow: Process;
  ctx: TypingContext;
  agentId: string | undefined;
  /** This step's validation problems. */
  errors: readonly BuilderProblem[];
  /** One edit to the process (the step and the next one wired to it), one undo. */
  onProcess(fn: (w: Process) => Process, key: string): void;
}) {
  const fields = step.reshape?.fields ?? [];
  const context = useMemo(
    () => processes.reshapeContext(workflow, step.id, ctx),
    [workflow, step.id, ctx],
  );
  const paths = useMemo(() => copyPaths(context), [context]);
  const propose = useAction();
  const sample = useAction();
  const [proposal, setProposal] = useState<ReshapeProposalView | null>(null);
  const [samples, setSamples] = useState<ReshapeSampleView | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const flagged = errors.filter((e) => e.code === "reshape_mapping");

  async function ask(update: boolean) {
    if (!agentId) return;
    const res = await propose.call(apiRoutes.opsReshapePropose, {
      params: { id: agentId },
      body: {
        process: workflow,
        stepId: step.id,
        ...agentSkillsOf(ctx),
        ...(update ? { update: true } : {}),
      },
    });
    if (!res.ok) return;
    setProposal(res.data);
    onProcess(
      (w) => applyProposal(w, step.id, { input: res.data.input, mapping: res.data.mapping }, ctx),
      `${step.id}:reshape:propose`,
    );
  }

  // A new Reshape step (from the palette, with no fields) asks for its mapping once.
  const asked = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: asked once per step, when it is new.
  useEffect(() => {
    if (asked.current || fields.length > 0 || !context?.next || !agentId) return;
    asked.current = true;
    void ask(false);
  }, [step.id]);

  // The sample follows the mapping: asked again when the step's input or mapping changes.
  const shape = JSON.stringify([step.input, step.reshape]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `shape` is the step's own content.
  useEffect(() => {
    if (!agentId || fields.length === 0) return;
    const t = window.setTimeout(async () => {
      const res = await sample.call(apiRoutes.opsReshapeSample, {
        params: { id: agentId },
        body: { process: workflow, stepId: step.id, ...agentSkillsOf(ctx) },
      });
      if (res.ok) setSamples(res.data);
    }, 300);
    return () => window.clearTimeout(t);
  }, [agentId, shape]);

  const setField = (name: string, from: processes.ReshapeExpr | undefined) => {
    onProcess((w) => {
      const s = processes.findStep(w, step.id)?.step;
      if (s?.kind !== "skill") return w;
      const mapping: processes.ReshapeMapping = {
        fields: (s.reshape?.fields ?? []).map((f) => {
          if (f.name !== name) return f;
          const { from: _old, ...rest } = f;
          return from ? { ...rest, from } : rest;
        }),
      };
      // A field read from a source the input doesn't bring in yet brings it in.
      const input: Record<string, unknown> = { ...s.input };
      for (const key of from ? processes.exprInputKeys(from) : []) {
        const src = context?.sources.find((x) => x.key === key);
        if (src && !Object.hasOwn(input, key)) input[key] = src.template;
      }
      return applyProposal(w, step.id, { input: input as Record<string, string>, mapping }, ctx);
    }, `${step.id}:reshape:${name}`);
    setEditing(null);
  };

  const sampleOf = (name: string) => samples?.fields.find((f) => f.name === name);
  const problemsOf = (name: string) =>
    flagged.filter((e) => e.field === `reshape.${name}`).map((e) => e.message);

  return (
    <section
      className="flex flex-col gap-3 border-t border-line pt-4"
      data-testid="builder-reshape"
    >
      <h3 className="eyebrow text-ink-muted">Mapping</h3>
      <p className="text-sm text-ink">
        {context?.next
          ? `Turns what earlier steps found into what “${context.next.name}” takes.`
          : "Turns what earlier steps found into the fields below."}{" "}
        <span className="text-ink-muted">The same every time; no model when it runs.</span>
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          data-testid="builder-reshape-propose"
          disabled={propose.busy || !agentId}
          onClick={() => ask(false)}
        >
          Propose a mapping
        </Button>
        {flagged.length > 0 ? (
          <Button
            size="sm"
            data-testid="builder-reshape-propose-update"
            disabled={propose.busy || !agentId}
            onClick={() => ask(true)}
          >
            Propose an updated mapping
          </Button>
        ) : null}
      </div>
      {propose.busy ? <p className="text-sm text-ink-muted">Proposing a mapping…</p> : null}
      {propose.error ? <p className="ds-error text-sm">{errorText(propose.error)}</p> : null}
      {proposal ? (
        <div className="text-sm text-ink" data-testid="builder-reshape-proposal">
          <p>
            {proposal.mapping.fields.filter((f) => f.from).length} of{" "}
            {proposal.mapping.fields.length} fields mapped
            {proposal.ai.asked
              ? `; the Builder AI filled ${proposal.ai.fields.length}${
                  proposal.ai.costUsd ? ` ($${Number(proposal.ai.costUsd).toFixed(4)})` : ""
                }`
              : ""}
            . Check each one before you save.
          </p>
          {proposal.ai.dropped.length > 0 ? (
            <ul className="mt-1 text-xs text-ink-muted" data-testid="builder-reshape-dropped">
              {proposal.ai.dropped.map((d) => (
                <li key={`${d.field}:${d.reason}`}>
                  Left unmapped: <span className="reference">{d.field}</span> ({d.reason})
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {samples ? (
        <p className="text-xs text-ink-muted" data-testid="builder-reshape-sample-source">
          {samples.source === "run" && samples.run
            ? `Values from the ${samples.run.mode} run of ${samples.run.at.slice(0, 10)}.`
            : "Values made from the fields' types: no run has reached this step's sources yet."}
        </p>
      ) : null}
      {fields.length === 0 ? (
        <p className="text-sm text-ink-muted">No fields yet: propose a mapping.</p>
      ) : (
        <ul className="flex flex-col" data-testid="builder-reshape-fields">
          {fields.map((f) => {
            const s = sampleOf(f.name);
            const problems = [...problemsOf(f.name), ...(s?.problem ? [s.problem] : [])];
            const how = proposal?.how[f.name];
            return (
              <li
                key={f.name}
                className="flex flex-col gap-1 border-t border-line py-2"
                data-testid={`builder-reshape-field-${f.name}`}
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm text-ink">
                    <span className="reference">{f.name}</span>{" "}
                    <span className="text-xs text-ink-muted">
                      {processes.typeWords(processes.schemaTypeNames(f.schema)) || "anything"}
                      {f.required === false ? ", optional" : ""}
                    </span>
                  </span>
                  {editing === f.name ? null : (
                    <Button
                      size="sm"
                      variant="ghost"
                      data-testid={`builder-reshape-edit-${f.name}`}
                      onClick={() => setEditing(f.name)}
                    >
                      Edit
                    </Button>
                  )}
                </div>
                {editing === f.name ? (
                  <FieldEditor
                    field={f}
                    paths={paths}
                    onSave={(from) => setField(f.name, from)}
                    onCancel={() => setEditing(null)}
                  />
                ) : (
                  <>
                    <p
                      className={cx("text-sm break-words", f.from ? "text-ink" : "text-ink-muted")}
                      data-testid={`builder-reshape-from-${f.name}`}
                    >
                      {f.from
                        ? exprText(f.from)
                        : f.required === false
                          ? "Not mapped (left out)"
                          : "Not mapped"}
                      {how ? (
                        <span className="text-xs text-ink-muted"> · {HOW_WORDS[how]}</span>
                      ) : null}
                    </p>
                    {f.from ? (
                      <p
                        className="text-xs text-ink-muted break-words"
                        data-testid={`builder-reshape-sample-${f.name}`}
                      >
                        Gives: {s ? sampleText(s.value) : "…"}
                      </p>
                    ) : null}
                  </>
                )}
                {problems.length > 0 ? (
                  <ul
                    className="ds-error text-xs"
                    data-testid={`builder-reshape-problem-${f.name}`}
                  >
                    {problems.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {flagged.some((e) => e.field === "reshape") ? (
        <ul className="ds-error text-xs" data-testid="builder-reshape-problems">
          {flagged
            .filter((e) => e.field === "reshape")
            .map((e) => (
              <li key={e.message}>{e.message}</li>
            ))}
        </ul>
      ) : null}
      {sample.error ? <p className="ds-error text-xs">{errorText(sample.error)}</p> : null}
    </section>
  );
}
