// One change a sandbox run would have made (docs/plan.md §1.243), as the person would see it
// arrive or change: an email as an email (from, to, subject, its text with its line breaks), a
// text as a message, a record as its fields before and after. Nothing was written (invariant 8).
// "Send to me" sends a message once to the person looking, and only to them; where it can't,
// the server's reason shows instead. Words come from the side drawing it (./words.ts).
import type { SandboxChange, SandboxMessage } from "@countersign/core";
import { useState } from "react";
import { Badge, Button, Card, ErrorNotice, Tag } from "../ui/primitives";
import type { SandboxWords } from "./words";

export function ChangeCard({
  change,
  words,
  onSend,
}: {
  change: SandboxChange;
  words: SandboxWords;
  /** Sends this change's message to the person looking; throws the API's refusal. */
  onSend: (changeId: string) => Promise<void>;
}) {
  const id = change.id;
  return (
    <Card pad testId={`sandbox-change-${id}`}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-ink" data-testid={`sandbox-change-${id}-title`}>
              {words.changeTitle(change)}
            </h3>
            {change.stepName && change.stepName !== change.title ? (
              <p className="text-sm text-ink-muted">{words.stepName(change.stepName)}</p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <Tag>{change.tool.connectorName}</Tag>
            <Badge tone="neutral">{words.notWrittenBadge}</Badge>
          </div>
        </div>
        {change.message ? (
          change.message.channel === "email" ? (
            <EmailView id={id} message={change.message} words={words} />
          ) : (
            <TextView id={id} message={change.message} words={words} />
          )
        ) : change.fields.length > 0 ? (
          <FieldsView id={id} change={change} words={words} />
        ) : null}
        <SendToMe change={change} words={words} onSend={onSend} />
      </div>
    </Card>
  );
}

/** "Northside Lumber <orders@northside.example.com>", or the address alone. */
function addressed(name: string | null, address: string): string {
  return name && name !== address ? `${name} <${address}>` : address;
}

function EmailView({
  id,
  message,
  words,
}: {
  id: string;
  message: SandboxMessage;
  words: SandboxWords;
}) {
  return (
    <div
      className="flex flex-col gap-3 rounded-md border border-line p-4"
      data-testid={`sandbox-change-${id}-email`}
    >
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        {message.from ? (
          <>
            <dt className="text-ink-muted">{words.from}</dt>
            <dd className="m-0 min-w-0 break-words text-ink">{message.from}</dd>
          </>
        ) : null}
        <dt className="text-ink-muted">{words.to}</dt>
        <dd className="m-0 min-w-0 break-words text-ink" data-testid={`sandbox-change-${id}-to`}>
          {addressed(message.toName, message.to)}
        </dd>
        <dt className="text-ink-muted">{words.subject}</dt>
        <dd className="m-0 min-w-0 break-words font-medium text-ink">
          {message.subject || words.noSubject}
        </dd>
      </dl>
      <p
        className="m-0 whitespace-pre-wrap break-words border-t border-line pt-3 text-ink"
        data-testid={`sandbox-change-${id}-body`}
      >
        {message.text || words.noText}
      </p>
      {message.attachments > 0 ? (
        <p className="m-0 text-sm text-ink-muted">{words.attachments(message.attachments)}</p>
      ) : null}
    </div>
  );
}

/** A text, a WhatsApp message or a call's words: a message as it would arrive. */
function TextView({
  id,
  message,
  words,
}: {
  id: string;
  message: SandboxMessage;
  words: SandboxWords;
}) {
  return (
    <div className="flex flex-col gap-2" data-testid={`sandbox-change-${id}-text`}>
      <p className="m-0 text-sm text-ink-muted">
        {[
          message.from ? `${words.from} ${message.from}` : null,
          `${words.to} ${addressed(message.toName, message.to)}`,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      {/* The chat's message bubble: a text reads as it would on a phone. */}
      <p
        className="ui-chat-you__bubble m-0 max-w-prose self-start"
        data-testid={`sandbox-change-${id}-bubble`}
      >
        {message.text || words.noText}
      </p>
      {message.attachments > 0 ? (
        <p className="m-0 text-sm text-ink-muted">{words.attachments(message.attachments)}</p>
      ) : null}
    </div>
  );
}

function FieldsView({
  id,
  change,
  words,
}: {
  id: string;
  change: SandboxChange;
  words: SandboxWords;
}) {
  return (
    <div className="dt dt-ana overflow-x-auto">
      <table data-testid={`sandbox-change-${id}-fields`}>
        <thead>
          <tr className="dt-cols">
            <th>{words.field}</th>
            <th>{words.before}</th>
            <th>{words.after}</th>
          </tr>
        </thead>
        <tbody>
          {change.fields.map((f) => (
            <tr key={f.field}>
              <td className="text-ink-muted">{f.field}</td>
              <td className="text-ink-muted">{f.before ?? words.empty}</td>
              <td className="font-medium text-ink">{f.after ?? words.empty}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SendToMe({
  change,
  words,
  onSend,
}: {
  change: SandboxChange;
  words: SandboxWords;
  onSend: (changeId: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const id = change.id;
  const send = change.send;
  if (!send && change.sent.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3">
      {change.sent.length > 0 ? (
        <ul
          className="m-0 flex list-none flex-col gap-0.5 p-0"
          data-testid={`sandbox-change-${id}-sent`}
        >
          {change.sent.map((s) => (
            <li key={`${s.at}-${s.to}`} className="text-sm text-positive">
              {words.sentLine(s)}
            </li>
          ))}
        </ul>
      ) : null}
      {send ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            size="sm"
            disabled={!send.can}
            working={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onSend(id);
              } catch (e) {
                setError(e);
              } finally {
                setBusy(false);
              }
            }}
            data-testid={`sandbox-change-${id}-send`}
          >
            {busy ? words.sending : words.sendButton}
          </Button>
          {send.can ? (
            send.to ? (
              <span className="text-sm text-ink-muted" data-testid={`sandbox-change-${id}-send-to`}>
                {words.sendTo(send.channel, send.to)}
              </span>
            ) : null
          ) : send.reason ? (
            <span className="text-sm text-ink-muted" data-testid={`sandbox-change-${id}-reason`}>
              {send.reason}
            </span>
          ) : null}
        </div>
      ) : null}
      {error ? <ErrorNotice error={error} /> : null}
    </div>
  );
}
