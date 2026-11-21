// Form controls on the Mezonas TextField and Select (ds-field, ds-input, ds-textarea, ds-select with
// the mz-chevron-down icon), shared by the back office and the portal; no raw colours.
import {
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";
import { cx } from "./cx";
import { Icon } from "./icons";

/**
 * Controls fill their container unless the caller gives a width (`w-28`): `cx` doesn't merge
 * classes, and with both `w-full` and `w-28` present the stylesheet's order, not the caller, decides.
 */
function width(className: string | undefined): string | false {
  return !/(^|\s)w-/.test(className ?? "") && "w-full";
}

export function Field({
  label,
  hint,
  error,
  children,
  testId,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | undefined;
  children: ReactNode;
  testId?: string;
  className?: string;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is the label's child.
    <label className={cx("ds-field", className)}>
      <span className="text-sm leading-tight font-medium text-ink">{label}</span>
      {children}
      {error ? (
        <span className="ds-error text-sm" data-testid={testId ? `${testId}-error` : undefined}>
          {error}
        </span>
      ) : hint ? (
        <span className="ds-help text-sm">{hint}</span>
      ) : null}
    </label>
  );
}

export function TextInput({
  invalid,
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return (
    <input
      {...rest}
      aria-invalid={invalid || undefined}
      className={cx(
        "ds-input disabled:opacity-60",
        width(className),
        invalid && "ds-input--error",
        className,
      )}
    />
  );
}

/** A textarea as tall as what's in it: no inner scroll, no clipped lines. */
export function fitHeight(el: HTMLTextAreaElement): void {
  const style = getComputedStyle(el);
  const border =
    (Number.parseFloat(style.borderTopWidth) || 0) +
    (Number.parseFloat(style.borderBottomWidth) || 0);
  // With the height let go, scrollHeight is the words' height or `rows` lines, whichever is more.
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight + border}px`;
}

/**
 * DECISION (plan §1.167): `autoSize`: the box grows and shrinks with its words, `rows` lines at
 * least (owner, 2026-11-21: a brief capped at five lines cut long text off mid-line). It fits
 * again when its width changes, since the words wrap differently.
 */
export function TextArea({
  invalid,
  className,
  autoSize = false,
  ref: outer,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  invalid?: boolean;
  autoSize?: boolean;
  ref?: Ref<HTMLTextAreaElement> | undefined;
}) {
  const own = useRef<HTMLTextAreaElement | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: fit again when the words change.
  useLayoutEffect(() => {
    if (autoSize && own.current) fitHeight(own.current);
  }, [autoSize, rest.value, rest.rows]);
  useEffect(() => {
    const el = own.current;
    if (!autoSize || !el || typeof ResizeObserver === "undefined") return;
    let wide = el.offsetWidth;
    const watch = new ResizeObserver(() => {
      if (el.offsetWidth === wide) return;
      wide = el.offsetWidth;
      fitHeight(el);
    });
    watch.observe(el);
    return () => watch.disconnect();
  }, [autoSize]);
  return (
    <textarea
      {...rest}
      ref={(el) => {
        own.current = el;
        if (typeof outer === "function") outer(el);
        else if (outer) outer.current = el;
      }}
      aria-invalid={invalid || undefined}
      className={cx(
        "ds-textarea leading-relaxed disabled:opacity-60",
        autoSize && "resize-none overflow-hidden",
        width(className),
        invalid && "ds-input--error",
        className,
      )}
    />
  );
}

/** Classes that place the control (its width and its place in a row) go on Select's wrapper. */
const LAYOUT = /^(w-|min-w-|max-w-|flex-|grow|shrink|basis-|self-|col-|row-|order-|m[trblxy]?-)/;

/** A native select in the Mezonas Select (ds-selectwrap) with the mz-chevron-down icon. */
export function Select({
  invalid,
  className,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }) {
  const classes = (className ?? "").split(/\s+/).filter(Boolean);
  const layout = classes.filter((c) => LAYOUT.test(c.replace(/^[a-z]+:/, "")));
  const own = classes.filter((c) => !layout.includes(c));
  return (
    <span
      className={cx(
        "ds-selectwrap",
        layout.some((c) => c.startsWith("w-")) ? "inline-block" : "block w-full",
        ...layout,
      )}
    >
      <select
        {...rest}
        aria-invalid={invalid || undefined}
        className={cx("ds-select pr-8 disabled:opacity-60", invalid && "ds-input--error", ...own)}
      />
      <Icon
        name="chevron-down"
        className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-ink-muted"
      />
    </span>
  );
}
