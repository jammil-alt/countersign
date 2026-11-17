// The folders this computer gives Mezonas: add one with the OS picker, choose read only or read
// and change, choose whether new files are sent, or take one back.
import { useState } from "react";
import type { DesktopView, FolderRow, NewFolder } from "../../shared/ipc";
import { bridge, Icon } from "../ui";

function AccessChoice({
  value,
  onChange,
}: {
  value: NewFolder["access"];
  onChange: (v: NewFolder["access"]) => void;
}) {
  return (
    <fieldset className="ds-seg seg-fieldset" aria-label="What Mezonas may do">
      <button type="button" aria-pressed={value === "read"} onClick={() => onChange("read")}>
        Read only
      </button>
      <button
        type="button"
        aria-pressed={value === "read_write"}
        onClick={() => onChange("read_write")}
      >
        Read and change
      </button>
    </fieldset>
  );
}

function SendSwitch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      className="ds-choice"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
    >
      <span className="ds-switch" />
      Send new files here to Mezonas
    </button>
  );
}

function AddFolder({ onDone }: { onDone: () => void }) {
  const [draft, setDraft] = useState<NewFolder | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const choose = async () => {
    setError(null);
    const r = await bridge().chooseFolder();
    if (!r) return;
    if (!r.ok) {
      setError(r.message);
      return;
    }
    setDraft({ path: r.path, label: r.label, access: "read", ingest: false });
  };

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    const r = await bridge().addFolder(draft);
    setBusy(false);
    if (!r.ok) setError(r.message);
    else {
      setDraft(null);
      onDone();
    }
  };

  if (!draft) {
    return (
      <div className="ds-stack">
        <div className="ds-row">
          <button type="button" className="ds-btn ds-btn--primary" onClick={() => void choose()}>
            <Icon name="add" />
            Add a folder
          </button>
        </div>
        {error ? <span className="ds-error">{error}</span> : null}
      </div>
    );
  }

  return (
    <section className="ds-card">
      <div className="ds-card__head">
        <span className="ds-eyebrow">New folder</span>
      </div>
      <div className="folder">
        <span className="path">{draft.path}</span>
        <label className="ds-field">
          <span className="ds-label">Name in Mezonas</span>
          <input
            className="ds-input"
            value={draft.label}
            maxLength={80}
            onChange={(e) => setDraft({ ...draft, label: e.target.value })}
          />
          <span className="ds-help">Steps and your team see this name, like "Accounting".</span>
        </label>
        <div className="ds-field">
          <span className="ds-label">What Mezonas may do</span>
          <AccessChoice
            value={draft.access}
            onChange={(access) => setDraft({ ...draft, access })}
          />
          <span className="ds-help">
            {draft.access === "read"
              ? "Mezonas reads files here and never changes them."
              : "Mezonas may add rows to closed workbooks and save new files here. Each change waits for your sign-off. Nothing is ever deleted."}
          </span>
        </div>
        <SendSwitch on={draft.ingest} onChange={(ingest) => setDraft({ ...draft, ingest })} />
        <span className="ds-help">
          PDFs, images, workbooks and documents added from now on go to Mezonas as documents. Files
          already here stay here.
        </span>
        {error ? <span className="ds-error">{error}</span> : null}
        <div className="ds-row">
          <button
            type="button"
            className="ds-btn ds-btn--primary"
            disabled={busy || draft.label.trim() === ""}
            onClick={() => void save()}
          >
            Give this folder to Mezonas
          </button>
          <button type="button" className="ds-btn ds-btn--ghost" onClick={() => setDraft(null)}>
            Cancel
          </button>
        </div>
      </div>
    </section>
  );
}

function FolderItem({ folder }: { folder: FolderRow }) {
  const [removing, setRemoving] = useState(false);
  const update = (patch: Parameters<ReturnType<typeof bridge>["updateFolder"]>[1]) =>
    void bridge().updateFolder(folder.id, patch);

  return (
    <div className="folder">
      <div className="folder__top">
        <div className="ds-stack" style={{ gap: "var(--space-1)" }}>
          <span className="type-subheading">{folder.label}</span>
          <span className="path">{folder.path}</span>
        </div>
        <div className="ds-row">
          {!folder.onMezonas ? (
            <span className="ds-pill ds-pill--warning">Not on Mezonas yet</span>
          ) : folder.access === "read_write" && !folder.writable ? (
            <span className="ds-pill ds-pill--neutral">Read only in Mezonas</span>
          ) : null}
          {folder.ingest ? <span className="ds-pill ds-pill--accent">Sends new files</span> : null}
        </div>
      </div>
      <div className="ds-row" style={{ justifyContent: "space-between" }}>
        <AccessChoice value={folder.access} onChange={(access) => update({ access })} />
        <div className="ds-row">
          <button
            type="button"
            className="ds-btn ds-btn--secondary ds-btn--sm"
            onClick={() => void bridge().showFolder(folder.id)}
          >
            Open
          </button>
          <button
            type="button"
            className="ds-btn ds-btn--ghost ds-btn--sm"
            onClick={() => setRemoving(true)}
          >
            Take back
          </button>
        </div>
      </div>
      <SendSwitch on={folder.ingest} onChange={(ingest) => update({ ingest })} />
      {removing ? (
        <div className="overlay">
          <div className="ds-scrim" />
          <div
            className="ds-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby={`remove-${folder.id}`}
          >
            <div className="ds-dialog__body">
              <h2 id={`remove-${folder.id}`} className="type-heading app__title">
                Take {folder.label} back from Mezonas?
              </h2>
              <p className="muted" style={{ margin: 0 }}>
                From now on Mezonas can't read or change anything in it. Steps that use it will stop
                and ask your team. Your files stay as they are.
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
                    .removeFolder(folder.id)
                    .then(() => setRemoving(false))
                }
              >
                Take it back
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function FoldersPage({ view }: { view: DesktopView }) {
  const [, refresh] = useState(0);
  return (
    <>
      <header className="ds-stack">
        <h1 className="type-title app__title">Folders</h1>
        <p className="app__lede">
          Mezonas can reach only these folders on this computer, and only what you allow in each.
          Workbooks are changed only while they're closed.
        </p>
      </header>
      {view.folders.length > 0 ? (
        <section className="ds-card">
          <div className="ds-card__head">
            <span className="ds-eyebrow">Given to Mezonas</span>
            <span className="ds-num">{view.folders.length}</span>
          </div>
          {view.folders.map((f) => (
            <FolderItem key={f.id} folder={f} />
          ))}
        </section>
      ) : null}
      <AddFolder onDone={() => refresh((n) => n + 1)} />
      {view.person && !view.person.admin ? (
        <p className="ds-help">Only an admin of your business can give Mezonas a folder.</p>
      ) : null}
    </>
  );
}
