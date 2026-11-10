// The client page's Settings tab (`/ops/clients/:clientId/settings[/:section]`, docs/plan.md
// §1.14): one section at a time beside a section list, as the portal's Settings. General (name,
// timezone, language, the portal's Feedback button), Approvals (who approves changes to its tools
// by default, then the approver rules), People (its people and invites, and the emails its admin
// chose), Business hours and Channels (R8, plan §1.86: the client's week and its people's hours,
// read-only; the account's number and email, ours to bind), Billing, Compliance (HIPAA mode and
// vendors), Exports (it was a tab; `/exports` redirects here) and Retire client. The tools it is
// offered are on Setup, Connections.
import type { ExternalApprover, OpsClientSettings } from "@countersign/core";
import { type ReactNode, useEffect, useState } from "react";
import { Link, NavLink, useLocation, useParams } from "react-router-dom";
import { isApiError } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { InviteForm, inviteMessage, MemberList } from "../../people/People";
import { Field, TextInput } from "../../ui/forms";
import { Section } from "../../ui/page";
import { Badge, Button, Card, ErrorNotice, Loading } from "../../ui/primitives";
import { ClientExportsSection } from "../client/ClientExports";
import { ClientFrame, clientPagePath, useClientPage } from "../client/ClientFrame";
import { ClientApproverRules } from "./ClientApproverRules";
import { ClientBillingSection } from "./ClientBilling";
import { ClientComplianceSetting, ClientRetireSetting } from "./ClientComplianceSetting";
import { ClientFeedbackSetting } from "./ClientFeedbackSetting";
import { ClientChannelsSection, ClientHoursSection } from "./ClientHours";
import { ClientLanguageSetting } from "./ClientLanguageSetting";
import { ApproverChoice, type CreatedState } from "./NewClient";

const APPROVER_LABEL: Record<ExternalApprover, string> = {
  client_admin: "their admin",
  operator: "us",
};

/** The sections, in the list's order; the first is the tab's own address. */
export const SETTINGS_SECTIONS = [
  ["general", "General"],
  ["approvals", "Approvals"],
  ["people", "People"],
  // R8 (docs/plan.md §1.86): what the portal shows the client, read-only where it is theirs.
  ["hours", "Business hours"],
  ["channels", "Channels"],
  ["billing", "Billing"],
  ["compliance", "Compliance"],
  ["exports", "Exports"],
  ["retire", "Retire client"],
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number][0];

/** `/ops/clients/:clientId/settings` for General, `…/settings/<section>` for the others. */
export function settingsPath(clientId: string, section: SettingsSection): string {
  const base = clientPagePath(clientId, "settings");
  return section === "general" ? base : `${base}/${section}`;
}

