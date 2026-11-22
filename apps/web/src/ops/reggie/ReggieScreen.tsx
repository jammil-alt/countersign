// `/ops/reggie` and `/ops/reggie/:id` (docs/plan.md §1.101): Reggie, the operator's account agent.
// Your conversations on the left; on the right, the conversation: your words, Reggie's answers
// with the tools it read, and a card for each change it proposed, which happens only when you
// confirm it. `/ops/reggie` is a new conversation, ready to type into; `?client=<id>` makes it
// about that client (the top bar's and the client page's "Ask Reggie").
// DECISION (QA, 2026-11-22): a conversation is saved with its first message, not on opening.
// Opening Reggie used to need a click on "New conversation" before you could type, and that click
// saved an empty conversation; now the box is there at once, and sending the first words starts
// the conversation and its first turn together. The list leaves out conversations with no message.
import { REGGIE_TEXT_MAX, type ReggieAction, type ReggieMessage } from "@countersign/core";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { voiceFor } from "../../api/voice";
import { AgentBadge } from "../../ui/badges";
import { AgentSaid, ChatLog, Composer, Pending, YouSaid } from "../../ui/chat";
import { Select } from "../../ui/forms";
import {
  Badge,
  Button,
  buttonClass,
  Card,
  cx,
  ErrorNotice,
  Loading,
  PageHeader,
} from "../../ui/primitives";
import { lookedAt } from "./words";

type OneConversation = ResponseOf<typeof apiRoutes.opsReggieTurn>;

/** What a new conversation's first turn hands to its page, so it opens with the answer in. */
interface FirstTurn {
  first?: OneConversation;
}

const STATUS: Record<
  ReggieAction["status"],
  { label: string; tone: "warning" | "positive" | "neutral" | "risk" }
> = {
  proposed: { label: "Waiting on you", tone: "warning" },
  done: { label: "Done", tone: "positive" },
  cancelled: { label: "Turned down", tone: "neutral" },
  failed: { label: "Failed", tone: "risk" },
};

const PLACEHOLDER = "Ask Reggie about a client, or ask it to get something from one.";

