// Turn on (docs/builder-plan.md §11.4 S4, §12.4; the mock-up's turnonHTML): one sheet, one
// button. It reads what Turn on would do (`opsAgentTurnOnPreview`) when it opens and again when
// the client changes, lists what is left (ours gold "Waiting on you", the client's "Waiting on
// <client>", what is done with a check), and Start the trial calls `opsAgentTurnOn`. Only ours
// hold the button; what the client owes goes to their setup list. Props-driven: the host opens
// it, starts a try, takes the operator to the steps still to settle and hears when it started.
import {
  type TurnOnAnswer,
  TurnOnAnswer as TurnOnAnswerSchema,
  type TurnOnItem,
} from "@countersign/core";
import { useEffect, useState } from "react";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { Icon } from "../../ui/icons";
import { Badge, Button } from "../../ui/primitives";
import { SideSheet } from "../../ui/sheet";
import {
  errorDetails,
  errorText,
  Field,
  isCode,
  Notice,
  plural,
  Select,
  useAction,
} from "../agents/ui";

export interface TurnOnSheetProps {
  /** The agent turned on: a template, or a client's agent. */
  agentId: string;
  /** A template: the client is picked here. */
  template: boolean;
  /** The clients a template can be turned on for (unused for a client's agent). */
  clients?: readonly { id: string; name: string }[];
  /** The client picked first (a build's client, the one it was tried at); a template's only. */
  clientId?: string | null;
  /** The version to turn on; the latest when left out. */
  versionId?: string;
  /** How many things are still to settle on the steps ("Go through them"); none holds the trial. */
  toSettle?: number;
  /** Try it, at the client picked. */
  onTry(clientId: string): void;
  /** Take the operator to the next step with something to settle. */
  onNextOpen?(): void;
  /** The trial started (or, for an agent that writes nothing, it went live). */
  onStarted(result: TurnOnAnswer): void;
  /** Turn on ran without starting the trial (the client owes something it waits on). */
  onChanged?(result: TurnOnAnswer): void;
  onClose(): void;
}

/** "Waiting on you" or "Waiting on <client>": gold, always with its word. */
function waitingWord(item: TurnOnItem, client: string): string {
  return item.owner === "client" ? `Waiting on ${client}` : "Waiting on you";
}

function ItemRow({
  item,
  client,
  onTry,
}: {
  item: TurnOnItem;
  client: string;
  onTry: (() => void) | null;
}) {
  const done = item.done === true;
  return (
    <li className="flex gap-3 py-3" data-testid={`flow-turn-on-item-${item.key}`}>
      <span className={done ? "text-ink-muted" : "text-signal-ink"}>
        <Icon name={done ? "check" : "alert"} size={16} />
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-ink">{item.title}</span>
          {done ? null : (
            <Badge tone="warning" testId={`flow-turn-on-wait-${item.key}`}>
              {waitingWord(item, client)}
            </Badge>
          )}
        </span>
        {item.detail ? <span className="text-sm text-ink-muted">{item.detail}</span> : null}
        {item.waits && !done ? (
          <span className="text-sm text-ink-muted">
            The trial starts once this is done. We set up the rest now.
          </span>
        ) : null}
        {onTry ? (
          <span className="pt-1">
            <Button size="sm" onClick={onTry} data-testid="flow-turn-on-try">
              Try it
            </Button>
          </span>
        ) : null}
      </div>
    </li>
  );
}

