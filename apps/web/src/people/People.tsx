// A client's people and the invite form, shared by the back office's client settings and the
// portal's Settings (docs/plan.md §1.14). An invite is saved first; the email is reported after,
// so a failed email still leaves an invite the person can sign in with. Words come from the
// portal's message files (English in the back office, docs/plan.md §1.18).
import {
  type Contact,
  type ContactAccess,
  type ContactInviteBody,
  canInviteContact,
  type InvitableRole,
  type InviteBody,
  type InviteResult,
  isOwnPerson,
  type Member,
} from "@countersign/core";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { isApiError } from "../api/client";
import type { PlainKey } from "../i18n/catalog";
import { EN, type I18n, useI18n } from "../i18n/i18n";
import { Field, Select, TextInput } from "../ui/forms";
import { Icon } from "../ui/icons";
import { Badge, Button, Card, cx, EmptyState, Tag } from "../ui/primitives";

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
    case "not_invitable":
      return t("people.problem.notInvitable");
    case "no_email":
      return t("people.fromDirectory.addEmail");
    case "sandbox":
      // Back office only, so English.
      return "The Sandbox is our own test client: it has no client people.";
    default:
      return t("people.problem.failed");
  }
}

/** `action`: a control at the end of each person's row (the back office's sign-in reset). */
export function MemberList({
  members,
  testId,
  action,
}: {
  members: Member[];
  testId: string;
  action?: (member: Member) => ReactNode;
}) {
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
              {action?.(m)}
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

// ── Inviting from the directory (2026-11-08) ─────────────────────────────────────────────────────

/** Whether a person can sign in: "Can sign in", or "Invited, hasn't signed in yet". */
export function AccessBadge({
  access,
  testId,
}: {
  access: ContactAccess | null | undefined;
  testId: string;
}) {
  const { t } = useI18n();
  if (!access) return null;
  return access === "member" ? (
    <Badge tone="positive" testId={testId}>
      {t("people.access.member")}
    </Badge>
  ) : (
    <Badge testId={testId}>{t("people.access.invited")}</Badge>
  );
}

/**
 * "Invite to sign in" on one of the client's own people with an email who can't sign in yet; on an
 * own person with no email, a quiet "Add an email to invite"; on anyone else, nothing.
 */
export function InviteContactAction({
  person,
  surface,
  onInvite,
  onInvited,
  testId,
}: {
  person: Contact;
  surface: "ops" | "portal";
  onInvite(body: ContactInviteBody): Promise<InviteResult>;
  onInvited(): void;
  testId: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (person.access) return null;
  if (!canInviteContact(person, person.organization)) {
    return isOwnPerson(person, person.organization) ? (
      <span className="text-xs text-ink-muted" data-testid={`${testId}-no-email`}>
        {t("people.fromDirectory.addEmail")}
      </span>
    ) : null;
  }
  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        aria-haspopup="dialog"
        data-testid={testId}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        {t("people.fromDirectory.invite")}
      </Button>
      {open ? (
        <InviteContactDialog
          person={person}
          surface={surface}
          onInvite={onInvite}
          onClose={(sent) => {
            setOpen(false);
            if (sent) onInvited();
          }}
          testId={`${testId}-dialog`}
        />
      ) : null}
    </>
  );
}

/** The name and email as they are in the directory, a role and "can approve"; Send. */
export function InviteContactDialog({
  person,
  surface,
  onInvite,
  onClose,
  testId,
}: {
  person: Contact;
  surface: "ops" | "portal";
  onInvite(body: ContactInviteBody): Promise<InviteResult>;
  /** `sent`: an invite was made, so the list should read again. */
  onClose(sent: boolean): void;
  testId: string;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const [role, setRole] = useState<InvitableRole>("client_user");
  const [canSign, setCanSign] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const sent = done !== null;
  useEffect(() => heading.current?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close.current(sent);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sent]);
  const admin = role === "client_admin";

  async function send() {
    setBusy(true);
    setProblem(null);
    try {
      // A client admin always approves (ARCHITECTURE §4).
      const result = await onInvite({ role, canSign: admin ? true : canSign });
      setDone(inviteMessage(result, i18n));
    } catch (error) {
      setProblem(inviteProblem(error, surface, i18n));
    } finally {
      setBusy(false);
    }
  }

  const titleId = `${testId}-title`;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: clicks inside the dialog stay out of the row under it.
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="ds-scrim" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={testId}
        className={cx(
          "ds-dialog flex max-h-[calc(100vh-32px)] w-[480px] flex-col",
          "max-sm:h-full max-sm:max-h-none max-sm:w-full max-sm:max-w-none max-sm:rounded-none",
        )}
      >
        <div className="ds-dialog__body min-h-0 flex-1 overflow-y-auto">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2
                id={titleId}
                ref={heading}
                tabIndex={-1}
                className="type-subheading text-ink outline-none"
              >
                {t("people.fromDirectory.title")}
              </h2>
              <p className="text-sm text-ink-muted">{t("people.fromDirectory.help")}</p>
            </div>
            <button
              type="button"
              className="ds-btn ds-btn--ghost ds-btn--sm"
              aria-label={t("people.fromDirectory.close")}
              onClick={() => onClose(sent)}
            >
              <Icon name="close" />
            </button>
          </div>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
            <dt className="text-ink-muted">{t("directory.field.name")}</dt>
            <dd className="truncate text-ink" data-testid={`${testId}-name`}>
              {person.name}
            </dd>
            <dt className="text-ink-muted">{t("directory.field.email")}</dt>
            <dd className="truncate text-ink" data-testid={`${testId}-email`}>
              {person.email}
            </dd>
          </dl>
          {done ? (
            <p role="status" className="text-sm text-ink" data-testid={`${testId}-done`}>
              {done}
            </p>
          ) : (
            <>
              <Field label={t("people.role")} error={problem ?? undefined}>
                <Select
                  data-testid={`${testId}-role`}
                  value={role}
                  invalid={!!problem}
                  onChange={(e) => setRole(e.target.value as InvitableRole)}
                >
                  <option value="client_user">{t("people.role.client_user")}</option>
                  <option value="client_admin">{t("people.role.client_admin")}</option>
                </Select>
              </Field>
              {/* biome-ignore lint/a11y/useSemanticElements: the design system's Checkbox is a button with role=checkbox. */}
              <button
                type="button"
                role="checkbox"
                aria-checked={admin || canSign}
                disabled={admin}
                data-testid={`${testId}-can-sign`}
                onClick={() => setCanSign((v) => !v)}
                className="ds-choice disabled:opacity-60"
              >
                <span className="ds-check">{admin || canSign ? "✓" : ""}</span>
                {t("people.fromDirectory.canSign")}
              </button>
              <p className="text-sm text-ink-muted">
                {admin ? t("people.fromDirectory.adminSigns") : t("people.rolesHelp")}
              </p>
            </>
          )}
        </div>
        <div className="ds-dialog__foot">
          {done ? (
            <Button variant="primary" data-testid={`${testId}-close`} onClick={() => onClose(true)}>
              {t("people.fromDirectory.close")}
            </Button>
          ) : (
            <>
              <Button
                variant="ghost"
                data-testid={`${testId}-cancel`}
                onClick={() => onClose(false)}
              >
                {t("common.cancel")}
              </Button>
              <Button
                variant="primary"
                data-testid={`${testId}-send`}
                disabled={busy}
                onClick={() => void send()}
              >
                {busy ? t("common.sending") : t("common.send")}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
