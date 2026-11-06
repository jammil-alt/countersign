// v0.12 bankfeed (docs/plan.md §1.52): Plaid Link, opened in the page for the client admin to
// connect their bank or card. The API answers a Link token and a signed state; Link's result (a
// public token) goes back to the usual callback route with that state. The bank's login is typed
// into Plaid's own window: it never reaches this page, our API or the operator. For a bank that
// signs in by OAuth, Plaid sends the browser to `/connections/bankfeed/callback`, where Link is
// opened again with the same token (kept in this tab's sessionStorage) to finish.
// The script comes only from Plaid's CDN; apps/web/public/_headers allows that one script and
// Plaid's frames.

export const PLAID_LINK_SCRIPT = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";

export interface LinkResult {
  publicToken: string;
  state: string;
}

interface PlaidHandler {
  open(): void;
  destroy(): void;
}

interface PlaidGlobal {
  create(config: {
    token: string;
    receivedRedirectUri?: string;
    onSuccess(publicToken: string, metadata: unknown): void;
    onExit(error: unknown, metadata: unknown): void;
  }): PlaidHandler;
}

const STORAGE_KEY = "mezonas.plaidLink";

interface Pending {
  token: string;
  state: string;
}

function remember(p: Pending | null): void {
  try {
    if (p) window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(p));
    else window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // No storage (private mode): an OAuth bank then has to be started again.
  }
}

/** The Link session this tab started, for an OAuth bank's return. */
export function pendingLink(): Pending | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    const p = raw ? (JSON.parse(raw) as Partial<Pending>) : null;
    return p && typeof p.token === "string" && typeof p.state === "string"
      ? { token: p.token, state: p.state }
      : null;
  } catch {
    return null;
  }
}

let loading: Promise<PlaidGlobal> | null = null;

function plaidGlobal(): PlaidGlobal | undefined {
  return (window as unknown as { Plaid?: PlaidGlobal }).Plaid;
}

/** Loads Plaid Link's script once. */
function loadPlaid(): Promise<PlaidGlobal> {
  const ready = plaidGlobal();
  if (ready) return Promise.resolve(ready);
  loading ??= new Promise<PlaidGlobal>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = PLAID_LINK_SCRIPT;
    script.async = true;
    script.onload = () => {
      const plaid = plaidGlobal();
      if (plaid) resolve(plaid);
      else reject(new Error("Plaid Link did not load"));
    };
    script.onerror = () => {
      loading = null;
      reject(new Error("Plaid Link did not load"));
    };
    document.head.appendChild(script);
  });
  return loading;
}

/**
 * Opens Link and resolves with its public token and the state, or null when the person closed
 * it. `receivedRedirectUri` is set only on an OAuth bank's return.
 */
export async function openPlaidLink(
  link: Pending,
  receivedRedirectUri?: string,
): Promise<LinkResult | null> {
  const plaid = await loadPlaid();
  remember(link);
  return new Promise<LinkResult | null>((resolve) => {
    const handler = plaid.create({
      token: link.token,
      ...(receivedRedirectUri ? { receivedRedirectUri } : {}),
      onSuccess(publicToken) {
        remember(null);
        handler.destroy();
        resolve({ publicToken, state: link.state });
      },
      onExit() {
        remember(null);
        handler.destroy();
        resolve(null);
      },
    });
    handler.open();
  });
}
