// This computer: whether Mezonas can reach it, what it gives, what waits, and the latest work.
import type { DesktopView } from "../../shared/ipc";
import type { Page } from "../App";
import { ConnectionPill, when } from "../ui";
import { ActivityList } from "./Activity";

export function HomePage({ view, go }: { view: DesktopView; go: (p: Page) => void }) {
  const waiting = view.desk?.length ?? 0;
  const writable = view.folders.filter((f) => f.writable).length;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const sentToday = view.activity.filter(
    (a) => a.kind === "sent" && new Date(a.at) >= today,
  ).length;
  const changedToday = view.activity.filter(
    (a) => a.kind === "write" && new Date(a.at) >= today,
  ).length;

  return (
    <>
      <header className="ds-stack">
        <span className="ds-eyebrow">{view.device?.clientName}</span>
        <div className="ds-row" style={{ justifyContent: "space-between" }}>
          <h1 className="type-title app__title">{view.device?.name}</h1>
          <ConnectionPill view={view} />
        </div>
        <p className="app__lede">
          {view.connection === "online"
            ? `Mezonas can reach this computer. Last contact ${when(view.lastContactAt).toLowerCase()}.`
            : view.connection === "offline"
              ? "We can't reach Mezonas right now. Jobs wait until we're back; nothing is lost."
              : view.connection === "waiting"
                ? "Mezonas isn't taking work from computers yet. This app is ready when it does."
                : "Starting up."}
        </p>
      </header>

      <div className="ds-kpis">
        <button type="button" className="ds-kpi" onClick={() => go("folders")}>
          <span className="ds-kpi__label">Folders</span>
          <span className="ds-kpi__value">{view.folders.length}</span>
          <span className="ds-kpi__note">{writable} allow changes</span>
        </button>
        <button
          type="button"
          className={`ds-kpi${waiting > 0 ? " ds-kpi--signal" : ""}`}
          onClick={() => go("desk")}
        >
          <span className="ds-kpi__label">{waiting > 0 ? "Waiting on you" : "Your Desk"}</span>
          <span className="ds-kpi__value">{view.desk === null ? "–" : waiting}</span>
          <span className="ds-kpi__note">
            {view.desk === null ? "Sign in to see it" : "to sign"}
          </span>
        </button>
        <div className="ds-kpi">
          <span className="ds-kpi__label">Today</span>
          <span className="ds-kpi__value">{changedToday}</span>
          <span className="ds-kpi__note">
            changes made, {sentToday} file{sentToday === 1 ? "" : "s"} sent
          </span>
        </div>
      </div>

      {view.folders.length === 0 ? (
        <div className="ds-empty">
          <span className="ds-eyebrow">No folders yet</span>
          <span className="type-subheading">Choose what Mezonas may use</span>
          <span className="muted">
            Give the folders that hold the work, like Accounting or Invoices. Mezonas can't reach
            anything else on this computer.
          </span>
          <button type="button" className="ds-btn ds-btn--primary" onClick={() => go("folders")}>
            Add a folder
          </button>
        </div>
      ) : null}

      <section className="ds-card">
        <div className="ds-card__head">
          <span className="ds-eyebrow">Latest</span>
          <button type="button" className="ds-btn ds-btn--link" onClick={() => go("activity")}>
            See all activity
          </button>
        </div>
        <ActivityList rows={view.activity.slice(0, 6)} />
      </section>
    </>
  );
}
