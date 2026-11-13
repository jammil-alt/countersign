// Who is signed in, the API client and the app lock, for every screen. The session lives in the
// secure store; the API client reads it on each call and keeps whatever the API seals again.
import { routes } from "@countersign/core";
import Constants from "expo-constants";
import * as LocalAuthentication from "expo-local-authentication";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppState } from "react-native";
import { type ApiClient, type Credentials, createApiClient, type ResponseOf } from "../api/client";
import { fixtureFetch } from "../api/fixtures";
import { cameBack, type LockState, startLock, unlocked, wentAway } from "../lock/lock";
import {
  clearSession,
  FIXTURES,
  forgetDevice,
  loadDeviceId,
  loadDevUser,
  loadSession,
  setupDone as readSetupDone,
  saveDevUser,
  saveSession,
} from "./store";

export type SessionInfo = ResponseOf<typeof routes.session>;

type Status = "loading" | "signedOut" | "signedIn";

interface AppValue {
  status: Status;
  api: ApiClient;
  /** GET /api/session: the person, their client, their language, their lead. */
  me: SessionInfo | null;
  deviceId: string | null;
  setDeviceId(id: string | null): void;
  setupDone: boolean;
  setSetupDone(done: boolean): void;
  locked: boolean;
  unlock(): Promise<boolean>;
  signedIn(session: string): Promise<void>;
  devSignedIn(email: string): Promise<void>;
  signOut(): Promise<void>;
  refreshMe(): Promise<void>;
}

const AppContext = createContext<AppValue | null>(null);

/** Read through a call, so a check after an await sees what `ended()` may have set. */
const isSignedOut = (c: Credentials) => c.kind === "none";

export function apiOrigin(): string {
  const extra = Constants.expoConfig?.extra as { apiOrigin?: string } | undefined;
  return (
    process.env.EXPO_PUBLIC_API_ORIGIN?.trim() || extra?.apiOrigin || "https://staging.mezonas.com"
  );
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [me, setMe] = useState<SessionInfo | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [setupDone, setSetupDone] = useState(false);
  const [lock, setLock] = useState<LockState>(startLock(false));
  const creds = useRef<Credentials>({ kind: "none" });

  const ended = useCallback(() => {
    creds.current = { kind: "none" };
    void clearSession();
    setMe(null);
    setStatus("signedOut");
  }, []);

  const api = useMemo(
    () =>
      createApiClient({
        origin: FIXTURES ? "https://fixtures.mezonas.invalid" : apiOrigin(),
        ...(FIXTURES ? { fetch: fixtureFetch } : {}),
        session: {
          credentials: () => creds.current,
          renewed: (session) => {
            creds.current = { kind: "session", session };
            void saveSession(session);
          },
          ended,
        },
      }),
    [ended],
  );

  const refreshMe = useCallback(async () => {
    setMe(await api.call(routes.session));
  }, [api]);

  // Start: a stored session (or the dev user), this phone's device id and whether it was set up.
  useEffect(() => {
    void (async () => {
      const session = FIXTURES ? "fixture" : await loadSession();
      const dev = session ? null : await loadDevUser();
      setDeviceId(FIXTURES ? "0190a1b2-0000-7000-8000-00000000d001" : await loadDeviceId());
      setSetupDone(FIXTURES ? true : await readSetupDone());
      if (session) creds.current = { kind: "session", session };
      else if (dev && __DEV__) creds.current = { kind: "dev", email: dev };
      if (creds.current.kind === "none") {
        setStatus("signedOut");
        return;
      }
      setLock(startLock(!FIXTURES));
      try {
        await refreshMe();
        setStatus("signedIn");
      } catch {
        // A network failure keeps the session (the Desk says it can't reach us); a 401 ended it.
        setStatus(isSignedOut(creds.current) ? "signedOut" : "signedIn");
      }
    })();
  }, [refreshMe]);

  // The lock: five minutes in the background and Face ID is asked again.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      const now = Date.now();
      setLock((s) => (next === "active" ? cameBack(s, now) : wentAway(s, now)));
    });
    return () => sub.remove();
  }, []);

  const unlock = useCallback(async () => {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: "Unlock Mezonas",
      cancelLabel: "Cancel",
    });
    if (result.success) setLock(unlocked());
    return result.success;
  }, []);

  const signedIn = useCallback(
    async (session: string) => {
      creds.current = { kind: "session", session };
      await saveSession(session);
      await refreshMe();
      setLock(unlocked());
      setStatus("signedIn");
    },
    [refreshMe],
  );

  const devSignedIn = useCallback(
    async (email: string) => {
      creds.current = { kind: "dev", email };
      await saveDevUser(email);
      await refreshMe();
      setLock(unlocked());
      setStatus("signedIn");
    },
    [refreshMe],
  );

  const signOut = useCallback(async () => {
    try {
      // This phone stops getting notifications and its key stops signing, then the session ends.
      if (deviceId && creds.current.kind !== "none") {
        await api
          .call(routes.removeDevice, { params: { id: deviceId }, byPerson: true })
          .catch(() => undefined);
      }
      if (creds.current.kind !== "none") await api.call(routes.signOut, { byPerson: true });
    } catch {
      // Signed out here whatever the API said.
    }
    await forgetDevice().catch(() => undefined);
    setDeviceId(null);
    setSetupDone(false);
    ended();
  }, [api, deviceId, ended]);

  const value: AppValue = {
    status,
    api,
    me,
    deviceId,
    setDeviceId,
    setupDone,
    setSetupDone,
    locked: status === "signedIn" && lock.locked,
    unlock,
    signedIn,
    devSignedIn,
    signOut,
    refreshMe,
  };
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppValue {
  const v = useContext(AppContext);
  if (!v) throw new Error("useApp outside AppProvider");
  return v;
}
