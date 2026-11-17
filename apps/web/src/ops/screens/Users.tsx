// `/ops/users` (docs/plan.md §1.122): Mezonas's own people. The operators who serve the clients you
// serve, each with how many of yours they serve; invite another (they serve every client you
// serve, and sign in with that address), give one the clients of yours they don't have yet, or
// stop one serving your clients. Every operator is an admin of the back office for now. A client's
// own people are on that client's Settings, People.
import type { OperatorInviteResult, OperatorMember } from "@countersign/core";
import { useState } from "react";
import { isApiError } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { RemoveButton } from "../../people/People";
import { Field, TextInput } from "../../ui/forms";
import { Loaded, Page, Section } from "../../ui/page";
import { Badge, Button, Card, EmptyState, PageHeader, Tag } from "../../ui/primitives";

/** What the invitation did, in plain words (back office: English). */
export function operatorInviteMessage(result: OperatorInviteResult): string {
  const email = result.operator.email;
  const clients = `${result.added} ${result.added === 1 ? "client" : "clients"}`;
  const added =
    result.added > 0 ? `Added ${email} to ${clients}.` : `${email} already serves them.`;
  switch (result.email.status) {
    case "sent":
      return `${added} We emailed them an invitation.`;
    case "not_sent":
      return result.email.reason === "already_signed_up"
        ? `${added} They've signed in before, so there was nothing to email.`
        : `${added} This environment sends no emails: they can sign in with that address now.`;
    default:
      return `${added} The email didn't send: ask them to sign in with that address.`;
  }
}

function inviteProblem(error: unknown): string {
  const code = isApiError(error) ? error.code : null;
  switch (code) {
    case "client_person":
      return "That address belongs to a client's people. Use another address.";
    case "invalid_request":
      return "Enter an email address.";
    default:
      return "We couldn't invite them. Try again.";
  }
}

export function OpsUsersScreen() {
  const api = useApiClient();
  const state = useApi(apiRoutes.opsOperators);
  return (
    <Page testId="ops-users">
      <PageHeader
        title="Users"
        subtitle="The operators who serve your clients. Every operator can do everything in the back office."
      />
      <Loaded state={state}>
        {(data) => (
          <>
            <OperatorList
              operators={data.operators}
              clients={data.clients}
              onAddAll={async (o) => {
                const result = await api.call(apiRoutes.opsInviteOperator, {
                  body: { email: o.email },
                });
                state.reload();
                return result;
              }}
              onRemove={async (o) => {
                await api.call(apiRoutes.opsRemoveOperator, { params: { userId: o.userId } });
                state.reload();
              }}
            />
            <Section title="Invite an operator">
              <OperatorInviteForm
                clients={data.clients}
                onInvite={async (body) => {
                  const result = await api.call(apiRoutes.opsInviteOperator, { body });
                  state.reload();
                  return result;
                }}
              />
            </Section>
            <p className="text-sm text-ink-muted">
              A client's own people (its admins and users) are on that client's Settings, People.
            </p>
          </>
        )}
      </Loaded>
    </Page>
  );
}

function OperatorList({
  operators,
  clients,
  onAddAll,
  onRemove,
}: {
  operators: OperatorMember[];
  clients: number;
  onAddAll: (o: OperatorMember) => Promise<OperatorInviteResult>;
  onRemove: (o: OperatorMember) => Promise<void>;
}) {
  if (operators.length === 0) return <EmptyState>No operators yet.</EmptyState>;
  return (
    <Card
      titleAbove
      title="Operators"
      meta={`${operators.length} ${operators.length === 1 ? "person" : "people"}`}
      testId="ops-users-list"
    >
      <ul>
        {operators.map((o) => (
          <OperatorRow
            key={o.userId}
            operator={o}
            clients={clients}
            onAddAll={onAddAll}
            onRemove={onRemove}
          />
        ))}
      </ul>
    </Card>
  );
}

