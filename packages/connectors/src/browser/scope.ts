// Site-scoped browsing for `ai` skills (docs/plan.md §1.86; ARCHITECTURE §10.14 "Declared reads").
//
// A skill that declares `browse: { sites, pages }` reaches the browser connector only through its
// two read tools, only on those sites, and only on pages that match both the skill's patterns and
// the site's own allowed pages (the intersection; the skill can never widen the site). The scope
// checks each call before the gate and hands the skill's pages to the connector as `within`; the
// connector checks the address again, with the site's rules, before it signs in, before it
// navigates and on the address it lands on (./session.ts). Never a form, never a sign-in by the
// model: sign-in stays code on pinned origins (./sign-in.ts).
//
// Per skill run the scope counts pages and time; its cost limit joins the runtime's own budgets
// (the smaller of the agent's and this). It keeps one signed-in session per site for the run
// (`sessions`, closed by `close`). At a limit, or at the connection's sign-in caps, the skill asks
// for help (`needsHelp`: the question, what it tried, its screenshots) instead of failing; the
// executor asks the lead and runs the step again with the answer as data. Answers are the agent's
// memory notes and come back as data the next time the same skill browses that site; paths that
// worked are notes in the scope's own memory scope (`browse`, never shown to the model as memory),
// and a path that worked twice is offered to the operator as a script draft (an operator `review`
// inbox item, like the owner's proposals). No new table.

import {
  hashJson,
  type JsonObject,
  parseSkillRef,
  type SkillBrowse,
  urlMatches,
} from "@countersign/core";
import { type HeldSession, RunSessionPool, type RunSessions } from "../connector";
import { BROWSER_FILE_DOWNLOAD_TOOL, BROWSER_PAGE_READ_TOOL } from "./ids";
import { BrowserCapReached } from "./sign-in";

// ── Pages ────────────────────────────────────────────────────────────────────────────────────────

