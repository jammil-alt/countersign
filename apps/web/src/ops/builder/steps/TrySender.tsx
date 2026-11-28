// Try it's message parts (owner, 2026-11-27). Who a made-up message is from ("From"): one of the
// Sandbox's people, those the trigger takes first, or someone typed in by email address or phone
// number, added to the Sandbox's people as the trigger takes them (`opsSandboxSender`). And Run
// it live in the Sandbox: the same message (sender, subject, words, the same Sandbox files) sent
// to the template's own agent in the Sandbox (or to the Sandbox agent itself) as a received one,
// through `opsSandboxTestMessage`, which starts a live run, every write signed in its trial.
// DECISION: the live run goes to the template's copy in the Sandbox that is on (`opsUsedBy`: the
// Sandbox's, not its test copy, with a live version and running), and it runs that copy's live
// version, never the draft in the builder; a copy behind the template's published version is
// still run, and Turn on in the Sandbox is offered to bring it up to date.
import type { PeopleFilter, TestMessageAnswer, TestMessageChannel } from "@countersign/core";
import { useId, useState } from "react";
import type { ResponseOf } from "../../../api/client";
import { apiRoutes } from "../../../api/routes";
import { useApi, useApiClient } from "../../../api/useApi";
import { ErrorNotice } from "../../../ui/ErrorState";
import { Select, TextInput } from "../../../ui/forms";
import { TurnOnInSandbox } from "../../lab/TemplateParts";
import { TestMessageResult } from "../../triggers/SandboxInbound";
import type { Workflow } from "./types";

type Person = ResponseOf<typeof apiRoutes.opsContacts>["items"][number];

/** What a message trigger takes: the channels a test message can come by, and from whom. */
export interface MessageOn {
  channels: TestMessageChannel[];
  from: PeopleFilter;
}

const CHANNELS: readonly TestMessageChannel[] = ["email", "sms", "whatsapp"];

/** The workflow's first trigger, when it is a message trigger. */
export function messageOn(workflow: Workflow): MessageOn | null {
  const on = workflow.triggers[0]?.on as
    | { type?: string; channels?: unknown; from?: PeopleFilter }
    | undefined;
  if (on?.type !== "message") return null;
  const channels = Array.isArray(on.channels)
    ? CHANNELS.filter((c) => (on.channels as unknown[]).includes(c))
    : [];
  return { channels, from: on.from ?? {} };
}

/** Whether the trigger takes this person: one of its people, relationships or labels. */
export function takesPerson(
  filter: PeopleFilter | null,
  p: Pick<Person, "id" | "relationship" | "roles">,
): boolean {
  if (!filter) return false;
  if ((filter.contactIds ?? []).includes(p.id)) return true;
  if (p.relationship && (filter.relationships ?? []).includes(p.relationship)) return true;
  const tags = new Set((p.roles ?? []).map((t) => t.trim().toLowerCase()));
  return (filter.tags ?? []).some((t) => tags.has(t.trim().toLowerCase()));
}

/**
 * What a message from them comes in by: their email where the trigger takes email, else a text
 * to their phone where it takes texts, else WhatsApp; failing all, what they have.
 */
// DECISION: email first, as a made-up message is an email with attachments; a phone sender (one
// with no email, or a number typed in) sends a text when the trigger takes texts.
export function senderChannel(
  p: {
    email?: string | null | undefined;
    phone?: string | null | undefined;
    whatsapp?: string | null | undefined;
  },
  channels: readonly TestMessageChannel[],
): TestMessageChannel {
  if (p.email && channels.includes("email")) return "email";
  if (p.phone && channels.includes("sms")) return "sms";
  if ((p.whatsapp ?? p.phone) && channels.includes("whatsapp")) return "whatsapp";
  return p.email ? "email" : p.phone ? "sms" : "whatsapp";
}

/** Someone the message is from, and what it comes in by. */
export interface Sender {
  contactId: string;
  channel: TestMessageChannel;
}

const OTHER = "other";

