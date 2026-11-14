// One Desk item: what changes, before and after; why it needs you; then the decision. A change is
// signed (or rejected) with Face ID or a fingerprint: the phone's key signs the item as shown, and
// the API checks the signature before it records the decision (docs/plan.md §1.99). Questions are
// answered here; a release code is entered here.
import { pickLocalized, routes } from "@countersign/core";
import * as LocalAuthentication from "expo-local-authentication";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";
import { isApiError } from "../../src/api/client";
import {
  type ChangeField,
  type ChangeValue,
  changeHeading,
  changeModel,
  formatMoney,
} from "../../src/desk/change";
import {
  type DeskItem,
  isChange,
  needOf,
  quickAnswers,
  signedInput,
  whyLines,
} from "../../src/desk/model";
import { decodePrivateKey, signDecision } from "../../src/device/signing";
import { useApp } from "../../src/state/app";
import { useDesk } from "../../src/state/desk";
import { readPrivateKey } from "../../src/state/store";
import { radius, space, textStyle, usePalette } from "../../src/theme/theme";
import { Icon } from "../../src/ui/Icon";
import { Button, Card, Eyebrow, Note, Pair, Pill, Screen, Sheet, Text } from "../../src/ui/kit";

type Decision = "approve" | "reject";

/** Back to the Desk, also when the item was opened straight from a notification. */
function leave() {
  if (router.canGoBack()) router.back();
  else router.replace("/(tabs)");
}

export default function ItemScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const desk = useDesk();
  const { me } = useApp();
  const p = usePalette();
  const item = id ? desk.find(id) : undefined;
  const [deciding, setDeciding] = useState<Decision | null>(null);
  const locale = me?.language.effective ?? "en";

  if (!item) {
    return (
      <Screen>
        <Back />
        <View style={{ padding: space["4"], gap: space["3"] }}>
          <Text variant="subheading">This item isn't waiting any more</Text>
          <Text tone="inkMuted">Someone may have answered it, or it was set aside.</Text>
          <Button kind="secondary" label="Back to your Desk" onPress={leave} />
        </View>
      </Screen>
    );
  }

  const need = needOf(item);
  const why = whyLines(item, locale);
  const service = item.service?.name ?? null;
  const index = desk.items.findIndex((i) => i.id === item.id);
  const description =
    item.display?.tool?.description !== undefined
      ? pickLocalized(item.display.tool.description, locale)
      : null;

  return (
    <Screen>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Back />
        {desk.items.length > 1 ? (
          <Text variant="small" tone="inkMuted" style={{ paddingRight: space["4"] }}>
            {`${index + 1} of ${desk.items.length}`}
          </Text>
        ) : null}
      </View>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: space["4"],
          paddingBottom: space["6"],
          gap: space["4"],
        }}
      >
        <View style={{ gap: space["2_5"] }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space["2_5"] }}>
            <Pill
              tone="warning"
              label={
                need === "answer" ? "Your answer" : need === "code" ? "Your code" : "Waiting on you"
              }
            />
            {service ? <Eyebrow>{service}</Eyebrow> : null}
          </View>
          <Text variant="heading" style={{ fontSize: 24, lineHeight: 30 }}>
            {item.title}
          </Text>
          {description ? <Text tone="inkMuted">{description}</Text> : null}
        </View>

        {isChange(item) ? <Change item={item} locale={locale} /> : null}
        {need === "answer" ? <Question item={item} locale={locale} /> : null}
        {need === "code" ? <ReleaseCode item={item} /> : null}

        {why.length > 0 ? (
          <Card style={{ flexDirection: "row", gap: space["2_5"], padding: space["3_5"] }}>
            <Icon name="info" color={p.inkMuted} />
            <View style={{ flex: 1, gap: space["1"] }}>
              <Text variant="label" style={{ fontSize: 14 }}>
                Why it needs you
              </Text>
              {why.map((w) => (
                <Text key={w} variant="small" tone="inkMuted">
                  {w}
                </Text>
              ))}
            </View>
          </Card>
        ) : null}
      </ScrollView>

      {need === "sign" || need === "request" || need === "done" ? (
        <View
          style={{
            flexDirection: "row",
            gap: space["2"],
            padding: space["3"],
            paddingHorizontal: space["4"],
            borderTopWidth: 1,
            borderTopColor: p.line,
            backgroundColor: p.surface,
          }}
        >
          {need === "done" ? (
            <Button tall label="Done" style={{ flex: 1 }} onPress={() => setDeciding("approve")} />
          ) : (
            <>
              <Button
                tall
                kind="secondary"
                label="Reject"
                style={{ flex: 1 }}
                onPress={() => setDeciding("reject")}
              />
              <Button
                tall
                label="Sign"
                style={{ flex: 2 }}
                onPress={() => setDeciding("approve")}
                testID="sign"
              />
            </>
          )}
        </View>
      ) : null}

      <DecideSheet item={item} decision={deciding} onClose={() => setDeciding(null)} />
    </Screen>
  );
}

