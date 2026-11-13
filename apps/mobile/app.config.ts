// The app's Expo config. Values that differ per build come from the environment (eas.json sets
// them per profile): EXPO_PUBLIC_API_ORIGIN, the Mezonas API the app talks to, and
// EAS_PROJECT_ID, the EAS project (push tokens need it; set once `eas init` has made it).
import type { ConfigContext, ExpoConfig } from "expo/config";

const API_ORIGIN = process.env.EXPO_PUBLIC_API_ORIGIN?.trim() || "https://staging.mezonas.com";
const PROJECT_ID = process.env.EAS_PROJECT_ID?.trim() || "";
const OWNER = process.env.EAS_OWNER?.trim() || "";

const FACE_ID = "Mezonas uses Face ID so only you can open your Desk and sign from this phone.";

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: "Mezonas",
  slug: "mezonas",
  scheme: "mezonas",
  version: "0.1.0",
  orientation: "portrait",
  icon: "../../packages/design-system/assets/Logos/mezonas-app-icon-512.png",
  userInterfaceStyle: "automatic",
  ios: {
    bundleIdentifier: "com.mezonas.app",
    supportsTablet: false,
    infoPlist: {
      NSFaceIDUsageDescription: FACE_ID,
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    package: "com.mezonas.app",
    adaptiveIcon: {
      foregroundImage: "../../packages/design-system/assets/Logos/mezonas-app-icon-512.png",
      backgroundColor: "#23415E",
    },
  },
  web: { bundler: "metro", output: "single" },
  plugins: [
    "expo-router",
    ["expo-secure-store", { faceIDPermission: FACE_ID }],
    ["expo-local-authentication", { faceIDPermission: FACE_ID }],
    ["expo-notifications", { color: "#23415E" }],
    "expo-web-browser",
    "expo-font",
  ],
  experiments: { typedRoutes: false },
  extra: {
    apiOrigin: API_ORIGIN,
    ...(PROJECT_ID ? { eas: { projectId: PROJECT_ID } } : {}),
  },
  ...(PROJECT_ID ? { updates: { url: `https://u.expo.dev/${PROJECT_ID}` } } : {}),
  ...(PROJECT_ID ? { runtimeVersion: { policy: "appVersion" as const } } : {}),
  ...(OWNER ? { owner: OWNER } : {}),
});
