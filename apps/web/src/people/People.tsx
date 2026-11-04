// A client's people and the invite form, shared by the back office's client settings and the
// portal's Settings (docs/plan.md §1.14). An invite is saved first; the email is reported after,
// so a failed email still leaves an invite the person can sign in with. Words come from the
// portal's message files (English in the back office, docs/plan.md §1.18).
import type { InvitableRole, InviteBody, InviteResult, Member } from "@countersign/core";
import { useState } from "react";
import { isApiError } from "../api/client";
import type { PlainKey } from "../i18n/catalog";
import { EN, type I18n, useI18n } from "../i18n/i18n";
import { Field, Select, TextInput } from "../ui/forms";
import { Badge, Button, Card, EmptyState, Tag } from "../ui/primitives";

export const ROLE_LABEL: Record<Member["role"], PlainKey> = {
  client_admin: "people.role.client_admin",
  client_user: "people.role.client_user",
  operator: "people.role.operator",
};

/** What the invitation email did, in plain words. */
export function inviteMessage(result: InviteResult, { t }: Pick<I18n, "t"> = EN): string {
  const email = result.member.email;
  switch (result.email.status) {
    case "sent":
      return t("people.invite.sent", { email });
    case "not_sent":
      return result.email.reason === "already_signed_up"
        ? t("people.invite.signedUpBefore", { email })
        : t("people.invite.noEmails", { email });
    default:
      return t("people.invite.emailFailed", { email });
  }
}

/** Why an invite was refused, in plain words. */
export function inviteProblem(
  error: unknown,
  surface: "ops" | "portal",
  { t }: Pick<I18n, "t"> = EN,
): string {
  const code = isApiError(error) ? error.code : null;
  switch (code) {
    case "already_member":
      return surface === "portal"
        ? t("people.problem.hasAccess")
        : // Back office only, so English.
          "That address is already in this client.";
    case "other_client":
      return t("people.problem.otherClient");
    case "is_operator":
      return t("people.problem.isOperator");
    case "unavailable":
      return t("people.problem.unavailable");
    case "invalid_request":
      return t("people.problem.noEmail");
    default:
      return t("people.problem.failed");
  }
}

export function MemberList({ members, testId }: { members: Member[]; testId: string }) {
  const { t } = useI18n();
  if (members.length === 0) return <EmptyState>{t("people.none")}</EmptyState>;
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
              {m.signedIn === false ? <Badge>{t("people.invited")}</Badge> : null}
              <Tag tone={m.role === "operator" ? "person" : "neutral"}>{t(ROLE_LABEL[m.role])}</Tag>
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
  const i18n = useI18n();
  const { t } = i18n;

  async function submit() {
    if (!email.trim()) {
      setProblem(t("people.problem.noEmail"));
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
        <Button type="submit" variant="primary" disabled={busy} data-testid={`${testId}-send`}>
          {t("people.invite")}
        </Button>
      </form>
      <p className="mt-3 text-sm text-ink-muted">{t("people.rolesHelp")}</p>
      {done ? (
        <p role="status" className="mt-2 text-sm text-ink" data-testid={`${testId}-done`}>
          {done}
        </p>
      ) : null}
    </Card>
  );
}
