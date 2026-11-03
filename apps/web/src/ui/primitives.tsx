// Groundwork primitives used by both shells. Colours come only from the token theme in
// styles.css (bg-card, text-secondary, border-edge, …), never raw values.
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { isApiError } from "../api/client";

export type Tone = "neutral" | "accent" | "positive" | "warning";

const TONE: Record<Tone, string> = {
  neutral: "bg-tone-neutral text-tone-neutral-ink border-tone-neutral-edge",
  accent: "bg-tone-accent text-tone-accent-ink border-tone-accent-edge",
  positive: "bg-tone-positive text-tone-positive-ink border-tone-positive-edge",
  warning: "bg-tone-warning text-tone-warning-ink border-tone-warning-edge",
};

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

/** The design's boxed small-caps badge: LIVE, DRAFT · V1, SKILL, FORK. */
export function Badge({
  tone = "neutral",
  children,
  className,
  testId,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <span
      data-testid={testId}
      className={cx(
        "label-caps inline-flex items-center rounded-sm border px-1.5 py-0.5 leading-none whitespace-nowrap",
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** A small count next to a nav item (Inbox 5). */
export function Count({ n, tone = "accent" }: { n: number; tone?: Tone }) {
  return (
    <span
      className={cx(
        "inline-flex min-w-5 justify-center rounded-sm border px-1 font-mono text-[11px]",
        TONE[tone],
      )}
    >
      {n}
    </span>
  );
}

type ButtonVariant = "primary" | "secondary" | "ghost";

/** For links that look like buttons (a <button> inside an <a> is invalid). */
export function buttonClass(variant: ButtonVariant = "secondary", className?: string): string {
  return cx(
    "inline-flex h-control items-center gap-2 rounded-md px-4 text-sm font-medium transition-colors disabled:opacity-50",
    variant === "primary" &&
      "bg-action text-on-action hover:bg-action-hover active:bg-action-pressed",
    variant === "secondary" && "border border-control bg-card text-primary hover:bg-hover",
    variant === "ghost" && "text-body hover:bg-subtle",
    className,
  );
}

export function Button({
  variant = "secondary",
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return <button type="button" {...rest} className={buttonClass(variant, className)} />;
}

export function Card({
  children,
  className,
  dashed,
  testId,
}: {
  children: ReactNode;
  className?: string;
  dashed?: boolean;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className={cx(
        "rounded-lg border bg-card",
        dashed ? "border-dashed border-control" : "border-edge",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** "YOUR AGENTS", "NEEDS YOU": the section label above a block. */
export function SectionLabel({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between">
      <h2 className="label-caps text-secondary">{children}</h2>
      {action}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
  leading,
  badge,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  leading?: ReactNode;
  badge?: ReactNode;
}) {
  return (
    <header className="mb-6 flex items-start justify-between gap-6">
      <div className="flex min-w-0 items-start gap-4">
        {leading}
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-[28px] leading-tight font-semibold text-primary">{title}</h1>
            {badge}
          </div>
          {subtitle ? <p className="mt-1 text-secondary">{subtitle}</p> : null}
        </div>
      </div>
      {actions ? <div className="flex shrink-0 gap-2">{actions}</div> : null}
    </header>
  );
}

const PERSONA_BG = [
  "bg-persona-sienna",
  "bg-persona-slate",
  "bg-persona-pine",
  "bg-persona-mustard",
  "bg-persona-plum",
  "bg-persona-brick",
  "bg-persona-juniper",
  "bg-persona-umber",
  "bg-persona-indigo",
  "bg-persona-rosewood",
  "bg-persona-teal",
  "bg-persona-flint",
] as const;

/** "MC" for Material costs; one word gives its first two letters. */
export function agentInitials(name: string): string {
  const words = name.split(/[\s_-]+/).filter(Boolean);
  const letters =
    words.length > 1
      ? `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}`
      : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

/** A stable persona colour per agent, so an agent keeps its colour on every screen. */
export function personaClass(seed: string): string {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PERSONA_BG[h % PERSONA_BG.length] ?? PERSONA_BG[0];
}

export function AgentAvatar({
  name,
  seed,
  size = "sm",
}: {
  name: string;
  seed: string;
  size?: "sm" | "md" | "lg";
}) {
  return (
    <span
      aria-hidden
      className={cx(
        "inline-flex shrink-0 items-center justify-center rounded-sm font-semibold text-on-action",
        personaClass(seed),
        size === "sm" && "size-6 text-[10px]",
        size === "md" && "size-8 text-xs",
        size === "lg" && "size-11 text-base",
      )}
    >
      {agentInitials(name)}
    </span>
  );
}

/** Underlined tabs as on the agent page; each tab is a route. */
export function Tabs({
  items,
}: {
  /** `active` overrides the URL match (a tab that owns several routes). */
  items: { to: string; label: string; count?: number; end?: boolean; active?: boolean }[];
}) {
  return (
    <nav className="flex gap-6 border-b border-edge" aria-label="Sections">
      {items.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.end ?? false}
          className={({ isActive }) =>
            cx(
              "-mb-px border-b-2 pb-2.5 text-[15px]",
              (t.active ?? isActive)
                ? "border-action font-medium text-primary"
                : "border-transparent text-body hover:text-primary",
            )
          }
        >
          {t.label}
          {t.count !== undefined ? (
            <span className="ml-1.5 font-mono text-xs text-secondary">{t.count}</span>
          ) : null}
        </NavLink>
      ))}
    </nav>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <p role="status" className="py-6 text-secondary">
      {label}
    </p>
  );
}

/** What a failed load says. Server codes are shown so a contract break is recognisable. */
export function ErrorNotice({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = isApiError(error)
    ? error.status === 404
      ? "Not found."
      : error.status === 403
        ? "You don't have access to this."
        : error.message
    : error instanceof Error
      ? error.message
      : String(error);
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-4 rounded-md border border-tone-warning-edge bg-tone-warning px-4 py-3 text-tone-warning-ink"
    >
      <span>
        {message}
        {isApiError(error) ? (
          <span className="ml-2 font-mono text-xs opacity-70">{error.code}</span>
        ) : null}
      </span>
      {onRetry ? (
        <Button variant="ghost" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

/** A screen from ARCHITECTURE §15 that later milestones fill in. */
export function Placeholder({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div data-testid="placeholder">
      <PageHeader title={title} />
      <Card dashed className="p-8 text-secondary">
        {children ?? "This screen comes in a later milestone."}
      </Card>
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <Card className="p-6 text-secondary">{children}</Card>;
}
