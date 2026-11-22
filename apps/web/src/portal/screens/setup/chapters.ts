// Getting started's chapters (docs/setup-plan.md §2; docs/plan.md §1.185): their order, words and
// addresses, shared by the overview and each chapter's page.
import type { ChapterProgress, SetupChapter } from "@countersign/core";
import type { PlainKey, Translate } from "../../../i18n/catalog";
import { PORTAL_PATHS } from "../../paths";

export const CHAPTER_WORDS: Record<SetupChapter, { title: PlainKey; about: PlainKey }> = {
  business: { title: "setup.chapter.business", about: "setup.chapter.business.about" },
  tools: { title: "setup.chapter.tools", about: "setup.chapter.tools.about" },
  people: { title: "setup.chapter.people", about: "setup.chapter.people.about" },
  see: { title: "setup.chapter.see", about: "setup.chapter.see.about" },
  live: { title: "setup.chapter.live", about: "setup.chapter.live.about" },
};

export const CHAPTER_ORDER: readonly SetupChapter[] = [
  "business",
  "tools",
  "people",
  "see",
  "live",
];

/** Where a chapter lives; the business chapter is Getting started's own cards. */
export function chapterPath(chapter: SetupChapter, agentId?: string | null): string {
  switch (chapter) {
    case "business":
      return PORTAL_PATHS.start;
    case "tools":
      return PORTAL_PATHS.startTools;
    case "people":
      return PORTAL_PATHS.startPeople;
    case "see":
      return PORTAL_PATHS.startSee(agentId ?? null);
    case "live":
      return PORTAL_PATHS.startLive(agentId ?? null);
  }
}

/** A chapter's state in words, for its pill. */
export function stateWords(p: ChapterProgress, t: Translate): string {
  switch (p.state) {
    case "done":
      return t("setup.state.done");
    case "open":
      return t("setup.state.open", { done: p.done, total: p.total });
    case "not_started":
      return t("setup.state.notStarted");
    case "not_needed":
      return t("setup.state.notNeeded");
  }
}
