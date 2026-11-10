// Scripts on website logins (docs/plan.md §1.86 "Scripts (wave 4)"; ARCHITECTURE v0.16 §10.14
// "Browser connectors"), shared by the portal's Accounts page (the client admin records and sees
// where each of their drafts stands) and the back office's Websites screen (the operator records,
// tests and publishes). Each action goes through our API to our browser, which our code signed in
// to first: whoever records sees the page and its screenshot, never the login. A click that sends a
// form is recorded and never clicked. Words through t(): the portal reads them in the client's
// language, the back office in English.
import type { RecorderActionInput, ScriptStep } from "@countersign/core";
import { type ReactNode, useState } from "react";
import type { ResponseOf } from "../api/client";
import { apiRoutes } from "../api/routes";
import { useApi, useApiClient } from "../api/useApi";
import type { PlainKey } from "../i18n/catalog";
import { useI18n } from "../i18n/i18n";
import { Field, Select, TextInput } from "../ui/forms";
import { Badge, Button, Card, EmptyState, ErrorNotice } from "../ui/primitives";

export type ScriptList = ResponseOf<typeof apiRoutes.portalBrowserScripts>;
export type Script = ScriptList["scripts"][number];
export type ScriptLogin = ScriptList["logins"][number];
type ActionResult = ResponseOf<typeof apiRoutes.portalBrowserScriptAction>;
type Recording = Script["recording"];
/** Which surface's routes: the back office's or the client admin's. */
export type ScriptSide = "ops" | "portal";

const OPS: ActionKind[] = ["open", "fill", "click", "read_field", "read_table", "download"];
type ActionKind = RecorderActionInput["op"];

const INPUT_TYPES = ["text", "decimal", "integer", "date"] as const;
const FIELD_TYPES = ["text", "decimal", "integer"] as const;

/** Where a script stands, as a word: recording, waiting for us, or published. */
export function ScriptStateBadge({ script }: { script: Script }) {
  const { t } = useI18n();
  if (script.state === "published") {
    return (
      <Badge tone="positive" testId="script-state">
        {t("scripts.state.published", { version: script.published?.version ?? 1 })}
      </Badge>
    );
  }
  if (script.state === "draft") {
    return (
      <Badge tone="warning" testId="script-state">
        {t("scripts.state.draft")}
      </Badge>
    );
  }
  return (
    <Badge tone="neutral" testId="script-state">
      {t("scripts.state.recording")}
    </Badge>
  );
}

/** A step in plain words. */
export function stepWords(step: ScriptStep, t: ReturnType<typeof useI18n>["t"]): string {
  switch (step.op) {
    case "open":
      return t("scripts.step.open", { url: step.url });
    case "fill":
      return "input" in step.value
        ? t("scripts.step.fillInput", { selector: step.selector, name: step.value.input })
        : t("scripts.step.fill", { selector: step.selector, value: step.value.text });
    case "click":
      return step.submits
        ? t("scripts.step.submit", { selector: step.selector })
        : t("scripts.step.click", { selector: step.selector });
    case "read_field":
      return t("scripts.step.readField", { selector: step.selector, name: step.output });
    case "read_table":
      return t("scripts.step.readTable", { n: step.table + 1, name: step.output });
    case "download":
      return t("scripts.step.download", { url: step.url, name: step.output });
  }
}

/** A slug from a name: lowercase letters, digits and dashes. */
function slugOf(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "script"
  );
}

