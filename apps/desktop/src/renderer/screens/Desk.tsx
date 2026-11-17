// Your Desk: what waits on the person. Titles here; signing happens in Mezonas, where each change
// is shown with its before and after.
import type { DesktopView } from "../../shared/ipc";
import { bridge, when } from "../ui";

export function DeskPage({ view }: { view: DesktopView }) {
  const open = () => void bridge().openDesk();
  return (
    <>
      <header className="ds-stack">
        <h1 className="type-title app__title">Your Desk</h1>
        <p className="app__lede">
          Approvals and questions that wait on you. Open one in Mezonas to see the change and sign
          it.
        </p>
      </header>
      {view.desk === null ? (
        <div className="ds-empty">
          <span className="ds-eyebrow">Signed out</span>
          <span className="type-subheading">Sign in to see what waits on you</span>
          <span className="muted">Work on this computer goes on while you're signed out.</span>
          <button
            type="button"
            className="ds-btn ds-btn--primary"
            onClick={() => void bridge().signIn()}
          >
            Sign in
          </button>
        </div>
      ) : view.desk.length === 0 ? (
        <div className="ds-empty">
          <span className="ds-eyebrow">Nothing waiting</span>
          <span className="type-subheading">Your Desk is clear</span>
          <span className="muted">We'll tell you here when something needs your sign-off.</span>
        </div>
      ) : (
        <section className="ds-card">
          <div className="ds-card__head">
            <span className="ds-eyebrow">Waiting on you</span>
            <span className="ds-num">{view.desk.length}</span>
          </div>
          {view.desk.map((item) => (
            <button key={item.id} type="button" className="ds-listrow" onClick={open}>
              <span>
                <span className="ds-listrow__title">{item.title}</span>
                <span className="ds-listrow__meta">{when(item.createdAt)}</span>
              </span>
              <span className="ds-pill ds-pill--warning">Waiting on you</span>
            </button>
          ))}
        </section>
      )}
      {view.desk && view.desk.length > 0 ? (
        <div className="ds-row">
          <button type="button" className="ds-btn ds-btn--primary" onClick={open}>
            Open Your Desk
          </button>
        </div>
      ) : null}
    </>
  );
}
