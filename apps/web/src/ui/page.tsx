// Page layout (docs/design/prototype.html `.wrap`, `.split`, `.cols`): a page's column, its
// sections with a heading and a right-side meta, a main column with a right rail, an even grid,
// and one way to show a load's loading, error and data states. Styles in ./page.css.
import type { ReactNode } from "react";
import type { ApiState } from "../api/useApi";
import { cx } from "./cx";
import { ErrorNotice, Loading } from "./primitives";

/** A page's column: 1200px at most, sections 32px apart. `narrow` reads better for forms. */
export function Page({
  children,
  width = "wide",
  testId,
}: {
  children: ReactNode;
  width?: "wide" | "narrow";
  testId?: string;
}) {
  return (
    <div data-testid={testId} className={cx("ui-page", width === "narrow" && "ui-page--narrow")}>
      {children}
    </div>
  );
}

/** "Working now · 3 running · 1 waiting on you": a heading, a muted meta or an action on the right. */
export function Section({
  title,
  meta,
  action,
  children,
  testId,
}: {
  title?: ReactNode;
  meta?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section data-testid={testId} className="ui-section">
      {title || meta || action ? (
        <div className="ui-section__head">
          {title ? <h2 className="type-heading text-ink">{title}</h2> : <span />}
          {meta || action ? (
            <div className="ui-section__meta">
              {meta ? <span className="text-sm text-ink-muted">{meta}</span> : null}
              {action}
            </div>
          ) : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/** The main column and a 340px rail on the right; the rail drops below it when there's no room. */
export function PageGrid({ children, rail }: { children: ReactNode; rail: ReactNode }) {
  return (
    <div className="ui-split">
      <div className="ui-split__main">{children}</div>
      <aside className="ui-split__rail">{rail}</aside>
    </div>
  );
}

/** Even columns (2, 3 or 4) that fold to one at phone width. */
export function Columns({ count, children }: { count: 2 | 3 | 4; children: ReactNode }) {
  return <div className={cx("ui-cols", `ui-cols--${count}`)}>{children}</div>;
}

/**
 * A load's three states, the same everywhere: Loading on the first load, the error with Try
 * again, else the data (kept on screen while it reloads).
 */
export function Loaded<T>({
  state,
  children,
}: {
  state: ApiState<T>;
  children: (data: T) => ReactNode;
}) {
  if (state.data !== undefined) return <>{children(state.data)}</>;
  if (state.error) return <ErrorNotice error={state.error} onRetry={state.reload} />;
  return <Loading />;
}
