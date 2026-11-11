// A kept list (the last query's answer while a new filter loads) told apart from a query's own.
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useKept } from "./kept";

describe("useKept", () => {
  it("is true only while the last query's answer shows under a new query", () => {
    const a = { rows: ["a"] };
    const b = { rows: ["b"] };
    const a2 = { rows: ["a", "new"] };
    const hook = renderHook(({ q, data }: { q: string; data: unknown }) => useKept(q, data), {
      initialProps: { q: "all", data: a as unknown },
    });
    expect(hook.result.current).toBe(false);
    hook.rerender({ q: "failed", data: a }); // kept: A's answer under "failed"
    expect(hook.result.current).toBe(true);
    hook.rerender({ q: "failed", data: b }); // its own answer
    expect(hook.result.current).toBe(false);
    hook.rerender({ q: "all", data: a }); // "all"'s own stored answer, not B's
    expect(hook.result.current).toBe(false);
    hook.rerender({ q: "all", data: a2 }); // a poll's new answer
    expect(hook.result.current).toBe(false);
    hook.rerender({ q: "x", data: undefined }); // nothing yet
    expect(hook.result.current).toBe(false);
  });
});
