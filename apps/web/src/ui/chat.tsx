// The one way a conversation with an agent looks and works, on every surface: the Builder (new
// agent, its panel, a step's chat, a fix), the skill Builder, Reggie in the back office, and Sloan
// and the client's other agents in the portal. A screen brings its own content (a turn's changes,
// a proposal's card, a message's sources) as children; the log, the bubbles, the reply's words,
// the agent at work and the composer are these. Styles in ./page.css (`ui-chat*`), tokens only.
//
// - `ChatLog`: the messages, kept scrolled to the newest.
// - `YouSaid`: your words, on the right. `AgentSaid`: an agent's (or a person's) answer, on the
//   left with its badge, its words as `ChatText` and whatever the screen adds under them.
// - `Thinking`: the agent is working on an answer: the design system's thinking loop (agent
//   motion), its words, and how long once it's more than a few seconds.
// - `Composer`: the message box. It grows from two lines to eight, then scrolls; Enter sends and
//   Shift+Enter starts a new line; the words leave the box as they're sent and come back if the
//   send fails. Shortcuts, starters, attach and voice go in its `tools` and `above` slots.
import type { ThinkingState } from "@countersign/core";
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  type TextareaHTMLAttributes,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { cx } from "./cx";
import { Thinking as ThinkingLoop } from "./motion";
import { Button } from "./primitives";
import { type Voice, VoiceButton } from "./voice";

// ── An agent's words ────────────────────────────────────────────────────────────────────────────

type Block = { kind: "p"; lines: string[] } | { kind: "ul" | "ol"; items: string[] };

const BULLET = /^\s*[-*•]\s+/;
const NUMBERED = /^\s*\d+[.)]\s+/;

/**
 * Markdown a model writes out of habit, as plain words: bold and headings lose their marks (a
 * reply is a chat message, not a report), inline code its backticks. Lists stay lists.
 */
export function plainWords(line: string): string {
  return line
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}

/** A reply's paragraphs and lists, read from its text. */
export function chatBlocks(text: string): Block[] {
  const out: Block[] = [];
  for (const chunk of text.replace(/\r\n/g, "\n").split(/\n\s*\n/)) {
    const lines = chunk.split("\n").filter((l) => l.trim() !== "");
    let para: string[] = [];
    let list = null as { kind: "ul" | "ol"; items: string[] } | null;
    const flush = () => {
      if (para.length) out.push({ kind: "p", lines: para });
      if (list) out.push(list);
      para = [];
      list = null;
    };
    for (const raw of lines) {
      const kind = BULLET.test(raw) ? "ul" : NUMBERED.test(raw) ? "ol" : null;
      if (kind) {
        if (para.length || list?.kind !== kind) flush();
        list ??= { kind, items: [] };
        list.items.push(plainWords(raw.replace(kind === "ul" ? BULLET : NUMBERED, "")));
      } else if (list && /^\s{2,}\S/.test(raw)) {
        // A list item's second line, indented under it.
        list.items[list.items.length - 1] += ` ${plainWords(raw.trim())}`;
      } else {
        if (list) flush();
        para.push(plainWords(raw.trim()));
      }
    }
    flush();
  }
  return out;
}

/** An agent's reply: paragraphs and plain lists, never Markdown's marks. */
export function ChatText({
  text,
  className,
  testId,
}: {
  text: string;
  /** Its type size, where it isn't in a `ChatLog`. */
  className?: string | undefined;
  testId?: string | undefined;
}) {
  const blocks = chatBlocks(text);
  return (
    <div className={cx("ui-chat-text", className)} data-testid={testId}>
      {blocks.map((b, i) => {
        const key = `${b.kind}-${i}`;
        if (b.kind === "p") return <p key={key}>{b.lines.join("\n")}</p>;
        const items = b.items.map((item, j) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a reply's words never reorder.
          <li key={`${j}-${item}`}>{item}</li>
        ));
        return b.kind === "ul" ? <ul key={key}>{items}</ul> : <ol key={key}>{items}</ol>;
      })}
    </div>
  );
}

// ── Writing to an agent ─────────────────────────────────────────────────────────────────────────

/** True when Enter should send: not with Shift (a new line), not while an IME is composing. */
export function sendsOnEnter(e: KeyboardEvent<HTMLTextAreaElement>): boolean {
  return e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229;
}

/**
 * The message box: it starts `minRows` lines tall, grows with what you write up to `maxRows`,
 * then scrolls. Enter sends, Shift+Enter starts a new line.
 */
