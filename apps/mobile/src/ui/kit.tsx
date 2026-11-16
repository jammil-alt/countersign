// The design system's components on the phone, as React Native views: the same names and rules as
// packages/design-system's CSS (ds-btn, ds-pill, ds-card, ds-seg, ds-switch, ds-toast, mz-person).
// Borders, not shadows; 44pt touch targets; signal (gold) always with a word; agents' work in ink,
// people in copper.
import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  Text as RNText,
  type StyleProp,
  Switch,
  type TextStyle,
  View,
  type ViewStyle,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { fontFamily, type Palette, radius, space, textStyle, usePalette } from "../theme/theme";
import type { TypeName } from "../theme/tokens";

export function Text({
  variant = "body",
  tone = "ink",
  style,
  children,
  numberOfLines,
  tabular,
}: {
  variant?: TypeName;
  tone?: "ink" | "inkMuted" | "slate" | "copper" | "risk" | "positive" | "onSlate" | "signalInk";
  style?: StyleProp<TextStyle>;
  children: ReactNode;
  numberOfLines?: number;
  /** Amounts: tabular figures. */
  tabular?: boolean;
}) {
  const p = usePalette();
  const color = tone === "risk" ? p.riskInk : p[tone];
  return (
    <RNText
      {...(numberOfLines ? { numberOfLines } : {})}
      style={[
        textStyle(variant),
        { color },
        tabular ? { fontVariant: ["tabular-nums"] } : null,
        style,
      ]}
    >
      {children}
    </RNText>
  );
}

export function Screen({
  children,
  edges = ["top"],
  style,
}: {
  children: ReactNode;
  edges?: ("top" | "bottom")[];
  style?: StyleProp<ViewStyle>;
}) {
  const p = usePalette();
  return (
    <SafeAreaView edges={edges} style={[{ flex: 1, backgroundColor: p.paper }, style]}>
      {children}
    </SafeAreaView>
  );
}

type ButtonKind = "primary" | "secondary" | "ghost" | "link";

export function Button({
  kind = "primary",
  label,
  onPress,
  disabled,
  busy,
  icon,
  tall,
  style,
  testID,
  right,
}: {
  kind?: ButtonKind;
  label: string;
  onPress?: () => void;
  disabled?: boolean;
  busy?: boolean;
  icon?: ReactNode;
  /** 52pt: the screen's one main action. */
  tall?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  /** Secondary text at the right end (a quick answer's price). */
  right?: string;
}) {
  const p = usePalette();
  const look = buttonLook(p, kind);
  const off = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      disabled={off}
      onPress={onPress}
      {...(testID ? { testID } : {})}
      style={({ pressed }) => [
        {
          minHeight: kind === "link" ? 44 : tall ? 52 : 44,
          paddingHorizontal: kind === "link" ? 0 : space["4"],
          borderRadius: radius.md,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: right ? "space-between" : "center",
          gap: space["2"],
          opacity: off ? 0.45 : 1,
          backgroundColor: pressed && kind !== "link" ? look.pressed : look.bg,
          borderWidth: kind === "secondary" ? 1 : 0,
          borderColor: p.lineStrong,
        },
        style,
      ]}
    >
      {busy ? <ActivityIndicator color={look.fg} /> : icon}
      <Text
        variant="label"
        style={{
          color: look.fg,
          fontSize: tall ? 15 : 14,
          lineHeight: 20,
          // The brand book: 600 only for subheadings and the Sign button (the primary action).
          ...(kind === "primary" ? { fontFamily: fontFamily("sans", 600) } : {}),
        }}
      >
        {label}
      </Text>
      {right ? (
        <Text variant="small" tone="inkMuted" tabular>
          {right}
        </Text>
      ) : null}
    </Pressable>
  );
}

function buttonLook(p: Palette, kind: ButtonKind) {
  switch (kind) {
    case "primary":
      return { bg: p.slate, pressed: p.slateHover, fg: p.onSlate };
    case "secondary":
      return { bg: p.surface, pressed: p.surfaceSubtle, fg: p.ink };
    case "ghost":
      return { bg: "transparent", pressed: p.surfaceSubtle, fg: p.ink };
    case "link":
      return { bg: "transparent", pressed: "transparent", fg: p.slate };
  }
}

