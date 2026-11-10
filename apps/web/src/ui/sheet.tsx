// A side sheet (the design system's Sheet, ds-sheet): details that open beside the page from a
// card or a row, over a scrim that closes it. A modal dialog: its heading takes focus when it opens,
// Escape or the scrim or Close shuts it, and focus goes back to what opened it. Full width at
// phone width.
import { type ReactNode, useEffect, useId, useRef } from "react";
import { Icon } from "./icons";
import { Button } from "./primitives";

export function SideSheet({
  title,
  eyebrow,
  onClose,
  footer,
  children,
  testId,
}: {
  title: ReactNode;
  /** Above the title: what kind of thing this is (a category tag, a status). */
  eyebrow?: ReactNode;
  onClose: () => void;
  /** Pinned to the sheet's foot: its actions. */
  footer?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    heading.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close.current();
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
        aria-label="Close"
        tabIndex={-1}
        className="ds-scrim ui-scrim-button"
        onClick={() => close.current()}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={testId}
        className="ds-sheet ui-sheet"
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
            aria-label="Close"
            data-testid={testId ? `${testId}-close` : undefined}
            onClick={() => close.current()}
          >
            <Icon name="close" size={20} />
          </Button>
        </div>
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
