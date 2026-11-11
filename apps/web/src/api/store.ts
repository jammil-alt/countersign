import type { RouteSpec } from "@countersign/core";
import type { ApiClient, CallOptions, ResponseOf } from "./client";

/**
 * What the app already knows from the API (docs/audit-plan.md 1.2): answers to `GET`s, kept in
 * memory so a screen seen a moment ago shows at once and refreshes behind. One store per
 * `ApiProvider` (and one for the app's own client), so tests that hand in a fake client never share
 * answers.
 *
 * The rules, all of them:
 * - an answer is keyed by the session's scope (user and active client), the route and its options;
 * - identical requests in flight are one request;
 * - any successful write, anywhere in the app, marks every stored answer stale (`noteWrite`);
 * - an answer older than five minutes is never shown again, and at most `MAX_ENTRIES` are kept;
 * - the store is emptied when the scope changes (sign-out, another session, the idle lock, the
 *   operator's active client) and lives in memory only: never `localStorage`, `sessionStorage` or
 *   IndexedDB, since it holds client data.
 */

// DECISION: nothing older than five minutes is shown (the plan's rule); signed document links
// live five minutes too, though those routes opt out (`cache: "none"`).
export const MAX_AGE_MS = 5 * 60_000;
// DECISION: an answer under ten seconds old, with no write since, is not asked again when another
// part of the screen mounts with the same key: that is what makes a screen ask each route once.
// A mount after that shows the stored answer and refreshes behind it; `reload` always asks.
export const FRESH_MS = 10_000;
// DECISION (2.5, the lead's answer): a catalog (`life: "catalog"` on `useApi`: the event, builder
// and connector catalogs, the models list, the clients' names) changes only on a deploy, a pack
// switch or a write, so its answer stays fresh for five minutes instead of ten seconds. A write
// still marks it stale like every other answer (the plan's one invalidation rule: creating a
// client changes the clients' names), the store still empties on every scope change and sign-out,
// and `reload` still asks.
export const CATALOG_FRESH_MS = MAX_AGE_MS;

/** How long an answer stays fresh: the default, or a catalog's longer life. */
export type Life = "catalog";

export function freshFor(life: Life | undefined): number {
  return life === "catalog" ? CATALOG_FRESH_MS : FRESH_MS;
}
// DECISION: at most 200 answers are kept; the least recently used answer no screen is showing goes
// first. A day of use stays bounded, and 200 covers every screen of a session's last five minutes.
export const MAX_ENTRIES = 200;

export interface Entry {
  /** The last answer, kept through a failed refresh (1.9). */
  readonly data?: unknown;
  /** The last failure; cleared by the next answer. */
  readonly error?: unknown;
  /** When `data` was answered; 0 when there is none. */
  readonly at: number;
  /** The write count when `data`'s request started: below `writes` means stale. */
  readonly epoch: number;
  /** A request is in flight for this key. */
  readonly fetching: boolean;
}

// Writes are counted for the whole app, not per store: a write through one client makes every
// answer anywhere stale. An extra refresh is the only cost.
let writes = 0;

/** A write succeeded (any non-`GET`, an upload): every stored answer is stale from now. */
export function noteWrite(): void {
  writes += 1;
}

type Listener = () => void;

export class ApiStore {
  /** Who the answers are for; null until the session's first answer names them. */
  private scope: string | null = null;
  private generation = 0;
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Map<string, Set<Listener>>();
  /** Told on every `clear`, so a hook with no answer yet still moves to its new key. */
  private readonly onClear = new Set<Listener>();
  private readonly inflight = new Map<string, { promise: Promise<void>; epoch: number }>();
  /** The latest request per key: only its answer is kept, so an older one can't land on top. */
  private readonly latest = new Map<string, number>();
  private requests = 0;
  /** Signing out: nothing is asked or kept until the signed-in screens have gone (`open`). */
  private closed = false;

