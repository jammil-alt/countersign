// The client admin's setup of the Webhooks connection (ARCHITECTURE §6.6): hooks to paste into a
// Zap (each a URL with its own secret) and the URL outbound events go to. Only the client admin
// sees this: the URLs are secrets, and the operator never does.
import { useState } from "react";
import { apiRoutes } from "../api/routes";
import { useApi, useApiClient } from "../api/useApi";
import { useI18n } from "../i18n/i18n";
import { shortTime } from "../runs/format";
import { Field, TextInput } from "../ui/forms";
import { Button, Card, EmptyState, ErrorNotice, Loading, SectionLabel } from "../ui/primitives";

function CopyButton({ value, testId }: { value: string; testId: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      data-testid={testId}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          },
          () => {},
        );
      }}
    >
      {copied ? t("common.copied") : t("common.copy")}
    </Button>
  );
}

export function WebhookSetup({ connectionId }: { connectionId: string }) {
  const api = useApiClient();
  const i18n = useI18n();
  const { t } = i18n;
  const { data, error, loading, reload } = useApi(apiRoutes.portalWebhook, {
    params: { id: connectionId },
    // Hook URLs carry their secret tokens, and the signing secret: never stored.
    cache: "none",
  });
  const [name, setName] = useState("");
  const [outbound, setOutbound] = useState<string | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function act(fn: () => Promise<unknown>) {
    setActionError(null);
    setBusy(true);
    try {
      await fn();
      reload();
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(false);
    }
  }

  const outboundValue = outbound ?? data?.outbound?.url ?? "";

  return (
    <section data-testid="webhook-setup">
      <SectionLabel>{t("webhook.section")}</SectionLabel>
      {loading && !data ? <Loading /> : null}
      {error ? <ErrorNotice error={error} onRetry={reload} /> : null}
      {actionError ? (
        <div className="mb-3">
          <ErrorNotice error={actionError} />
        </div>
      ) : null}
      {data ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card className="flex flex-col gap-3 p-4">
            <div>
              <p className="font-medium text-ink">{t("webhook.inTitle")}</p>
              <p className="text-sm text-ink-muted">{t("webhook.inHelp")}</p>
            </div>
            {data.hooks.length === 0 ? (
              <EmptyState>{t("webhook.noHooks")}</EmptyState>
            ) : (
              <ul data-testid="webhook-hooks" className="flex flex-col gap-3">
                {data.hooks.map((h) => (
                  <li key={h.id} className="flex flex-col gap-1.5 border-t border-line pt-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-ink">{h.name}</span>
                      <span className="text-sm text-ink-muted">
                        {t("webhook.made", { time: shortTime(h.createdAt, undefined, i18n) })}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <TextInput
                        readOnly
                        value={h.url}
                        aria-label={t("webhook.urlOf", { name: h.name })}
                        data-testid="webhook-hook-url"
                        className="font-mono text-sm"
                        onFocus={(e) => e.currentTarget.select()}
                      />
                      <CopyButton value={h.url} testId="webhook-hook-copy" />
                      <Button
                        size="sm"
                        variant="ghost"
                        data-testid="webhook-hook-remove"
                        disabled={busy}
                        onClick={() =>
                          void act(() =>
                            api.call(apiRoutes.portalWebhookRemoveHook, {
                              params: { id: connectionId, hookId: h.id },
                            }),
                          )
                        }
                      >
                        {t("webhook.remove")}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <form
              className="flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (!name.trim()) return;
                void act(async () => {
                  await api.call(apiRoutes.portalWebhookAddHook, {
                    params: { id: connectionId },
                    body: { name: name.trim() },
                  });
                  setName("");
                });
              }}
            >
              <Field label={t("webhook.newHook")} className="grow">
                <TextInput
                  placeholder={t("webhook.newHookPlaceholder")}
                  data-testid="webhook-hook-name"
                  value={name}
                  maxLength={80}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
              <Button type="submit" data-testid="webhook-hook-add" disabled={busy || !name.trim()}>
                {t("webhook.makeHook")}
              </Button>
            </form>
          </Card>

          <Card className="flex flex-col gap-3 p-4">
            <div>
              <p className="font-medium text-ink">{t("webhook.outTitle")}</p>
              <p className="text-sm text-ink-muted">{t("webhook.outHelp")}</p>
            </div>
            <form
              className="flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void act(async () => {
                  await api.call(apiRoutes.portalWebhookOutbound, {
                    params: { id: connectionId },
                    body: { url: outboundValue.trim() || null },
                  });
                  setOutbound(null);
                });
              }}
            >
              <Field label={t("webhook.sendTo")} className="grow">
                <TextInput
                  data-testid="webhook-outbound-url"
                  type="url"
                  value={outboundValue}
                  placeholder="https://hooks.zapier.com/hooks/catch/…"
                  onChange={(e) => setOutbound(e.target.value)}
                />
              </Field>
              <Button type="submit" data-testid="webhook-outbound-save" disabled={busy}>
                {t("common.save")}
              </Button>
            </form>
            {data.outbound ? (
              <div className="flex flex-col gap-1.5 text-sm">
                <p className="text-ink-muted">
                  {data.outbound.setAt
                    ? t("webhook.sendingToSince", {
                        host: data.outbound.host,
                        time: shortTime(data.outbound.setAt, undefined, i18n),
                      })
                    : t("webhook.sendingTo", { host: data.outbound.host })}
                </p>
                <p className="text-ink-muted">
                  {t("webhook.secretHelp", { header: "x-mezonas-signature" })}
                </p>
                <div className="flex items-center gap-2">
                  <TextInput
                    readOnly
                    value={data.outbound.signingSecret}
                    aria-label={t("webhook.secret")}
                    data-testid="webhook-signing-secret"
                    className="font-mono text-sm"
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  <CopyButton value={data.outbound.signingSecret} testId="webhook-secret-copy" />
                </div>
              </div>
            ) : (
              <p className="text-sm text-ink-muted">{t("webhook.noOutbound")}</p>
            )}
          </Card>
        </div>
      ) : null}
    </section>
  );
}
