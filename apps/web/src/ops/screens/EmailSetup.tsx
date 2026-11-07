// Email sending for a client (plan §1.25), on the back office's messaging page: Mezonas' sending
// service (Resend) sends from an address on the client's own domain once its DNS records are
// verified, and from ours until then. The operator adds the domain, shows the client the records
// to add, and checks them. Replies come back to the client's forwarding address.
import type { EmailSetup } from "@countersign/core";
import { useState } from "react";
import { isApiError } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { Field, TextInput } from "../../ui/forms";
import { Badge, Button, Card, ErrorNotice, Loading, SectionLabel } from "../../ui/primitives";

export function EmailPanel({ clientId }: { clientId: string }) {
  const api = useApiClient();
  const res = useApi(apiRoutes.opsEmail, { params: { id: clientId } });
  const [override, setOverride] = useState<EmailSetup | null>(null);
  const setup = override ?? res.data?.setup;
  const [domain, setDomain] = useState("");
  const [localPart, setLocalPart] = useState("assistant");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(call: () => Promise<{ setup: EmailSetup }>) {
    setBusy(true);
    setError(null);
    try {
      setOverride((await call()).setup);
    } catch (e) {
      setError(isApiError(e) ? e.message : "That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (res.error) return <ErrorNotice error={res.error} onRetry={res.reload} />;
  if (!setup) return <Loading />;
  const conn = setup.connection;
  return (
    <Card className="p-5" testId="ops-email">
      <SectionLabel>Email</SectionLabel>
      {!setup.available ? (
        <p className="text-sm text-ink-muted">
          Agents can't send email for Mezonas yet. An engineer sets up our sending account.
        </p>
      ) : null}
      {conn ? (
        <div className="mb-4 flex flex-col gap-2 text-sm">
          <p className="text-ink">
            Agents send from <span className="figures">{conn.from}</span>.
            {conn.domain && conn.domainStatus !== "verified"
              ? ` Once ${conn.domain} is verified, from that domain instead.`
              : ""}
          </p>
          {conn.domain ? (
            <p>
              <Badge
                tone={conn.domainStatus === "verified" ? "positive" : "warning"}
                testId="ops-email-domain-status"
              >
                {conn.domain}: {conn.domainStatus === "verified" ? "verified" : "waiting on DNS"}
              </Badge>
            </p>
          ) : null}
          <p className="text-ink-muted">
            {setup.replyTo
              ? `Replies come back to ${setup.replyTo}.`
              : "Replies aren't read until the client has a forwarding address."}
          </p>
        </div>
      ) : null}
      {conn?.records.length ? (
        <div className="dt dt-ana mb-4 overflow-x-auto">
          <table data-testid="ops-email-records">
            <thead>
              <tr className="dt-cols">
                <th>Type</th>
                <th>Name</th>
                <th>Value</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {conn.records.map((r) => (
                <tr key={`${r.type}:${r.name}`}>
                  <td>{r.type}</td>
                  <td className="figures">{r.name}</td>
                  <td className="figures break-all">
                    {r.priority !== null ? `${r.priority} ` : ""}
                    {r.value}
                  </td>
                  <td>{r.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <form
        className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_160px_auto] sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          void act(() =>
            api.call(apiRoutes.opsEmailConnect, {
              params: { id: clientId },
              body: { domain: domain.trim() || conn?.domain || null, localPart },
            }),
          );
        }}
      >
        <Field label="The client's domain" hint="Empty: send from ours.">
          <TextInput
            value={domain}
            placeholder={conn?.domain ?? "shop.com"}
            onChange={(e) => setDomain(e.target.value)}
            data-testid="ops-email-domain"
          />
        </Field>
        <Field label="Address">
          <TextInput value={localPart} onChange={(e) => setLocalPart(e.target.value)} />
        </Field>
        <Button
          type="submit"
          variant="primary"
          disabled={busy || !setup.available}
          data-testid="ops-email-save"
        >
          {conn ? "Update" : "Set up email"}
        </Button>
      </form>
      {conn?.domain && conn.domainStatus !== "verified" ? (
        <div className="mt-3">
          <Button
            disabled={busy}
            onClick={() =>
              void act(() => api.call(apiRoutes.opsEmailVerify, { params: { id: clientId } }))
            }
            data-testid="ops-email-verify"
          >
            Check the DNS records
          </Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="ds-error mt-3 text-sm">
          {error}
        </p>
      ) : null}
    </Card>
  );
}
