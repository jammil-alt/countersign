// Sign in: the system browser runs the usual Mezonas sign-in (WorkOS) and hands the session back.
// In a development build only, a dev sign-in by email for `wrangler dev` with the dev adapter.
import { router } from "expo-router";
import { useState } from "react";
import { TextInput, View } from "react-native";
import { signInWithBrowser } from "../src/auth/signIn";
import { apiOrigin, useApp } from "../src/state/app";
import { radius, space, textStyle, usePalette } from "../src/theme/theme";
import { Button, Note, Screen, Text } from "../src/ui/kit";
import { Mark } from "../src/ui/Mark";

const REFUSALS: Record<string, string> = {
  not_invited: "This email has no Mezonas account. Ask your Mezonas lead to invite you.",
  email_not_verified: "Confirm your email first, then sign in again.",
  email_taken: "This email is tied to another sign-in. Ask your Mezonas lead.",
};

export default function SignIn() {
  const { api, signedIn, devSignedIn } = useApp();
  const p = usePalette();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [devEmail, setDevEmail] = useState("");

  const start = async () => {
    setBusy(true);
    setProblem(null);
    const r = await signInWithBrowser(api, apiOrigin());
    setBusy(false);
    if (r.ok) {
      await signedIn(r.session);
      router.replace("/");
      return;
    }
    if (r.reason === "refused") {
      setProblem((r.code && REFUSALS[r.code]) ?? "Sign-in didn't finish. Try again.");
    } else if (r.reason === "failed") {
      setProblem("We couldn't finish signing you in. Try again.");
    }
  };

  const dev = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await devSignedIn(devEmail.trim().toLowerCase());
      router.replace("/");
    } catch {
      setProblem("No dev user with that email. Seed the database, then try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen
      edges={["top", "bottom"]}
      style={{ paddingHorizontal: space["6"], paddingBottom: space["6"] }}
    >
      <View style={{ flex: 1, justifyContent: "center", gap: space["6"] }}>
        <Mark size={64} />
        <View style={{ gap: space["2"] }}>
          <Text variant="heading" style={{ fontSize: 28, lineHeight: 34 }}>
            Your Desk, on your phone
          </Text>
          <Text tone="inkMuted">
            See what waits on you, answer in one tap and sign with Face ID. Sign in with the account
            your Mezonas lead set up for you.
          </Text>
        </View>
        {problem ? <Note tone="risk">{problem}</Note> : null}
      </View>
      <View style={{ gap: space["3"] }}>
        <Button tall label="Sign in" busy={busy} onPress={() => void start()} testID="sign-in" />
        {__DEV__ ? (
          <View
            style={{
              gap: space["2"],
              paddingTop: space["4"],
              borderTopWidth: 1,
              borderTopColor: p.line,
            }}
          >
            <Text variant="eyebrow" tone="inkMuted">
              Development only
            </Text>
            <TextInput
              value={devEmail}
              onChangeText={setDevEmail}
              placeholder="dev user email"
              placeholderTextColor={p.inkFaint}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              accessibilityLabel="Dev user email"
              style={[
                textStyle("body"),
                {
                  minHeight: 44,
                  paddingHorizontal: space["3"],
                  borderWidth: 1,
                  borderColor: p.lineStrong,
                  borderRadius: radius.sm,
                  color: p.ink,
                  backgroundColor: p.surface,
                },
              ]}
            />
            <Button
              kind="secondary"
              label="Dev sign-in"
              disabled={!devEmail.includes("@")}
              onPress={() => void dev()}
            />
          </View>
        ) : null}
      </View>
    </Screen>
  );
}
