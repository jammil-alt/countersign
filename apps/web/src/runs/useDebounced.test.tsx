// Search boxes wait for typing to stop (docs/audit-plan.md 2.4): one hook for the four of them,
// and the rows on screen marked as answering the last search while the next one loads.
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SEARCH_PAUSE_MS, useAnswered, useDebounced } from "./useDebounced";

describe("useDebounced", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("settles on the value once it stops changing, not once a letter", () => {
    const seen: string[] = [];
    const { rerender, result } = renderHook(
      ({ v }) => {
        const settled = useDebounced(v);
        seen.push(settled);
        return settled;
      },
      { initialProps: { v: "" } },
    );
    for (const v of ["b", "bi", "bir", "birc", "birch"]) {
      rerender({ v });
      act(() => vi.advanceTimersByTime(100));
    }
    expect(result.current).toBe("");
    act(() => vi.advanceTimersByTime(SEARCH_PAUSE_MS));
    expect(result.current).toBe("birch");
    // Nothing in between was ever the settled value.
    expect(new Set(seen)).toEqual(new Set(["", "birch"]));
  });

  it("goes back to an earlier value when the box returns to it", () => {
    const { rerender, result } = renderHook(({ v }) => useDebounced(v, 200), {
      initialProps: { v: "oak" },
    });
    rerender({ v: "oa" });
    rerender({ v: "oak" });
    act(() => vi.advanceTimersByTime(500));
    expect(result.current).toBe("oak");
  });
});

describe("useAnswered", () => {
  type Props = { data: { rows: number } | undefined; q: string };
  const first = { rows: 1 };
  const second = { rows: 2 };

  it("marks kept rows stale until the new query's answer replaces them", () => {
    const { rerender, result } = renderHook(({ data, q }: Props) => useAnswered(data, q), {
      initialProps: { data: first, q: "" } as Props,
    });
    expect(result.current).toEqual({ query: "", stale: false });
    // The query changed; the list keeps the last answer while the new one loads.
    rerender({ data: first, q: "birch" });
    expect(result.current).toEqual({ query: "", stale: true });
    rerender({ data: second, q: "birch" });
    expect(result.current).toEqual({ query: "birch", stale: false });
  });

  it("keeps them stale when the new query fails", () => {
    const { rerender, result } = renderHook(({ data, q }: Props) => useAnswered(data, q), {
      initialProps: { data: first, q: "" } as Props,
    });
    rerender({ data: first, q: "birch" });
    // The load failed: `useApi` still shows the kept answer, and nothing is refreshing.
    rerender({ data: first, q: "birch" });
    expect(result.current).toEqual({ query: "", stale: true });
  });

  it("is not stale for a stored answer refreshing behind, or before any data", () => {
    const { rerender, result } = renderHook(({ data, q }: Props) => useAnswered(data, q), {
      initialProps: { data: undefined, q: "oak" } as Props,
    });
    expect(result.current.stale).toBe(false);
    rerender({ data: first, q: "oak" });
    rerender({ data: second, q: "oak" });
    expect(result.current).toEqual({ query: "oak", stale: false });
  });
});