function Back() {
  const p = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Back to your Desk"
      onPress={leave}
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
        Your Desk
      </Text>
    </Pressable>
  );
}

// ── What changes ────────────────────────────────────────────────────────────────────────────────

function Change({
  item,
  locale,
}: {
  item: DeskItem;
  locale: "en" | "es" | "fr" | "pt-BR" | "it" | "de";
}) {
  const p = usePalette();
  const before = item.payload.before;
  const input = signedInput(item.payload);
  const model = changeModel(item.display?.tool ?? null, before, input, locale, {
    names: item.display?.names,
  });
  const totals = model.fields.flatMap((f) =>
    f.after.type === "lines" && f.after.total ? [Number(f.after.total)] : [],
  );
  // A total the lines already add up to is shown once, under the lines.
  const changed = model.fields.filter(
    (f) =>
      (model.create || f.changed) &&
      !(f.after.type === "money" && totals.includes(Number(f.after.amount))),
  );
  if (changed.length === 0) return null;
  const toolId = typeof item.payload.tool === "string" ? item.payload.tool : "";
  const heading = changeHeading(item.display ?? null, toolId, before, input, locale);
  return (
    <View style={{ gap: space["3"] }}>
      <View style={{ flexDirection: "row", gap: space["2"] }}>
        <Side
          label="Before"
          text={model.create ? `Not in ${heading.connector} yet.` : "As it is now."}
          muted
        />
        <Side
          label="After"
          text={
            model.create ? `Created in ${heading.connector}.` : `Updated in ${heading.connector}.`
          }
        />
      </View>
      {changed.map((f) =>
        f.list ? (
          <ListField key={f.key} field={f} />
        ) : (
          <View
            key={f.key}
            style={{
              borderWidth: 1,
              borderColor: p.line,
              borderRadius: radius.md,
              backgroundColor: p.surface,
            }}
          >
            <Pair
              k={f.label}
              v={
                model.create || f.now.type === "none"
                  ? text(f.after)
                  : `${text(f.now)} → ${text(f.after)}`
              }
              last
              tabular={f.after.type === "money" || f.after.type === "number"}
            />
          </View>
        ),
      )}
    </View>
  );
}

function Side({ label, text: body, muted }: { label: string; text: string; muted?: boolean }) {
  const p = usePalette();
  return (
    <View
      style={{
        flex: 1,
        gap: space["1_5"],
        padding: space["3"],
        borderRadius: radius.sm,
        backgroundColor: muted ? p.surfaceSubtle : p.surface,
        borderWidth: muted ? 0 : 1,
        borderColor: p.line,
      }}
    >
      <Eyebrow>{label}</Eyebrow>
      <Text variant="small">{body}</Text>
    </View>
  );
}

