// The step builder's side drawer (feedback, 2026-11-26: "make the step settings a full size side
// modal that comes out when you click it"): the window's full height under the header, sliding out
// from the right. A step's settings open in it over a scrim, as a modal: Escape, the scrim or the
// panel's own Close shuts it, and Tab stays inside. Try it and the Builder open in it without the
// scrim, so the chart beside it stays in reach while they work on it.
import { type ReactNode, useEffect, useRef } from "react";
import { cx } from "../../../ui/primitives";
import { trapTab } from "../../../ui/sheet";

export function Drawer({
  label,
  testId,
  onClose,
  modal = true,
  narrow = false,
  children,
}: {
  label: string;
  testId?: string;
  onClose(): void;
  /** Over a scrim, keeping focus inside (a step's settings); otherwise beside the page. */
  modal?: boolean;
  /** The palette's width, not a step's. */
  narrow?: boolean;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Escape in a field (a select, a picker) is that field's own first.
        if (e.defaultPrevented) return;
        close.current();
      } else if (modal) trapTab(e, box.current);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modal]);

  return (
    <div className={cx("flow-drawer-layer", modal && "is-modal")}>
      {modal ? (
        <button
          type="button"
          aria-label="Close"
          tabIndex={-1}
          className="ds-scrim ui-scrim-button"
          data-testid={testId ? `${testId}-scrim` : undefined}
          onClick={() => close.current()}
        />
      ) : null}
      <div
        ref={box}
        role="dialog"
        aria-modal={modal}
        aria-label={label}
        data-testid={testId}
        className={cx("flow-drawer", narrow && "flow-drawer--narrow")}
      >
        {children}
      </div>
    </div>
  );
}
