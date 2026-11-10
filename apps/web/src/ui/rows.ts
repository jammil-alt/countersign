// A table row that opens one thing: a click anywhere on the row goes where its link goes. The
// row's own link stays the way in for keyboards and screen readers (one link, named by it); its
// check boxes, buttons and other links keep their own clicks. As the back office's runs list.
import type { MouseEvent } from "react";
import { useNavigate } from "react-router-dom";

/** The class that marks such a row: the pointer, and the subtle surface on hover. */
export const ROW_LINK_CLASS = "cursor-pointer hover:bg-surface-subtle";

/** `rowLink(to)` gives a row its class and its click. */
export function useRowLink(): (to: string) => {
  className: string;
  onClick: (e: MouseEvent<HTMLElement>) => void;
} {
  const navigate = useNavigate();
  return (to) => ({
    className: ROW_LINK_CLASS,
    onClick: (e) => {
      if ((e.target as HTMLElement).closest("a, button, input, label, select, textarea")) return;
      // Selecting text in a row is not a click on it.
      if (globalThis.getSelection?.()?.toString()) return;
      navigate(to);
    },
  });
}
