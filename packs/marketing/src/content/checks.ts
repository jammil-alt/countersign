/**
 * The checks every guide passes before it is published (docs/marketing-plan.md §4.5): a title and
 * a description a search result shows whole, one `<h1>` (the title, so none in the body),
 * something to read, internal links that resolve, and the client's claims list (./claims.ts).
 *
 * The same function answers the editor's live check, `marketing.content.check` and the publish
 * action, so what the editor marks is exactly what publishing refuses. A `refuse` problem blocks a
 * publish; a `check` is shown and does not.
 *
 * Ported from Plenary Labs (apps/api/src/content/checks.ts). Pure: the caller hands in the paths
 * that exist and the client's claims list.
 */

import { type ClaimsList, EMPTY_CLAIMS, lintClaims } from "./claims";
import { type Rendered, renderMarkdown, textOf } from "./markdown";

/** What a search result shows before it cuts a title or a description off. */
export const TITLE_MAX = 60;
export const DESCRIPTION_MAX = 155;
/** The longest body, in characters of Markdown (content_version allows 200,000). */
export const BODY_MAX = 100_000;
/** Search queries a guide is written for. */
export const QUERIES_MAX = 10;

/** A guide's address under `/guides/`: lowercase words joined by single hyphens (§11.4). */
export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const SLUG_MAX = 80;
export const GUIDES_PREFIX = "/guides/";
export const guidePath = (slug: string) => `${GUIDES_PREFIX}${slug}`;
export function slugOf(path: string): string | null {
  if (!path.startsWith(GUIDES_PREFIX)) return null;
  const slug = path.slice(GUIDES_PREFIX.length);
  return SLUG_PATTERN.test(slug) && slug.length <= SLUG_MAX ? slug : null;
}

export type ProblemField = "title" | "description" | "body";

export interface ContentProblem {
  readonly field: ProblemField;
  readonly code: string;
  readonly severity: "refuse" | "check";
  readonly message: string;
  /** The words concerned, when there are some to point at. */
  readonly match?: string;
}

export interface GuideDraft {
  readonly title: string;
  readonly description: string;
  /** Markdown. */
  readonly body: string;
}

export interface Checked {
  readonly rendered: Rendered;
  readonly problems: readonly ContentProblem[];
  /** Words in the body, for the editor. */
  readonly words: number;
  readonly publishable: boolean;
}

/**
 * Whether an internal link resolves: a page of the site, a published guide or this one, and for a
 * link to a section of this guide, a heading it has.
 */
function resolves(
  href: string,
  paths: ReadonlySet<string>,
  headingIds: ReadonlySet<string>,
): boolean {
  if (href.startsWith("#")) return headingIds.has(href.slice(1));
  const [path = ""] = href.split(/[?#]/);
  const bare = path.length > 1 ? path.replace(/\/$/, "") : path;
  return paths.has(bare);
}

export function checkGuide(
  draft: GuideDraft,
  options: {
    /** Every path a link may point at: the site's pages, published guides and this guide's own. */
    paths: ReadonlySet<string>;
    /** The client's claims list (the newest version); none, the house rules only. */
    claims?: ClaimsList;
    /** The site's domain, for the broken-link message. */
    domain?: string;
  },
): Checked {
  const problems: ContentProblem[] = [];
  const title = draft.title.trim();
  const description = draft.description.trim();

  if (title === "") {
    problems.push({
      field: "title",
      code: "title_missing",
      severity: "refuse",
      message: "Give the guide a title.",
    });
  } else if (title.length > TITLE_MAX) {
    problems.push({
      field: "title",
      code: "title_long",
      severity: "refuse",
      message: `Keep the title to ${TITLE_MAX} characters, so a search result shows it whole (it has ${title.length}).`,
    });
  }
  if (description === "") {
    problems.push({
      field: "description",
      code: "description_missing",
      severity: "refuse",
      message: "Write a description: it is what a search result shows under the title.",
    });
  } else if (description.length > DESCRIPTION_MAX) {
    problems.push({
      field: "description",
      code: "description_long",
      severity: "refuse",
      message: `Keep the description to ${DESCRIPTION_MAX} characters (it has ${description.length}).`,
    });
  }
  if (draft.body.length > BODY_MAX) {
    problems.push({
      field: "body",
      code: "body_long",
      severity: "refuse",
      message: `Keep the guide under ${BODY_MAX.toLocaleString("en-US")} characters.`,
    });
  }

  const rendered = renderMarkdown(draft.body.slice(0, BODY_MAX + 1));
  const text = textOf(rendered.html);
  if (text === "") {
    problems.push({
      field: "body",
      code: "body_missing",
      severity: "refuse",
      message: "The guide has nothing to read yet.",
    });
  }
  if (rendered.topHeadings > 0) {
    problems.push({
      field: "body",
      code: "second_h1",
      severity: "refuse",
      message:
        "The title is the page's only top-level heading. Start sections with ## rather than #.",
    });
  }
  for (const what of rendered.removed) {
    problems.push({
      field: "body",
      code: "removed",
      severity: "refuse",
      message: `Taken out of the page: ${what}. Links go to https:, mailto: or a page on the site.`,
      match: what,
    });
  }
  const headingIds = new Set(rendered.headings.map((h) => h.id));
  const where = options.domain ? ` on ${options.domain}` : "";
  for (const href of new Set(rendered.links)) {
    const internal = href.startsWith("/") || href.startsWith("#");
    if (internal && !href.startsWith("//") && !resolves(href, options.paths, headingIds)) {
      problems.push({
        field: "body",
        code: "link_broken",
        severity: "refuse",
        message: `No page at ${href}${where}.`,
        match: href,
      });
    }
  }

  const fields: [ProblemField, string][] = [
    ["title", title],
    ["description", description],
    ["body", text],
  ];
  for (const [field, words] of fields) {
    for (const finding of lintClaims(words, options.claims ?? EMPTY_CLAIMS)) {
      problems.push({
        field,
        code: `claims_${finding.rule}`,
        severity: finding.severity,
        message: finding.message,
        match: finding.match,
      });
    }
  }

  return {
    rendered,
    problems,
    words: text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length ?? 0,
    publishable: publishable(problems),
  };
}

/** Whether a set of problems lets a publish go ahead. */
export const publishable = (problems: readonly ContentProblem[]): boolean =>
  problems.every((problem) => problem.severity !== "refuse");

/** Whether a target query's words are all in the title (shown beside the editor's queries). */
export function queryInTitle(query: string, title: string): boolean {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const have = new Set(title.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  return words.length > 0 && words.every((w) => have.has(w));
}
