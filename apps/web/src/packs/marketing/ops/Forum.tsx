// Forum (M48, docs/plan.md §1.77): the forum watch's work for a person. Replies waiting: read the
// thread and the draft, then approve it naming who will post it under their own name, or turn it
// down with a reason. To post: the approved replies, for that person to post by hand on the forum
// and then mark posted. A thread can be added for the watch to look at (any https link; a Hacker
// News link is kept as that item). The agent never posts. Thread titles and drafts are the
// forum's and the agent's words, shown as text.
import { type FormEvent, useState } from "react";
import { useApiClient } from "../../../api/useApi";
import { Field, Select, TextInput } from "../../../ui/forms";
import {
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Loading,
  SectionLabel,
} from "../../../ui/primitives";
import { StatusChip } from "../../../ui/status";
import { runMarketingAction, useMarketingReport } from "./api";
import { MarketingLayout, useMarketingClientId } from "./layout";

export type ReplyStatus = "waiting" | "approved" | "rejected" | "posted";

export interface ForumReplyRow {
  id: string;
  status: ReplyStatus;
  body: string;
  createdAt: string | null;
  poster: { id: string; name: string | null } | null;
  decidedBy: string | null;
  decidedAt: string | null;
  postedAt: string | null;
  reason: string | null;
  runId: string | null;
  thread: { id: string; source: string; url: string; title: string; externalId: string } | null;
}

export interface ForumThreadRow {
  id: string;
  source: string;
  url: string;
  title: string;
  seenAt: string | null;
  outcome: "drafted" | "passed" | null;
  addedBy: string | null;
  byAgent: boolean;
}

export interface ForumReport {
  waiting: ForumReplyRow[];
  toPost: ForumReplyRow[];
  done: ForumReplyRow[];
  threads: ForumThreadRow[];
  people: { id: string; name: string; role: string }[];
  counts: { waiting: number; toPost: number; threads: number };
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : "That didn't work.");

function ThreadLink({ thread }: { thread: ForumReplyRow["thread"] }) {
  if (!thread) return <span className="text-ink-muted">A thread no longer here</span>;
  return (
    <a
      href={thread.url}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className="font-medium text-link hover:underline"
    >
      {thread.title}
    </a>
  );
}

function Draft({ body }: { body: string }) {
  return (
    <p className="whitespace-pre-wrap break-words rounded-md border border-line p-3 text-ink">
      {body}
    </p>
  );
}

function Waiting({
  reply,
  people,
  onDone,
}: {
  reply: ForumReplyRow;
  people: ForumReport["people"];
  onDone: () => void;
}) {
  const api = useApiClient();
  const clientId = useMarketingClientId();
  const [poster, setPoster] = useState("");
  const [reason, setReason] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const decide = async (body: Record<string, unknown>) => {
    setBusy(true);
    setProblem(null);
    try {
      await runMarketingAction(api, clientId, "decide-forum-reply", { replyId: reply.id, ...body });
      onDone();
    } catch (e) {
      setProblem(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card testId="marketing-forum-waiting-row" pad>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <ThreadLink thread={reply.thread} />
          <StatusChip state="waiting">Waiting for you</StatusChip>
        </div>
        <Draft body={reply.body} />
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Who posts it, under their own name" className="w-64">
            <Select
              value={poster}
              onChange={(e) => setPoster(e.target.value)}
              data-testid="marketing-forum-poster-select"
            >
              <option value="">Choose a person</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Button
            variant="primary"
            disabled={busy || !poster}
            onClick={() => decide({ decision: "approve", posterUserId: poster })}
            data-testid="marketing-forum-reply-approve"
          >
            Approve for them to post
          </Button>
          <Button
            disabled={busy}
            onClick={() => setRejecting(true)}
            data-testid="marketing-forum-reply-reject"
          >
            Turn down
          </Button>
        </div>
        {rejecting ? (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void decide({ decision: "reject", reason: reason.trim() });
            }}
          >
            <Field
              label="Why"
              hint="For your team; the watch learns nothing from it."
              className="w-80"
            >
              <TextInput
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                data-testid="marketing-forum-reason-input"
              />
            </Field>
            <Button
              type="submit"
              disabled={busy || reason.trim() === ""}
              data-testid="marketing-forum-reply-reject-confirm"
            >
              Turn it down
            </Button>
          </form>
        ) : null}
        {problem ? (
          <p className="text-sm ui-tone-risk" role="alert">
            {problem}
          </p>
        ) : null}
      </div>
    </Card>
  );
}

