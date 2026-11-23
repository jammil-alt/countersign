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
  type InviteResult,
  isOwnPerson,
  type Member,
} from "@countersign/core";
import { useEffect, useRef, useState } from "react";
import { isApiError } from "../api/client";
import type { PlainKey } from "../i18n/catalog";
import { EN, type I18n, useI18n } from "../i18n/i18n";
import { Field, Select } from "../ui/forms";
import { Icon } from "../ui/icons";
import { Badge, Button, buttonClass, cx } from "../ui/primitives";

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

/** "Remove" on a person's row; the row then shows `RemoveConfirm`. */
export function RemoveButton({ testId, onClick }: { testId: string; onClick: () => void }) {
  const { t } = useI18n();
  return (
    <Button size="sm" variant="ghost" data-testid={`${testId}-remove`} onClick={onClick}>
      {t("people.remove")}
    </Button>
  );
}

/**
 * Removing someone (de-provisioning, docs/security.md §2), after this confirmation. Their access
 * ends within 5 minutes, since an open session carries memberships for up to 5 minutes
 * (docs/plan.md §1.93); what waited on them goes to the client admin. `onRemove` reads the list
 * again, which takes the row away.
 */
export function RemoveConfirm({
  name,
  testId,
  onRemove,
  onCancel,
}: {
  name: string;
  testId: string;
  onRemove: () => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(false);
  const keep = useRef<HTMLButtonElement>(null);
  useEffect(() => keep.current?.focus(), []);
  return (
    <div className="ds-banner block" data-testid={`${testId}-remove-confirm`}>
      <p>{t("people.removeWarning", { name })}</p>
      {problem ? (
        <p role="alert" className="mt-1 font-medium" data-testid={`${testId}-remove-problem`}>
          {t("people.removeProblem")}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          variant="primary"
          size="sm"
          disabled={busy}
          data-testid={`${testId}-remove-yes`}
          onClick={() => {
            setBusy(true);
            setProblem(false);
            onRemove()
              .catch(() => setProblem(true))
              .finally(() => setBusy(false));
          }}
        >
          {t("people.remove")}
        </Button>
        <button
          type="button"
          ref={keep}
          className={buttonClass("ghost", undefined, "sm")}
          data-testid={`${testId}-remove-keep`}
          onClick={onCancel}
        >
          {t("people.removeKeep")}
        </button>
      </div>
    </div>
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
  // Overnight D3: a new user approves nothing until it is ticked.
  const [canSign, setCanSign] = useState(false);
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
