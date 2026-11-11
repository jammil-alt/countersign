// Mezonas primitives used by both shells: thin wrappers over the design system's component classes
// (ds-btn, ds-pill, ds-tag, ds-card, ds-avatar, ds-banner, ds-empty), so screens say `<Badge>` and
// `<Button>` and get the brand. Colours come only from the token theme in styles.css (bg-surface,
// text-ink-muted, border-line, …), never raw values.
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Link, NavLink } from "react-router-dom";
import { isApiError } from "../api/client";
import { errorText } from "../i18n/errors";
import { useI18n } from "../i18n/i18n";
import { cx } from "./cx";
import { Icon, type IconName } from "./icons";
import { Skeleton, SkeletonLine, SkeletonText } from "./skeleton";

export { cx } from "./cx";

/**
 * What a status means (brand book): neutral = nothing happened yet; accent (slate) = the team is on
 * it; positive = done, signed, approved; warning (signal gold) = waiting on you; risk = failed;
 * person (copper) = a person's touch. Every pill is a word, never colour alone.
 */
export type Tone = "neutral" | "accent" | "positive" | "warning" | "risk" | "person";

const PILL: Record<Tone, string> = {
  neutral: "ds-pill--neutral",
  accent: "ds-pill--accent",
  positive: "ds-pill--positive",
  warning: "ds-pill--warning",
  // DECISION: the design system's StatusPill has no risk or copper tone; these two compose the
  // pill from the risk and copper tokens (Banner's risk-ink/risk-tint/risk-line, the lead's
  // copper-ink on copper-tint) rather than adding colours.
  risk: "border-risk-line bg-risk-tint text-risk-ink",
  person: "border-copper-tint bg-copper-tint text-copper-ink",
};

/** The StatusPill classes for a tone. */
export function pillClass(tone: Tone): string {
  return cx("ds-pill", PILL[tone]);
}

/** A status pill (StatusPill): "Live · v4", "Draft", "Needs approval", "Failed". */
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
    <span data-testid={testId} className={cx("ds-pill", PILL[tone], className)}>
      {children}
    </span>
  );
}

/**
 * A descriptive label for a kind of work (Tag): "Trigger", "Action", "QuickBooks". Not a status.
 * `person` marks work a person does (a person step): copper, the brand's colour for people.
 */
