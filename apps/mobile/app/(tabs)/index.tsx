// Your Desk: what waits on you. Changes open to be signed; questions with quick answers are
// answered here in one tap; "Not now" sets an item aside. After a signature, the undo window.
import { pickLocalized, routes } from "@countersign/core";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, RefreshControl, ScrollView, View } from "react-native";
import {
  ago,
  clock,
  type DeskItem,
  isChange,
  needOf,
  quickAnswers,
  snoozeTimes,
  undoLeft,
  whyLines,
} from "../../src/desk/model";
import { useApp } from "../../src/state/app";
import { useDesk } from "../../src/state/desk";
import { radius, space, usePalette } from "../../src/theme/theme";
import { Icon } from "../../src/ui/Icon";
import {
  Button,
  Card,
  Eyebrow,
  Note,
  PersonChip,
  Pill,
  Screen,
  Sheet,
  Text,
  Toast,
} from "../../src/ui/kit";

export default function Desk() {
  const { me } = useApp();
  const desk = useDesk();
  const p = usePalette();
  const [later, setLater] = useState<DeskItem | null>(null);
  const client = me?.tenants.find((t) => t.id === me.activeTenantId)?.name ?? "";
  const initials = (me?.user.name ?? me?.user.email ?? "?")
    .split(/\s+/)
    .map((w) => w[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <Screen>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: space["4"],
          paddingTop: space["5"],
          paddingBottom: space["3"],
        }}
      >
        <View style={{ gap: space["1"] }}>
          {client ? <Eyebrow>{client}</Eyebrow> : null}
          <Text variant="heading" style={{ fontSize: 26, lineHeight: 32 }}>
            Your Desk
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Settings"
          onPress={() => router.navigate("/settings")}
          style={{
            width: 44,
            height: 44,
            borderRadius: radius.pill,
            backgroundColor: p.ink,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text variant="label" style={{ color: p.paper }}>
            {initials}
          </Text>
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: space["4"],
          paddingBottom: space["24"],
          gap: space["3"],
        }}
        refreshControl={
          <RefreshControl
            refreshing={desk.loading}
            onRefresh={() => void desk.refresh(true)}
            tintColor={p.inkMuted}
          />
        }
      >
        <Text variant="small" tone="inkMuted">
          {desk.items.length === 0
            ? desk.loading
              ? "Loading what waits on you."
              : "Nothing waits on you."
            : `${desk.items.length} ${desk.items.length === 1 ? "item waits" : "items wait"} on you.`}
        </Text>
        {desk.error ? <Note tone="risk">{desk.error}</Note> : null}
        {desk.items.map((item) => (
          <DeskCard key={item.id} item={item} onLater={() => setLater(item)} />
        ))}
        {desk.setAside > 0 ? (
          <Text
            variant="small"
            tone="inkMuted"
            style={{ paddingVertical: space["3"], paddingHorizontal: space["1"] }}
          >
            {desk.setAside === 1
              ? "1 item set aside for later."
              : `${desk.setAside} items set aside for later.`}
          </Text>
        ) : null}
        {desk.items.length === 0 && !desk.loading && !desk.error ? (
          <Card style={{ padding: space["6"], alignItems: "center", gap: space["2"] }}>
            <Icon name="check" size={24} color={p.positive} />
            <Text variant="subheading">You're all caught up</Text>
            <Text variant="small" tone="inkMuted" style={{ textAlign: "center" }}>
              We'll tell you when something needs you.
            </Text>
          </Card>
        ) : null}
      </ScrollView>

      <SignedToast />
      <LaterSheet item={later} onClose={() => setLater(null)} />
    </Screen>
  );
}

