// A client's people as the Team screen and the back office's client People list them, and the
// invite form (docs/plan.md §1.14, §1.122). Apart from ./People.tsx so the portal's first load
// (which has Contacts, and so People.tsx) doesn't carry them: Team loads when it is opened, and the
// back office is its own chunk (scripts/web-size.mjs).
import type {
  AssignableAgent,
  InvitableRole,
  InviteBody,
  InviteResult,
  Member,
} from "@countersign/core";
import { type ReactNode, useState } from "react";
import { useI18n } from "../i18n/i18n";
import { Field, Select, TextInput } from "../ui/forms";
import { Badge, Button, Card, EmptyState, Tag } from "../ui/primitives";
import { AccessEditor, AccessFields } from "./AccessLazy";
import { type AccessChoice, accessReady, agentsLine } from "./access-core";
import { inviteMessage, inviteProblem, RemoveButton, RemoveConfirm, ROLE_LABEL } from "./People";

export function MemberList({
  members,
  testId,
  action,
  onRemove,
  agents,
  onAccess,
}: {
  members: Member[];
  testId: string;
  /** The back office's own control for a person (§1.100: reset their sign-in); none in the portal. */
  action?: (member: Member) => ReactNode;
  /** Remove a client admin or user (never an operator: `db:remove-operator` does that). */
  onRemove?: (member: Member) => Promise<void>;
  /** §1.122: the client's agents, to name and change each user's. */
  agents?: readonly AssignableAgent[];
  /** §1.122: change a client person's role, signing and agents (never an operator's). */
  onAccess?: (member: Member, value: AccessChoice) => Promise<void>;
}) {
  const { t } = useI18n();
  if (members.length === 0) return <EmptyState>{t("people.none")}</EmptyState>;
  return (
    <Card className="overflow-hidden" testId={testId}>
      <ul>
        {members.map((m) => (
          <MemberRow
            key={m.userId}
            member={m}
            testId={`${testId}-${m.email}`}
            action={action}
            onRemove={onRemove && m.role !== "operator" ? () => onRemove(m) : undefined}
            agents={agents}
            onAccess={onAccess && m.role !== "operator" ? (v) => onAccess(m, v) : undefined}
          />
        ))}
      </ul>
    </Card>
  );
}

function MemberRow({
  member: m,
  testId,
  action,
  onRemove,
  agents,
  onAccess,
}: {
  member: Member;
  testId: string;
  action: ((member: Member) => ReactNode) | undefined;
  onRemove: (() => Promise<void>) | undefined;
  agents: readonly AssignableAgent[] | undefined;
  onAccess: ((value: AccessChoice) => Promise<void>) | undefined;
}) {
  const { t } = useI18n();
  const [removing, setRemoving] = useState(false);
  const [editing, setEditing] = useState(false);
  return (
    <li
      data-testid={testId}
      className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3 last:border-b-0"
    >
      <span className="min-w-0">
        <span className="block font-medium text-ink">{m.name ?? m.email}</span>
        {m.name ? <span className="block text-sm text-ink-muted">{m.email}</span> : null}
        {m.role === "client_user" && agents ? (
          <span className="block text-sm text-ink-muted" data-testid={`${testId}-agents`}>
            {agentsLine(m.agentIds, agents, t)}
            {m.canSign === false ? ` ${t("teamPage.viewer")}` : ""}
          </span>
        ) : null}
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {m.signedIn === false ? <Badge>{t("people.invited")}</Badge> : null}
        <Tag tone={m.role === "operator" ? "person" : "neutral"}>{t(ROLE_LABEL[m.role])}</Tag>
        {onAccess && agents && !editing ? (
          <Button
            size="sm"
            variant="ghost"
            data-testid={`${testId}-access-toggle`}
            onClick={() => setEditing(true)}
          >
            {t("access.edit")}
          </Button>
        ) : null}
        {onRemove && !removing ? (
          <RemoveButton testId={testId} onClick={() => setRemoving(true)} />
        ) : null}
      </span>
      {action ? <div className="w-full">{action(m)}</div> : null}
      {onAccess && agents && editing ? (
        <div className="w-full">
          <AccessEditor
            name={m.name ?? m.email}
            initial={{
              role: m.role === "client_admin" ? "client_admin" : "client_user",
              canSign: m.canSign ?? true,
              agentIds: m.role === "client_user" ? (m.agentIds ?? null) : null,
            }}
            agents={agents}
            onSave={onAccess}
            onDone={() => setEditing(false)}
            testId={`${testId}-access`}
          />
        </div>
      ) : null}
      {onRemove && removing ? (
        <div className="w-full">
          <RemoveConfirm
            name={m.name ?? m.email}
            testId={testId}
            onRemove={onRemove}
            onCancel={() => setRemoving(false)}
          />
        </div>
      ) : null}
    </li>
  );
}

