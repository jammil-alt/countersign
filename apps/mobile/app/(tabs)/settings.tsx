// Settings: how we reach you (this phone, email, texts), when (right away or once an hour), what
// the lock screen shows, sign-in and phones, and signing out.
import { routes } from "@countersign/core";
import { router } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { useApp } from "../../src/state/app";
import { space } from "../../src/theme/theme";
import {
  Button,
  Card,
  Eyebrow,
  LinkRow,
  Note,
  RadioRow,
  Screen,
  Segmented,
  SwitchRow,
  Text,
} from "../../src/ui/kit";

interface Push {
  on: boolean;
  every: "now" | "hour";
  showClient: boolean;
  devices: number;
}
interface Mine {
  email: boolean;
  sms: boolean;
  canText: boolean;
  emailsOn: boolean;
}

export default function Settings() {
  const { api, me, signOut } = useApp();
  const [push, setPush] = useState<Push | null>(null);
  const [mine, setMine] = useState<Mine | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const client = me?.tenants.find((t) => t.id === me.activeTenantId)?.name ?? "your business";

  const load = useCallback(async () => {
    try {
      const [a, b] = await Promise.all([
        api.call(routes.myPush),
        api.call(routes.portalMyNotifications),
      ]);
      setPush(a);
      setMine(b);
    } catch {
      setProblem("Your settings didn't load. Try again in a moment.");
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const savePush = async (next: Omit<Push, "devices">) => {
    if (!push) return;
    setPush({ ...push, ...next });
    try {
      setPush(await api.call(routes.setMyPush, { body: next, byPerson: true }));
    } catch {
      setProblem("That change didn't save. Try again.");
      void load();
    }
  };

  const saveMine = async (next: { email: boolean; sms: boolean }) => {
    if (!mine) return;
    setMine({ ...mine, ...next });
    try {
      setMine(await api.call(routes.portalSetMyNotifications, { body: next, byPerson: true }));
    } catch {
      setProblem("That change didn't save. Try again.");
      void load();
    }
  };

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: space["4"],
          paddingBottom: space["10"],
          gap: space["5"],
        }}
      >
        <View style={{ paddingTop: space["5"], gap: space["1"] }}>
          <Eyebrow>Settings</Eyebrow>
          <Text variant="heading" style={{ fontSize: 26, lineHeight: 32 }}>
            Notifications
          </Text>
        </View>
        {problem ? <Note tone="risk">{problem}</Note> : null}

        <Section title="How we reach you">
          <Card>
            <SwitchRow
              label="Notifications on your phones"
              {...(push && push.devices === 0 ? { note: "No phone is set up yet" } : {})}
              value={push?.on ?? false}
              disabled={!push}
              onChange={(on) =>
                push && void savePush({ on, every: push.every, showClient: push.showClient })
              }
            />
            <SwitchRow
              label="Email"
              {...(mine && !mine.emailsOn ? { note: "We send no email here yet" } : {})}
              value={mine?.email ?? false}
              disabled={!mine}
              onChange={(email) => mine && void saveMine({ email, sms: mine.sms })}
            />
            <SwitchRow
              label="Text messages"
              {...(mine && !mine.canText
                ? { note: "Add your mobile number on the web first" }
                : {})}
              value={mine?.sms ?? false}
              disabled={!mine?.canText}
              onChange={(sms) => mine && void saveMine({ email: mine.email, sms })}
              last
            />
          </Card>
        </Section>

        <Section title="When something waits on you">
          <Segmented
            label="How often"
            value={push?.every ?? "now"}
            options={[
              { value: "now", label: "Right away" },
              { value: "hour", label: "Once an hour" },
            ]}
            onChange={(every) =>
              push && void savePush({ on: push.on, every, showClient: push.showClient })
            }
          />
          <Text variant="small" tone="inkMuted" style={{ paddingHorizontal: space["1"] }}>
            Not during your quiet hours. Email comes at most once an hour.
          </Text>
        </Section>

        <Section title="On your lock screen">
          <Card>
            <RadioRow
              label="A count only"
              note="“3 items wait on you”"
              selected={!(push?.showClient ?? false)}
              onPress={() =>
                push && void savePush({ on: push.on, every: push.every, showClient: false })
              }
            />
            <RadioRow
              label="With the business name"
              note={`“${client}: 3 items wait on you”`}
              selected={push?.showClient ?? false}
              onPress={() =>
                push && void savePush({ on: push.on, every: push.every, showClient: true })
              }
              last
            />
          </Card>
          <Text variant="small" tone="inkMuted" style={{ paddingHorizontal: space["1"] }}>
            We never put amounts, vendors or customers on your lock screen.
          </Text>
        </Section>

        <Card>
          <LinkRow label="Sign-in and phones" onPress={() => router.push("/devices")} last />
        </Card>

        <View style={{ gap: space["2"] }}>
          <Button kind="secondary" label="Sign out" onPress={() => void signOut()} />
          <Text variant="small" tone="inkMuted" style={{ textAlign: "center" }}>
            {me ? `Signed in as ${me.user.email}` : ""}
          </Text>
        </View>
      </ScrollView>
    </Screen>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: space["2"] }}>
      <Eyebrow style={{ paddingHorizontal: space["1"] }}>{title}</Eyebrow>
      {children}
    </View>
  );
}
