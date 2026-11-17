// Before this computer is added: sign in, then add it (a client admin), named as the person likes.
import { useState } from "react";
import type { DesktopView } from "../../shared/ipc";
import { Logo } from "../App";
import { bridge, Notice } from "../ui";

export function Welcome({ view }: { view: DesktopView }) {
  const [name, setName] = useState(view.computerName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    setBusy(true);
    setError(null);
    const r = await bridge().pair(name);
    setBusy(false);
    if (!r.ok) setError(r.message);
  };

  return (
    <div className="welcome">
      <div className="ds-card welcome__card">
        <Logo />
        <Notice view={view} />
        {!view.person ? (
          <>
            <div className="ds-stack">
              <h1 className="type-title app__title">Work with files on this computer</h1>
              <p className="app__lede">
                Give Mezonas the folders it needs. We read them, add rows to your workbooks and save
                files there. Every change waits for your sign-off.
              </p>
            </div>
            <div className="ds-row">
              <button
                type="button"
                className="ds-btn ds-btn--primary"
                onClick={() => void bridge().signIn()}
              >
                {view.signingIn ? "Open sign-in again" : "Sign in"}
              </button>
            </div>
            {view.signingIn ? (
              <p className="ds-help">Finish signing in in your browser, then come back here.</p>
            ) : null}
          </>
        ) : (
          <>
            <div className="ds-stack">
              <span className="ds-eyebrow">{view.person.clientName ?? "Your business"}</span>
              <h1 className="type-title app__title">Add this computer to Mezonas</h1>
              <p className="app__lede">
                Signed in as {view.person.name}. Next you choose which folders Mezonas may use.
                Nothing else on this computer is reachable.
              </p>
            </div>
            {view.person.admin ? (
              <>
                <label className="ds-field">
                  <span className="ds-label">Name for this computer</span>
                  <input
                    className={`ds-input${error ? " ds-input--error" : ""}`}
                    value={name}
                    maxLength={80}
                    onChange={(e) => setName(e.target.value)}
                    aria-invalid={error ? true : undefined}
                  />
                  {error ? <span className="ds-error">{error}</span> : null}
                  <span className="ds-help">
                    Your team sees this name in Mezonas, like "Front office PC".
                  </span>
                </label>
                <div className="ds-row">
                  <button
                    type="button"
                    className="ds-btn ds-btn--primary"
                    disabled={busy || name.trim() === ""}
                    onClick={() => void add()}
                  >
                    {busy ? "Adding" : "Add this computer"}
                  </button>
                  <button
                    type="button"
                    className="ds-btn ds-btn--ghost"
                    onClick={() => void bridge().signOut()}
                  >
                    Sign out
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="notice notice--info">
                  Only an admin of your business can add a computer. Ask them to sign in here once;
                  after that this app works for everyone at this computer.
                </div>
                <div className="ds-row">
                  <button
                    type="button"
                    className="ds-btn ds-btn--secondary"
                    onClick={() => void bridge().signOut()}
                  >
                    Sign out
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
