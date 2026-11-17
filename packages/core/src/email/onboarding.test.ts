import { describe, expect, it } from "vitest";
import { LOCALES, type Locale } from "../i18n/locale";
import { ONBOARDING_WORDS } from "../i18n/onboarding";
import {
  dedupeKeys,
  intakePersonOfKey,
  isOnboardingNotificationKind,
  NOTIFICATION_KINDS,
  ONBOARDING_NOTIFICATION_KINDS,
} from "../notify/notify";
import { EMAIL_LOGO_PATH, EMAIL_THEME, renderBrandedEmail } from "./layout";
import {
  type InviteEmailInput,
  intakeSummaryLine,
  renderColleagueEmail,
  renderInviteEmail,
  renderMoreQuestionsEmail,
} from "./onboarding";

const ORIGIN = "https://app.mezonas.com";
const LINK = `${ORIGIN}/start/abc.def`;
const EXPIRES = new Date("2026-12-01T12:00:00Z");

function invite(over: Partial<InviteEmailInput> = {}): InviteEmailInput {
  return {
    locale: "en",
    client: "Acme Supply",
    to: { name: "Dana Ruiz", email: "dana@acme.example" },
    lead: { name: "Jammil Ade", photoUrl: null },
    link: LINK,
    expiresAt: EXPIRES,
    origin: ORIGIN,
    note: "Dana, good to talk today.\nHere is the short list we spoke about.",
    summary: { general: true, areas: ["purchasing"], agents: 2, minutes: 15 },
    ...over,
  };
}

describe("the branded layout", () => {
  it("hosts the logo as a PNG with the app, and draws borders, not shadows", () => {
    const out = renderBrandedEmail({
      locale: "en",
      subject: "Hello",
      from: { name: "Mezonas", photoUrl: null },
      blocks: [{ kind: "paragraph", text: "x" }],
      origin: `${ORIGIN}/`,
    });
    expect(out.html).toContain(`src="${ORIGIN}${EMAIL_LOGO_PATH}"`);
    expect(EMAIL_LOGO_PATH).toMatch(/\.png$/);
    expect(out.html).not.toMatch(/box-shadow/);
    expect(out.html).not.toMatch(/\.svg/);
    expect(out.html).toContain('name="color-scheme" content="light dark"');
    expect(out.html).toContain("prefers-color-scheme: dark");
    expect(out.html).toContain(EMAIL_THEME.paper.dark);
  });

  it("escapes every word and refuses links that aren't https", () => {
    const out = renderBrandedEmail({
      locale: "en",
      subject: "Hi\r\nBcc: x@evil.example",
      from: { name: '<script>alert("x")</script>', photoUrl: "javascript:alert(1)" },
      blocks: [
        { kind: "heading", text: "<b>bold</b>" },
        { kind: "note", text: "a & b <img src=x onerror=1>", from: "Jammil" },
      ],
      origin: ORIGIN,
    });
    expect(out.subject).toBe("Hi Bcc: x@evil.example");
    expect(out.html).not.toContain("<script>");
    expect(out.html).not.toContain("<img src=x");
    expect(out.html).not.toContain("javascript:");
    expect(out.html).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(out.html).toContain("a &amp; b");
    for (const href of ["javascript:alert(1)", "http://evil.example/", "/start/x"]) {
      expect(() =>
        renderBrandedEmail({
          locale: "en",
          subject: "x",
          from: { name: "x", photoUrl: null },
          blocks: [{ kind: "button", label: "Go", href }],
          origin: ORIGIN,
        }),
      ).toThrow(/https|absolute/);
    }
  });
});

