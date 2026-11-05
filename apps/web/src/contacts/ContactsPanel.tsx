// A client's contacts and their consent (plan §1.22), on the back office's messaging page and the
// portal's /contacts (client admin). The same rules on both: numbers in international form,
// consent per channel with how it was given, an opt-out that stops every channel. A STOP text is
// lifted only by the contact texting START, so its opt-out has no "lift" button here. Reach out
// (plan §1.25) adds email, preferred channels in order, the contact's own timezone and quiet hours,
// roles and notes; the operator and the client admin both edit them, and every edit is logged.
// Words in the reader's language (docs/plan.md §1.18; English in the back office). What contacts
// wrote, call transcripts and email text are untrusted data: shown as text, never translated.
import {
  CONSENT_SOURCE_MAX,
  CONTACT_NAME_MAX,
  CONTACT_NOTES_MAX,
  type ConsentChannel,
  type Contact,
  type ContactConsentChangeInput,
  type ContactCreateInput,
  type ContactPatchInput,
  LOCALE_NAMES,
  LOCALES,
  type Locale,
  REACH_CHANNELS,
  type ReachChannel,
} from "@countersign/core";
import { type FormEvent, useState } from "react";
import { isApiError } from "../api/client";
import { apiRoutes } from "../api/routes";
import { useApi, useApiClient } from "../api/useApi";
import type { PlainKey } from "../i18n/catalog";
import { errorText as apiErrorText } from "../i18n/errors";
import { type I18n, useI18n } from "../i18n/i18n";
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

const CHANNEL_KEY: Record<ReachChannel, PlainKey> = {
  sms: "contacts.channel.sms",
  whatsapp: "contacts.channel.whatsapp",
  voice: "contacts.channel.voice",
  email: "contacts.channel.email",
};

/** Delivery and call statuses we have words for; any other shows as the carrier wrote it. */
const STATUS_KEY: Record<string, PlainKey> = {
  queued: "contacts.status.queued",
  sent: "contacts.status.sent",
  delivered: "contacts.status.delivered",
  undelivered: "contacts.status.undelivered",
  failed: "contacts.status.failed",
  read: "contacts.status.read",
  received: "contacts.status.received",
  replied: "contacts.status.replied",
  not_sent: "contacts.status.not_sent",
  no_reply: "contacts.status.no_reply",
  completed: "contacts.status.completed",
  busy: "contacts.status.busy",
  "no-answer": "contacts.status.no-answer",
};

/** What can be agreed to: texts, WhatsApp, calls from an automated assistant, and email. */
type ConsentChoice = ConsentChannel;

function problemText(error: unknown, fallback: PlainKey, i18n: I18n): string {
  return isApiError(error) ? apiErrorText(error, i18n) : i18n.t(fallback);
}

