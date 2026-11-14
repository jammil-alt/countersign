// The People page's texting pieces (docs/plan.md §1.98), loaded only for the client admin: the
// texting sign-up link to share, and invitations to sign up for texts for the people ticked.
import { TEXT_INVITE_BATCH_MAX } from "@countersign/core";
import { useState } from "react";
import { apiRoutes } from "../../api/routes";
import { useApiClient } from "../../api/useApi";
import { useI18n } from "../../i18n/i18n";
import { TextInput } from "../../ui/forms";
import { Button, Card, ErrorNotice } from "../../ui/primitives";

/**
 * Invite the people ticked to sign up for texts (docs/plan.md §1.98): each with an email address
 * gets one invitation from us in your name, and at most one reminder. Texting starts only when they
 * sign up themselves.
 */
// DECISION: sending keeps the selection and changes nothing on the list (an invitation isn't
// consent), so the result stays beside the button.
export function TextInviteBulk({ ids }: { ids: string[] }) {
  const { t } = useI18n();
  const api = useApiClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<{ sent: number; skipped: number } | null>(null);

  async function invite() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.call(apiRoutes.portalTextInvitations, {
        body: { contactIds: ids.slice(0, TEXT_INVITE_BATCH_MAX) },
      });
      setResult({ sent: res.sent.length, skipped: res.skipped.length });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 border-b border-line pb-3" data-testid="people-text-invite">
      <span className="text-sm font-medium text-ink">{t("peoplePage.textInvite")}</span>
      <span className="text-sm text-ink-muted">{t("peoplePage.textInviteHint")}</span>
      <div>
        <Button
          size="sm"
          onClick={() => void invite()}
          disabled={busy}
          data-testid="people-text-invite-send"
        >
          {t("peoplePage.textInviteSend")}
        </Button>
      </div>
      {result ? (
        <p role="status" className="text-sm text-ink" data-testid="people-text-invite-result">
          {t("peoplePage.textInviteDone", { count: result.sent })}
          {result.skipped > 0
            ? ` ${t("peoplePage.textInviteSkipped", { count: result.skipped })}`
            : ""}
        </p>
      ) : null}
      {error ? <ErrorNotice error={error} /> : null}
    </div>
  );
}

/**
 * Your texting sign-up link (docs/plan.md §1.98): share it with your people; each signs up for
 * texts on their own. A new link retires the old one.
 */
export function TextingSignupLink() {
  const { t } = useI18n();
  const api = useApiClient();
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);

  async function load(replace: boolean) {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const res = await api.call(
        replace ? apiRoutes.portalTextSignupLinkReplace : apiRoutes.portalTextSignupLink,
      );
      setUrl(res.url);
      setConfirming(false);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Card pad testId="people-signup-link">
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium text-ink">{t("peoplePage.signupLink")}</span>
        <span className="text-sm text-ink-muted">{t("peoplePage.signupLinkHint")}</span>
        {url ? (
          <div className="flex flex-wrap items-center gap-2">
            <TextInput
              readOnly
              value={url}
              className="min-w-0 flex-1"
              onFocus={(e) => e.currentTarget.select()}
              data-testid="people-signup-link-url"
            />
            <Button size="sm" onClick={() => void copy()} data-testid="people-signup-link-copy">
              {copied ? t("peoplePage.signupLinkCopied") : t("peoplePage.signupLinkCopy")}
            </Button>
            {confirming ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void load(true)}
                disabled={busy}
                data-testid="people-signup-link-replace-confirm"
              >
                {t("peoplePage.signupLinkReplaceConfirm")}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setConfirming(true)}
                data-testid="people-signup-link-replace"
              >
                {t("peoplePage.signupLinkReplace")}
              </Button>
            )}
          </div>
        ) : (
          <div>
            <Button
              size="sm"
              onClick={() => void load(false)}
              disabled={busy}
              data-testid="people-signup-link-show"
            >
              {t("peoplePage.signupLinkShow")}
            </Button>
          </div>
        )}
        {confirming ? (
          <span className="text-sm text-ink-muted">{t("peoplePage.signupLinkReplaceHint")}</span>
        ) : null}
        {error ? <ErrorNotice error={error} /> : null}
      </div>
    </Card>
  );
}
