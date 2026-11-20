// The setup checklist on a client copy's page (docs/builder-plan.md §6, B4), inside the go-live
// panel: each item, whether it is done, who did it and when, and what holds the trial and go-live.
// The client admin answers in the portal's Getting started; we record an item here when the client
// asks us to (who did it is kept). A connect item is done by its connection on the client's side.
import { type SetupGuard, type SetupRowView, type SetupView, setupRoutes } from "@countersign/core";
import { useState } from "react";
import { Badge, Button, SectionLabel, Tag } from "../../ui/primitives";
import { errorText, Notice, TextInput, useAction } from "./ui";

const GUARD_LABEL: Record<SetupGuard, string> = {
  setup: "Before the trial",
  trial: "Before the trial",
  live: "Before go-live",
};

const KIND_LABEL: Record<SetupRowView["kind"], string> = {
  connect: "Connect",
  answer: "Answer",
  file: "File",
  confirm: "Confirm",
};

const day = (iso: string) => new Date(iso).toLocaleDateString();

/** "Answered by Ada (client) on 19/11/2026: 0.9", "Connected", "Recorded by Sam (us)". */
export function setupWho(row: SetupRowView): string | null {
  if (!row.done) return null;
  if (row.byConnection) return "Connected and bound";
  const verb = row.kind === "answer" ? "Answered" : row.kind === "file" ? "Sent" : "Confirmed";
  const who = row.byName ?? (row.side === "operator" ? "us" : "the client");
  const side = row.side === "operator" ? " (us)" : row.side === "client" ? " (client)" : "";
  const when = row.at ? ` on ${day(row.at)}` : "";
  const what =
    row.kind === "file"
      ? `: ${row.files} ${row.files === 1 ? "file" : "files"}`
      : row.value
        ? `: ${row.value}`
        : "";
  return `${verb} by ${who}${side}${when}${what}`;
}

export function SetupChecklist({
  agentId,
  setup,
  onChanged,
}: {
  agentId: string;
  setup: SetupView;
  onChanged(): void;
}) {
  return (
    <div className="mt-5 border-t border-line pt-4" data-testid="agent-setup">
      <SectionLabel>
        <span className="flex items-center gap-2">
          Setup checklist
          <Badge tone={setup.done === setup.total ? "positive" : "neutral"} testId="setup-count">
            {`${setup.done} of ${setup.total} done`}
          </Badge>
        </span>
      </SectionLabel>
      {setup.holds.trial ? (
        <p className="text-ink" data-testid="setup-holds-trial">
          <Badge tone="warning">Waiting on the client</Badge> The trial can't start yet.{" "}
          {setup.holds.trial}
        </p>
      ) : setup.holds.live ? (
        <p className="text-ink" data-testid="setup-holds-live">
          <Badge tone="warning">Waiting on the client</Badge> Sign-off and go-live wait.{" "}
          {setup.holds.live}
        </p>
      ) : null}
      <ul className="mt-3 flex flex-col gap-3">
        {setup.items.map((row) => (
          <SetupRow key={row.id} agentId={agentId} row={row} onChanged={onChanged} />
        ))}
      </ul>
    </div>
  );
}

function SetupRow({
  agentId,
  row,
  onChanged,
}: {
  agentId: string;
  row: SetupRowView;
  onChanged(): void;
}) {
  const action = useAction();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(row.suggested ?? "");
  const who = setupWho(row);
  // A connect item is the client's to connect; a file is theirs to send.
  const canRecord = !row.byConnection && row.kind !== "file";

  async function record() {
    const res = await action.call(setupRoutes.opsSetupItem, {
      params: { id: agentId, itemId: row.id },
      body: value.trim() ? { value: value.trim() } : {},
    });
    if (res.ok) {
      setOpen(false);
      onChanged();
    }
  }

  return (
    <li className="border-b border-line pb-3" data-testid={`setup-item-${row.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-ink">{row.label}</span>
        <Tag>{KIND_LABEL[row.kind]}</Tag>
        <Tag>{GUARD_LABEL[row.guards]}</Tag>
        {row.done ? (
          <Badge tone="positive">Done</Badge>
        ) : row.byConnection ? (
          // Connectors C6: connected, bound and nothing missing; the fix may be ours or theirs.
          <Badge tone="warning">Waiting on a connector</Badge>
        ) : (
          <Badge tone="warning">Waiting on the client</Badge>
        )}
      </div>
      {row.hint ? <p className="text-sm text-ink-muted">{row.hint}</p> : null}
      {row.byConnection && !row.done ? (
        <p className="text-sm text-ink-muted" data-testid={`setup-readiness-${row.id}`}>
          Readiness, in Settings, says what's missing and who fixes it.
        </p>
      ) : null}
      {who ? (
        <p className="text-sm text-ink-muted" data-testid={`setup-who-${row.id}`}>
          {who}
        </p>
      ) : row.suggested ? (
        <p className="text-sm text-ink-muted">Starts at {row.suggested}</p>
      ) : null}
      {row.setsValue ? (
        <p className="text-sm text-ink-muted">The answer becomes the agent's setting.</p>
      ) : null}
      {canRecord && !open ? (
        <Button
          variant="ghost"
          data-testid={`setup-record-${row.id}`}
          onClick={() => setOpen(true)}
        >
          {row.done ? "Change for the client" : "Record for the client"}
        </Button>
      ) : null}
      {open ? (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <TextInput
            aria-label={row.label}
            data-testid={`setup-value-${row.id}`}
            value={value}
            maxLength={2000}
            placeholder={row.kind === "confirm" ? "A note (optional)" : "Their answer"}
            onChange={(e) => setValue(e.target.value)}
          />
          <Button
            data-testid={`setup-save-${row.id}`}
            disabled={action.busy || (row.kind === "answer" && !value.trim())}
            onClick={record}
          >
            {action.busy ? "Saving…" : row.kind === "confirm" ? "Confirm" : "Save"}
          </Button>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
      ) : null}
      {action.error ? (
        <div className="mt-2">
          <Notice tone="warning">{errorText(action.error)}</Notice>
        </div>
      ) : null}
    </li>
  );
}
