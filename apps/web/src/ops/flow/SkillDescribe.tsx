// Describe a skill (owner, 2026-11-24: "the skill process uses the old flow ... allow the upload of
// a file like excel or csv or pdf, jpeg etc for these... then with words specify the input and the
// output"). A new skill starts here, as a new agent starts on Describe it: a name, a sample of what
// it gets, and in words what it gets, what it gives back and what it does. Draft the skill starts
// a skill build and drafts it at once (the Builder sees the words and the sample), then opens the
// skill's conversation with its draft and tests. No intake questions, no fit-gap.
//
// A spreadsheet sample is read on the spot, in code, as Read table reads one: its columns and its
// first rows as JSON. That is the file "put in a JSON", with no model and no skill. A PDF or an
// image goes to the Builder as it is. Nothing of the sample is stored.
import type { BuildDetail, BuilderSampleFile, SkillSampleView } from "@countersign/core";
import { type ReactNode, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApiClient } from "../../api/useApi";
import { ErrorNotice } from "../../ui/ErrorState";
import { Field, TextArea, TextInput } from "../../ui/forms";
import { Thinking } from "../../ui/motion";
import { Button } from "../../ui/primitives";
import { buildPath } from "../builds/words";

/** 5 MB, the most a sample is read at. */
export const SAMPLE_MAX_BYTES = 5 * 1024 * 1024;

/** What a sample may be: a spreadsheet, a PDF or an image. */
export const SAMPLE_ACCEPT = ".xlsx,.csv,.json,.pdf,.png,.jpg,.jpeg,.gif,.webp";

/** The most each part of the words may say: together they fit the draft's 4,000. */
export const PART_MAX = 1200;

/** The rows of a spreadsheet sample shown as JSON. */
const JSON_ROWS = 3;

