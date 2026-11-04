// A client's contacts and their consent (plan §1.22), on the back office's messaging page and the
// portal's /contacts (client admin). The same rules on both: numbers in international form,
// consent per channel with how it was given, an opt-out that stops every channel. A STOP text is
// lifted only by the contact texting START, so its opt-out has no "lift" button here.
// Portal strings are plain English for now; the languages stream moves them to t().
import {
  CONSENT_SOURCE_MAX,
  CONTACT_NAME_MAX,
  type Contact,
  type ContactConsentChangeInput,
  type ContactCreateInput,
  type MessagingChannel,
} from "@countersign/core";
import { type FormEvent, useState } from "react";
import { isApiError } from "../api/client";
import { apiRoutes } from "../api/routes";
import { useApi, useApiClient } from "../api/useApi";
import { Field, Select, TextInput } from "../ui/forms";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Loading,
  SectionLabel,
} from "../ui/primitives";

export type ContactsSurface = { kind: "ops"; clientId: string } | { kind: "portal" };

const CHANNEL_LABEL: Record<MessagingChannel | "voice", string> = {
  sms: "Texts",
  whatsapp: "WhatsApp",
  voice: "Calls",
};
/** What can be agreed to: texts, WhatsApp, and calls from an automated assistant. */
type ConsentChoice = MessagingChannel | "voice";

function errorText(error: unknown, fallback: string): string {
  return isApiError(error) ? error.message : fallback;
}

