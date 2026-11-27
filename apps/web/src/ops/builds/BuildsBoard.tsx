// The builds in progress (docs/plan.md §1.108), a card each with what holds it: the Agent lab's
// Drafts tab shows it (owner, 2026-11-17: "Board is essentially the drafts section of the lab").
// Each card opens the build's page.
//
// Owner (2026-11-27): a build goes from its draft straight to Publish, so the board has two
// columns: Draft, every open build whatever phase it is stored in (intake, fit-gap, and the POC
// test, client test and QA of builds made before), and Live, the builds it is given that went
// live. The Lab gives it open builds only; a live one is listed as its agent, as before.
import type { BuildStatus, BuildSummary } from "@countersign/core";
import { Link } from "react-router-dom";
import { Badge } from "../../ui/primitives";
import { buildHref, plural } from "./words";

export const BUILD_COLUMNS: { status: Extract<BuildStatus, "open" | "live">; label: string }[] = [
  { status: "open", label: "Draft" },
  { status: "live", label: "Live" },
];

/** What a build makes, in a word, and for whom. */
export function buildKindLine(b: BuildSummary): string {
  const what = b.kind === "skill" ? "Skill" : b.client ? "Client agent" : "Template";
  const who = b.client?.name ?? (b.testClient ? `tested at ${b.testClient.name}` : "everyone");
  return `${what} · ${who}`;
}

export function BuildsBoard({ builds }: { builds: readonly BuildSummary[] }) {
  // A column with nothing in it is left out, but Draft always shows.
  const columns = BUILD_COLUMNS.map((c) => ({
    ...c,
    here: builds.filter((b) => b.status === c.status),
  })).filter((c) => c.status === "open" || c.here.length > 0);
  return (
    <div
      className={`grid gap-4 pb-2 ${columns.length > 1 ? "md:grid-cols-2" : ""}`}
      data-testid="builds-board"
    >
      {columns.map(({ status, label, here }) => (
        <section key={status} className="flex min-w-0 flex-col gap-3" aria-label={label}>
          <h2 className="flex items-center justify-between px-1 text-sm font-medium text-ink">
            {label}
            <span className="text-ink-muted">{here.length}</span>
          </h2>
          <div
            className={`grid gap-3 ${columns.length > 1 ? "" : "sm:grid-cols-2 xl:grid-cols-3"}`}
          >
            {here.map((b) => (
              <Link
                key={b.id}
                // §1.172: a build started on Describe it opens in the builder, not on its build page.
                to={buildHref(b)}
                data-testid={`builds-card-${b.id}`}
                className="flex flex-col gap-2 rounded-md border border-line bg-surface p-4 text-sm hover:border-line-strong"
              >
                <span className="font-medium text-ink">{b.title}</span>
                <span className="text-ink-muted">{buildKindLine(b)}</span>
                <span className="flex flex-wrap gap-1.5">
                  {/* CONS-2 (QA 2026-11-19): the summary counts stored open items only, not the
                      draft's problems, failing tests or decisions the page counts as issues. It
                      called them "open issues" and said "Nothing open" beside a page with three.
                      DECISION: the board names what it counts (items, as the page calls them) and
                      claims nothing at none. Counting the page's issues for every build on the
                      board means validating each draft for publish on every read. */}
                  {b.openItems > 0 ? (
                    <Badge tone="warning">{plural(b.openItems, "open item")}</Badge>
                  ) : null}
                  {b.waitingOnClient > 0 ? (
                    <Badge tone="person">{b.waitingOnClient} with the client</Badge>
                  ) : null}
                </span>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
