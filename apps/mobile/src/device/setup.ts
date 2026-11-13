// Setting this phone up (the first run after sign-in): notifications, then the signing key, then
// one POST /api/me/devices with the push token and the key's public half.
import { routes } from "@countersign/core";
import Constants from "expo-constants";
import * as Crypto from "expo-crypto";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import type { ApiClient } from "../api/client";
import { FIXTURES, saveDeviceId, savePrivateKey } from "../state/store";
import { encodePrivateKey, newPrivateKey, publicJwk } from "./signing";

/** The EAS project id (app.config.ts `extra.eas.projectId`); push tokens need one. */
export function easProjectId(): string | null {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  return extra?.eas?.projectId ?? null;
}

export type PushOutcome =
  | { status: "on"; token: string }
  | { status: "denied" }
  | { status: "unavailable"; why: "no_project" | "simulator" | "failed" };

/** Asks to send notifications and gets this phone's Expo push token. Never throws. */
export async function enablePush(): Promise<PushOutcome> {
  if (FIXTURES) return { status: "on", token: "ExponentPushToken[fixture]" };
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", {
      name: "Waiting on you",
      importance: Notifications.AndroidImportance.DEFAULT,
    }).catch(() => undefined);
  }
  const current = await Notifications.getPermissionsAsync();
  const granted = current.granted || (await Notifications.requestPermissionsAsync()).granted;
  if (!granted) return { status: "denied" };
  if (!Device.isDevice) return { status: "unavailable", why: "simulator" };
  const projectId = easProjectId();
  if (!projectId) return { status: "unavailable", why: "no_project" };
  try {
    const { data } = await Notifications.getExpoPushTokenAsync({ projectId });
    return { status: "on", token: data };
  } catch {
    return { status: "unavailable", why: "failed" };
  }
}

/** The phone's name as Settings lists it: "Maria's iPhone", else the model. */
export function phoneName(): string {
  const name = Device.deviceName?.trim() || Device.modelName?.trim();
  return (name || (Platform.OS === "ios" ? "iPhone" : "Android phone")).slice(0, 80);
}

/**
 * Makes the signing key (stored behind Face ID or a fingerprint) and registers the phone. Returns
 * the device id the API gave it.
 */
export async function registerPhone(api: ApiClient, pushToken: string | null): Promise<string> {
  const privateKey = newPrivateKey(Crypto.getRandomBytes(48));
  await savePrivateKey(encodePrivateKey(privateKey));
  const { device } = await api.call(routes.registerDevice, {
    body: {
      name: phoneName(),
      platform: Platform.OS === "android" ? "android" : "ios",
      pushToken,
      publicKey: publicJwk(privateKey),
    },
    byPerson: true,
  });
  await saveDeviceId(device.id);
  return device.id;
}

/** A new push token for a registered phone (tokens change after a reinstall or a restore). */
export async function updatePushToken(api: ApiClient, deviceId: string, token: string | null) {
  await api.call(routes.updateDevice, { params: { id: deviceId }, body: { pushToken: token } });
}
