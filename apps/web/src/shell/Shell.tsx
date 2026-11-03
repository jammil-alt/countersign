// The frame both surfaces share (docs/design/screens/1-home.png): a header with the platform mark,
// a context slot (the operator's client switcher, or the client's name in the portal), the command
// bar placeholder, the inbox count and the avatar; a sidebar; the page.
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link, NavLink } from "react-router-dom";
import { displayName, userInitial, useSession, useSessionState } from "../session/session";
import { Count, cx } from "../ui/primitives";

export const PLATFORM_NAME = "Countersign";

export function Mark() {
  return (
    <span
      aria-hidden
      className="inline-flex size-7 items-center justify-center rounded-sm bg-primary text-[13px] text-card"
    >
      ◆
    </span>
  );
}

export function AppShell({
  surface,
  home,
  context,
  inboxTo,
  inboxCount,
  sidebar,
  children,
}: {
  surface: "ops" | "portal";
  home: string;
  context: ReactNode;
  inboxTo: string;
  inboxCount?: number | undefined;
  sidebar: ReactNode;
  children: ReactNode;
}) {
  return (
    <div data-testid={`shell-${surface}`} className="flex min-h-screen flex-col bg-ground">
      <header className="sticky top-0 z-20 flex h-header items-center gap-6 border-b border-edge bg-card px-5">
        <Link to={home} className="flex items-center gap-3 font-semibold text-primary">
          <Mark />
          <span className="text-[15px]">{PLATFORM_NAME}</span>
        </Link>
        <span aria-hidden className="h-6 border-l border-edge" />
        <div className="min-w-0 shrink-0">{context}</div>
        <div className="flex flex-1 justify-center">
          {/* The command bar arrives later (docs/design/README.md: not yet in v1 scope). */}
          <input
            data-testid="shell-command-bar"
            aria-label="Command bar"
            disabled
            placeholder="Ask an agent, or type / for a command"
            className="h-9 w-full max-w-[560px] rounded-sm border border-control bg-card px-3 text-[15px] placeholder:text-secondary"
          />
        </div>
        <Link
          to={inboxTo}
          data-testid="shell-inbox"
          className="flex items-center gap-2 text-sm text-primary"
        >
          Inbox
          {inboxCount !== undefined ? <Count n={inboxCount} /> : null}
        </Link>
        <UserMenu />
      </header>
      <div className="flex flex-1">
        <aside
          aria-label="Navigation"
          className="w-sidebar shrink-0 border-r border-edge bg-ground px-3 py-3"
        >
          {sidebar}
        </aside>
        <main className="min-w-0 flex-1 px-8 py-7">{children}</main>
      </div>
    </div>
  );
}

function UserMenu() {
  const session = useSession();
  const { signOut } = useSessionState();
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
        aria-label={`Account: ${displayName(session.user)}`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex size-7 items-center justify-center rounded-sm bg-persona-umber text-xs font-semibold text-on-action"
      >
        {userInitial(session.user)}
      </button>
      {open ? (
        <div className="absolute right-0 mt-2 w-64 rounded-md border border-edge bg-card p-3 elevation-md">
          <p className="font-medium text-primary">{displayName(session.user)}</p>
          <p className="truncate text-xs text-secondary">{session.user.email}</p>
          <button
            type="button"
            data-testid="shell-sign-out"
            onClick={() => void signOut()}
            className="mt-3 text-sm text-link underline"
          >
            Sign out
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
      className={({ isActive }) =>
        cx(
          "flex items-center justify-between gap-2 rounded-sm px-2.5 py-2 text-[15px]",
          isActive ? "bg-selected font-medium text-selected-ink" : "text-primary hover:bg-subtle",
        )
      }
    >
      {children ?? <span>{label}</span>}
      {count !== undefined ? (
        <span className="font-mono text-xs text-secondary">{count}</span>
      ) : null}
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
      <div className="mb-1 flex items-center justify-between px-2.5">
        <h2 className="label-caps text-secondary">{label}</h2>
        {action}
      </div>
      <div className="flex flex-col gap-0.5">{children}</div>
    </section>
  );
}
