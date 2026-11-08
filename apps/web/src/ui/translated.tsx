// P-7: a message with its translation beside it (docs/plan.md §1.69). The translation shows first,
// marked with the language it came from; the original is one click away. Both are the sender's
// words, shown as text, never markup. Agents' work stays ink (brand book).
import { useState } from "react";
import { useI18n } from "../i18n/i18n";
import { Button } from "./primitives";

export interface ShownTranslation {
  status: string;
  from: string;
  text: string | null;
  truncated: boolean;
}

export function TranslatedText({
  text,
  translation,
  testId,
}: {
  /** The original, as the sender wrote it. */
  text: string;
  translation?: ShownTranslation | null | undefined;
  testId?: string;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const [original, setOriginal] = useState(false);
  const shown = translation?.status === "translated" && translation.text ? translation : null;
  if (!shown) {
    return (
      <p className="mt-0.5 whitespace-pre-wrap text-ink" data-testid={testId}>
        {text}
      </p>
    );
  }
  const language =
    shown.from === "unknown"
      ? t("translation.unknownLanguage")
      : (new Intl.DisplayNames([i18n.intl], { type: "language" }).of(shown.from) ?? shown.from);
  return (
    <div className="mt-0.5" data-testid={testId}>
      <p className="whitespace-pre-wrap text-ink">{original ? text : shown.text}</p>
      <span className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
        {original ? t("translation.original") : t("translation.from", { language })}
        {!original && shown.truncated ? <span>{t("translation.truncated")}</span> : null}
        <Button variant="link" size="sm" onClick={() => setOriginal(!original)}>
          {original ? t("translation.showTranslation") : t("translation.showOriginal")}
        </Button>
      </span>
    </div>
  );
}
