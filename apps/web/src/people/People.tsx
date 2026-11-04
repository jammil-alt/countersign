// A client's people and the invite form, shared by the back office's client settings and the
// portal's Settings (docs/plan.md §1.14). An invite is saved first; the email is reported after,
// so a failed email still leaves an invite the person can sign in with.
import type { InvitableRole, InviteBody, InviteResult, Member } from "@countersign/core";
import { useState } from "react";
import { isApiError } from "../api/client";
import { Field, Select, TextInput } from "../ui/forms";
import { Badge, Button, Card, EmptyState, Tag } from "../ui/primitives";

export const ROLE_LABEL: Record<Member["role"], string> = {
  client_admin: "Admin",
  client_user: "User",
  operator: "Mezonas",
};

/** What the invitation email did, in plain words. */
export function inviteMessage(result: InviteResult): string {
  const who = result.member.email;
  switch (result.email.status) {
    case "sent":
      return `We emailed ${who} an invitation.`;
    case "not_sent":
      return result.email.reason === "already_signed_up"
        ? `Added ${who}. They've signed in before, so there was nothing to email.`
        : `Invited ${who}. This environment sends no emails: they can sign in with that address now.`;
    default:
      return `Invited ${who}, but the email didn't send. Ask them to sign in with that address.`;
  }
}

/** Why an invite was refused, in plain words. */
export function inviteProblem(error: unknown, surface: "ops" | "portal"): string {
  const code = isApiError(error) ? error.code : null;
  switch (code) {
    case "already_member":
      return surface === "portal"
        ? "That address already has access."
        : "That address is already in this client.";
    case "other_client":
      return "That address belongs to another client.";
    case "is_operator":
      return "That address belongs to a Mezonas operator.";
    case "unavailable":
      return "That address can't be invited here. Ask us and we'll sort it out.";
    case "invalid_request":
      return "Enter an email address.";
    default:
      return "We couldn't send that invite. Try again.";
  }
}

export function MemberList({ members, testId }: { members: Member[]; testId: string }) {
  if (members.length === 0) return <EmptyState>Nobody yet. Invite someone below.</EmptyState>;
  return (
    <Card className="overflow-hidden" testId={testId}>
      <ul>
        {members.map((m) => (
          <li
            key={m.userId}
            data-testid={`${testId}-${m.email}`}
            className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3 last:border-b-0"
          >
            <span className="min-w-0">
              <span className="block font-medium text-ink">{m.name ?? m.email}</span>
              {m.name ? <span className="block text-sm text-ink-muted">{m.email}</span> : null}
            </span>
            <span className="flex shrink-0 items-center gap-2">
              {m.signedIn === false ? <Badge>Invited</Badge> : null}
              <Tag tone={m.role === "operator" ? "person" : "neutral"}>{ROLE_LABEL[m.role]}</Tag>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Email, name and role; `onInvite` sends it and answers the result. */
export function InviteForm({
  surface,
  onInvite,
  testId,
}: {
  surface: "ops" | "portal";
  onInvite(body: InviteBody): Promise<InviteResult>;
  testId: string;
}) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<InvitableRole>("client_user");
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
        role,
        ...(name.trim() ? { name: name.trim() } : {}),
      });
      setDone(inviteMessage(result));
      setEmail("");
      setName("");
    } catch (error) {
      setProblem(inviteProblem(error, surface));
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
          label="Email"
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
        <Field label="Name (optional)" className="min-w-48 flex-1">
          <TextInput
            data-testid={`${testId}-name`}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Role" className="w-40">
          <Select
            data-testid={`${testId}-role`}
            value={role}
            onChange={(e) => setRole(e.target.value as InvitableRole)}
          >
            <option value="client_user">User</option>
            <option value="client_admin">Admin</option>
          </Select>
        </Field>
        <Button type="submit" variant="primary" disabled={busy} data-testid={`${testId}-send`}>
          Invite
        </Button>
      </form>
      <p className="mt-3 text-sm text-ink-muted">
        Admins connect tools, approve changes and invite people. Users see the inbox items given to
        them, runs and reports.
      </p>
      {done ? (
        <p role="status" className="mt-2 text-sm text-ink" data-testid={`${testId}-done`}>
          {done}
        </p>
      ) : null}
    </Card>
  );
}
