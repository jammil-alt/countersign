// The frame both surfaces share (docs/design/screens/1-home.png on the Mezonas AppHeader and
// Sidebar): a header with the Mezonas logo, a context slot (the operator's client switcher, or the
// client's name in the portal), the command bar placeholder, the inbox count and the avatar; a
// sidebar; the page.
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link, NavLink } from "react-router-dom";
import { useI18n } from "../i18n/i18n";
import { LanguageMenu } from "../i18n/LanguageMenu";
import { displayName, userInitial, useSession, useSessionState } from "../session/session";
import { Logo, PRODUCT_NAME } from "../ui/brand";
import { Icon } from "../ui/icons";
import { Count, cx } from "../ui/primitives";

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

export function AppShell({
  surface,
  home,
  place,
  context,
  inboxTo,
  inboxCount,
  sidebar,
  children,
}: {
  surface: "ops" | "portal";
  home: string;
  /** Where this is, for the tab's text: "Back office", or the client's name in the portal. */
  place: string | null;
  context: ReactNode;
  inboxTo: string;
  inboxCount?: number | undefined;
  sidebar: ReactNode;
  children: ReactNode;
}) {
  const { t } = useI18n();
  useEffect(() => {
    document.title = tabTitle(place, inboxCount);
  }, [place, inboxCount]);
  return (
    <div data-testid={`shell-${surface}`} className="flex min-h-screen flex-col bg-paper">
      <header className="ds-header sticky top-0 z-20 gap-5">
        <Link to={home} className="flex shrink-0 items-center rounded-sm" title={PLATFORM_NAME}>
          <Logo height={20} />
        </Link>
        <span aria-hidden className="h-5 w-px bg-line" />
        <div className="min-w-0 shrink-0">{context}</div>
        <div className="flex flex-1 justify-center">
          {/* The command bar arrives later (docs/design/README.md: not yet in v1 scope). */}
          <span className="relative w-full max-w-[560px]">
            <Icon
              name="search"
              className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-muted"
            />
            <input
              data-testid="shell-command-bar"
              aria-label={t("shell.commandBar")}
              disabled
              placeholder={t("shell.commandPlaceholder")}
              className="ds-input pl-9 disabled:bg-surface-subtle"
            />
          </span>
        </div>
        <Link
          to={inboxTo}
          data-testid="shell-inbox"
          className="flex shrink-0 items-center gap-2 rounded-sm text-sm font-medium text-ink hover:text-slate"
        >
          {t("shell.inbox")}
          {inboxCount !== undefined ? <Count n={inboxCount} tone="warning" /> : null}
        </Link>
        <UserMenu surface={surface} />
      </header>
      <div className="flex flex-1">
        <aside aria-label={t("shell.navigation")} className="ds-sidebar shrink-0">
          {sidebar}
        </aside>
        <main className="min-w-0 flex-1 px-10 py-8">{children}</main>
      </div>
    </div>
  );
}

function UserMenu({ surface }: { surface: "ops" | "portal" }) {
  const { t } = useI18n();
  const session = useSession();
  const { signOut } = useSessionState();
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
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div ref={ref} className="relative">
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
        <div className="absolute right-0 z-30 mt-2 w-80 rounded-md border border-line bg-surface p-4 elevation-pop">
          <p className="font-medium text-ink">{displayName(session.user)}</p>
          <p className="truncate text-sm text-ink-muted">{session.user.email}</p>
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

export function SidebarLink({
  to,
  label,
  count,
  end,
  testId,
  children,
}: {
  to: string;
  label?: string;
  count?: number | undefined;
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
      className="ds-navitem gap-2 leading-tight aria-[current=page]:font-medium"
    >
      {children ?? <span>{label}</span>}
      {count !== undefined ? <span className="text-xs text-ink-muted figures">{count}</span> : null}
    </NavLink>
  );
}

export function SidebarSection({
  label,
  action,
  children,
}: {
  label: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mt-5">
      <div className="mb-1.5 flex items-center justify-between px-2.5">
        <h2 className="eyebrow text-ink-muted">{label}</h2>
        {action}
      </div>
      <div className="flex flex-col gap-0.5">{children}</div>
    </section>
  );
}
