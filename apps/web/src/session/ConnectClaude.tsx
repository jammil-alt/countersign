// `/ops/connect-claude/:code` and `/connect-claude/:code` (docs/plan.md §1.120): a Claude connection
// to Mezonas' MCP server waits here for the person's approval. Claude signs in through AuthKit, which
// never passes our second step, so while the step is on its tool calls are answered with this link;
// the person, signed in here past the step, approves it. It lasts until that Claude sign-in ends,
// 12 hours at most. One screen in both shells: an operator's link opens the back office, a client's
// the portal. Audit 5.3: the page says when Claude asked with this link, and approving takes the
// short code Claude showed beside it, typed here, so it is never one click on a link alone.
import { CLAUDE_CONFIRM_DIGITS, type ClaudeConnection } from "@countersign/core";
import { type ReactNode, useState } from "react";
import { useParams } from "react-router-dom";
import { isApiError } from "../api/client";
import { apiRoutes } from "../api/routes";
import { useApi, useApiClient } from "../api/useApi";
import { useI18n } from "../i18n/i18n";
import { Field, TextInput } from "../ui/forms";
import { Page } from "../ui/page";
import { Badge, Button, Card, ErrorNotice, Loading, PageHeader } from "../ui/primitives";

/** The link's code, as the API's contract has it (anything else matches nothing). */
const CODE = /^[a-z2-7]{32}$/;
/** The code Claude showed beside the link: digits only, spaces and dashes typed with it dropped. */
const confirmOf = (typed: string) => typed.replace(/[\s-]/g, "");
const CONFIRM = new RegExp(`^[0-9]{${CLAUDE_CONFIRM_DIGITS}}$`);

export function ConnectClaudeScreen() {
  const { t } = useI18n();
  const { code = "" } = useParams();
  const valid = CODE.test(code);
  const state = useApi(apiRoutes.claudeConnection, valid ? { params: { code } } : null);
  // The answer to Approve replaces the first read.
  const [approved, setApproved] = useState<ClaudeConnection | null>(null);
  const connection = approved ?? state.data;

  let body: ReactNode;
  if (!valid || (isApiError(state.error) && state.error.status === 404)) {
    body = (
      <p className="text-ink" data-testid="connect-claude-unknown">
        {t("connectClaude.unknown")}
      </p>
    );
  } else if (connection) {
    body = <ConnectionCard code={code} connection={connection} onApproved={setApproved} />;
  } else if (state.error) {
    body = <ErrorNotice error={state.error} onRetry={state.reload} />;
  } else {
    body = <Loading />;
  }

  return (
    <Page width="narrow" testId="connect-claude">
      <PageHeader title={t("connectClaude.title")} subtitle={t("connectClaude.subtitle")} />
      {body}
    </Page>
  );
}

function ConnectionCard({
  code,
  connection,
  onApproved,
}: {
  code: string;
  connection: ClaudeConnection;
  onApproved: (c: ClaudeConnection) => void;
}) {
  const { t, fmt } = useI18n();
  const api = useApiClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [typed, setTyped] = useState("");
  const confirm = confirmOf(typed);
  const started = fmt.time(connection.startedAt);
  const until = fmt.time(connection.expiresAt);
  const requested = connection.requestedAt ? fmt.time(connection.requestedAt) : null;

  async function approve() {
    if (!CONFIRM.test(confirm)) return;
    setBusy(true);
    setError(null);
    try {
      onApproved(
        await api.call(apiRoutes.claudeConnectionApprove, {
          params: { code },
          body: { confirm },
        }),
      );
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const badge =
    connection.status === "approved" ? (
      <Badge tone="positive">{t("connectClaude.status.approved")}</Badge>
    ) : connection.status === "expired" ? (
      <Badge>{t("connectClaude.status.expired")}</Badge>
    ) : (
      <Badge tone="warning">{t("connectClaude.status.waiting")}</Badge>
    );

  return (
    <Card title={t("connectClaude.card")} meta={badge} pad testId="connect-claude-card">
      {connection.status === "approved" ? (
        <p className="text-ink" data-testid="connect-claude-approved">
          {t("connectClaude.approved", { time: until })}
        </p>
      ) : connection.status === "expired" ? (
        <p className="text-ink" data-testid="connect-claude-expired">
          {t("connectClaude.expired")}
        </p>
      ) : (
        <form
          className="flex flex-col gap-4"
          data-testid="connect-claude-waiting"
          onSubmit={(e) => {
            e.preventDefault();
            void approve();
          }}
        >
          <p className="text-ink">{t("connectClaude.waiting", { time: started })}</p>
          {requested ? (
            <p className="text-ink" data-testid="connect-claude-requested">
              {t("connectClaude.requested", { time: requested })}
            </p>
          ) : null}
          <Field label={t("connectClaude.confirm")} hint={t("connectClaude.confirmHint")}>
            <TextInput
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              inputMode="numeric"
              autoComplete="off"
              maxLength={CLAUDE_CONFIRM_DIGITS + 4}
              className="w-40"
              data-testid="connect-claude-confirm"
            />
          </Field>
          <p className="text-sm text-ink-muted">{t("connectClaude.lasts", { time: until })}</p>
          <div>
            <Button
              type="submit"
              variant="primary"
              disabled={busy || !CONFIRM.test(confirm)}
              data-testid="connect-claude-approve"
            >
              {busy ? t("connectClaude.approving") : t("connectClaude.approve")}
            </Button>
          </div>
          {error ? <ErrorNotice error={error} /> : null}
        </form>
      )}
    </Card>
  );
}
