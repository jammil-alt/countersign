// Closing out an issue or a decision where it is listed (owner, 2026-11-21): "There is no way to
// answer this question here". A box under the row to answer or to say what it should be, sent to
// the Builder in that issue's thread, and a small Close menu for an issue settled some other way.

import { useState } from "react";
import { TextArea } from "../../ui/forms";
import { Button } from "../../ui/primitives";
import { type Voice, VoiceButton } from "../../ui/voice";

/** A reply under a row: words (typed or dictated), Send and Cancel. Sends with Ctrl or ⌘ Enter. */
export function ReplyBox({
  label,
  placeholder,
  send,
  value,
  onChange,
  onSend,
  onCancel,
  voice,
  busy,
  testId,
}: {
  /** The box's name for screen readers. */
  label: string;
  placeholder: string;
  /** The send button's words ("Send answer"). */
  send: string;
  value: string;
  onChange(text: string): void;
  onSend(text: string): void;
  onCancel(): void;
  voice?: Voice | undefined;
  busy: boolean;
  testId: string;
}) {
  const empty = !value.trim();
  const go = () => {
    if (!empty && !busy) onSend(value.trim());
  };
  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      <TextArea
        aria-label={label}
        placeholder={placeholder}
        rows={3}
        maxLength={4000}
        // The box opens on the operator's own click: the words go straight in.
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            go();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        data-testid={`${testId}-input`}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          disabled={empty || busy}
          onClick={go}
          data-testid={`${testId}-send`}
        >
          {send}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} data-testid={`${testId}-cancel`}>
          Cancel
        </Button>
        {voice ? (
          <VoiceButton
            voice={voice}
            disabled={busy}
            testId={`${testId}-voice`}
            onText={(said) => {
              const now = value.trimEnd();
              onChange(now ? `${now} ${said}` : said);
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

/** "Close": opens a short row of ways to close an issue without answering it here. */
export function CloseMenu<K extends string>({
  choices,
  onPick,
  disabled,
  testId,
}: {
  choices: readonly { key: K; label: string }[];
  onPick(key: K): void;
  disabled: boolean;
  testId: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="ghost"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        data-testid={testId}
      >
        {open ? "Keep it open" : "Close…"}
      </Button>
      {open ? (
        // biome-ignore lint/a11y/useSemanticElements: a group of buttons, not a form's fieldset
        <span className="flex flex-wrap items-center gap-2" role="group" aria-label="Close it as">
          {choices.map((c) => (
            <Button
              key={c.key}
              size="sm"
              disabled={disabled}
              onClick={() => {
                setOpen(false);
                onPick(c.key);
              }}
              data-testid={`${testId}-${c.key}`}
            >
              {c.label}
            </Button>
          ))}
        </span>
      ) : null}
    </span>
  );
}
