// Escalations: similar open items handled together (QA, 2026-11-22). An agent that asks the same
// kind of thing many times ("Add Dana Reyes to the directory", twenty times over) leaves one row
// per item; here they are one line with "Handle together", which opens them in a side sheet with
// a box each. Approve or reject sends each item its own decision through the route a single item
// uses, so each is checked, recorded and audited as it is one at a time: ours through
// POST /api/ops/inbox/:id/resolve, a client's only by stepping in (with one reason the client
// reads on each) through POST /api/ops/clients/:id/inbox/:itemId/step-in.
import { FINDING_SUBJECT } from "@countersign/core";
import { useState } from "react";
import { apiRoutes } from "../../api/routes";
import { useApiClient } from "../../api/useApi";
import { Button, Card, ErrorNotice } from "../../ui/primitives";
import { SideSheet } from "../../ui/sheet";
import { plural } from "../run/words";
import { SCRIPT_DRAFT_SUBJECT } from "./BrowserScripts";
import { canStepIn } from "./StepIn";

/** At least this many alike before they are offered together. */
export const SIMILAR_MIN = 3;

/** What grouping needs of an item (the Escalations list's rows). */
export interface BulkItem {
  id: string;
  tenantId: string;
  agentId: string | null;
  kind: string;
  status: string;
  subjectType: string | null;
  title: string;
  payload: Record<string, unknown>;
  resolvableByOperator: boolean;
}

export interface SimilarGroup<T extends BulkItem> {
  key: string;
  items: T[];
  /** Ours to resolve; else the client's, which we only step into. */
  mine: boolean;
}

/**
 * Whether an item may be decided with others like it: an open approval or review that a plain yes
 * or no answers. Not a question (it needs its own answer), a change to a client's tool (each is
 * signed on its own card), a supervisor finding, a request for the client's code, a message to
 * edit before it goes, or a script draft.
 */
// DECISION (QA, 2026-11-22): only kinds whose card is a plain approve or reject are offered
// together, so "Approve N" sends each exactly what its own card's button would.
export function bulkable(item: BulkItem): boolean {
  if (item.status !== "open") return false;
  if (item.kind !== "approval" && item.kind !== "review") return false;
  if (item.subjectType === FINDING_SUBJECT || item.subjectType === SCRIPT_DRAFT_SUBJECT) {
    return false;
  }
  if (typeof item.payload.reachOutId === "string") return false;
  return item.resolvableByOperator || canStepIn(item);
}

/**
 * Items alike enough to decide together: the same client, agent, kind and subject, and the same
 * hand (ours, or the client's), SIMILAR_MIN or more, the biggest group first.
 */
export function similarGroups<T extends BulkItem>(items: readonly T[]): SimilarGroup<T>[] {
  const groups = new Map<string, SimilarGroup<T>>();
  for (const i of items) {
    if (!bulkable(i)) continue;
    const mine = i.resolvableByOperator;
    const key = [i.tenantId, i.agentId ?? "", i.kind, i.subjectType ?? "", mine].join("|");
    const g = groups.get(key) ?? { key, items: [], mine };
    g.items.push(i);
    groups.set(key, g);
  }
  return [...groups.values()]
    .filter((g) => g.items.length >= SIMILAR_MIN)
    .sort((a, b) => b.items.length - a.items.length || a.key.localeCompare(b.key));
}

/** The lines above the list: each group of similar items, with "Handle together". */
export function SimilarItems<T extends BulkItem>({
  items,
  context,
  onDone,
}: {
  items: readonly T[];
  /** "Pia · Demo client": who asks, for whom. */
  context: (item: T) => string;
  onDone: () => void;
}) {
  const groups = similarGroups(items);
  const [open, setOpen] = useState<string | null>(null);
  if (groups.length === 0) return null;
  const shown = groups.find((g) => g.key === open);
  return (
    <>
      <Card titleAbove title="Similar items" testId="ops-inbox-similar">
        {groups.map((g) => {
          const first = g.items[0] as T;
          return (
            <div key={g.key} className="ops-row" data-testid={`ops-inbox-similar-${first.id}`}>
              <span className="ops-row__text">
                <span className="font-medium text-ink">
                  {plural(g.items.length, "item", "items")} like "{first.title}"
                </span>
                <span className="text-sm text-ink-muted">
                  {[context(first), g.mine ? "ours to answer" : "the client's to answer"].join(
                    " · ",
                  )}
                </span>
              </span>
              <Button
                size="sm"
                data-testid={`ops-inbox-similar-${first.id}-open`}
                onClick={() => setOpen(g.key)}
              >
                Handle together
              </Button>
            </div>
          );
        })}
      </Card>
      {shown ? (
        <BulkSheet
          group={shown}
          onClose={() => setOpen(null)}
          onDone={() => {
            setOpen(null);
            onDone();
          }}
        />
      ) : null}
    </>
  );
}