const SCHEME_HOST = /^([a-z][a-z0-9+.-]*):\/\/[^/?#]*/i;
/** A `.` or `..` path segment, as written (the URL parser would quietly resolve it). */
const DOT_SEGMENT = /(^|\/)\.{1,2}(\/|$)/;
/** Encoded dots, slashes, backslashes, percent signs or NULs in a path, or a bare backslash. */
const ENCODED_TRICK = /%(2e|2f|5c|25|00)|\\/i;

export type BrowsePageCheck =
  | { ok: true; url: string }
  | { ok: false; code: "invalid" | "traversal" | "not_listed"; reason: string };

/**
 * Whether a browsing skill may open `url`: a full http(s) address (never protocol-relative or a
 * bare path), no traversal in its path (`..`, `.`, encoded dots or slashes, backslashes), and one
 * of the skill's page patterns (`/orders/*`, matched against the path and query as core's
 * `urlMatches` does). The site's own rules are checked beside this (core's `checkBrowserUrl`).
 */
// DECISION: traversal is refused as written, not resolved: a model that writes `/orders/../users`
// is trying to leave its pages, and a server may decode `%2f` the URL parser leaves alone.
export function checkBrowsePage(url: string, pages: readonly string[]): BrowsePageCheck {
  const raw = url.trim();
  if (raw.startsWith("//") || raw.startsWith("\\")) {
    return {
      ok: false,
      code: "invalid",
      reason: "an address without its https:// (//host/…) is never opened",
    };
  }
  const head = SCHEME_HOST.exec(raw);
  const scheme = head?.[1]?.toLowerCase();
  if (!head || (scheme !== "https" && scheme !== "http")) {
    return { ok: false, code: "invalid", reason: "only a full https address on the site opens" };
  }
  const rest = raw.slice(head[0].length);
  const path = rest.split(/[?#]/, 1)[0] ?? "";
  if (DOT_SEGMENT.test(path) || ENCODED_TRICK.test(path)) {
    return { ok: false, code: "traversal", reason: "an address that climbs out of its path" };
  }
  if (!pages.some((p) => urlMatches(p, raw))) {
    return {
      ok: false,
      code: "not_listed",
      reason: `not one of this skill's pages (${pages.join(", ")})`,
    };
  }
  return { ok: true, url: raw };
}

/**
 * A visited address as a page pattern for a path: segments and query values with a digit in them
 * become `*` (`/invoices/INV-1001.pdf` → `/invoices/*`), so two runs for different records match.
 */
// DECISION: a digit marks a record's own part of an address; anything else is the site's layout.
export function pagePattern(url: string): string {
  const head = SCHEME_HOST.exec(url);
  const rest = head ? url.slice(head[0].length) : url;
  const [beforeHash = ""] = rest.split("#", 1);
  const q = beforeHash.indexOf("?");
  const path = q === -1 ? beforeHash : beforeHash.slice(0, q);
  const query = q === -1 ? "" : beforeHash.slice(q + 1);
  const star = (s: string) => (/\d/.test(s) ? "*" : s);
  const page = (path || "/").split("/").map(star).join("/");
  if (!query) return page;
  const params = query
    .split("&")
    .filter(Boolean)
    .map((kv) => {
      const eq = kv.indexOf("=");
      return eq === -1 ? kv : `${kv.slice(0, eq)}=${star(kv.slice(eq + 1))}`;
    });
  return `${page}?${params.join("&")}`;
}

// ── Limits ───────────────────────────────────────────────────────────────────────────────────────

export interface BrowseLimits {
  /** Pages opened or files downloaded through the browser in one skill run. */
  pages: number;
  /** Minutes from the skill run's start. */
  minutes: number;
  /**
   * The skill run's model spend, in USD (a decimal string, invariant 6). Not counted here: the
   * runtime takes the smaller of this and the agent's own cost budget.
   */
  costUsd: string;
}

// DECISION: 15 pages, 5 minutes and $0.50 of model spend per skill run. Enough to find an invoice
// or an order's status on a portal by following its own links; past that a person who knows the
// site answers faster than more browsing. A run signs in once per site (./session.ts), and the
// time limit bounds how long it stays signed in.
export const BROWSE_LIMITS: Readonly<BrowseLimits> = { pages: 15, minutes: 5, costUsd: "0.50" };

/**
 * What stopped a browsing run: its pages or time (counted here), its budget (the runtime's model
 * calls or cost) or the connection's sign-in caps.
 */
export type BrowseLimit = "pages" | "time" | "budget" | "sign_in";

const LIMIT_WORDS: Record<Exclude<BrowseLimit, "sign_in">, (l: BrowseLimits) => string> = {
  pages: (l) => `${l.pages} pages`,
  time: (l) => `${l.minutes} minutes`,
  budget: () => "its budget",
};

// ── Asking for help ──────────────────────────────────────────────────────────────────────────────

/**
 * A browsing skill's output when it could not find what it needs within its limits: the executor
 * asks the lead (`question`, with what was `tried` and the `screenshots`), and on an answer runs
 * the step once more with `help: <answer>` in its input as data.
 */
export interface NeedsHelp {
  question: string;
  /** The pages opened and what was looked for, in order, as plain lines. */
  tried: string[];
  /**
   * The evidence screenshots of the pages it read: storage keys on the connection's log (the
   * session record's `screenshots`), not new documents.
   */
  screenshots?: string[];
  /**
   * The tag to keep the answer under: write `browseHelpNote(remember, question, answer)` (or
   * `${remember} ${answer}`) with `memory.write`, and the same skill browsing the same site gets it
   * back as data next time.
   */
  remember: string;
}

/** The step output's key for a help request (the executor's contract). */
export const NEEDS_HELP_KEY = "needsHelp";

/** The model's way to ask for help before a limit: a tool beside `finish`, typed here. */
export const NEED_HELP_TOOL = "need_help";

export const NEED_HELP_TOOL_SPEC = {
  name: NEED_HELP_TOOL,
  description:
    "Ask the client's lead for help when the pages you may open don't show what you need. Say what you are looking for in plain words. Call it instead of `finish`; the step waits for the answer and runs again with it.",
  input_schema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        maxLength: 500,
        description: "One plain question for a person who knows the site",
      },
    },
    required: ["question"],
  },
} as const;

/** `[browse-help skill=<id> sites=<a,b>]`: the tag on an answer's memory note. */
export function browseHelpTag(skill: string, sites: readonly string[]): string {
  return `[browse-help skill=${parseSkillRef(skill).id} sites=${[...sites].sort().join(",")}]`;
}

/** A memory note holding a lead's answer to a help request (at most 2,000 characters). */
export function browseHelpNote(tag: string, question: string, answer: string): string {
  return `${tag} Asked: ${question.trim()} Answer: ${answer.trim()}`.slice(0, 2000);
}

