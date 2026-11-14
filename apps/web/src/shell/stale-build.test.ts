import { describe, expect, it, vi } from "vitest";
import { isStaleBuildError, reloadForNewBuild } from "./stale-build";

function memoryStore() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

describe("isStaleBuildError", () => {
  it("knows each browser's words for a module file that couldn't be fetched", () => {
    for (const message of [
      "Failed to fetch dynamically imported module: https://staging.mezonas.com/assets/WorkflowBuilder-CVK9MJzO.js",
      "error loading dynamically imported module: https://app.mezonas.com/assets/x.js",
      "Importing a module script failed.",
    ]) {
      expect(isStaleBuildError(new TypeError(message))).toBe(true);
    }
  });

  it("leaves every other error alone", () => {
    expect(isStaleBuildError(new TypeError("Failed to fetch"))).toBe(false);
    expect(isStaleBuildError(new Error("Cannot read properties of undefined"))).toBe(false);
    expect(isStaleBuildError(undefined)).toBe(false);
  });
});

describe("reloadForNewBuild", () => {
  it("reloads once, then not again within 30 seconds, then again after", () => {
    const store = memoryStore();
    const reload = vi.fn();
    expect(reloadForNewBuild(store, reload, 1_000_000)).toBe(true);
    expect(reloadForNewBuild(store, reload, 1_010_000)).toBe(false);
    expect(reloadForNewBuild(store, reload, 1_031_000)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("doesn't reload where the tab can't remember that it did", () => {
    const reload = vi.fn();
    expect(reloadForNewBuild(null, reload, 1)).toBe(false);
    const broken = {
      getItem: () => null,
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(reloadForNewBuild(broken, reload, 1)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
