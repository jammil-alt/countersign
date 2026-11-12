// @ts-check
// The site's diagrams and demos, rendered to HTML when the site is built (`{{component name}}`
// in a page). Every state a demo can show is in the page; src/site.js only switches between
// them, so a reader without scripts sees the first state of each, and nothing is fetched.
//
// DECISION: the design (mezonas-site-handoff, 2026-11) was a React-style component file; the site
// stays plain HTML with build-time rendering and one small script, rather than a framework, so
// it keeps no runtime dependencies (apps/site/README.md).

import { LANES, PROCESS, USE_CASE_FIRST, USE_CASES } from "./content/hire.mjs";
import { INTEGRITY, MASKED_FIELDS, PERMISSIONS, SECURITY, WORKSHEET } from "./content/security.mjs";
import { ACTORS, ICONS } from "./content/shared.mjs";
import {
  CONNECTOR_CATEGORIES,
  CONNECTORS,
  GAP_ROWS,
  GAP_SCALE,
  HUB,
  HUB_PACKETS,
  RUN_ITEMS,
  RUN_QUOTES,
  RUN_STAGES,
  RUN_TEXTS,
  RUN_TICKS,
  RUN_VENDORS,
  TEAM,
} from "./content/what.mjs";

/** @typedef {import("./content/shared.mjs").Icon} Icon */
/** @typedef {import("./content/shared.mjs").Step} Step */