/** The From control's state: the Sandbox's people, the pick, and someone typed in. */
export function useTrySender(input: {
  sandbox: string | null;
  on: MessageOn | null;
  enabled: boolean;
}) {
  const api = useApiClient();
  const contacts = useApi(
    apiRoutes.opsContacts,
    input.enabled && input.sandbox ? { params: { id: input.sandbox } } : null,
  );
  const [chosen, setChosen] = useState("");
  const [typed, setTyped] = useState("");
  const filter = input.on?.from ?? null;
  const channels = input.on?.channels.length ? input.on.channels : (["email"] as const);
  const people = contacts.data?.items ?? [];
  const taken = people.filter((p) => takesPerson(filter, p));
  const others = people.filter((p) => !takesPerson(filter, p));
  const pick = chosen || taken[0]?.id || others[0]?.id || OTHER;

  /**
   * The sender picked, someone typed in added to the Sandbox's people first; null when "Someone
   * else" is left empty (the model picks one of the people the trigger takes).
   */
  async function resolve(): Promise<Sender | null> {
    if (pick !== OTHER) {
      const p = people.find((x) => x.id === pick);
      return p ? { contactId: p.id, channel: senderChannel(p, channels) } : null;
    }
    const address = typed.trim();
    if (!address || !input.sandbox) return null;
    const relationship = filter?.relationships?.[0];
    const out = await api.call(apiRoutes.opsSandboxSender, {
      body: {
        clientId: input.sandbox,
        address,
        ...(relationship ? { relationship } : {}),
        ...(filter?.tags?.length ? { tags: filter.tags } : {}),
      },
    });
    setChosen(out.contactId);
    setTyped("");
    contacts.reload();
    // What was typed says the channel: a number sends a text, even to someone with an email.
    const email = address.includes("@");
    return {
      contactId: out.contactId,
      channel: senderChannel(
        email ? { email: address } : { phone: address, whatsapp: address },
        channels,
      ),
    };
  }

  return { pick, setPick: setChosen, typed, setTyped, taken, others, filter, resolve };
}

export type TrySender = ReturnType<typeof useTrySender>;

const article = (w: string) => (/^[aeiou]/i.test(w) ? `an ${w}` : `a ${w}`);

function personLine(p: Person): string {
  const at = p.email ?? p.phone ?? p.whatsapp;
  return at ? `${p.name} · ${at}` : p.name;
}

/** Try it's From: who the made-up message is from. */
export function FromField({ sender, disabled }: { sender: TrySender; disabled: boolean }) {
  const id = useId();
  const typedId = useId();
  const relationship = sender.filter?.relationships?.[0];
  return (
    <div className="flex flex-col gap-1 text-xs text-ink-muted">
      <label htmlFor={id}>From</label>
      <Select
        id={id}
        data-testid="steps-try-sender"
        value={sender.pick}
        disabled={disabled}
        onChange={(e) => sender.setPick(e.target.value)}
      >
        {sender.taken.length > 0 ? (
          <optgroup label="Who it takes">
            {sender.taken.map((p) => (
              <option key={p.id} value={p.id}>
                {personLine(p)}
              </option>
            ))}
          </optgroup>
        ) : null}
        {sender.others.length > 0 ? (
          <optgroup label={sender.taken.length > 0 ? "Others in the Sandbox" : "In the Sandbox"}>
            {sender.others.map((p) => (
              <option key={p.id} value={p.id}>
                {personLine(p)}
              </option>
            ))}
          </optgroup>
        ) : null}
        <option value={OTHER}>Someone else</option>
      </Select>
      {sender.pick === OTHER ? (
        <>
          <label htmlFor={typedId}>Their email address or phone number</label>
          <TextInput
            id={typedId}
            data-testid="steps-try-sender-address"
            maxLength={200}
            placeholder="sam@example.com or +1 555 010 4477"
            disabled={disabled}
            value={sender.typed}
            onChange={(e) => sender.setTyped(e.target.value)}
          />
          <span>
            We add them to the Sandbox's people
            {relationship ? ` as ${article(relationship)}` : ""}, so the trigger takes them. A phone
            number sends a text. Left empty, we pick one of the people it takes.
          </span>
        </>
      ) : null}
    </div>
  );
}

/** The message Try it has: what a live run is sent. */
export interface LiveMessage {
  subject: string | null;
  text: string;
  documentIds: string[];
  /** Who it was made up from; null: the From picked. */
  contactId: string | null;
  channel: TestMessageChannel | null;
}