const HELP_NOTE = /^\[browse-help skill=(\S+) sites=([a-z0-9,-]+)\]\s*([\s\S]*)$/;
const PATH_NOTE = /^\[browse-path skill=(\S+) fp=([0-9a-f]+)\]\s*([\s\S]*)$/;
const OFFERED_NOTE = /^\[browse-script-offered skill=(\S+) fp=([0-9a-f]+)\]/;

// ── Paths and script drafts ──────────────────────────────────────────────────────────────────────

/** One step of a path that worked: a read tool on a page pattern of a site. */
export interface BrowsePathStep {
  tool: string;
  site: string;
  page: string;
  /** The address it was this time (shown to the operator; not part of the fingerprint). */
  example: string;
}

/** What a skill run asks the platform to keep once it is done (call-tool's `finishScope`). */
export interface BrowseEffects {
  /**
   * Notes to write in the scope's memory scope (`noteScope`; a test run's stay in the run's own
   * scope).
   */
  memory?: string[];
  /**
   * A review item for the operator (never from a test run), offered once: `once` is the note that
   * marks it offered, written first, and only the earliest such note's run creates the item.
   */
  operatorItem?: { title: string; subjectType: string; payload: JsonObject; once?: string };
}

/** The inbox subject of a script draft the operator reviews (docs/plan.md §9 R9). */
export const BROWSE_SCRIPT_DRAFT_SUBJECT = "browse_script_draft";

/**
 * The memory scope of the paths that worked and the drafts offered: the platform's own record,
 * never read into the model's memory or the client's knowledge (they read scope `agent`).
 */
// DECISION: a memory scope of its own rather than the tool_call log or a new table: no migration,
// the bookkeeping never pushes the agent's real notes out of its prompt, and the paths are still
// in the agent's memory rows for an export or a deletion.
export const BROWSE_NOTE_SCOPE = "browse";

// ── The scope ────────────────────────────────────────────────────────────────────────────────────

/** A tool call's result, as much as the scope reads of it (call-tool's ToolOutcome fits). */
interface ObservedOutcome {
  status: string;
  output?: unknown;
  reason?: string;
  error?: string;
}

const READ_TOOLS = new Set([BROWSER_PAGE_READ_TOOL, BROWSER_FILE_DOWNLOAD_TOOL]);

/** The browser connector's tools share its namespace. */
export function isBrowserTool(toolId: string): boolean {
  return toolId.startsWith("browser.");
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * One run of a browsing skill: confines its browser calls, counts its limits, and keeps what it
 * tried and the path that worked. Implements call-tool's `ToolCallScope` (check, observe, finish,
 * its sessions and close).
 */
export class BrowseScope {
  readonly skill: string;
  readonly browse: SkillBrowse;
  readonly limits: BrowseLimits;
  readonly goal: string;
  /** Where its paths and offered drafts are kept (call-tool's `finishScope` reads and writes it). */
  readonly noteScope = BROWSE_NOTE_SCOPE;
  readonly #now: () => Date;
  readonly #startedAt: number;
  readonly #pool = new RunSessionPool();
  #opened = 0;
  #hit: BrowseLimit | null = null;
  /** Why the connection would not sign in (its caps), for the help request. */
  #signInReason: string | null = null;
  #question: string | null = null;
  readonly #tried: string[] = [];
  readonly #path: BrowsePathStep[] = [];
  readonly #screenshots: string[] = [];

  constructor(input: {
    /** The skill's reference or id; versions are dropped, so answers outlive an edit. */
    skill: string;
    browse: SkillBrowse;
    /** What the skill looks for, in plain words (its name, else its description). */
    goal: string;
    now?: (() => Date) | undefined;
    limits?: Partial<BrowseLimits> | undefined;
  }) {
    this.skill = parseSkillRef(input.skill).id;
    this.browse = input.browse;
    this.goal = input.goal;
    this.limits = { ...BROWSE_LIMITS, ...input.limits };
    this.#now = input.now ?? (() => new Date());
    this.#startedAt = this.#now().getTime();
  }

  /** The scope for a skill that declares `browse`; null for one that doesn't. */
  static of(
    def: { id: string; name: string; browse?: SkillBrowse | undefined },
    options: { now?: (() => Date) | undefined; limits?: Partial<BrowseLimits> | undefined } = {},
  ): BrowseScope | null {
    return def.browse
      ? new BrowseScope({ skill: def.id, browse: def.browse, goal: def.name, ...options })
      : null;
  }

  /** The browser tools a browsing skill is offered (it needs not list them). */
  static readonly tools: readonly string[] = [BROWSER_PAGE_READ_TOOL, BROWSER_FILE_DOWNLOAD_TOOL];

