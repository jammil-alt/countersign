// Search boxes wait for typing to stop (docs/audit-plan.md 2.4): one hook for the four of them,
// and the rows on screen marked as answering the last search while the next one loads.
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SEARCH_PAUSE_MS, useDebounced, useStale } from "./useDebounced";

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

describe("useStale", () => {
  it("is true only while a kept answer for another query shows", () => {
    const first = { rows: 1 };
    const second = { rows: 2 };
    type Props = { state: { data: { rows: number }; refreshing: boolean }; q: string };
    const { rerender, result } = renderHook(({ state, q }: Props) => useStale(state, q), {
      initialProps: { state: { data: first, refreshing: false }, q: "" },
    });
    expect(result.current).toBe(false);
    // The query changed; the list keeps the last answer while the new one loads.
    rerender({ state: { data: first, refreshing: true }, q: "birch" });
    expect(result.current).toBe(true);
    rerender({ state: { data: second, refreshing: false }, q: "birch" });
    expect(result.current).toBe(false);
  });

  it("is false for a stored answer refreshing behind", () => {
    const { result } = renderHook(() => useStale({ data: { rows: 1 }, refreshing: true }, "oak"));
    expect(result.current).toBe(false);
  });
});