/**
 * Email, name and role; `onInvite` sends it and answers the result. With `agents` (§1.122), a
 * user's access too: whether they approve, and all agents or only some.
 */
export function InviteForm({
  surface,
  onInvite,
  testId,
  agents,
}: {
  surface: "ops" | "portal";
  onInvite(body: InviteBody): Promise<InviteResult>;
  testId: string;
  agents?: readonly AssignableAgent[];
}) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<InvitableRole>("client_user");
  const [access, setAccess] = useState<AccessChoice>({
    role: "client_user",
    canSign: true,
    agentIds: null,
  });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const i18n = useI18n();
  const { t } = i18n;

  async function submit() {
    if (!email.trim()) {
      setProblem(t("people.problem.noEmail"));
      return;
    }
    if (agents && !accessReady(access)) {
      setProblem(t("access.pickOne"));
      return;
    }
    setBusy(true);
    setProblem(null);
    setDone(null);
    try {
      const result = await onInvite({
        email: email.trim(),
        ...(agents
          ? {
              role: access.role,
              ...(access.role === "client_user"
                ? { canSign: access.canSign, agentIds: access.agentIds }
                : {}),
            }
          : { role }),
        ...(name.trim() ? { name: name.trim() } : {}),
      });
      setDone(inviteMessage(result, i18n));
      setEmail("");
      setName("");
    } catch (error) {
      setProblem(inviteProblem(error, surface, i18n));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mt-3 p-5" testId={testId}>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field
          label={t("people.email")}
          error={problem ?? undefined}
          className="min-w-64 flex-1"
          testId={`${testId}-email`}
        >
          <TextInput
            type="email"
            autoComplete="off"
            data-testid={`${testId}-email`}
            value={email}
            invalid={!!problem}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label={t("people.name")} className="min-w-48 flex-1">
          <TextInput
            data-testid={`${testId}-name`}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        {agents ? null : (
          <Field label={t("people.role")} className="w-40">
            <Select
              data-testid={`${testId}-role`}
              value={role}
              onChange={(e) => setRole(e.target.value as InvitableRole)}
            >
              <option value="client_user">{t("people.role.client_user")}</option>
              <option value="client_admin">{t("people.role.client_admin")}</option>
            </Select>
          </Field>
        )}
        {agents ? (
          <div className="w-full">
            <AccessFields value={access} onChange={setAccess} agents={agents} testId={testId} />
          </div>
        ) : null}
        <Button type="submit" variant="primary" disabled={busy} data-testid={`${testId}-send`}>
          {t("people.invite")}
        </Button>
      </form>
      <p className="mt-3 text-sm text-ink-muted">
        {t("people.rolesHelp")}
        {agents ? ` ${t("access.limitedHelp")}` : ""}
      </p>
      {done ? (
        <p role="status" className="mt-2 text-sm text-ink" data-testid={`${testId}-done`}>
          {done}
        </p>
      ) : null}
    </Card>
  );
}
