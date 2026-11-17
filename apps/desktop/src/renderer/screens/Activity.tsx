// What this app did on this computer, newest first: reads, changes, files sent, refusals.
import type { ActivityRow, DesktopView } from "../../shared/ipc";
import { when } from "../ui";

const KIND: Record<ActivityRow["kind"], { label: string; tone: string }> = {
  read: { label: "Read", tone: "neutral" },
  write: { label: "Changed", tone: "accent" },
  sent: { label: "Sent", tone: "positive" },
  refused: { label: "Not done", tone: "warning" },
  error: { label: "Problem", tone: "risk" },
  info: { label: "Note", tone: "neutral" },
};

export function ActivityList({ rows }: { rows: ActivityRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="muted" style={{ margin: 0, padding: "var(--space-4) var(--space-5)" }}>
        Nothing yet.
      </p>
    );
  }
  return (
    <div>
      {rows.map((a) => (
        <div key={a.id} className="activity">
          <span className="activity__at">{when(a.at)}</span>
          <span>{a.text}</span>
          <span className={`ds-pill ds-pill--sm ds-pill--${KIND[a.kind].tone}`}>
            {KIND[a.kind].label}
          </span>
        </div>
      ))}
    </div>
  );
}

export function ActivityPage({ view }: { view: DesktopView }) {
  return (
    <>
      <header className="ds-stack">
        <h1 className="type-title app__title">Activity</h1>
        <p className="app__lede">
          Everything Mezonas did on this computer. Each change was signed first; a copy of every
          workbook from before a change is kept on this computer for 30 days.
        </p>
      </header>
      <section className="ds-card">
        <ActivityList rows={view.activity} />
      </section>
    </>
  );
}