/** A language by its name in the reader's language: "Spanish", "Spanisch", "Portuguese (Brazil)". */
function languageName(code: string, i18n: I18n): string {
  try {
    const names = new Intl.DisplayNames([i18n.intl], {
      type: "language",
      languageDisplay: "standard",
    });
    return names.of(code) ?? code;
  } catch {
    return LOCALE_NAMES[code as Locale] ?? code;
  }
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
  const { t } = useI18n();
  const c = useContactsApi(surface);
  const { data, error, loading, reload } = c.list;
  const [open, setOpen] = useState<string | null>(null);

  return (
    <section data-testid="contacts-panel">
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="order-2 xl:order-1">
          <SectionLabel>{t("contacts.title")}</SectionLabel>
          {loading && !data ? <Loading /> : null}
          {error ? <ErrorNotice error={error} onRetry={reload} /> : null}
          {data && data.items.length === 0 ? <EmptyState>{t("contacts.empty")}</EmptyState> : null}
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
  const { t } = useI18n();
  if (contact.optedOut) {
    return (
      <Badge testId={`contact-${contact.id}-opted-out`}>
        {contact.optedOut.source === "keyword:STOP"
          ? t("contacts.optedOutByText")
          : t("contacts.optedOut")}
      </Badge>
    );
  }
  const pill = (channel: ReachChannel, agreed: boolean | undefined) =>
    agreed
      ? t("contacts.agreed", { channel: t(CHANNEL_KEY[channel]) })
      : t("contacts.notAgreed", { channel: t(CHANNEL_KEY[channel]) });
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
            {pill(ch, contact.canMessage[ch])}
          </Badge>
        ))}
      {contact.phone ? (
        <Badge
          tone={contact.canCall ? "positive" : "neutral"}
          testId={`contact-${contact.id}-voice`}
        >
          {pill("voice", contact.canCall)}
        </Badge>
      ) : null}
      {contact.email ? (
        <Badge
          tone={contact.canEmail ? "positive" : "neutral"}
          testId={`contact-${contact.id}-email`}
        >
          {pill("email", contact.canEmail)}
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
  const i18n = useI18n();
  const { t } = i18n;
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
      setError(t("contacts.problem.quietHours"));
      setBusy(false);
      return;
    }
    try {
      await api.update(contact.id, {
        email: email.trim() || null,
        phone: phone.trim() || null,
        whatsapp: whatsapp.trim() || null,
        // Sent only when changed: a language saved before the six were enforced stays as it is.
        ...(language === (contact.language ?? "")
          ? {}
          : { language: (language || null) as Locale | null }),
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
      setError(problemText(err, "contacts.problem.notSaved", i18n));
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
        <Field label={t("contacts.email")}>
          <TextInput
            value={email}
            type="email"
            onChange={(e) => setEmail(e.target.value)}
            data-testid={`contact-${contact.id}-email-input`}
          />
        </Field>
        <Field label={t("contacts.phone")}>
          <TextInput value={phone} inputMode="tel" onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <Field label={t("contacts.whatsapp")}>
          <TextInput
            value={whatsapp}
            inputMode="tel"
            onChange={(e) => setWhatsapp(e.target.value)}
          />
        </Field>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Field key={i} label={i === 0 ? t("contacts.firstBy") : t("contacts.then")}>
            <Select
              value={preferred[i] ?? ""}
              disabled={i > preferred.length}
              onChange={(e) => setRank(i, e.target.value)}
              data-testid={`contact-${contact.id}-preferred-${i}`}
            >
              <option value="">
                {i === 0 ? t("contacts.noPreference") : t("contacts.nothingElse")}
              </option>
              {REACH_CHANNELS.filter((ch) => !preferred.slice(0, i).includes(ch)).map((ch) => (
                <option key={ch} value={ch}>
                  {t(CHANNEL_KEY[ch])}
                </option>
              ))}
            </Select>
          </Field>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <Field label={t("contacts.language")}>
          <Select value={language} onChange={(e) => setLanguage(e.target.value)}>
            <option value="">{t("contacts.yourLanguage")}</option>
            {LOCALES.map((code) => (
              <option key={code} value={code}>
                {languageName(code, i18n)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("contacts.timezone")} hint={t("contacts.emptyIsYours")}>
          <TextInput
            value={timezone}
            placeholder="America/Chicago"
            onChange={(e) => setTimezone(e.target.value)}
            data-testid={`contact-${contact.id}-timezone`}
          />
        </Field>
        <Field label={t("contacts.quietFrom")} hint={t("contacts.emptyIsYours")}>
          <TextInput
            value={quietStart}
            placeholder="21:00"
            onChange={(e) => setQuietStart(e.target.value)}
          />
        </Field>
        <Field label={t("contacts.quietUntil")}>
          <TextInput
            value={quietEnd}
            placeholder="08:00"
            onChange={(e) => setQuietEnd(e.target.value)}
          />
        </Field>
      </div>
      <Field label={t("contacts.roles")} hint={t("contacts.rolesHint")}>
        <TextInput
          value={roles}
          onChange={(e) => setRoles(e.target.value)}
          data-testid={`contact-${contact.id}-roles`}
        />
      </Field>
      <Field label={t("contacts.notes")}>
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
          {t("contacts.saveDetails")}
        </Button>
        {saved ? <span className="text-sm text-ink-muted">{t("contacts.saved")}</span> : null}
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
  const i18n = useI18n();
  const { t, fmt } = i18n;
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
      setError(problemText(e, "contacts.problem.notSaved", i18n));
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
            {contact.language ? ` · ${languageName(contact.language, i18n)}` : ""}
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
            {open ? t("contacts.close") : t("contacts.manage")}
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
                  ? t("contacts.stoppedByText", { date: fmt.date(contact.optedOut.at) })
                  : t("contacts.optedOutOn", { date: fmt.date(contact.optedOut.at) })}
              </span>
              {keywordOptOut ? null : (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => void change({ action: "lift_opt_out" })}
                  data-testid={`contact-${contact.id}-lift`}
                >
                  {t("contacts.liftOptOut")}
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
                <Field label={t("contacts.consentChannel")}>
                  <Select
                    value={channel}
                    onChange={(e) => setChannel(e.target.value as ConsentChoice)}
                    data-testid={`contact-${contact.id}-channel`}
                  >
                    <option value="sms">{t("contacts.channel.sms")}</option>
                    <option value="whatsapp">{t("contacts.channel.whatsapp")}</option>
                    <option value="voice">{t("contacts.consentOption.voice")}</option>
                    <option value="email">{t("contacts.channel.email")}</option>
                  </Select>
                </Field>
                <Field label={t("contacts.howAgreed")} hint={t("contacts.howAgreedHint")}>
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
                  {t("contacts.recordConsent")}
                </Button>
                {contact.consent[channel] ? (
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => void change({ action: "withdraw", channel })}
                  >
                    {t("contacts.withdrawConsent")}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => void change({ action: "opt_out" })}
                  data-testid={`contact-${contact.id}-opt-out`}
                >
                  {t("contacts.optOutAll")}
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
  const { t, fmt } = useI18n();
  const opsMessages = useApi(
    apiRoutes.opsContactMessages,
    api.ops ? { params: { id: api.ops, contactId } } : null,
  );
  const portalMessages = useApi(
    apiRoutes.portalContactMessages,
    api.ops ? null : { params: { id: contactId } },
  );
  const { data, error, loading } = api.ops ? opsMessages : portalMessages;
  if (loading && !data) return <Loading label={t("contacts.loadingMessages")} />;
  if (error) return <ErrorNotice error={error} />;
  if (!data || data.items.length === 0) {
    return <p className="text-sm text-ink-muted">{t("contacts.noMessages")}</p>;
  }
  return (
    <ol data-testid={`contact-${contactId}-messages`} className="flex flex-col gap-2">
      {data.items.slice(0, 20).map((m) => {
        const status = m.status ? STATUS_KEY[m.status] : undefined;
        return (
          <li key={m.id} className="text-sm">
            <span className="eyebrow text-ink-muted">
              {m.channel === "voice"
                ? m.direction === "in"
                  ? t("contacts.message.theyCalled")
                  : t("contacts.message.weCalled")
                : m.direction === "in"
                  ? t("contacts.message.theyWrote")
                  : t("contacts.message.weSent")}{" "}
              · {m.channel === "voice" ? t("contacts.message.call") : t(CHANNEL_KEY[m.channel])}
              {m.reachOut ? ` · ${t("contacts.message.reachOut")}` : ""} · {fmt.time(m.at)}
              {m.status ? ` · ${status ? t(status) : m.status}` : ""}
            </span>
            {/* The sender's words (a text, an email, a call transcript), shown as text, never as
                markup, and never translated. */}
            <p className="mt-0.5 whitespace-pre-wrap text-ink">{m.text}</p>
          </li>
        );
      })}
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
  const i18n = useI18n();
  const { t } = i18n;
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
      setError(problemText(err, "contacts.problem.notAdded", i18n));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-5" testId="contact-add">
      <SectionLabel>{t("contacts.add")}</SectionLabel>
      <form className="flex flex-col gap-4" onSubmit={(e) => void add(e)}>
        <Field label={t("contacts.name")}>
          <TextInput
            value={name}
            maxLength={CONTACT_NAME_MAX}
            onChange={(e) => setName(e.target.value)}
            data-testid="contact-add-name"
          />
        </Field>
        <Field label={t("contacts.phone")} hint={t("contacts.phoneHint")}>
          <TextInput
            value={phone}
            inputMode="tel"
            onChange={(e) => setPhone(e.target.value)}
            data-testid="contact-add-phone"
          />
        </Field>
        <Field label={t("contacts.whatsapp")} hint={t("contacts.whatsappHint")}>
          <TextInput
            value={whatsapp}
            inputMode="tel"
            onChange={(e) => setWhatsapp(e.target.value)}
            data-testid="contact-add-whatsapp"
          />
        </Field>
        <Field label={t("contacts.email")}>
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
          {t("contacts.agreedToHear")}
        </label>
        {agreed ? (
          <Field label={t("contacts.howAgreed")}>
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
            {t("contacts.addContact")}
          </Button>
        </div>
      </form>
    </Card>
  );
}
