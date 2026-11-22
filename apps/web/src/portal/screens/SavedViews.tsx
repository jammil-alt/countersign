// R6 (docs/plan.md §1.236): the runs list's saved views, its own chunk with its routes' schemas.
// A person's own views and those the team shares, each opening the list on its filter; the list's
// filter saved under a name; an admin shares a view of their own with the team, and may delete one
// the team shares. A view holds the portal's RunFilter only.
import { type PortalView, portalViewRoutes, type RunFilter } from "@countersign/core";
import { type FormEvent, useState } from "react";
import { useApi, useApiClient } from "../../api/useApi";
import { useI18n } from "../../i18n/i18n";
import { useSession } from "../../session/session";
import { TextInput } from "../../ui/forms";
import { Icon } from "../../ui/icons";
import { Button, cx, ErrorNotice } from "../../ui/primitives";

function useIsAdmin(): boolean {
  const session = useSession();
  const client =
    session.tenants.find((c) => c.id === session.activeTenantId) ?? session.tenants[0] ?? null;
  return client?.role === "client_admin";
}

/** Whether two filters are the same, whatever their keys' order. */
export function sameFilter(a: RunFilter, b: RunFilter): boolean {
  const norm = (f: RunFilter) =>
    JSON.stringify(
      Object.keys(f)
        .sort()
        .map((k) => [k, f[k as keyof RunFilter]]),
    );
  return norm(a) === norm(b);
}

export default function SavedViews({
  current,
  onOpen,
}: {
  /** The list's filter now, or null when it shows every run (nothing to save). */
  current: RunFilter | null;
  onOpen: (filters: RunFilter) => void;
}) {
  const { t } = useI18n();
  const api = useApiClient();
  const admin = useIsAdmin();
  const list = useApi(portalViewRoutes.portalViews);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [share, setShare] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  const views = list.data?.views ?? [];

  async function act(work: () => Promise<unknown>) {
    setBusy(true);
    setProblem(null);
    try {
      await work();
      list.reload();
      return true;
    } catch (err) {
      setProblem(err);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!current || !name.trim()) return;
    const ok = await act(() =>
      api.call(portalViewRoutes.portalCreateView, {
        body: { name: name.trim(), filters: current, shared: admin && share },
      }),
    );
    if (ok) {
      setNaming(false);
      setName("");
      setShare(false);
    }
  }

  const chip = (v: PortalView) => {
    const open = current !== null && sameFilter(current, v.filters);
    return (
      <span
        key={v.id}
        className={cx("ds-tag", open && "border-slate")}
        data-testid="portal-views-view"
      >
        <button
          type="button"
          className="text-ink"
          aria-pressed={open}
          title={v.ownerName ? t("runsPage.views.by", { name: v.ownerName }) : undefined}
          onClick={() => onOpen(v.filters)}
          data-testid={`portal-views-open-${v.id}`}
        >
          {v.name}
        </button>
        {v.shared ? (
          <span className="ml-1 text-ink-muted" data-testid="portal-views-shared">
            · {t("runsPage.views.shared")}
          </span>
        ) : null}
        {admin && v.mine ? (
          <button
            type="button"
            className="ml-1 text-ink-muted underline hover:text-ink"
            disabled={busy}
            onClick={() =>
              void act(() =>
                api.call(portalViewRoutes.portalUpdateView, {
                  params: { id: v.id },
                  body: { shared: !v.shared },
                }),
              )
            }
            data-testid={`portal-views-share-${v.id}`}
          >
            {v.shared ? t("runsPage.views.stopSharing") : t("runsPage.views.shareShort")}
          </button>
        ) : null}
        {v.mine || (admin && v.shared) ? (
          <button
            type="button"
            className="ml-1 inline-flex align-middle text-ink-muted hover:text-ink"
            aria-label={t("runsPage.views.delete", { name: v.name })}
            disabled={busy}
            onClick={() =>
              void act(() => api.call(portalViewRoutes.portalDeleteView, { params: { id: v.id } }))
            }
            data-testid={`portal-views-delete-${v.id}`}
          >
            <Icon name="close" size={14} />
          </button>
        ) : null}
      </span>
    );
  };

  if (views.length === 0 && !current) return null;
  return (
    <div className="flex flex-col gap-2" data-testid="portal-views">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {views.length > 0 ? (
          <span className="text-ink-muted">{t("runsPage.views.label")}</span>
        ) : null}
        {views.map(chip)}
        {current && !naming ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setNaming(true)}
            data-testid="portal-views-save"
          >
            {t("runsPage.views.save")}
          </Button>
        ) : null}
      </div>
      {current && naming ? (
        <form
          className="flex flex-wrap items-center gap-2 text-sm"
          onSubmit={(e) => void save(e)}
          data-testid="portal-views-form"
        >
          <TextInput
            aria-label={t("runsPage.views.name")}
            placeholder={t("runsPage.views.namePlaceholder")}
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            className="w-56"
            data-testid="portal-views-name"
            autoFocus
          />
          {admin ? (
            <label className="flex items-center gap-2 text-ink">
              <input
                type="checkbox"
                className="size-4 accent-slate"
                checked={share}
                onChange={(e) => setShare(e.target.checked)}
                data-testid="portal-views-share"
              />
              {t("runsPage.views.share")}
            </label>
          ) : null}
          <Button
            size="sm"
            type="submit"
            disabled={busy || !name.trim()}
            data-testid="portal-views-confirm"
          >
            {t("common.save")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setNaming(false)}>
            {t("common.cancel")}
          </Button>
        </form>
      ) : null}
      {problem ? <ErrorNotice error={problem} /> : null}
    </div>
  );
}
