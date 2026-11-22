// Getting started's overview (docs/setup-plan.md §2; docs/plan.md §1.199, SU2): a line per agent
// being set up with what is left before its trial and who it waits on, then the five chapters with
// where each stands. Read from `/api/getting-started`: the client's own words and people only.
import type { GettingStartedView, SetupLeft } from "@countersign/core";
import { Link } from "react-router-dom";
import { useI18n } from "../../../i18n/i18n";
import { Badge, Card, SectionLabel } from "../../../ui/primitives";
import { CHAPTER_ORDER, CHAPTER_WORDS, chapterPath, stateWords } from "./chapters";

/** Whether the overview has anything to show: an agent being set up. */
export function hasSetup(view: GettingStartedView | null | undefined): view is GettingStartedView {
  return !!view && view.agents.length > 0;
}

function LeftChip({ line, agentId }: { line: SetupLeft; agentId: string }) {
  const { t } = useI18n();
  const who = line.who ? (line.who.me ? t("setup.who.you") : line.who.name) : null;
  return (
    <Link
      to={chapterPath(line.chapter, agentId)}
      className="inline-flex items-center rounded-full border border-line bg-surface px-2.5 py-0.5 text-sm text-ink hover:border-line-strong"
      data-testid={`start-left-${line.key}`}
    >
      {line.label}
      {who ? <span className="text-ink-muted"> · {who}</span> : null}
    </Link>
  );
}

export function SetupOverview({ view }: { view: GettingStartedView }) {
  const { t } = useI18n();
  const byKey = new Map(view.chapters.map((c) => [c.key, c]));
  return (
    <div className="flex flex-col gap-6" data-testid="start-overview">
      {view.minutesLeft > 0 ? (
        <p className="text-ink-muted" data-testid="start-minutes">
          {t("setup.minutes", { count: view.minutesLeft })}
        </p>
      ) : null}
      <section>
        <SectionLabel
          action={<span className="text-sm text-ink-muted">{t("setup.trial.hint")}</span>}
        >
          {t("setup.trial.title")}
        </SectionLabel>
        <Card>
          {view.agents.map((a) => (
            <div
              key={a.agentId}
              className="flex items-start justify-between gap-4 border-t border-line px-5 py-4 first:border-t-0"
              data-testid={`start-agent-${a.agentId}`}
            >
              <div className="min-w-0">
                <p className="text-ink">{a.name}</p>
                {a.description ? <p className="text-sm text-ink-muted">{a.description}</p> : null}
                {a.left.length ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {a.left.map((l) => (
                      <LeftChip key={l.key} line={l} agentId={a.agentId} />
                    ))}
                  </div>
                ) : null}
              </div>
              {a.left.length ? (
                <Badge tone="warning">{t("setup.left", { count: a.left.length })}</Badge>
              ) : (
                <Badge tone="positive">{t("setup.ready")}</Badge>
              )}
            </div>
          ))}
        </Card>
      </section>
      <section>
        <SectionLabel
          action={<span className="text-sm text-ink-muted">{t("setup.chapters.hint")}</span>}
        >
          {t("setup.chapters")}
        </SectionLabel>
        <Card>
          {CHAPTER_ORDER.map((key, i) => {
            const p = byKey.get(key);
            if (!p) return null;
            const done = p.state === "done" || p.state === "not_needed";
            return (
              <Link
                key={key}
                to={chapterPath(key)}
                className="flex items-center gap-4 border-t border-line px-5 py-4 first:border-t-0 hover:bg-surface-subtle"
                data-testid={`start-chapter-${key}`}
              >
                <span
                  className={
                    done
                      ? "grid size-7 shrink-0 place-items-center rounded-full bg-positive text-sm text-on-slate"
                      : "grid size-7 shrink-0 place-items-center rounded-full border border-line-strong text-sm text-ink-muted"
                  }
                  aria-hidden
                >
                  {done ? "✓" : i + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-ink">{t(CHAPTER_WORDS[key].title)}</span>
                  <span className="block text-sm text-ink-muted">
                    {t(CHAPTER_WORDS[key].about)}
                  </span>
                </span>
                <Badge
                  tone={
                    p.state === "done"
                      ? "positive"
                      : p.state === "open" || p.state === "not_started"
                        ? "warning"
                        : "neutral"
                  }
                >
                  {stateWords(p, t)}
                </Badge>
              </Link>
            );
          })}
        </Card>
      </section>
    </div>
  );
}
