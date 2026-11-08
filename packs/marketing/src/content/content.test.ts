// The content checks, the claims lint and the renderer: pure, so strings in and findings out.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkGuide, guidePath, publishable, queryInTitle, slugOf } from "./checks";
import { ClaimsList, lintClaims, phrasePattern } from "./claims";
import { renderMarkdown } from "./markdown";

const PATHS = new Set(["/", "/privacy", "/guides/approvals"]);

const LIST = ClaimsList.parse({
  title: "Test list",
  approved: [{ id: "approval-default", text: "Every change waits for approval by default" }],
  conditional: [
    {
      id: "named-product",
      text: "Comparisons that name another product",
      condition: "the owner approves each one",
      phrases: ["Zapier"],
    },
  ],
  never: [
    {
      id: "no-guarantees",
      text: "That an agent never makes a mistake",
      phrases: ["never makes mistakes", "100% accurate"],
    },
  ],
});

const good = {
  title: "How approvals work in Mezonas",
  description:
    "Every change an agent wants to make waits for a person to sign it, with the before and after.",
  body: "## Why sign\n\nA change waits for you. See [our privacy policy](/privacy) and [approvals](/guides/approvals#why).\n",
};

describe("checkGuide", () => {
  it("passes a guide that keeps every rule", () => {
    const c = checkGuide(
      {
        ...good,
        body: "## Why sign\n\nRead [the privacy policy](/privacy) or [the top](#why-sign).",
      },
      { paths: PATHS, claims: LIST },
    );
    expect(c.problems).toEqual([]);
    expect(c.publishable).toBe(true);
    expect(c.words).toBeGreaterThan(5);
    expect(c.rendered.html).toContain('<h2 id="why-sign">Why sign</h2>');
  });

  it("refuses a title over 60 and a description over 155 characters", () => {
    const c = checkGuide(
      { ...good, title: "t".repeat(61), description: "d".repeat(156) },
      { paths: PATHS },
    );
    const codes = c.problems.map((p) => p.code);
    expect(codes).toContain("title_long");
    expect(codes).toContain("description_long");
    expect(c.publishable).toBe(false);
    // Exactly at the limits is fine.
    const ok = checkGuide(
      { ...good, title: "t".repeat(60), description: "d".repeat(155), body: "Words." },
      { paths: PATHS },
    );
    expect(ok.problems.map((p) => p.code)).not.toContain("title_long");
    expect(ok.problems.map((p) => p.code)).not.toContain("description_long");
  });

  it("refuses a missing title, description or body", () => {
    const c = checkGuide({ title: " ", description: "", body: "" }, { paths: PATHS });
    expect(c.problems.map((p) => p.code)).toEqual(
      expect.arrayContaining(["title_missing", "description_missing", "body_missing"]),
    );
  });

  it("refuses a second h1: the title is the page's only one", () => {
    const c = checkGuide({ ...good, body: "# Another top\n\nText." }, { paths: PATHS });
    expect(c.problems.map((p) => p.code)).toContain("second_h1");
  });

  it("refuses internal links that resolve nowhere, and keeps outside https links", () => {
    const c = checkGuide(
      {
        ...good,
        body: "See [pricing](/pricing), [a section](#nowhere) and [docs](https://example.com/x).",
      },
      { paths: PATHS, domain: "mezonas.com" },
    );
    const broken = c.problems.filter((p) => p.code === "link_broken").map((p) => p.match);
    expect(broken).toEqual(["/pricing", "#nowhere"]);
    expect(c.problems.find((p) => p.code === "link_broken")?.message).toBe(
      "No page at /pricing on mezonas.com.",
    );
  });

  it("takes out unsafe links and says so", () => {
    const c = checkGuide({ ...good, body: "Click [here](javascript:alert(1))." }, { paths: PATHS });
    expect(c.problems.map((p) => p.code)).toContain("removed");
    expect(c.rendered.html).not.toContain("javascript");
  });

  it("never lets raw HTML through", () => {
    const c = checkGuide(
      { ...good, body: '<script>alert(1)</script> <img src=x onerror="alert(1)">' },
      { paths: PATHS },
    );
    expect(c.rendered.html).not.toMatch(/<script|<img/);
    expect(c.rendered.html).toContain("&lt;script&gt;");
  });

  it("refuses exclamation marks and 'AI-powered' in any field, whatever the list", () => {
    const c = checkGuide(
      { ...good, title: "Approvals, done right!", body: "Our AI-powered agents. AI powered too." },
      { paths: PATHS },
    );
    const codes = c.problems.map((p) => `${p.field}:${p.code}`);
    expect(codes).toContain("title:claims_exclamation");
    expect(codes).toContain("body:claims_ai_powered");
    expect(publishable(c.problems)).toBe(false);
  });

  it("refuses the list's never phrases and flags its conditions without refusing", () => {
    const c = checkGuide(
      { ...good, body: "Our agents never  makes mistakes. Unlike Zapier, we sign." },
      { paths: PATHS, claims: LIST },
    );
    const never = c.problems.find((p) => p.code === "claims_no-guarantees");
    expect(never?.severity).toBe("refuse");
    expect(never?.match).toBe("never makes mistakes");
    const cond = c.problems.find((p) => p.code === "claims_named-product");
    expect(cond?.severity).toBe("check");
    expect(cond?.message).toBe("Only if: the owner approves each one");
  });
});