function BulkSheet<T extends BulkItem>({
  group,
  onClose,
  onDone,
}: {
  group: SimilarGroup<T>;
  onClose: () => void;
  onDone: () => void;
}) {
  const api = useApiClient();
  const [picked, setPicked] = useState(() => new Set(group.items.map((i) => i.id)));
  const [reason, setReason] = useState("");
  const [progress, setProgress] = useState<{ done: number; of: number } | null>(null);
  const [failed, setFailed] = useState<{ id: string; error: unknown }[]>([]);
  const chosen = group.items.filter((i) => picked.has(i.id));
  const busy = progress !== null && progress.done < progress.of;
  const ready = !busy && chosen.length > 0 && (group.mine || reason.trim().length > 0);

  const decide = async (decision: "approve" | "reject") => {
    const misses: { id: string; error: unknown }[] = [];
    setFailed([]);
    setProgress({ done: 0, of: chosen.length });
    // One at a time, each through its own route: each item is decided, recorded and audited as
    // it is from its own card.
    for (const [n, item] of chosen.entries()) {
      try {
        if (group.mine) {
          await api.call(apiRoutes.opsResolveInbox, {
            params: { id: item.id },
            body: { decision },
          });
        } else {
          await api.call(apiRoutes.opsStepInInbox, {
            params: { id: item.tenantId, itemId: item.id },
            body: { action: decision, reason: reason.trim() },
          });
        }
      } catch (error) {
        misses.push({ id: item.id, error });
      }
      setProgress({ done: n + 1, of: chosen.length });
    }
    setFailed(misses);
    if (misses.length === 0) onDone();
    else setPicked(new Set(misses.map((m) => m.id)));
  };

  const n = chosen.length;
  const them = group.mine ? "" : " for them";
  return (
    <SideSheet
      wide
      testId="ops-inbox-bulk"
      title={`${plural(group.items.length, "similar item", "similar items")}`}
      onClose={onClose}
      footer={
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            data-testid="ops-inbox-bulk-approve"
            disabled={!ready}
            working={busy}
            onClick={() => void decide("approve")}
          >
            Approve {n}
            {them}
          </Button>
          <Button
            data-testid="ops-inbox-bulk-reject"
            disabled={!ready}
            onClick={() => void decide("reject")}
          >
            Reject {n}
            {them}
          </Button>
          {progress ? (
            <span className="text-sm text-ink-muted" data-testid="ops-inbox-bulk-progress">
              {progress.done} of {progress.of} done
            </span>
          ) : null}
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-ink-muted">
          {group.mine
            ? "Each one you leave ticked gets its own decision, as if you answered it on its card."
            : "These are the client's to answer. Step in only when you must: each one you leave ticked shows them that we did, and why."}
        </p>
        {group.mine ? null : (
          <label className="ds-field" htmlFor="ops-inbox-bulk-reason">
            <span className="text-sm font-medium text-ink">Why we're stepping in</span>
            <input
              id="ops-inbox-bulk-reason"
              data-testid="ops-inbox-bulk-reason"
              className="ds-input text-sm"
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
        )}
        {failed.length > 0 ? (
          <div className="flex flex-col gap-2" data-testid="ops-inbox-bulk-failed">
            <p className="text-sm text-ink">
              {plural(failed.length, "item wasn't", "items weren't")} done. They stay ticked to try
              again.
            </p>
            <ErrorNotice error={failed[0]?.error} />
          </div>
        ) : null}
        <ul className="flex flex-col rounded-md border border-line">
          {group.items.map((i) => (
            <li
              key={i.id}
              className="flex items-start gap-3 border-b border-line px-4 py-2.5 text-sm last:border-b-0"
            >
              <input
                type="checkbox"
                className="mt-0.5 size-4 accent-[var(--slate)]"
                aria-label={i.title}
                data-testid={`ops-inbox-bulk-${i.id}`}
                checked={picked.has(i.id)}
                disabled={busy}
                onChange={(e) =>
                  setPicked((s) => {
                    const next = new Set(s);
                    if (e.target.checked) next.add(i.id);
                    else next.delete(i.id);
                    return next;
                  })
                }
              />
              <span className="text-ink">{i.title}</span>
            </li>
          ))}
        </ul>
      </div>
    </SideSheet>
  );
}
