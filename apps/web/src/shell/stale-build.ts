// A tab opened before a deploy still runs the old build. When it opens a screen it hasn't loaded
// yet, the browser asks for that screen's file under the old build's name, which the new deploy no
// longer serves, and the screen fails to load (Sentry MEZONAS-WEB-2: the workflow builder after a
// staging deploy). The page reloads once instead, which picks up the new build.
//
// DECISION: reload at most once in 30 seconds, remembered for the tab (sessionStorage), so a file
// that is really missing, or an API that is down, shows its error instead of reloading for ever.
// Where the tab can't remember (storage blocked), it doesn't reload: the error shows as before.

const KEY = "mezonas:reloaded-for-new-build";
const WINDOW_MS = 30_000;

// What each browser says when a module file can't be fetched: Chrome and Edge, Firefox, Safari.
const STALE_BUILD =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i;

/** Whether an error is a screen's file that couldn't be fetched (an old build after a deploy). */
export function isStaleBuildError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return STALE_BUILD.test(message);
}

type Store = Pick<Storage, "getItem" | "setItem">;

/**
 * Reload the page for the new build, unless it already did so in the last 30 seconds. True when it
 * reloads.
 */
export function reloadForNewBuild(
  store: Store | null = tabStore(),
  reload: () => void = () => location.reload(),
  now: number = Date.now(),
): boolean {
  if (!store) return false;
  try {
    const last = Number(store.getItem(KEY));
    if (Number.isFinite(last) && last > 0 && now - last < WINDOW_MS) return false;
    store.setItem(KEY, String(now));
  } catch {
    return false;
  }
  reload();
  return true;
}

function tabStore(): Store | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Vite's own signal that a screen's file failed to load (`vite:preloadError`): reload instead of
 * throwing. A failure it doesn't cover reaches React's root error handlers, which check
 * `isStaleBuildError` (main.tsx).
 */
export function watchForNewBuild(target: Pick<Window, "addEventListener"> = window): void {
  target.addEventListener("vite:preloadError", (event) => {
    if (reloadForNewBuild()) event.preventDefault();
  });
}