describe("the claims lint", () => {
  it("matches whole words, case-blind, never inside another word", () => {
    expect("ZAPIER-like".match(phrasePattern("zapier"))).not.toBeNull();
    expect("Zapiers".match(phrasePattern("zapier"))).toBeNull();
    expect("100% accurate".match(phrasePattern("100% accurate"))).not.toBeNull();
  });

  it("treats a phrase as words, never as a pattern", () => {
    const list = ClaimsList.parse({
      title: "x",
      never: [{ id: "dots", text: "x", phrases: [".* .*"] }],
    });
    expect(lintClaims("anything at all", list)).toEqual([]);
  });

  it("refuses a list with an id used twice", () => {
    const r = ClaimsList.safeParse({
      title: "x",
      approved: [{ id: "a", text: "x" }],
      never: [{ id: "a", text: "y", phrases: [] }],
    });
    expect(r.success).toBe(false);
  });

  it("parses the Mezonas draft the operator loads", () => {
    const raw = JSON.parse(
      readFileSync(
        new URL("../../../../fixtures/marketing/mezonas-claims.json", import.meta.url),
        "utf8",
      ),
    );
    const list = ClaimsList.parse(raw);
    expect(list.status).toBe("draft");
    expect(list.approved.length).toBeGreaterThan(5);
    expect(list.never.length).toBeGreaterThan(3);
    // The site's own words pass the list.
    expect(
      lintClaims(
        "Every change they want to make waits for your approval, unless you choose otherwise.",
        list,
      ),
    ).toEqual([]);
    expect(lintClaims("Our agents are fully autonomous.", list).map((f) => f.severity)).toContain(
      "refuse",
    );
  });
});

describe("addresses and queries", () => {
  it("reads a guide's slug from its path", () => {
    expect(slugOf(guidePath("approval-workflows"))).toBe("approval-workflows");
    expect(slugOf("/guides/Bad_Slug")).toBeNull();
    expect(slugOf("/pricing")).toBeNull();
  });

  it("says whether a query's words are in the title", () => {
    expect(queryInTitle("approval workflow", "The approval workflow, explained")).toBe(true);
    expect(queryInTitle("bill approval", "Approvals")).toBe(false);
  });

  it("renders the subset and gives headings ids", () => {
    const r = renderMarkdown("## One\n\n## One\n\n- a\n- b\n\n> quoted\n\n```\ncode <b>\n```");
    expect(r.headings.map((h) => h.id)).toEqual(["one", "one-2"]);
    expect(r.html).toContain("<ul><li>a</li><li>b</li></ul>");
    expect(r.html).toContain("<pre><code>code &lt;b&gt;</code></pre>");
  });
});
