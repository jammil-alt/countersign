// "Is this you signing in?" (docs/plan.md §1.154): a browser waits on this phone to finish a
// sign-in. One Face ID reads the phone's key; with it the phone lists what waits and answers:
// the number on the computer's screen, or "It wasn't me". Works signed in or not, locked or not:
// the key is the proof, and the API checks every call's signature. The key is held only while
// this screen is open.
import { routes, type WaitingSignIn } from "@countersign/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { isApiError } from "../api/client";
import { decodePrivateKey, signSignInDecision, signSignInList } from "../device/signing";
import { useApp } from "../state/app";
import { readPrivateKey } from "../state/store";
import { radius, space, usePalette } from "../theme/theme";
import { Icon } from "../ui/Icon";
import { Button, Card, Note, Screen, Text } from "../ui/kit";

type Stage =
  | { kind: "start"; problem: string | null }
  | { kind: "loading" }
  | { kind: "none" }
  | { kind: "ask"; waiting: WaitingSignIn; problem: string | null }
  | { kind: "sending"; waiting: WaitingSignIn }
  | { kind: "approved"; waiting: WaitingSignIn }
  | { kind: "denied"; waiting: WaitingSignIn; wrongNumber: boolean };

/** "2:41 PM", in the phone's own clock. */
const timeOf = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** What a refusal from the API means to the person. */
function problemText(error: unknown): string {
  if (isApiError(error)) {
    if (error.code === "signature_required")
      return "This phone can't approve sign-ins any more. Set it up again in Settings.";
    if (error.code === "signature_stale")
      return "Your phone's clock is off. Set it to the right time, then try again.";
    if (error.code === "not_waiting")
      return "That sign-in isn't waiting any more. Start again on the computer.";
    if (error.code === "too_many_attempts")
      return "Too many tries. Wait 15 minutes, then try again.";
  }
  return "We couldn't reach Mezonas. Check your connection and try again.";
}