export function Card({
  children,
  style,
  onPress,
  accessibilityLabel,
  testID,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  onPress?: () => void;
  accessibilityLabel?: string;
  testID?: string;
}) {
  const p = usePalette();
  const base: ViewStyle = {
    backgroundColor: p.surface,
    borderColor: p.line,
    borderWidth: 1,
    borderRadius: radius.md,
    overflow: "hidden",
  };
  if (!onPress) {
    return (
      <View style={[base, style]} {...(testID ? { testID } : {})}>
        {children}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      {...(accessibilityLabel ? { accessibilityLabel } : {})}
      {...(testID ? { testID } : {})}
      onPress={onPress}
      style={({ pressed }) => [base, pressed ? { backgroundColor: p.surfaceSubtle } : null, style]}
    >
      {children}
    </Pressable>
  );
}

export type PillTone = "warning" | "positive" | "accent" | "neutral" | "risk";

export function Pill({ tone, label }: { tone: PillTone; label: string }) {
  const p = usePalette();
  const look: Record<PillTone, { fg: string; bg: string; border: string }> = {
    warning: { fg: p.signalInk, bg: p.signalTint, border: p.signal },
    positive: { fg: p.positive, bg: p.positiveTint, border: p.positiveTint },
    accent: { fg: p.slate, bg: p.slateTint, border: p.slateTint },
    neutral: { fg: p.inkMuted, bg: p.surfaceSubtle, border: p.line },
    risk: { fg: p.riskInk, bg: p.riskTint, border: p.riskLine },
  };
  const l = look[tone];
  return (
    <View
      style={{
        alignSelf: "flex-start",
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: radius.pill,
        borderWidth: 1,
        borderColor: l.border,
        backgroundColor: l.bg,
      }}
    >
      <Text variant="label" style={{ color: l.fg, fontSize: 12, lineHeight: 14 }}>
        {label}
      </Text>
    </View>
  );
}

export function Eyebrow({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<TextStyle>;
}) {
  return (
    <Text variant="eyebrow" tone="inkMuted" {...(style ? { style } : {})}>
      {children}
    </Text>
  );
}

/** A person (copper) or an agent's role (ink on subtle), with initials. */
export function PersonChip({
  name,
  role,
  person,
}: {
  name: string;
  role?: string;
  person?: boolean;
}) {
  const p = usePalette();
  const initials = name
    .split(/\s+/)
    .map((w) => w[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space["2"] }}>
      <View
        style={{
          width: 28,
          height: 28,
          borderRadius: radius.pill,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: person ? p.copperTint : p.surfaceSubtle,
          borderWidth: person ? 0 : 1,
          borderColor: p.line,
        }}
      >
        <Text variant="label" style={{ fontSize: 11, color: person ? p.copperInk : p.ink }}>
          {initials}
        </Text>
      </View>
      <Text variant="label" tone={person ? "copper" : "ink"}>
        {role ? `${name}, ${role}` : name}
      </Text>
    </View>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  const p = usePalette();
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      style={{
        flexDirection: "row",
        gap: 2,
        padding: 3,
        backgroundColor: p.surfaceSubtle,
        borderWidth: 1,
        borderColor: p.line,
        borderRadius: radius.md,
      }}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            onPress={() => onChange(o.value)}
            style={{
              flex: 1,
              minHeight: 40,
              alignItems: "center",
              justifyContent: "center",
              borderRadius: radius.sm,
              backgroundColor: on ? p.surface : "transparent",
              borderWidth: on ? 1 : 0,
              borderColor: p.line,
            }}
          >
            <Text variant="label" tone={on ? "ink" : "inkMuted"}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A row with a label (and a note) and a switch, 52pt high. */
export function SwitchRow({
  label,
  note,
  value,
  onChange,
  disabled,
  last,
}: {
  label: string;
  note?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  last?: boolean;
}) {
  const p = usePalette();
  return (
    <View
      style={{
        minHeight: 52,
        paddingHorizontal: space["4"],
        paddingVertical: space["2"],
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: space["3"],
        borderBottomWidth: last ? 0 : 1,
        borderBottomColor: p.line,
      }}
    >
      <View style={{ flex: 1 }}>
        <Text>{label}</Text>
        {note ? (
          <Text variant="small" tone="inkMuted">
            {note}
          </Text>
        ) : null}
      </View>
      <Switch
        accessibilityLabel={label}
        value={value}
        onValueChange={onChange}
        {...(disabled ? { disabled } : {})}
        trackColor={{ false: p.lineStrong, true: p.slate }}
        thumbColor={p.surface}
        // react-native-web's own prop for the thumb when on; native uses thumbColor.
        {...({ activeThumbColor: p.surface } as object)}
        ios_backgroundColor={p.lineStrong}
      />
    </View>
  );
}

/** A tappable row with a value and a chevron. */
export function LinkRow({
  label,
  value,
  onPress,
  last,
}: {
  label: string;
  value?: string;
  onPress: () => void;
  last?: boolean;
}) {
  const p = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 52,
        paddingHorizontal: space["4"],
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        borderBottomWidth: last ? 0 : 1,
        borderBottomColor: p.line,
        backgroundColor: pressed ? p.surfaceSubtle : "transparent",
      })}
    >
      <Text>{label}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space["1"] }}>
        {value ? (
          <Text variant="small" tone="inkMuted">
            {value}
          </Text>
        ) : null}
        <RNText style={{ color: p.inkMuted }}>›</RNText>
      </View>
    </Pressable>
  );
}