describe("the invite", () => {
  it("carries the note, one line on what's in it, one button, who it's from, the expiry", () => {
    const out = renderInviteEmail(invite());
    expect(out.subject).toBe("Getting Acme Supply started with Mezonas");
    expect(out.text).toContain("Hi Dana,");
    expect(out.text).toContain("> Dana, good to talk today.\n> Here is the short list");
    expect(out.text).toContain(
      "What's in it: A few questions about how Acme Supply works and purchasing, and what we need to set up 2 agents; about 15 minutes.",
    );
    expect(out.text).toContain(`Get started: ${LINK}`);
    expect(out.text).toContain("Sent by Jammil Ade at Mezonas.");
    expect(out.text).toContain("We'll never ask for a password by email.");
    expect(out.text).toContain("This link works until December 1, 2026.");
    expect(out.html.match(/<a /g)).toHaveLength(1);
    expect(out.html).toContain(`href="${LINK}"`);
    // Copper for the lead (a person), slate for the button.
    expect(out.html).toContain(EMAIL_THEME.copper.light);
    expect(out.html).toContain(EMAIL_THEME.slate.light);
    // Initials stand in for a photo.
    expect(out.html).toContain(">JA</div>");
  });

  it("leaves the note out when there is none, and uses only https photos", () => {
    const out = renderInviteEmail(
      invite({ note: "  ", lead: { name: "Jammil", photoUrl: "https://cdn.example/j.png" } }),
    );
    expect(out.text).not.toContain("> ");
    expect(out.html).toContain('src="https://cdn.example/j.png"');
    const http = renderInviteEmail(
      invite({ lead: { name: "Jammil", photoUrl: "http://cdn.example/j.png" } }),
    );
    expect(http.html).not.toContain("cdn.example");
  });

  it("is written in each of the six languages", () => {
    const subjects = new Set<string>();
    for (const locale of LOCALES) {
      const out = renderInviteEmail(invite({ locale }));
      const w = ONBOARDING_WORDS[locale];
      subjects.add(out.subject);
      expect(out.subject).toBe(w.inviteSubject("Acme Supply"));
      expect(out.text).toContain(w.getStarted);
      expect(out.text).toContain(w.neverPassword);
      expect(out.html).toContain(`lang="${locale}"`);
      expect(out.text).not.toMatch(/undefined|NaN|\[object/);
    }
    expect(subjects.size).toBe(LOCALES.length);
  });

  it("names the areas in the reader's language", () => {
    const line = (locale: Locale) =>
      intakeSummaryLine(locale, "Acme", {
        general: false,
        areas: ["purchasing", "bookkeeping"],
        agents: 1,
        minutes: 10,
      });
    expect(line("en")).toBe(
      "A few questions about purchasing and bookkeeping, and what we need to set up one agent; about 10 minutes",
    );
    expect(line("es")).toContain("compras y contabilidad");
    expect(line("de")).toContain("Einkauf und Buchhaltung");
    expect(
      intakeSummaryLine("en", "Acme", { general: false, areas: [], agents: 0, minutes: 0 }),
    ).toBe("Your account");
  });
});

describe("the colleague and more-questions emails", () => {
  it("name who asked and what about", () => {
    const out = renderColleagueEmail({
      ...invite(),
      to: { name: "Mark Lee", email: "mark@acme.example" },
      askedBy: { name: "Dana Ruiz" },
      about: ["Bills", "Vendors"],
    });
    expect(out.subject).toBe("Dana Ruiz asked you to help set up Acme Supply on Mezonas");
    expect(out.text).toContain("Hi Mark,");
    expect(out.text).toContain("answer a few questions for Acme Supply: Bills and Vendors.");
    expect(out.text).toContain("Sent by Jammil Ade at Mezonas, for Dana Ruiz.");
  });

  it("list the cards added and the note", () => {
    const out = renderMoreQuestionsEmail({
      ...invite(),
      added: ["Vendor contracts and invoice review"],
    });
    expect(out.subject).toBe("A few more questions for Acme Supply");
    expect(out.text).toContain("Vendor contracts and invoice review");
    expect(out.text).toContain(`Answer them: ${LINK}`);
  });
});

describe("the onboarding notification kinds", () => {
  it("are their own kinds, keyed by intake person", () => {
    for (const k of ONBOARDING_NOTIFICATION_KINDS) {
      expect(isOnboardingNotificationKind(k)).toBe(true);
      expect((NOTIFICATION_KINDS as readonly string[]).includes(k)).toBe(false);
    }
    expect(isOnboardingNotificationKind("items_waiting")).toBe(false);
    const person = "6f1c1e2a-1b2c-4d3e-8f4a-5b6c7d8e9f00";
    expect(intakePersonOfKey(dedupeKeys.intake("intake_invite", person))).toBe(person);
    expect(intakePersonOfKey(dedupeKeys.intake("intake_colleague", person, "abc"))).toBe(person);
    expect(intakePersonOfKey(`items:${person}:2026`)).toBeNull();
  });
});
