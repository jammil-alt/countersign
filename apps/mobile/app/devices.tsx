// Sign-in and phones: the phones that get your notifications and can sign, with this one marked;
// removing a phone stops its notifications and its key at once.
import { type MyDevice, routes } from "@countersign/core";
import { router } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useApp } from "../src/state/app";
import { forgetDevice } from "../src/state/store";
import { space, usePalette } from "../src/theme/theme";
import { Icon } from "../src/ui/Icon";
import { Button, Card, Eyebrow, Note, Pill, Screen, Text } from "../src/ui/kit";

export default function Devices() {
  const { api, deviceId, setDeviceId, setSetupDone, me } = useApp();
  const p = usePalette();
  const [devices, setDevices] = useState<MyDevice[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDevices((await api.call(routes.myDevices)).devices);
    } catch {
      setProblem("Your phones didn't load. Try again in a moment.");
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = async (d: MyDevice) => {
    setBusy(d.id);
    try {
      await api.call(routes.removeDevice, { params: { id: d.id }, byPerson: true });
      if (d.id === deviceId) {
        await forgetDevice();
        setDeviceId(null);
        setSetupDone(false);
      }
      await load();
    } catch {
      setProblem("That phone wasn't removed. Try again.");
    } finally {
      setBusy(null);
    }
  };

  const lead = me?.lead?.name;

  return (
    <Screen>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Back to settings"
        onPress={() => router.back()}
        style={{
          flexDirection: "row",
          alignItems: "center",
          minHeight: 44,
          paddingHorizontal: space["2"],
          marginTop: space["2"],
        }}
      >
        <Icon name="chevronLeft" color={p.slate} />
        <Text variant="label" tone="slate" style={{ fontSize: 15 }}>
          Notifications
        </Text>
      </Pressable>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: space["4"],
          paddingBottom: space["10"],
          gap: space["5"],
        }}
      >
        <Text variant="heading" style={{ fontSize: 26, lineHeight: 32 }}>
          Sign-in and phones
        </Text>
        {problem ? <Note tone="risk">{problem}</Note> : null}

        <View style={{ gap: space["2"] }}>
          <Eyebrow style={{ paddingHorizontal: space["1"] }}>
            Phones that get notifications and sign
          </Eyebrow>
          <Card>
            {devices === null ? (
              <Text tone="inkMuted" style={{ padding: space["4"] }}>
                Loading your phones.
              </Text>
            ) : devices.length === 0 ? (
              <Text tone="inkMuted" style={{ padding: space["4"] }}>
                No phone is set up yet.
              </Text>
            ) : (
              devices.map((d, i) => (
                <View
                  key={d.id}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: space["3"],
                    minHeight: 64,
                    paddingHorizontal: space["4"],
                    paddingVertical: space["2"],
                    borderBottomWidth: i === devices.length - 1 ? 0 : 1,
                    borderBottomColor: p.line,
                  }}
                >
                  <View
                    style={{ flexDirection: "row", alignItems: "center", gap: space["3"], flex: 1 }}
                  >
                    <Icon name="phone" color={p.inkMuted} />
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text variant="label" style={{ fontSize: 15, lineHeight: 20 }}>
                        {d.name}
                      </Text>
                      <Text
                        variant="small"
                        tone="inkMuted"
                        style={{ fontSize: 12, lineHeight: 16 }}
                      >
                        {[
                          d.signing ? "Signs with Face ID" : "Notifications only",
                          d.lastSeenAt
                            ? `last used ${new Date(d.lastSeenAt).toLocaleDateString()}`
                            : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </Text>
                    </View>
                  </View>
                  {d.id === deviceId ? (
                    <Pill tone="accent" label="This phone" />
                  ) : (
                    <Button
                      kind="secondary"
                      label="Remove"
                      busy={busy === d.id}
                      onPress={() => void remove(d)}
                    />
                  )}
                </View>
              ))
            )}
          </Card>
          <Text variant="small" tone="inkMuted" style={{ paddingHorizontal: space["1"] }}>
            Removing a phone stops its notifications and its signing at once.
          </Text>
        </View>

        {deviceId === null ? (
          <Button label="Set up this phone" onPress={() => router.push("/setup")} />
        ) : null}

        <View style={{ gap: space["2"] }}>
          <Eyebrow style={{ paddingHorizontal: space["1"] }}>Lost your phone?</Eyebrow>
          <Text variant="small" tone="inkMuted" style={{ paddingHorizontal: space["1"] }}>
            {`Sign in on the web and remove it here, or ask ${lead ?? "your Mezonas lead"} to remove it for you.`}
          </Text>
        </View>
      </ScrollView>
    </Screen>
  );
}
