// The three tabs: Desk (with what waits on you, in gold, with its number), Messages and Settings.
import { Redirect, Tabs } from "expo-router";
import { View } from "react-native";
import { useApp } from "../../src/state/app";
import { useDesk } from "../../src/state/desk";
import { fontFamily, radius, usePalette } from "../../src/theme/theme";
import { Icon } from "../../src/ui/Icon";
import { Text } from "../../src/ui/kit";

export default function TabsLayout() {
  const { status } = useApp();
  const { items } = useDesk();
  const p = usePalette();
  if (status === "signedOut") return <Redirect href="/sign-in" />;
  const waiting = items.length;
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: p.slate,
        tabBarInactiveTintColor: p.inkMuted,
        tabBarStyle: { backgroundColor: p.surface, borderTopColor: p.line },
        tabBarLabelStyle: { fontFamily: fontFamily("sans", 500), fontSize: 11, lineHeight: 14 },
        tabBarItemStyle: { paddingVertical: 4 },
        sceneStyle: { backgroundColor: p.paper },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Desk",
          tabBarAccessibilityLabel: waiting > 0 ? `Desk, ${waiting} waiting on you` : "Desk",
          tabBarIcon: ({ color }) => (
            <View>
              <Icon name="desk" size={24} color={color} />
              {waiting > 0 ? (
                <View
                  style={{
                    position: "absolute",
                    top: -4,
                    right: -12,
                    minWidth: 18,
                    height: 18,
                    paddingHorizontal: 5,
                    borderRadius: radius.pill,
                    backgroundColor: p.signal,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Text variant="label" style={{ fontSize: 11, lineHeight: 14, color: "#151A21" }}>
                    {String(waiting)}
                  </Text>
                </View>
              ) : null}
            </View>
          ),
        }}
      />
      <Tabs.Screen
        name="messages"
        options={{
          title: "Messages",
          tabBarIcon: ({ color }) => <Icon name="message" size={24} color={color} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
          tabBarIcon: ({ color }) => <Icon name="settings" size={24} color={color} />,
        }}
      />
    </Tabs>
  );
}