  /**
   * Before the gate: other tools pass as they are; a browser call passes only as a read on one of
   * the skill's sites and pages, within the limits, with the skill's pages set as `within` (what
   * the model wrote there is replaced, so it can only be the skill's own list).
   */
  check(
    toolId: string,
    input: unknown,
  ): { ok: true; input: unknown } | { ok: false; reason: string } {
    if (!isBrowserTool(toolId)) return { ok: true, input };
    if (!READ_TOOLS.has(toolId)) {
      return {
        ok: false,
        reason: `${toolId}: a skill that browses only reads pages and downloads files, never a form or a sign-in`,
      };
    }
    const limit = this.#limitNow();
    if (limit) {
      const why =
        limit === "sign_in"
          ? `the site can't be signed in to now (${this.#signInReason})`
          : `this skill's limit of ${LIMIT_WORDS[limit](this.limits)} is reached`;
      return { ok: false, reason: `${why}: finish with what you found, or ask for help` };
    }
    const args = obj(input);
    const site = str(args.site);
    if (!site || !this.browse.sites.includes(site)) {
      return {
        ok: false,
        reason: `${site ?? "that site"} is not one of this skill's sites (${this.browse.sites.join(", ")})`,
      };
    }
    const url = str(args.url) ?? "";
    const page = checkBrowsePage(url, this.browse.pages);
    if (!page.ok) return { ok: false, reason: `${url}: ${page.reason}` };
    return { ok: true, input: { ...args, url: page.url, within: [...this.browse.pages] } };
  }

  /**
   * After the call (refusals included): what was tried, the path, the screenshots. A page counts
   * toward the limit only once the gate and the connector let it be opened: read, or tried and
   * failed on the site. A refusal (the scope's, the gate's or the connector's) opens nothing.
   */
  observe(toolId: string, input: unknown, outcome: ObservedOutcome): void {
    if (!isBrowserTool(toolId)) return;
    const args = obj(input);
    const site = str(args.site) ?? "";
    const url = str(args.url) ?? "";
    if (outcome.status === "done" || outcome.status === "failed") this.#opened += 1;
    if (outcome.status === "done") {
      const out = obj(outcome.output);
      const landed = str(out.url) ?? url;
      const download = toolId === BROWSER_FILE_DOWNLOAD_TOOL;
      this.#tried.push(`${download ? "Downloaded" : "Read"} ${landed}`);
      this.#path.push({ tool: toolId, site, page: pagePattern(landed), example: landed });
      const shot = str(out.screenshot);
      if (shot && !this.#screenshots.includes(shot)) this.#screenshots.push(shot);
      return;
    }
    const why = outcome.reason ?? outcome.error ?? outcome.status;
    this.#tried.push(
      `${outcome.status === "refused" ? "Refused" : "Could not open"} ${url || "(no address)"}: ${why}`,
    );
  }

  /**
   * The limit a run is over, if any: its time, the connection's sign-in caps, or its pages once a
   * call past the page limit was refused. The runtime checks it before each model call; over a
   * limit, the step returns `needsHelp` rather than going on.
   */
  overLimit(): BrowseLimit | null {
    if (this.#hit) return this.#hit;
    if (this.#now().getTime() - this.#startedAt >= this.limits.minutes * 60_000) {
      this.#hit = "time";
    }
    return this.#hit;
  }

  #limitNow(): BrowseLimit | null {
    if (this.#hit) return this.#hit;
    if (this.#opened >= this.limits.pages) this.#hit = "pages";
    return this.overLimit();
  }

  /** The runtime's budget for the run ran out (model calls or cost): the help request. */
  budgetReached(): NeedsHelp {
    this.#hit ??= "budget";
    return this.needsHelp();
  }

  /**
   * The run's sessions: one signed-in browser per site (./session.ts `inBrowserSession`). A
   * sign-in refused by the connection's caps stops the run's browsing with a help request.
   */
  readonly sessions: RunSessions = {
    hold: <T>(key: string, open: () => Promise<HeldSession<T>>): Promise<T> =>
      this.#pool.hold(key, async () => {
        try {
          return await open();
        } catch (error) {
          if (error instanceof BrowserCapReached) {
            this.#hit = "sign_in";
            this.#signInReason = error.message;
          }
          throw error;
        }
      }),
  };

  /** Closes the run's sessions (signs out); the runtime calls it when the skill run ends. */
  close(): Promise<void> {
    return this.#pool.closeAll();
  }