function ToPost({ reply, onDone }: { reply: ForumReplyRow; onDone: () => void }) {
  const api = useApiClient();
  const clientId = useMarketingClientId();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const mark = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await runMarketingAction(api, clientId, "mark-forum-posted", { replyId: reply.id });
      onDone();
    } catch (e) {
      setProblem(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card testId="marketing-forum-topost-row" pad>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <ThreadLink thread={reply.thread} />
          <StatusChip state="person">For {reply.poster?.name ?? "a person"} to post</StatusChip>
        </div>
        <Draft body={reply.body} />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            disabled={busy}
            onClick={mark}
            data-testid="marketing-forum-reply-posted"
          >
            Mark posted
          </Button>
          <span className="text-sm text-ink-muted">
            Post it by hand on the forum, as written, then mark it here.
          </span>
        </div>
        {problem ? (
          <p className="text-sm ui-tone-risk" role="alert">
            {problem}
          </p>
        ) : null}
      </div>
    </Card>
  );
}

function AddThread({ onDone }: { onDone: () => void }) {
  const api = useApiClient();
  const clientId = useMarketingClientId();
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      await runMarketingAction(api, clientId, "add-forum-thread", {
        url: url.trim(),
        title: title.trim(),
      });
      setUrl("");
      setTitle("");
      onDone();
    } catch (err) {
      setProblem(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Add a thread for the watch" testId="marketing-forum-add" pad>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field
          label="Link"
          hint="An https link. A Hacker News thread is looked at once, like the ones the watch finds."
        >
          <TextInput
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://news.ycombinator.com/item?id=…"
            data-testid="marketing-forum-add-url-input"
          />
        </Field>
        <Field label="Its title">
          <TextInput
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            data-testid="marketing-forum-add-title-input"
          />
        </Field>
        {problem ? (
          <p className="text-sm ui-tone-risk" role="alert">
            {problem}
          </p>
        ) : null}
        <div>
          <Button
            type="submit"
            disabled={busy || !url.trim() || !title.trim()}
            data-testid="marketing-forum-add-create"
          >
            Add the thread
          </Button>
        </div>
      </form>
    </Card>
  );
}

function outcomeChip(t: ForumThreadRow) {
  if (t.outcome === "passed") return <StatusChip state="idle">Passed over</StatusChip>;
  if (t.outcome === "drafted") return <StatusChip state="done">Drafted</StatusChip>;
  return t.addedBy ? (
    <StatusChip state="person">Added by {t.addedBy}</StatusChip>
  ) : (
    <StatusChip state="idle">Seen</StatusChip>
  );
}

export function MarketingForumScreen() {
  const clientId = useMarketingClientId();
  const state = useMarketingReport<ForumReport>(clientId, "forum");
  const data = state.data;
  return (
    <MarketingLayout
      title="Forum"
      subtitle="Hacker News threads worth an answer, and reply drafts for a person to post by hand. The agent never posts."
      testId="marketing-forum"
    >
      {state.loading && !data ? <Loading /> : null}
      {state.error ? <ErrorNotice error={state.error} onRetry={state.reload} /> : null}
      {data ? (
        <div className="flex flex-col gap-6">
          <section data-testid="marketing-forum-waiting">
            <SectionLabel>Replies waiting for you ({data.counts.waiting})</SectionLabel>
            {data.waiting.length === 0 ? (
              <EmptyState testId="marketing-forum-waiting-empty">
                No reply is waiting. The forum watch drafts one only where it can genuinely help.
              </EmptyState>
            ) : (
              <ul className="flex flex-col gap-3">
                {data.waiting.map((r) => (
                  <li key={r.id}>
                    <Waiting reply={r} people={data.people} onDone={state.reload} />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section data-testid="marketing-forum-topost">
            <SectionLabel>To post ({data.counts.toPost})</SectionLabel>
            {data.toPost.length === 0 ? (
              <EmptyState testId="marketing-forum-topost-empty">
                Nothing to post. An approved reply waits here for its person.
              </EmptyState>
            ) : (
              <ul className="flex flex-col gap-3">
                {data.toPost.map((r) => (
                  <li key={r.id}>
                    <ToPost reply={r} onDone={state.reload} />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <AddThread onDone={state.reload} />

          <section data-testid="marketing-forum-threads">
            <SectionLabel>Threads looked at</SectionLabel>
            {data.threads.length === 0 ? (
              <EmptyState testId="marketing-forum-threads-empty">
                None yet. The watch looks every few hours once its agent is on.
              </EmptyState>
            ) : (
              <ul className="flex flex-col gap-2">
                {data.threads.map((t) => (
                  <li
                    key={t.id}
                    className="flex flex-wrap items-center justify-between gap-2"
                    data-testid="marketing-forum-thread-row"
                  >
                    <a
                      href={t.url}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      className="text-link hover:underline"
                    >
                      {t.title}
                    </a>
                    {outcomeChip(t)}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {data.done.length > 0 ? (
            <section data-testid="marketing-forum-done">
              <SectionLabel>Posted and turned down</SectionLabel>
              <ul className="flex flex-col gap-2">
                {data.done.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-2">
                    <ThreadLink thread={r.thread} />
                    {r.status === "posted" ? (
                      <StatusChip state="done">Posted by {r.poster?.name ?? "a person"}</StatusChip>
                    ) : (
                      <StatusChip state="idle">Turned down: {r.reason ?? "no reason"}</StatusChip>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      ) : null}
    </MarketingLayout>
  );
}
