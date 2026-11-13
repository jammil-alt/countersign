// The app's root: fonts, the signed-in state and the lock, the Desk's data, and where a
// notification's tap goes. While locked, only the Unlock screen shows.
import {
  Geist_400Regular,
  Geist_500Medium,
  Geist_600SemiBold,
  useFonts,
} from "@expo-google-fonts/geist";
import { GeistMono_500Medium } from "@expo-google-fonts/geist-mono";
import * as Notifications from "expo-notifications";
import { router, Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { pathForNotification } from "../src/notifications/links";
import { UnlockScreen } from "../src/screens/Unlock";
import { AppProvider, useApp } from "../src/state/app";
import { DeskProvider } from "../src/state/desk";
import { FIXTURES } from "../src/state/store";
import { usePalette } from "../src/theme/theme";

void SplashScreen.preventAutoHideAsync().catch(() => undefined);

if (!FIXTURES) {
  // A notification that arrives while the app is open shows as a banner; the Desk refreshes too.
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: true,
    }),
  });
}

export default function Root() {
  const [fontsLoaded] = useFonts({
    Geist_400Regular,
    Geist_500Medium,
    Geist_600SemiBold,
    GeistMono_500Medium,
  });
  useEffect(() => {
    if (fontsLoaded) void SplashScreen.hideAsync().catch(() => undefined);
  }, [fontsLoaded]);
  if (!fontsLoaded) return null;
  return (
    <SafeAreaProvider>
      <AppProvider>
        <DeskProvider>
          <Shell />
        </DeskProvider>
      </AppProvider>
    </SafeAreaProvider>
  );
}

function Shell() {
  const { locked, status } = useApp();
  const p = usePalette();

  // Tapping a notification opens the page it names (the Desk for items waiting).
  useEffect(() => {
    if (FIXTURES || status !== "signedIn") return;
    const open = (data: unknown) => router.navigate(pathForNotification(data));
    const last = Notifications.getLastNotificationResponse();
    if (last) open(last.notification.request.content.data);
    const sub = Notifications.addNotificationResponseReceivedListener((r) =>
      open(r.notification.request.content.data),
    );
    return () => sub.remove();
  }, [status]);

  if (status === "loading") return null;
  if (locked) return <UnlockScreen />;
  return (
    <>
      <StatusBar style="auto" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: p.paper },
        }}
      />
    </>
  );
}
