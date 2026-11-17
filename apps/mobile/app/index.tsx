// Where the app opens: sign-in, this phone's setup, or the Desk.
import { Redirect } from "expo-router";
import { useApp } from "../src/state/app";

export default function Index() {
  const { status, setupDone } = useApp();
  if (status === "signedOut") return <Redirect href="/sign-in" />;
  if (!setupDone) return <Redirect href="/setup" />;
  return <Redirect href="/(tabs)" />;
}
