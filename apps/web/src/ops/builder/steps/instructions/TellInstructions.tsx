// Tell's instructions (§5): to whom, by which channel, and what it says. A Tell never waits.

import { SmallInput, SmallSelect } from "../../fields";
import { PeopleList } from "../../people";
import type { InstructionsProps } from "./shared";

export function TellInstructions({ step, env, onChange }: InstructionsProps) {
  const tell = step.tell ?? { to: [], channel: "inbox" as const, message: "" };
  const set = (patch: Partial<typeof tell>) => onChange({ ...step, tell: { ...tell, ...patch } });
  return (
    <div className="flex flex-col gap-2" data-testid="instructions-tell">
      <span className="text-sm font-medium text-ink">Tell</span>
      <PeopleList
        value={tell.to}
        people={env.people}
        field="tell.to"
        testId="tell-to"
        max={10}
        onChange={(to) => set({ to })}
      />
      <SmallSelect
        aria-label="Tell by"
        value={tell.channel}
        onChange={(e) => set({ channel: e.target.value as typeof tell.channel })}
      >
        <option value="inbox">Inbox</option>
        <option value="email">Email</option>
        <option value="sms">Text</option>
      </SmallSelect>
      <SmallInput
        aria-label="What it says"
        placeholder="What it says"
        value={tell.message}
        onChange={(e) => set({ message: e.target.value })}
      />
    </div>
  );
}