function when(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** The routes for one surface, so the rest of the panel doesn't care which it is on. */
function useContactsApi(surface: ContactsSurface) {
  const api = useApiClient();
  const ops = surface.kind === "ops" ? surface.clientId : null;
  const opsList = useApi(apiRoutes.opsContacts, ops ? { params: { id: ops } } : null);
  const portalList = useApi(apiRoutes.portalContacts, ops ? null : {});
  const list = ops ? opsList : portalList;
  return {
    list,
    create: (body: ContactCreateInput) =>
      ops
        ? api.call(apiRoutes.opsCreateContact, { params: { id: ops }, body })
        : api.call(apiRoutes.portalCreateContact, { body }),
    consent: (id: string, body: ContactConsentChangeInput) =>
      ops
        ? api.call(apiRoutes.opsContactConsent, { params: { id: ops, contactId: id }, body })
        : api.call(apiRoutes.portalContactConsent, { params: { id }, body }),
    update: (id: string, body: { phone?: string | null; whatsapp?: string | null }) =>
      ops
        ? api.call(apiRoutes.opsUpdateContact, { params: { id: ops, contactId: id }, body })
        : api.call(apiRoutes.portalUpdateContact, { params: { id }, body }),
    ops,
  };
}

export function ContactsPanel({ surface }: { surface: ContactsSurface }) {
  const c = useContactsApi(surface);
  const { data, error, loading, reload } = c.list;
  const [open, setOpen] = useState<string | null>(null);

  return (
    <section data-testid="contacts-panel">
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="order-2 xl:order-1">
          <SectionLabel>Contacts</SectionLabel>
          {loading && !data ? <Loading /> : null}
          {error ? <ErrorNotice error={error} onRetry={reload} /> : null}
          {data && data.items.length === 0 ? (
            <EmptyState>
              No contacts yet. Add the people we may text, with how they agreed to it.
            </EmptyState>
          ) : null}
          <ul data-testid="contacts-list" className="flex flex-col gap-3">
            {data?.items.map((contact) => (
              <li key={contact.id}>
                <ContactCard
                  contact={contact}
                  api={c}
                  open={open === contact.id}
                  onToggle={() => setOpen(open === contact.id ? null : contact.id)}
                  onChanged={reload}
                />
              </li>
            ))}
          </ul>
        </div>
        <div className="order-1 xl:order-2">
          <AddContact api={c} onAdded={reload} />
        </div>
      </div>
    </section>
  );
}

function ConsentPills({ contact }: { contact: Contact }) {
  if (contact.optedOut) {
    return (
      <Badge testId={`contact-${contact.id}-opted-out`}>
        Opted out {contact.optedOut.source === "keyword:STOP" ? "by text" : ""}
      </Badge>
    );
  }
  return (
    <>
      {(["sms", "whatsapp"] as const)
        .filter((ch) => (ch === "sms" ? contact.phone : contact.whatsapp))
        .map((ch) => (
          <Badge
            key={ch}
            tone={contact.canMessage[ch] ? "positive" : "neutral"}
            testId={`contact-${contact.id}-${ch}`}
          >
            {CHANNEL_LABEL[ch]}: {contact.canMessage[ch] ? "agreed" : "not agreed"}
          </Badge>
        ))}
      {contact.phone ? (
        <Badge
          tone={contact.canCall ? "positive" : "neutral"}
          testId={`contact-${contact.id}-voice`}
        >
          Calls: {contact.canCall ? "agreed" : "not agreed"}
        </Badge>
      ) : null}
    </>
  );
}

function ContactCard({
  contact,
  api,
  open,
  onToggle,
  onChanged,
}: {
  contact: Contact;
  api: ReturnType<typeof useContactsApi>;
  open: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [channel, setChannel] = useState<ConsentChoice>(contact.phone ? "sms" : "whatsapp");
  const [source, setSource] = useState("");

  async function change(body: ContactConsentChangeInput) {
    setBusy(true);
    setError(null);
    try {
      await api.consent(contact.id, body);
      setSource("");
      onChanged();
    } catch (e) {
      setError(errorText(e, "That didn't save. Try again."));
    } finally {
      setBusy(false);
    }
  }

  const keywordOptOut = contact.optedOut?.source === "keyword:STOP";
  return (
    <Card className="p-4" testId={`contact-${contact.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium text-ink">{contact.name}</div>
          <div className="mt-0.5 text-sm text-ink-muted figures">
            {[
              contact.phone,
              contact.whatsapp && contact.whatsapp !== contact.phone
                ? `WhatsApp ${contact.whatsapp}`
                : null,
            ]
              .filter(Boolean)
              .join(" · ")}
            {contact.language ? ` · ${contact.language}` : ""}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <ConsentPills contact={contact} />
          <Button
            size="sm"
            variant="ghost"
            onClick={onToggle}
            data-testid={`contact-${contact.id}-open`}
          >
            {open ? "Close" : "Manage"}
          </Button>
        </div>
      </div>
      {open ? (
        <div className="mt-4 flex flex-col gap-4 border-t border-line pt-4">
          {contact.optedOut ? (
            <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
              <span className="text-ink-muted">
                {keywordOptOut
                  ? `Texted STOP on ${when(contact.optedOut.at)}. Only they can opt back in, by texting START.`
                  : `Opted out on ${when(contact.optedOut.at)}. Nothing is sent to them.`}
              </span>
              {keywordOptOut ? null : (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => void change({ action: "lift_opt_out" })}
                  data-testid={`contact-${contact.id}-lift`}
                >
                  Lift the opt-out
                </Button>
              )}
            </div>
          ) : (
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (source.trim()) void change({ action: "grant", channel, source: source.trim() });
              }}
            >
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[160px_minmax(0,1fr)]">
                <Field label="Channel">
                  <Select
                    value={channel}
                    onChange={(e) => setChannel(e.target.value as ConsentChoice)}
                    data-testid={`contact-${contact.id}-channel`}
                  >
                    <option value="sms">Texts</option>
                    <option value="whatsapp">WhatsApp</option>
                    <option value="voice">Calls from an automated assistant</option>
                  </Select>
                </Field>
                <Field label="How they agreed" hint="For example: signed the service agreement.">
                  <TextInput
                    value={source}
                    maxLength={CONSENT_SOURCE_MAX}
                    onChange={(e) => setSource(e.target.value)}
                    data-testid={`contact-${contact.id}-source`}
                  />
                </Field>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  disabled={busy || !source.trim()}
                  data-testid={`contact-${contact.id}-grant`}
                >
                  Record consent
                </Button>
                {contact.consent[channel] ? (
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => void change({ action: "withdraw", channel })}
                  >
                    Withdraw consent
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => void change({ action: "opt_out" })}
                  data-testid={`contact-${contact.id}-opt-out`}
                >
                  Opt out of everything
                </Button>
              </div>
            </form>
          )}
          {error ? (
            <p role="alert" className="ds-error text-sm">
              {error}
            </p>
          ) : null}
          <ContactMessages api={api} contactId={contact.id} />
        </div>
      ) : null}
    </Card>
  );
}

function ContactMessages({
  api,
  contactId,
}: {
  api: ReturnType<typeof useContactsApi>;
  contactId: string;
}) {
  const opsMessages = useApi(
    apiRoutes.opsContactMessages,
    api.ops ? { params: { id: api.ops, contactId } } : null,
  );
  const portalMessages = useApi(
    apiRoutes.portalContactMessages,
    api.ops ? null : { params: { id: contactId } },
  );
  const { data, error, loading } = api.ops ? opsMessages : portalMessages;
  if (loading && !data) return <Loading label="Loading messages…" />;
  if (error) return <ErrorNotice error={error} />;
  if (!data || data.items.length === 0) {
    return <p className="text-sm text-ink-muted">No messages yet.</p>;
  }
  return (
    <ol data-testid={`contact-${contactId}-messages`} className="flex flex-col gap-2">
      {data.items.slice(0, 20).map((m) => (
        <li key={m.id} className="text-sm">
          <span className="eyebrow text-ink-muted">
            {m.channel === "voice"
              ? m.direction === "in"
                ? "They called"
                : "We called"
              : m.direction === "in"
                ? "They wrote"
                : "We sent"}{" "}
            · {m.channel === "voice" ? "Call" : CHANNEL_LABEL[m.channel]} ·{" "}
            {new Date(m.at).toLocaleString()}
            {m.status ? ` · ${m.status}` : ""}
          </span>
          {/* The sender's words, shown as text, never as markup. */}
          <p className="mt-0.5 whitespace-pre-wrap text-ink">{m.text}</p>
        </li>
      ))}
    </ol>
  );
}

function AddContact({
  api,
  onAdded,
}: {
  api: ReturnType<typeof useContactsApi>;
  onAdded: () => void;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [whatsapp, setWhatsapp] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = name.trim() && (phone.trim() || whatsapp.trim()) && (!agreed || source.trim());

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    const channels: MessagingChannel[] = [
      ...(phone.trim() ? (["sms"] as const) : []),
      ...(whatsapp.trim() ? (["whatsapp"] as const) : []),
    ];
    try {
      await api.create({
        name: name.trim(),
        ...(phone.trim() ? { phone: phone.trim() } : {}),
        ...(whatsapp.trim() ? { whatsapp: whatsapp.trim() } : {}),
        ...(agreed ? { consent: { channels, source: source.trim() } } : {}),
      });
      setName("");
      setPhone("");
      setWhatsapp("");
      setAgreed(false);
      setSource("");
      onAdded();
    } catch (err) {
      setError(errorText(err, "We couldn't add them. Try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-5" testId="contact-add">
      <SectionLabel>Add a contact</SectionLabel>
      <form className="flex flex-col gap-4" onSubmit={(e) => void add(e)}>
        <Field label="Name">
          <TextInput
            value={name}
            maxLength={CONTACT_NAME_MAX}
            onChange={(e) => setName(e.target.value)}
            data-testid="contact-add-name"
          />
        </Field>
        <Field label="Phone" hint="With the country code, e.g. +1 555 555 0100.">
          <TextInput
            value={phone}
            inputMode="tel"
            onChange={(e) => setPhone(e.target.value)}
            data-testid="contact-add-phone"
          />
        </Field>
        <Field label="WhatsApp number" hint="Leave empty if they don't use WhatsApp.">
          <TextInput
            value={whatsapp}
            inputMode="tel"
            onChange={(e) => setWhatsapp(e.target.value)}
            data-testid="contact-add-whatsapp"
          />
        </Field>
        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
            data-testid="contact-add-agreed"
          />
          They agreed to hear from you on these numbers
        </label>
        {agreed ? (
          <Field label="How they agreed">
            <TextInput
              value={source}
              maxLength={CONSENT_SOURCE_MAX}
              onChange={(e) => setSource(e.target.value)}
              data-testid="contact-add-source"
            />
          </Field>
        ) : null}
        {error ? (
          <p role="alert" className="ds-error text-sm">
            {error}
          </p>
        ) : null}
        <div>
          <Button
            type="submit"
            variant="primary"
            disabled={busy || !ready}
            data-testid="contact-add-save"
          >
            Add contact
          </Button>
        </div>
      </form>
    </Card>
  );
}
