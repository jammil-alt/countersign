// `/ops/feedback`: everything sent with the Feedback button, from the back office and the clients
// this operator serves, newest first, open by default. Each item: who, which client, the page, what
// was pinned, the comment, the picture with the pin; Resolve (with an optional note, e.g. a PR
// link) and Reopen. Drafted in the prototype's back-office style (no prototype screen;
// docs/ui-plan.md): each item a card with who and where in its head, the actions in its foot.
import type { FeedbackItem } from "@countersign/core";
import { useState } from "react";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { PinnedPicture } from "../../feedback/Feedback";
import { TextInput } from "../../ui/forms";
import { Loaded, Page } from "../../ui/page";
import { Badge, Button, Card, EmptyState, PageHeader } from "../../ui/primitives";

type Filter = "open" | "resolved" | "all";
const FILTERS: [Filter, string][] = [
  ["open", "Open"],
  ["resolved", "Resolved"],
  ["all", "All"],
];

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function OpsFeedbackScreen() {
  const [filter, setFilter] = useState<Filter>("open");
  const feedback = useApi(apiRoutes.opsFeedback, { query: { status: filter } });
  const items = feedback.data?.items ?? [];
  const open = items.filter((i) => i.status === "open").length;

  return (
    <Page testId="ops-feedback">
      <PageHeader
        title="Feedback"
        subtitle={
          feedback.data
            ? filter === "resolved"
              ? `${items.length} resolved. What people sent with the Feedback button.`
              : `${open} open${filter === "all" ? ` of ${items.length}` : ""}. What people sent with the Feedback button.`
            : "What people sent with the Feedback button."
        }
        actions={
          <div className="ds-seg" data-testid="ops-feedback-filter">
            {FILTERS.map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={filter === value}
                data-testid={`ops-feedback-filter-${value}`}
                onClick={() => setFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
        }
      />
      <Loaded state={feedback}>
        {(data) =>
          data.items.length === 0 ? (
            <EmptyState>
              {filter === "open" ? "Nothing open. New feedback shows here." : "No feedback here."}
            </EmptyState>
          ) : (
            <div data-testid="ops-feedback-list" className="flex flex-col gap-4">
              {data.items.map((item) => (
                <FeedbackCard key={item.id} item={item} onChanged={feedback.reload} />
              ))}
            </div>
          )
        }
      </Loaded>
    </Page>
  );
}

function FeedbackCard({ item, onChanged }: { item: FeedbackItem; onChanged: () => void }) {
  const client = useApiClient();
  const [resolving, setResolving] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const who = item.from.name ?? item.from.email;

  async function act(action: "resolve" | "reopen") {
    setBusy(true);
    setError(null);
    try {
      if (action === "resolve") {
        const trimmed = note.trim();
        await client.call(apiRoutes.opsResolveFeedback, {
          params: { id: item.id },
          body: trimmed ? { note: trimmed } : {},
        });
      } else {
        await client.call(apiRoutes.opsReopenFeedback, { params: { id: item.id } });
      }
      setResolving(false);
      setNote("");
      onChanged();
    } catch {
      setError(
        action === "resolve" ? "We couldn't resolve it. Try again." : "We couldn't reopen it.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      testId={`ops-feedback-item-${item.id}`}
      title={
        <span className="flex min-w-0 flex-col">
          <span>
            {who}
            <span className="font-normal text-ink-muted">
              {" · "}
              <span data-testid="ops-feedback-client">
                {item.client ? item.client.name : "Back office"}
              </span>
              {" · "}
              {when(item.createdAt)}
            </span>
          </span>
          <span
            className="reference truncate text-sm font-normal text-ink-muted"
            data-testid="ops-feedback-path"
          >
            {item.path}
          </span>
        </span>
      }
      meta={
        item.status === "open" ? (
          <Badge tone="warning" testId="ops-feedback-status">
            Open
          </Badge>
        ) : (
          <Badge tone="positive" testId="ops-feedback-status">
            Resolved
          </Badge>
        )
      }
      footer={
        <>
          {item.status === "open" && !resolving ? (
            <Button data-testid="ops-feedback-resolve" onClick={() => setResolving(true)}>
              Resolve
            </Button>
          ) : null}
          {item.status === "open" && resolving ? (
            <>
              <TextInput
                data-testid="ops-feedback-note"
                aria-label="Note (optional)"
                placeholder="Note, such as a PR link (optional)"
                value={note}
                maxLength={2000}
                onChange={(e) => setNote(e.target.value)}
                className="w-80 max-w-full"
              />
              <Button
                variant="primary"
                data-testid="ops-feedback-resolve-confirm"
                disabled={busy}
                onClick={() => void act("resolve")}
              >
                Resolve
              </Button>
              <Button variant="ghost" onClick={() => setResolving(false)}>
                Cancel
              </Button>
            </>
          ) : null}
          {item.status === "resolved" ? (
            <Button
              data-testid="ops-feedback-reopen"
              disabled={busy}
              onClick={() => void act("reopen")}
            >
              Reopen
            </Button>
          ) : null}
          {error ? <span className="ds-error text-sm">{error}</span> : null}
        </>
      }
    >
      <div className="ui-card__body grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,360px)]">
        <div className="min-w-0">
          <p data-testid="ops-feedback-comment" className="whitespace-pre-wrap text-ink">
            {item.comment}
          </p>
          <p className="mt-3 text-sm text-ink-muted" data-testid="ops-feedback-target">
            {item.pin ? (
              <>
                Pinned: <span className="text-ink">{item.target ?? "a spot on the page"}</span>
              </>
            ) : (
              "No particular spot"
            )}
          </p>
          {item.status === "resolved" ? (
            <p className="mt-3 text-sm text-ink-muted" data-testid="ops-feedback-resolution">
              Resolved by {item.resolvedBy?.name ?? item.resolvedBy?.email ?? "someone"}
              {item.resolvedAt ? ` on ${when(item.resolvedAt)}` : ""}
              {item.resolutionNote ? (
                <>
                  {": "}
                  <Note text={item.resolutionNote} />
                </>
              ) : null}
            </p>
          ) : null}
        </div>
        {item.hasScreenshot ? (
          <Screenshot item={item} />
        ) : (
          <p className="text-sm text-ink-muted" data-testid="ops-feedback-no-picture">
            No picture
          </p>
        )}
      </div>
    </Card>
  );
}

/** A note that is a link stays a link. */
function Note({ text }: { text: string }) {
  if (/^https?:\/\/\S+$/.test(text)) {
    return (
      <a href={text} target="_blank" rel="noreferrer" className="text-link underline">
        {text}
      </a>
    );
  }
  return <span className="text-ink">{text}</span>;
}

function Screenshot({ item }: { item: FeedbackItem }) {
  // A 5-minute link, asked for when the card shows.
  const { data, error } = useApi(apiRoutes.opsFeedbackScreenshot, { params: { id: item.id } });
  if (error) return <p className="text-sm text-ink-muted">Couldn't load the picture.</p>;
  return (
    <a
      href={data?.url}
      target="_blank"
      rel="noreferrer"
      className="block"
      aria-label="Open the picture"
    >
      <PinnedPicture
        src={data?.url ?? null}
        pin={item.pin}
        viewport={item.viewport}
        testId="ops-feedback-picture"
      />
    </a>
  );
}
