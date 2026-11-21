// For screen tests of the builder on its chart (docs/builder-plan.md §12): the order the chart
// shows a list's steps in, and dragging with the keyboard where nothing is laid out.
import { act, screen } from "@testing-library/react";
import type userEvent from "@testing-library/user-event";

type User = ReturnType<typeof userEvent.setup>;

/** The step ids of one list as the chart shows them, in order (`root`, `path:<id>`, `loop:<id>`). */
export function listOrder(container: string): string[] {
  const n = (el: Element) => Number(/(\d+)$/.exec(el.getAttribute("data-number") ?? "")?.[1] ?? 0);
  return [...document.querySelectorAll(`[data-testid^="flow-box-"][data-container="${container}"]`)]
    .sort((a, b) => n(a) - n(b))
    .map((el) => (el.getAttribute("data-testid") ?? "").replace("flow-box-", ""));
}

/** Top-level step ids as the chart shows them, top to bottom. */
export function rootOrder(): string[] {
  return listOrder("root");
}

// jsdom lays nothing out, so dnd-kit's keyboard sensor would see every droppable at 0,0. The chart
// places its boxes and + points itself (inline left, top, width, height from its layout), so each
// one's rect is read from there: where a browser would draw it.
function chartRect(el: HTMLElement): DOMRect | null {
  const id = el.getAttribute("data-testid") ?? "";
  if (!/^flow-(box-|insert-|start$|tail$)/.test(id)) return null;
  const px = (v: string) => Number.parseFloat(v) || 0;
  // A + is placed by its centre.
  const plus = id.startsWith("flow-insert-");
  const width = plus ? 18 : px(el.style.width);
  const height = plus ? 18 : px(el.style.height);
  const left = px(el.style.left) - (plus ? 9 : 0);
  const top = px(el.style.top) - (plus ? 9 : 0);
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect;
}

/** Gives the chart's boxes and + points their rects; returns what puts the real ones back. */
export function fakeChartRects(): () => void {
  const real = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    // The dot under a box sits at the middle of its bottom edge.
    if ((this.getAttribute("data-testid") ?? "").startsWith("flow-dot-")) {
      const box = this.parentElement ? chartRect(this.parentElement) : null;
      if (box) {
        const left = box.left + box.width / 2 - 5;
        const top = box.bottom - 5;
        return {
          x: left,
          y: top,
          left,
          top,
          width: 10,
          height: 10,
          right: left + 10,
          bottom: top + 10,
          toJSON: () => ({}),
        } as DOMRect;
      }
    }
    return chartRect(this) ?? real.call(this);
  };
  return () => {
    HTMLElement.prototype.getBoundingClientRect = real;
  };
}

/**
 * Picks `from` up with the keyboard (a step's box, or the dot under it), moves it onto `onto` with
 * the arrows (25px a press, as dnd-kit's keyboard sensor moves), and drops it.
 */
export async function keyboardDrag(user: User, from: string, onto: string) {
  // After a drop dnd-kit gives focus back to what was dropped on the next frame; let it.
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
  const source = screen.getByTestId(from);
  const target = screen.getByTestId(onto);
  const centre = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
  const a = centre(source);
  const b = centre(target);
  act(() => source.focus());
  await user.keyboard("[Space]");
  const dx = Math.round((b.x - a.x) / 25);
  const dy = Math.round((b.y - a.y) / 25);
  for (let i = 0; i < Math.abs(dx); i++) {
    await user.keyboard(dx > 0 ? "[ArrowRight]" : "[ArrowLeft]");
  }
  for (let i = 0; i < Math.abs(dy); i++) {
    await user.keyboard(dy > 0 ? "[ArrowDown]" : "[ArrowUp]");
  }
  await user.keyboard("[Space]");
}
