// Vulnerabilities against their patch deadlines (docs/plaid-plan.md, docs/security.md §7): every
// open Dependabot alert and code-scanning alert (CodeQL, OSV-Scanner) gets one issue labelled
// `vulnerability`, titled with its due date; the issue closes, with how long the fix took, once the
// alert is fixed or dismissed. The job summary is the month's evidence: each open alert, its due
// date and whether it is overdue. Run by `.github/workflows/vulnerability-sla.yml`.
//
// Deadlines from the alert's creation: critical 7 days, high 30, medium 90, low 180 ("as
// scheduled": the next quarterly review at the latest).
//
// Tokens: GITHUB_TOKEN reads code scanning and writes issues. Dependabot alerts need a token with
// "Dependabot alerts: read" (ALERTS_TOKEN, a fine-grained token on this repo); without one they are
// left out and the summary says so.

export const SLA_DAYS = { critical: 7, high: 30, medium: 90, low: 180 };
export const LABEL = "vulnerability";
const DAY = 86_400_000;

/** `critical`, `high`, `medium` or `low` for either kind of alert. */
export function severityOf(alert) {
  if (alert.kind === "dependabot") {
    const s = alert.security_advisory?.severity ?? alert.security_vulnerability?.severity;
    return s in SLA_DAYS ? s : "medium";
  }
  const security = alert.rule?.security_severity_level;
  if (security in SLA_DAYS) return security;
  // A code-quality rule with no security level: CodeQL's error / warning / note.
  return { error: "high", warning: "medium", note: "low" }[alert.rule?.severity] ?? "low";
}