/** A choice row with a radio mark. */
export function RadioRow({
  label,
  note,
  selected,
  onPress,
  last,
}: {
  label: string;
  note?: string;
  selected: boolean;
  onPress: () => void;
  last?: boolean;
}) {
  const p = usePalette();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
      onPress={onPress}
      style={{
        minHeight: 60,
        paddingHorizontal: space["4"],
        paddingVertical: space["2"],
        flexDirection: "row",
        alignItems: "center",
        gap: space["3"],
        borderBottomWidth: last ? 0 : 1,
        borderBottomColor: p.line,
      }}
    >
      <View
        style={{
          width: 18,
          height: 18,
          borderRadius: 9,
          borderWidth: 1.5,
          borderColor: selected ? p.slate : p.lineStrong,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {selected ? (
          <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: p.slate }} />
        ) : null}
      </View>
      <View style={{ flex: 1 }}>
        <Text>{label}</Text>
        {note ? (
          <Text variant="small" tone="inkMuted">
            {note}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

export function Toast({
  text,
  action,
  onAction,
}: {
  text: string;
  action?: string;
  onAction?: () => void;
}) {
  const p = usePalette();
  return (
    <View
      accessibilityRole="alert"
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: space["4"],
        minHeight: 48,
        paddingHorizontal: space["4"],
        borderRadius: radius.sm,
        backgroundColor: p.ink,
      }}
    >
      <RNText style={[textStyle("label"), { color: p.paper, flex: 1, fontSize: 14 }]}>
        {text}
      </RNText>
      {action && onAction ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={action}
          onPress={onAction}
          style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: space["1"] }}
        >
          <RNText style={[textStyle("subheading"), { color: p.slateTint, fontSize: 14 }]}>
            {action}
          </RNText>
        </Pressable>
      ) : null}
    </View>
  );
}

/** A bottom sheet over a scrim: one decision at a time. */
export function Sheet({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const p = usePalette();
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        accessibilityLabel="Close"
        onPress={onClose}
        style={{ flex: 1, backgroundColor: "rgba(21,26,33,0.4)" }}
      />
      <View
        style={{
          backgroundColor: p.surface,
          borderTopLeftRadius: radius.lg,
          borderTopRightRadius: radius.lg,
          borderTopWidth: 1,
          borderColor: p.line,
          paddingHorizontal: space["5"],
          paddingTop: space["2_5"],
          paddingBottom: space["8"],
          gap: space["4_5"],
        }}
      >
        <View
          style={{
            alignSelf: "center",
            width: 36,
            height: 4,
            borderRadius: radius.pill,
            backgroundColor: p.line,
          }}
        />
        {children}
      </View>
    </Modal>
  );
}

/** A note in slate tint (information) or risk tint (an error), always with words. */
export function Note({ tone = "info", children }: { tone?: "info" | "risk"; children: ReactNode }) {
  const p = usePalette();
  const risk = tone === "risk";
  return (
    <View
      style={{
        flexDirection: "row",
        gap: space["2_5"],
        padding: space["3"],
        borderRadius: radius.sm,
        backgroundColor: risk ? p.riskTint : p.slateTint,
        borderWidth: risk ? 1 : 0,
        borderColor: p.riskLine,
      }}
    >
      <Text variant="small" tone={risk ? "risk" : "ink"} style={{ flex: 1 }}>
        {children}
      </Text>
    </View>
  );
}

/** A key and a value on one line, as in the sheets' summaries. */
export function Pair({
  k,
  v,
  last,
  tabular,
}: {
  k: string;
  v: string;
  last?: boolean;
  tabular?: boolean;
}) {
  const p = usePalette();
  return (
    <View
      style={{
        flexDirection: "row",
        justifyContent: "space-between",
        gap: space["3"],
        paddingHorizontal: space["3_5"],
        paddingVertical: space["2_5"] + 1,
        borderBottomWidth: last ? 0 : 1,
        borderBottomColor: p.line,
      }}
    >
      <Text variant="small" tone="inkMuted" style={{ fontSize: 14 }}>
        {k}
      </Text>
      <Text
        variant="label"
        style={{ fontSize: 14, flexShrink: 1, textAlign: "right" }}
        {...(tabular ? { tabular } : {})}
      >
        {v}
      </Text>
    </View>
  );
}
