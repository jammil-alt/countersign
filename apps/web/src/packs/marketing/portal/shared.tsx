// The Marketing area in the client's portal (M50, docs/plan.md §1.78): the parts its three read
// screens share. The portal reads only the reports the pack lets it (overview, search,
// weekly-report: apps/api `portalReports`), as the client's own; words come from the message
// catalog (`marketing.*`), numbers and days through the reader's locale. Page paths, searches and
// the agent's report text are the client's data and show as written.
import { useSearchParams } from "react-router-dom";
import { apiRoutes } from "../../../api/routes";
import { type ApiState, useApi } from "../../../api/useApi";
import type { PlainKey } from "../../../i18n/catalog";
import { type I18n, useI18n } from "../../../i18n/i18n";
import { Icon } from "../../../ui/icons";
import { buttonClass } from "../../../ui/primitives";
import { cleanQuery, MARKETING_PACK, type ReportQuery } from "../ops/api";

export { MARKETING_PACK };

/** A site as the reports name it. */
export interface PortalSite {
  id: string;
  domain: string;
  name: string;
}

/** One of the portal's reports for the signed-in client, reloaded when the query changes. */
export function usePortalReport<T>(report: string, query?: ReportQuery): ApiState<T> {
  const state = useApi(apiRoutes.portalPackReport, {
    params: { pack: MARKETING_PACK, report },
    query: cleanQuery(query),
  });
  return { ...state, data: state.data?.report as T | undefined };
}

/** One row of a portal report in full (a weekly report); `null` id: nothing loads. */
export function usePortalItem<T>(report: string, itemId: string | null): ApiState<T> {
  const state = useApi(
    apiRoutes.portalPackReportItem,
    itemId ? { params: { pack: MARKETING_PACK, report, itemId } } : null,
  );
  return { ...state, data: state.data?.report as T | undefined };
}

/** The portal's CSV of a report, with the same query. */
export function portalCsvHref(report: string, query?: ReportQuery): string {
  const q = new URLSearchParams(cleanQuery(query)).toString();
  return `/api/reports/${MARKETING_PACK}/${report}/csv${q ? `?${q}` : ""}`;
}

export function PortalCsvLink({ report, query }: { report: string; query?: ReportQuery }) {
  const { t } = useI18n();
  return (
    <a
      href={portalCsvHref(report, query)}
      download
      className={buttonClass("secondary", undefined, "sm")}
      data-testid={`portal-marketing-${report}-csv`}
    >
      <Icon name="upload" size={16} className="ds-icon rotate-180" />
      {t("marketing.downloadCsv")}
    </a>
  );
}

/** The site the address names (`?site=`), kept in the address so a link opens the same one. */
export function useSiteParam(): [string, (site: string) => void] {
  const [params, setParams] = useSearchParams();
  const site = params.get("site") ?? "";
  return [
    site,
    (next) => {
      const p = new URLSearchParams(params);
      if (next) p.set("site", next);
      else p.delete("site");
      setParams(p, { replace: true });
    },
  ];
}

/** A choice of the client's sites, shown only when it has more than one. */
export function SitePicker({
  sites,
  value,
  onChange,
}: {
  sites: readonly PortalSite[] | undefined;
  value: string | undefined;
  onChange: (site: string) => void;
}) {
  const { t } = useI18n();
  if (!sites || sites.length < 2) return null;
  return (
    <label className="flex items-center gap-2 text-sm text-ink-muted">
      {t("marketing.site")}
      <select
        className="ds-input"
        value={value ?? sites[0]?.id ?? ""}
        onChange={(e) => onChange(e.target.value)}
        data-testid="portal-marketing-site"
      >
        {sites.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name || s.domain}
          </option>
        ))}
      </select>
    </label>
  );
}

/** "12.5%" in the reader's locale, from a rate kept as a decimal string; "–" with none. */
export function percent(rate: string | null | undefined, { intl }: Pick<I18n, "intl">): string {
  if (rate === null || rate === undefined || rate === "") return "–";
  const n = Number(rate);
  if (!Number.isFinite(n)) return "–";
  return new Intl.NumberFormat(intl, { style: "percent", maximumFractionDigits: 1 }).format(n);
}

/** An average position to one place ("4.2"); "–" with none. */
export function position(value: number | null | undefined, { intl }: Pick<I18n, "intl">): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "–";
  return new Intl.NumberFormat(intl, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value);
}

/** "Up 12 on the days before", "Same as the days before". */
export function changeWords({
  t,
  fmt,
}: Pick<I18n, "t" | "fmt">): (direction: "up" | "down" | "same", by: number) => string {
  return (direction, by) =>
    direction === "same"
      ? t("marketing.change.same")
      : t(direction === "up" ? "marketing.change.up" : "marketing.change.down", {
          by: fmt.number(by),
        });
}

/** A median engaged time's band: "30 s to 1 min", "under 10 s", "4 min or more". */
export function bandWords(
  band: { fromSeconds: number; toSeconds: number | null } | null | undefined,
  { t }: Pick<I18n, "t">,
): string {
  if (!band) return "–";
  const words = (s: number) =>
    s < 60
      ? t("marketing.seconds", { n: s })
      : s % 60 === 0
        ? t("marketing.minutes", { n: s / 60 })
        : t("marketing.minutesSeconds", { m: Math.floor(s / 60), s: s % 60 });
  if (band.fromSeconds === 0 && band.toSeconds !== null) {
    return t("marketing.band.under", { to: words(band.toSeconds) });
  }
  if (band.toSeconds === null) return t("marketing.band.over", { from: words(band.fromSeconds) });
  return t("marketing.band.between", {
    from: words(band.fromSeconds),
    to: words(band.toSeconds),
  });
}

const SOURCE_GROUP_WORDS: Record<string, PlainKey> = {
  direct: "marketing.source.direct",
  search: "marketing.source.search",
  social: "marketing.source.social",
  referral: "marketing.source.referral",
  campaign: "marketing.source.campaign",
  internal: "marketing.source.internal",
};

/** "google (Search)", "Direct": a source in the reader's words; its name stays as written. */
export function sourceWords(group: string, name: string | null, { t }: Pick<I18n, "t">) {
  const key = SOURCE_GROUP_WORDS[group];
  const words = key ? t(key) : group;
  return name ? `${name} (${words})` : words;
}

/** The line under every website screen: how visits are counted. */
export function PrivacyLine() {
  const { t } = useI18n();
  return (
    <p className="text-sm text-ink-muted" data-testid="portal-marketing-privacy">
      {t("marketing.privacy")}
    </p>
  );
}
