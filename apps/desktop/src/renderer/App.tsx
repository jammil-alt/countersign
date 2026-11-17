// The window: a welcome until this computer is added to Mezonas, then the sidebar and its pages.
import logo from "@countersign/design-system/assets/Logos/mezonas-logo.svg";
import logoPaper from "@countersign/design-system/assets/Logos/mezonas-logo-paper.svg";
import { useEffect, useState } from "react";
import type { DesktopView } from "../shared/ipc";
import { ActivityPage } from "./screens/Activity";
import { DeskPage } from "./screens/Desk";
import { FoldersPage } from "./screens/Folders";
import { HomePage } from "./screens/Home";
import { SettingsPage } from "./screens/Settings";
import { Welcome } from "./screens/Welcome";
import { bridge, ConnectionPill, Icon, type IconName, Notice } from "./ui";

export type Page = "home" | "folders" | "desk" | "activity" | "settings";

const NAV: { page: Page; label: string; icon: IconName }[] = [
  { page: "home", label: "This computer", icon: "table" },
  { page: "folders", label: "Folders", icon: "document" },
  { page: "desk", label: "Your Desk", icon: "desk" },
  { page: "activity", label: "Activity", icon: "worksheet" },
  { page: "settings", label: "Settings", icon: "settings" },
];

export function Logo() {
  return (
    <>
      <img className="logo-light" src={logo} alt="Mezonas" width="116" height="16" />
      <img className="logo-dark" src={logoPaper} alt="Mezonas" width="116" height="16" />
    </>
  );
}

export function App() {
  const [view, setView] = useState<DesktopView | null>(null);
  const [page, setPage] = useState<Page>("home");

  useEffect(() => {
    void bridge().view().then(setView);
    return bridge().onView(setView);
  }, []);

  if (!view) return null;
  if (!view.device) return <Welcome view={view} />;

  const waiting = view.desk?.length ?? 0;
  return (
    <div className="app">
      <aside className="ds-sidebar app__side">
        <div>
          <div className="app__brand">
            <Logo />
          </div>
          <span className="ds-eyebrow" style={{ padding: "6px 10px 10px" }}>
            {view.device.clientName}
          </span>
          <nav className="app__nav" aria-label="Mezonas">
            {NAV.map((n) => (
              <button
                key={n.page}
                type="button"
                className="ds-navitem"
                aria-current={page === n.page ? "page" : undefined}
                onClick={() => setPage(n.page)}
              >
                <span className="ds-row">
                  <Icon name={n.icon} />
                  {n.label}
                </span>
                {n.page === "desk" && waiting > 0 ? (
                  <span className="ds-pill ds-pill--warning ds-pill--sm">{waiting}</span>
                ) : null}
              </button>
            ))}
          </nav>
        </div>
        <div className="app__foot">
          <ConnectionPill view={view} />
          <span>{view.device.name}</span>
        </div>
      </aside>
      <main className="app__main">
        <div className="app__page">
          <Notice view={view} />
          {page === "home" ? <HomePage view={view} go={setPage} /> : null}
          {page === "folders" ? <FoldersPage view={view} /> : null}
          {page === "desk" ? <DeskPage view={view} /> : null}
          {page === "activity" ? <ActivityPage view={view} /> : null}
          {page === "settings" ? <SettingsPage view={view} /> : null}
        </div>
      </main>
    </div>
  );
}
