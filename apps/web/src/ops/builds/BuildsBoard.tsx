// The builds in progress by phase (docs/plan.md §1.108), a card each with what holds it: the Agent
// lab's Drafts tab shows it (owner, 2026-11-17: "Board is essentially the drafts section of the
// lab"). Each card opens the build's page.
import { type BuildPhase, type BuildSummary, PHASE_WORDS } from "@countersign/core";
import { Link } from "react-router-dom";
import { Badge } from "../../ui/primitives";
import { buildPath, plural } from "./words";

export const BUILD_COLUMNS: BuildPhase[] = [
  "intake",
  "fitgap",
  "draft",
  "poc",
  "client_test",
  "qa",
];

/** What a build makes, in a word, and for whom. */
export function buildKindLine(b: BuildSummary): string {
  const what = b.kind === "skill" ? "Skill" : b.client ? "Client agent" : "Template";
  const who = b.client?.name ?? (b.testClient ? `tested at ${b.testClient.name}` : "everyone");
  return `${what} · ${who}`;
}

export function BuildsBoard({ builds }: { builds: readonly BuildSummary[] }) {
  return (
    <div
      className="grid gap-4 overflow-x-auto pb-2 md:grid-cols-3 xl:grid-cols-6"
      data-testid="builds-board"
    >
      {BUILD_COLUMNS.map((phase) => {
        const here = builds.filter((b) => b.phase === phase);
        return (
          <section
            key={phase}
            className="flex min-w-0 flex-col gap-3"
            aria-label={PHASE_WORDS[phase].label}
          >
            <h2 className="flex items-center justify-between px-1 text-sm font-medium text-ink">
              {PHASE_WORDS[phase].label}
              <span className="text-ink-muted">{here.length}</span>
            </h2>
            {here.map((b) => (
              <Link
                key={b.id}
                to={buildPath(b.id)}
                data-testid={`builds-card-${b.id}`}
                className="flex flex-col gap-2 rounded-md border border-line bg-surface p-4 text-sm hover:border-line-strong"
              >
                <span className="font-medium text-ink">{b.title}</span>
                <span className="text-ink-muted">{buildKindLine(b)}</span>
                <span className="flex flex-wrap gap-1.5">
                  {b.openItems > 0 ? (
                    <Badge tone="warning">{plural(b.openItems, "open issue")}</Badge>
                  ) : (
                    <Badge tone="positive">Nothing open</Badge>
                  )}
                  {b.waitingOnClient > 0 ? (
                    <Badge tone="person">{b.waitingOnClient} with the client</Badge>
                  ) : null}
                </span>
              </Link>
            ))}
          </section>
        );
      })}
    </div>
  );
}
