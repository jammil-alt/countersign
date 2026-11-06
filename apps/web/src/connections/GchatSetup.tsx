// v0.14 W4-E: the client admin's Google Chat card (docs/plan.md §1.60): the spaces connected to
// this client, a one-time code to connect another (shown once, when it is made), and disconnecting
// a space. A space is connected by mentioning the Mezonas app with the code in it.
import { useState } from "react";
import type { ResponseOf } from "../api/client";
import { apiRoutes } from "../api/routes";
import { useApi, useApiClient } from "../api/useApi";
import { useI18n } from "../i18n/i18n";
import { shortTime } from "../runs/format";
import { Button, Card, EmptyState, ErrorNotice, Loading, SectionLabel } from "../ui/primitives";

type Setup = ResponseOf<typeof apiRoutes.portalGchat>;

export function GchatSetup({ connectionId }: { connectionId: string }) {
  const api = useApiClient();
  const i18n = useI18n();
  const { t } = i18n;
  const { data, error, loading, reload } = useApi(apiRoutes.portalGchat, {
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
    <section data-testid="gchat-setup">
      <SectionLabel>{t("gchat.section")}</SectionLabel>
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
              <p className="font-medium text-ink">{t("gchat.spacesTitle")}</p>
              <p className="text-sm text-ink-muted">{t("gchat.help")}</p>
            </div>
            {view.spaces.length === 0 ? (
              <EmptyState>{t("gchat.noSpaces")}</EmptyState>
            ) : (
              <ul data-testid="gchat-spaces" className="flex flex-col gap-3">
                {view.spaces.map((s) => (
                  <li
                    key={s.name}
                    className="flex items-center justify-between gap-2 border-t border-line pt-3"
                  >
                    <div className="min-w-0">
                      <p className="font-medium text-ink">
                        {s.displayName ?? t("gchat.groupChat")}
                      </p>
                      <p className="text-sm text-ink-muted">
                        {s.boundBy
                          ? t("gchat.boundBy", {
                              time: shortTime(s.boundAt, undefined, i18n),
                              name: s.boundBy,
                            })
                          : t("gchat.boundAt", { time: shortTime(s.boundAt, undefined, i18n) })}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      data-testid="gchat-space-disconnect"
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          await api.call(apiRoutes.portalGchatUnbind, {
                            params: { id: connectionId, spaceId: s.name.slice("spaces/".length) },
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
              <p className="font-medium text-ink">{t("gchat.codeTitle")}</p>
              <p className="text-sm text-ink-muted">{t("gchat.steps")}</p>
            </div>
            {mention && made?.pendingCodeExpiresAt ? (
              <div className="flex flex-col gap-1.5">
                <p data-testid="gchat-code" className="font-mono text-lg text-ink">
                  {mention}
                </p>
                <p className="text-sm text-ink-muted">
                  {t("gchat.codeExpires", {
                    time: shortTime(made.pendingCodeExpiresAt, undefined, i18n),
                  })}
                </p>
              </div>
            ) : view.pendingCodeExpiresAt ? (
              <p className="text-sm text-ink-muted">
                {t("gchat.codeWaiting", {
                  time: shortTime(view.pendingCodeExpiresAt, undefined, i18n),
                })}
              </p>
            ) : null}
            <div>
              <Button
                variant="primary"
                data-testid="gchat-get-code"
                disabled={busy}
                onClick={() =>
                  void act(() =>
                    api.call(apiRoutes.portalGchatCode, { params: { id: connectionId }, body: {} }),
                  )
                }
              >
                {code || view.pendingCodeExpiresAt ? t("gchat.newCode") : t("gchat.getCode")}
              </Button>
            </div>
            <p className="text-sm text-ink-muted">{t("gchat.adminAllow")}</p>
          </Card>
        </div>
      ) : null}
    </section>
  );
}