export const keyOf = (alert) => `${alert.kind}#${alert.number}`;
const marker = (key) => `<!-- vuln-sla:${key} -->`;
const keyIn = (body) => /<!-- vuln-sla:([a-z_]+#\d+) -->/.exec(body ?? "")?.[1] ?? null;
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

export function dueOf(alert) {
  return Date.parse(alert.created_at) + SLA_DAYS[severityOf(alert)] * DAY;
}

function summaryOf(alert) {
  if (alert.kind === "dependabot") {
    const pkg = alert.security_vulnerability?.package?.name ?? alert.dependency?.package?.name;
    return `${pkg ?? "a dependency"}: ${alert.security_advisory?.summary ?? "advisory"}`;
  }
  const tool = alert.tool?.name ?? "code scanning";
  const where = alert.most_recent_instance?.location?.path;
  return `${tool} ${alert.rule?.id ?? "rule"}${where ? ` in ${where}` : ""}`;
}

/**
 * What to do, given every alert (open or not) and the open `vulnerability` issues: issues to open,
 * issues to close, and the summary rows. Pure, so it is tested without GitHub.
 */
export function plan({ alerts, issues, now }) {
  const byKey = new Map();
  for (const issue of issues) {
    const key = keyIn(issue.body);
    if (key) byKey.set(key, issue);
  }
  const open = [];
  const close = [];
  const rows = [];
  for (const alert of alerts) {
    const key = keyOf(alert);
    const severity = severityOf(alert);
    const due = dueOf(alert);
    const issue = byKey.get(key);
    if (alert.state === "open") {
      const overdue = now > due;
      rows.push({
        key,
        severity,
        created: ymd(Date.parse(alert.created_at)),
        due: ymd(due),
        overdue,
        url: alert.html_url,
      });
      if (!issue) {
        open.push({
          key,
          title: `[${severity}, due ${ymd(due)}] ${summaryOf(alert)}`.slice(0, 250),
          body: [
            marker(key),
            `${alert.html_url}`,
            "",
            `Severity **${severity}**, found ${ymd(Date.parse(alert.created_at))}: fix within ${SLA_DAYS[severity]} days, by **${ymd(due)}** (the patching policy).`,
            "This issue closes by itself when the alert is fixed or dismissed.",
          ].join("\n"),
        });
      }
    } else if (issue) {
      const ended = Date.parse(
        alert.fixed_at ??
          alert.dismissed_at ??
          alert.auto_dismissed_at ??
          new Date(now).toISOString(),
      );
      const days = Math.max(0, Math.round((ended - Date.parse(alert.created_at)) / DAY));
      const within = ended <= due;
      close.push({
        key,
        number: issue.number,
        comment: `${marker(key)}\nThe alert is ${alert.state.replace("_", " ")} (${ymd(ended)}): ${days} days after it was found, ${within ? "within" : "past"} the ${SLA_DAYS[severity]}-day deadline for ${severity}.`,
      });
    }
  }
  // An issue whose alert is gone from the list (deleted, or the repository's alerts were reset).
  const seen = new Set(alerts.map(keyOf));
  for (const [key, issue] of byKey) {
    if (!seen.has(key)) {
      close.push({
        key,
        number: issue.number,
        comment: `${marker(key)}\nThe alert no longer exists.`,
      });
    }
  }
  rows.sort((a, b) => a.due.localeCompare(b.due));
  return { open, close, rows };
}

export function summaryMarkdown({ rows, dependabot }) {
  const lines = ["## Vulnerabilities and their deadlines", ""];
  if (!dependabot) {
    lines.push(
      "Dependabot alerts were not read: set the `ALERTS_TOKEN` secret (Dependabot alerts: read).",
      "",
    );
  }
  if (rows.length === 0) return [...lines, "No open alerts."].join("\n");
  lines.push("| Alert | Severity | Found | Due | |", "|---|---|---|---|---|");
  for (const r of rows) {
    lines.push(
      `| [${r.key}](${r.url}) | ${r.severity} | ${r.created} | ${r.due} | ${r.overdue ? "**overdue**" : "on time"} |`,
    );
  }
  const overdue = rows.filter((r) => r.overdue).length;
  lines.push("", `${rows.length} open, ${overdue} overdue.`);
  return lines.join("\n");
}

// ── GitHub ──────────────────────────────────────────────────────────────────────────────────────

async function github(token, path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
  if (!res.ok) {
    const error = new Error(`${init.method ?? "GET"} ${path}: ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return { json: res.status === 204 ? null : await res.json(), link: res.headers.get("link") };
}

async function all(token, path) {
  const out = [];
  let next = `${path}${path.includes("?") ? "&" : "?"}per_page=100`;
  while (next) {
    const { json, link } = await github(token, next);
    out.push(...json);
    const m = /<https:\/\/api\.github\.com([^>]+)>;\s*rel="next"/.exec(link ?? "");
    next = m ? m[1] : null;
  }
  return out;
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  const alertsToken = process.env.ALERTS_TOKEN || null;
  if (!repo || !token) throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN are needed");
  const dry = process.argv.includes("--dry-run");

  const alerts = [];
  for (const a of await all(token, `/repos/${repo}/code-scanning/alerts?state=open`).catch(none)) {
    alerts.push({ ...a, kind: "code_scanning" });
  }
  // Closed ones too, so their issues close; only those that have an issue matter, but the list is
  // small enough to read whole.
  for (const state of ["fixed", "dismissed"]) {
    for (const a of await all(token, `/repos/${repo}/code-scanning/alerts?state=${state}`).catch(
      none,
    )) {
      alerts.push({ ...a, kind: "code_scanning" });
    }
  }
  let dependabot = false;
  if (alertsToken) {
    for (const a of await all(alertsToken, `/repos/${repo}/dependabot/alerts`)) {
      alerts.push({ ...a, kind: "dependabot" });
    }
    dependabot = true;
  }
  const issues = await all(token, `/repos/${repo}/issues?state=open&labels=${LABEL}`);
  const p = plan({ alerts, issues, now: Date.now() });

  if (!dry) {
    for (const o of p.open) {
      await github(token, `/repos/${repo}/issues`, {
        method: "POST",
        body: JSON.stringify({ title: o.title, body: o.body, labels: [LABEL] }),
      });
    }
    for (const c of p.close) {
      await github(token, `/repos/${repo}/issues/${c.number}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: c.comment }),
      });
      await github(token, `/repos/${repo}/issues/${c.number}`, {
        method: "PATCH",
        body: JSON.stringify({ state: "closed", state_reason: "completed" }),
      });
    }
  }
  const summary = summaryMarkdown({ rows: p.rows, dependabot });
  console.log(summary);
  console.log(
    `\nIssues opened: ${p.open.length}; closed: ${p.close.length}${dry ? " (dry run)" : ""}.`,
  );
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  }
}

// Code scanning answers 404 before its first analysis (and 403 when it is off): no alerts.
function none(error) {
  if (error.status === 404 || error.status === 403) return [];
  throw error;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`vuln-sla: ${error.message}`);
    process.exitCode = 1;
  });
}
