// `/ops/connect-claude/:code`: a Claude connection to the back office (the Ops MCP connector,
// docs/plan.md §1.34) waits here for its operator's approval (§1.83). Claude signs in through
// AuthKit, which has no second step of its own, so the operator, signed in here past the second
// step, approves it. It lasts until that Claude sign-in ends, 12 hours at most.
import type { ClaudeConnection } from "@countersign/core";
import { type ReactNode, useState } from "react";
import { useParams } from "react-router-dom";
import { isApiError } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { shortTime } from "../../runs/format";
import { Page } from "../../ui/page";
import { Badge, Button, Card, ErrorNotice, Loading, PageHeader } from "../../ui/primitives";

const CODE = /^[A-Za-z0-9_-]{16,64}$/;

export function ConnectClaudeScreen() {
  const { code = "" } = useParams();
  const valid = CODE.test(code);
  const state = useApi(apiRoutes.opsClaudeConnection, valid ? { params: { code } } : null);
  // The answer to Approve replaces the first read.
  const [approved, setApproved] = useState<ClaudeConnection | null>(null);
  const connection = approved ?? state.data;

  let body: ReactNode;
  if (!valid || (isApiError(state.error) && state.error.status === 404)) {
    body = (
      <p className="text-ink" data-testid="connect-claude-unknown">
        This link doesn't match a Claude connection. Connect Claude again to get a new link.
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
      <PageHeader
        title="Connect Claude"
        subtitle="Claude can use the back office as you once you approve it here."
      />
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
  const api = useApiClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const started = shortTime(connection.startedAt);
  const until = shortTime(connection.expiresAt);

  async function approve() {
    setBusy(true);
    setError(null);
    try {
      onApproved(await api.call(apiRoutes.opsClaudeConnectionApprove, { params: { code } }));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const badge =
    connection.status === "approved" ? (
      <Badge tone="positive">Approved</Badge>
    ) : connection.status === "expired" ? (
      <Badge>Expired</Badge>
    ) : (
      <Badge tone="warning">Waiting for approval</Badge>
    );

  return (
    <Card title="Claude connection" meta={badge} pad testId="connect-claude-card">
      {!connection.yours ? (
        <p className="text-ink" data-testid="connect-claude-not-yours">
          This connection belongs to another person. It can't be approved here.
        </p>
      ) : connection.status === "approved" ? (
        <p className="text-ink" data-testid="connect-claude-approved">
          Approved. Claude can use the back office as you until {until}, or until you sign out of
          Claude.
        </p>
      ) : connection.status === "expired" ? (
        <p className="text-ink" data-testid="connect-claude-expired">
          This request has expired. Connect Claude again to get a new link.
        </p>
      ) : (
        <div className="flex flex-col gap-4" data-testid="connect-claude-waiting">
          <p className="text-ink">
            Claude is asking to use the Mezonas back office as you, started at {started}. Approve it
            only if you just connected Claude yourself.
          </p>
          <p className="text-sm text-ink-muted">
            It lasts until that Claude sign-in ends, at {until} at the latest.
          </p>
          <div>
            <Button
              variant="primary"
              disabled={busy}
              data-testid="connect-claude-approve"
              onClick={() => void approve()}
            >
              {busy ? "Approving…" : "Approve"}
            </Button>
          </div>
          {error ? <ErrorNotice error={error} /> : null}
        </div>
      )}
    </Card>
  );
}
