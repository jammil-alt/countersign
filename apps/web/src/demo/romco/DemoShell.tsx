// The portal's frame for the demo: the same top bar and sidebar as `AppShell` (shell/Shell.tsx), on
// the same classes and parts, without the session, search or feedback it needs live. The tour bar
// at the foot steps a presenter through the run, stop by stop.
import { type ReactNode, useEffect, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { SidebarAgent, SidebarLink, SidebarSection } from "../../shell/Shell";
import { AgentBadge } from "../../ui/badges";
import { Logo, LogoMark } from "../../ui/brand";
import { Icon } from "../../ui/icons";
import { Count, cx } from "../../ui/primitives";
import { CLIENT, INVOICE_ID, UCC_ID } from "./people";
import { useSloan } from "./Sloan";
import { type DemoState, TOURS, useDemo } from "./state";

export function useWaiting(): number {
  const { state } = useDemo();
  return (
    (state.formsSent ? 0 : 1) +
    (state.marcusDone && !state.reportSent ? 1 : 0) +
    (state.inv === 2 ? 1 : 0)
  );
}

export function DemoShell({ children }: { children: ReactNode }) {
  const waiting = useWaiting();
  const sloan = useSloan();
  const { state } = useDemo();
  const line = !state.formsSent
    ? "Trial · waiting on you"
    : !state.marcusDone
      ? "Trial · waiting on 1 form"
      : state.reportSent
        ? "Trial · done"
        : "Trial · waiting on you";
  return (
    <div className="ui-shell" data-testid="shell-portal">
      <header className="ds-header ui-topbar">
        <Link to={`/agents/${UCC_ID}`} className="ui-topbar__logo" title="Mezonas">
          <span className="ui-topbar__lockup">
            <Logo height={18} />
          </span>
          <span className="ui-topbar__mark">
            <LogoMark size={28} />
          </span>
        </Link>
        <span aria-hidden className="ui-topbar__sep" />
        <div className="ui-topbar__context">
          <span>{CLIENT}</span>
        </div>
        <div className="ui-topbar__search">
          <button type="button" className="ui-searchbox">
            <Icon name="search" className="text-ink-muted" />
            <span className="ui-searchbox__text">Search filings, deals, accounts…</span>
            <kbd className="ui-kbd">⌘K</kbd>
          </button>
        </div>
        <button
          type="button"
          className="ui-topbar__ask"
          title="Your account agent. Ask it anything."
          aria-haspopup="dialog"
          onClick={() => sloan.openPanel()}
        >
          <AgentBadge name="Sloan" size="sm" />
          <span className="ui-topbar__asklabel">Ask Sloan</span>
        </button>
        <NavLink to="/inbox" className="ui-topbar__desk" aria-label={`Inbox (${waiting})`}>
          <Icon name="desk" className="ui-topbar__deskicon" />
          <span className="ui-topbar__desklabel">Inbox</span>
          <Count n={waiting} tone="warning" />
        </NavLink>
        <span
          className="ds-avatar ds-avatar--sm ds-avatar--self font-medium"
          title="Dana Whitfield"
        >
          DW
        </span>
      </header>
      <div className="ui-shell__body">
        <aside className="ds-sidebar ui-sidebar" aria-label="Navigation">
          <div className="ui-sidebar__nav">
            <nav className="flex flex-col gap-0.5">
              <SidebarLink to="/home" icon="table" label="Home" />
              <SidebarLink to="/inbox" icon="desk" label="Inbox" count={waiting} />
              <SidebarLink to="/requests" icon="message" label="Requests" />
              <SidebarLink to={`/runs/R-1042/receive`} icon="report" label="Runs" />
              <SidebarLink to="/connectors" icon="bank" label="Connectors" />
              <SidebarLink to="/contacts" icon="team" label="Contacts" />
            </nav>
            <SidebarSection label="Your agents">
              <SidebarAgent
                to={`/agents/${UCC_ID}`}
                name="UCC filings review"
                line={line}
                badge={<AgentBadge name="UCC filings review" seed={UCC_ID} size="sm" />}
              />
              <SidebarAgent
                to={`/agents/${INVOICE_ID}`}
                name="Invoice CRM update"
                line={
                  [
                    "Trial · waiting on 1 report",
                    "Trial · waiting on sales ops",
                    "Trial · waiting on you",
                    "Trial · done",
                  ][state.inv]
                }
                badge={<AgentBadge name="Invoice CRM update" seed={INVOICE_ID} size="sm" />}
              />
            </SidebarSection>
          </div>
          <div className="ui-sidebar__foot">
            <SidebarLink to="/settings" icon="settings" label="Settings" />
          </div>
        </aside>
        <main className="ui-main">{children}</main>
      </div>
      <TourBar />
    </div>
  );
}

/** Scrolls to a `#section` after a move, else to the top. */
export function ScrollOnMove() {
  const { pathname, hash } = useLocation();
  // biome-ignore lint/correctness/useExhaustiveDependencies: each new page scrolls to its top.
  useEffect(() => {
    if (hash) {
      const el = document.getElementById(decodeURIComponent(hash.slice(1)));
      if (el) {
        el.scrollIntoView({ block: "start" });
        return;
      }
    }
    window.scrollTo(0, 0);
  }, [pathname, hash]);
  return null;
}

/** Every stop of every tour, in order: the UCC tour, then the Invoice CRM update's. */
const ALL = TOURS.flatMap((tour) => tour.stops.map((stop, n) => ({ tour, stop, n })));

/** The last stop shown, for a page that is two stops (the Inbox). */
let lastStop = 0;

/** The presenter's bar: where we are in the story, Back and Next, every stop, Start over. */
export function TourBar() {
  const { pathname, hash } = useLocation();
  const navigate = useNavigate();
  const { reset, set, state } = useDemo();
  const [open, setOpen] = useState(false);
  const here = `${pathname}${hash}`;
  const match = (path: string) => ALL.flatMap((a, i) => (a.stop.path === path ? [i] : []));
  const hits = match(here).length > 0 ? match(here) : match(pathname);
  // A page that is several stops (the Inbox) is the one whose state is the run's now, in the tour
  // last shown; else the nearest after the last.
  const tour = ALL[lastStop]?.tour.key;
  const same = (i: number) => {
    const a = ALL[i];
    if (!a) return false;
    const want = a.tour.stateAt(a.n);
    return (Object.keys(want) as (keyof DemoState)[]).every((k) => want[k] === state[k]);
  };
  const at =
    hits.find((i) => same(i) && ALL[i]?.tour.key === tour) ??
    hits.find(same) ??
    hits.find((i) => i >= lastStop) ??
    hits[hits.length - 1] ??
    -1;
  if (at >= 0) lastStop = at;
  const here_ = at >= 0 ? ALL[at] : null;
  const go = (i: number) => {
    const a = ALL[i];
    lastStop = Math.max(0, i);
    if (a) {
      set(a.tour.stateAt(a.n));
      navigate(a.stop.path);
    }
    setOpen(false);
  };
  return (
    <div className="demo-tour" data-print="hide">
      {open ? (
        <div className="demo-tour__list">
          {TOURS.map((t) => (
            <section key={t.key}>
              <p className="ds-eyebrow demo-tour__head">{t.name}</p>
              <ol>
                {t.stops.map((s, n) => {
                  const i = ALL.findIndex((a) => a.tour === t && a.n === n);
                  return (
                    <li key={`${s.path}-${s.title}`}>
                      <button
                        type="button"
                        className={cx(i === at && "is-here")}
                        onClick={() => go(i)}
                      >
                        <span className="demo-tour__n">{n + 1}</span>
                        {s.title}
                      </button>
                    </li>
                  );
                })}
              </ol>
            </section>
          ))}
          <button
            type="button"
            className="demo-tour__again"
            onClick={() => {
              reset();
              lastStop = 0;
              go(0);
            }}
          >
            <span className="demo-tour__n">↺</span>
            Start over
          </button>
        </div>
      ) : null}
      <div className="demo-tour__bar">
        <button
          type="button"
          className="demo-tour__where"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <span className="ds-eyebrow">Demo · {here_ ? here_.tour.name : "ROMCO"}</span>
          <span className="demo-tour__title">
            {here_
              ? `${here_.n + 1} of ${here_.tour.stops.length} · ${here_.stop.title}`
              : "Off the tour"}
          </span>
          <Icon name="chevron-down" size={14} />
        </button>
        <p className="demo-tour__hint">
          {here_?.stop.hint ?? "Pick a stop, or press Next to go back on the tour."}
        </p>
        <span className="flex gap-2">
          <button
            type="button"
            className="ds-btn ds-btn--secondary ds-btn--sm"
            disabled={at <= 0}
            onClick={() => go(at - 1)}
          >
            Back
          </button>
          <button
            type="button"
            className="ds-btn ds-btn--primary ds-btn--sm"
            disabled={at >= ALL.length - 1}
            onClick={() => go(at < 0 ? 0 : at + 1)}
          >
            {here_ && here_.n === here_.tour.stops.length - 1 && at < ALL.length - 1
              ? `Next: ${ALL[at + 1]?.tour.name}`
              : "Next"}
          </button>
        </span>
      </div>
    </div>
  );
}