export function ReggieScreen() {
  const { id } = useParams();
  // Conversations with a message only: the API leaves out empty ones.
  const list = useApi(apiRoutes.opsReggieConversations);
  const items = list.data?.items ?? [];

  return (
    <div className="flex flex-col gap-6" data-testid="reggie">
      <PageHeader
        title="Reggie"
        subtitle="Your account agent. It reads what you can read, asks clients for what only they can give, and changes nothing until you confirm."
      />
      <div className="grid gap-6 lg:grid-cols-[18rem_1fr]">
        <aside className="flex flex-col gap-3">
          {id ? (
            <Link
              to="/ops/reggie"
              className={buttonClass("primary", undefined, "sm")}
              data-testid="reggie-new"
            >
              New conversation
            </Link>
          ) : null}
          {list.loading && !list.data ? <Loading /> : null}
          <ul className="flex flex-col gap-1" data-testid="reggie-conversations">
            {items.map((c) => (
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
          {id ? (
            <Conversation key={id} id={id} onChanged={() => list.reload()} />
          ) : (
            <NewConversation onStarted={() => list.reload()} />
          )}
        </section>
      </div>
    </div>
  );
}

/**
 * A conversation not saved yet: what it's about and the box, ready to type into. The first words
 * sent start it (about the client chosen) and its first turn; then its own page opens.
 */
function NewConversation({ onStarted }: { onStarted(): void }) {
  const api = useApiClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const clients = useApi(apiRoutes.opsClients, { query: { view: "names" } });
  const [about, setAbout] = useState(params.get("client") ?? "");
  const [pending, setPending] = useState<{ text: string; since: number } | null>(null);
  const [error, setError] = useState<unknown>(null);
  // A conversation started whose first turn failed: a second try goes to it, not to a new one.
  const started = useRef<{ id: string; about: string } | null>(null);
  const box = useRef<HTMLTextAreaElement | null>(null);
  const asked = params.get("client") ?? "";

  // "Ask Reggie" with another client while this page is open: the new conversation is about it.
  useEffect(() => {
    setAbout(asked);
    started.current = null;
  }, [asked]);
  useEffect(() => {
    box.current?.focus();
  }, []);

  async function send(words: string): Promise<boolean> {
    if (pending) return false;
    setPending({ text: words, since: Date.now() });
    setError(null);
    try {
      if (!started.current || started.current.about !== about) {
        const out = await api.call(apiRoutes.opsReggieConversationStart, {
          body: about ? { clientId: about } : {},
        });
        started.current = { id: out.conversation.id, about };
      }
      const id = started.current.id;
      const first = await api.call(apiRoutes.opsReggieTurn, {
        params: { id },
        body: { text: words },
      });
      onStarted();
      navigate(`/ops/reggie/${id}`, { state: { first } satisfies FirstTurn });
      return true;
    } catch (e) {
      setError(e);
      return false;
    } finally {
      setPending(null);
    }
  }

  const served = clients.data?.clients ?? [];
  return (
    <div className="flex flex-col gap-4" data-testid="reggie-new-conversation">
      <div className="flex flex-wrap items-center gap-2 text-sm text-ink-muted">
        <label htmlFor="reggie-about">About</label>
        <Select
          id="reggie-about"
          aria-label="About"
          className="w-64"
          value={about}
          onChange={(e) => setAbout(e.target.value)}
          disabled={!!pending}
          data-testid="reggie-about"
        >
          <option value="">Everything</option>
          {/* A client asked about before the names load still shows as chosen. */}
          {about && !served.some((c) => c.id === about) ? (
            <option value={about}>This client</option>
          ) : null}
          {served.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </div>
      <ChatLog follow={pending?.text ?? ""}>
        {pending ? (
          <Pending
            text={pending.text}
            since={pending.since}
            badge={<AgentBadge name="Reggie" size="sm" />}
            label="Reggie is looking into it…"
            state="tracing"
            testId="reggie-thinking"
          />
        ) : (
          <p className="text-ink-muted" data-testid="reggie-empty">
            Ask how a client is doing, what's waiting and on whom, or to ask a client for something.
          </p>
        )}
      </ChatLog>
      {error ? <ErrorNotice error={error} /> : null}
      <Composer
        label="Message to Reggie"
        placeholder={PLACEHOLDER}
        maxLength={REGGIE_TEXT_MAX}
        busy={!!pending}
        onSend={send}
        inputRef={box}
        inputTestId="reggie-input"
        sendTestId="reggie-send"
        voice={voiceFor("ops", about || null)}
      />
    </div>
  );
}

function Conversation({ id, onChanged }: { id: string; onChanged(): void }) {
  const api = useApiClient();
  // A conversation just started opens with its first turn's answer, then reads its own.
  const first = (useLocation().state as FirstTurn | null)?.first;
  const handed = first?.conversation.id === id ? first : null;
  const loaded = useApi(apiRoutes.opsReggieConversation, { params: { id } });
  const [data, setData] = useState(loaded.data ?? handed);
  const [pending, setPending] = useState<{ text: string; since: number } | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (loaded.data) setData(loaded.data);
  }, [loaded.data]);

  async function send(words: string): Promise<boolean> {
    if (pending) return false;
    setPending({ text: words, since: Date.now() });
    setError(null);
    try {
      const out = await api.call(apiRoutes.opsReggieTurn, {
        params: { id },
        body: { text: words },
      });
      setData(out);
      onChanged();
      return true;
    } catch (e) {
      setError(e);
      return false;
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
      <ChatLog follow={`${data.messages.length}:${pending?.text ?? ""}`}>
        {data.messages.map((m) => (
          <Message key={m.id} message={m} cards={cardsOf(m.id)} onDecided={replaced} />
        ))}
        {pending ? (
          <Pending
            text={pending.text}
            since={pending.since}
            badge={<AgentBadge name="Reggie" size="sm" />}
            label="Reggie is looking into it…"
            state="tracing"
            testId="reggie-thinking"
          />
        ) : null}
      </ChatLog>
      {error ? <ErrorNotice error={error} /> : null}
      <Composer
        label="Message to Reggie"
        placeholder={PLACEHOLDER}
        maxLength={REGGIE_TEXT_MAX}
        busy={!!pending}
        onSend={send}
        inputTestId="reggie-input"
        sendTestId="reggie-send"
        voice={voiceFor("ops", data.conversation.client?.id)}
      />
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
    return <YouSaid text={m.text} testId="reggie-operator-message" />;
  }
  const looked = lookedAt(m.tools);
  return (
    <AgentSaid
      badge={<AgentBadge name="Reggie" size="sm" />}
      text={m.text}
      testId="reggie-message"
      textTestId="reggie-answer"
    >
      {looked ? (
        <p className="ui-chat-meta" data-testid="reggie-tools">
          {looked}
        </p>
      ) : null}
      {cards.map((a) => (
        <ActionCard key={a.id} action={a} onDecided={onDecided} />
      ))}
    </AgentSaid>
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
