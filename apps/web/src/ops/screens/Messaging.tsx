// `/ops/clients/:clientId/messaging` (plan §1.22): a client's texts and WhatsApp. The operator makes
// the client's Twilio subaccount, buys and releases its numbers (they cost money, so only here,
// never by an agent), marks the WhatsApp sender once Twilio has registered it, records and checks
// A2P 10DLC registration, sets quiet hours, and keeps the client's contacts.
import type { A2pStatus, AvailableNumber, MessagingSetup, QuietHours } from "@countersign/core";
import { type FormEvent, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { isApiError } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { ContactsPanel } from "../../contacts/ContactsPanel";
// v0.14 capture
import { ConversationsPanel } from "../../conversations/ConversationsPanel";
import { Field, TextInput } from "../../ui/forms";
import {
  Badge,
  Button,
  buttonClass,
  Card,
  ErrorNotice,
  Loading,
  PageHeader,
  SectionLabel,
  type Tone,
} from "../../ui/primitives";
import { CallsPanel } from "./Calls";
import { CaptureDefault } from "./CaptureDefault";
import { EmailPanel } from "./EmailSetup";

const A2P: Record<A2pStatus, { label: string; tone: Tone }> = {
  not_started: { label: "Not started", tone: "neutral" },
  pending: { label: "In review", tone: "accent" },
  approved: { label: "Approved", tone: "positive" },
  failed: { label: "Refused", tone: "risk" },
};

function message(error: unknown): string {
  return isApiError(error) ? error.message : "That didn't work. Try again.";
}

export function OpsMessagingScreen() {
  const { clientId = "" } = useParams();
  const client = useApi(apiRoutes.opsClient, { params: { id: clientId } });
  const setup = useApi(apiRoutes.opsMessaging, { params: { id: clientId } });
  const [override, setOverride] = useState<MessagingSetup | null>(null);
  const data = override ?? setup.data?.setup;

  return (
    <div>
      <PageHeader
        title="Texts and WhatsApp"
        subtitle={client.data ? client.data.client.name : undefined}
        actions={
          <Link to={`/ops/clients/${clientId}`} className={buttonClass("ghost")}>
            Back to the client
          </Link>
        }
      />
      {setup.loading && !data ? <Loading /> : null}
      {setup.error ? <ErrorNotice error={setup.error} onRetry={setup.reload} /> : null}
      {data ? <TwilioSetup clientId={clientId} setup={data} onChange={setOverride} /> : null}
      <div className="mt-6">
        <CallsPanel clientId={clientId} />
      </div>
      <div className="mt-6">
        <EmailPanel clientId={clientId} />
      </div>
      <div className="mt-8">
        <ContactsPanel surface={{ kind: "ops", clientId }} />
      </div>
      {/* v0.14 capture: WhatsApp conversations and the client's default (docs/plan.md §1.55). */}
      <div className="mt-8">
        <CaptureDefault clientId={clientId} />
        <ConversationsPanel surface={{ kind: "ops", clientId }} />
      </div>
    </div>
  );
}

function TwilioSetup({
  clientId,
  setup,
  onChange,
}: {
  clientId: string;
  setup: MessagingSetup;
  onChange: (s: MessagingSetup) => void;
}) {
  const api = useApiClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const params = { id: clientId };

  async function act(call: () => Promise<{ setup: MessagingSetup }>) {
    setBusy(true);
    setError(null);
    try {
      onChange((await call()).setup);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  const twilio = setup.twilio;
  return (
    <div className="flex flex-col gap-6" data-testid="ops-messaging-setup">
      {error ? (
        <div role="alert" className="ds-banner">
          {error}
        </div>
      ) : null}
      <Card className="p-5">
        <SectionLabel>Twilio</SectionLabel>
        {!setup.available ? (
          <p className="text-ink-muted">
            Mezonas' Twilio account isn't set up on this deployment yet (TWILIO_ACCOUNT_SID and
            TWILIO_AUTH_TOKEN).
          </p>
        ) : twilio === null || twilio.status !== "connected" ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-ink-muted">
              {twilio
                ? "The client's subaccount is disconnected. Reconnect it to send again."
                : "No subaccount yet. We make one under Mezonas' account, just for this client."}
            </p>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => void act(() => api.call(apiRoutes.opsTwilioProvision, { params }))}
              data-testid="ops-twilio-provision"
            >
              {twilio ? "Reconnect the subaccount" : "Set up the subaccount"}
            </Button>
          </div>
        ) : (
          <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-[180px_minmax(0,1fr)]">
            <dt className="text-ink-muted">Subaccount</dt>
            <dd className="reference" data-testid="ops-twilio-subaccount">
              {twilio.subaccountSid}
            </dd>
            <dt className="text-ink-muted">Inbound messages go to</dt>
            <dd className="reference break-all">{setup.webhooks.messages}</dd>
          </dl>
        )}
      </Card>

      {twilio?.status === "connected" ? (
        <>
          <Numbers clientId={clientId} setup={setup} busy={busy} act={act} />
          <A2pPanel clientId={clientId} setup={setup} busy={busy} act={act} />
        </>
      ) : null}
      <QuietHoursPanel clientId={clientId} setup={setup} busy={busy} act={act} />
    </div>
  );
}

type Act = (call: () => Promise<{ setup: MessagingSetup }>) => Promise<void>;

function Numbers({
  clientId,
  setup,
  busy,
  act,
}: {
  clientId: string;
  setup: MessagingSetup;
  busy: boolean;
  act: Act;
}) {
  const api = useApiClient();
  const [areaCode, setAreaCode] = useState("");
  const [found, setFound] = useState<AvailableNumber[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const numbers = setup.twilio?.numbers ?? [];

  async function search(e: FormEvent) {
    e.preventDefault();
    setSearchError(null);
    try {
      const r = await api.call(apiRoutes.opsTwilioAvailableNumbers, {
        params: { id: clientId },
        query: { country: "US", ...(areaCode ? { areaCode } : {}) },
      });
      setFound(r.items);
    } catch (err) {
      setSearchError(message(err));
    }
  }

  return (
    <Card className="p-5" testId="ops-twilio-numbers">
      <SectionLabel>Numbers</SectionLabel>
      {numbers.length === 0 ? (
        <p className="mb-4 text-ink-muted">No numbers yet. Find one below.</p>
      ) : (
        <ul className="mb-4 flex flex-col gap-2">
          {numbers.map((n) => (
            <li
              key={n.sid}
              className="flex flex-wrap items-center justify-between gap-3"
              data-testid={`ops-number-${n.phoneNumber}`}
            >
              <span className="figures text-ink">{n.phoneNumber}</span>
              <span className="flex flex-wrap items-center gap-2">
                {n.whatsapp ? <Badge tone="positive">WhatsApp sender</Badge> : null}
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void act(() =>
                      api.call(apiRoutes.opsTwilioNumberWhatsApp, {
                        params: { id: clientId, sid: n.sid },
                        body: { enabled: !n.whatsapp },
                      }),
                    )
                  }
                >
                  {n.whatsapp ? "Not a WhatsApp sender" : "Registered for WhatsApp"}
                </Button>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void act(() =>
                      api.call(apiRoutes.opsTwilioReleaseNumber, {
                        params: { id: clientId, sid: n.sid },
                      }),
                    )
                  }
                  data-testid={`ops-number-${n.phoneNumber}-release`}
                >
                  Release
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => void search(e)}>
        <Field label="Area code" className="w-32">
          <TextInput
            value={areaCode}
            inputMode="numeric"
            maxLength={3}
            onChange={(e) => setAreaCode(e.target.value.replace(/\D/g, ""))}
            data-testid="ops-number-area"
          />
        </Field>
        <Button type="submit" data-testid="ops-number-search">
          Find US numbers
        </Button>
      </form>
      {searchError ? (
        <p role="alert" className="ds-error mt-2 text-sm">
          {searchError}
        </p>
      ) : null}
      {found ? (
        found.length === 0 ? (
          <p className="mt-3 text-ink-muted">None for sale there. Try another area code.</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2" data-testid="ops-number-results">
            {found.map((n) => (
              <li key={n.phoneNumber} className="flex items-center justify-between gap-3">
                <span className="text-sm">
                  <span className="figures text-ink">{n.phoneNumber}</span>
                  <span className="text-ink-muted">
                    {" "}
                    · {[n.locality, n.region].filter(Boolean).join(", ")}
                  </span>
                </span>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      const r = await api.call(apiRoutes.opsTwilioBuyNumber, {
                        params: { id: clientId },
                        body: { phoneNumber: n.phoneNumber },
                      });
                      setFound(null);
                      return r;
                    })
                  }
                  data-testid={`ops-number-buy-${n.phoneNumber}`}
                >
                  Buy
                </Button>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </Card>
  );
}

function A2pPanel({
  clientId,
  setup,
  busy,
  act,
}: {
  clientId: string;
  setup: MessagingSetup;
  busy: boolean;
  act: Act;
}) {
  const api = useApiClient();
  const a2p = setup.twilio?.a2p;
  const [brand, setBrand] = useState(a2p?.brandSid ?? "");
  const [service, setService] = useState(a2p?.messagingServiceSid ?? "");
  if (!a2p) return null;
  const status = A2P[a2p.status];
  return (
    <Card className="p-5" testId="ops-a2p">
      <SectionLabel
        action={
          <Badge tone={status.tone} testId="ops-a2p-status">
            {status.label}
          </Badge>
        }
      >
        US texting registration (A2P 10DLC)
      </SectionLabel>
      <p className="mb-4 text-sm text-ink-muted">
        Register the client's brand and campaign in Twilio's console, then record them here. Texts
        to US numbers wait until both are approved.
        {a2p.checkedAt
          ? ` Last checked ${new Date(a2p.checkedAt).toLocaleString()}: brand ${a2p.brandStatus ?? "none"}, campaign ${a2p.campaignStatus ?? "none"}.`
          : ""}
      </p>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void act(() =>
            api.call(apiRoutes.opsTwilioA2p, {
              params: { id: clientId },
              body: { brandSid: brand.trim() || null, messagingServiceSid: service.trim() || null },
            }),
          );
        }}
      >
        <Field label="Brand (BN…)" className="w-80">
          <TextInput
            value={brand}
            onChange={(e) => setBrand(e.target.value)}
            data-testid="ops-a2p-brand"
          />
        </Field>
        <Field label="Messaging Service (MG…)" className="w-80">
          <TextInput
            value={service}
            onChange={(e) => setService(e.target.value)}
            data-testid="ops-a2p-service"
          />
        </Field>
        <Button type="submit" disabled={busy}>
          Save
        </Button>
        <Button
          disabled={busy || (!a2p.brandSid && !a2p.messagingServiceSid)}
          onClick={() =>
            void act(() => api.call(apiRoutes.opsTwilioA2pRefresh, { params: { id: clientId } }))
          }
          data-testid="ops-a2p-refresh"
        >
          Check status
        </Button>
      </form>
    </Card>
  );
}

function QuietHoursPanel({
  clientId,
  setup,
  busy,
  act,
}: {
  clientId: string;
  setup: MessagingSetup;
  busy: boolean;
  act: Act;
}) {
  const api = useApiClient();
  const [q, setQ] = useState<QuietHours>(setup.quietHours);
  return (
    <Card className="p-5" testId="ops-quiet-hours">
      <SectionLabel>Quiet hours</SectionLabel>
      <p className="mb-4 text-sm text-ink-muted">
        Nothing is sent between these times, in the client's timezone ({setup.timezone}). A send
        approved in quiet hours fails and can be sent again after.
      </p>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void act(() =>
            api.call(apiRoutes.opsMessagingSettings, {
              params: { id: clientId },
              body: { quietHours: q },
            }),
          );
        }}
      >
        <Field label="From" className="w-32">
          <TextInput
            type="time"
            value={q.start}
            onChange={(e) => setQ({ ...q, start: e.target.value })}
          />
        </Field>
        <Field label="Until" className="w-32">
          <TextInput
            type="time"
            value={q.end}
            onChange={(e) => setQ({ ...q, end: e.target.value })}
          />
        </Field>
        <Button type="submit" disabled={busy || q.start === q.end}>
          Save
        </Button>
      </form>
    </Card>
  );
}
