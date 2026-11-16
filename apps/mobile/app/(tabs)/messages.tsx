// Messages: the thread with your Mezonas lead. The lead's words in copper (a person); yours on the
// right. Sloan and the agents' threads stay on the web for now.
import { type PortalMessage, routes } from "@countersign/core";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  ScrollView,
  type ScrollViewInstance,
  TextInput,
  View,
} from "react-native";
import type { z } from "zod";
import { useApp } from "../../src/state/app";
import { radius, space, textStyle, usePalette } from "../../src/theme/theme";
import { Button, Eyebrow, Note, Screen, Text } from "../../src/ui/kit";

type Message = z.output<typeof PortalMessage>;

export default function Messages() {
  const { api, me } = useApp();
  const p = usePalette();
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const scroll = useRef<ScrollViewInstance>(null);
  const lead = me?.lead?.name ?? null;

  const load = useCallback(
    async (byPerson = false) => {
      setLoading(true);
      try {
        const { threads } = await api.call(routes.portalThreads, {
          query: { subject: "lead" },
          byPerson,
        });
        const t = threads.find((x) => x.subject === "lead") ?? null;
        setThreadId(t?.id ?? null);
        if (t) {
          const out = await api.call(routes.portalThreadMessages, {
            params: { id: t.id },
            query: { limit: 100 },
          });
          setMessages(out.messages);
          if (t.unread > 0)
            void api.call(routes.portalReadThread, { params: { id: t.id } }).catch(() => undefined);
        }
        setProblem(null);
      } catch {
        setProblem("Your messages didn't load. Pull to try again.");
      } finally {
        setLoading(false);
      }
    },
    [api],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const send = async () => {
    if (!threadId || draft.trim().length === 0) return;
    setSending(true);
    try {
      const out = await api.call(routes.portalPostMessage, {
        params: { id: threadId },
        body: { text: draft.trim() },
        byPerson: true,
      });
      setMessages((m) => [...m, ...out.messages]);
      setDraft("");
      setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 50);
    } catch {
      setProblem("Your message didn't send. Try again.");
    } finally {
      setSending(false);
    }
  };

  return (
    <Screen>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View
          style={{
            paddingHorizontal: space["4"],
            paddingTop: space["5"],
            paddingBottom: space["3"],
            gap: space["1"],
          }}
        >
          <Eyebrow>Messages</Eyebrow>
          <Text variant="heading" style={{ fontSize: 26, lineHeight: 32 }}>
            {lead ? `${lead}, your lead` : "Your Mezonas lead"}
          </Text>
        </View>
        <ScrollView
          ref={scroll}
          contentContainerStyle={{
            paddingHorizontal: space["4"],
            paddingBottom: space["4"],
            gap: space["3"],
          }}
          refreshControl={
            <RefreshControl
              refreshing={loading}
              onRefresh={() => void load(true)}
              tintColor={p.inkMuted}
            />
          }
          onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}
        >
          {problem ? <Note tone="risk">{problem}</Note> : null}
          {!loading && messages.length === 0 && !problem ? (
            <Text tone="inkMuted">
              {lead ? `Write to ${lead}. They answer within a working day.` : "No messages yet."}
            </Text>
          ) : null}
          {messages.map((m) => {
            const mine = m.sender.you;
            return (
              <View
                key={m.id}
                style={{
                  alignSelf: mine ? "flex-end" : "flex-start",
                  maxWidth: "86%",
                  gap: space["1"],
                  padding: space["3"],
                  borderRadius: radius.md,
                  borderWidth: 1,
                  borderColor: mine ? p.line : m.sender.lead ? p.copperTint : p.line,
                  backgroundColor: mine
                    ? p.surface
                    : m.sender.lead
                      ? p.copperTint
                      : p.surfaceSubtle,
                }}
              >
                <Text
                  variant="label"
                  tone={m.sender.lead ? "copper" : "inkMuted"}
                  style={{ fontSize: 12 }}
                >
                  {mine ? "You" : (m.sender.name ?? "Mezonas")}
                </Text>
                <Text>{m.translation?.text ?? m.text}</Text>
              </View>
            );
          })}
        </ScrollView>
        <View
          style={{
            flexDirection: "row",
            gap: space["2"],
            padding: space["3"],
            borderTopWidth: 1,
            borderTopColor: p.line,
            backgroundColor: p.surface,
            alignItems: "flex-end",
          }}
        >
          <TextInput
            value={draft}
            onChangeText={setDraft}
            multiline
            placeholder={lead ? `Message ${lead}` : "Message your lead"}
            placeholderTextColor={p.inkFaint}
            accessibilityLabel="Message"
            style={[
              textStyle("body"),
              {
                flex: 1,
                minHeight: 44,
                maxHeight: 120,
                paddingHorizontal: space["3"],
                paddingVertical: space["2_5"],
                borderWidth: 1,
                borderColor: p.lineStrong,
                borderRadius: radius.sm,
                color: p.ink,
              },
            ]}
          />
          <Button
            label="Send"
            busy={sending}
            disabled={!threadId || draft.trim().length === 0}
            onPress={() => void send()}
          />
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}
