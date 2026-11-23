// The SOP in the reader's language (S5.7, overnight fixes 2026-11-23): core says each sentence it
// makes by key beside its English (packages/core/src/sop/say.ts); this writes it from the key. A
// revision made before the keys, or a key this build doesn't know, keeps its English.
import type { SopProcedureLine, SopSay, SopView } from "@countersign/core";
import type { Translate } from "../i18n/catalog";

type Loose = (key: string, params?: Record<string, string>) => string;

/** One sentence from its key, else its English. */
export function sayText(t: Translate, said: SopSay | null | undefined, english: string): string {
  if (!said) return english;
  const tr = t as unknown as Loose;
  const params: Record<string, string> = { ...(said.params ?? {}) };
  for (const [name, key] of Object.entries(said.paramKeys ?? {})) {
    const word = tr(key);
    if (word !== key) params[name] = word;
  }
  const text = tr(said.key, params);
  return text === said.key ? english : text;
}

function localLine(line: SopProcedureLine, t: Translate): SopProcedureLine {
  if (line.line !== "step") return line;
  const approval = line.approval
    ? {
        ...line.approval,
        ifNoAnswer:
          line.approval.ifNoAnswer === null
            ? null
            : sayText(t, line.approval.ifNoAnswerSay, line.approval.ifNoAnswer),
        ifRejected:
          line.approval.ifRejected === null
            ? null
            : sayText(t, line.approval.ifRejectedSay, line.approval.ifRejected),
      }
    : null;
  return {
    ...line,
    purpose: sayText(t, line.purposeSay, line.purpose),
    approval,
    onError: line.onError === null ? null : sayText(t, line.onErrorSay, line.onError),
  };
}

/** The view with what code said written in the reader's language: steps, outcomes, triggers. */
export function localSop(view: SopView, t: Translate): SopView {
  const said = view.start.triggersSay ?? [];
  const triggerWords = new Map(
    view.start.triggers.map((english, i) => [english, sayText(t, said[i], english)]),
  );
  const trigger = (english: string) => triggerWords.get(english) ?? english;
  return {
    ...view,
    scope: { ...view.scope, covers: view.scope.covers.map(trigger) },
    start: { ...view.start, triggers: view.start.triggers.map(trigger) },
    procedure: view.procedure.map((l) => localLine(l, t)),
  };
}
