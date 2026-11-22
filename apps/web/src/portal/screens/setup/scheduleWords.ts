// A schedule in words for the adjustable settings on See it work, as the agent page's Settings tab
// words it (`scheduleWords` in ../Agent.tsx, kept there): a common schedule (every day, weekdays,
// one day a week at a time) in words, anything else as "On a schedule".
import type { I18n } from "../../../i18n/i18n";

export function scheduleWords(
  cron: string | null,
  { t, locale }: Pick<I18n, "t" | "locale">,
): string {
  const parts = (cron ?? "").trim().split(/\s+/);
  if (parts.length !== 5) return t("agent.trigger.schedule");
  const [min, hour, dom, mon, dow] = parts as [string, string, string, string, string];
  if (!/^\d+$/.test(min) || !/^\d+$/.test(hour) || dom !== "*" || mon !== "*") {
    return t("agent.trigger.schedule");
  }
  const time = new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(2000, 0, 2, Number(hour), Number(min))));
  if (dow === "*") return t("agent.trigger.daily", { time });
  if (dow === "1-5") return t("agent.trigger.weekdays", { time });
  if (/^[0-6]$/.test(dow)) {
    // 2 January 2000 was a Sunday: day 0 of cron's week.
    const day = new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(
      new Date(Date.UTC(2000, 0, 2 + Number(dow))),
    );
    return t("agent.trigger.weekly", { day, time });
  }
  return t("agent.trigger.schedule");
}
