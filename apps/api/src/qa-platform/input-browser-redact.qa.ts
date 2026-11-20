// INPUT lens: the browser connector's redactor (packages/connectors/src/browser/session.ts).
// `withBrowserSession` adds the password (any length), each second-factor code (any length) and
// every cookie value of 8 characters or more (`redact.add(c.value, 8)` after sign-in), then runs
// every page read through `redact.text` / `redact.deep` (readText, readTables, controls, results).
// Driven here on the class itself, with the values the session adds.

import { describe, expect, it } from "vitest";
import { Redactor } from "../../../../packages/connectors/src/browser/session";

describe("browser redactor: page data a client's agent reads", () => {
  it("INPUT-9: a site's preference cookie doesn't hide the same word in the page's data", () => {
    const redact = new Redactor();
    redact.add("S3cret-pass!word", 1);
    // Cookies a supplier portal sets after sign-in: the session, and two UI preferences.
    for (const value of ["sess-9f8a7b6c5d4e3f2a", "invoices", "Delivered"]) redact.add(value, 8);
    const page = {
      text: "Invoices: 3 open invoices. Order 5521 Delivered on 2026-11-18.",
      tables: [
        {
          headers: ["Order", "Status", "Total"],
          rows: [["5521", "Delivered", "1,250.00"]],
        },
      ],
    };
    // Expected: the page's words as the page shows them (only real secrets hidden). Today every
    // "invoices" and "Delivered" reads "[hidden]", so a delivery status the agent records is lost.
    expect(redact.deep(page)).toEqual(page);
  });

  it("INPUT-9: a short second-factor code doesn't rewrite dates and amounts on the page", () => {
    const redact = new Redactor();
    // `onCode: (code) => redact.add(code, 1)`: a 4-digit code some portals send.
    redact.add("2026", 1);
    const text = "Statement 2026-10 total 12,026.40, due 2026-11-30";
    // Expected: the statement as written (the code was spent at sign-in). Today:
    // "Statement [hidden]-10 total 12,026.40, due [hidden]-11-30".
    expect(redact.text(text)).toBe(text);
  });
});
