// Settings: notifications, starting with the computer, who is signed in, and this computer.
import { useState } from "react";
import type { DesktopView } from "../../shared/ipc";
import { bridge } from "../ui";

function Toggle({
  on,
  label,
  onChange,
}: {
  on: boolean;
  label: string;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      className="ds-choice"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
    >
      <span className="ds-switch" />
      {label}
    </button>
  );
}

export function SettingsPage({ view }: { view: DesktopView }) {
  const [removing, setRemoving] = useState(false);
  return (
    <>
      <header className="ds-stack">
        <h1 className="type-title app__title">Settings</h1>
      </header>

      <section className="ds-card">
        <div className="ds-card__head">
          <span className="ds-eyebrow">On this computer</span>
        </div>
        <div className="folder">
          <Toggle
            on={view.settings.notifications}
            label="Tell me when something waits on me"
            onChange={(notifications) => void bridge().setSettings({ notifications })}
          />
          <Toggle
            on={view.settings.openAtLogin}
            label="Open Mezonas when this computer starts"
            onChange={(openAtLogin) => void bridge().setSettings({ openAtLogin })}
          />
          <span className="ds-help">
            Mezonas works on your folders only while this app is running. It stays in the{" "}
            {view.platform === "mac" ? "menu bar" : "system tray"} when you close the window.
          </span>
        </div>
      </section>

      <section className="ds-card">
        <div className="ds-card__head">
          <span className="ds-eyebrow">You</span>
        </div>
        <div className="folder">
          {view.person ? (
            <div className="ds-row" style={{ justifyContent: "space-between" }}>
              <span>
                {view.person.name} <span className="muted">· {view.person.email}</span>
              </span>
              <button
                type="button"
                className="ds-btn ds-btn--secondary ds-btn--sm"
                onClick={() => void bridge().signOut()}
              >
                Sign out
              </button>
            </div>
          ) : (
            <div className="ds-row" style={{ justifyContent: "space-between" }}>
              <span className="muted">Signed out. Work on this computer goes on.</span>
              <button
                type="button"
                className="ds-btn ds-btn--primary ds-btn--sm"
                onClick={() => void bridge().signIn()}
              >
                Sign in
              </button>
            </div>
          )}
        </div>
      </section>

      <section className="ds-card">
        <div className="ds-card__head">
          <span className="ds-eyebrow">This computer</span>
        </div>
        <div className="folder">
          <span>
            {view.device?.name} <span className="muted">· {view.device?.clientName}</span>
          </span>
          <span className="path">
            Mezonas {view.version} · {view.origin}
          </span>
          <div className="ds-row">
            <button
              type="button"
              className="ds-btn ds-btn--secondary ds-btn--sm"
              onClick={() => setRemoving(true)}
            >
              Remove this computer from Mezonas
            </button>
          </div>
        </div>
      </section>

      {removing ? (
        <div className="overlay">
          <div className="ds-scrim" />
          <div
            className="ds-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="remove-computer"
          >
            <div className="ds-dialog__body">
              <h2 id="remove-computer" className="type-heading app__title">
                Remove {view.device?.name} from Mezonas?
              </h2>
              <p className="muted" style={{ margin: 0 }}>
                Mezonas stops reaching every folder here, and this computer forgets its key. Your
                files stay as they are. You can add it again later.
              </p>
            </div>
            <div className="ds-dialog__foot">
              <button
                type="button"
                className="ds-btn ds-btn--ghost"
                onClick={() => setRemoving(false)}
              >
                Keep it
              </button>
              <button
                type="button"
                className="ds-btn ds-btn--primary"
                onClick={() =>
                  void bridge()
                    .unpair()
                    .then(() => setRemoving(false))
                }
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
