// The browser session's redactor hides real secrets only (PLATFORM_QA INPUT-9): the password, session
// and auth cookies, and a code while the sign-in that uses it is under way. A site's preference
// cookie or a spent short code never rewrites the page's own words, dates or amounts.

import { describe, expect, it } from "vitest";
import { ORIGIN, PROFILE, setUp } from "./browser.test-helper";
import { Redactor } from "./session";

const cookie = (name: string, value: string, httpOnly: boolean) => ({ name, value, httpOnly });

describe("browser redactor: page data a client's agent reads", () => {
  it("(PLATFORM_QA INPUT-9) a site's preference cookie doesn't hide the same word in the page's data", () => {
    const redact = new Redactor();
    redact.add("S3cret-pass!word", 1);
    // Cookies a supplier portal sets after sign-in: the session, and two UI preferences.
    redact.cookie(cookie("sid", "sess-9f8a7b6c5d4e3f2a", true));
    redact.cookie(cookie("view", "invoices", false));
    redact.cookie(cookie("filter", "Delivered", false));
    const page = {
      text: "Invoices: 3 open invoices. Order 5521 Delivered on 2026-11-18.",
      tables: [
        { headers: ["Order", "Status", "Total"], rows: [["5521", "Delivered", "1,250.00"]] },
      ],
    };
    expect(redact.deep(page)).toEqual(page);
  });

  it("(PLATFORM_QA INPUT-9) still hides session and auth cookies and the password wherever they show", () => {
    const redact = new Redactor();
    redact.add("S3cret-pass!word", 1);
    redact.cookie(cookie("sid", "sess-9f8a7b6c5d4e3f2a", true));
    // A token a page's script can read (not httpOnly) is still a secret by its look.
    redact.cookie(cookie("auth", "eyJhbGciOiJIUzI1NiJ9x7Q2", false));
    const text = redact.text(
      "pw S3cret-pass!word sid=sess-9f8a7b6c5d4e3f2a; token eyJhbGciOiJIUzI1NiJ9x7Q2 end",
    );
    expect(text).toBe("pw [hidden] sid=[hidden]; token [hidden] end");
  });

  it("(PLATFORM_QA INPUT-9) a short second-factor code doesn't rewrite the page once it is spent", async () => {
    const s = setUp({
      profile: {
        login: {
          ...PROFILE.login,
          secondFactor: {
            kind: "email",
            sender: "@supplier.test",
            pattern: "code is (\\d{4})",
            codeField: "#code",
            codeButton: "#verify",
          },
        },
      },
    });
    await s.identify();
    // A 4-digit code that is also part of an invoice number on the page.
    s.portal.options.code = "1001";
    const r = await s.read(`${ORIGIN}/invoices`);
    const out = r.output as { text: string; tables: { rows: string[][] }[] };
    expect(out.text).toContain("INV-1001 120.00 open");
    expect(out.tables[0]?.rows[0]?.[0]).toBe("INV-1001");
  });
});
