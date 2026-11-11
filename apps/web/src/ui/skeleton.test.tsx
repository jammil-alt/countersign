import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Loaded } from "./page";
import { Loading } from "./primitives";
import {
  Skeleton,
  SkeletonCard,
  SkeletonLine,
  SkeletonPage,
  SkeletonRows,
  SkeletonStats,
} from "./skeleton";

const waiting = { data: undefined, error: null, loading: true, reload: () => {} };

/** The words a sighted person sees: the text outside `sr-only`. */
function visibleText(el: HTMLElement): string {
  const copy = el.cloneNode(true) as HTMLElement;
  for (const hidden of copy.querySelectorAll(".sr-only")) hidden.remove();
  return copy.textContent ?? "";
}

describe("Skeleton", () => {
  it("is one status for screen readers, its shapes hidden from them", () => {
    const { container } = render(
      <Skeleton>
        <SkeletonLine />
        <SkeletonCard />
        <SkeletonRows rows={2} columns={3} />
        <SkeletonStats count={2} />
      </Skeleton>,
    );
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Loading…");
    expect(visibleText(status)).toBe("");
    for (const shape of Array.from(status.children).slice(1)) {
      expect(shape).toHaveAttribute("aria-hidden", "true");
    }
    expect(container.querySelectorAll(".ui-skel-row")).toHaveLength(2);
    expect(container.querySelectorAll(".ui-skel-row:first-child .ui-skel-line")).toHaveLength(3);
    expect(container.querySelectorAll(".ui-stat")).toHaveLength(2);
  });

  it("says the caller's words when given", () => {
    render(
      <Skeleton label="Loading the price…">
        <SkeletonLine />
      </Skeleton>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Loading the price…");
  });
});

describe("Loaded", () => {
  it("shows the page body's skeleton by default, with no loading text on screen", () => {
    const { container } = render(<Loaded state={waiting}>{(d: string) => <p>{d}</p>}</Loaded>);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Loading");
    expect(visibleText(status)).toBe("");
    expect(container.querySelector(".ui-skel-page")).not.toBeNull();
  });

  it("shows the screen's own skeleton when it gives one", () => {
    const { container } = render(
      <Loaded state={waiting} skeleton={<SkeletonRows rows={4} />}>
        {(d: string) => <p>{d}</p>}
      </Loaded>,
    );
    expect(container.querySelectorAll(".ui-skel-row")).toHaveLength(4);
    expect(container.querySelector(".ui-skel-page")).toBeNull();
  });

  it("shows the data, not the skeleton, once there is data", () => {
    render(
      <Loaded state={{ ...waiting, data: "ready", loading: false }} skeleton={<SkeletonPage />}>
        {(d: string) => <p>{d}</p>}
      </Loaded>,
    );
    expect(screen.getByText("ready")).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("Loading", () => {
  it("is a skeleton, its label read and not shown", () => {
    render(<Loading label="Connecting…" />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Connecting…");
    expect(visibleText(status)).toBe("");
    expect(status).toHaveClass("ui-skel-wrap--block");
  });

  it("keeps to one short line in a small slot", () => {
    const { container } = render(<Loading size="line" />);
    expect(screen.getByRole("status")).toHaveClass("ui-skel-wrap--line");
    expect(container.querySelectorAll(".ui-skel-line")).toHaveLength(1);
  });

  it("shows its words for work the person started", () => {
    const { container } = render(<Loading progress label="Saving your choice…" />);
    const status = screen.getByRole("status");
    expect(visibleText(status)).toBe("Saving your choice…");
    expect(container.querySelector(".ui-skel")).toBeNull();
  });
});

describe("skeleton styles", () => {
  const css = readFileSync(join(import.meta.dirname, "page.css"), "utf8");
  const rules = css.slice(css.indexOf("── Skeletons"));

  it("stands still when reduced motion is asked for", () => {
    expect(rules).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.ui-skel\s*\{\s*animation: none;/,
    );
  });

  it("takes its parent's width, so a centred parent cannot shrink it to nothing", () => {
    expect(rules).toMatch(/\.ui-skel-wrap \{[^}]*\bwidth: 100%;/);
  });

  it("uses the design system's tokens only: no raw colours or shadows", () => {
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|box-shadow/i);
    expect(rules).toContain("var(--line)");
    expect(rules).toContain("var(--radius-sm)");
  });
});
