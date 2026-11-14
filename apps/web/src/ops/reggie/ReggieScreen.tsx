// `/ops/reggie` and `/ops/reggie/:id` (docs/plan.md §1.101): Reggie, the operator's account agent.
// Your conversations on the left; on the right, the conversation: your words, Reggie's answers
// with the tools it read, and a card for each change it proposed, which happens only when you
// confirm it. `?client=<id>` starts a conversation about that client (the client page's "Ask
// Reggie").
import type { ReggieAction, ReggieMessage } from "@countersign/core";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { AgentBadge } from "../../ui/badges";
import { Select } from "../../ui/forms";
import { Badge, Button, Card, cx, ErrorNotice, Loading, PageHeader } from "../../ui/primitives";

const STATUS: Record<
  ReggieAction["status"],
  { label: string; tone: "warning" | "positive" | "neutral" | "risk" }
> = {
  proposed: { label: "Waiting on you", tone: "warning" },
  done: { label: "Done", tone: "positive" },
  cancelled: { label: "Turned down", tone: "neutral" },
  failed: { label: "Failed", tone: "risk" },
};

export function ReggieScreen() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const api = useApiClient();
  const list = useApi(apiRoutes.opsReggieConversations);
  const clients = useApi(apiRoutes.opsClients, { query: { view: "names" } });
  const [about, setAbout] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [starting, setStarting] = useState(false);
  const asked = params.get("client");
  const startedFor = useRef<string | null>(null);

  async function start(clientId: string | null) {
    setStarting(true);
    setError(null);
    try {
      const out = await api.call(apiRoutes.opsReggieConversationStart, {
        body: clientId ? { clientId } : {},
      });
      list.reload();
      navigate(`/ops/reggie/${out.conversation.id}`, { replace: !!asked });
    } catch (e) {
      setError(e);
    } finally {
      setStarting(false);
    }
  }

  // "Ask Reggie" on a client's page: one conversation about that client, started on arrival.
  // biome-ignore lint/correctness/useExhaustiveDependencies: start once per `?client=`.
  useEffect(() => {
    if (!id && asked && startedFor.current !== asked) {
      startedFor.current = asked;
      void start(asked);
    }
  }, [id, asked]);

  return (
    <div className="flex flex-col gap-6" data-testid="reggie">
      <PageHeader
        title="Reggie"
        subtitle="Your account agent. It reads what you can read, asks clients for what only they can give, and changes nothing until you confirm."
      />
      <div className="grid gap-6 lg:grid-cols-[18rem_1fr]">
        <aside className="flex flex-col gap-3">
          <Card pad>
            <div className="flex flex-col gap-2">
              <Select
                aria-label="About"
                value={about}
                onChange={(e) => setAbout(e.target.value)}
                data-testid="reggie-about"
              >
                <option value="">About everything</option>
                {(clients.data?.clients ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
              <Button
                variant="primary"
                size="sm"
                onClick={() => void start(about || null)}
                disabled={starting}
                data-testid="reggie-new"
              >
                New conversation
              </Button>
            </div>
          </Card>
          {list.loading && !list.data ? <Loading /> : null}
          <ul className="flex flex-col gap-1" data-testid="reggie-conversations">
            {(list.data?.items ?? []).map((c) => (
              <li key={c.id}>
                <Link
                  to={`/ops/reggie/${c.id}`}
                  className={cx(
                    "block rounded-md px-3 py-2 text-sm",
                    c.id === id ? "bg-surface-subtle text-ink" : "text-ink-muted hover:text-ink",
                  )}
                  data-testid={`reggie-conversation-${c.id}`}
                >
                  <span className="block truncate font-medium">
                    {c.title || "New conversation"}
                  </span>
                  {c.client ? (
                    <span className="block truncate text-xs">{c.client.name}</span>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        </aside>
        <section>
          {error ? <ErrorNotice error={error} /> : null}
          {id ? (
            <Conversation id={id} onChanged={() => list.reload()} />
          ) : (
            <Card pad>
              <p className="text-ink-muted" data-testid="reggie-empty">
                Start a conversation about a client, or about everything. Ask how a client is doing,
                what's waiting and on whom, or to ask a client for something.
              </p>
            </Card>
          )}
        </section>
      </div>
    </div>
  );
}

function Conversation({ id, onChanged }: { id: string; onChanged(): void }) {
  const api = useApiClient();
  const loaded = useApi(apiRoutes.opsReggieConversation, { params: { id } });
  const [data, setData] = useState(loaded.data ?? null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [text, setText] = useState("");
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (loaded.data) setData(loaded.data);
  }, [loaded.data]);
  // jsdom has no scrollIntoView; browsers keep the newest message in view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the conversation grows.
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "end" });
  }, [data?.messages.length, pending]);

  async function send() {
    const words = text.trim();
    if (!words || pending) return;
    setPending(words);
    setError(null);
    try {
      const out = await api.call(apiRoutes.opsReggieTurn, {
        params: { id },
        body: { text: words },
      });
      setData(out);
      setText("");
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setPending(null);
    }
  }

  function replaced(action: ReggieAction) {
    setData((d) =>
      d ? { ...d, actions: d.actions.map((a) => (a.id === action.id ? action : a)) } : d,
    );
  }

  // Each card goes under the first answer of Reggie's made at or after it (the turn that proposed it).
  const answers = (data?.messages ?? []).filter((m) => m.role === "reggie");
  const cardsOf = (messageId: string) =>
    (data?.actions ?? []).filter(
      (a) => answers.find((m) => m.createdAt >= a.createdAt)?.id === messageId,
    );

  if (!data) {
    return loaded.error ? (
      <ErrorNotice error={loaded.error} onRetry={loaded.reload} />
    ) : (
      <Loading />
    );
  }
  return (
    <div className="flex flex-col gap-4" data-testid="reggie-conversation">
      {data.conversation.client ? (
        <p className="text-sm text-ink-muted">
          About{" "}
          <Link className="underline" to={`/ops/clients/${data.conversation.client.id}`}>
            {data.conversation.client.name}
          </Link>
        </p>
      ) : null}
      <div className="flex flex-col gap-5">
        {data.messages.map((m) => (
          <Message key={m.id} message={m} cards={cardsOf(m.id)} onDecided={replaced} />
        ))}
        {pending ? (
          <>
            <p className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-lg bg-surface-subtle px-3.5 py-2.5 text-sm text-ink">
              {pending}
            </p>
            <div className="flex items-start gap-3" data-testid="reggie-thinking">
              <AgentBadge name="Reggie" size="sm" />
              <p className="pt-1 text-sm text-ink-muted">Reggie is looking into it…</p>
            </div>
          </>
        ) : null}
        <div ref={end} />
      </div>
      {error ? <ErrorNotice error={error} /> : null}
      <div className="rounded-md border border-line-strong bg-surface p-3">
        <textarea
          aria-label="Message to Reggie"
          data-testid="reggie-input"
          rows={3}
          value={text}
          placeholder="Ask Reggie about a client, or ask it to get something from one."
          className="w-full resize-none bg-transparent text-sm text-ink placeholder:text-ink-muted focus:outline-none"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="mt-2 flex justify-end">
          <Button
            variant="primary"
            size="sm"
            onClick={() => void send()}
            disabled={!text.trim() || !!pending}
            data-testid="reggie-send"
          >
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}

function Message({
  message: m,
  cards,
  onDecided,
}: {
  message: ReggieMessage;
  cards: ReggieAction[];
  onDecided(a: ReggieAction): void;
}) {
  if (m.role === "operator") {
    return (
      <p
        className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-lg bg-surface-subtle px-3.5 py-2.5 text-sm text-ink"
        data-testid="reggie-operator-message"
      >
        {m.text}
      </p>
    );
  }
  return (
    <div className="flex items-start gap-3" data-testid="reggie-message">
      <AgentBadge name="Reggie" size="sm" />
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <p className="whitespace-pre-wrap text-sm text-ink">{m.text}</p>
        {m.tools.length > 0 ? (
          <p className="text-xs text-ink-muted" data-testid="reggie-tools">
            Read: {m.tools.join(", ")}
          </p>
        ) : null}
        {cards.map((a) => (
          <ActionCard key={a.id} action={a} onDecided={onDecided} />
        ))}
      </div>
    </div>
  );
}

function ActionCard({
  action: a,
  onDecided,
}: {
  action: ReggieAction;
  onDecided(a: ReggieAction): void;
}) {
  const api = useApiClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const status = STATUS[a.status];

  async function decide(confirm: boolean) {
    setBusy(true);
    setError(null);
    try {
      const out = await api.call(
        confirm ? apiRoutes.opsReggieActionConfirm : apiRoutes.opsReggieActionCancel,
        { params: { id: a.id } },
      );
      onDecided(out.action);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card pad testId={`reggie-action-${a.id}`}>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-medium text-ink">{a.title}</span>
          <Badge tone={status.tone} testId={`reggie-action-${a.id}-status`}>
            {status.label}
          </Badge>
        </div>
        {a.lines[0] ? <p className="text-sm text-ink-muted">{a.lines[0]}</p> : null}
        {a.lines.slice(1).map((line) => (
          <p key={line} className="whitespace-pre-wrap text-sm text-ink">
            {line}
          </p>
        ))}
        {a.outcome ? (
          <p className="text-sm text-ink-muted" data-testid={`reggie-action-${a.id}-outcome`}>
            {a.outcome}
          </p>
        ) : null}
        {error ? <ErrorNotice error={error} /> : null}
        {a.status === "proposed" ? (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              size="sm"
              onClick={() => void decide(true)}
              disabled={busy}
              data-testid={`reggie-action-${a.id}-confirm`}
            >
              Confirm
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void decide(false)}
              disabled={busy}
              data-testid={`reggie-action-${a.id}-cancel`}
            >
              Turn down
            </Button>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
