// Light, dark or the system's setting. The design system's tokens follow the OS
// (`prefers-color-scheme`) unless `<html data-theme>` says otherwise (tokens.css and styles.css), so
// a choice here only sets or clears that attribute. The choice is this browser's, kept in
// localStorage; it may be unavailable (private windows), so every read and write is guarded.
import { useCallback, useState } from "react";

export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

const KEY = "mezonas.theme";

export function storedTheme(): Theme {
  try {
    const v = globalThis.localStorage?.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

/** Sets `<html data-theme>` (light or dark), or clears it so the OS decides. */
export function applyTheme(theme: Theme): void {
  const root = globalThis.document?.documentElement;
  if (!root) return;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

/** Before the first render, so the page doesn't flash the other theme. */
export function applyStoredTheme(): void {
  applyTheme(storedTheme());
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, set] = useState<Theme>(storedTheme);
  const choose = useCallback((t: Theme) => {
    try {
      if (t === "system") globalThis.localStorage?.removeItem(KEY);
      else globalThis.localStorage?.setItem(KEY, t);
    } catch {
      // Not kept past this page; still applied now.
    }
    applyTheme(t);
    set(t);
  }, []);
  return [theme, choose];
}
