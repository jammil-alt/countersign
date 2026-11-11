// The frame both surfaces share (docs/design/prototype.html, `.hdr` and `.side`, on the Mezonas
// AppHeader and Sidebar): a top bar with the logo, a context slot (the client's name in the portal;
// "Back office" and the client switcher in the back office), the ⌘K search box, the portal's Ask
// Sloan button, the Inbox or Escalations with its count, and the avatar menu (theme, language,
// sign out); a sidebar; the page. At phone width the sidebar folds behind a menu button
// and the top bar compacts; where a surface keeps its inbox out of the top bar (`inHeader: false`),
// the menu button carries its count. Feedback floats at the bottom right.
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { FEEDBACK_LAYER_ATTR } from "../feedback/capture";
import { useFeedbackStarter } from "../feedback/Feedback";
import type { MessageKey } from "../i18n/catalog";
import { useI18n } from "../i18n/i18n";
import { LanguageMenu } from "../i18n/LanguageMenu";
import { displayName, userInitial, useSession, useSessionState } from "../session/session";
import { Logo, LogoMark, PRODUCT_NAME } from "../ui/brand";
import { Icon, type IconName } from "../ui/icons";
import { Count, cx } from "../ui/primitives";
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
  search: { placeholder: string; run: SearchRun; ask?: SearchAsk };
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
  const { pathname } = useLocation();
  const deskInHeader = desk.inHeader ?? true;
  // Folded on a wide screen: a rail of icons, the words for screen readers and in tooltips.
  const rail = wide && collapsed;
  const menuCount = !deskInHeader && desk.count ? desk.count : 0;
  const asideRef = useRef<HTMLElement>(null);
  const tip = useRailTip(asideRef, rail, pathname);
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
          <SearchBox placeholder={search.placeholder} run={search.run} ask={search.ask} />
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
      <FeedbackButton />
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
            <div className="ui-sidebar__nav">{sidebar}</div>
            {sidebarFooter || wide ? (
              <div className="ui-sidebar__foot">
                {sidebarFooter}
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
          <HeaderSwitcherProvider switcher={switcher ?? null}>{children}</HeaderSwitcherProvider>
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
 * Feedback: floating at the bottom right of every screen, as in Plenary Labs (2026-11-10, the
 * owner: back out of the avatar menu, where QA round 1 had put it). An icon and "Feedback"; the icon
 * alone at phone width. Only where feedback is on for the session (always in the back office; per
 * client in the portal). Its name says what it is for: problems with the app (Sloan takes other
 * asks).
 */
function FeedbackButton() {
  const { t } = useI18n();
  const startFeedback = useFeedbackStarter();
  if (!startFeedback) return null;
  return (
    <button
      type="button"
      data-testid="feedback-button"
      aria-label={t("feedback.button")}
      title={t("feedback.button")}
      onClick={() => startFeedback()}
      className="ui-feedback-fab"
      // Part of the feedback layer: left out of the picture and never the pinned element.
      {...{ [FEEDBACK_LAYER_ATTR]: "" }}
    >
      <Icon name="message" size={20} />
      <span className="ui-feedback-fab__label">{t("feedback.short")}</span>
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
