// §1.97: the client admin's Microsoft Teams card (docs/plan.md §1.97), as Google Chat's: the
// channels connected to this client, a one-time code to connect another (shown once, when it is
// made), and disconnecting a channel. A channel is connected by mentioning the Mezonas bot with the
// code in it.
import { useState } from "react";
import type { ResponseOf } from "../api/client";
import { apiRoutes } from "../api/routes";
import { useApi, useApiClient } from "../api/useApi";
import { useI18n } from "../i18n/i18n";
import { shortTime } from "../runs/format";
import { Button, Card, EmptyState, ErrorNotice, Loading, SectionLabel } from "../ui/primitives";

type Setup = ResponseOf<typeof apiRoutes.portalTeams>;

export function TeamsSetup({ connectionId }: { connectionId: string }) {
  const api = useApiClient();
  const i18n = useI18n();
  const { t } = i18n;
  const { data, error, loading, reload } = useApi(apiRoutes.portalTeams, {
    params: { id: connectionId },
  });
  const [made, setMade] = useState<Setup | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const view = made ?? data;

  async function act(fn: () => Promise<Setup | null>) {
    setActionError(null);
    setBusy(true);
    try {
      setMade(await fn());
      reload();
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(false);
    }
  }

  const code = made?.newCode ?? null;
  const mention = code ? `@Mezonas ${code}` : null;

  return (
    <section data-testid="teams-setup">
      <SectionLabel>{t("teams.section")}</SectionLabel>
      {loading && !view ? <Loading /> : null}
      {error ? <ErrorNotice error={error} onRetry={reload} /> : null}
      {actionError ? (
        <div className="mb-3">
          <ErrorNotice error={actionError} />
        </div>
      ) : null}
      {view ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card className="flex flex-col gap-3 p-4">
            <div>
              <p className="font-medium text-ink">{t("teams.channelsTitle")}</p>
              <p className="text-sm text-ink-muted">{t("teams.help")}</p>
            </div>
            {view.channels.length === 0 ? (
              <EmptyState>{t("teams.noChannels")}</EmptyState>
            ) : (
              <ul data-testid="teams-channels" className="flex flex-col gap-3">
                {view.channels.map((c) => (
                  <li
                    key={c.channelId}
                    className="flex items-center justify-between gap-2 border-t border-line pt-3"
                  >
                    <div className="min-w-0">
                      <p className="font-medium text-ink">{c.label}</p>
                      <p className="text-sm text-ink-muted">
                        {c.boundBy
                          ? t("teams.boundBy", {
                              time: shortTime(c.boundAt, undefined, i18n),
                              name: c.boundBy,
                            })
                          : t("teams.boundAt", { time: shortTime(c.boundAt, undefined, i18n) })}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      data-testid="teams-channel-disconnect"
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          await api.call(apiRoutes.portalTeamsUnbind, {
                            params: { id: connectionId, channelId: c.channelId },
                          });
                          return null;
                        })
                      }
                    >
                      {t("connections.disconnect")}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="flex flex-col gap-3 p-4">
            <div>
              <p className="font-medium text-ink">{t("teams.codeTitle")}</p>
              <p className="text-sm text-ink-muted">{t("teams.steps")}</p>
            </div>
            {mention && made?.pendingCodeExpiresAt ? (
              <div className="flex flex-col gap-1.5">
                <p data-testid="teams-code" className="font-mono text-lg text-ink">
                  {mention}
                </p>
                <p className="text-sm text-ink-muted">
                  {t("teams.codeExpires", {
                    time: shortTime(made.pendingCodeExpiresAt, undefined, i18n),
                  })}
                </p>
              </div>
            ) : view.pendingCodeExpiresAt ? (
              <p className="text-sm text-ink-muted">
                {t("teams.codeWaiting", {
                  time: shortTime(view.pendingCodeExpiresAt, undefined, i18n),
                })}
              </p>
            ) : null}
            <div>
              <Button
                variant="primary"
                data-testid="teams-get-code"
                disabled={busy}
                onClick={() =>
                  void act(() =>
                    api.call(apiRoutes.portalTeamsCode, { params: { id: connectionId }, body: {} }),
                  )
                }
              >
                {code || view.pendingCodeExpiresAt ? t("teams.newCode") : t("teams.getCode")}
              </Button>
            </div>
            <p className="text-sm text-ink-muted">{t("teams.adminAllow")}</p>
          </Card>
        </div>
      ) : null}
    </section>
  );
}