function ListField({ field }: { field: ChangeField }) {
  const p = usePalette();
  const v = field.after;
  if (v.type !== "lines" && v.type !== "files" && v.type !== "table") return null;
  const rows =
    v.type === "table"
      ? v.rows.map((r, i) => ({
          key: String(i),
          title: r[0] ?? "",
          meta: r.slice(1).join(" · "),
          amount: null,
        }))
      : v.items.map((l, i) => ({
          key: String(i),
          title: l.description ?? l.ref ?? "Line",
          meta:
            v.type === "lines" && l.qty && l.unitPrice
              ? `${l.qty} × ${formatMoney(l.unitPrice, v.currency)}`
              : (l.ref ?? ""),
          amount: v.type === "lines" && l.amount ? formatMoney(l.amount, v.currency) : null,
        }));
  return (
    <Card>
      <View
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          paddingHorizontal: space["4"],
          paddingVertical: space["3"],
          borderBottomWidth: 1,
          borderBottomColor: p.line,
        }}
      >
        <Eyebrow>{`${field.label} · ${rows.length}`}</Eyebrow>
      </View>
      {rows.map((r) => (
        <View
          key={r.key}
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            gap: space["3"],
            paddingHorizontal: space["4"],
            paddingVertical: space["3"],
            borderBottomWidth: 1,
            borderBottomColor: p.line,
          }}
        >
          <View style={{ flex: 1, gap: 2 }}>
            <Text variant="label" style={{ fontSize: 14, lineHeight: 20 }}>
              {r.title}
            </Text>
            {r.meta ? (
              <Text
                variant="small"
                tone="inkMuted"
                tabular
                style={{ fontSize: 12, lineHeight: 16 }}
              >
                {r.meta}
              </Text>
            ) : null}
          </View>
          {r.amount ? (
            <Text variant="label" tabular style={{ fontSize: 14, lineHeight: 20 }}>
              {r.amount}
            </Text>
          ) : null}
        </View>
      ))}
      {v.type === "lines" && v.total ? (
        <View
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            paddingHorizontal: space["4"],
            paddingVertical: space["3"],
            backgroundColor: p.surfaceSubtle,
          }}
        >
          <Text variant="subheading" style={{ fontSize: 14, lineHeight: 20 }}>
            Total
          </Text>
          <Text variant="subheading" tabular style={{ fontSize: 14, lineHeight: 20 }}>
            {formatMoney(v.total, v.currency)}
          </Text>
        </View>
      ) : null}
    </Card>
  );
}

function text(v: ChangeValue): string {
  switch (v.type) {
    case "none":
      return "—";
    case "text":
      return v.text;
    case "money":
      return formatMoney(v.amount, v.currency);
    case "number":
      return v.value;
    case "date": {
      const d = new Date(v.value);
      return Number.isNaN(d.getTime()) ? v.value : d.toLocaleDateString();
    }
    case "lines":
      return v.total ? formatMoney(v.total, v.currency) : `${v.items.length} lines`;
    case "files":
      return `${v.items.length} files`;
    case "table":
      return `${v.rows.length} rows`;
  }
}

/** The change's total, for the Face ID sheet: the first money field after the change. */
function totalOf(
  item: DeskItem,
  locale: "en" | "es" | "fr" | "pt-BR" | "it" | "de",
): string | null {
  const model = changeModel(
    item.display?.tool ?? null,
    item.payload.before,
    signedInput(item.payload),
    locale,
  );
  for (const f of model.fields) {
    if (f.after.type === "money") return formatMoney(f.after.amount, f.after.currency);
  }
  for (const f of model.fields) {
    if (f.after.type === "lines" && f.after.total)
      return formatMoney(f.after.total, f.after.currency);
  }
  return null;
}

// ── Questions and release codes ─────────────────────────────────────────────────────────────────