export function TurnOnSheet(props: TurnOnSheetProps) {
  const {
    agentId,
    template,
    clients = [],
    onTry,
    onNextOpen,
    onStarted,
    onChanged,
    onClose,
  } = props;
  const [clientId, setClientId] = useState<string>(
    (template ? props.clientId : null) ??
      (template && clients.length === 1 ? (clients[0]?.id ?? "") : ""),
  );
  // The answer of the last press (or its 409), shown in place of the preview until the client changes.
  const [pressed, setPressed] = useState<TurnOnAnswer | null>(null);
  const action = useAction();
  const preview = useApi(
    apiRoutes.opsAgentTurnOnPreview,
    template && !clientId
      ? null
      : { params: { id: agentId }, query: template ? { client: clientId } : {} },
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new client clears the last press.
  useEffect(() => {
    setPressed(null);
    action.clear();
  }, [clientId]);

  const shown = pressed ?? preview.data ?? null;
  const clientName =
    shown?.clientName ?? clients.find((c) => c.id === clientId)?.name ?? "the client";
  const items = shown?.items ?? [];
  const holds = items.some((i) => i.holds);
  const version = shown?.version;
  const target = shown?.clientId ?? (clientId || null);
  const settle = toSettleRow(props.toSettle ?? 0, onNextOpen);

  async function start() {
    const res = await action.call(apiRoutes.opsAgentTurnOn, {
      params: { id: agentId },
      body: {
        ...(template && clientId ? { clientId } : {}),
        ...(props.versionId ? { versionId: props.versionId } : {}),
      },
    });
    if (res.ok) {
      setPressed(res.data);
      onChanged?.(res.data);
      if (res.data.started) onStarted(res.data);
      return;
    }
    if (isCode(res.error, "turn_on_held")) {
      const held = TurnOnAnswerSchema.safeParse(errorDetails(res.error));
      if (held.success) setPressed(held.data);
    }
  }

  const footer = (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant="primary"
        onClick={() => void start()}
        disabled={!shown || holds || !target || shown.started}
        working={action.busy}
        data-testid="flow-turn-on-start"
      >
        Start the trial
      </Button>
      <Button variant="ghost" onClick={onClose} data-testid="flow-turn-on-not-yet">
        Not yet
      </Button>
    </div>
  );

  return (
    <SideSheet
      testId="flow-turn-on"
      eyebrow={<span className="ds-eyebrow">Turn on</span>}
      title={target ? `Start the trial at ${clientName}` : "Start the trial"}
      onClose={onClose}
      footer={footer}
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-ink-muted">
          One button: it publishes {version ? `v${version}` : "this version"}
          {template ? `, copies it to ${clientName}` : ""}, binds {clientName}'s connections and
          starts the trial. The trial runs 14 days or 25 runs, and every write is signed.
        </p>

        {template ? (
          <Field label="Client">
            <Select
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              data-testid="flow-turn-on-client"
            >
              <option value="">Pick the client</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}

        {shown?.started ? (
          <Notice tone="positive" testId="flow-turn-on-started">
            {shown.stage === "live"
              ? `It's live at ${clientName}: it writes nothing, so it has no trial.`
              : `It's in its trial at ${clientName}. Every write waits for their signature until sign-off.`}
          </Notice>
        ) : null}
        {pressed && !pressed.started && pressed.refused ? (
          <Notice tone="neutral" testId="flow-turn-on-refused">
            It's set up at {clientName}, and the trial hasn't started: {pressed.refused.join("; ")}.
            Turn it on again once that is done.
          </Notice>
        ) : null}
        {pressed && !pressed.started && !pressed.refused && holds ? (
          <Notice tone="warning" testId="flow-turn-on-held">
            Not yet: {plural(items.filter((i) => i.holds).length, "thing")} of ours still holds it.
          </Notice>
        ) : null}
        {action.error && !isCode(action.error, "turn_on_held") ? (
          <Notice tone="warning" testId="flow-turn-on-error">
            {errorText(action.error)}
          </Notice>
        ) : null}
        {preview.error && !shown ? (
          <Notice tone="warning" testId="flow-turn-on-load-error">
            {errorText(preview.error)}
          </Notice>
        ) : null}
        {template && !clientId ? (
          <p className="text-sm text-ink-muted">Pick the client it starts at.</p>
        ) : null}
        {!shown && preview.loading && target ? (
          <p className="text-sm text-ink-muted">Reading what it needs…</p>
        ) : null}

        {items.length > 0 || settle ? (
          <ul
            className="flex flex-col divide-y divide-line border-y border-line"
            data-testid="flow-turn-on-items"
          >
            {items.map((item) => (
              <ItemRow
                key={item.key}
                item={item}
                client={clientName}
                onTry={item.kind === "tried" && !item.done && target ? () => onTry(target) : null}
              />
            ))}
            {settle}
          </ul>
        ) : null}

        {shown ? (
          <p className="text-sm text-ink-muted">
            What {clientName} still owes goes to their setup list. It doesn't hold the trial.
          </p>
        ) : null}
      </div>
    </SideSheet>
  );
}

/** "6 still to settle on their steps", with Go through them, when the host says so. */
function toSettleRow(n: number, onNextOpen: (() => void) | undefined) {
  if (n <= 0 || !onNextOpen) return null;
  return (
    <li className="flex gap-3 py-3" data-testid="flow-turn-on-settle">
      <span className="text-signal-ink">
        <Icon name="alert" size={16} />
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-ink">
            {n} still to settle on {n === 1 ? "its step" : "their steps"}
          </span>
          <Badge tone="warning">Waiting on you</Badge>
        </span>
        <span className="text-sm text-ink-muted">
          It runs on the defaults until you do. None of them holds the trial.
        </span>
        <span className="pt-1">
          <Button size="sm" onClick={onNextOpen} data-testid="flow-turn-on-next-open">
            Go through them
          </Button>
        </span>
      </div>
    </li>
  );
}
