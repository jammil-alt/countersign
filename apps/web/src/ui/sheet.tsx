// A side sheet (the design system's Sheet, ds-sheet): details that open beside the page from a
// card or a row, over a scrim that closes it. A modal dialog: its heading takes focus when it opens,
// Escape or the scrim or Close shuts it, and focus goes back to what opened it. Tab keeps focus
// inside it. Full width at phone width.
import { type ReactNode, useEffect, useId, useRef } from "react";
import { useI18n } from "../i18n/i18n";
import { Icon } from "./icons";
import { Button, cx } from "./primitives";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/** Tab and Shift+Tab go round the sheet's own controls, never behind it (a modal keeps focus). */
export function trapTab(e: KeyboardEvent, root: HTMLElement | null) {
  if (e.key !== "Tab" || !root) return;
  const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.closest("[inert]"),
  );
  const first = items[0];
  const last = items.at(-1);
  if (!first || !last) return;
  const active = document.activeElement;
  const inside = active instanceof Node && root.contains(active);
  if (e.shiftKey && (active === first || !inside)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || !inside)) {
    e.preventDefault();
    first.focus();
  }
}

export function SideSheet({
  title,
  eyebrow,
  onClose,
  footer,
  children,
  testId,
  wide,
  tabs,
}: {
  title: ReactNode;
  /** Above the title: what kind of thing this is (a category tag, a status). */
  eyebrow?: ReactNode;
  onClose: () => void;
  /** Pinned to the sheet's foot: its actions. */
  footer?: ReactNode;
  children: ReactNode;
  testId?: string;
  /** Room for tables (a run step's data). */
  wide?: boolean;
  /** Under the head, above the body: the sheet's own tabs. */
  tabs?: ReactNode;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    heading.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close.current();
      else trapTab(e, dialog.current);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      opener?.focus();
    };
  }, []);

  return (
    <div className="ui-sheetlayer">
      <button
        type="button"
        aria-label={t("common.close")}
        tabIndex={-1}
        className="ds-scrim ui-scrim-button"
        onClick={() => close.current()}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={testId}
        ref={dialog}
        className={cx("ds-sheet ui-sheet", wide && "ui-sheet--wide")}
      >
        <div className="ui-sheet__head">
          <div className="flex min-w-0 flex-col gap-2">
            {eyebrow}
            <h2
              id={titleId}
              ref={heading}
              tabIndex={-1}
              className="type-subheading text-ink outline-none"
            >
              {title}
            </h2>
          </div>
          <Button
            variant="ghost"
            className="ds-btn--icon shrink-0"
            aria-label={t("common.close")}
            data-testid={testId ? `${testId}-close` : undefined}
            onClick={() => close.current()}
          >
            <Icon name="close" size={20} />
          </Button>
        </div>
        {tabs ? <div className="ui-sheet__tabs">{tabs}</div> : null}
        <div className="ui-sheet__body">{children}</div>
        {footer ? <div className="ui-sheet__foot">{footer}</div> : null}
      </div>
    </div>
  );
}

/** A labelled part of a sheet: a small label, then its content. */
export function SheetSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="eyebrow text-ink-muted">{label}</h3>
      {children}
    </section>
  );
}
