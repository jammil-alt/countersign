// Back to the lab as you left it: the lab keeps its tab, status and search in the address, and
// saves them here for this tab's visit, so "All agents" on an agent's page returns to that view.
import { OPS_PATHS } from "../paths";

const KEY = "mezonas.lab.query";

export function rememberLabQuery(query: string): void {
  try {
    window.sessionStorage.setItem(KEY, query);
  } catch {
    // Storage blocked: the link opens the lab's first view.
  }
}

/** The lab's address with the view it was last left on. */
export function labPath(): string {
  try {
    const q = window.sessionStorage.getItem(KEY);
    return q ? `${OPS_PATHS.lab}?${q}` : OPS_PATHS.lab;
  } catch {
    return OPS_PATHS.lab;
  }
}