function Question({
  item,
  locale,
}: {
  item: DeskItem;
  locale: "en" | "es" | "fr" | "pt-BR" | "it" | "de";
}) {
  const { api } = useApp();
  const desk = useDesk();
  const p = usePalette();
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const choices = quickAnswers(item.payload, locale);
  const question = typeof item.payload.question === "string" ? item.payload.question : null;

  const send = async (value: string) => {
    setBusy(value);
    setProblem(null);
    try {
      await api.call(routes.portalResolveInbox, {
        params: { id: item.id },
        body: { decision: "approve", answer: value },
        byPerson: true,
      });
      desk.drop(item.id);
      void desk.refresh();
      leave();
    } catch {
      setProblem("Your answer didn't go through. Try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <View style={{ gap: space["2_5"] }}>
      {question ? <Text>{question}</Text> : null}
      {choices ? (
        choices.map((c) => (
          <Button
            key={c.value}
            kind="secondary"
            label={c.label}
            busy={busy === c.value}
            disabled={busy !== null}
            onPress={() => void send(c.value)}
          />
        ))
      ) : (
        <>
          <TextInput
            value={answer}
            onChangeText={setAnswer}
            multiline
            placeholder="Your answer"
            placeholderTextColor={p.inkFaint}
            accessibilityLabel="Your answer"
            style={[
              textStyle("body"),
              {
                minHeight: 96,
                padding: space["3"],
                borderWidth: 1,
                borderColor: p.lineStrong,
                borderRadius: radius.sm,
                color: p.ink,
                backgroundColor: p.surface,
                textAlignVertical: "top",
              },
            ]}
          />
          <Button
            label="Send your answer"
            busy={busy !== null}
            disabled={answer.trim().length === 0}
            onPress={() => void send(answer.trim())}
          />
        </>
      )}
      {problem ? <Note tone="risk">{problem}</Note> : null}
    </View>
  );
}

function ReleaseCode({ item }: { item: DeskItem }) {
  const { api } = useApp();
  const desk = useDesk();
  const p = usePalette();
  const [request, setRequest] = useState<{
    agentName: string;
    toolName: string;
    sentTo: string;
    triesLeft: number;
    resendsLeft: number;
    mine: boolean;
  } | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void api
      .call(routes.portalReleaseRequest, { params: { id: item.id } })
      .then((r) => setRequest(r.request))
      .catch(() => setMessage("We couldn't load this request. Pull your Desk to try again."));
  }, [api, item.id]);

  const enter = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await api.call(routes.portalEnterReleaseCode, {
        params: { id: item.id },
        body: { code },
        byPerson: true,
      });
      setRequest(r.request);
      if (r.result === "released") {
        desk.drop(item.id);
        void desk.refresh();
        leave();
      } else if (r.result === "wrong") {
        setMessage(`That code didn't match. ${r.request.triesLeft} tries left.`);
      } else {
        setMessage("This code has ended. Ask for a new one.");
      }
    } catch (e) {
      setMessage(
        isApiError(e) && e.code === "invalid_request"
          ? "A code is six digits."
          : "That didn't go through. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    const r = await api.call(routes.portalResendReleaseCode, {
      params: { id: item.id },
      byPerson: true,
    });
    setRequest(r.request);
    setMessage(`We sent a new code to ${r.request.sentTo}.`);
  };

  if (!request) return message ? <Note tone="risk">{message}</Note> : null;
  if (!request.mine) {
    return <Note>{`The code went to ${request.sentTo}. Only that person can enter it.`}</Note>;
  }
  return (
    <View style={{ gap: space["2_5"] }}>
      <Text>{`${request.agentName} needs your release to use ${request.toolName}. We sent a code to ${request.sentTo}.`}</Text>
      <TextInput
        value={code}
        onChangeText={setCode}
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        autoComplete="one-time-code"
        maxLength={7}
        placeholder="6-digit code"
        placeholderTextColor={p.inkFaint}
        accessibilityLabel="Code"
        style={[
          textStyle("heading"),
          {
            minHeight: 52,
            paddingHorizontal: space["3"],
            borderWidth: 1,
            borderColor: p.lineStrong,
            borderRadius: radius.sm,
            color: p.ink,
            backgroundColor: p.surface,
            letterSpacing: 4,
          },
        ]}
      />
      <Button
        label="Release"
        busy={busy}
        disabled={code.replace(/\D/g, "").length !== 6}
        onPress={() => void enter()}
      />
      {request.resendsLeft > 0 ? (
        <Button kind="ghost" label="Send a new code" onPress={() => void resend()} />
      ) : null}
      {message ? <Note>{message}</Note> : null}
    </View>
  );
}

