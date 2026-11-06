// v0.14 W4-C: the client admin's channel picker for the Slack connection (docs/plan.md §1.56).
// Agents may post only to the channels picked here. The list comes live from Slack (public
// channels), with whether the Mezonas app is in each: Slack lets it post only where it is. Only the
// client admin sees this; the operator never picks for a client.
import { useState } from "react";
import { apiRoutes } from "../api/routes";
import { useApi, useApiClient } from "../api/useApi";
import { useI18n } from "../i18n/i18n";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Loading,
  SectionLabel,
} from "../ui/primitives";

export function SlackChannels() {
  const api = useApiClient();
  const { t } = useI18n();
  const { data, error, loading, reload } = useApi(apiRoutes.portalSlackChannels);
  /** The admin's unsaved picks; null while they match what is saved. */
  const [draft, setDraft] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);

  const savedIds = data?.picked.map((p) => p.id) ?? [];
  const picked = draft ?? savedIds;
  // Picks Slack no longer lists (renamed, archived or made private) stay until removed.
  const unlisted = data?.picked.filter((p) => !data.channels.some((c) => c.id === p.id)) ?? [];

  function toggle(id: string, on: boolean) {
    setSaved(false);
    setDraft((d) => {
      const now = d ?? savedIds;
      return on ? [...now.filter((x) => x !== id), id] : now.filter((x) => x !== id);
    });
  }

  async function save() {
    setActionError(null);
    setBusy(true);
    try {
      await api.call(apiRoutes.portalSlackPick, { body: { channels: picked } });
      setDraft(null);
      setSaved(true);
      reload();
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section data-testid="slack-channels">
      <SectionLabel>{t("slack.section")}</SectionLabel>
      {loading && !data ? <Loading /> : null}
      {error ? <ErrorNotice error={error} onRetry={reload} /> : null}
      {data ? (
        <Card className="flex flex-col gap-3 p-4">
          <div>
            <p className="font-medium text-ink">{t("slack.workspace", { name: data.workspace })}</p>
            <p className="text-sm text-ink-muted">{t("slack.help")}</p>
          </div>
          {data.channels.length === 0 && unlisted.length === 0 ? (
            <EmptyState>{t("slack.noChannels")}</EmptyState>
          ) : (
            <ul data-testid="slack-channel-list" className="flex flex-col gap-1.5">
              {[
                ...data.channels,
                ...unlisted.map((p) => ({ ...p, isMember: true, gone: true })),
              ].map((c) => (
                <li key={c.id}>
                  <label className="flex items-center gap-2 text-sm text-ink">
                    <input
                      type="checkbox"
                      className="size-4 accent-slate"
                      data-testid={`slack-channel-${c.id}`}
                      checked={picked.includes(c.id)}
                      onChange={(e) => toggle(c.id, e.target.checked)}
                    />
                    <span>#{c.name}</span>
                    {"gone" in c ? (
                      <span className="text-ink-muted">{t("slack.gone")}</span>
                    ) : !c.isMember ? (
                      <Badge tone="warning" testId={`slack-channel-${c.id}-not-member`}>
                        {t("slack.notMember")}
                      </Badge>
                    ) : null}
                  </label>
                </li>
              ))}
            </ul>
          )}
          <p className="text-sm text-ink-muted" data-testid="slack-picked-count">
            {picked.length === 0 ? t("slack.noPicks") : t("slack.picked", { count: picked.length })}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              data-testid="slack-channels-save"
              disabled={busy || draft === null}
              onClick={() => void save()}
            >
              {t("common.save")}
            </Button>
            {saved ? (
              <p role="status" data-testid="slack-channels-saved" className="text-sm text-positive">
                {t("slack.saved")}
              </p>
            ) : null}
          </div>
          {actionError ? <ErrorNotice error={actionError} /> : null}
        </Card>
      ) : null}
    </section>
  );
}