export function ClientSettingsScreen() {
  const { clientId = "", section: asked } = useParams();
  // DECISION: an unknown section opens General rather than a "Not found".
  const section: SettingsSection = SETTINGS_SECTIONS.find(([id]) => id === asked)?.[0] ?? "general";
  return (
    <ClientFrame clientId={clientId}>
      <div className="ui-sections" data-testid="ops-client-settings">
        <nav
          className="ui-sections__nav"
          aria-label="Settings sections"
          data-testid="ops-client-settings-nav"
        >
          {SETTINGS_SECTIONS.map(([id, label]) => (
            <NavLink
              key={id}
              to={settingsPath(clientId, id)}
              end
              className="ds-navitem ui-navitem"
              data-testid={`ops-client-settings-nav-${id}`}
            >
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="ui-sections__body">
          <SectionBody clientId={clientId} section={section} />
        </div>
      </div>
    </ClientFrame>
  );
}

function SectionBody({ clientId, section }: { clientId: string; section: SettingsSection }) {
  const client = useClientPage();
  switch (section) {
    case "hours":
      return <ClientHoursSection clientId={clientId} />;
    case "channels":
      return <ClientChannelsSection clientId={clientId} />;
    case "billing":
      return (
        <Titled
          title="Billing"
          action={
            <Link to="/ops/billing" className="ds-btn ds-btn--link text-sm">
              All clients' billing
            </Link>
          }
        >
          <ClientBillingSection clientId={clientId} />
        </Titled>
      );
    case "compliance":
      return (
        <Titled title="Compliance">
          <ClientComplianceSetting clientId={clientId} />
        </Titled>
      );
    case "exports":
      return <ClientExportsSection clientId={clientId} />;
    case "retire":
      return (
        <Titled title="Retire client">
          {client.data ? (
            <ClientRetireSetting clientId={clientId} clientName={client.data.client.name} />
          ) : (
            <Loading />
          )}
        </Titled>
      );
    default:
      return <SettingsForm clientId={clientId} section={section} />;
  }
}

function Titled({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Section
      title={title}
      action={action}
      testId={`ops-client-settings-${title.toLowerCase().replace(/ /g, "-")}`}
    >
      {children}
    </Section>
  );
}

/** General, Approvals and People: the sections that read the client's settings. */
function SettingsForm({
  clientId,
  section,
}: {
  clientId: string;
  section: "general" | "approvals" | "people";
}) {
  const client = useClientPage();
  const location = useLocation();
  const created = (location.state as CreatedState | null)?.created ?? null;
  const api = useApiClient();
  const settings = useApi(apiRoutes.opsClientSettings, { params: { id: clientId } });
  const [current, setCurrent] = useState<OpsClientSettings | undefined>(undefined);
  useEffect(() => setCurrent(settings.data), [settings.data]);

  if (settings.loading && !current) return <Loading />;
  if (settings.error) return <ErrorNotice error={settings.error} onRetry={settings.reload} />;
  if (!current) return null;

  const save: Save = async (body) => {
    const next = await api.call(apiRoutes.opsUpdateClientSettings, {
      params: { id: clientId },
      body,
    });
    setCurrent(next);
    client.reload();
  };

  if (section === "approvals") {
    return (
      <Section
        title="Approvals"
        meta={`Approvals by ${APPROVER_LABEL[current.approvals.externalActions]}`}
        testId="ops-client-settings-approvals"
      >
        <Approvals settings={current} onSave={save} />
        <ClientApproverRules clientId={clientId} />
      </Section>
    );
  }

  if (section === "people") {
    return (
      <People
        clientId={clientId}
        settings={current}
        onInvited={settings.reload}
        created={
          // A new client opens here: what was set up, and whether its admin was invited.
          created ? (
            <Card className="p-5" testId="ops-client-created">
              <div className="flex flex-wrap items-center gap-3">
                <Badge tone="positive">Created</Badge>
                <span className="font-medium text-ink">{created.name} is set up.</span>
              </div>
              <p className="mt-2 text-ink">
                {created.admin
                  ? inviteMessage(created.admin)
                  : "Nobody is invited yet. Invite their admin below."}
              </p>
            </Card>
          ) : null
        }
      />
    );
  }

  return (
    <Section title="General" testId="ops-client-settings-general">
      <Details settings={current} onSave={save} />
      {/* M44 (docs/plan.md §1.74): whether the client is one of our own (§1.72). */}
      <OursSetting settings={current} onSave={save} />
      {client.data ? (
        <ClientLanguageSetting
          clientId={clientId}
          settings={client.data.client.settings}
          onSaved={client.reload}
        />
      ) : null}
      <ClientFeedbackSetting clientId={clientId} />
    </Section>
  );
}

type Save = (body: {
  name?: string;
  timezone?: string;
  approvals?: ExternalApprover;
  internal?: boolean;
  reason?: string;
}) => Promise<void>;

/**
 * M44: one of our own (`tenant.settings.internal`, docs/plan.md §1.72): Mezonas as its own client.
 * Its data is real, it is never billed and it gets no Weekly Table; the back office's Marketing
 * entry opens it. Changed with a reason, kept in the client's change log, as the approvals are.
 */
function OursSetting({ settings, onSave }: { settings: OpsClientSettings; onSave: Save }) {
  const saved = settings.client.internal;
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setNote(null);
    try {
      await onSave({ internal: !saved, ...(reason.trim() ? { reason: reason.trim() } : {}) });
      setReason("");
      setNote("Saved.");
    } catch (error) {
      setNote(failure(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="One of ours" pad testId="ops-client-settings-internal">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 flex-1 text-ink">
          {saved
            ? "This client is us. Its data is real, it is never billed and it gets no Weekly Table."
            : "A client of ours. Mark it as one of ours only if it is Mezonas itself."}
        </p>
        <Badge tone={saved ? "accent" : "neutral"} testId="ops-client-settings-internal-state">
          {saved ? "Ours" : "A client"}
        </Badge>
      </div>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <Field
          label="Why"
          hint="Kept in the client's change log."
          className="min-w-0 flex-1 basis-64"
        >
          <TextInput
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
            data-testid="ops-client-settings-internal-reason"
          />
        </Field>
        <Button
          variant={saved ? "secondary" : "primary"}
          disabled={busy}
          onClick={() => void save()}
          data-testid="ops-client-settings-internal-save"
        >
          {saved ? "Mark as a client" : "Mark as ours"}
        </Button>
      </div>
      {note ? (
        <p role="status" className="mt-2 text-sm text-ink-muted">
          {note}
        </p>
      ) : null}
    </Card>
  );
}

function failure(error: unknown): string {
  const code = isApiError(error) ? error.code : null;
  if (code === "no_op") return "Nothing changed.";
  if (code === "invalid_timezone") return "That isn't a timezone we know.";
  return "We couldn't save that. Try again.";
}

function Details({ settings, onSave }: { settings: OpsClientSettings; onSave: Save }) {
  const [name, setName] = useState(settings.client.name);
  const [timezone, setTimezone] = useState(settings.client.timezone);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setNote(null);
    try {
      await onSave({ name: name.trim(), timezone: timezone.trim() });
      setNote("Saved.");
    } catch (error) {
      setNote(failure(error));
    } finally {
      setBusy(false);
    }
  }

  const changed =
    name.trim() !== settings.client.name || timezone.trim() !== settings.client.timezone;
  return (
    <Card title="Client" pad testId="ops-client-settings-details">
      <div className="flex flex-wrap gap-4">
        <Field label="Name" className="min-w-0 flex-1 basis-64">
          <TextInput
            data-testid="ops-client-settings-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field
          label="Timezone"
          hint="Schedules run in this timezone."
          className="min-w-0 flex-1 basis-64"
        >
          <TextInput
            data-testid="ops-client-settings-timezone"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
          />
        </Field>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <Button
          variant="primary"
          disabled={busy || !changed || !name.trim()}
          onClick={() => void save()}
          data-testid="ops-client-settings-save"
        >
          Save
        </Button>
        {note ? (
          <span role="status" className="text-sm text-ink-muted">
            {note}
          </span>
        ) : null}
      </div>
    </Card>
  );
}

function Approvals({ settings, onSave }: { settings: OpsClientSettings; onSave: Save }) {
  const saved = settings.approvals.externalActions;
  const [choice, setChoice] = useState<ExternalApprover>(saved);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => setChoice(saved), [saved]);

  async function save() {
    setBusy(true);
    setNote(null);
    try {
      await onSave({ approvals: choice });
      setNote("Saved.");
    } catch (error) {
      setNote(failure(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Who approves by default" pad testId="ops-client-settings-default-approver">
      <ApproverChoice value={choice} onChange={setChoice} name="ops-client-approvals" />
      <p className="mt-2 text-sm text-ink-muted">
        A client agent's own approver, and each step's, still come first. Their admin can always
        tighten what agents may do in each tool.
      </p>
      {choice !== saved ? (
        <div className="mt-3">
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => void save()}
            data-testid="ops-client-approvals-save"
          >
            Save
          </Button>
        </div>
      ) : null}
      {note ? (
        <p role="status" className="mt-2 text-sm text-ink-muted">
          {note}
        </p>
      ) : null}
      {settings.approvals.changes.length > 0 ? (
        <ul
          className="mt-3 flex flex-col gap-1 text-sm text-ink-muted"
          data-testid="ops-client-approvals-history"
        >
          {settings.approvals.changes.map((c) => (
            <li key={c.id}>
              Changed to {APPROVER_LABEL[c.to]} by {c.by?.name ?? c.by?.email ?? "someone"} on{" "}
              {new Date(c.createdAt).toLocaleDateString()}
              {c.reason ? (
                <>
                  : <span className="text-ink">{c.reason}</span>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

function People({
  clientId,
  settings,
  onInvited,
  created,
}: {
  clientId: string;
  settings: OpsClientSettings;
  onInvited: () => void;
  created: ReactNode;
}) {
  const api = useApiClient();
  const people = settings.members.filter((m) => m.role !== "operator");
  const team = settings.members.filter((m) => m.role === "operator");
  return (
    <Section
      title="People"
      meta={`${people.length} ${people.length === 1 ? "person" : "people"}`}
      testId="ops-client-settings-people"
    >
      {created}
      <div>
        {settings.client.sandbox ? (
          <p className="mb-3 text-sm text-ink-muted">
            The Sandbox is our own test client: it has no client people.
          </p>
        ) : null}
        <MemberList members={people} testId="ops-client-members" />
        {settings.client.sandbox ? null : (
          <>
            <InviteForm
              surface="ops"
              testId="ops-client-invite"
              onInvite={async (body) => {
                const result = await api.call(apiRoutes.opsInvite, {
                  params: { id: clientId },
                  body,
                });
                onInvited();
                return result;
              }}
            />
            <p className="mt-3 text-sm">
              <Link
                to={clientPagePath(clientId, "directory")}
                className="text-link hover:underline"
                data-testid="ops-client-invite-directory"
              >
                Invite from the directory
              </Link>
            </p>
          </>
        )}
        {team.length > 0 ? (
          <p className="mt-3 text-sm text-ink-muted" data-testid="ops-client-team">
            Served by {team.map((m) => m.name ?? m.email).join(", ")}.
          </p>
        ) : null}
      </div>
      <Card title="Emails" pad testId="ops-client-settings-emails">
        <p className="text-ink">
          {settings.notifications.itemsWaiting ? "Emails" : "No emails"} when something waits on
          them; {settings.notifications.weeklyDigest ? "a" : "no"} weekly summary.
        </p>
        <p className="mt-1 text-sm text-ink-muted">
          Their admin chooses these in the portal. We don't send them yet.
        </p>
      </Card>
    </Section>
  );
}
