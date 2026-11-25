// AI's instructions (§5): what to do, in prose. The model is under More.

import { TextArea } from "../../../agents/ui";
import type { InstructionsProps } from "./shared";

export const AI_TEXT_MAX = 8000;

export function AiInstructions({ step, onChange }: InstructionsProps) {
  const text = step.ai?.text ?? "";
  return (
    <div className="flex flex-col gap-1" data-testid="instructions-ai">
      <TextArea
        aria-label="What the AI does"
        rows={6}
        maxLength={AI_TEXT_MAX}
        value={text}
        placeholder="Say what to do, as you would to a new colleague."
        onChange={(e) => onChange({ ...step, ai: { ...step.ai, text: e.target.value } })}
      />
      <span className="text-xs text-ink-muted">
        {text.length} of {AI_TEXT_MAX}
      </span>
    </div>
  );
}
