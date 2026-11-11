import type { RouteSpec } from "@countersign/core";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { type ApiClient, api, type CallOptions, type ResponseOf } from "./client";
import { ApiStore, noteWrites } from "./store";

interface ApiContextValue {
  client: ApiClient;
  store: ApiStore;
}

function withStore(client: ApiClient, store?: ApiStore): ApiContextValue {
  return { client: noteWrites(client), store: store ?? new ApiStore(client) };
}

const ApiContext = createContext<ApiContextValue>(withStore(api));

/**
 * Tests and stories hand in a client with a fake fetch. Each provider has its own store, so two
 * tests, or two renders in one test, never share answers; a test that means to remount a screen
 * over the same answers hands in one `store` to both.
 */
// DECISION: the store is per provider (the brief allows per client or per provider): screen tests
// that render twice with one fake client expect the second render to ask again.
export function ApiProvider({
  client,
  store,
  children,
}: {
  client: ApiClient;
  store?: ApiStore;
  children: ReactNode;
}) {
  const value = useMemo(() => withStore(client, store), [client, store]);
  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>;
}

/** The client for calls a screen makes itself; a successful write marks stored answers stale. */
export function useApiClient(): ApiClient {
  return useContext(ApiContext).client;
}

/** The store under `useApi`: the session empties it and sets its scope. */
export function useApiStore(): ApiStore {
  return useContext(ApiContext).store;
}

/** Fills the store for a page about to open (on hover or focus of its link), without a component. */
export function usePrefetch(): <R extends RouteSpec>(
  route: R,
  options?: Omit<CallOptions<R>, "signal">,
) => void {
  const store = useApiStore();
  return useCallback((route, options = {}) => store.prefetch(route, options), [store]);
}

export type ApiOptions<R extends RouteSpec> = Omit<CallOptions<R>, "signal"> & {
  /**
   * `"none"`: never stored or shared. For answers that hold a short-lived link or a value that
   * must not linger (signed document links, export downloads, webhook tokens).
   */
  cache?: "none";
};

export interface ApiState<T> {
  /** The answer for these options; never another key's. Kept when a refresh fails. */
  data: T | undefined;
  /** The last failure, shown beside `data` when there is some. */
  error: unknown;
  /** Nothing to show yet: true only while there is no data. */
  loading: boolean;
  /**
   * Data is showing and a newer answer is on its way. Optional in the type so states built by
   * hand (tests, `Loaded`'s callers) need not name it; `useApi` always sets it.
   */
  refreshing?: boolean;
  reload: () => void;
}

/**
 * Loads one route. Pass `null` options to wait (e.g. until an id is known). What the store already
 * holds for the same route and options shows at once and refreshes behind (`refreshing`); the call
 * reruns when the options change by value, and shows nothing of the last options' answer.
 */
// DECISION: our own small store under the hook (owner's answer D6, docs/audit-plan.md 1.2), not a
// query library; TanStack Query goes under the same hook only if this outgrows it.
export function useApi<R extends RouteSpec>(
  route: R,
  options: ApiOptions<R> | null = {},
): ApiState<ResponseOf<R>> {
  const store = useApiStore();
  const hookId = useId();
  let key: string | null = null;
  let callOptions: Omit<CallOptions<R>, "signal"> | null = null;
  if (options !== null) {
    const { cache, ...rest } = options;
    callOptions = rest;
    const shared = store.key(route, rest);
    key = cache === "none" ? `none:${hookId}:${shared}` : shared;
  }
  const noCache = options?.cache === "none";
  // The entity the call is about: the route and its path params. A change of query (a filter, a
  // search) is the same list asked another way; a change of params is another entity.
  const entity = callOptions === null ? null : store.key(route, { params: callOptions.params });

  // An answer older than five minutes is not shown: dropped the first time a key is read here.
  const seen = useRef<string | null>(null);
  if (key !== null && seen.current !== key) {
    store.dropIfOld(key);
    seen.current = key;
  }

  const ref = useRef({ key, route, callOptions });
  ref.current = { key, route, callOptions };

  const subscribe = useCallback(
    (fn: () => void) => (key === null ? () => {} : store.subscribe(key, fn)),
    [store, key],
  );
  const entry = useSyncExternalStore(subscribe, () => (key === null ? undefined : store.get(key)));

  // A mount asks only when the stored answer is not fresh (so parts of one screen asking the same
  // route ask once); a change of options in a mounted hook always asks, behind what it shows.
  const mounted = useRef(false);
  useEffect(() => {
    const { route: r, callOptions: opts } = ref.current;
    const first = !mounted.current;
    mounted.current = true;
    if (key === null || opts === null) return;
    if (!first || store.needsFetch(key)) void store.fetch(key, r, opts);
    return noCache ? () => store.forget(key) : undefined;
  }, [store, key, noCache]);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  // `reload` asks again on the next render, for the options then: a reload in the same commit as
  // a change to `null` options (a page taking over a frame's call) asks nothing, as before.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const { key: k, route: r, callOptions: opts } = ref.current;
    if (tick > 0 && k !== null && opts !== null) void store.fetch(k, r, opts);
  }, [store, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  // DECISION: while a new query on the same entity loads, the last answer for that entity stays
  // (dimmed by `refreshing` where a screen shows it), as typing and filtering ask (plan 1.8); an
  // answer for other params (another run, another agent) is never shown under the new ones (1.9).
  const own = entry?.data as ResponseOf<R> | undefined;
  const last = useRef<{ entity: string; data: ResponseOf<R> } | null>(null);
  if (own !== undefined && entity !== null) last.current = { entity, data: own };
  const kept =
    own === undefined && entity !== null && last.current?.entity === entity
      ? last.current.data
      : undefined;
  const data = own ?? kept;
  const loading =
    key !== null &&
    data === undefined &&
    (entry === undefined || entry.fetching || entry.error === undefined);
  return {
    data,
    error: entry?.error,
    loading,
    refreshing:
      data !== undefined &&
      (entry?.fetching === true || (kept !== undefined && entry?.error === undefined)),
    reload,
  };
}
