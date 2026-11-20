// The Builds page's long sections (owner, 2026-11-19): a section's title folds it and the choice
// is kept for this browser; a long list shows its first rows with "Show all"; a busy button moves.
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { Button, Card } from "../../ui/primitives";
import { useFirstRows, useFold } from "./fold";

function Folded({ fallback }: { fallback?: boolean }) {
  const fold = useFold("issues", fallback);
  return (
    <Card testId="card" title="Issues" meta={<span>3 open</span>} fold={fold} footer="Foot">
      <p>Body</p>
    </Card>
  );
}

function List({ n, keep }: { n: number; keep?: number }) {
  const rows = Array.from({ length: n }, (_, i) => i);
  const { shown, more } = useFirstRows(rows, {
    keep: (r) => r === keep,
    noun: "issues",
    testId: "more",
  });
  return (
    <div>
      <ul>
        {shown.map((r) => (
          <li key={r}>row {r}</li>
        ))}
      </ul>
      {more}
    </div>
  );
}

describe("folding a section", () => {
  beforeEach(() => localStorage.clear());

  it("shuts to its head, keeping the counts in sight, and opens again", () => {
    render(<Folded />);
    expect(screen.getByText("Body")).toBeTruthy();
    fireEvent.click(screen.getByTestId("build-fold-issues"));
    expect(screen.queryByText("Body")).toBeNull();
    expect(screen.queryByText("Foot")).toBeNull();
    expect(screen.getByText("3 open")).toBeTruthy();
    expect(screen.getByTestId("build-fold-issues").getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(screen.getByTestId("build-fold-issues"));
    expect(screen.getByText("Body")).toBeTruthy();
  });

  it("keeps the choice for this browser, over the section's default", () => {
    const { unmount } = render(<Folded />);
    fireEvent.click(screen.getByTestId("build-fold-issues"));
    unmount();
    render(<Folded fallback />);
    expect(screen.queryByText("Body")).toBeNull();
  });
});

describe("a long list", () => {
  it("shows every row when there are only a couple past the cut", () => {
    render(<List n={7} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(7);
    expect(screen.queryByTestId("more")).toBeNull();
  });

  it("shows the first five, the one in focus, and all of them on a click", () => {
    render(<List n={20} keep={12} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(6);
    expect(screen.getByText("row 12")).toBeTruthy();
    expect(screen.getByTestId("more").textContent).toBe("Show all 20 issues (14 more)");
    fireEvent.click(screen.getByTestId("more"));
    expect(screen.getAllByRole("listitem")).toHaveLength(20);
    expect(screen.getByTestId("more").textContent).toBe("Show fewer");
  });
});

describe("a working button", () => {
  it("is off, busy and marked to move while its action runs", () => {
    render(<Button working>Move to the POC test</Button>);
    const b = screen.getByRole("button");
    expect((b as HTMLButtonElement).disabled).toBe(true);
    expect(b.getAttribute("aria-busy")).toBe("true");
    expect(b.className).toContain("ui-btn--working");
  });

  it("is a plain button otherwise", () => {
    render(<Button>Move to the POC test</Button>);
    const b = screen.getByRole("button");
    expect(b.getAttribute("aria-busy")).toBeNull();
    expect(b.className).not.toContain("ui-btn--working");
  });
});