export function ChatInput({
  value,
  onSend,
  minRows = 2,
  maxRows = 8,
  className,
  ref: outer,
  ...rest
}: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "rows" | "value"> & {
  value: string;
  onSend(): void;
  minRows?: number | undefined;
  maxRows?: number | undefined;
  ref?: RefObject<HTMLTextAreaElement | null> | undefined;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: measure again when the words change.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const style = getComputedStyle(el);
    const line = Number.parseFloat(style.lineHeight) || 24;
    const pad =
      (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
    const border =
      (Number.parseFloat(style.borderTopWidth) || 0) +
      (Number.parseFloat(style.borderBottomWidth) || 0);
    const min = line * minRows + pad + border;
    const max = line * maxRows + pad + border;
    el.style.height = "auto";
    const want = el.scrollHeight + border;
    el.style.height = `${Math.min(Math.max(want, min), max)}px`;
    el.style.overflowY = want > max ? "auto" : "hidden";
  }, [value, minRows, maxRows]);

  return (
    <textarea
      {...rest}
      ref={(el) => {
        ref.current = el;
        if (outer) outer.current = el;
      }}
      rows={minRows}
      value={value}
      className={cx("ui-chat-input", className)}
      onKeyDown={(e) => {
        rest.onKeyDown?.(e);
        if (e.defaultPrevented) return;
        if (sendsOnEnter(e)) {
          e.preventDefault();
          onSend();
        }
      }}
    />
  );
}

// ── The agent at work ───────────────────────────────────────────────────────────────────────────

/** Seconds since `since`, ticking once a second while shown. */
function useSeconds(since: number | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === undefined) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [since]);
  return since === undefined ? null : Math.max(0, Math.floor((now - since) / 1000));
}

/**
 * The agent is working on an answer: its badge, the design system's thinking loop (agent motion,
 * docs/plan.md §1.106: `drafting` for an agent that writes its reply, `tracing` for one that looks
 * things up), its words, and how long it has been once that is more than a few seconds (`since`,
 * a time in ms). A status region: the words are what screen readers hear; the loop is a picture
 * and stops under reduced motion.
 */
export function Thinking({
  badge,
  label,
  state = "drafting",
  since,
  testId,
}: {
  badge?: ReactNode | undefined;
  label: string;
  state?: ThinkingState | undefined;
  since?: number | undefined;
  testId?: string | undefined;
}) {
  const seconds = useSeconds(since);
  return (
    <div className="ui-chat-thinking" role="status" data-testid={testId}>
      {badge}
      <ThinkingLoop state={state} />
      <span>
        {label}
        {seconds !== null && seconds >= 5 ? (
          <span className="ui-chat-thinking__time"> · {seconds} s</span>
        ) : null}
      </span>
    </div>
  );
}

// ── The log and its messages ────────────────────────────────────────────────────────────────────

/**
 * The messages, newest last, kept in view as the conversation grows (`follow` changes when it
 * does: the message count, the words pending). `roomy` is the portal's reading size.
 */
export function ChatLog({
  children,
  follow,
  roomy,
  testId,
}: {
  children: ReactNode;
  follow?: unknown;
  roomy?: boolean | undefined;
  testId?: string | undefined;
}) {
  const end = useRef<HTMLDivElement>(null);
  // jsdom has no scrollIntoView; browsers keep the newest message in view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the conversation grows.
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "end" });
  }, [follow]);
  return (
    <div className={cx("ui-chat", roomy && "ui-chat--roomy")} data-testid={testId}>
      {children}
      <div ref={end} />
    </div>
  );
}

/** Your words, on the right. `above` is a line over them (who and when, or what they were about). */
export function YouSaid({
  text,
  above,
  mono,
  testId,
}: {
  text: string;
  above?: ReactNode | undefined;
  /** A /command. */
  mono?: boolean | undefined;
  testId?: string | undefined;
}) {
  return (
    <div className="ui-chat-you">
      {above ? <span className="ui-chat-meta">{above}</span> : null}
      <p className={cx("ui-chat-you__bubble", mono && "font-mono")} data-testid={testId}>
        {text}
      </p>
    </div>
  );
}

/**
 * An answer, on the left with its badge: an agent's words read as a chat reply (`ChatText`), or a
 * person's as they wrote them (`asWritten`), then whatever the screen adds (changes, cards,
 * sources, what it looked at).
 */
export function AgentSaid({
  badge,
  above,
  text,
  asWritten,
  mono,
  children,
  testId,
  textTestId,
}: {
  badge: ReactNode;
  above?: ReactNode | undefined;
  text?: string | null | undefined;
  asWritten?: boolean | undefined;
  mono?: boolean | undefined;
  children?: ReactNode | undefined;
  testId?: string | undefined;
  textTestId?: string | undefined;
}) {
  return (
    <div className="ui-chat-agent" data-testid={testId}>
      {badge}
      <div className="ui-chat-agent__body">
        {above ? <span className="ui-chat-meta">{above}</span> : null}
        {text ? (
          asWritten || mono ? (
            <p className={cx("ui-chat-written", mono && "font-mono")} data-testid={textTestId}>
              {text}
            </p>
          ) : (
            <ChatText text={text} testId={textTestId} />
          )
        ) : null}
        {children}
      </div>
    </div>
  );
}