  constructor(
    private readonly client: ApiClient,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * The key for one call. It starts with the store's generation, which moves on every change of
   * scope (user or active client) and every sign-out, so two sessions can never share a key.
   */
  key(route: RouteSpec, options: object): string {
    return `${this.generation}\u0001${route.method} ${route.path}\u0001${JSON.stringify(options)}`;
  }

  /**
   * Who is asking: the user and the active client. A different scope empties the store, so a
   * second session never sees the first's answers.
   */
  // DECISION: the session's first answer names the scope without emptying the store: whatever was
  // asked before it went with the same cookie, so it is that session's own. Every later change
  // (another user, another active client, signed out) empties it.
  setScope(scope: string): boolean {
    if (this.scope === null) {
      this.scope = scope;
      return false;
    }
    if (scope === this.scope) return false;
    this.scope = scope;
    this.clear();
    return true;
  }

  /**
   * Empties the store and refuses every request until `open`. Sign-out closes it: the screens
   * still mounted would otherwise ask again at once, with the cookie that is about to go.
   */
  close(): void {
    this.closed = true;
    this.clear();
  }

  /** Takes requests again, once the screens of the session that went are gone. */
  open(): void {
    if (!this.closed) return;
    this.closed = false;
    this.clear();
  }

  /** Who the answers are for: a user and client, "" signed out, null not yet known. */
  get currentScope(): string | null {
    return this.scope;
  }

  /** The store's clock (tests give it another). */
  clock(): number {
    return this.now();
  }

  /** Whether a signed-in scope is set (a user, not "" or not yet known). */
  get signedIn(): boolean {
    return this.scope !== null && this.scope !== "";
  }

  /** How many answers are kept (tests). */
  get size(): number {
    return this.entries.size;
  }

  /** Forgets every answer and drops the answers of requests still in flight. */
  clear(): void {
    this.generation += 1;
    this.entries.clear();
    this.inflight.clear();
    this.latest.clear();
    for (const set of this.listeners.values()) for (const fn of set) fn();
    for (const fn of this.onClear) fn();
  }

  /** Changes on every `clear`: part of every key. */
  get version(): number {
    return this.generation;
  }

  subscribeClear(fn: Listener): () => void {
    this.onClear.add(fn);
    return () => {
      this.onClear.delete(fn);
    };
  }

  get(key: string): Entry | undefined {
    return this.entries.get(key);
  }

  /** Whether an answer is too old to show (nothing older than five minutes is shown). */
  tooOld(at: number, now = this.now()): boolean {
    return now - at >= MAX_AGE_MS;
  }

  /**
   * Whether a mount should ask again: no answer, a stale one, or one older than `fresh` (`FRESH_MS`,
   * or a catalog's `CATALOG_FRESH_MS`).
   */
  needsFetch(key: string, fresh: number = FRESH_MS): boolean {
    const e = this.entries.get(key);
    if (!e || e.data === undefined) return !e?.fetching;
    if (e.fetching) return false;
    return e.epoch < writes || this.now() - e.at >= fresh;
  }

  /** Whether the stored answer for `key` was asked before the last successful write. */
  staleByWrite(key: string): boolean {
    const e = this.entries.get(key);
    return e?.data !== undefined && e.epoch < writes;
  }

  subscribe(key: string, fn: Listener): () => void {
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.listeners.delete(key);
    };
  }

  /** Forgets one key (a `cache: "none"` hook going away). */
  forget(key: string): void {
    this.entries.delete(key);
    this.inflight.delete(key);
    this.latest.delete(key);
  }

  /**
   * Asks for `key`, or joins the request already in flight for it. The answer replaces `data`; a
   * failure keeps it and sets `error`.
   */
  fetch<R extends RouteSpec>(
    key: string,
    route: R,
    options: Omit<CallOptions<R>, "signal">,
  ): Promise<void> {
    // A request that started before the last write may answer with what the write changed: it is
    // not joined, a new one is asked and only the newest answer is kept.
    if (this.closed) return Promise.resolve();
    const pending = this.inflight.get(key);
    if (pending && pending.epoch === writes) return pending.promise;
    const generation = this.generation;
    const epoch = writes;
    const id = ++this.requests;
    this.latest.set(key, id);
    this.prune();
    this.update(key, (e) => ({ ...e, fetching: true }));
    const current = () => generation === this.generation && this.latest.get(key) === id;
    const promise = this.client
      .call(route, options)
      .then(
        (data: ResponseOf<R>) => {
          if (current()) this.update(key, () => ({ data, at: this.now(), epoch, fetching: false }));
        },
        (error: unknown) => {
          if (current()) this.update(key, (e) => ({ ...e, error, fetching: false }));
        },
      )
      .finally(() => {
        if (this.inflight.get(key)?.promise === promise) this.inflight.delete(key);
        if (!this.entries.has(key)) this.latest.delete(key);
      });
    this.inflight.set(key, { promise, epoch });
    return promise;
  }

  /** Fills the store for a page about to open, unless a fresh answer is already there (1.6). */
  prefetch<R extends RouteSpec>(
    route: R,
    options: Omit<CallOptions<R>, "signal"> = {},
    life?: Life,
  ): void {
    const key = this.key(route, options);
    const e = this.entries.get(key);
    if (e?.data !== undefined && this.tooOld(e.at)) this.entries.delete(key);
    if (this.needsFetch(key, freshFor(life))) void this.fetch(key, route, options);
  }

  private update(key: string, next: (e: Entry) => Entry): void {
    const prev = this.entries.get(key) ?? { at: 0, epoch: 0, fetching: false };
    // Re-inserted, so the map's order is the order of use: the first entries are the least recent.
    this.entries.delete(key);
    this.entries.set(key, next(prev));
    this.trim();
    for (const fn of this.listeners.get(key) ?? []) fn();
  }

  /** Lets go of answers no screen is showing: too old to show, or over the cap (oldest first). */
  private prune(): void {
    const now = this.now();
    for (const [key, e] of this.entries) {
      if (!e.fetching && this.tooOld(e.at, now) && !this.listeners.has(key)) this.drop(key);
    }
  }

  private trim(): void {
    if (this.entries.size <= MAX_ENTRIES) return;
    for (const [key, e] of this.entries) {
      if (this.entries.size <= MAX_ENTRIES) break;
      if (!e.fetching && !this.listeners.has(key)) this.drop(key);
    }
  }

  private drop(key: string): void {
    this.entries.delete(key);
    if (!this.inflight.has(key)) this.latest.delete(key);
  }
}

/** The client a store's screens use: the same calls, with every successful write noted. */
export function noteWrites(client: ApiClient): ApiClient {
  return {
    async call(route, options) {
      const out = await client.call(route, options);
      if (route.method !== "GET") noteWrite();
      return out;
    },
  };
}
