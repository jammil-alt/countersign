// Phone notifications (docs/plan.md §1.99): Mezonas tells a person's phones that something waits,
// through Expo's push service, which hands each message to Apple's or Google's. What goes is
// `renderPush`'s: "Mezonas" (or the business's name, if the person chose it) and the kind's
// sentence with its count. No record content, no link; the app opens the page itself.
//
// DECISION: Expo's push service rather than Apple's and Google's directly. Apple's push service
// speaks only HTTP/2, which a Worker's fetch is not known to offer, and Expo's tokens work for
// both platforms with one request shape. Expo is therefore a processor (`expo_push` in core's
// compliance list): it sees the device token and those few words.

import type { FetchLike } from "@countersign/connectors";
import type { Bindings } from "../env";

export const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
/** Expo takes at most 100 messages a request. */
const EXPO_BATCH = 100;

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  /** What the app reads when the notification is tapped: the page to open. */
  data: { path: string; kind: string };
  /** The app icon's count: the items waiting, when the kind counts them. */
  badge?: number;
}

export type PushTicket =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly gone: boolean; readonly error: string };

export interface Pusher {
  /** False when phone notifications are switched off here (`MOBILE_PUSH=off`): rows are skipped. */
  readonly isConfigured: boolean;
  /** One ticket per message, in order. Throws when the request itself fails. */
  send(messages: readonly PushMessage[]): Promise<PushTicket[]>;
}

export const unconfiguredPusher: Pusher = {
  isConfigured: false,
  send: () => Promise.reject(new Error("phone notifications are off")),
};

const ExpoTicket = (value: unknown): PushTicket => {
  const t = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  if (t.status === "ok" && typeof t.id === "string") return { ok: true, id: t.id };
  const details = (t.details && typeof t.details === "object" ? t.details : {}) as Record<
    string,
    unknown
  >;
  const error = typeof details.error === "string" ? details.error : "error";
  // The app was removed or the token replaced: that phone gets nothing more.
  return { ok: false, gone: error === "DeviceNotRegistered", error };
};

/**
 * Expo's push service. `accessToken` (EXPO_ACCESS_TOKEN) is needed once the Expo project turns on
 * "enhanced push security", which we should: then only we can send to our app's tokens.
 */
export function expoPusher(input: { fetch: FetchLike; accessToken?: string | null }): Pusher {
  const token = input.accessToken?.trim();
  return {
    isConfigured: true,
    async send(messages) {
      const out: PushTicket[] = [];
      for (let i = 0; i < messages.length; i += EXPO_BATCH) {
        const batch = messages.slice(i, i + EXPO_BATCH);
        const response = await input.fetch(EXPO_PUSH_URL, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(
            batch.map((m) => ({
              to: m.to,
              title: m.title,
              body: m.body,
              data: m.data,
              sound: "default",
              priority: "high",
              ...(m.badge !== undefined ? { badge: m.badge } : {}),
            })),
          ),
        });
        if (!response.ok) throw new Error(`expo push answered ${response.status}`);
        const json = JSON.parse(await response.text()) as { data?: unknown };
        const tickets = Array.isArray(json.data) ? json.data : [];
        if (tickets.length !== batch.length) throw new Error("expo push: tickets don't match");
        out.push(...tickets.map(ExpoTicket));
      }
      return out;
    },
  };
}

/** On unless MOBILE_PUSH is `off`. */
export function pusherFromEnv(env: Bindings, fetch: FetchLike): Pusher {
  if (env.MOBILE_PUSH?.trim().toLowerCase() === "off") return unconfiguredPusher;
  return expoPusher({ fetch, accessToken: env.EXPO_ACCESS_TOKEN ?? null });
}
