// `/ops/clients/:clientId/settings`: the settings a client was onboarded with (docs/plan.md §1.14):
// name and timezone, who approves changes to its tools (with the log of who changed it and why),
// the tools it is offered (changed on Connections), its people and invites, and the email choices
// its admin made in the portal; then compliance (HIPAA mode, vendors) and retiring the client.
// On the client page's Settings tab, with the client's language, approver rules, the portal's
// Feedback switch, which used to sit on the client's first page.
import type { ExternalApprover, OpsClientSettings } from "@countersign/core";
import { useEffect, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { isApiError } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { InviteForm, inviteMessage, MemberList } from "../../people/People";
import { Field, TextInput } from "../../ui/forms";
import { Badge, Button, Card, ErrorNotice, Loading, SectionLabel, Tag } from "../../ui/primitives";
import { ClientFrame, useClientPage } from "../client/ClientFrame";
import { ClientApproverRules } from "./ClientApproverRules";
import { ClientComplianceSetting } from "./ClientComplianceSetting";
import { ClientFeedbackSetting } from "./ClientFeedbackSetting";
import { ClientLanguageSetting } from "./ClientLanguageSetting";
import { ApproverChoice, type CreatedState } from "./NewClient";

const APPROVER_LABEL: Record<ExternalApprover, string> = {
  client_admin: "their admin",
  operator: "us",
};

export function ClientSettingsScreen() {
  const { clientId = "" } = useParams();
  return (
    <ClientFrame clientId={clientId}>
      <Settings clientId={clientId} />
    </ClientFrame>
  );
}

function Settings({ clientId }: { clientId: string }) {
  const client = useClientPage();
  const location = useLocation();
  const created = (location.state as CreatedState | null)?.created ?? null;
  const api = useApiClient();
  const settings = useApi(apiRoutes.opsClientSettings, { params: { id: clientId } });
  const connections = useApi(apiRoutes.opsClientConnections, { params: { id: clientId } });
  const [current, setCurrent] = useState<OpsClientSettings | undefined>(undefined);
  useEffect(() => setCurrent(settings.data), [settings.data]);

  if (settings.loading && !current) return <Loading />;
  if (settings.error) return <ErrorNotice error={settings.error} onRetry={settings.reload} />;
  if (!current) return null;

  const save = async (body: {
    name?: string;
    timezone?: string;
    approvals?: ExternalApprover;
    reason?: string;
  }) => {
    const next = await api.call(apiRoutes.opsUpdateClientSettings, {
      params: { id: clientId },
      body,
    });
    setCurrent(next);
    client.reload();
  };
  const people = current.members.filter((m) => m.role !== "operator");
  const team = current.members.filter((m) => m.role === "operator");

  return (
    <div className="max-w-4xl">
      <p className="mb-6 text-ink-muted" data-testid="ops-client-settings-line">
        {`${people.length} ${people.length === 1 ? "person" : "people"} · approvals by ${APPROVER_LABEL[current.approvals.externalActions]}`}
      </p>
      {created ? (
        <Card className="mb-8 p-5" testId="ops-client-created">
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
      ) : null}

      <Details settings={current} onSave={save} />
      <Approvals settings={current} onSave={save} />
      <ClientApproverRules clientId={clientId} />
      {client.data ? (
        <ClientLanguageSetting
          clientId={clientId}
          settings={client.data.client.settings}
          onSaved={client.reload}
        />
      ) : null}

      <section className="mt-8" data-testid="ops-client-settings-offered">
        <SectionLabel
          action={
            <Link
              to={`/ops/clients/${clientId}/connections`}
              className="ds-btn ds-btn--link text-sm"
            >
              Change on Connections
            </Link>
          }
        >
          Tools offered
        </SectionLabel>
        <Card className="p-5">
          {connections.error ? (
            <ErrorNotice error={connections.error} onRetry={connections.reload} />
          ) : null}
          {connections.data ? (
            connections.data.offered.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {connections.data.offered.map((id) => (
                  <Tag key={id}>
                    {connections.data?.connectors.find((c) => c.id === id)?.name ?? id}
                  </Tag>
                ))}
              </div>
            ) : (
              <p className="text-ink-muted">No tools offered yet.</p>
            )
          ) : null}
        </Card>
      </section>

      <section className="mt-8" data-testid="ops-client-settings-people">
        <SectionLabel>People</SectionLabel>
        {current.client.sandbox ? (
          <p className="mb-3 text-sm text-ink-muted">
            The Sandbox is our own test client: it has no client people.
          </p>
        ) : null}
        <MemberList members={people} testId="ops-client-members" />
        {current.client.sandbox ? null : (
          <InviteForm
            surface="ops"
            testId="ops-client-invite"
            onInvite={async (body) => {
              const result = await api.call(apiRoutes.opsInvite, {
                params: { id: clientId },
                body,
              });
              settings.reload();
              return result;
            }}
          />
        )}
        {team.length > 0 ? (
          <p className="mt-3 text-sm text-ink-muted" data-testid="ops-client-team">
            Served by {team.map((m) => m.name ?? m.email).join(", ")}.
          </p>
        ) : null}
      </section>

      <section className="mt-8" data-testid="ops-client-settings-emails">
        <SectionLabel>Emails</SectionLabel>
        <Card className="p-5">
          <p className="text-ink">
            {current.notifications.itemsWaiting ? "Emails" : "No emails"} when something waits on
            them; {current.notifications.weeklyDigest ? "a" : "no"} weekly summary.
          </p>
          <p className="mt-1 text-sm text-ink-muted">
            Their admin chooses these in the portal. We don't send them yet.
          </p>
        </Card>
      </section>

      <ClientFeedbackSetting clientId={clientId} />
      <ClientComplianceSetting clientId={clientId} clientName={current.client.name} />
    </div>
  );
}

type Save = (body: {
  name?: string;
  timezone?: string;
  approvals?: ExternalApprover;
  reason?: string;
}) => Promise<void>;

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
    <section data-testid="ops-client-settings-details">
      <SectionLabel>Client</SectionLabel>
      <Card className="p-5">
        <div className="flex flex-wrap gap-4">
          <Field label="Name" className="min-w-64 flex-1">
            <TextInput
              data-testid="ops-client-settings-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field
            label="Timezone"
            hint="Schedules run in this timezone."
            className="min-w-64 flex-1"
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
    </section>
  );
}

function Approvals({ settings, onSave }: { settings: OpsClientSettings; onSave: Save }) {
  const saved = settings.approvals.externalActions;
  const [choice, setChoice] = useState<ExternalApprover>(saved);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => setChoice(saved), [saved]);

  async function save() {
    setBusy(true);
    setNote(null);
    try {
      await onSave({ approvals: choice, ...(reason.trim() ? { reason: reason.trim() } : {}) });
      setReason("");
      setNote("Saved.");
    } catch (error) {
      setNote(failure(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-8" data-testid="ops-client-settings-approvals">
      <SectionLabel>Approvals</SectionLabel>
      <ApproverChoice value={choice} onChange={setChoice} name="ops-client-approvals" />
      <p className="mt-2 text-sm text-ink-muted">
        A client agent's own approver, and each step's, still come first. Their admin can always
        tighten what agents may do in each tool.
      </p>
      {choice !== saved ? (
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <Field
            label="Why change it?"
            hint="Optional. Kept with the change."
            className="min-w-64 flex-1"
          >
            <TextInput
              data-testid="ops-client-approvals-reason"
              value={reason}
              maxLength={500}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
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
    </section>
  );
}