function DeskCard({ item, onLater }: { item: DeskItem; onLater: () => void }) {
  const { api, me } = useApp();
  const desk = useDesk();
  const p = usePalette();
  const [busy, setBusy] = useState<string | null>(null);
  const need = needOf(item);
  const locale = me?.language.effective ?? "en";
  const choices = need === "answer" ? quickAnswers(item.payload, locale) : null;
  const question = typeof item.payload.question === "string" ? item.payload.question : null;
  const service = item.service?.name ?? null;
  const [agent, role] = service?.includes(",") ? service.split(/,\s*/, 2) : [service, undefined];
  const description = item.display?.tool?.description;
  // The tool's own line on what the change does, else the first reason it waits on you.
  const line =
    description !== undefined
      ? pickLocalized(description, locale)
      : (whyLines(item, locale)[0] ?? question ?? null);

  const answer = async (value: string) => {
    setBusy(value);
    try {
      await api.call(routes.portalResolveInbox, {
        params: { id: item.id },
        body: { decision: "approve", answer: value },
        byPerson: true,
      });
      desk.drop(item.id);
      void desk.refresh();
    } finally {
      setBusy(null);
    }
  };

  const open = () => router.push({ pathname: "/item/[id]", params: { id: item.id } });

  if (choices) {
    return (
      <Card style={{ padding: space["4"], gap: space["2_5"] }}>
        <View
          style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}
        >
          <Pill tone="warning" label="Your answer" />
          <Text variant="small" tone="inkMuted">
            {ago(item.createdAt, Date.now())}
          </Text>
        </View>
        <Text variant="subheading">{item.title}</Text>
        {question ? (
          <Text variant="small" tone="inkMuted">
            {question}
          </Text>
        ) : null}
        <View style={{ gap: space["2"], paddingTop: 2 }}>
          {choices.map((c) => (
            <Button
              key={c.value}
              kind="secondary"
              label={c.label}
              busy={busy === c.value}
              disabled={busy !== null && busy !== c.value}
              onPress={() => void answer(c.value)}
              style={{ justifyContent: "flex-start" }}
            />
          ))}
          <Button kind="ghost" label="Not now" onPress={onLater} />
        </View>
      </Card>
    );
  }

  return (
    <Card
      onPress={open}
      accessibilityLabel={item.title}
      style={{ padding: space["4"], gap: space["2_5"] }}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Pill
          tone="warning"
          label={
            need === "answer" ? "Your answer" : need === "code" ? "Your code" : "Waiting on you"
          }
        />
        <Text variant="small" tone="inkMuted">
          {ago(item.createdAt, Date.now())}
        </Text>
      </View>
      <Text variant="subheading">{item.title}</Text>
      {line ? (
        <Text variant="small" tone="inkMuted" numberOfLines={3}>
          {line}
        </Text>
      ) : null}
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        {agent ? <PersonChip name={agent} {...(role ? { role } : {})} /> : <View />}
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <Text variant="label" tone="slate">
            {isChange(item) ? "Open" : "Answer"}
          </Text>
          <Icon name="chevronRight" size={16} color={p.slate} />
        </View>
      </View>
    </Card>
  );
}

function SignedToast() {
  const { api } = useApp();
  const desk = useDesk();
  const [now, setNow] = useState(Date.now());
  const s = desk.justSigned;
  useEffect(() => {
    if (!s) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    const end = setTimeout(
      () => desk.setJustSigned(null),
      Math.max(4000, (s.deliverAfter ? new Date(s.deliverAfter).getTime() - Date.now() : 0) + 1500),
    );
    return () => {
      clearInterval(t);
      clearTimeout(end);
    };
  }, [s, desk]);
  if (!s) return null;
  const left = undoLeft({ deliverAfter: s.deliverAfter }, now);
  const text =
    s.decision === "reject"
      ? "Rejected. Nothing changes."
      : left > 0
        ? `Signed. It goes out in ${clock(left)}.`
        : "Signed.";
  const undo = async () => {
    await api.call(routes.portalUndoInbox, { params: { id: s.id }, byPerson: true });
    desk.setJustSigned(null);
    void desk.refresh(true);
  };
  return (
    <View style={{ position: "absolute", left: space["4"], right: space["4"], bottom: space["4"] }}>
      <Toast
        text={text}
        {...(left > 0 && s.decision === "approve"
          ? { action: "Undo", onAction: () => void undo() }
          : {})}
      />
    </View>
  );
}

function LaterSheet({ item, onClose }: { item: DeskItem | null; onClose: () => void }) {
  const { api } = useApp();
  const desk = useDesk();
  const times = snoozeTimes(new Date());
  const set = async (until: Date) => {
    if (!item) return;
    await api.call(routes.portalSnoozeInbox, {
      params: { id: item.id },
      body: { until: until.toISOString() },
      byPerson: true,
    });
    desk.drop(item.id);
    onClose();
    void desk.refresh();
  };
  return (
    <Sheet open={item !== null} onClose={onClose}>
      <Text variant="heading">Not now</Text>
      <Text variant="small" tone="inkMuted">
        It leaves your Desk until then. Its deadline doesn't move.
      </Text>
      <View style={{ gap: space["2"] }}>
        <Button kind="secondary" label="Later today" onPress={() => void set(times.later)} />
        <Button
          kind="secondary"
          label="Tomorrow at 8:00"
          onPress={() => void set(times.tomorrow)}
        />
        <Button kind="secondary" label="Monday at 8:00" onPress={() => void set(times.monday)} />
        <Button kind="ghost" label="Cancel" onPress={onClose} />
      </View>
    </Sheet>
  );
}