/** Run it live in the Sandbox: where it goes, and sending it. */
export function useLiveRun(input: {
  agent: { id: string; kind: "template" | "client" };
  sandbox: string | null;
  message: LiveMessage | null;
  resolve(): Promise<Sender | null>;
  enabled: boolean;
}) {
  const api = useApiClient();
  const template = input.agent.kind === "template";
  const usedBy = useApi(
    apiRoutes.opsUsedBy,
    input.enabled && template ? { params: { id: input.agent.id } } : null,
  );
  const copy = template
    ? (usedBy.data?.agents.find(
        (a) =>
          a.client.id === input.sandbox &&
          !a.agent.testCopy &&
          a.agent.runStatus === "active" &&
          !!a.agent.liveVersionId,
      ) ?? null)
    : null;
  // A Sandbox agent is its own target: the API says why when it isn't on.
  const target = template ? (copy?.agent.id ?? null) : input.agent.id;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [answer, setAnswer] = useState<TestMessageAnswer | null>(null);

  async function run() {
    const m = input.message;
    if (!target || !m) return;
    setBusy(true);
    setError(null);
    setAnswer(null);
    try {
      const who: Sender | null =
        m.contactId && m.channel
          ? { contactId: m.contactId, channel: m.channel }
          : await input.resolve();
      if (!who) throw new Error("Say who the message is from first.");
      const res = await api.call(apiRoutes.opsSandboxTestMessage, {
        body: {
          agentId: target,
          channel: who.channel,
          fromContactId: who.contactId,
          ...(who.channel === "email" && m.subject?.trim()
            ? { subject: m.subject.trim().slice(0, 300) }
            : {}),
          text: m.text.slice(0, 20_000),
          ...(m.documentIds.length > 0 ? { documentIds: m.documentIds } : {}),
        },
      });
      setAnswer(res);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return {
    template,
    loading: template && !usedBy.data && !usedBy.error,
    usedByError: usedBy.error,
    reload: usedBy.reload,
    copy,
    templateVersion: usedBy.data?.templateLiveVersion ?? null,
    target,
    run,
    busy,
    error,
    answer,
  };
}

export type LiveRun = ReturnType<typeof useLiveRun>;

/** What Run it live does, where it goes, and what it did. */
export function LiveRunNotes({ live, templateId }: { live: LiveRun; templateId: string }) {
  const copy = live.copy;
  const name = copy ? (copy.agent.serviceName ?? copy.agent.name) : "The agent";
  return (
    <section
      className="flex flex-col gap-2 border border-line p-3"
      data-testid="steps-try-live"
      aria-label="Run it live in the Sandbox"
    >
      <span className="text-sm font-medium text-ink">Run it live in the Sandbox</span>
      <p className="text-xs text-ink-muted">
        Sends this message in as a received one, to the version that is on in the Sandbox, not this
        draft. That run is live: it writes and sends, each write waiting for a signature in its
        trial.
      </p>
      {live.template && live.loading ? (
        <p className="text-xs text-ink-muted">Looking for it in the Sandbox…</p>
      ) : null}
      {live.usedByError ? <ErrorNotice error={live.usedByError} onRetry={live.reload} /> : null}
      {live.template && !live.loading && !live.usedByError && !copy ? (
        <div className="flex flex-wrap items-center gap-2" data-testid="steps-try-live-off">
          <p className="text-xs text-ink">This template isn't on in the Sandbox yet.</p>
          <TurnOnInSandbox templateId={templateId} onStarted={live.reload} />
        </div>
      ) : null}
      {copy && copy.behind > 0 ? (
        <div className="flex flex-wrap items-center gap-2" data-testid="steps-try-live-behind">
          <p className="text-xs text-ink">
            The Sandbox runs v{copy.baseVersion}, {copy.behind} behind the template's v
            {live.templateVersion}.
          </p>
          <TurnOnInSandbox templateId={templateId} onStarted={live.reload} />
        </div>
      ) : null}
      {live.error ? <ErrorNotice error={live.error} /> : null}
      {live.answer ? <TestMessageResult answer={live.answer} name={name} /> : null}
    </section>
  );
}