/** Starts a recording on one of the logins (the back office may start from a script-draft offer). */
export function StartScriptForm({
  side,
  logins,
  showClient,
  fromOffer,
  initialLogin,
  onStarted,
}: {
  side: ScriptSide;
  logins: readonly ScriptLogin[];
  showClient?: boolean;
  fromOffer?: string | null;
  initialLogin?: string | null;
  onStarted: (script: Script) => void;
}) {
  const { t } = useI18n();
  const api = useApiClient();
  const [login, setLogin] = useState(initialLogin ?? logins[0]?.connectionId ?? "");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function start() {
    setBusy(true);
    setError(null);
    try {
      const body = { connectionId: login, slug: slugOf(name), name: name.trim() };
      const out =
        side === "ops"
          ? await api.call(apiRoutes.opsStartBrowserScript, {
              body: { ...body, ...(fromOffer ? { fromOffer } : {}) },
            })
          : await api.call(apiRoutes.portalStartBrowserScript, { body });
      setName("");
      onStarted(out.script);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-col gap-3" data-testid="script-start">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label={t("scripts.login")}>
          <Select
            data-testid="script-start-login"
            value={login}
            onChange={(e) => setLogin(e.target.value)}
          >
            {logins.map((l) => (
              <option key={l.connectionId} value={l.connectionId}>
                {showClient ? `${l.clientName} · ${l.siteName}` : l.siteName}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("scripts.name")}>
          <TextInput
            data-testid="script-start-name"
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
      </div>
      {error ? <ErrorNotice error={error} /> : null}
      <div>
        <Button
          data-testid="script-start-go"
          variant="primary"
          disabled={!login || !name.trim() || busy}
          onClick={() => void start()}
        >
          {t("scripts.start")}
        </Button>
      </div>
    </div>
  );
}

/** One action as the form holds it. */
interface Draft {
  op: ActionKind;
  url: string;
  selector: string;
  value: string;
  as: string;
  table: string;
  submits: boolean;
}

const EMPTY: Draft = {
  op: "open",
  url: "",
  selector: "",
  value: "",
  as: "",
  table: "1",
  submits: false,
};

function actionOf(d: Draft): RecorderActionInput {
  switch (d.op) {
    case "open":
      return { op: "open", url: d.url.trim() };
    case "fill":
      return {
        op: "fill",
        selector: d.selector.trim(),
        value: d.value,
        ...(d.as.trim() ? { as: d.as.trim() } : {}),
      };
    case "click":
      return { op: "click", selector: d.selector.trim(), submits: d.submits };
    case "read_field":
      return { op: "read_field", selector: d.selector.trim(), as: d.as.trim() };
    case "read_table":
      return {
        op: "read_table",
        table: Math.max(0, Number.parseInt(d.table, 10) - 1 || 0),
        as: d.as.trim(),
      };
    case "download":
      return { op: "download", url: d.url.trim(), as: d.as.trim() };
  }
}

function ready(d: Draft): boolean {
  if (d.op === "open") return d.url.trim().length > 0;
  if (d.op === "download") return d.url.trim().length > 0 && d.as.trim().length > 0;
  if (d.op === "read_table") return d.as.trim().length > 0;
  if (d.op === "read_field") return d.selector.trim().length > 0 && d.as.trim().length > 0;
  return d.selector.trim().length > 0;
}

/**
 * The recorder: the steps so far (each may be removed), the next action, the page after the last
 * one with its screenshot and what may be used on it, the review of the inputs and outputs, and
 * saving a version. `children` are the back office's own controls (test, publish).
 */
export function ScriptRecorder({
  side,
  script,
  onChanged,
  children,
}: {
  side: ScriptSide;
  script: Script;
  onChanged: (script: Script) => void;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const api = useApiClient();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [last, setLast] = useState<ActionResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const rec = script.recording;
  const submitted = rec.steps.some((s) => s.op === "click" && s.submits);

  async function run(fn: () => Promise<Script>) {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      onChanged(await fn());
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  async function act() {
    await run(async () => {
      const body = { action: actionOf(draft) };
      const params = { id: script.id };
      const out =
        side === "ops"
          ? await api.call(apiRoutes.opsBrowserScriptAction, { params, body })
          : await api.call(apiRoutes.portalBrowserScriptAction, { params, body });
      setLast(out);
      setDraft({ ...EMPTY, op: draft.op === "open" ? "fill" : draft.op });
      return out.script;
    });
  }

  /** Saves the review: the recording with these names, steps and types. */
  async function edit(next: Partial<Recording> & { steps?: ScriptStep[] }) {
    await run(async () => {
      const body = {
        name: script.name,
        description: rec.description,
        inputs: next.inputs ?? rec.inputs,
        outputs: next.outputs ?? rec.outputs,
        steps: next.steps ?? rec.steps,
        undo: rec.undo,
      };
      const params = { id: script.id };
      const out =
        side === "ops"
          ? await api.call(apiRoutes.opsEditBrowserScript, { params, body })
          : await api.call(apiRoutes.portalEditBrowserScript, { params, body });
      return out.script;
    });
  }

  async function save() {
    await run(async () => {
      const params = { id: script.id };
      const out =
        side === "ops"
          ? await api.call(apiRoutes.opsSaveBrowserScript, { params })
          : await api.call(apiRoutes.portalSaveBrowserScript, { params });
      setSaved(true);
      return out.script;
    });
  }

  const removeStep = (id: string) => {
    const steps = rec.steps.filter((s) => s.id !== id);
    const usedIn = new Set(
      steps.flatMap((s) =>
        s.op === "fill" && "input" in s.value
          ? [s.value.input]
          : s.op === "open" || s.op === "download"
            ? [...s.url.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map((m) => m[1] ?? "")
            : [],
      ),
    );
    const read = new Set(steps.flatMap((s) => ("output" in s ? [s.output] : [])));
    void edit({
      steps,
      inputs: rec.inputs.filter((i) => usedIn.has(i.name)),
      outputs: rec.outputs.filter((o) => read.has(o.name)),
    });
  };

  return (
    <Card
      testId={`script-${script.slug}`}
      title={
        <span className="flex min-w-0 flex-col">
          <span>{script.name}</span>
          <span className="text-sm font-normal text-ink-muted">
            {script.siteName} · <span className="reference">{script.slug}</span>
          </span>
        </span>
      }
      meta={<ScriptStateBadge script={script} />}
    >
      <div className="ui-card__body flex flex-col gap-4">
        <section className="flex flex-col gap-2" data-testid="script-steps">
          <h4 className="eyebrow text-ink-muted">{t("scripts.steps")}</h4>
          {rec.steps.length === 0 ? (
            <p className="text-sm text-ink-muted">{t("scripts.noSteps")}</p>
          ) : (
            <ol className="flex flex-col gap-1">
              {rec.steps.map((s, i) => (
                <li
                  key={s.id}
                  className="flex items-center justify-between gap-3 text-sm text-ink"
                  data-testid={`script-step-${s.id}`}
                >
                  <span className="min-w-0 break-words">
                    {i + 1}. {stepWords(s, t)}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    data-testid={`script-step-${s.id}-remove`}
                    onClick={() => removeStep(s.id)}
                  >
                    {t("scripts.remove")}
                  </Button>
                </li>
              ))}
            </ol>
          )}
        </section>

        {submitted ? null : (
          <ActionForm draft={draft} onDraft={setDraft} busy={busy} onAct={() => void act()} />
        )}

        {last ? (
          <LastPage result={last} onPick={(s) => setDraft({ ...draft, selector: s })} />
        ) : null}

        <Review recording={rec} busy={busy} onSave={(next) => void edit(next)} />

        {error ? <ErrorNotice error={error} /> : null}
        {saved ? (
          <p className="text-sm text-ink" data-testid="script-saved">
            {t("scripts.saved")}
          </p>
        ) : script.problems.length > 0 && rec.steps.length > 0 ? (
          <p className="text-sm text-ink-muted" data-testid="script-problems">
            {t("scripts.problems", { problems: script.problems.join("; ") })}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            data-testid="script-save-version"
            variant="primary"
            disabled={busy || script.problems.length > 0}
            onClick={() => void save()}
          >
            {t("scripts.saveVersion")}
          </Button>
          {children}
        </div>
      </div>
    </Card>
  );
}

function ActionForm({
  draft,
  onDraft,
  busy,
  onAct,
}: {
  draft: Draft;
  onDraft: (d: Draft) => void;
  busy: boolean;
  onAct: () => void;
}) {
  const { t } = useI18n();
  const set = (patch: Partial<Draft>) => onDraft({ ...draft, ...patch });
  const needsUrl = draft.op === "open" || draft.op === "download";
  const needsSelector = draft.op === "fill" || draft.op === "click" || draft.op === "read_field";
  return (
    <section className="flex flex-col gap-3" data-testid="script-action">
      <h4 className="eyebrow text-ink-muted">{t("scripts.next")}</h4>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label={t("scripts.type")}>
          <Select
            data-testid="script-action-op"
            value={draft.op}
            onChange={(e) => set({ op: e.target.value as ActionKind })}
          >
            {OPS.map((op) => (
              <option key={op} value={op}>
                {t(`scripts.op.${op}` as PlainKey)}
              </option>
            ))}
          </Select>
        </Field>
        {needsUrl ? (
          <Field label={t("scripts.address")}>
            <TextInput
              data-testid="script-action-url"
              value={draft.url}
              placeholder="/orders/new"
              onChange={(e) => set({ url: e.target.value })}
            />
          </Field>
        ) : null}
        {needsSelector ? (
          <Field label={t("scripts.selector")}>
            <TextInput
              data-testid="script-action-selector"
              className="font-mono"
              value={draft.selector}
              onChange={(e) => set({ selector: e.target.value })}
            />
          </Field>
        ) : null}
        {draft.op === "read_table" ? (
          <Field label={t("scripts.table")}>
            <TextInput
              data-testid="script-action-table"
              inputMode="numeric"
              value={draft.table}
              onChange={(e) => set({ table: e.target.value })}
            />
          </Field>
        ) : null}
        {draft.op === "fill" ? (
          <Field label={t("scripts.value")}>
            <TextInput
              data-testid="script-action-value"
              value={draft.value}
              onChange={(e) => set({ value: e.target.value })}
            />
          </Field>
        ) : null}
        {draft.op !== "open" && draft.op !== "click" ? (
          <Field label={draft.op === "fill" ? t("scripts.asInput") : t("scripts.asOutput")}>
            <TextInput
              data-testid="script-action-as"
              className="font-mono"
              value={draft.as}
              placeholder={draft.op === "fill" ? "orderNumber" : "price"}
              onChange={(e) => set({ as: e.target.value })}
            />
          </Field>
        ) : null}
      </div>
      {draft.op === "click" ? (
        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            data-testid="script-action-submits"
            checked={draft.submits}
            onChange={(e) => set({ submits: e.target.checked })}
          />
          {t("scripts.submits")}
        </label>
      ) : null}
      <div>
        <Button data-testid="script-action-do" disabled={busy || !ready(draft)} onClick={onAct}>
          {busy ? t("scripts.working") : t("scripts.do")}
        </Button>
      </div>
    </section>
  );
}

/** The page after the last action: its address, screenshot, what was read, what may be used. */
function LastPage({
  result,
  onPick,
}: {
  result: ActionResult;
  onPick: (selector: string) => void;
}) {
  const { t } = useI18n();
  const { page } = result;
  return (
    <section className="flex flex-col gap-2" data-testid="script-page">
      <h4 className="eyebrow text-ink-muted">{t("scripts.page")}</h4>
      <p className="reference break-all text-sm text-ink">{page.url}</p>
      {result.value !== undefined ? (
        <p className="text-sm text-ink" data-testid="script-read">
          {t("scripts.read", {
            value: typeof result.value === "string" ? result.value : JSON.stringify(result.value),
          })}
        </p>
      ) : null}
      {page.screenshotUrl ? (
        <img
          src={page.screenshotUrl}
          alt={t("scripts.screenshot")}
          className="max-h-80 w-full rounded-md border border-line object-contain"
          data-testid="script-screenshot"
        />
      ) : null}
      {page.controls.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="text-sm text-ink-muted">{t("scripts.controls")}</span>
          <div className="flex flex-wrap gap-2" data-testid="script-controls">
            {page.controls.slice(0, 40).map((c) => (
              <Button
                key={c.selector}
                size="sm"
                variant="ghost"
                title={c.selector}
                onClick={() => onPick(c.selector)}
              >
                {c.label || c.selector}
              </Button>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** Names and types the inputs and outputs, then saves the review. */
function Review({
  recording,
  busy,
  onSave,
}: {
  recording: Recording;
  busy: boolean;
  onSave: (next: Pick<Recording, "inputs" | "outputs">) => void;
}) {
  const { t } = useI18n();
  const [inputs, setInputs] = useState(recording.inputs);
  const [outputs, setOutputs] = useState(recording.outputs);
  const key = JSON.stringify([recording.inputs, recording.outputs]);
  const [seen, setSeen] = useState(key);
  if (seen !== key) {
    // The recording changed under the form (a step recorded or removed): start from it again.
    setSeen(key);
    setInputs(recording.inputs);
    setOutputs(recording.outputs);
  }
  if (recording.inputs.length === 0 && recording.outputs.length === 0) return null;
  const changed = JSON.stringify([inputs, outputs]) !== key;
  return (
    <section className="flex flex-col gap-3" data-testid="script-review">
      {inputs.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h4 className="eyebrow text-ink-muted">{t("scripts.inputs")}</h4>
          {inputs.map((i, n) => (
            <div key={i.name} className="grid grid-cols-1 gap-2 md:grid-cols-3">
              <span className="reference self-center text-sm text-ink">{i.name}</span>
              <TextInput
                aria-label={t("scripts.label")}
                data-testid={`script-input-${i.name}-label`}
                value={i.label}
                onChange={(e) =>
                  setInputs(inputs.map((x, k) => (k === n ? { ...x, label: e.target.value } : x)))
                }
              />
              <Select
                aria-label={t("scripts.type")}
                data-testid={`script-input-${i.name}-type`}
                value={i.type}
                onChange={(e) =>
                  setInputs(
                    inputs.map((x, k) =>
                      k === n ? { ...x, type: e.target.value as (typeof INPUT_TYPES)[number] } : x,
                    ),
                  )
                }
              >
                {INPUT_TYPES.map((ty) => (
                  <option key={ty} value={ty}>
                    {t(`scripts.valueType.${ty}` as PlainKey)}
                  </option>
                ))}
              </Select>
            </div>
          ))}
        </div>
      ) : null}
      {outputs.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h4 className="eyebrow text-ink-muted">{t("scripts.outputs")}</h4>
          {outputs.map((o, n) => (
            <div key={o.name} className="grid grid-cols-1 gap-2 md:grid-cols-3">
              <span className="reference self-center text-sm text-ink">{o.name}</span>
              <TextInput
                aria-label={t("scripts.label")}
                data-testid={`script-output-${o.name}-label`}
                value={o.label}
                onChange={(e) =>
                  setOutputs(outputs.map((x, k) => (k === n ? { ...x, label: e.target.value } : x)))
                }
              />
              {(FIELD_TYPES as readonly string[]).includes(o.type) ? (
                <Select
                  aria-label={t("scripts.type")}
                  data-testid={`script-output-${o.name}-type`}
                  value={o.type}
                  onChange={(e) =>
                    setOutputs(
                      outputs.map((x, k) =>
                        k === n
                          ? { ...x, type: e.target.value as (typeof FIELD_TYPES)[number] }
                          : x,
                      ),
                    )
                  }
                >
                  {FIELD_TYPES.map((ty) => (
                    <option key={ty} value={ty}>
                      {t(`scripts.valueType.${ty}` as PlainKey)}
                    </option>
                  ))}
                </Select>
              ) : (
                <span className="self-center text-sm text-ink-muted">
                  {t(`scripts.valueType.${o.type}` as PlainKey)}
                </span>
              )}
            </div>
          ))}
        </div>
      ) : null}
      <div>
        <Button
          size="sm"
          data-testid="script-review-save"
          disabled={busy || !changed}
          onClick={() => onSave({ inputs, outputs })}
        >
          {t("scripts.saveReview")}
        </Button>
      </div>
    </section>
  );
}

/** The scripts as a list: each with its login, its state, and a way to open it. */
export function ScriptRows({
  scripts,
  showClient,
  openId,
  onOpen,
}: {
  scripts: readonly Script[];
  showClient?: boolean;
  openId: string | null;
  onOpen: (id: string | null) => void;
}) {
  const { t } = useI18n();
  if (scripts.length === 0) return <EmptyState>{t("scripts.empty")}</EmptyState>;
  return (
    <ul className="flex flex-col divide-y divide-line" data-testid="script-rows">
      {scripts.map((s) => (
        <li
          key={s.id}
          className="flex flex-wrap items-center justify-between gap-3 py-2"
          data-testid={`script-row-${s.slug}`}
        >
          <span className="flex min-w-0 flex-col">
            <span className="text-sm text-ink">{s.name}</span>
            <span className="text-xs text-ink-muted">
              {showClient ? `${s.clientName} · ` : ""}
              {s.siteName}
            </span>
          </span>
          <span className="flex items-center gap-2">
            <ScriptStateBadge script={s} />
            <Button
              size="sm"
              data-testid={`script-row-${s.slug}-open`}
              onClick={() => onOpen(openId === s.id ? null : s.id)}
            >
              {openId === s.id ? t("scripts.close") : t("scripts.open")}
            </Button>
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The portal's scripts (the client admin's, on the Accounts page beside the vault): where each
 * script stands, and recording one on a website login. Nothing shows until there is a login to
 * record on or a script; publishing is ours.
 */
export function PortalScriptsCard() {
  const { t } = useI18n();
  const list = useApi(apiRoutes.portalBrowserScripts);
  const [openId, setOpenId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const data = list.data;
  if (!data || (data.logins.length === 0 && data.scripts.length === 0)) return null;
  const open = data.scripts.find((s) => s.id === openId) ?? null;
  return (
    <div className="ds-card" data-testid="portal-scripts">
      <div className="ui-card__head">
        <div className="min-w-0">
          <h2 className="type-subheading text-ink">{t("scripts.title")}</h2>
          <p className="text-sm text-ink-muted">{t("scripts.subtitle")}</p>
        </div>
        {data.logins.length > 0 ? (
          <Button
            size="sm"
            data-testid="portal-scripts-record"
            aria-expanded={starting}
            onClick={() => setStarting(!starting)}
          >
            {starting ? t("scripts.close") : t("scripts.record")}
          </Button>
        ) : null}
      </div>
      <div className="ui-card__body flex flex-col gap-4">
        {starting ? (
          <StartScriptForm
            side="portal"
            logins={data.logins}
            onStarted={(s) => {
              setStarting(false);
              setOpenId(s.id);
              list.reload();
            }}
          />
        ) : null}
        <ScriptRows scripts={data.scripts} openId={openId} onOpen={setOpenId} />
        {open ? (
          <ScriptRecorder side="portal" script={open} onChanged={() => list.reload()} />
        ) : null}
      </div>
    </div>
  );
}
