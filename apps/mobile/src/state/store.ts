// What the app keeps on the phone, all in the secure store (the iOS Keychain, Android's Keystore):
// the sealed session, this phone's device id, and the private half of its signing key, which reads
// back only after Face ID or a fingerprint. In the fixture build (EXPO_PUBLIC_FIXTURES=1, for
// screenshots and the web preview) nothing is stored.
import * as SecureStore from "expo-secure-store";

export const FIXTURES = process.env.EXPO_PUBLIC_FIXTURES === "1";

const KEY = {
  session: "mz.session",
  dev: "mz.devUser",
  device: "mz.deviceId",
  setup: "mz.setupDone",
  signing: "mz.signingKey",
} as const;

// DECISION: the sealed session can pass 2 KB, more than one secure-store value may hold on some
// Android versions, so it is stored in chunks (`mz.session.0`, `.1`, …) with their count.
const CHUNK = 1800;

const memory = new Map<string, string>();

async function get(key: string): Promise<string | null> {
  if (FIXTURES) return memory.get(key) ?? null;
  return SecureStore.getItemAsync(key);
}

async function set(key: string, value: string): Promise<void> {
  if (FIXTURES) {
    memory.set(key, value);
    return;
  }
  await SecureStore.setItemAsync(key, value, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

async function remove(key: string): Promise<void> {
  if (FIXTURES) {
    memory.delete(key);
    return;
  }
  await SecureStore.deleteItemAsync(key);
}

export async function saveSession(session: string): Promise<void> {
  const parts = Math.ceil(session.length / CHUNK);
  for (let i = 0; i < parts; i++)
    await set(`${KEY.session}.${i}`, session.slice(i * CHUNK, (i + 1) * CHUNK));
  await set(KEY.session, String(parts));
}

export async function loadSession(): Promise<string | null> {
  const count = Number(await get(KEY.session));
  if (!Number.isInteger(count) || count < 1) return null;
  let out = "";
  for (let i = 0; i < count; i++) {
    const part = await get(`${KEY.session}.${i}`);
    if (part === null) return null;
    out += part;
  }
  return out;
}

export async function clearSession(): Promise<void> {
  const count = Number(await get(KEY.session));
  if (Number.isInteger(count)) for (let i = 0; i < count; i++) await remove(`${KEY.session}.${i}`);
  await remove(KEY.session);
  await remove(KEY.dev);
}

export const saveDevUser = (email: string) => set(KEY.dev, email);
export const loadDevUser = () => get(KEY.dev);

export const saveDeviceId = (id: string) => set(KEY.device, id);
export const loadDeviceId = () => get(KEY.device);

export const markSetupDone = () => set(KEY.setup, "1");
export const setupDone = async () => (await get(KEY.setup)) === "1";

/** Forget this phone: its device id, its key and its setup (signing out of Mezonas on it). */
export async function forgetDevice(): Promise<void> {
  await remove(KEY.device);
  await remove(KEY.setup);
  if (!FIXTURES) await SecureStore.deleteItemAsync(KEY.signing, { requireAuthentication: true });
  else memory.delete(KEY.signing);
}

/** The private key, behind Face ID or a fingerprint: only this phone's owner reads it back. */
export async function savePrivateKey(hex: string): Promise<void> {
  if (FIXTURES) {
    memory.set(KEY.signing, hex);
    return;
  }
  await SecureStore.setItemAsync(KEY.signing, hex, {
    requireAuthentication: true,
    keychainAccessible: SecureStore.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
    authenticationPrompt: "Set up signing with Face ID",
  });
}

/** Reading it is the Face ID moment; null when the person cancels or there is no key. */
export async function readPrivateKey(prompt: string): Promise<string | null> {
  // The fixture build signs with a fixed key: there is no Face ID in a browser preview.
  if (FIXTURES) return memory.get(KEY.signing) ?? "01".repeat(32);
  try {
    return await SecureStore.getItemAsync(KEY.signing, {
      requireAuthentication: true,
      authenticationPrompt: prompt,
    });
  } catch {
    return null;
  }
}

export async function hasPrivateKey(): Promise<boolean> {
  if (FIXTURES) return memory.has(KEY.signing);
  // Asking whether it exists must not prompt: the device id stands for it (both are set together).
  return (await get(KEY.device)) !== null;
}
