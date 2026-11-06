// What happened, line by line (docs/design/prototype.html "Latest from your agents", "Audit trail"),
// and what a change does (`.ba`: before and after you sign).
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "../i18n/i18n";

/** "9:12 · PI · Pia found Baltic birch up 12% · [INV-48211]". With `to`, the text links there. */
export function ActivityRow({
  time,
  badge,
  children,
  end,
  to,
  testId,
}: {
  time?: ReactNode;
  /** An AgentBadge or PersonBadge. */
  badge?: ReactNode;
  children: ReactNode;
  /** A StatusChip or a receipt on the right. */
  end?: ReactNode;
  to?: string;
  testId?: string;
}) {
  return (
    <div data-testid={testId} className="ui-activity">
      {time !== undefined ? <span className="ui-activity__time">{time}</span> : null}
      {badge ? <span className="ui-activity__badge">{badge}</span> : null}
      <span className="ui-activity__text">
        {to ? (
          <Link to={to} className="text-ink hover:underline">
            {children}
          </Link>
        ) : (
          children
        )}
      </span>
      {end ? <span className="ui-activity__end">{end}</span> : null}
    </div>
  );
}

/** A change's before and after, side by side ("Before" / "After you sign"); stacked on phones. */
export function BeforeAfter({
  before,
  after,
  beforeLabel,
  afterLabel,
  testId,
}: {
  before: ReactNode;
  after: ReactNode;
  beforeLabel?: ReactNode;
  afterLabel?: ReactNode;
  testId?: string;
}) {
  const { t } = useI18n();
  return (
    <div data-testid={testId} className="ui-ba">
      <div>
        <p className="eyebrow text-ink-muted">{beforeLabel ?? t("ui.before")}</p>
        <div className="mt-1 text-sm text-ink">{before}</div>
      </div>
      <div>
        <p className="eyebrow text-ink-muted">{afterLabel ?? t("ui.after")}</p>
        <div className="mt-1 text-sm text-ink">{after}</div>
      </div>
    </div>
  );
}
