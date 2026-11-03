import type { RouteSpec } from "@countersign/core";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { type ApiClient, api, type CallOptions, type ResponseOf } from "./client";

const ApiContext = createContext<ApiClient>(api);

/** Tests and stories hand in a client with a fake fetch. */
export function ApiProvider({ client, children }: { client: ApiClient; children: ReactNode }) {
  return <ApiContext.Provider value={client}>{children}</ApiContext.Provider>;
}

export function useApiClient(): ApiClient {
  return useContext(ApiContext);
}

export interface ApiState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => void;
}

/**
 * Loads one route. Pass `null` options to wait (e.g. until an id is known). The call reruns when
 * the options change by value; a stale answer is dropped by aborting the request it belonged to.
 */
// DECISION: a small hook instead of a query library; v1 screens load once and poll a few
// statuses (plan §1.2 "Live updates"), which `reload` covers.
export function useApi<R extends RouteSpec>(
  route: R,
  options: Omit<CallOptions<R>, "signal"> | null = {},
): ApiState<ResponseOf<R>> {
  const client = useApiClient();
  const key = options === null ? null : JSON.stringify(options);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [tick, setTick] = useState(0);
  const [state, setState] = useState<{ data?: ResponseOf<R>; error?: unknown; loading: boolean }>({
    loading: key !== null,
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the options by value; `tick` forces a reload.
  useEffect(() => {
    const opts = optionsRef.current;
    if (key === null || opts === null) return;
    const controller = new AbortController();
    setState((s) => ({ ...s, loading: true }));
    client.call(route, { ...opts, signal: controller.signal }).then(
      (data) => {
        if (!controller.signal.aborted) setState({ data, loading: false });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setState({ error, loading: false });
      },
    );
    return () => controller.abort();
  }, [client, route, key, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data: state.data, error: state.error, loading: state.loading, reload };
}
