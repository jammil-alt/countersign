// Polling waits for each answer: a reload aborts the request before it, so a poll that fired every
// 2 s while the server took longer cancelled every answer, and the run page kept saying "Running"
// after the run was done.
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePoll } from "./usePoll";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("usePoll", () => {
  it("reloads every `ms`, but never on top of a load still in flight", () => {
    const reload = vi.fn();
    const { rerender } = renderHook(({ busy }) => usePoll(reload, true, 2_000, busy), {
      initialProps: { busy: false },
    });
    act(() => vi.advanceTimersByTime(2_000));
    expect(reload).toHaveBeenCalledTimes(1);

    // The answer takes 5 s: no reload cancels it.
    rerender({ busy: true });
    act(() => vi.advanceTimersByTime(5_000));
    expect(reload).toHaveBeenCalledTimes(1);

    // Answered: the next tick reloads again.
    rerender({ busy: false });
    act(() => vi.advanceTimersByTime(1_000));
    expect(reload).toHaveBeenCalledTimes(2);
    act(() => vi.advanceTimersByTime(2_000));
    expect(reload).toHaveBeenCalledTimes(3);
  });

  it("skips ticks while the tab is hidden, and reloads once when it is back", () => {
    let state: DocumentVisibilityState = "visible";
    const spy = vi.spyOn(document, "visibilityState", "get").mockImplementation(() => state);
    try {
      const reload = vi.fn();
      renderHook(() => usePoll(reload, true, 2_000, false));
      state = "hidden";
      act(() => vi.advanceTimersByTime(60_000));
      expect(reload).not.toHaveBeenCalled();

      state = "visible";
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(reload).toHaveBeenCalledTimes(1);
      act(() => vi.advanceTimersByTime(2_000));
      expect(reload).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("does not reload on coming back when no tick was missed", () => {
    const reload = vi.fn();
    renderHook(() => usePoll(reload, true, 2_000, false));
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(reload).not.toHaveBeenCalled();
  });

  it("stops when it is no longer active", () => {
    const reload = vi.fn();
    const { rerender } = renderHook(({ active }) => usePoll(reload, active, 2_000, false), {
      initialProps: { active: true },
    });
    rerender({ active: false });
    act(() => vi.advanceTimersByTime(10_000));
    expect(reload).not.toHaveBeenCalled();
  });
});
