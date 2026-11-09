// The patch deadlines (scripts/vuln-sla.mjs): severity, due dates, which issues open and close.
import assert from "node:assert/strict";
import { test } from "node:test";
import { dueOf, plan, severityOf, summaryMarkdown } from "./vuln-sla.mjs";

const NOW = Date.parse("2026-11-20T00:00:00Z");

const dependabot = (number, severity, created, extra = {}) => ({
  kind: "dependabot",
  number,
  state: "open",
  created_at: created,
  html_url: `https://github.test/dependabot/${number}`,
  security_advisory: { severity, summary: "Prototype pollution" },
  security_vulnerability: { package: { name: "lodash" }, severity },
  ...extra,
});
const scanning = (number, rule, created, extra = {}) => ({
  kind: "code_scanning",
  number,
  state: "open",
  created_at: created,
  html_url: `https://github.test/code-scanning/${number}`,
  rule,
  tool: { name: "CodeQL" },
  most_recent_instance: { location: { path: "apps/api/src/x.ts" } },
  ...extra,
});

test("severity: Dependabot's, code scanning's security level, else the rule's", () => {
  assert.equal(severityOf(dependabot(1, "critical", "2026-11-01T00:00:00Z")), "critical");
  assert.equal(
    severityOf(scanning(1, { security_severity_level: "high" }, "2026-11-01T00:00:00Z")),
    "high",
  );
  assert.equal(severityOf(scanning(2, { severity: "warning" }, "2026-11-01T00:00:00Z")), "medium");
  assert.equal(severityOf(scanning(3, { severity: "note" }, "2026-11-01T00:00:00Z")), "low");
  assert.equal(severityOf(scanning(4, {}, "2026-11-01T00:00:00Z")), "low");
});

test("due: critical 7 days, high 30, medium 90, low 180", () => {
  const at = "2026-11-01T00:00:00Z";
  const days = (a) => (dueOf(a) - Date.parse(at)) / 86_400_000;
  assert.equal(days(dependabot(1, "critical", at)), 7);
  assert.equal(days(dependabot(2, "high", at)), 30);
  assert.equal(days(dependabot(3, "medium", at)), 90);
  assert.equal(days(dependabot(4, "low", at)), 180);
});

test("opens one issue per open alert without one, titled with its deadline", () => {
  const p = plan({
    alerts: [dependabot(5, "critical", "2026-11-10T00:00:00Z")],
    issues: [],
    now: NOW,
  });
  assert.equal(p.open.length, 1);
  assert.equal(p.open[0].title, "[critical, due 2026-11-17] lodash: Prototype pollution");
  assert.match(p.open[0].body, /<!-- vuln-sla:dependabot#5 -->/);
  assert.deepEqual(
    p.rows.map((r) => [r.key, r.due, r.overdue]),
    [["dependabot#5", "2026-11-17", true]],
  );
});

test("leaves an alert that has its issue alone, and closes the issue once it's fixed", () => {
  const issue = (n, key) => ({ number: n, body: `<!-- vuln-sla:${key} -->\nx` });
  const p = plan({
    alerts: [
      scanning(7, { security_severity_level: "medium" }, "2026-11-01T00:00:00Z"),
      dependabot(8, "high", "2026-10-01T00:00:00Z", {
        state: "fixed",
        fixed_at: "2026-11-15T00:00:00Z",
      }),
      dependabot(9, "low", "2026-11-01T00:00:00Z", {
        state: "dismissed",
        dismissed_at: "2026-11-02T00:00:00Z",
      }),
    ],
    issues: [
      issue(100, "code_scanning#7"),
      issue(101, "dependabot#8"),
      issue(102, "dependabot#99"),
    ],
    now: NOW,
  });
  assert.deepEqual(p.open, []);
  assert.deepEqual(
    p.close.map((c) => c.number),
    [101, 102],
  );
  assert.match(
    p.close[0].comment,
    /fixed \(2026-11-15\): 45 days after it was found, past the 30-day deadline for high/,
  );
  assert.match(p.close[1].comment, /no longer exists/);
});

test("the summary says when Dependabot wasn't read, and counts what's overdue", () => {
  const p = plan({
    alerts: [dependabot(5, "critical", "2026-11-10T00:00:00Z")],
    issues: [],
    now: NOW,
  });
  const md = summaryMarkdown({ rows: p.rows, dependabot: false });
  assert.match(md, /ALERTS_TOKEN/);
  assert.match(md, /1 open, 1 overdue/);
  assert.match(summaryMarkdown({ rows: [], dependabot: true }), /No open alerts/);
});
