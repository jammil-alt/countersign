// "Two steps and your Desk is on this phone": notifications, then signing with Face ID (the
// phone's key), registered with the API in one go.
import { router } from "expo-router";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { enablePush, type PushOutcome, registerPhone } from "../src/device/setup";
import { useApp } from "../src/state/app";
import { markSetupDone } from "../src/state/store";
import { radius, space, usePalette } from "../src/theme/theme";
import { Icon } from "../src/ui/Icon";
import { Button, Eyebrow, Note, Screen, Text } from "../src/ui/kit";

type Step = "push" | "signing";

const PUSH_NOTES: Record<string, string> = {
  denied: "Notifications are off for Mezonas. You can turn them on in your phone's settings.",
  no_project: "This build can't get notifications yet. We'll email you meanwhile.",
  simulator: "A simulator can't get notifications. We'll email you meanwhile.",
  failed: "We couldn't turn on notifications. We'll email you meanwhile.",
};

export default function Setup() {
  const { api, me, setDeviceId, setSetupDone } = useApp();
  const p = usePalette();
  const [step, setStep] = useState<Step>("push");
  const [push, setPush] = useState<PushOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const allow = async () => {
    setBusy(true);
    const out = await enablePush();
    setPush(out);
    setBusy(false);
    setStep("signing");
  };

  const finish = async (register: boolean) => {
    setBusy(true);
    setProblem(null);
    try {
      if (register) {
        const id = await registerPhone(api, push?.status === "on" ? push.token : null);
        setDeviceId(id);
      }
      await markSetupDone();
      setSetupDone(true);
      router.replace("/(tabs)");
    } catch {
      setProblem("We couldn't set up signing on this phone. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const who = me?.user.name ?? me?.user.email ?? "you";
  const client = me?.tenants.find((t) => t.id === me.activeTenantId)?.name;
  const pushNote =
    push && push.status !== "on"
      ? PUSH_NOTES[push.status === "denied" ? "denied" : push.why]
      : null;

  return (
    <Screen edges={["top", "bottom"]}>
      <ScrollView
        contentContainerStyle={{ padding: space["4"], paddingTop: space["10"], gap: space["6"] }}
      >
        <View style={{ gap: space["2"], paddingHorizontal: space["1"] }}>
          <Eyebrow>Set up this phone</Eyebrow>
          <Text variant="heading" style={{ fontSize: 26, lineHeight: 32 }}>
            Two steps and your Desk is on this phone
          </Text>
        </View>

        <View
          style={{
            backgroundColor: p.surface,
            borderWidth: 1,
            borderColor: p.line,
            borderRadius: radius.md,
          }}
        >
          <StepRow n={1} state="done" title="Signed in" note={client ? `${who}, ${client}` : who} />
          <StepRow
            n={2}
            state={step === "push" ? "current" : "done"}
            title="Turn on notifications"
            note="We tell you when something waits on you: a count and nothing else. You see the details here, after Face ID."
          >
            {step === "push" ? (
              <Button label="Allow notifications" busy={busy} onPress={() => void allow()} />
            ) : null}
          </StepRow>
          <StepRow
            n={3}
            state={step === "signing" ? "current" : "todo"}
            title="Sign with Face ID"
            note="This phone gets its own key. You sign with Face ID or your fingerprint: no codes to type."
            last
          >
            {step === "signing" ? (
              <Button
                label="Set up Face ID signing"
                busy={busy}
                icon={<Icon name="faceId" color={p.onSlate} />}
                onPress={() => void finish(true)}
              />
            ) : null}
          </StepRow>
        </View>

        {pushNote ? <Note>{pushNote}</Note> : null}
        {problem ? <Note tone="risk">{problem}</Note> : null}
      </ScrollView>
      <View style={{ padding: space["4"] }}>
        <Button kind="ghost" label="Skip for now" onPress={() => void finish(false)} />
      </View>
    </Screen>
  );
}

function StepRow({
  n,
  state,
  title,
  note,
  last,
  children,
}: {
  n: number;
  state: "done" | "current" | "todo";
  title: string;
  note: string;
  last?: boolean;
  children?: React.ReactNode;
}) {
  const p = usePalette();
  const done = state === "done";
  return (
    <View
      style={{
        flexDirection: "row",
        gap: space["3"],
        padding: space["4"],
        borderBottomWidth: last ? 0 : 1,
        borderBottomColor: p.line,
        backgroundColor: state === "current" ? p.surfaceSubtle : "transparent",
      }}
    >
      <View
        style={{
          width: 24,
          height: 24,
          alignItems: "center",
          justifyContent: "center",
          borderWidth: 1,
          borderColor: done ? p.slate : state === "current" ? p.ink : p.lineStrong,
          backgroundColor: done ? p.slate : p.surface,
        }}
      >
        {done ? (
          <Icon name="check" size={14} color={p.onSlate} />
        ) : (
          <Text variant="reference" tone={state === "current" ? "ink" : "inkMuted"}>
            {String(n)}
          </Text>
        )}
      </View>
      <View style={{ flex: 1, gap: space["1_5"] }}>
        <Text
          variant={state === "current" ? "subheading" : "body"}
          tone={state === "todo" ? "inkMuted" : "ink"}
        >
          {title}
        </Text>
        <Text variant="small" tone="inkMuted">
          {note}
        </Text>
        {children ? <View style={{ marginTop: space["2"] }}>{children}</View> : null}
      </View>
    </View>
  );
}
