// Check the skill (owner, 2026-11-24: "do the edit-and-try screen next"). On a skill draft still
// being written: what it gets, what it does and what it gives back, each editable by hand, then
// Try it once on the sample it was described with, another file or JSON. A try runs on the test
// bench (in memory, every write refused); what it gave back can be kept as a test. A change by
// hand is the operator's turn in the conversation, undoable like the Builder's.
import type { SkillDefinition, SkillTryView } from "@countersign/core";
import { useRef, useState } from "react";
import { apiRoutes } from "../../api/routes";
import { Field, Select, TextArea, TextInput } from "../../ui/forms";
import { Badge, Button, Card } from "../../ui/primitives";
import { errorText, Notice, useAction } from "../agents/ui";
import { SAMPLE_ACCEPT, SAMPLE_MAX_BYTES } from "../flow/SkillDescribe";
import {
  blankField,
  HAS_FIELDS,
  SHAPE_KIND_LABEL,
  SHAPE_KINDS,
  type ShapeField,
  type ShapeKind,
  schemaFromShape,
  shapeFromSchema,
  shapeProblems,
} from "./shape";

function base64Of(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export interface CheckSkillProps {
  sessionId: string;
  definition: SkillDefinition;
  /** The first test's input: what Try it on JSON starts from. */
  firstInput?: unknown;
  /** The sample the skill was described with, when this page was opened from there. */
  sample?: File | null | undefined;
  /** After a change is saved or a try is kept: read the conversation again. */
  onChanged(): void;
}

export function CheckSkill({
  sessionId,
  definition,
  firstInput,
  sample,
  onChanged,
}: CheckSkillProps) {
  const save = useAction();
  const [input, setInput] = useState(() => shapeFromSchema(definition.input));
  const [output, setOutput] = useState(() => shapeFromSchema(definition.output));
  const [instructions, setInstructions] = useState(definition.instructions ?? "");
  const inputSchema = schemaFromShape(input);
  const outputSchema = schemaFromShape(output);
  const changed = {
    input: !same(inputSchema, schemaFromShape(shapeFromSchema(definition.input))),
    output: !same(outputSchema, schemaFromShape(shapeFromSchema(definition.output))),
    instructions: instructions.trim() !== (definition.instructions ?? "").trim(),
  };
  const dirty = changed.input || changed.output || changed.instructions;
  const problems = [
    ...shapeProblems(input, "What it gets"),
    ...shapeProblems(output, "What it gives back"),
    ...(instructions.trim() ? [] : ["Say what it does."]),
  ];

  async function saveChanges() {
    const res = await save.call(apiRoutes.opsBuilderSkillEdit, {
      params: { id: sessionId },
      body: {
        ...(changed.input ? { input: inputSchema } : {}),
        ...(changed.instructions ? { instructions: instructions.trim() } : {}),
        ...(changed.output ? { output: outputSchema } : {}),
      },
    });
    if (res.ok) onChanged();
  }

  function reset() {
    setInput(shapeFromSchema(definition.input));
    setOutput(shapeFromSchema(definition.output));
    setInstructions(definition.instructions ?? "");
  }

  return (
    <div className="flex flex-col gap-6" data-testid="check-skill">
      <Card title="What it gets" meta="The fields the step hands it" pad>
        <ShapeEditor side="input" fields={input} onChange={setInput} />
      </Card>
      <Card
        title="What it does"
        meta={
          definition.mode === "tool"
            ? "Rule rows, no model"
            : `AI on ${definition.model?.id ?? "the agent's model"}`
        }
        pad
      >
        <TextArea
          rows={6}
          className="w-full"
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          data-testid="check-skill-instructions"
        />
        <p className="mt-2 text-sm text-ink-muted">
          Plain steps it follows, firm rules first. One rule a line reads best.
        </p>
      </Card>
      <Card title="What it gives back" meta="The fields the next step reads" pad>
        <ShapeEditor side="output" fields={output} onChange={setOutput} />
      </Card>
      {dirty ? (
        <div className="flex flex-col gap-2" data-testid="check-skill-unsaved">
          {problems.length > 0 ? (
            <ul className="ds-error flex flex-col gap-1 text-sm" data-testid="check-skill-problems">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          ) : null}
          {save.error ? <Notice tone="warning">{errorText(save.error)}</Notice> : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              disabled={problems.length > 0}
              working={save.busy}
              onClick={() => void saveChanges()}
              data-testid="check-skill-save"
            >
              Save changes
            </Button>
            <Button variant="ghost" onClick={reset} data-testid="check-skill-reset">
              Put it back
            </Button>
            <span className="text-sm text-ink-muted">
              Saved changes show in the conversation, and each can be undone.
            </span>
          </div>
        </div>
      ) : null}
      <TrySkill
        sessionId={sessionId}
        blocked={dirty}
        firstInput={firstInput}
        sample={sample ?? null}
        onKept={onChanged}
      />
    </div>
  );
}

/** One side's fields: name, kind, meaning, required; a list of records has its own fields. */
function ShapeEditor({
  side,
  fields,
  onChange,
  depth = 0,
}: {
  side: "input" | "output";
  fields: ShapeField[];
  onChange(next: ShapeField[]): void;
  depth?: number;
}) {
  const set = (i: number, patch: Partial<ShapeField>) =>
    onChange(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const id = (i: number, part: string) => `check-skill-${side}-${depth}-${i}-${part}`;
  return (
    <div
      className={
        depth > 0 ? "flex flex-col gap-2 border-l border-line pl-4" : "flex flex-col gap-3"
      }
      data-testid={`check-skill-${side}${depth > 0 ? "-nested" : ""}`}
    >
      {fields.length === 0 ? (
        <p className="text-sm text-ink-muted">
          {side === "input" ? "Gets nothing yet." : "Gives nothing back yet."}
        </p>
      ) : null}
      {fields.map((f, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a field has no id until it is named.
        <div key={i} className="flex flex-col gap-2">
          <div className="grid grid-cols-1 items-end gap-2 md:grid-cols-[minmax(0,1fr)_170px_minmax(0,1.4fr)_auto_auto]">
            <Field label="Field">
              <TextInput
                value={f.name}
                onChange={(e) => set(i, { name: e.target.value })}
                placeholder="buyer"
                data-testid={id(i, "name")}
              />
            </Field>
            <Field label="Kind">
              <Select
                value={f.kind}
                onChange={(e) => {
                  const kind = e.target.value as ShapeKind;
                  set(i, { kind, fields: HAS_FIELDS.has(kind) ? f.fields : [] });
                }}
                data-testid={id(i, "kind")}
              >
                {SHAPE_KINDS.filter(
                  // One level down: no records inside records, and a document only comes in.
                  (k) =>
                    (depth === 0 || !HAS_FIELDS.has(k)) && (k !== "document" || side === "input"),
                ).map((k) => (
                  <option key={k} value={k}>
                    {SHAPE_KIND_LABEL[k]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Meaning">
              <TextInput
                value={f.meaning}
                onChange={(e) => set(i, { meaning: e.target.value })}
                placeholder="Who filed it, as written"
                data-testid={id(i, "meaning")}
              />
            </Field>
            <label className="flex h-9 items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                className="size-4 accent-slate"
                checked={f.required}
                onChange={(e) => set(i, { required: e.target.checked })}
                data-testid={id(i, "required")}
              />
              Required
            </label>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Remove ${f.name || "field"}`}
              onClick={() => onChange(fields.filter((_, j) => j !== i))}
              data-testid={id(i, "remove")}
            >
              Remove
            </Button>
          </div>
          {HAS_FIELDS.has(f.kind) ? (
            <ShapeEditor
              side={side}
              depth={depth + 1}
              fields={f.fields}
              onChange={(next) => set(i, { fields: next })}
            />
          ) : null}
        </div>
      ))}
      <div>
        <Button
          size="sm"
          onClick={() => onChange([...fields, blankField()])}
          data-testid={`check-skill-${side}-${depth}-add`}
        >
          {depth > 0 ? "Add a field to each record" : "Add a field"}
        </Button>
      </div>
    </div>
  );
}

/** Try it: once, on the sample, another file or JSON; what it gave back may be kept as a test. */
function TrySkill({
  sessionId,
  blocked,
  firstInput,
  sample,
  onKept,
}: {
  sessionId: string;
  blocked: boolean;
  firstInput: unknown;
  sample: File | null;
  onKept(): void;
}) {
  const run = useAction();
  const keep = useAction();
  const pickRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(sample);
  const [way, setWay] = useState<"file" | "json">(sample ? "file" : "json");
  const [json, setJson] = useState(() =>
    firstInput === undefined ? "{}" : JSON.stringify(firstInput, null, 2),
  );
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [result, setResult] = useState<SkillTryView | null>(null);
  const [caseName, setCaseName] = useState("");
  const [kept, setKept] = useState(false);

  async function tryIt() {
    setResult(null);
    setKept(false);
    setJsonError(null);
    let body:
      | { input: unknown }
      | { sample: { filename: string; mimeType: string; base64: string } };
    if (way === "file") {
      if (!file) return;
      if (file.size > SAMPLE_MAX_BYTES) {
        setFileError(`${file.name} is over 5 MB.`);
        return;
      }
      body = {
        sample: {
          filename: file.name,
          mimeType: file.type,
          base64: base64Of(await file.arrayBuffer()),
        },
      };
    } else {
      try {
        body = { input: JSON.parse(json) };
      } catch {
        setJsonError("That isn't valid JSON.");
        return;
      }
    }
    const res = await run.call(apiRoutes.opsBuilderSkillTry, { params: { id: sessionId }, body });
    if (res.ok) {
      setResult(res.data);
      setCaseName(file && way === "file" ? file.name.replace(/\.[^.]+$/, "") : "Tried by hand");
    }
  }

  async function keepIt() {
    if (!result) return;
    const res = await keep.call(apiRoutes.opsBuilderSkillEdit, {
      params: { id: sessionId },
      body: {
        addCase: {
          name: caseName.trim() || "Tried by hand",
          input: result.input,
          expected: result.output,
        },
      },
    });
    if (res.ok) {
      setKept(true);
      onKept();
    }
  }

  const ready = way === "file" ? !!file : json.trim() !== "";
  return (
    <Card title="Try it" meta="Runs once as a test: it never writes" pad testId="try-skill">
      <div className="flex flex-col gap-4">
        <fieldset className="ds-seg self-start" aria-label="Try it on">
          <button
            type="button"
            aria-pressed={way === "file"}
            onClick={() => setWay("file")}
            data-testid="try-skill-way-file"
          >
            A file
          </button>
          <button
            type="button"
            aria-pressed={way === "json"}
            onClick={() => setWay("json")}
            data-testid="try-skill-way-json"
          >
            JSON
          </button>
        </fieldset>
        {way === "file" ? (
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={pickRef}
              type="file"
              accept={SAMPLE_ACCEPT}
              className="sr-only"
              data-testid="try-skill-file"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) {
                  setFile(f);
                  setFileError(null);
                }
                e.target.value = "";
              }}
            />
            <Button size="sm" onClick={() => pickRef.current?.click()} data-testid="try-skill-pick">
              {file ? "Use another file" : "Choose a file"}
            </Button>
            <span className="text-sm text-ink-muted" data-testid="try-skill-file-name">
              {file
                ? `${file.name}${file === sample ? ", your sample" : ""}. A spreadsheet's rows go to its list of rows; a PDF or an image to its document.`
                : "A spreadsheet, a PDF or an image. Nothing of it is kept."}
            </span>
            {fileError ? <p className="ds-error w-full text-sm">{fileError}</p> : null}
          </div>
        ) : (
          <Field label="What it gets, as JSON" error={jsonError ?? undefined}>
            <TextArea
              rows={8}
              className="w-full font-mono text-xs"
              value={json}
              onChange={(e) => setJson(e.target.value)}
              data-testid="try-skill-json"
            />
          </Field>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            disabled={blocked || !ready}
            working={run.busy}
            onClick={() => void tryIt()}
            data-testid="try-skill-run"
          >
            Try it
          </Button>
          {blocked ? (
            <span className="text-sm text-ink-muted" data-testid="try-skill-blocked">
              Save your changes first: a try runs the draft as saved.
            </span>
          ) : null}
        </div>
        {run.error ? (
          <Notice tone="warning" testId="try-skill-error">
            {errorText(run.error)}
          </Notice>
        ) : null}
        {result ? (
          <div className="flex flex-col gap-3" data-testid="try-skill-result">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge
                tone={result.status === "succeeded" ? "positive" : "risk"}
                testId="try-skill-status"
              >
                {result.status === "succeeded" ? "Done" : "Failed"}
              </Badge>
              <span className="text-ink-muted">
                {[
                  result.from ? `On ${result.from}` : "On your JSON",
                  `${result.modelCalls} model ${result.modelCalls === 1 ? "call" : "calls"}`,
                  `$${Number(result.costUsd).toFixed(4)}`,
                ].join(" · ")}
              </span>
            </div>
            {result.error ? (
              <p className="ds-error text-sm" data-testid="try-skill-failure">
                {result.error}
              </p>
            ) : (
              <pre
                className="max-h-96 overflow-auto rounded-md border border-line bg-surface-subtle p-3 font-mono text-xs text-ink"
                data-testid="try-skill-output"
              >
                {JSON.stringify(result.output, null, 2)}
              </pre>
            )}
            {result.status === "succeeded" && result.keepable ? (
              kept ? (
                <p className="text-sm text-ink" data-testid="try-skill-kept">
                  Kept as a test: this input, with this answer expected.
                </p>
              ) : (
                <div className="flex flex-wrap items-end gap-2">
                  <Field label="Test name" className="min-w-0 flex-1">
                    <TextInput
                      value={caseName}
                      onChange={(e) => setCaseName(e.target.value)}
                      maxLength={200}
                      data-testid="try-skill-case-name"
                    />
                  </Field>
                  <Button
                    working={keep.busy}
                    onClick={() => void keepIt()}
                    data-testid="try-skill-keep"
                  >
                    Keep as a test
                  </Button>
                </div>
              )
            ) : result.status === "succeeded" ? (
              <p className="text-sm text-ink-muted">
                A try on a document can't be kept as a test: the file isn't stored.
              </p>
            ) : null}
            {keep.error ? <Notice tone="warning">{errorText(keep.error)}</Notice> : null}
          </div>
        ) : null}
      </div>
    </Card>
  );
}
