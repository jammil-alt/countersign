// Polls that back off (docs/audit-plan.md 2.7): 3 s at first, growing to 30 s, starting again on
// a restart, stopping after their tries, and silent in a hidden tab.
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { backoffMs, useBackoffPoll } from "./poll";

const BACKOFF = { firstMs: 3_000, maxMs: 30_000 };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("backoffMs", () => {
  it("grows by half each tick up to its longest", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((n) => backoffMs(n, BACKOFF))).toEqual([
      3_000, 4_500, 6_750, 10_125, 15_188, 22_781, 30_000, 30_000,
    ]);
  });
});

describe("useBackoffPoll", () => {
  it("asks less and less often, and starts again from the first interval on a restart", () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    const { rerender } = renderHook(
      ({ restart }: { restart: string }) => useBackoffPoll(reload, true, BACKOFF, false, restart),
      { initialProps: { restart: "a" } },
    );
    act(() => vi.advanceTimersByTime(3_000));
    expect(reload).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(4_499));
    expect(reload).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(1));
    expect(reload).toHaveBeenCalledTimes(2);
    // A minute later it asks at most every 30 s.
    act(() => vi.advanceTimersByTime(120_000));
    const after = reload.mock.calls.length;
    act(() => vi.advanceTimersByTime(30_000));
    expect(reload).toHaveBeenCalledTimes(after + 1);
    rerender({ restart: "b" });
    act(() => vi.advanceTimersByTime(3_000));
    expect(reload).toHaveBeenCalledTimes(after + 2);
  });

  it("stops after its tries, and never ticks when inactive", () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    renderHook(() => useBackoffPoll(reload, true, { ...BACKOFF, maxTries: 2 }, false));
    act(() => vi.advanceTimersByTime(600_000));
    expect(reload).toHaveBeenCalledTimes(2);
    const idle = vi.fn();
    renderHook(() => useBackoffPoll(idle, false, BACKOFF, false));
    act(() => vi.advanceTimersByTime(600_000));
    expect(idle).not.toHaveBeenCalled();
  });

  it("asks nothing in a hidden tab", () => {
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const reload = vi.fn();
    renderHook(() => useBackoffPoll(reload, true, BACKOFF, false));
    act(() => vi.advanceTimersByTime(600_000));
    expect(reload).not.toHaveBeenCalled();
  });
});