// ── Signing ─────────────────────────────────────────────────────────────────────────────────────

function DecideSheet({
  item,
  decision,
  onClose,
}: {
  item: DeskItem;
  decision: Decision | null;
  onClose: () => void;
}) {
  const { api, deviceId, me } = useApp();
  const desk = useDesk();
  const p = usePalette();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const locale = me?.language.effective ?? "en";
  const total = isChange(item) ? totalOf(item, locale) : null;
  const toolId = typeof item.payload.tool === "string" ? item.payload.tool : "";
  const heading = isChange(item)
    ? changeHeading(
        item.display ?? null,
        toolId,
        item.payload.before,
        signedInput(item.payload),
        locale,
      )
    : null;
  const approve = decision === "approve";

  const go = async () => {
    if (!decision) return;
    setBusy(true);
    setProblem(null);
    try {
      const prompt = approve ? "Sign with Face ID" : "Reject with Face ID";
      let deviceSignature: ReturnType<typeof signDecision> | undefined;
      if (deviceId) {
        const key = await readPrivateKey(prompt);
        if (!key) {
          setProblem("Face ID didn't finish, so nothing was signed.");
          return;
        }
        deviceSignature = signDecision({
          privateKey: decodePrivateKey(key),
          deviceId,
          item,
          decision,
          at: new Date(),
        });
      } else {
        // A phone not set up for signing still asks for Face ID before it decides.
        const ok = await LocalAuthentication.authenticateAsync({ promptMessage: prompt });
        if (!ok.success) {
          setProblem("Face ID didn't finish, so nothing was signed.");
          return;
        }
      }
      const out = await api.call(routes.portalResolveInbox, {
        params: { id: item.id },
        body: { decision, ...(deviceSignature ? { deviceSignature } : {}) },
        byPerson: true,
      });
      desk.drop(item.id);
      desk.setJustSigned({
        id: item.id,
        title: item.title,
        decision,
        deliverAfter: out.item.deliverAfter ?? null,
      });
      onClose();
      leave();
      void desk.refresh();
    } catch (e) {
      setProblem(
        isApiError(e) && e.status === 409
          ? "This item changed since you opened it. Look at it again before you sign."
          : isApiError(e) && e.code === "signature_stale"
            ? "Your phone's clock looks off, so the signature was too old. Check the time and sign again."
            : isApiError(e) && (e.code === "signature_invalid" || e.code === "device_unknown")
              ? "This phone's signature wasn't accepted. Set up signing again in Settings."
              : "That didn't go through. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={decision !== null} onClose={onClose}>
      <View style={{ gap: space["1_5"] }}>
        <Text variant="heading">{approve ? "Sign with Face ID" : "Reject this change"}</Text>
        <Text variant="small" tone="inkMuted" style={{ fontSize: 14, lineHeight: 21 }}>
          {approve
            ? "Your signature covers this change exactly as shown. If anything changes, we ask you again."
            : "Nothing is written. The agent is told you said no."}
        </Text>
      </View>
      <View style={{ borderWidth: 1, borderColor: p.line, borderRadius: radius.md }}>
        <Pair k="What" v={heading?.title ?? item.title} />
        {total ? <Pair k="Total" v={total} tabular /> : null}
        <Pair k="Changes" v={heading ? heading.connector : "Your answer only"} last />
      </View>
      {problem ? <Note tone="risk">{problem}</Note> : null}
      <View style={{ gap: space["2"] }}>
        <Button
          tall
          label={approve ? "Sign with Face ID" : "Reject with Face ID"}
          icon={<Icon name="faceId" color={p.onSlate} />}
          busy={busy}
          onPress={() => void go()}
          testID="confirm-sign"
        />
        <Button kind="ghost" label="Cancel" onPress={onClose} />
      </View>
    </Sheet>
  );
}
