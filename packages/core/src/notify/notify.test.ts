import { describe, expect, it } from "vitest";
import { LOCALES } from "../i18n/locale";
import {
  dedupeKeys,
  holdsInQuietHours,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_KINDS,
  type NotificationCounts,
  notificationLink,
  notificationPath,
  personNotifications,
  reconnectDayPrefix,
  retryReason,
  triesOf,
  withPersonNotifications,
} from "./notify";
import { renderNotification } from "./render";

const U = "0190f0a0-0000-7000-8000-000000000001";
const C = "0190f0a0-0000-7000-8000-000000000002";

describe("dedupe keys", () => {
  it("items: one per person and UTC hour", () => {
    const a = dedupeKeys.itemsWaiting(U, new Date("2026-11-06T10:05:00Z"));
    const b = dedupeKeys.itemsWaiting(U, new Date("2026-11-06T10:55:00Z"));
    const c = dedupeKeys.itemsWaiting(U, new Date("2026-11-06T11:00:00Z"));
    expect(a).toBe(`items:${U}:2026-11-06T10`);
    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });

  it("reconnect: per connection, UTC day and person; the day prefix finds them", () => {
    const at = new Date("2026-11-06T23:59:00Z");
    const k = dedupeKeys.reconnect(C, at, U);
    expect(k).toBe(`reconnect:${C}:2026-11-06:${U}`);
    expect(k.startsWith(reconnectDayPrefix(C, at))).toBe(true);
    expect(dedupeKeys.reconnect(C, new Date("2026-11-07T00:00:00Z"), U)).not.toBe(k);
  });

  it("weekly, lead, credits and sign-off keys", () => {
    expect(dedupeKeys.weekly("2026-11-02", U)).toBe(`weekly:2026-11-02:${U}`);
    expect(dedupeKeys.lead(C, U)).toBe(`lead:${C}:${U}`);
    expect(dedupeKeys.credits("2026-11", 2, U)).toBe(`credits:2026-11:2:${U}`);
    expect(dedupeKeys.signoff(C, U)).toBe(`signoff:${C}:${U}`);
  });
});

describe("preferences", () => {
  it("email on and texts off by default; a person's choice is kept apart", () => {
    expect(personNotifications({}, U)).toEqual({ email: true, sms: false });
    const s = withPersonNotifications({ other: 1 }, U, { email: false, sms: true });
    expect(personNotifications(s, U)).toEqual({ email: false, sms: true });
    expect(personNotifications(s, C)).toEqual({ email: true, sms: false });
    expect(s.other).toBe(1);
  });

  it("quiet hours hold texts always and emails only for items waiting", () => {
    expect(holdsInQuietHours("weekly_table", "sms")).toBe(true);
    expect(holdsInQuietHours("items_waiting", "email")).toBe(true);
    expect(holdsInQuietHours("weekly_table", "email")).toBe(false);
    expect(holdsInQuietHours("reconnect", "email")).toBe(false);
  });

  it("retries count in the reason", () => {
    expect(triesOf(null)).toBe(0);
    expect(triesOf(retryReason(2))).toBe(2);
    expect(triesOf("quiet_hours")).toBe(0);
  });
});

describe("rendering", () => {
  const counts: Record<(typeof NOTIFICATION_KINDS)[number], NotificationCounts> = {
    items_waiting: { items: 3 },
    weekly_table: { runs: 12, changes: 4, weekStart: "2026-11-02" },
    reconnect: {},
    credits: { block: 2 },
    lead_message: { messages: 2 },
    signoff: {},
  };

  it("every kind, channel and language: a sentence with the counts and exactly one link", () => {
    for (const kind of NOTIFICATION_KINDS) {
      for (const channel of NOTIFICATION_CHANNELS) {
        for (const locale of LOCALES) {
          const link = notificationLink("https://app.mezonas.test/", notificationPath(kind, { weekStart: "2026-11-02" }));
          const r = renderNotification({ kind, channel, counts: counts[kind], link, locale });
          expect(r.subject.length).toBeGreaterThan(5);
          expect(r.text).toContain(link);
          const urls = r.text.match(/https?:\/\/\S+/g) ?? [];
          expect(urls).toEqual([link]);
          if (channel === "email") {
            expect(r.html).toContain(link);
            expect(r.html).not.toMatch(/<img|<script/i);
            expect((r.html?.match(/href=/g) ?? []).length).toBe(1);
          } else {
            expect(r.html).toBeUndefined();
            expect(r.text.length).toBeLessThanOrEqual(320);
          }
        }
      }
    }
  });

  it("counts show; no double slash in links", () => {
    const r = renderNotification({
      kind: "items_waiting",
      channel: "email",
      counts: { items: 3 },
      link: notificationLink("https://app.mezonas.test/", "/inbox"),
      locale: "en",
    });
    expect(r.subject).toBe("3 items wait for you in Mezonas");
    expect(r.text).toContain("https://app.mezonas.test/inbox");
    const one = renderNotification({
      kind: "items_waiting",
      channel: "sms",
      counts: { items: 1 },
      link: "https://x.test/inbox",
      locale: "en",
    });
    expect(one.text).toBe("Mezonas: 1 item waits for you in Mezonas. https://x.test/inbox");
  });

  it("the weekly sentence carries runs and changes; credits the block's credits", () => {
    const w = renderNotification({
      kind: "weekly_table",
      channel: "email",
      counts: counts.weekly_table,
      link: "https://x.test/weekly",
      locale: "en",
    });
    expect(w.subject).toBe("Your weekly summary for the week of November 2, 2026");
    expect(w.text).toContain("12 runs done, 4 changes to your tools");
    const c = renderNotification({
      kind: "credits",
      channel: "email",
      counts: { block: 2 },
      link: "https://x.test/settings",
      locale: "de",
    });
    expect(c.subject).toContain("5.000");
  });

  it("lead messages read differently for the client and for the lead", () => {
    const base = {
      kind: "lead_message" as const,
      channel: "email" as const,
      counts: { messages: 1 },
      link: "https://x.test/",
      locale: "en" as const,
    };
    expect(renderNotification(base).subject).toBe("You have a new message from your Mezonas lead");
    expect(renderNotification({ ...base, toLead: true }).subject).toBe(
      "A client sent you a new message",
    );
  });

  it("links are escaped in the HTML part", () => {
    const r = renderNotification({
      kind: "reconnect",
      channel: "email",
      counts: {},
      link: 'https://x.test/connections?a="b"&c=<d>',
      locale: "en",
    });
    expect(r.html).not.toContain('"b"');
    expect(r.html).toContain("&quot;b&quot;&amp;c=&lt;d&gt;");
  });
});
