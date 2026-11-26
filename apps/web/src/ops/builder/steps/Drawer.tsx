// The step builder's side drawer (feedback, 2026-11-26: "make the step settings a full size side
// modal that comes out when you click it"): the window's full height under the header, sliding out
// from the right. A step's settings open in it over a scrim, as a modal: Escape, the scrim or the
// panel's own Close shuts it, and Tab stays inside. Try it and the Builder open in it without the
// scrim, so the chart beside it stays in reach while they work on it; a click outside folds them to
// a tab at the window's edge that opens them again (owner, 2026-11-26: "for the builder it should
// collapse and be callable again; for the steps it should close").
// Drawn at the end of the page (a portal): inside the page, a parent that makes its own frame
// (a transform, a contained box) cut the scrim down to that frame, and a click outside it did
// nothing.
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cx } from "../../../ui/primitives";
import { trapTab } from "../../../ui/sheet";

export function Drawer({
  label,
  testId,
  onClose,
  modal = true,
  onCollapse,
  narrow = false,
  hidden = false,
  companion,
  companionLabel = "Builder",
  keepOn,
  children,
}: {
  label: string;
  testId?: string;
  onClose(): void;
  /** Over a scrim, keeping focus inside (a step's settings); otherwise beside the page. */
  modal?: boolean;
  /** Beside the page only: a click outside it (not on `keep`) folds it rather than closing it. */
  onCollapse?: () => void;
  /** The palette's width, not a step's. */
  narrow?: boolean;
  /** Folded: kept, with what it holds (a message being typed, a try under way), but not shown. */
  hidden?: boolean;
  /**
   * A second panel to the right of the first, in the same drawer (owner, 2026-11-26: the Builder
   * beside an open step, both full height). Under 1200 px wide they share the drawer, with a
   * switch between the two.
   */
  companion?: ReactNode;
  companionLabel?: string;
  /** Beside the page: what a press on doesn't fold it (a step on the chart, which opens beside it). */
  keepOn?: string;
  children: ReactNode;
}) {
  const [pane, setPane] = useState<"main" | "companion">("main");
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const collapse = useRef(onCollapse);
  collapse.current = onCollapse;
  const keepRef = useRef(keepOn);
  keepRef.current = keepOn;
  useEffect(() => {
    if (hidden) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Escape in a field (a select, a picker) is that field's own first.
        if (e.defaultPrevented) return;
        // Beside the page, Escape folds it as a click outside does.
        if (!modal && collapse.current) collapse.current();
        else close.current();
      } else if (modal) trapTab(e, box.current);
    };
    // Beside the page: a press anywhere outside it folds it (the button that opens it again, and
    // anything marked `data-drawer-keep`, excepted).
    const onDown = (e: PointerEvent) => {
      if (modal || !collapse.current) return;
      const t = e.target;
      if (!(t instanceof Element) || box.current?.contains(t)) return;
      if (t.closest("[data-drawer-keep]")) return;
      if (keepRef.current && t.closest(keepRef.current)) return;
      collapse.current();
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [modal, hidden]);

  return createPortal(
    <div className={cx("flow-drawer-layer", modal && "is-modal")} hidden={hidden}>
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
        className={cx(
          "flow-drawer",
          narrow && "flow-drawer--narrow",
          companion !== undefined && "flow-drawer--pair",
        )}
        data-pane={companion !== undefined ? pane : undefined}
      >
        {companion !== undefined ? (
          <>
            <fieldset className="ds-seg flow-drawer__switch" aria-label="Show">
              <button
                type="button"
                aria-pressed={pane === "main"}
                data-testid={testId ? `${testId}-show-main` : undefined}
                onClick={() => setPane("main")}
              >
                {label}
              </button>
              <button
                type="button"
                aria-pressed={pane === "companion"}
                data-testid={testId ? `${testId}-show-companion` : undefined}
                onClick={() => setPane("companion")}
              >
                {companionLabel}
              </button>
            </fieldset>
            <div className="flow-drawer__main">{children}</div>
            <div className="flow-drawer__companion">{companion}</div>
          </>
        ) : (
          children
        )}
      </div>
    </div>,
    document.body,
  );
}

/** A folded drawer: a tab at the window's right edge that opens it again. */
export function DrawerTab({
  label,
  testId,
  onOpen,
}: {
  label: string;
  testId?: string;
  onOpen(): void;
}) {
  return createPortal(
    <button
      type="button"
      className="flow-drawer-tab"
      data-testid={testId}
      data-drawer-keep
      onClick={onOpen}
    >
      {label}
    </button>,
    document.body,
  );
}
