// Draft (docs/plan.md §1.168): a long text field's "Draft" button. It opens a small sheet to jot
// notes in (or dictate them, where the browser can record); Write it asks the API for the field's
// text in its own format and length, from the notes and what the field holds now. The draft shows
// as a suggestion with Use it, Try again and Cancel: nothing in the field changes until Use it.
// Loaded lazily by the forms that take `assist` (./forms.tsx), so it stays out of the first load.

import {
  ASSIST_CURRENT_MAX,
  ASSIST_FIELDS,
  ASSIST_NOTES_MAX,
  type AssistContext,
  type AssistFieldId,
  assistRoutes,
} from "@countersign/core";
import { type RefObject, useContext, useState } from "react";
import { createPortal } from "react-dom";
import { useApiClient } from "../api/useApi";
import { voiceFor } from "../api/voice";
import { AssistScope, type AssistSpec, assistOf } from "./assist-scope";
import { ErrorNotice } from "./ErrorState";
import { TextArea } from "./forms";
import { Button } from "./primitives";
import { SheetSection, SideSheet } from "./sheet";
import { VoiceButton } from "./voice";

export function DraftButton({
  field,
  context,
  current,
  onUse,
  disabled,
  testId = "draft",
}: {
  field: AssistFieldId;
  /** The records the field is about, beside the page's scope (`AssistScope`). */
  context?: AssistContext | undefined;
  /** What the field holds now, read when the sheet opens. */
  current: () => string;
  /** Puts the draft in the field: only on Use it. */
  onUse(text: string): void;
  disabled?: boolean | undefined;
  testId?: string | undefined;
}) {
  const scope = useContext(AssistScope);
  const [open, setOpen] = useState<{ current: string } | null>(null);
  return (
    <>
      <button
        type="button"
        className="ds-btn ds-btn--link text-xs"
        disabled={disabled}
        data-testid={testId}
        onClick={() => setOpen({ current: current() })}
      >
        Draft
      </button>
      {open
        ? // A portal: a field inside a <label> must not take the sheet's clicks as its own.
          createPortal(
            <DraftSheet
              field={field}
              context={{ ...scope, ...context }}
              current={open.current}
              testId={testId}
              onClose={() => setOpen(null)}
              onUse={(text) => {
                setOpen(null);
                onUse(text);
              }}
            />,
            document.body,
          )
        : null}
    </>
  );
}

function DraftSheet({
  field,
  context,
  current,
  testId,
  onClose,
  onUse,
}: {
  field: AssistFieldId;
  context: AssistContext;
  current: string;
  testId: string;
  onClose(): void;
  onUse(text: string): void;
}) {
  const api = useApiClient();
  const spec = ASSIST_FIELDS[field];
  const [notes, setNotes] = useState("");
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const now = current.trim() ? current.slice(0, ASSIST_CURRENT_MAX) : "";
  const empty = !notes.trim() && !now;

  async function write() {
    if (empty) return;
    setBusy(true);
    setError(null);
    try {
      const out = await api.call(assistRoutes.opsAssistDraft, {
        body: { field, notes: notes.trim(), ...(now ? { current: now } : {}), context },
      });
      setDraft(out.text);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SideSheet
      eyebrow={<span className="eyebrow text-ink-muted">Draft</span>}
      title={spec.label}
      onClose={onClose}
      testId={`${testId}-sheet`}
      footer={
        <div className="flex w-full flex-wrap gap-2">
          {draft === null ? (
            <Button
              variant="primary"
              size="sm"
              working={busy}
              disabled={empty}
              onClick={() => void write()}
              data-testid={`${testId}-write`}
            >
              Write it
            </Button>
          ) : (
            <>
              <Button
                variant="primary"
                size="sm"
                disabled={busy}
                onClick={() => onUse(draft)}
                data-testid={`${testId}-use`}
              >
                Use it
              </Button>
              <Button
                size="sm"
                working={busy}
                disabled={empty}
                onClick={() => void write()}
                data-testid={`${testId}-again`}
              >
                Try again
              </Button>
            </>
          )}
          <Button size="sm" variant="ghost" onClick={onClose} data-testid={`${testId}-cancel`}>
            Cancel
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        <p className="m-0 text-sm text-ink-muted">{spec.purpose}</p>
        <SheetSection label="Your notes">
          <TextArea
            aria-label="Your notes"
            rows={5}
            maxLength={ASSIST_NOTES_MAX}
            value={notes}
            placeholder="Jot what you know, in any order. We write it up in this field's format."
            onChange={(e) => setNotes(e.target.value)}
            data-testid={`${testId}-notes`}
          />
          <span className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-ink-muted">
              {now
                ? "We start from what the field holds now, and your notes."
                : `At most ${spec.maxLength.toLocaleString("en")} characters.`}
            </span>
            <VoiceButton
              voice={voiceFor("ops", context.clientId ?? null)}
              disabled={busy}
              testId={`${testId}-voice`}
              onText={(said) => setNotes((n) => (n.trimEnd() ? `${n.trimEnd()} ${said}` : said))}
            />
          </span>
        </SheetSection>
        {error ? <ErrorNotice error={error} /> : null}
        {draft !== null ? (
          <SheetSection label="Suggestion">
            <div
              className="ds-card p-3 text-sm whitespace-pre-wrap text-ink"
              data-testid={`${testId}-suggestion`}
            >
              {draft}
            </div>
            <span className="figures text-xs text-ink-muted">
              {draft.length.toLocaleString("en")} of {spec.maxLength.toLocaleString("en")}{" "}
              characters. Nothing changes in the field until you use it.
            </span>
          </SheetSection>
        ) : null}
      </div>
    </SideSheet>
  );
}

/**
 * Puts text in a form control as typing would: through the element's own value setter and an
 * input event, so the screen's `onChange` takes it as it takes the person's own typing.
 */
export function fillControl(el: HTMLTextAreaElement | HTMLInputElement | null, text: string): void {
  if (!el) return;
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.focus();
}

/** Draft for a control of ./forms.tsx (`assist`): reads and fills the control itself. */
export function FieldDraft({
  spec,
  target,
  testId,
}: {
  spec: AssistSpec;
  target: RefObject<HTMLTextAreaElement | HTMLInputElement | null>;
  testId?: string | undefined;
}) {
  const { field, context } = assistOf(spec, {});
  return (
    <DraftButton
      field={field}
      context={context}
      current={() => target.current?.value ?? ""}
      onUse={(text) => fillControl(target.current, text)}
      testId={testId}
    />
  );
}
