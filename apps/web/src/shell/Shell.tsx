// The frame both surfaces share (docs/design/prototype.html, `.hdr` and `.side`, on the Mezonas
// AppHeader and Sidebar): a top bar with the logo, a context slot (the client's name in the portal;
// "Back office" and the client switcher in the back office), the ⌘K search box, the portal's Ask
// Sloan button, the Inbox or Escalations with its count, and the avatar menu (theme, language,
// sign out); a sidebar; the page. At phone width the sidebar folds behind a menu button
// and the top bar compacts; where a surface keeps its inbox out of the top bar (`inHeader: false`),
// the menu button carries its count. Feedback is a row in the sidebar's foot, above Collapse.
import {
  createContext,
  type ReactNode,
  Suspense,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { FEEDBACK_LAYER_ATTR } from "../feedback/capture";
import { useFeedbackStarter } from "../feedback/Feedback";
import type { MessageKey } from "../i18n/catalog";
import { useI18n } from "../i18n/i18n";
import { LanguageMenu } from "../i18n/LanguageMenu";
import { displayName, userInitial, useSession, useSessionState } from "../session/session";
import { Logo, LogoMark, PRODUCT_NAME } from "../ui/brand";
import { ErrorBoundary } from "../ui/ErrorBoundary";
import { Icon, type IconName } from "../ui/icons";
import { Count, cx, Loading } from "../ui/primitives";
import { HeaderSwitcherProvider } from "./HeaderSwitcher";
import { type SearchAsk, SearchBox, type SearchRun } from "./Search";
import { THEMES, type Theme, useTheme } from "./theme";

/** The product's name wherever a person reads it. */
export const PLATFORM_NAME = PRODUCT_NAME;

/**
 * The browser tab's text: what needs you first, then where you are, then Mezonas, so a tab still
 * says something when it's narrow. "(3) Harbor Millwork · Mezonas", "Back office · Mezonas".
 */
export function tabTitle(place: string | null, waiting: number | undefined): string {
  const text = place ? `${place} · ${PLATFORM_NAME}` : PLATFORM_NAME;
  return waiting ? `(${waiting}) ${text}` : text;
}

export interface ShellDesk {
  /** "/inbox" in the portal, "/ops/inbox" (Escalations) in the back office. */
  to: string;
  label: string;
  /** Waiting on you (signal); undefined until it loads. */
  count?: number | undefined;
  /**
   * False where the sidebar already links it (the portal, QA round 1: Your Desk appears once); the
   * count then rides on the phone's menu button.
   */
  inHeader?: boolean;
  /** Keep the count's slot while it loads, so nothing shifts when it arrives. */
  reserve?: boolean;
}

export function AppShell({
  surface,
  home,
  place,
  context,
  search,
  desk,
  sidebar,
  sidebarFooter,
  switcher,
  topAction,
  menu,
  children,
}: {
  surface: "ops" | "portal";
  home: string;
  /** Where this is, for the tab's text: "Back office", or the client's name in the portal. */
  place: string | null;
  context: ReactNode;
  /** None for a client user limited to some agents (docs/plan.md §1.122): search is closed to them. */
  search: { placeholder: string; run: SearchRun; ask?: SearchAsk } | null;
  desk: ShellDesk;
  sidebar: ReactNode;
  /** Pinned to the sidebar's foot (the portal's Sloan card and lead). */
  sidebarFooter?: ReactNode;
  /** The agent switcher on an agent's page: its header draws it (`HeaderSwitcher`). */
  switcher?: ReactNode;
  /** Beside the Inbox in the top bar (the portal's Ask Sloan). */
  topAction?: ReactNode;
  /** Extra rows at the top of the avatar menu (the portal's Settings and its lead). */
  menu?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);
  const wide = useWide();
  const [collapsed, setCollapsed] = useSidebarCollapsed();
  const startFeedback = useFeedbackStarter();
  const { pathname } = useLocation();
  const deskInHeader = desk.inHeader ?? true;
  // Folded on a wide screen: a rail of icons, the words for screen readers and in tooltips.
  const rail = wide && collapsed;
  const menuCount = !deskInHeader && desk.count ? desk.count : 0;
  const asideRef = useRef<HTMLElement>(null);
  const tip = useRailTip(asideRef, rail, pathname);
  const navRef = useRef<HTMLDivElement>(null);
  const moreBelow = useMoreBelow(navRef, rail, pathname);
  useNavScroll(navRef, surface, pathname);
  useEffect(() => {
    document.title = tabTitle(place, desk.count);
  }, [place, desk.count]);
  // A page opened from the folded sidebar closes it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: closes on each page change.
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  return (
    <div data-testid={`shell-${surface}`} className="ui-shell">
      <header className="ds-header ui-topbar">
        <button
          type="button"
          data-testid="shell-menu"
          aria-label={
            menuCount ? `${t("shell.menu")} · ${desk.label} (${menuCount})` : t("shell.menu")
          }
          aria-expanded={menuOpen}
          aria-controls="shell-sidebar"
          onClick={() => setMenuOpen((o) => !o)}
          className={cx(
            "ds-btn ds-btn--ghost ui-topbar__menu",
            menuCount ? "gap-1.5 px-2" : "ds-btn--icon",
          )}
        >
          <Icon name="sidebar" size={20} />
          {menuCount ? <Count n={menuCount} tone="warning" /> : null}
        </button>
        <Link to={home} className="ui-topbar__logo" title={PLATFORM_NAME}>
          <span className="ui-topbar__lockup">
            <Logo height={18} />
          </span>
          <span className="ui-topbar__mark">
            <LogoMark size={28} />
          </span>
        </Link>
        <span aria-hidden className="ui-topbar__sep" />
        <div className="ui-topbar__context">{context}</div>
        <div className="ui-topbar__search">
          {search ? (
            <SearchBox placeholder={search.placeholder} run={search.run} ask={search.ask} />
          ) : null}
        </div>
        {topAction}
        {deskInHeader ? (
          <NavLink
            to={desk.to}
            data-testid="shell-inbox"
            aria-label={desk.count ? `${desk.label} (${desk.count})` : desk.label}
            className="ui-topbar__desk"
          >
            <Icon name="desk" className="ui-topbar__deskicon" />
            <span className="ui-topbar__desklabel">{desk.label}</span>
            {desk.count !== undefined ? (
              <Count n={desk.count} tone="warning" />
            ) : desk.reserve ? (
              <CountSlot />
            ) : null}
          </NavLink>
        ) : null}
        <UserMenu surface={surface} extra={menu} />
      </header>
      <div className="ui-shell__body">
        {menuOpen ? (
          <button
            type="button"
            aria-label={t("shell.closeMenu")}
            tabIndex={-1}
            className="ds-scrim ui-shell__scrim"
            onClick={() => setMenuOpen(false)}
          />
        ) : null}
        <aside
          ref={asideRef}
          id="shell-sidebar"
          aria-label={t("shell.navigation")}
          data-open={menuOpen ? "true" : undefined}
          data-collapsed={rail ? "true" : undefined}
          className="ds-sidebar ui-sidebar"
        >
          <SidebarRail.Provider value={{ rail }}>
            <div
              ref={navRef}
              className="ui-sidebar__nav"
              data-more={moreBelow ? "true" : undefined}
            >
              {sidebar}
            </div>
            {sidebarFooter || wide || startFeedback ? (
              <div className="ui-sidebar__foot">
                {sidebarFooter}
                {startFeedback ? (
                  <FeedbackNavItem
                    rail={rail}
                    onStart={() => {
                      setMenuOpen(false);
                      startFeedback();
                    }}
                  />
                ) : null}
                {/* On a wide screen, Collapse (or Expand) closes the sidebar's foot, as in Anchor. */}
                {wide ? (
                  <button
                    type="button"
                    data-testid="sidebar-collapse"
                    aria-expanded={!collapsed}
                    aria-controls="shell-sidebar"
                    data-tip={collapsed ? t("shell.expand") : undefined}
                    onClick={() => setCollapsed(!collapsed)}
                    className="ds-navitem ui-navitem ui-sidebar__collapse"
                  >
                    <span className="flex min-w-0 items-center gap-2.5">
                      <Icon name="chevron-right" className="ui-navitem__icon ui-sidebar__chev" />
                      <span className="ui-navitem__label">
                        {t(collapsed ? "shell.expand" : "shell.collapse")}
                      </span>
                    </span>
                  </button>
                ) : null}
              </div>
            ) : null}
          </SidebarRail.Provider>
        </aside>
        {tip ? (
          // The rail's names, as the design system's tooltip. Drawn outside the sidebar (fixed), which
          // scrolls and would clip it; screen readers already have each name, so it is hidden.
          <span
            aria-hidden
            data-testid="sidebar-tip"
            className="ds-tooltip ui-railtip"
            style={{ top: tip.top, left: tip.left }}
          >
            {tip.text}
          </span>
        ) : null}
        <main className="ui-main">
          <HeaderSwitcherProvider switcher={switcher ?? null}>
            {/* A page that throws shows a notice here; the frame stays. A new address clears it. */}
            <ErrorBoundary resetKey={pathname}>
              {/* A page still loading a part of itself waits here, so the frame (the sidebar's
                  scroll, its counts) is never hidden behind the app's still frame meanwhile. */}
              <Suspense fallback={<Loading />}>{children}</Suspense>
            </ErrorBoundary>
          </HeaderSwitcherProvider>
        </main>
      </div>
    </div>
  );
}

/**
 * The rail's tooltip: the name of the row under the pointer or keyboard focus (its `data-tip`),
 * placed beside it. Gone when the pointer leaves, focus moves on, the sidebar scrolls, Escape is
 * pressed, the page changes or the rail opens.
 */
function useRailTip(
  asideRef: { current: HTMLElement | null },
  rail: boolean,
  pathname: string,
): { text: string; top: number; left: number } | null {
  const [tip, setTip] = useState<{ text: string; top: number; left: number } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: cleared on each page change too.
  useEffect(() => {
    setTip(null);
    const aside = asideRef.current;
    if (!rail || !aside) return;
    const show = (e: Event) => {
      const row = (e.target as Element | null)?.closest?.<HTMLElement>("[data-tip]");
      const text = row?.dataset.tip;
      if (!row || !text) return setTip(null);
      const r = row.getBoundingClientRect();
      setTip({ text, top: r.top + r.height / 2, left: r.right + 8 });
    };
    const hide = () => setTip(null);
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };
    aside.addEventListener("pointerover", show);
    aside.addEventListener("focusin", show);
    aside.addEventListener("pointerleave", hide);
    aside.addEventListener("focusout", hide);
    aside.addEventListener("scroll", hide);
    aside.addEventListener("keydown", esc);
    return () => {
      aside.removeEventListener("pointerover", show);
      aside.removeEventListener("focusin", show);
      aside.removeEventListener("pointerleave", hide);
      aside.removeEventListener("focusout", hide);
      aside.removeEventListener("scroll", hide);
      aside.removeEventListener("keydown", esc);
    };
  }, [asideRef, rail, pathname]);
  return tip;
}