/** Your words on their way, and the agent at work on them. */
export function Pending({
  text,
  since,
  badge,
  label,
  state,
  testId,
}: {
  text: string;
  state?: ThinkingState | undefined;
  since?: number | undefined;
  badge: ReactNode;
  label: string;
  testId?: string | undefined;
}) {
  return (
    <>
      <YouSaid text={text} />
      <Thinking badge={badge} label={label} state={state} since={since} testId={testId} />
    </>
  );
}

// ── The composer ────────────────────────────────────────────────────────────────────────────────

export interface ComposerProps {
  /** The box's name for screen readers ("Message to Reggie"). */
  label: string;
  placeholder: string;
  /**
   * Sends the words. The box empties at once; if this resolves false or throws, the words come
   * back (unless something new was written meanwhile). A throw is the caller's to show.
   */
  onSend(text: string): Promise<boolean | undefined> | boolean | undefined;
  /** A send is under way: Send is off and says so. */
  busy?: boolean | undefined;
  disabled?: boolean | undefined;
  /** The words, when the screen holds them (starters, a prefilled question); else the box does. */
  value?: string | undefined;
  onValueChange?(text: string): void;
  maxLength?: number | undefined;
  /** Over the box: starters to pick from. */
  above?: ReactNode | undefined;
  /** Under the words, inside the box: what goes with the message (examples, attachments). */
  extra?: ReactNode | undefined;
  /** Beside Send: shortcuts, attach. */
  tools?: ReactNode | undefined;
  /**
   * §1.109: voice typing. A Dictate button beside Send; what is written out joins the words in
   * the box, to read and change before sending. Left out: no button.
   */
  voice?: Voice | undefined;
  /** The send hint and the buttons' words, in the reader's language. */
  words?: { hint?: string; send?: string; sending?: string };
  /** Sends with nothing written (an attachment on its own). */
  allowEmpty?: boolean | undefined;
  inputRef?: RefObject<HTMLTextAreaElement | null> | undefined;
  testId?: string | undefined;
  inputTestId?: string | undefined;
  sendTestId?: string | undefined;
}

const ENGLISH = {
  hint: "Enter to send, Shift+Enter for a new line",
  send: "Send",
  sending: "Sending…",
};

export function Composer({
  label,
  placeholder,
  onSend,
  busy,
  disabled,
  value,
  onValueChange,
  maxLength = 4000,
  above,
  extra,
  tools,
  voice,
  words,
  allowEmpty,
  inputRef,
  testId,
  inputTestId,
  sendTestId,
}: ComposerProps) {
  const ownRef = useRef<HTMLTextAreaElement | null>(null);
  const box = inputRef ?? ownRef;
  const [own, setOwn] = useState("");
  const text = value ?? own;
  // What the box holds now, for a send that comes back after the screen re-rendered.
  const latest = useRef(text);
  latest.current = text;
  const setText = (next: string) => {
    latest.current = next;
    if (value === undefined) setOwn(next);
    onValueChange?.(next);
  };
  const w = { ...ENGLISH, ...words };
  const empty = !text.trim();
  const off = disabled || busy || (empty && !allowEmpty);

  async function send() {
    if (off) return;
    const words = text.trim();
    setText("");
    let ok: boolean | undefined = true;
    try {
      ok = await onSend(words);
    } catch {
      ok = false;
    }
    if (ok === false && !latest.current) setText(words);
  }

  return (
    <div className="ui-chat-composer" data-testid={testId}>
      {above}
      <div className="ui-chat-composer__box">
        <ChatInput
          ref={box}
          aria-label={label}
          data-testid={inputTestId}
          className="ui-chat-input--bare"
          maxLength={maxLength}
          value={text}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onSend={() => void send()}
        />
        {extra}
        <div className="ui-chat-composer__foot">
          {tools ? <div className="ui-chat-composer__tools">{tools}</div> : null}
          {voice ? (
            <VoiceButton
              voice={voice}
              disabled={disabled}
              testId={testId ? `${testId}-voice` : "composer-voice"}
              onText={(said) => {
                const now = latest.current.trimEnd();
                setText(now ? `${now} ${said}` : said);
                box.current?.focus();
              }}
            />
          ) : null}
          <span className="ui-chat-composer__hint">{w.hint}</span>
          <Button
            variant="primary"
            size="sm"
            data-testid={sendTestId}
            disabled={off}
            onClick={() => void send()}
          >
            {busy ? w.sending : w.send}
          </Button>
        </div>
      </div>
    </div>
  );
}
