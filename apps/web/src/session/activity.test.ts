import { SESSION_IDLE_SEC } from "@countersign/core";
import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "../api/client";
import { apiRoutes } from "../api/routes";
import { idleTooLong, noteInput, recentlyActive, watchInput } from "./activity";

describe("activity", () => {
  it("counts input for a minute, and idles out after 30 minutes", () => {
    const t = Date.now() + 10 * 60_000;
    noteInput(t);
    expect(recentlyActive(t + 59_000)).toBe(true);
    expect(recentlyActive(t + 60_000)).toBe(false);
    expect(idleTooLong(t + SESSION_IDLE_SEC * 1000 - 1)).toBe(false);
    expect(idleTooLong(t + SESSION_IDLE_SEC * 1000)).toBe(true);
  });

  it("marks a request made right after input, and not one made later by a poll", async () => {
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        }),
    );
    const api = createApiClient({ fetch });
    noteInput(Date.now());
    await api.call(apiRoutes.health);
    const marked = fetch.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(marked["x-countersign-activity"]).toBe("1");

    noteInput(Date.now() - 5 * 60_000);
    await api.call(apiRoutes.health);
    const polled = fetch.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(polled["x-countersign-activity"]).toBeUndefined();
  });

  it("listens for keys, clicks, wheels and touches, and stops", () => {
    const target = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const stop = watchInput(target);
    expect(target.addEventListener.mock.calls.map((c) => c[0])).toEqual([
      "keydown",
      "pointerdown",
      "wheel",
      "touchstart",
    ]);
    stop();
    expect(target.removeEventListener).toHaveBeenCalledTimes(4);
  });
});