export function Tag({
  children,
  tone = "neutral",
  className,
  testId,
}: {
  children: ReactNode;
  tone?: "neutral" | "person";
  className?: string;
  testId?: string;
}) {
  return (
    <span
      data-testid={testId}
      className={cx(
        "ds-tag whitespace-nowrap",
        tone === "person" && "border-copper-tint bg-copper-tint text-copper-ink",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** A step's kind as a Tag: person steps in copper, every other kind (the agents' work) in ink. */
export function StepKindTag({ kind, label }: { kind: string; label: string }) {
  return <Tag tone={kind === "person" ? "person" : "neutral"}>{label}</Tag>;
}

/**
 * A count badge (Inbox 5). Waiting-on-you counts use the signal tone; a zero count stays neutral,
 * since nothing waits.
 */
export function Count({
  n,
  tone = "neutral",
  small = false,
}: {
  n: number;
  tone?: Tone;
  /** On an icon's corner (the folded sidebar): smaller, so the icon stays clear. */
  small?: boolean;
}) {
  return (
    <span
      className={cx(
        "ds-pill justify-center figures",
        small ? "h-4 min-w-4 px-1 py-0 text-[10px] leading-4" : "min-w-6 px-1.5 py-[3px] text-xs",
        PILL[n === 0 ? "neutral" : tone],
      )}
    >
      {n}
    </span>
  );
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "link";

/** For links that look like buttons (a <button> inside an <a> is invalid). */
export function buttonClass(
  variant: ButtonVariant = "secondary",
  className?: string,
  size?: "sm",
): string {
  return cx("ds-btn", `ds-btn--${variant}`, size === "sm" && "ds-btn--sm", className);
}

export function Button({
  variant = "secondary",
  size,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: "sm" }) {
  return <button type="button" {...rest} className={buttonClass(variant, className, size)} />;
}

/**
 * A sheet on the table: `surface` with a `line` hairline, `radius-md`, no shadow. With a `title`
 * (and a right-side `meta`) it gets the card's head row; a `footer` gets a foot row; `pad` pads the
 * body (20px 24px) for cards that aren't lists.
 */
export function Card({
  children,
  className,
  dashed,
  testId,
  title,
  meta,
  footer,
  pad,
  titleAbove,
}: {
  children: ReactNode;
  className?: string;
  dashed?: boolean;
  testId?: string;
  title?: ReactNode;
  meta?: ReactNode;
  footer?: ReactNode;
  pad?: boolean;
  /**
   * A table or a list of rows: the title (and meta) sit above the card, not in a header band
   * inside it. `testId` goes on the whole group, `className` on the card.
   */
  titleAbove?: boolean;
}) {
  // DECISION: tables and row lists carry a plain title above them, not a bordered header band
  // (2026-11-10, the owner's call); cards about one thing keep their header inside.
  if (titleAbove && (title || meta)) {
    return (
      <section data-testid={testId} className="ui-cardgroup">
        <div className="ui-section__head">
          {title ? <h3 className="type-subheading text-ink">{title}</h3> : <span />}
          {meta ? <div className="ui-card__meta">{meta}</div> : null}
        </div>
        <div className={cx("ds-card", dashed && "border-dashed border-line-strong", className)}>
          {pad ? <div className="ui-card__body">{children}</div> : children}
          {footer ? <div className="ui-card__foot">{footer}</div> : null}
        </div>
      </section>
    );
  }
  return (
    <div
      data-testid={testId}
      className={cx("ds-card", dashed && "border-dashed border-line-strong", className)}
    >
      {title || meta ? (
        <div className="ui-card__head">
          {title ? <h3 className="type-subheading text-ink">{title}</h3> : <span />}
          {meta ? <div className="ui-card__meta">{meta}</div> : null}
        </div>
      ) : null}
      {pad ? <div className="ui-card__body">{children}</div> : children}
      {footer ? <div className="ui-card__foot">{footer}</div> : null}
    </div>
  );
}

/** "YOUR AGENTS", "NEEDS YOU": the eyebrow above a block. */
export function SectionLabel({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-3">
      <h2 className="eyebrow text-ink-muted">{children}</h2>
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
  eyebrow,
  beside,
}: {
  /** "THURSDAY, NOVEMBER 5", "RUNS / R-2287": a kicker above the title. */
  eyebrow?: ReactNode;
  /** After the eyebrow, as the next step of a breadcrumb (the agent switcher). */
  beside?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  leading?: ReactNode;
  badge?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
      <div className="flex min-w-0 items-start gap-4">
        {leading}
        <div className="min-w-0">
          {eyebrow && beside ? (
            <div className="ui-crumbs mb-2">
              <p className="eyebrow text-ink-muted">{eyebrow}</p>
              {beside}
            </div>
          ) : eyebrow ? (
            <p className="eyebrow mb-2 text-ink-muted">{eyebrow}</p>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="type-title text-ink">{title}</h1>
            {badge}
          </div>
          {subtitle ? <p className="mt-1 text-ink-muted">{subtitle}</p> : null}
        </div>
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
    </header>
  );
}

/** "MC" for Material costs; one word gives its first two letters. */
export function agentInitials(name: string): string {
  const words = name.split(/[\s_-]+/).filter(Boolean);
  const letters =
    words.length > 1
      ? `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}`
      : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

/**
 * An agent's avatar: round initials on a slate fill, as the brand's team roles are (Avatar). Every
 * agent looks the same; its name, not a colour, tells them apart.
 */
export function AgentAvatar({
  name,
  size = "sm",
}: {
  name: string;
  /** Kept for callers; agents no longer get a colour per seed. */
  seed?: string;
  size?: "sm" | "md" | "lg";
}) {
  return (
    <span
      aria-hidden
      className={cx(
        "ds-avatar bg-slate font-medium text-on-slate",
        size === "sm" && "ds-avatar--sm",
        size === "lg" && "ds-avatar--lg",
      )}
    >
      {agentInitials(name)}
    </span>
  );
}

/** Underlined tabs (Tabs) as on the agent page; each tab is a route. */
export function Tabs({
  items,
}: {
  /** `active` overrides the URL match (a tab that owns several routes). */
  items: { to: string; label: string; count?: number; end?: boolean; active?: boolean }[];
}) {
  const { t } = useI18n();
  // On a phone the row scrolls sideways inside itself, not the page. The hairline under it is
  // drawn as its background, so the active tab's underline covers it without a negative margin
  // (which would make a scrolling row scroll a pixel down too).
  return (
    <nav
      className="flex gap-5 overflow-x-auto bg-[linear-gradient(var(--line),var(--line))] bg-[length:100%_1px] bg-bottom bg-no-repeat"
      aria-label={t("common.sections")}
    >
      {items.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.end ?? false}
          className={({ isActive }) =>
            cx(
              "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 py-3 text-sm leading-none font-medium",
              (t.active ?? isActive)
                ? "border-slate text-ink"
                : "border-transparent text-ink-muted hover:text-ink",
            )
          }
        >
          {t.label}
          {t.count !== undefined ? (
            <span className="text-xs text-ink-muted figures">{t.count}</span>
          ) : null}
        </NavLink>
      ))}
    </nav>
  );
}

/**
 * A small switch between the pages of one tab (the Segmented, ds-seg), each a route: the client
 * page's Data (Documents, Records) and Setup (Connections, Messaging, …), instead of more top tabs.
 */
export function SubTabs({
  items,
  label,
  testId,
}: {
  items: { to: string; label: string; active: boolean; testId?: string }[];
  /** What the switch chooses, for screen readers. */
  label: string;
  testId?: string;
}) {
  return (
    <nav className="ds-seg ui-subtabs" aria-label={label} data-testid={testId}>
      {items.map((i) => (
        <Link
          key={i.to}
          to={i.to}
          aria-current={i.active ? "page" : undefined}
          data-testid={i.testId}
          className="ui-subtabs__item"
        >
          {i.label}
        </Link>
      ))}
    </nav>
  );
}

/**
 * Something still loading, as a skeleton (./skeleton.tsx), never a line of text: three lines of
 * text by default (a panel, a card, a section), or `size="line"` for a small slot beside other
 * words. `label` says what loads, for screen readers only ("Loading the price…"); without one
 * they hear "Loading…". A screen that knows its content's shape passes it to `Loaded` instead.
 */
// DECISION: the label is read, not shown (docs/audit-plan.md 1.3: no loading text after the frame
// is up). A screen that must show progress in words ("Saving…") says it in its own control.
export function Loading({ label, size = "block" }: { label?: string; size?: "block" | "line" }) {
  return (
    <Skeleton label={label} className={`ui-skel-wrap--${size}`}>
      {size === "line" ? <SkeletonLine /> : <SkeletonText lines={3} />}
    </Skeleton>
  );
}

/**
 * What a failed load says, as a risk Banner, in the reader's language (by the error's code).
 * Plain words only: the server's code ("tenant_forbidden") never shows; it stays on the element
 * (`data-error-code`) for support and tests.
 */
// DECISION: the code was shown so a contract break was recognisable; people read it as part of
// the message ("You don't have access to this. tenant_forbidden"), so it moved to an attribute.
export function ErrorNotice({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const i18n = useI18n();
  const message = errorText(error, i18n);
  return (
    <div
      role="alert"
      className="ds-banner items-center"
      {...(isApiError(error) ? { "data-error-code": error.code } : {})}
    >
      <Icon name="alert" className="mt-px" />
      <span className="min-w-0 flex-1">{message}</span>
      {onRetry ? (
        <Button variant="ghost" size="sm" onClick={onRetry} className="text-risk">
          {i18n.t("common.tryAgain")}
        </Button>
      ) : null}
    </div>
  );
}

/** A screen from ARCHITECTURE §15 that later milestones fill in. */
export function Placeholder({ title, children }: { title: string; children?: ReactNode }) {
  const { t } = useI18n();
  return (
    <div data-testid="placeholder">
      <PageHeader title={title} />
      <div className="ds-empty">
        <span className="eyebrow text-ink-muted">{t("common.notBuiltTitle")}</span>
        <span className="text-ink-muted">{children ?? t("common.notBuiltBody")}</span>
      </div>
    </div>
  );
}

/** What an empty state offers to do: a link to where it fills, or a button. */
export type EmptyAction =
  | { label: string; to: string; testId?: string }
  | { label: string; onClick: () => void; testId?: string };

/**
 * Says what will appear here and how it fills (EmptyState): an icon in a soft tile, an optional
 * `title`, the line (`line` or `children`), and an optional `action` (a link or a button), all
 * centred. `tone="done"` is good news (nothing waits: a check in the positive tint); `compact`
 * fits inside a card or a side panel. `<EmptyState>No runs yet.</EmptyState>` still works.
 * DECISION: one empty state for the app (2026-11-10): centred, with an icon tile and a solid
 * hairline instead of the pattern's dashed box, which read as "drop something here".
 */
export function EmptyState({
  title,
  line,
  action,
  icon,
  tone = "neutral",
  compact = false,
  testId,
  children,
}: {
  title?: ReactNode;
  line?: ReactNode;
  action?: EmptyAction | undefined;
  /** The tile's icon: what would be here (runs, clients, documents…). Defaults to info, or a check when done. */
  icon?: IconName;
  tone?: "neutral" | "done";
  /** Inside a card or panel: no border of its own, less room. */
  compact?: boolean;
  testId?: string;
  children?: ReactNode;
}) {
  const text = line ?? children;
  return (
    <div
      className={cx(
        "ds-empty ui-empty",
        tone === "done" && "ui-empty--done",
        compact && "ui-empty--compact",
      )}
      data-testid={testId}
    >
      <span className="ui-empty__icon" aria-hidden="true">
        <Icon name={icon ?? (tone === "done" ? "check" : "info")} size={compact ? 16 : 20} />
      </span>
      {title || text ? (
        <div className="ui-empty__text">
          {title ? <p className="ui-empty__title">{title}</p> : null}
          {text ? <div className="ui-empty__line">{text}</div> : null}
        </div>
      ) : null}
      {action ? (
        "to" in action ? (
          <Link
            to={action.to}
            className={buttonClass("secondary", undefined, "sm")}
            data-testid={action.testId}
          >
            {action.label}
          </Link>
        ) : (
          <Button size="sm" onClick={action.onClick} data-testid={action.testId}>
            {action.label}
          </Button>
        )
      ) : null}
    </div>
  );
}