/** Whether the sidebar is folded to its rail of icons. */
const SidebarRail = createContext<{ rail: boolean }>({ rail: false });

/** Wider than a phone: the sidebar sits beside the page (shell.css's 767.98px breakpoint). */
const WIDE_QUERY = "(min-width: 768px)";

function wideQuery(): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(WIDE_QUERY)
    : null;
}

/** Whether the screen is wider than a phone. Without matchMedia (tests), a phone. */
function useWide(): boolean {
  const [wide, setWide] = useState(() => wideQuery()?.matches ?? false);
  useEffect(() => {
    const mq = wideQuery();
    if (!mq) return;
    const update = () => setWide(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return wide;
}

const SIDEBAR_KEY = "mezonas.sidebar";

/**
 * Whether the person folded the sidebar away on a wide screen. This browser's choice, kept in
 * localStorage like the theme; it may be unavailable (private windows), so it's guarded.
 */
function useSidebarCollapsed(): [boolean, (collapsed: boolean) => void] {
  const [collapsed, set] = useState(() => {
    try {
      return globalThis.localStorage?.getItem(SIDEBAR_KEY) === "collapsed";
    } catch {
      return false;
    }
  });
  const choose = (next: boolean) => {
    try {
      if (next) globalThis.localStorage?.setItem(SIDEBAR_KEY, "collapsed");
      else globalThis.localStorage?.removeItem(SIDEBAR_KEY);
    } catch {
      // Kept for this page only.
    }
    set(next);
  };
  return [collapsed, choose];
}

const THEME_LABEL = {
  system: "shell.theme.system",
  light: "shell.theme.light",
  dark: "shell.theme.dark",
} as const satisfies Record<Theme, MessageKey>;

/**
 * Feedback: a row in the sidebar's foot, above Collapse (the owner, 2026-11-11: it floated at the
 * bottom right and covered the page's own buttons). Only where feedback is on for the session
 * (always in the back office; per client in the portal). Its name says what it is for: problems
 * with the app (Sloan takes other asks).
 */
// DECISION (staging QA, 2026-11-22): it reads "Report a problem", with the info mark and in the
// muted ink of Collapse, so it reads as a tool you start rather than a place you go: it sat beside
// the back office's Utilities, whose first tab is the feedback received, and both said "Feedback".
function FeedbackNavItem({ rail, onStart }: { rail: boolean; onStart: () => void }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      data-testid="feedback-button"
      aria-label={t("feedback.button")}
      data-tip={rail ? t("feedback.short") : undefined}
      onClick={onStart}
      className="ds-navitem ui-navitem ui-sidebar__tool"
      // Part of the feedback layer: left out of the picture and never the pinned element.
      {...{ [FEEDBACK_LAYER_ATTR]: "" }}
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <Icon name="info" className="ui-navitem__icon" />
        <span className="ui-navitem__label">{t("feedback.short")}</span>
      </span>
    </button>
  );
}

function UserMenu({ surface, extra }: { surface: "ops" | "portal"; extra?: ReactNode }) {
  const { t } = useI18n();
  const session = useSession();
  const { signOut } = useSessionState();
  const [theme, setTheme] = useTheme();
  // The operator is Mezonas staff, a person on the client's account: copper, like the lead. A
  // client user is the signed-in self: ink.
  const operator = session.operator;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { pathname } = useLocation();
  // A page opened from the menu closes it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: closes on each page change.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        data-testid="shell-avatar"
        aria-label={t("shell.account", { name: displayName(session.user) })}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cx(
          "ds-avatar ds-avatar--sm cursor-pointer font-medium",
          operator ? "mz-lead" : "ds-avatar--self",
        )}
      >
        {userInitial(session.user)}
      </button>
      {open ? (
        <div className="ui-menu" data-testid="shell-user-menu">
          <p className="font-medium text-ink">{displayName(session.user)}</p>
          <p className="truncate text-sm text-ink-muted">{session.user.email}</p>
          {extra ? (
            <div className="mt-3 flex flex-col gap-2 border-t border-line pt-3">{extra}</div>
          ) : null}
          <div className="mt-3 flex flex-col gap-1.5 border-t border-line pt-3">
            <span className="text-sm font-medium text-ink" id="shell-theme-label">
              {t("shell.theme")}
            </span>
            {/* biome-ignore lint/a11y/useSemanticElements: the design system's Segmented control. */}
            <div className="ds-seg self-start" role="group" aria-labelledby="shell-theme-label">
              {THEMES.map((th) => (
                <button
                  key={th}
                  type="button"
                  data-testid={`shell-theme-${th}`}
                  aria-pressed={theme === th}
                  onClick={() => setTheme(th)}
                >
                  {t(THEME_LABEL[th])}
                </button>
              ))}
            </div>
          </div>
          {/* The back office stays in English (plan §1.18): only the portal offers languages. */}
          {surface === "portal" ? <LanguageMenu /> : null}
          <button
            type="button"
            data-testid="shell-sign-out"
            onClick={() => void signOut()}
            className="ds-btn ds-btn--link mt-3"
          >
            {t("shell.signOut")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** A sidebar item: an icon, its words, and a count (signal while something waits). */
export function SidebarLink({
  to,
  label,
  icon,
  count,
  countTone = "warning",
  reserveCount = false,
  end,
  testId,
  children,
}: {
  to: string;
  label?: string;
  icon?: IconName;
  count?: number | undefined;
  /** `warning` (signal) for waiting-on-you counts; `neutral` for plain totals. */
  countTone?: "warning" | "neutral";
  /** Keep the count's slot while it loads (undefined), so the row doesn't shift. */
  reserveCount?: boolean;
  end?: boolean;
  testId?: string;
  children?: ReactNode;
}) {
  const { rail } = useContext(SidebarRail);
  return (
    <NavLink
      to={to}
      end={end ?? false}
      data-testid={testId}
      data-tip={rail ? label : undefined}
      // ds-navitem draws the current page from the aria-current NavLink sets.
      className="ds-navitem ui-navitem"
    >
      <span className="flex min-w-0 items-center gap-2.5">
        {icon ? <Icon name={icon} className="ui-navitem__icon" /> : null}
        <span className="ui-navitem__label min-w-0">
          {children ?? <span className="block truncate">{label}</span>}
        </span>
      </span>
      {rail ? (
        // On the rail a count rides on the icon's corner, and only while something waits.
        count ? (
          <span className="ui-navitem__count">
            <Count n={count} tone={countTone} small />
          </span>
        ) : null
      ) : count !== undefined ? (
        <Count n={count} tone={countTone} />
      ) : reserveCount ? (
        <CountSlot />
      ) : null}
    </NavLink>
  );
}

export function SidebarSection({
  label,
  action,
  children,
  testId,
}: {
  label: string;
  action?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  const { rail } = useContext(SidebarRail);
  return (
    // Utilities outrank shell.css, so the rail's spacing is chosen here rather than overridden.
    <section className={cx("ui-navsection", !rail && "mt-5")} data-testid={testId}>
      {rail ? (
        <h2 className="sr-only">{label}</h2>
      ) : (
        <div className="mb-1.5 flex items-center justify-between px-2.5">
          <h2 className="eyebrow text-ink-muted">{label}</h2>
          {action}
        </div>
      )}
      <div className="flex flex-col gap-0.5">{children}</div>
    </section>
  );
}

/** A count's place while it loads: an invisible count of the same size. */
function CountSlot() {
  return (
    <span aria-hidden className="invisible" data-testid="count-slot">
      <Count n={0} />
    </span>
  );
}

/** Rows that hold the agents' place in the sidebar while they load, the size of real rows. */
export function SidebarAgentSkeleton({ rows }: { rows: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: identical placeholder rows.
          key={i}
          aria-hidden
          data-testid="sidebar-agent-skeleton"
          className="ds-navitem ui-navitem ui-navagent ui-navskel"
        >
          <span className="flex min-w-0 items-center gap-2.5">
            <span className="ui-agentbadge ui-agentbadge--sm ui-skel" />
            <span className="ui-navitem__label flex min-w-0 flex-col gap-1">
              <span className="ui-skel ui-navskel__bar--name" />
              <span className="ui-skel ui-navskel__bar--line" />
            </span>
          </span>
        </div>
      ))}
    </>
  );
}

/** An agent's row in the sidebar: its badge, its name, and a muted line (role · status). */
export function SidebarAgent({
  to,
  name,
  line,
  badge,
  testId,
}: {
  to: string;
  name: string;
  line?: ReactNode;
  badge: ReactNode;
  testId?: string;
}) {
  const { rail } = useContext(SidebarRail);
  return (
    <NavLink
      to={to}
      data-testid={testId}
      data-tip={rail ? name : undefined}
      className="ds-navitem ui-navitem ui-navagent"
    >
      <span className="flex min-w-0 items-center gap-2.5">
        {badge}
        <span className="ui-navitem__label min-w-0">
          <span className="block truncate text-ink">{name}</span>
          {line ? <span className="block truncate text-xs text-ink-muted">{line}</span> : null}
        </span>
      </span>
    </NavLink>
  );
}

/** How tall the fade over the nav's last rows is while more is below (shell.css). */
const NAV_FADE_PX = 32;

/** Where each surface's sidebar was scrolled to, for this page load. */
const navScrollTops = new Map<string, number>();

/**
 * The sidebar keeps its place (staging QA, 2026-11-22: rows below the fold, and the sidebar back
 * at the top after each move). Its scroll is remembered as it changes and given back if the frame
 * is drawn again, and on a move the current page's row is brought into view only when it is out of
 * sight (a page opened from search or a link), never when it already shows.
 */
// DECISION: remembered for the page load only (a module map), not in storage: a reload starts at
// the top with the current row in view, which the second effect gives.
export function useNavScroll(
  navRef: { current: HTMLElement | null },
  surface: string,
  pathname: string,
): void {
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const saved = navScrollTops.get(surface);
    if (saved) nav.scrollTop = saved;
    const keep = () => navScrollTops.set(surface, nav.scrollTop);
    nav.addEventListener("scroll", keep, { passive: true });
    return () => nav.removeEventListener("scroll", keep);
  }, [navRef, surface]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: checked again on each page change.
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const show = () => {
      const row = nav.querySelector<HTMLElement>('[aria-current="page"]');
      if (!row) return;
      const box = nav.getBoundingClientRect();
      const at = row.getBoundingClientRect();
      // Clear of the fade at the nav's foot (shell.css, `data-more`), not only inside its box.
      const bottom = box.bottom - NAV_FADE_PX;
      if (box.height === 0 || (at.top >= box.top && at.bottom <= bottom)) return;
      // The nav alone moves (never the page behind it), by just enough to show the row.
      nav.scrollTop += at.top < box.top ? at.top - box.top : at.bottom - bottom;
    };
    show();
    // On a first load the rows still move as the fonts and counts arrive: checked again as they
    // settle, for a moment, unless the person has taken the sidebar in hand by then.
    let touched = false;
    const touch = () => {
      touched = true;
    };
    const until = Date.now() + 2000;
    const again = () => {
      if (!touched && Date.now() < until) show();
    };
    nav.addEventListener("wheel", touch, { passive: true });
    nav.addEventListener("pointerdown", touch);
    nav.addEventListener("keydown", touch);
    const seen = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(again);
    for (const child of nav.children) seen?.observe(child);
    let live = true;
    void document.fonts?.ready.then(() => {
      if (live) requestAnimationFrame(again);
    });
    return () => {
      live = false;
      seen?.disconnect();
      nav.removeEventListener("wheel", touch);
      nav.removeEventListener("pointerdown", touch);
      nav.removeEventListener("keydown", touch);
    };
  }, [navRef, pathname]);
}

/** Forgets the remembered sidebar scroll (tests). */
export function resetNavScroll(): void {
  navScrollTops.clear();
}

/**
 * Whether the sidebar's nav has rows below what shows (staging feedback, 2026-11-21: the pinned
 * foot needs a mark that the list goes on under it). Read on scroll and whenever its size changes.
 */
function useMoreBelow(
  navRef: { current: HTMLElement | null },
  rail: boolean,
  pathname: string,
): boolean {
  const [more, setMore] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: measured again when the rail folds or the page changes.
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const read = () => setMore(nav.scrollTop + nav.clientHeight < nav.scrollHeight - 1);
    read();
    nav.addEventListener("scroll", read, { passive: true });
    const seen = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(read);
    seen?.observe(nav);
    for (const child of nav.children) seen?.observe(child);
    return () => {
      nav.removeEventListener("scroll", read);
      seen?.disconnect();
    };
  }, [navRef, rail, pathname]);
  return more;
}