  /** The model asked for help (`need_help`): its question, kept for `needsHelp`. */
  askedForHelp(input: unknown): NeedsHelp {
    const q = str(obj(input).question)?.trim();
    if (q) this.#question = q.slice(0, 500);
    return this.needsHelp();
  }

  /** The help request: the model's question, else one made from the goal and the limit. */
  needsHelp(question?: string): NeedsHelp {
    const where = this.browse.sites.join(", ");
    const hit = this.#hit;
    const q =
      question?.trim() ||
      this.#question ||
      (hit === "sign_in"
        ? `We couldn't sign in to ${where} to look for "${this.goal}": ${this.#signInReason}. Can you find it, or tell us when to try again?`
        : `We looked for "${this.goal}" on ${where} and didn't find it${
            hit ? ` within ${LIMIT_WORDS[hit](this.limits)}` : ""
          }. Where on the site should we look?`);
    return {
      question: q.slice(0, 500),
      tried: [`Looked for: ${this.goal}`, ...this.#tried].slice(0, 50),
      ...(this.#screenshots.length > 0 ? { screenshots: this.#screenshots.slice(-10) } : {}),
      remember: browseHelpTag(this.skill, this.browse.sites),
    };
  }

  /** The pages that worked this run, in order (repeats of the same step folded). */
  path(): BrowsePathStep[] {
    const out: BrowsePathStep[] = [];
    for (const s of this.#path) {
      const last = out.at(-1);
      if (last && last.tool === s.tool && last.site === s.site && last.page === s.page) continue;
      out.push(s);
    }
    return out;
  }

  /**
   * What the model gets as data next to the skill's input: earlier answers to this skill's help
   * requests on these sites, and the paths that worked before (memory notes, never instructions).
   */
  data(notes: readonly string[]): { helpAnswers: string[]; knownPaths: string[] } {
    const helpAnswers: string[] = [];
    const knownPaths: string[] = [];
    for (const note of notes) {
      const help = HELP_NOTE.exec(note);
      if (help) {
        const sites = (help[2] ?? "").split(",");
        if (help[1] === this.skill && sites.some((s) => this.browse.sites.includes(s))) {
          helpAnswers.push((help[3] ?? "").trim());
        }
        continue;
      }
      const path = PATH_NOTE.exec(note);
      if (path && path[1] === this.skill) knownPaths.push((path[3] ?? "").trim());
    }
    return { helpAnswers, knownPaths };
  }

  /**
   * Once the skill finished with an answer: keep the path that worked as a note; when the same
   * path (same pages, other records) worked before, offer it to the operator as a script draft,
   * once. `notes` are the agent's notes in `noteScope` (the newest 50).
   */
  // DECISION: counted in the agent's `browse` notes (the newest 50): no new table. A path that
  // scrolled out of them counts from one again, which only delays the offer.
  async finish(notes: readonly string[]): Promise<BrowseEffects> {
    const steps = this.path();
    if (steps.length === 0) return {};
    const shape = steps.map(({ tool, site, page }) => ({ tool, site, page }));
    const fp = (await hashJson({ skill: this.skill, steps: shape })).slice(0, 16);
    const seen = notes.some((n) => {
      const m = PATH_NOTE.exec(n);
      return m?.[1] === this.skill && m[2] === fp;
    });
    if (!seen) {
      const note = `[browse-path skill=${this.skill} fp=${fp}] ${shape
        .map((s) => `${s.site}${s.page}`)
        .join(" > ")}`;
      return { memory: [note.slice(0, 2000)] };
    }
    const offered = notes.some((n) => {
      const m = OFFERED_NOTE.exec(n);
      return m?.[1] === this.skill && m[2] === fp;
    });
    if (offered) return {};
    const sites = [...new Set(steps.map((s) => s.site))];
    return {
      operatorItem: {
        once: `[browse-script-offered skill=${this.skill} fp=${fp}]`,
        title:
          `A browsing path worked twice: "${this.goal}" on ${sites.join(", ")}. Review it as a script`.slice(
            0,
            200,
          ),
        subjectType: BROWSE_SCRIPT_DRAFT_SUBJECT,
        payload: {
          draft: {
            kind: "browser_script",
            status: "draft",
            skill: this.skill,
            sites,
            fingerprint: fp,
            timesSucceeded: 2,
            steps: steps.map((s) => ({
              tool: s.tool,
              site: s.site,
              page: s.page,
              example: s.example,
            })),
          },
        },
      },
    };
  }
}