function OperatorRow({
  operator: o,
  clients,
  onAddAll,
  onRemove,
}: {
  operator: OperatorMember;
  clients: number;
  onAddAll: (o: OperatorMember) => Promise<OperatorInviteResult>;
  onRemove: (o: OperatorMember) => Promise<void>;
}) {
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const testId = `ops-users-${o.email}`;
  const missing = clients - o.clients;
  return (
    <li data-testid={testId} className="border-b border-line px-6 py-4 last:border-b-0 max-sm:px-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium text-ink">{o.name ?? o.email}</p>
          {o.name ? <p className="truncate text-sm text-ink-muted">{o.email}</p> : null}
          <p className="mt-1 text-sm text-ink-muted" data-testid={`${testId}-clients`}>
            {o.clients === clients
              ? `Serves all ${clients} of your clients.`
              : `Serves ${o.clients} of your ${clients} clients.`}
          </p>
        </div>
        <span className="flex shrink-0 items-center gap-2">
          {o.signedIn === false ? <Badge>Invited</Badge> : null}
          {o.you ? <Tag tone="person">You</Tag> : <Tag>Operator</Tag>}
          {missing > 0 ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              data-testid={`${testId}-add-all`}
              onClick={() => {
                setBusy(true);
                setProblem(null);
                onAddAll(o)
                  .catch(() => setProblem("We couldn't add them. Try again."))
                  .finally(() => setBusy(false));
              }}
            >
              Give all my clients
            </Button>
          ) : null}
          {!o.you && !removing ? (
            <RemoveButton testId={testId} onClick={() => setRemoving(true)} />
          ) : null}
        </span>
      </div>
      {problem ? (
        <p role="alert" className="mt-2 text-sm text-risk">
          {problem}
        </p>
      ) : null}
      {removing ? (
        <div className="ds-banner mt-4 block" data-testid={`${testId}-remove-confirm`}>
          <p>
            {o.name ?? o.email} stops serving your {clients} clients and loses access to them within
            5 minutes. Anything waiting on them goes to the other operators.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              variant="primary"
              size="sm"
              disabled={busy}
              data-testid={`${testId}-remove-yes`}
              onClick={() => {
                setBusy(true);
                setProblem(null);
                onRemove(o)
                  .catch(() => {
                    setProblem("We couldn't remove them. Try again.");
                    setRemoving(false);
                  })
                  .finally(() => setBusy(false));
              }}
            >
              Remove
            </Button>
            <Button
              variant="ghost"
              size="sm"
              data-testid={`${testId}-remove-keep`}
              onClick={() => setRemoving(false)}
            >
              Keep them
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

function OperatorInviteForm({
  clients,
  onInvite,
}: {
  clients: number;
  onInvite: (body: { email: string; name?: string }) => Promise<OperatorInviteResult>;
}) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function submit() {
    if (!email.trim()) {
      setProblem("Enter an email address.");
      return;
    }
    setBusy(true);
    setProblem(null);
    setDone(null);
    try {
      const result = await onInvite({
        email: email.trim(),
        ...(name.trim() ? { name: name.trim() } : {}),
      });
      setDone(operatorInviteMessage(result));
      setEmail("");
      setName("");
    } catch (error) {
      setProblem(inviteProblem(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-5" testId="ops-users-invite">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field
          label="Email"
          error={problem ?? undefined}
          className="min-w-64 flex-1"
          testId="ops-users-invite-email"
        >
          <TextInput
            type="email"
            autoComplete="off"
            data-testid="ops-users-invite-email"
            value={email}
            invalid={!!problem}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="Name (optional)" className="min-w-48 flex-1">
          <TextInput
            data-testid="ops-users-invite-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Button type="submit" variant="primary" disabled={busy} data-testid="ops-users-invite-send">
          Invite
        </Button>
      </form>
      <p className="mt-3 text-sm text-ink-muted">
        They serve all {clients} of your clients and sign in with this address. A client you create
        later is served by you alone until you give it to them here.
      </p>
      {done ? (
        <p role="status" className="mt-2 text-sm text-ink" data-testid="ops-users-invite-done">
          {done}
        </p>
      ) : null}
    </Card>
  );
}
