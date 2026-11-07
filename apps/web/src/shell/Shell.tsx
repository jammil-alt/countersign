// The frame both surfaces share (docs/design/prototype.html, `.hdr` and `.side`, on the Mezonas
// AppHeader and Sidebar): a top bar with the logo, a context slot (the client's name in the portal;
// "Back office" and the client switcher in the back office), the ⌘K search box, the Desk or
// Escalations with its count, and the avatar menu (theme, language, sign out); a sidebar; the page.
// At phone width the sidebar folds behind a menu button and the top bar compacts.
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { useFeedbackStarter } from "../feedback/Feedback";
import type { MessageKey } from "../i18n/catalog";
import { useI18n } from "../i18n/i18n";
import { LanguageMenu } from "../i18n/LanguageMenu";
import { displayName, userInitial, useSession, useSessionState } from "../session/session";
import { Logo, PRODUCT_NAME } from "../ui/brand";
import { Icon, type IconName } from "../ui/icons";
import { Count, cx } from "../ui/primitives";
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
  /** "/desk" in the portal, "/ops/inbox" (Escalations) in the back office. */
  to: string;
  label: string;
  /** Waiting on you (signal); undefined until it loads. */
  count?: number | undefined;
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
  pageBar,
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
  /** A slim bar above the page (the agent switcher on an agent's page). */
  pageBar?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);
  const { pathname } = useLocation();
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
          aria-label={t("shell.menu")}
          aria-expanded={menuOpen}
          aria-controls="shell-sidebar"
          onClick={() => setMenuOpen((o) => !o)}
          className="ds-btn ds-btn--ghost ds-btn--icon ui-topbar__menu"
        >
          <Icon name="sidebar" size={20} />
        </button>
        <Link to={home} className="ui-topbar__logo" title={PLATFORM_NAME}>
          <Logo height={18} />
        </Link>
        <span aria-hidden className="ui-topbar__sep" />
        <div className="ui-topbar__context">{context}</div>
        <div className="ui-topbar__search">
          <SearchBox placeholder={search.placeholder} run={search.run} ask={search.ask} />
        </div>
        <NavLink
          to={desk.to}
          data-testid="shell-inbox"
          aria-label={desk.count ? `${desk.label} (${desk.count})` : desk.label}
          className="ui-topbar__desk"
        >
          <Icon name="desk" className="ui-topbar__deskicon" />
          <span className="ui-topbar__desklabel">{desk.label}</span>
          {desk.count !== undefined ? <Count n={desk.count} tone="warning" /> : null}
        </NavLink>
        <UserMenu surface={surface} />
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
          id="shell-sidebar"
          aria-label={t("shell.navigation")}
          data-open={menuOpen ? "true" : undefined}
          className="ds-sidebar ui-sidebar"
        >
          <div className="ui-sidebar__nav">{sidebar}</div>
          {sidebarFooter ? <div className="ui-sidebar__foot">{sidebarFooter}</div> : null}
        </aside>
        <main className="ui-main">
          {pageBar ? <div className="ui-pagebar">{pageBar}</div> : null}
          {children}
        </main>
      </div>
    </div>
  );
}

const THEME_LABEL = {
  system: "shell.theme.system",
  light: "shell.theme.light",
  dark: "shell.theme.dark",
} as const satisfies Record<Theme, MessageKey>;

function UserMenu({ surface }: { surface: "ops" | "portal" }) {
  const { t } = useI18n();
  const session = useSession();
  const { signOut } = useSessionState();
  const [theme, setTheme] = useTheme();
  const startFeedback = useFeedbackStarter();
  // The operator is Mezonas staff, a person on the client's account: copper, like the lead. A
  // client user is the signed-in self: ink.
  const operator = session.operator;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

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
          {startFeedback ? (
            <button
              type="button"
              data-testid="feedback-button"
              onClick={() => {
                setOpen(false);
                startFeedback();
              }}
              className="ds-btn ds-btn--link mt-3 flex items-center gap-1.5"
            >
              <Icon name="message" size={16} />
              {t("feedback.button")}
            </button>
          ) : null}
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
  end?: boolean;
  testId?: string;
  children?: ReactNode;
}) {
  return (
    <NavLink
      to={to}
      end={end ?? false}
      data-testid={testId}
      // ds-navitem draws the current page from the aria-current NavLink sets.
      className="ds-navitem ui-navitem"
    >
      <span className="flex min-w-0 items-center gap-2.5">
        {icon ? <Icon name={icon} className="ui-navitem__icon" /> : null}
        {children ?? <span className="truncate">{label}</span>}
      </span>
      {count !== undefined ? <Count n={count} tone={countTone} /> : null}
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
  return (
    <section className="mt-5" data-testid={testId}>
      <div className="mb-1.5 flex items-center justify-between px-2.5">
        <h2 className="eyebrow text-ink-muted">{label}</h2>
        {action}
      </div>
      <div className="flex flex-col gap-0.5">{children}</div>
    </section>
  );
}

/** A folded group of the pages that aren't in the prototype's sidebar, so none is lost. */
export function SidebarMore({
  label,
  children,
  testId,
}: {
  label: string;
  children: ReactNode;
  testId?: string;
}) {
  const { pathname } = useLocation();
  const ref = useRef<HTMLDetailsElement>(null);
  // Open while one of its pages is the current one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: rechecks on each page change.
  useEffect(() => {
    const el = ref.current;
    if (el?.querySelector('[aria-current="page"]')) el.open = true;
  }, [pathname]);
  return (
    <details ref={ref} className="ui-more mt-5" data-testid={testId}>
      <summary className="ui-more__summary">
        <span className="eyebrow text-ink-muted">{label}</span>
        <Icon name="chevron-down" size={14} className="ui-more__chev text-ink-muted" />
      </summary>
      <div className="mt-1.5 flex flex-col gap-0.5">{children}</div>
    </details>
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
  return (
    <NavLink to={to} data-testid={testId} className="ds-navitem ui-navitem ui-navagent">
      <span className="flex min-w-0 items-center gap-2.5">
        {badge}
        <span className="min-w-0">
          <span className="block truncate text-ink">{name}</span>
          {line ? <span className="block truncate text-xs text-ink-muted">{line}</span> : null}
        </span>
      </span>
    </NavLink>
  );
}
