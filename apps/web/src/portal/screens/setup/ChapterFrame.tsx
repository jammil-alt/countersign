// A chapter's page (docs/setup-plan.md §2): "Chapter n of 5", its title and what it is for, the
// content, then the way back and on to the next chapter.
import type { SetupChapter } from "@countersign/core";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "../../../i18n/i18n";
import { Page } from "../../../ui/page";
import { buttonClass, PageHeader } from "../../../ui/primitives";
import { PORTAL_PATHS } from "../../paths";
import { CHAPTER_ORDER, CHAPTER_WORDS, chapterPath } from "./chapters";

export function ChapterFrame({
  chapter,
  children,
  actions,
  testId,
}: {
  chapter: SetupChapter;
  children: ReactNode;
  actions?: ReactNode;
  testId?: string;
}) {
  const { t } = useI18n();
  const n = CHAPTER_ORDER.indexOf(chapter) + 1;
  const next = CHAPTER_ORDER[n];
  return (
    <Page width="narrow" testId={testId ?? `start-${chapter}`}>
      <div className="flex flex-col gap-6">
        <PageHeader
          eyebrow={t("setup.frame.eyebrow", { n })}
          title={t(CHAPTER_WORDS[chapter].title)}
          subtitle={t(CHAPTER_WORDS[chapter].about)}
          actions={actions}
        />
        {children}
        <nav className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
          <Link className={buttonClass("ghost", undefined, "sm")} to={PORTAL_PATHS.start}>
            {t("setup.frame.back")}
          </Link>
          {next ? (
            <Link className={buttonClass("secondary", undefined, "sm")} to={chapterPath(next)}>
              {t("setup.frame.next", { chapter: t(CHAPTER_WORDS[next].title) })}
            </Link>
          ) : null}
        </nav>
      </div>
    </Page>
  );
}

/** A chapter whose stream isn't built yet: the frame and a note. */
export function ChapterComing({ chapter }: { chapter: SetupChapter }) {
  const { t } = useI18n();
  return (
    <ChapterFrame chapter={chapter}>
      <div className="rounded-md border border-line bg-surface p-6">
        <p className="text-ink">{t("setup.notBuilt")}</p>
        <p className="mt-1 text-sm text-ink-muted">{t("setup.notBuiltBody")}</p>
      </div>
    </ChapterFrame>
  );
}