function base64Of(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

/** The words the Builder drafts from: each part under its own heading, the empty ones left out. */
export function skillWords(parts: {
  gets: string;
  gives: string;
  does: string;
  sample: string | null;
}): string {
  return [
    parts.gets.trim() ? `What it gets: ${parts.gets.trim()}` : null,
    parts.gives.trim() ? `What it gives back: ${parts.gives.trim()}` : null,
    parts.does.trim() ? `What it does: ${parts.does.trim()}` : null,
    parts.sample ? `Sample file: ${parts.sample}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Where a drafted skill opens: its conversation, else its build. */
export function draftedSkillPath(detail: BuildDetail): string {
  const session = detail.draft?.sessionId;
  return session ? `/ops/skills/new?session=${session}` : buildPath(detail.build.id);
}

export interface SkillDescribeProps {
  /** The client the skill is for; null for a shared skill. */
  clientId?: string | null | undefined;
  /** Above the fields: the lab's choice of what it builds and for whom. */
  header?: ReactNode;
  onCancel?: (() => void) | undefined;
}

export function SkillDescribe({ clientId = null, header, onCancel }: SkillDescribeProps) {
  const api = useApiClient();
  const navigate = useNavigate();
  const pickRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [gets, setGets] = useState("");
  const [gives, setGives] = useState("");
  const [does, setDoes] = useState("");
  const [sample, setSample] = useState<{ file: BuilderSampleFile; view: SkillSampleView } | null>(
    null,
  );
  const [reading, setReading] = useState(false);
  const [sampleError, setSampleError] = useState<string | null>(null);
  // The build once started, so a second try after a failed draft drafts the same one.
  const [started, setStarted] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const said = gets.trim() || gives.trim() || does.trim();
  const usable = !sample?.view.failure || sample.view.kind === "table";
  const canDraft = !busy && !reading && !!name.trim() && !!said && usable;

  async function pick(f: File) {
    setSampleError(null);
    setSample(null);
    if (f.size > SAMPLE_MAX_BYTES) {
      setSampleError(`${f.name} is over 5 MB. Use a smaller sample: a few pages or rows will do.`);
      return;
    }
    setReading(true);
    try {
      const file = { filename: f.name, mimeType: f.type, base64: base64Of(await f.arrayBuffer()) };
      const view = await api.call(apiRoutes.opsSkillSample, { body: { file } });
      setSample({ file, view });
    } catch (e) {
      setSampleError(e instanceof Error ? e.message : "We couldn't read the file.");
    } finally {
      setReading(false);
    }
  }

  async function draft() {
    setBusy(true);
    setError(null);
    try {
      let id = started;
      if (!id) {
        const out = await api.call(apiRoutes.opsStartBuild, {
          body: { kind: "skill", title: name.trim(), ...(clientId ? { clientId } : {}) },
        });
        id = out.build.id;
        setStarted(id);
      }
      // A table that read with a problem still goes: the Builder sees what could be read.
      const withSample = sample && !(sample.view.kind === "table" && !sample.view.table);
      const detail = await api.call(apiRoutes.opsDraftBuildNow, {
        params: { id },
        body: {
          description: skillWords({
            gets,
            gives,
            does,
            sample: withSample ? sample.file.filename : null,
          }),
          ...(withSample ? { sample: sample.file } : {}),
        },
      });
      navigate(draftedSkillPath(detail));
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6" data-testid="skill-describe">
      <div className="flex max-w-[62ch] flex-col gap-2">
        <h2 className="text-2xl font-medium text-ink">What should the skill do?</h2>
        <p className="text-base text-ink-muted">
          A skill is one job a step runs: it gets something, does its work and gives back fields the
          next step reads. Add a sample of what it gets, then say in your words what comes in and
          what should come out.
        </p>
      </div>
      <form
        className="flex flex-col gap-4 rounded-md border border-line bg-surface p-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (canDraft) void draft();
        }}
      >
        {header}
        <Field label="Name">
          <TextInput
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Filter UCC filings"
            maxLength={200}
            data-testid="skill-describe-name"
          />
        </Field>

        <div className="flex flex-col gap-2" data-testid="skill-describe-sample">
          <span className="text-sm font-medium text-ink">A sample of what it gets</span>
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={pickRef}
              type="file"
              accept={SAMPLE_ACCEPT}
              className="sr-only"
              data-testid="skill-describe-sample-file"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void pick(f);
                e.target.value = "";
              }}
            />
            <Button
              size="sm"
              disabled={reading || busy}
              onClick={() => pickRef.current?.click()}
              data-testid="skill-describe-sample-pick"
            >
              {sample ? "Use another file" : "Add a sample file"}
            </Button>
            {sample ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => setSample(null)}
                data-testid="skill-describe-sample-remove"
              >
                Remove
              </Button>
            ) : null}
            <span className="text-sm text-ink-muted">
              {sample
                ? sample.file.filename
                : "A spreadsheet (.xlsx, .csv, .json), a PDF or an image, up to 5 MB. Nothing of it is kept."}
            </span>
          </div>
          {reading ? (
            <p className="text-sm text-ink-muted" role="status">
              Reading the file
            </p>
          ) : null}
          {sampleError ? (
            <p className="ds-error text-sm" data-testid="skill-describe-sample-error">
              {sampleError}
            </p>
          ) : null}
          {sample ? <SamplePreview view={sample.view} /> : null}
        </div>

        <Field label="What it gets" hint="Where it comes from, and what each one holds.">
          <TextArea
            rows={3}
            className="w-full"
            maxLength={PART_MAX}
            value={gets}
            onChange={(e) => setGets(e.target.value)}
            placeholder="The monthly UCC filings, one filing a row, as Read table gives them from the provider's spreadsheet."
            data-testid="skill-describe-gets"
          />
        </Field>
        <Field
          label="What it gives back"
          hint="The fields the next step reads: name each one and say what it holds."
        >
          <TextArea
            rows={4}
            className="w-full"
            maxLength={PART_MAX}
            value={gives}
            onChange={(e) => setGives(e.target.value)}
            placeholder="kept: each filing that stays, with buyer, street, city, county, ZIP, equipment type, make, seller and filing date. removed: each filing taken out, with the reason."
            data-testid="skill-describe-gives"
          />
        </Field>
        <Field
          label="What it does"
          hint="Its rules, one a line. Leave it empty if the above says it all."
        >
          <TextArea
            rows={4}
            className="w-full"
            maxLength={PART_MAX}
            value={does}
            onChange={(e) => setDoes(e.target.value)}
            placeholder={
              "Remove amendments and refinances.\nRemove filings outside our counties.\nMark equipment we don't sell as not applicable."
            }
            data-testid="skill-describe-does"
          />
        </Field>

        {error ? <ErrorNotice error={error} /> : null}
        <div className="flex min-h-9 flex-wrap items-center gap-2">
          {busy ? (
            <div
              className="flex w-full items-start gap-3 rounded-md border border-line bg-surface-subtle px-3.5 py-3"
              role="status"
              data-testid="skill-describe-drafting"
            >
              <Thinking state="drafting" className="mt-0.5 shrink-0" />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-sm">
                <span className="font-medium text-ink">Drafting the skill</span>
                <span className="text-ink-muted">
                  It writes what the skill gets and gives back, its instructions and a test from
                  your sample. This usually takes a minute.
                </span>
              </div>
            </div>
          ) : (
            <>
              <Button
                type="submit"
                variant="primary"
                disabled={!canDraft}
                data-testid="skill-describe-draft"
              >
                Draft the skill
              </Button>
              {onCancel ? (
                <Button variant="ghost" onClick={onCancel} data-testid="skill-describe-cancel">
                  Cancel
                </Button>
              ) : null}
            </>
          )}
        </div>
      </form>
    </div>
  );
}

/** What the sample is: a spreadsheet's columns and first rows as JSON, or a document. */
function SamplePreview({ view }: { view: SkillSampleView }) {
  if (view.kind === "other") {
    return (
      <p className="ds-error text-sm" data-testid="skill-describe-sample-error">
        {view.failure}
      </p>
    );
  }
  if (view.kind === "document") {
    return (
      <p className="text-sm text-ink" data-testid="skill-describe-sample-document">
        {view.mimeType === "application/pdf" ? "A PDF" : "An image"}: the skill reads it with a
        model, and the Builder sees it while drafting.
      </p>
    );
  }
  const table = view.table;
  if (!table) {
    return (
      <p className="ds-error text-sm" data-testid="skill-describe-sample-error">
        We couldn't read it as a spreadsheet: {view.failure}
      </p>
    );
  }
  const json = JSON.stringify(table.rows.slice(0, JSON_ROWS), null, 2);
  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-line bg-surface-subtle p-3"
      data-testid="skill-describe-sample-table"
    >
      <p className="text-sm text-ink" data-testid="skill-describe-sample-summary">
        {table.rowCount.toLocaleString("en-US")} {table.rowCount === 1 ? "row" : "rows"} and{" "}
        {table.columns.length} {table.columns.length === 1 ? "column" : "columns"}
        {table.sheet ? ` on the sheet ${table.sheet}` : ""}. Read table turns it into JSON in code,
        with no model. A skill gets the rows like this:
      </p>
      {table.failure ? <p className="ds-error text-sm">{table.failure}</p> : null}
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted">
        {table.columns.map((c) => (
          <li key={c.field}>
            <span className="font-mono text-ink">{c.field}</span> from “{c.headers[0] ?? c.field}”,{" "}
            {c.type}
          </li>
        ))}
      </ul>
      <pre
        className="max-h-72 overflow-auto rounded-md border border-line bg-surface p-3 font-mono text-xs text-ink"
        data-testid="skill-describe-sample-json"
      >
        {json}
      </pre>
      <p className="text-xs text-ink-muted">
        If the JSON is all you need, it's a Read table step in the workflow, not a skill. Make a
        skill for what comes after: cleaning, judging or matching the rows.
      </p>
    </div>
  );
}
