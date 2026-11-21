// To the point (owner, 2026-11-21): "remove some of the context... what is it, why. It is such an
// overwhelming process." The paragraph under an issue or a decision shows its first sentence; the
// rest opens with More. Nothing is cut from what is stored.

import { useState } from "react";
import { cx } from "../../ui/cx";

/** The most a row's text shows before More. */
export const SHORT_MAX = 140;

/**
 * The start of a text: its first sentence when that fits in `max`, else its words up to `max`.
 * Null when the whole text already fits (nothing to open).
 */
export function shortOf(text: string, max = SHORT_MAX): string | null {
  const whole = text.trim();
  const line = whole.split("\n")[0]?.trim() ?? "";
  const end = line.search(/[.?!](\s|$)/);
  const sentence = end >= 0 ? line.slice(0, end + 1) : line;
  if (sentence.length <= max) return sentence === whole ? null : sentence;
  const cut = sentence.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, "")}…`;
}

/** A row's paragraph, short first. */
export function ShortText({
  text,
  className,
  testId,
}: {
  text: string;
  className?: string;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const short = shortOf(text);
  return (
    <p className={cx("break-words", open && "whitespace-pre-line", className)} data-testid={testId}>
      {short && !open ? short : text.trim()}
      {short ? (
        <>
          {" "}
          <button
            type="button"
            className="ds-btn ds-btn--link text-xs"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            data-testid={testId ? `${testId}-more` : undefined}
          >
            {open ? "Less" : "More"}
          </button>
        </>
      ) : null}
    </p>
  );
}