/** Text for HTML: `&`, `<`, `>` and `"` escaped. */
export function esc(/** @type {string} */ text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** A line icon from ICONS. */
function ico(/** @type {Icon} */ name, cls = "mk-ico") {
  return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${ICONS[name]}"></path></svg>`;
}

/** The Mezonas mark (the table and its six seats), in `currentColor`. */
const MARK =
  '<svg class="mk-hub__mark" viewBox="4 6 40 36" aria-hidden="true" focusable="false"><g fill="currentColor">' +
  '<rect x="12" y="14" width="24" height="20" rx="2"></rect><rect x="15" y="6" width="7" height="4" rx="1"></rect>' +
  '<rect x="26" y="6" width="7" height="4" rx="1"></rect><rect x="15" y="38" width="7" height="4" rx="1"></rect>' +
  '<rect x="26" y="38" width="7" height="4" rx="1"></rect><rect x="4" y="20.5" width="4" height="7" rx="1"></rect>' +
  '<rect x="40" y="20.5" width="4" height="7" rx="1"></rect></g></svg>';

/** "4251.50" → "$4,251.50". Money stays a string: this only formats it. */
export function dollars(/** @type {string} */ amount) {
  const [whole = "0", cents = "00"] = amount.split(".");
  return `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${cents.padEnd(2, "0")}`;
}

/** Percent along a scale of `n` steps, at the middle of step `i`. */
const along = (/** @type {number} */ i, n = GAP_SCALE.length) => ((i + 0.5) * 100) / n;

// What we do

function hub() {
  const spokes = HUB.map(
    (h) =>
      `<line x1="50" y1="50" x2="${h.x}" y2="${h.y}" vector-effect="non-scaling-stroke"></line>`,
  ).join("");
  // A negative begin starts each packet already on its way, so none waits at the corner.
  const packets = HUB_PACKETS.map(
    (p) =>
      `<circle class="mk-hub__pkt mk-hub__pkt--${p.tone}" r="${p.tone === "signal" ? 1.4 : 1.2}"><animateMotion dur="2.6s" repeatCount="indefinite" begin="${(p.begin - 2.6).toFixed(1)}s" path="M${p.from[0]} ${p.from[1]} L${p.to[0]} ${p.to[1]}"></animateMotion></circle>`,
  ).join("");
  const nodes = HUB.map(
    (h) => `<li class="mk-hub__node mk-hub__node--${h.kind}" style="left: ${h.x}%; top: ${h.y}%;">
            <span class="mk-hub__tile"><span class="mk-hub__icon">${ico(h.icon)}</span></span>
            <span class="mk-hub__label"><span class="mk-hub__name">${esc(h.name)}</span><span class="mk-hub__what">${esc(h.what)}</span></span>
          </li>`,
  ).join("\n          ");
  return `<div class="mk-hub">
        <div class="mk-hub__dots" aria-hidden="true"></div>
        <svg class="mk-hub__lines" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
          <circle class="mk-hub__ring" cx="50" cy="50" r="36" vector-effect="non-scaling-stroke"></circle>
          <circle class="mk-hub__ring mk-hub__ring--inner" cx="50" cy="50" r="22" vector-effect="non-scaling-stroke"></circle>
          <g class="mk-hub__spokes">${spokes}</g>
          <g class="mk-hub__pkts">${packets}</g>
        </svg>
        <div class="mk-hub__center">${MARK}<span class="mk-hub__center-text"><span class="mk-hub__center-name">Mezonas</span><span class="mk-hub__center-sub">agents + your lead</span></span></div>
        <ul class="mk-hub__nodes">
          ${nodes}
        </ul>
      </div>`;
}

/** One connector tile. */
function tile(/** @type {(typeof CONNECTORS)[number]} */ k) {
  return `<span class="mk-conn__logo"><img src="/logos/${k.logo}" alt="" style="height: ${k.height}px;" loading="lazy"></span><span class="mk-conn__text"><span class="mk-conn__name">${esc(k.name)}</span><span class="mk-conn__cat">${esc(k.also ? "Accounting and CRM" : (CONNECTOR_CATEGORIES[k.cat]?.label ?? ""))}</span></span>`;
}

function connectors() {
  const cats = [
    ["all", "All"],
    ...Object.entries(CONNECTOR_CATEGORIES).map(([id, c]) => [id, c.label]),
  ];
  const pills = cats
    .map(
      ([id, label], i) =>
        `<button type="button" class="mk-chip" data-conn-cat="${id}" aria-pressed="${i === 0}" data-track="connectors-${id}">${esc(label ?? "")}</button>`,
    )
    .join("\n            ");
  /** A marquee row: the list twice, the copy hidden from screen readers, for a seamless loop. */
  const row = (/** @type {string[]} */ catIds, reverse = false) => {
    const list = CONNECTORS.filter((k) => catIds.includes(k.cat));
    const items = [
      ...list.map((k) => `<li class="mk-conn">${tile(k)}</li>`),
      ...list.map((k) => `<li class="mk-conn" aria-hidden="true">${tile(k)}</li>`),
    ].join("");
    return `<div class="mk-marquee"><ul class="mk-marquee__track${reverse ? " mk-marquee__track--rev" : ""}">${items}</ul></div>`;
  };
  const grid = CONNECTORS.map(
    (k) =>
      `<li class="mk-conn" data-cat="${[k.cat, k.also].filter(Boolean).join(" ")}">${tile(k)}</li>`,
  ).join("");
  return `<div class="mk-conns" data-connectors>
        <div class="mk-section-head mk-section-head--split">
          <div class="mk-stack mk-stack--10 mk-measure">
            <p class="eyebrow">Connectors</p>
            <h2 class="mk-h2" id="connectors-title">Works with the tools you already run.</h2>
          </div>
          <div class="mk-chips" role="group" aria-label="Filter by category">
            ${pills}
          </div>
        </div>
        <div class="mk-conns__all" data-conn-all>
          ${row(["acct", "pay", "crm"])}
          ${row(["comm", "files", "mkt"], true)}
        </div>
        <ul class="mk-conns__grid" data-conn-grid hidden>${grid}</ul>
        <div class="mk-conns__foot">
          <span class="mk-conns__more"><span class="mk-pill mk-pill--slate">+ many more</span><span class="mk-small mk-muted">Using something not listed? If it has a login, we can usually connect to it.</span></span>
          <a href="#diagnostic" class="mk-link" data-track="connectors-ask">Ask about your stack</a>
        </div>
      </div>`;
}

/** The small badge on an avatar: a person (round, copper) or an AI agent (square, slate). */
function badge(/** @type {"person" | "agent" | "agent-on-slate"} */ kind) {
  const title = kind === "person" ? "Person" : "AI agent";
  return `<span class="mk-badge mk-badge--${kind}" title="${title}"><span class="visually-hidden">${title}</span>${ico(kind === "person" ? "person" : "chip", "mk-ico mk-ico--11")}</span>`;
}

function team() {
  const link = `<div class="mk-org__link" aria-hidden="true"><span></span><svg width="12" height="8" viewBox="0 0 12 8"><path d="M1 7l5-5 5 5"></path></svg><span></span></div>`;
  const agents = TEAM.map(
    (t) => `<li class="mk-org__seat">
              <div class="mk-org__agent">
                <span class="mk-avatar"><span class="mk-avatar__face mk-avatar__face--agent" aria-hidden="true">${esc(t.name.charAt(0))}</span>${badge("agent")}</span>
                <span class="mk-org__who"><span class="mk-org__name">${esc(t.name)}</span><span class="mk-small mk-muted">${esc(t.role)}</span></span>
                <span class="mk-org__line">${esc(t.line)}</span>
                <span class="mk-org__tools">${t.tools.map(([name, icon]) => `<span>${ico(icon, "mk-ico mk-ico--12")}${esc(name)}</span>`).join("")}</span>
              </div>
            </li>`,
  ).join("\n            ");
  return `<div class="mk-scroll">
        <div class="mk-org">
          <div class="mk-org__card mk-org__card--you">
            <span class="mk-avatar mk-avatar--46"><span class="mk-avatar__face mk-avatar__face--round">${ico("pen")}</span>${badge("person")}</span>
            <span class="mk-org__text"><span class="eyebrow">Decides</span><span class="mk-org__name">You, the owner</span><span class="mk-small">See everything. Sign what matters.</span></span>
          </div>
          ${link}
          <div class="mk-org__card mk-org__card--lead">
            <span class="mk-avatar mk-avatar--46"><span class="mk-avatar__face mk-avatar__face--round" aria-hidden="true">AM</span>${badge("person")}</span>
            <span class="mk-org__text"><span class="eyebrow">Checks</span><span class="mk-org__name">Ana, your Mezonas lead</span><span class="mk-small">Checks every result before it reaches you.</span></span>
          </div>
          ${link}
          <div class="mk-org__card mk-org__card--manager">
            <span class="mk-avatar mk-avatar--46"><span class="mk-avatar__face" aria-hidden="true">S</span>${badge("agent-on-slate")}</span>
            <span class="mk-org__text"><span class="eyebrow">Manages</span><span class="mk-org__name">Sloan, your manager agent</span><span class="mk-small">Runs the team and prepares the work for Ana.</span></span>
          </div>
          ${link}
          <ul class="mk-org__team">
            ${agents}
            <li class="mk-org__seat">
              <div class="mk-org__agent mk-org__agent--open">
                <span class="mk-avatar__face mk-avatar__face--open">${ico("plus")}</span>
                <span class="mk-org__who"><span class="mk-org__name">Your next hire</span><span class="mk-small mk-muted">Add a seat</span></span>
                <span class="mk-org__line mk-muted">Expenses, vendor setup, payroll prep. When you're ready.</span>
              </div>
            </li>
          </ul>
        </div>
      </div>`;
}

function gap() {
  const rows = GAP_ROWS.map((g) => {
    const you = along(g.you);
    const best = along(g.best);
    const style = `--you: ${you}%; --best: ${best}%; --gap-left: ${Math.min(you, best)}%; --gap-width: ${Math.abs(best - you)}%;`;
    return `<li class="mk-gap__row" style="${style}">
            <span class="mk-gap__label">${esc(g.label)}</span>
            <div class="mk-gap__track-wrap">
              <div class="mk-gap__track" aria-hidden="true"><span class="mk-gap__rail"></span><span class="mk-gap__bar"></span><span class="mk-gap__best"></span><span class="mk-gap__you"></span></div>
              <div class="mk-gap__texts"><span class="mk-small mk-gap__now"><span class="mk-gap__today">${esc(g.now)}</span><span class="mk-gap__done">Done for you</span></span><span class="mk-small mk-gap__goal">${esc(g.bestText)}</span></div>
            </div>
          </li>`;
  }).join("\n          ");
  return `<div class="mk-gap" data-gap>
        <div class="mk-section-head mk-section-head--split">
          <div class="mk-stack mk-stack--10 mk-measure">
            <p class="eyebrow">Where you are vs. where you should be</p>
            <h2 class="mk-h2" id="gap-title">The work you know you should be doing.</h2>
          </div>
          <div class="mk-seg" role="group" aria-label="Choose a view">
            <button type="button" data-gap-view="today" aria-pressed="true" data-track="gap-today">Today</button>
            <button type="button" data-gap-view="with" aria-pressed="false" data-track="gap-with">With Mezonas</button>
          </div>
        </div>
        <div class="mk-legend">
          <span class="mk-small"><span class="mk-legend__you" aria-hidden="true"></span>You, today</span>
          <span class="mk-small"><span class="mk-legend__best" aria-hidden="true"></span>Your best competitors</span>
          <span class="mk-small"><span class="mk-legend__gap" aria-hidden="true"></span>The gap</span>
        </div>
        <div>
          <div class="mk-gap__scale" aria-hidden="true"><span></span><div>${GAP_SCALE.map((s) => `<span class="eyebrow">${esc(s)}</span>`).join("")}</div></div>
          <ul class="mk-gap__rows">
          ${rows}
          </ul>
        </div>
        <div class="mk-gap__close">
          <p>Not for lack of knowing. For lack of hours and discipline.</p>
          <p class="mk-gap__punch">Now someone has both.</p>
        </div>
      </div>`;
}

function run() {
  const stages = RUN_STAGES.map(
    (s, i) =>
      `<li><button type="button" class="mk-run__step" data-run-stage="${i}" data-start="${s.start}" data-tick="${s.pick ?? s.start}" aria-current="${i === 0 ? "step" : "false"}" data-track="run-stage-${i + 1}"><span class="mk-mono">0${i + 1}</span><span class="mk-run__step-label">${esc(s.label)}</span></button></li>`,
  ).join("");
  const texts = RUN_TEXTS.map(
    (t, i) =>
      `<div class="mk-bubble${t.ours ? " mk-bubble--ours" : ""} mk-in" style="animation-delay: ${i * 0.5}s;">${t.ours ? "" : `<p class="mk-bubble__from">${esc(t.from)}</p>`}<p>${esc(t.text)}</p></div>`,
  ).join("");
  const items = RUN_ITEMS.map(
    (it, i) =>
      `<li class="mk-in" style="animation-delay: ${i * 0.4}s;"><span class="mk-run__qty mk-num">${esc(it.qty)}</span><span class="mk-run__item"><span>${esc(it.name)}</span><span class="mk-small mk-muted">${esc(it.match)}</span></span><span class="mk-pill mk-pill--positive">Matched</span></li>`,
  ).join("");
  const vendors = RUN_VENDORS.map(
    (
      v,
      i,
    ) => `<li class="mk-vendor mk-in" style="animation-delay: ${i * 0.15}s;" data-vendor data-answer-tick="${9 + i}"${v.tone === "positive" ? " data-pick" : ""}>
              <div class="mk-vendor__head"><span class="mk-ib mk-ib--40">${ico(v.icon)}</span><span class="mk-vendor__who"><span>${esc(v.name)}</span><span class="mk-small mk-muted">${esc(v.channel)}</span></span></div>
              <span class="mk-pill mk-pill--quiet mk-pulse" data-vendor-wait>${esc(v.waiting)}</span>
              <div class="mk-vendor__answer" data-vendor-answer hidden><div class="mk-vendor__reply mk-in"><p class="mk-small">${esc(v.reply)}</p></div><span class="mk-pill mk-pill--${v.tone ?? "neutral"}">${esc(v.tag)}</span></div>
            </li>`,
  ).join("\n            ");
  const max = Math.max(...RUN_QUOTES.map((q) => (q.total ? Number(q.total) : 0)));
  const quotes = RUN_QUOTES.map((q) => {
    const pct = q.total ? Math.round((Number(q.total) / max) * 100) : 0;
    const dayTone = q.ok ? (q.best ? "positive" : "neutral") : "signal";
    return `<li><span class="mk-run__vendor">${esc(q.name)}</span><span class="mk-run__total"><span class="mk-run__track"><span class="mk-run__fill${q.best ? " mk-run__fill--best" : ""} mk-grow" style="width: ${pct}%;"></span></span><span class="mk-num mk-run__amount">${q.total ? dollars(q.total) : "—"}</span></span><span class="mk-pill mk-pill--${dayTone}">${esc(q.day)}</span></li>`;
  }).join("");
  return `<div class="mk-card mk-card--lg mk-run" data-run data-ticks="${RUN_TICKS}">
        <div class="mk-run__head">
          <div class="mk-run__agent"><span class="mk-run__avatar" aria-hidden="true">P</span><span class="mk-run__agent-name">Pia, Purchasing</span><span class="mk-pill mk-pill--surface">Sample shop</span></div>
          <button class="mk-btn mk-btn--quiet mk-btn--sm" type="button" data-run-toggle data-track="run-toggle">Pause</button>
        </div>
        <ol class="mk-run__steps">${stages}</ol>
        <div class="mk-run__body">
          <div class="mk-run__panel" data-run-panel="0">
            <div class="mk-phone">
              <div class="mk-phone__head">${ico("chat")}<span class="mk-small">Text to the purchasing line</span></div>
              ${texts}
            </div>
          </div>
          <div class="mk-run__panel" data-run-panel="1" hidden>
            <div class="mk-list">
              <div class="mk-list__head"><span>Hughes job · material list</span><span class="mk-mono mk-muted">Need by Thu</span></div>
              <ul>${items}</ul>
            </div>
          </div>
          <div class="mk-run__panel" data-run-panel="2" hidden>
            <ul class="mk-vendors">
            ${vendors}
            </ul>
          </div>
          <div class="mk-run__panel" data-run-panel="3" hidden>
            <div class="mk-quotes">
              <div class="mk-quotes__head"><span class="eyebrow">Total for the full list</span><span class="eyebrow">Arrives</span></div>
              <ul>${quotes}</ul>
            </div>
          </div>
          <div class="mk-run__panel" data-run-panel="4" hidden>
            <div class="mk-sign mk-in">
              <div class="mk-sign__top"><span class="eyebrow">Your desk</span><span class="mk-pill mk-pill--signal-fill">Waiting on you</span></div>
              <p class="mk-sign__title">Buy from Lone Star Panel</p>
              <div class="mk-sign__facts">
                <div><p class="eyebrow">Total</p><p class="mk-num">$4,251.50</p></div>
                <div><p class="eyebrow">Arrives</p><p>Thursday</p></div>
                <div><p class="eyebrow">Vs. next lowest</p><p class="mk-num mk-positive">$208 less</p></div>
              </div>
              <span class="mk-pill mk-pill--person">Checked by Ana, your Mezonas lead</span>
              <div class="mk-sign__actions">
                <button class="mk-btn mk-btn--primary mk-btn--sign" type="button" data-run-sign data-track="run-sign">Sign</button>
                <button class="mk-btn mk-btn--quiet" type="button" data-run-quotes data-track="run-quotes">See all quotes</button>
              </div>
            </div>
          </div>
        </div>
        <div class="mk-run__progress" aria-hidden="true"><span data-run-progress style="width: ${Math.round((1 / RUN_TICKS) * 100)}%;"></span></div>
      </div>`;
}

// Hire, don't build

/** The lane each actor's steps sit on, 0 at the top. */
function laneOf(/** @type {string} */ actor) {
  return Math.max(
    0,
    LANES.findIndex((l) => l.actors.includes(actor)),
  );
}

/** The stepped line through a use case's cards, in a 600 × 400 box, through step `k`. */
export function stepPath(/** @type {[number, number][]} */ pts, /** @type {number} */ k) {
  if (k < 1 || pts.length === 0) return "M0 0";
  const [x0, y0] = /** @type {[number, number]} */ (pts[0]);
  let d = `M${x0} ${y0}`;
  for (let i = 1; i <= k && i < pts.length; i++) {
    const [px] = /** @type {[number, number]} */ (pts[i - 1]);
    const [x, y] = /** @type {[number, number]} */ (pts[i]);
    d += ` H${px + 50} V${y} H${x}`;
  }
  return d;
}

function useCases() {
  const pills = USE_CASES.map(
    (u) =>
      `<button type="button" class="mk-pick" data-uc="${u.id}" aria-pressed="${u.id === USE_CASE_FIRST}" data-track="usecase-${u.id}"><span class="mk-pick__av" aria-hidden="true">${esc(u.who.charAt(0))}</span><span>${esc(u.result)}</span></button>`,
  ).join("\n          ");
  const lanes = LANES.map(
    (l, i) =>
      `<div class="mk-lanes__band${i === 0 ? " mk-lanes__band--first" : ""}${i % 2 ? " mk-lanes__band--alt" : ""}" style="grid-row: ${i + 1};"></div><div class="mk-lanes__label" style="grid-row: ${i + 1};"><span class="mk-lanes__name"><span class="mk-lanes__dot mk-lanes__dot--${l.tone}" aria-hidden="true"></span>${esc(l.label)}</span><span class="mk-lanes__sub">${esc(l.sub)}</span></div>`,
  ).join("");
  const panels = USE_CASES.map((u) => {
    const pts = /** @type {[number, number][]} */ (
      u.flow.map((f, i) => [i * 100 + 50, laneOf(f[1]) * 100 + 50])
    );
    const cards = u.flow
      .map((f, i) => {
        const [icon, actor, kind, t, d] = f;
        return `<li class="mk-lanes__cell" style="grid-column: ${i + 2}; grid-row: ${laneOf(actor) + 1};" data-step="${i}"><div class="mk-flowcard"><div class="mk-flowcard__top"><span class="mk-dot mk-tone--${ACTORS[actor].tone}">${ico(icon, "mk-ico mk-ico--16")}</span><span class="mk-mono mk-tone-text--${ACTORS[actor].tone}">0${i + 1} · ${esc(kind)}<span class="mk-flowcard__lane"> · ${esc(ACTORS[actor].label)}</span></span></div><span class="mk-flowcard__t">${esc(t)}</span><span class="mk-flowcard__d">${esc(d)}</span></div></li>`;
      })
      .join("");
    return `<div class="mk-uc" data-uc-panel="${u.id}"${u.id === USE_CASE_FIRST ? "" : " hidden"}>
          <div class="mk-uc__head">
            <div class="mk-uc__result">
              <p class="eyebrow">Result</p>
              <p class="mk-uc__title">${esc(u.result)}</p>
              <div class="mk-row"><span class="mk-pill mk-pill--agent">${esc(u.who)}</span><span class="mk-pill mk-pill--neutral">Uses ${esc(u.uses)}</span></div>
            </div>
            <div class="mk-uc__outcome"><span class="mk-ib mk-ib--40 mk-ib--round">${ico("check")}</span><span class="mk-stack mk-stack--3"><span class="eyebrow">The outcome</span><span class="mk-uc__change">${esc(u.change)}</span></span></div>
          </div>
          <div class="mk-scroll">
            <div class="mk-lanes">
              ${lanes}
              <svg class="mk-lanes__path" viewBox="0 0 600 400" preserveAspectRatio="none" aria-hidden="true" focusable="false" data-points="${pts.map((p) => p.join(",")).join(" ")}">
                <path class="mk-lanes__todo mk-flow" d="${stepPath(pts, pts.length - 1)}" vector-effect="non-scaling-stroke"></path>
                <path class="mk-lanes__done" d="M0 0" vector-effect="non-scaling-stroke" data-done></path>
              </svg>
              <ol class="mk-lanes__cards">${cards}</ol>
            </div>
          </div>
        </div>`;
  }).join("\n        ");
  return `<div class="mk-stack mk-stack--28" data-usecases>
        <div class="mk-picks" role="group" aria-label="Choose a result">
          ${pills}
        </div>
        <div class="mk-card mk-card--xl mk-uc-card">
        ${panels}
        </div>
      </div>`;
}

function process() {
  const steps = PROCESS.map(
    (
      p,
      i,
    ) => `<li><button type="button" class="mk-proc" data-proc="${i}" aria-pressed="${i === 0}" data-track="process-${p.name.toLowerCase()}">
              <span class="mk-proc__top"><span class="mk-mono mk-slate">${p.n} · ${esc(p.name)}</span><span class="mk-mono mk-muted">${esc(p.time)}</span></span>
              <span class="mk-proc__title">${esc(p.title)}</span>
              <span class="mk-proc__desc"${i === 0 ? "" : " hidden"}>${esc(p.desc)}</span>
            </button></li>`,
  ).join("\n            ");
  const flows = PROCESS.map(
    (p, i) => `<div class="mk-wf" data-proc-panel="${i}"${i === 0 ? "" : " hidden"}>
            <div class="mk-stack mk-stack--2 mk-wf__head"><p class="eyebrow">Workflow</p><p class="mk-wf__title">${esc(p.name)}: ${esc(p.title)}</p></div>
            <div class="mk-row">
              <span class="mk-pill mk-pill--neutral">Your systems: accounting, CRM, email</span>
              <span class="mk-pill mk-pill--agent">Agents</span>
              <span class="mk-pill mk-pill--person">Your team and your lead</span>
              <span class="mk-pill mk-pill--you">You</span>
            </div>
            <ol class="mk-wf__nodes">${p.flow
              .map(([icon, actor, kind, t, d], j) => {
                const a = ACTORS[actor];
                return `<li class="mk-wf__node" data-node="${j}"><div class="mk-wf__rail"><span class="mk-ib mk-tone--${a.tone}">${ico(icon)}</span>${j < p.flow.length - 1 ? '<span class="mk-wf__line"></span>' : ""}</div><div class="mk-wf__text"><span class="mk-mono mk-tone-text--${a.tone}">${esc(kind)} · ${esc(a.label)}</span><span class="mk-wf__t">${esc(t)}</span><span class="mk-small mk-muted">${esc(d)}</span></div><span class="mk-pill mk-pill--agent mk-pulse mk-wf__now">Now</span></li>`;
              })
              .join("")}</ol>
          </div>`,
  ).join("\n          ");
  return `<div class="mk-procs" data-process>
        <ol class="mk-procs__list">
            ${steps}
        </ol>
        <div class="mk-card mk-card--lg mk-procs__card">
          <button class="mk-btn mk-btn--quiet mk-btn--sm mk-procs__toggle" type="button" data-proc-toggle data-track="process-toggle">Pause</button>
          ${flows}
        </div>
      </div>`;
}

// Security

/** A pillar's checklist. */
function checklist(/** @type {{ t: string, d: string, soon?: boolean }[]} */ list) {
  return `<ul class="mk-checks">${list
    .map(
      (x) =>
        `<li>${ico("check")}<span class="mk-stack"><span class="mk-strong">${esc(x.t)}${x.soon ? ' <span class="mk-pill mk-pill--neutral">Coming soon</span>' : ""}</span><span class="mk-small mk-muted">${esc(x.d)}</span></span></li>`,
    )
    .join("")}</ul>`;
}

function masking() {
  const rows = MASKED_FIELDS.map(
    (f) =>
      `<li><span class="mk-small mk-muted mk-mask__label">${esc(f.label)}</span>${
        f.masked
          ? `<span class="mk-mask__value"><span class="mk-num mk-mask__real">${esc(f.real)}</span><span class="mk-mono mk-mask__ai">&#91;${esc(f.masked)}&#93;</span></span><span class="mk-pill mk-pill--agent mk-mask__pill">Masked</span>`
          : `<span class="mk-mask__value mk-num">${esc(f.real)}</span>`
      }</li>`,
  ).join("");
  return `<div class="mk-card mk-card--lg mk-mask" data-mask>
          <div class="mk-mask__head">
            <div class="mk-stack mk-stack--4"><p class="eyebrow">Security, shown</p><p class="mk-card-title">What an AI model will see.</p><span class="mk-pill mk-pill--neutral mk-mask__soon">Coming soon</span></div>
            <div class="mk-seg mk-seg--sm" role="group" aria-label="Choose a view">
              <button type="button" data-mask-view="real" aria-pressed="true" data-track="mask-real">What you see</button>
              <button type="button" data-mask-view="ai" aria-pressed="false" data-track="mask-ai">What the AI sees</button>
            </div>
          </div>
          <ul class="mk-mask__rows">${rows}</ul>
          <p class="mk-small mk-muted">The model checks the price. It never needs to know who the vendor is or where the money goes.</p>
        </div>`;
}

function worksheet() {
  return `<ol class="mk-ws">${WORKSHEET.map(
    (w) =>
      `<li><span class="mk-mono mk-muted mk-ws__time">${esc(w.time)}</span><span class="mk-ws__what"><span class="mk-strong">${esc(w.what)}</span><span class="mk-mono mk-muted">${esc(w.src)}</span></span><span class="mk-pill mk-pill--${w.tone}">${esc(w.who)}</span></li>`,
  ).join("")}</ol>`;
}

function permissions() {
  return `<ul class="mk-perms">${PERMISSIONS.map(
    (p) =>
      `<li><span class="mk-perms__sys">${esc(p.sys)}</span><span class="mk-perms__note mk-muted">${esc(p.note)}</span><span class="mk-pill mk-pill--lg mk-pill--${p.tone}">${esc(p.level)}</span></li>`,
  ).join("")}</ul>`;
}

/** The components a page can name as `{{component name}}`. */
export const COMPONENTS = {
  hub,
  connectors,
  team,
  gap,
  run,
  "use-cases": useCases,
  process,
  "security-list": () => checklist(SECURITY),
  "integrity-list": () => checklist(INTEGRITY),
  masking,
  worksheet,
  permissions,
};

/** Replaces each `{{component name}}` in a page with the component's HTML. */
export function renderComponents(/** @type {string} */ html, /** @type {string} */ file) {
  return html.replace(/\{\{component ([a-z-]+)\}\}/g, (_, name) => {
    const render = /** @type {Record<string, () => string>} */ (COMPONENTS)[name];
    if (!render) throw new Error(`${file}: no component "${name}"`);
    return render();
  });
}
