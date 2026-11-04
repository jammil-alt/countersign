// A client's contacts and their consent (plan §1.22), on the back office's messaging page and the
// portal's /contacts (client admin). The same rules on both: numbers in international form,
// consent per channel with how it was given, an opt-out that stops every channel. A STOP text is
// lifted only by the contact texting START, so its opt-out has no "lift" button here. Reach out
// (plan §1.25) adds email, preferred channels in order, the contact's own timezone and quiet hours,
// roles and notes; the operator and the client admin both edit them, and every edit is logged.
// Portal strings are plain English for now; the languages stream moves them to t().
import {
  CONSENT_SOURCE_MAX,
  CONTACT_NAME_MAX,
  CONTACT_NOTES_MAX,
  type ConsentChannel,
  type Contact,
  type ContactConsentChangeInput,
  type ContactCreateInput,
  type ContactPatchInput,
  REACH_CHANNELS,
  type ReachChannel,
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

const CHANNEL_LABEL: Record<ReachChannel, string> = {
  sms: "Texts",
  whatsapp: "WhatsApp",
  voice: "Calls",
  email: "Email",
};
/** What can be agreed to: texts, WhatsApp, calls from an automated assistant, and email. */
type ConsentChoice = ConsentChannel;

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
    update: (id: string, body: ContactPatchInput) =>
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
              No contacts yet. Add the people your agents may reach, with how they agreed to it.
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
      {contact.email ? (
        <Badge
          tone={contact.canEmail ? "positive" : "neutral"}
          testId={`contact-${contact.id}-email`}
        >
          Email: {contact.canEmail ? "agreed" : "not agreed"}
        </Badge>
      ) : null}
    </>
  );
}