export function SignInApprovalScreen({ onDone }: { onDone: () => void }) {
  const { api, deviceId, userId } = useApp();
  const p = usePalette();
  const [stage, setStage] = useState<Stage>({ kind: "start", problem: null });
  const key = useRef<Uint8Array | null>(null);

  // The key goes when the screen does.
  useEffect(
    () => () => {
      key.current?.fill(0);
      key.current = null;
    },
    [],
  );

  const load = useCallback(async () => {
    if (!deviceId || !userId) {
      setStage({
        kind: "start",
        problem: "This phone isn't set up to approve sign-ins. Sign in and set it up first.",
      });
      return;
    }
    if (!key.current) {
      const hex = await readPrivateKey("Approve a sign-in");
      if (!hex) {
        setStage({ kind: "start", problem: "Face ID didn't finish, so nothing was sent." });
        return;
      }
      key.current = decodePrivateKey(hex);
    }
    setStage({ kind: "loading" });
    try {
      const res = await api.call(routes.mobileSignInApprovals, {
        body: signSignInList({ privateKey: key.current, userId, deviceId, at: new Date() }),
      });
      const [waiting] = res.approvals;
      setStage(waiting ? { kind: "ask", waiting, problem: null } : { kind: "none" });
    } catch (error) {
      setStage({ kind: "start", problem: problemText(error) });
    }
  }, [api, deviceId, userId]);

  // Asked once on its own, as the lock screen does.
  useEffect(() => {
    void load();
  }, [load]);

  const answer = async (waiting: WaitingSignIn, number: number | null) => {
    if (!key.current || !deviceId || !userId) return;
    const decision = number === null ? "deny" : "approve";
    setStage({ kind: "sending", waiting });
    try {
      const res = await api.call(routes.mobileSignInApprovalDecide, {
        params: { id: waiting.id },
        body: signSignInDecision({
          privateKey: key.current,
          approvalId: waiting.id,
          userId,
          deviceId,
          decision,
          number,
          at: new Date(),
        }),
      });
      setStage(
        res.status === "approved"
          ? { kind: "approved", waiting }
          : { kind: "denied", waiting, wrongNumber: decision === "approve" },
      );
    } catch (error) {
      setStage({ kind: "ask", waiting, problem: problemText(error) });
    }
  };

  const where = (w: WaitingSignIn) =>
    [w.browser, w.place, timeOf(w.createdAt)].filter(Boolean).join(" · ");

  return (
    <Screen
      edges={["top", "bottom"]}
      style={{ paddingHorizontal: space["6"], paddingBottom: space["6"] }}
    >
      <View style={{ flex: 1, justifyContent: "center", gap: space["5"] }}>
        {stage.kind === "ask" || stage.kind === "sending" ? (
          <>
            <View style={{ gap: space["2"] }}>
              <Text variant="heading" style={{ fontSize: 26, lineHeight: 32 }}>
                Is this you signing in?
              </Text>
              <Text tone="inkMuted">{where(stage.waiting)}</Text>
            </View>
            <Text>Tap the number on your computer's screen.</Text>
            <View style={{ flexDirection: "row", gap: space["3"] }}>
              {stage.waiting.choices.map((n) => (
                <Pressable
                  key={n}
                  accessibilityRole="button"
                  accessibilityLabel={`${n}`}
                  disabled={stage.kind === "sending"}
                  onPress={() => void answer(stage.waiting, n)}
                  testID={`sign-in-number-${n}`}
                  style={({ pressed }) => ({
                    flex: 1,
                    minHeight: 88,
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: radius.md,
                    borderWidth: 1,
                    borderColor: p.lineStrong,
                    backgroundColor: pressed ? p.surfaceSubtle : p.surface,
                  })}
                >
                  <Text variant="heading" style={{ fontSize: 34, lineHeight: 40 }}>
                    {n}
                  </Text>
                </Pressable>
              ))}
            </View>
            {stage.kind === "ask" && stage.problem ? (
              <Note tone="risk">{stage.problem}</Note>
            ) : null}
          </>
        ) : stage.kind === "approved" ? (
          <Card style={{ padding: space["5"], gap: space["2"] }}>
            <Text variant="heading">You're signed in</Text>
            <Text tone="inkMuted">{where(stage.waiting)}</Text>
          </Card>
        ) : stage.kind === "denied" ? (
          <Card style={{ padding: space["5"], gap: space["2"] }}>
            <Text variant="heading">Sign-in turned down</Text>
            <Text tone="inkMuted">
              {stage.wrongNumber
                ? "That wasn't the number on the screen, so we stopped this sign-in. Start again on the computer."
                : "Nobody gets in with this request. If it wasn't you, change your password and tell your Mezonas lead."}
            </Text>
          </Card>
        ) : stage.kind === "none" ? (
          <View style={{ gap: space["2"] }}>
            <Text variant="heading">No sign-in is waiting</Text>
            <Text tone="inkMuted">
              Start signing in on your computer and choose your phone, then open this again.
            </Text>
          </View>
        ) : stage.kind === "loading" ? (
          <Text tone="inkMuted">Looking for sign-ins waiting on this phone.</Text>
        ) : (
          <View style={{ gap: space["3"] }}>
            <Text variant="heading" style={{ fontSize: 26, lineHeight: 32 }}>
              Approve a sign-in
            </Text>
            <Text tone="inkMuted">
              Confirm it's you with Face ID, then tap the number on your computer's screen.
            </Text>
            {stage.problem ? <Note tone="risk">{stage.problem}</Note> : null}
          </View>
        )}
      </View>
      <View style={{ gap: space["2_5"] }}>
        {stage.kind === "start" ? (
          <Button
            tall
            label="Continue with Face ID"
            icon={<Icon name="faceId" color={p.onSlate} />}
            onPress={() => void load()}
            testID="sign-in-approval-start"
          />
        ) : null}
        {stage.kind === "ask" ? (
          <Button
            kind="secondary"
            label="It wasn't me"
            onPress={() => void answer(stage.waiting, null)}
            testID="sign-in-approval-deny"
          />
        ) : null}
        <Button
          kind="ghost"
          label={stage.kind === "approved" || stage.kind === "denied" ? "Done" : "Not now"}
          onPress={onDone}
          testID="sign-in-approval-close"
        />
      </View>
    </Screen>
  );
}
