// "Unlock to see your Desk": after five minutes away (or a cold start), Face ID or a fingerprint
// before anything shows. Asked once on its own; then the button.
import { useEffect, useState } from "react";
import { View } from "react-native";
import { useApp } from "../state/app";
import { radius, space, usePalette } from "../theme/theme";
import { Icon } from "../ui/Icon";
import { Button, Note, Screen, Text } from "../ui/kit";
import { Mark } from "../ui/Mark";

export function UnlockScreen() {
  const { unlock, signOut, me } = useApp();
  const p = usePalette();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    void unlock().then((ok) => setFailed(!ok));
  }, [unlock]);

  const name = me?.user.name ?? me?.user.email ?? null;
  const client = me?.tenants.find((t) => t.id === me.activeTenantId)?.name ?? null;

  return (
    <Screen
      edges={["top", "bottom"]}
      style={{ paddingHorizontal: space["6"], paddingBottom: space["6"] }}
    >
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: space["5"] }}>
        <Mark size={72} />
        <View style={{ gap: space["2"], alignItems: "center" }}>
          <Text variant="heading" style={{ fontSize: 26, lineHeight: 32, textAlign: "center" }}>
            Unlock to see your Desk
          </Text>
          <Text tone="inkMuted" style={{ textAlign: "center" }}>
            Mezonas locks after 5 minutes away, so only you can sign from this phone.
          </Text>
        </View>
        {name ? (
          <View
            style={{
              paddingHorizontal: space["3"],
              paddingVertical: space["2"],
              borderRadius: radius.pill,
              borderWidth: 1,
              borderColor: p.line,
              backgroundColor: p.surface,
            }}
          >
            <Text variant="label">{client ? `${name} · ${client}` : name}</Text>
          </View>
        ) : null}
        {failed ? (
          <Note>Face ID didn't match. Try again, or use your passcode when asked.</Note>
        ) : null}
      </View>
      <View style={{ gap: space["2_5"] }}>
        <Button
          tall
          label="Unlock with Face ID"
          icon={<Icon name="faceId" color={p.onSlate} />}
          onPress={() => void unlock().then((ok) => setFailed(!ok))}
        />
        <Button kind="ghost" label="Not you? Sign out" onPress={() => void signOut()} />
      </View>
    </Screen>
  );
}