/** The contact's details: addresses, how and when they like to be reached, roles and notes. */
function ContactDetails({
  contact,
  api,
  onChanged,
}: {
  contact: Contact;
  api: ReturnType<typeof useContactsApi>;
  onChanged: () => void;
}) {
  const [email, setEmail] = useState(contact.email ?? "");
  const [phone, setPhone] = useState(contact.phone ?? "");
  const [whatsapp, setWhatsapp] = useState(contact.whatsapp ?? "");
  const [language, setLanguage] = useState(contact.language ?? "");
  const [preferred, setPreferred] = useState<ReachChannel[]>(contact.preferredChannels ?? []);
  const [timezone, setTimezone] = useState(contact.timezone ?? "");
  const [quietStart, setQuietStart] = useState(contact.quietHours?.start ?? "");
  const [quietEnd, setQuietEnd] = useState(contact.quietHours?.end ?? "");
  const [roles, setRoles] = useState((contact.roles ?? []).join(", "));
  const [notes, setNotes] = useState(contact.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function setRank(index: number, value: string) {
    const next = preferred.filter((_, i) => i < index);
    if (value) next.push(value as ReachChannel);
    setPreferred([...new Set(next)]);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    const quiet =
      quietStart && quietEnd
        ? { start: quietStart, end: quietEnd }
        : quietStart || quietEnd
          ? undefined
          : null;
    if (quiet === undefined) {
      setError("Give both times for quiet hours, or neither.");
      setBusy(false);
      return;
    }
    try {
      await api.update(contact.id, {
        email: email.trim() || null,
        phone: phone.trim() || null,
        whatsapp: whatsapp.trim() || null,
        language: language || null,
        preferredChannels: preferred,
        timezone: timezone.trim() || null,
        quietHours: quiet,
        roles: roles
          .split(",")
          .map((r) => r.trim().toLowerCase())
          .filter(Boolean),
        notes: notes.trim() || null,
      });
      setSaved(true);
      onChanged();
    } catch (err) {
      setError(errorText(err, "That didn't save. Try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => void save(e)}
      data-testid={`contact-${contact.id}-details`}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Email">
          <TextInput
            value={email}
            type="email"
            onChange={(e) => setEmail(e.target.value)}
            data-testid={`contact-${contact.id}-email-input`}
          />
        </Field>
        <Field label="Phone">
          <TextInput value={phone} inputMode="tel" onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <Field label="WhatsApp number">
          <TextInput
            value={whatsapp}
            inputMode="tel"
            onChange={(e) => setWhatsapp(e.target.value)}
          />
        </Field>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Field key={i} label={i === 0 ? "Reach them first by" : "Then"}>
            <Select
              value={preferred[i] ?? ""}
              disabled={i > preferred.length}
              onChange={(e) => setRank(i, e.target.value)}
              data-testid={`contact-${contact.id}-preferred-${i}`}
            >
              <option value="">{i === 0 ? "No preference" : "Nothing else"}</option>
              {REACH_CHANNELS.filter((ch) => !preferred.slice(0, i).includes(ch)).map((ch) => (
                <option key={ch} value={ch}>
                  {CHANNEL_LABEL[ch]}
                </option>
              ))}
            </Select>
          </Field>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <Field label="Language">
          <Select value={language} onChange={(e) => setLanguage(e.target.value)}>
            <option value="">Your language</option>
            <option value="en">English</option>
            <option value="es">Spanish</option>
            <option value="fr">French</option>
            <option value="pt-BR">Portuguese (Brazil)</option>
            <option value="it">Italian</option>
            <option value="de">German</option>
          </Select>
        </Field>
        <Field label="Timezone" hint="Empty: yours.">
          <TextInput
            value={timezone}
            placeholder="America/Chicago"
            onChange={(e) => setTimezone(e.target.value)}
            data-testid={`contact-${contact.id}-timezone`}
          />
        </Field>
        <Field label="Quiet from" hint="Empty: yours.">
          <TextInput
            value={quietStart}
            placeholder="21:00"
            onChange={(e) => setQuietStart(e.target.value)}
          />
        </Field>
        <Field label="Quiet until">
          <TextInput
            value={quietEnd}
            placeholder="08:00"
            onChange={(e) => setQuietEnd(e.target.value)}
          />
        </Field>
      </div>
      <Field label="Roles" hint="Comma-separated, e.g. purchaser, owner.">
        <TextInput
          value={roles}
          onChange={(e) => setRoles(e.target.value)}
          data-testid={`contact-${contact.id}-roles`}
        />
      </Field>
      <Field label="Notes">
        <TextInput
          value={notes}
          maxLength={CONTACT_NOTES_MAX}
          onChange={(e) => setNotes(e.target.value)}
        />
      </Field>
      {error ? (
        <p role="alert" className="ds-error text-sm">
          {error}
        </p>
      ) : null}
      <div className="flex items-center gap-3">
        <Button
          type="submit"
          size="sm"
          variant="primary"
          disabled={busy}
          data-testid={`contact-${contact.id}-save`}
        >
          Save details
        </Button>
        {saved ? <span className="text-sm text-ink-muted">Saved.</span> : null}
      </div>
    </form>
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
              contact.email,
            ]
              .filter(Boolean)
              .join(" · ")}
            {contact.language ? ` · ${contact.language}` : ""}
          </div>
          {contact.roles?.length ? (
            <div className="mt-1 flex flex-wrap gap-1">
              {contact.roles.map((r) => (
                <Badge key={r} testId={`contact-${contact.id}-role-${r}`}>
                  {r}
                </Badge>
              ))}
            </div>
          ) : null}
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
          <ContactDetails contact={contact} api={api} onChanged={onChanged} />
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
                    <option value="email">Email</option>
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
            · {m.channel === "voice" ? "Call" : CHANNEL_LABEL[m.channel]}
            {m.reachOut ? " · reach-out" : ""} · {new Date(m.at).toLocaleString()}
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
  const [email, setEmail] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready =
    name.trim() && (phone.trim() || whatsapp.trim() || email.trim()) && (!agreed || source.trim());

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    const channels: ConsentChannel[] = [
      ...(phone.trim() ? (["sms"] as const) : []),
      ...(whatsapp.trim() ? (["whatsapp"] as const) : []),
      ...(email.trim() ? (["email"] as const) : []),
    ];
    try {
      await api.create({
        name: name.trim(),
        ...(phone.trim() ? { phone: phone.trim() } : {}),
        ...(whatsapp.trim() ? { whatsapp: whatsapp.trim() } : {}),
        ...(email.trim() ? { email: email.trim() } : {}),
        ...(agreed ? { consent: { channels, source: source.trim() } } : {}),
      });
      setName("");
      setPhone("");
      setWhatsapp("");
      setEmail("");
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
        <Field label="Email">
          <TextInput
            value={email}
            type="email"
            onChange={(e) => setEmail(e.target.value)}
            data-testid="contact-add-email"
          />
        </Field>
        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
            data-testid="contact-add-agreed"
          />
          They agreed to hear from you on these numbers and this address
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
