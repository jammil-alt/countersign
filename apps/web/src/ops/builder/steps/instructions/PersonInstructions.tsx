// A person's instructions (§5): who, approve or ask, the question, the answers offered, how long
// they have, and where it is sent. The deadline is the builder's own editor.

import { Button } from "../../../../ui/primitives";
import { TextArea } from "../../../agents/ui";
import { DeadlineEditor } from "../../deadline";
import { NO_ERRORS, Row, SmallInput, SmallSelect } from "../../fields";
import { PersonPicker } from "../../people";
import type { InstructionsProps } from "./shared";

type Person = NonNullable<InstructionsProps["step"]["person"]>;

export const newPerson = (): Person => ({
  mode: "approve",
  who: "client_admin",
  question: "",
  show: {},
  deadline: { after: "1 day", hours: "clock", ifNoAnswer: "stop" },
  channel: "inbox",
  onReject: "stop",
});

export function PersonInstructions({ step, env, onChange }: InstructionsProps) {
  const p = step.person ?? newPerson();
  const set = (patch: Partial<Person>) => onChange({ ...step, person: { ...p, ...patch } });
  const choices = p.choices ?? [];
  return (
    <div className="flex flex-col gap-3" data-testid="instructions-person">
      <Row label="Who">
        <PersonPicker
          label="Who is asked"
          value={p.who}
          people={env.people}
          field="person.who"
          testId="person-who"
          allowLead
          onChange={(who) => set({ who: who ?? p.who })}
        />
      </Row>
      <Row label="They">
        <SmallSelect
          aria-label="Approve or answer"
          value={p.mode}
          onChange={(e) => set({ mode: e.target.value as Person["mode"] })}
        >
          <option value="approve">Approve or reject</option>
          <option value="ask">Answer a question</option>
        </SmallSelect>
      </Row>
      <Row label="The question">
        <TextArea
          aria-label="The question"
          rows={3}
          value={p.question}
          onChange={(e) => set({ question: e.target.value })}
        />
      </Row>
      {p.mode === "ask" ? (
        <Row label="Answers offered" hint="Leave empty for a free answer.">
          <div className="flex flex-col gap-1.5">
            {choices.map((c, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: choices are edited in place.
              <div key={i} className="flex items-center gap-1.5">
                <SmallInput
                  aria-label={`Answer ${i + 1}`}
                  value={typeof c.label === "string" ? c.label : (c.label.en ?? "")}
                  onChange={(e) =>
                    set({
                      choices: choices.map((x, j) =>
                        j === i
                          ? {
                              value: e.target.value.replace(/[^A-Za-z0-9_-]+/g, "-") || `a${i + 1}`,
                              label: e.target.value,
                            }
                          : x,
                      ),
                    })
                  }
                />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => set({ choices: choices.filter((_, j) => j !== i) })}
                >
                  Remove
                </Button>
              </div>
            ))}
            {choices.length < 6 ? (
              <Button
                size="sm"
                className="self-start"
                onClick={() =>
                  set({ choices: [...choices, { value: `a${choices.length + 1}`, label: "" }] })
                }
              >
                Add an answer
              </Button>
            ) : null}
          </div>
        </Row>
      ) : null}
      <DeadlineEditor
        value={p.deadline}
        prefix="person.deadline"
        testId="person-deadline"
        errors={NO_ERRORS}
        people={env.people}
        proceedBlocked={null}
        onChange={(deadline) => set({ deadline })}
      />
      <Row label="Sent by">
        <SmallSelect
          aria-label="Sent by"
          value={p.channel}
          onChange={(e) => set({ channel: e.target.value as Person["channel"] })}
        >
          <option value="inbox">Inbox</option>
          <option value="email">Email</option>
        </SmallSelect>
      </Row>
      <Row label="If they say no">
        <SmallSelect
          aria-label="If they say no"
          value={p.onReject}
          onChange={(e) => set({ onReject: e.target.value as Person["onReject"] })}
        >
          <option value="stop">Stop the run</option>
          <option value="continue">Go on</option>
        </SmallSelect>
      </Row>
    </div>
  );
}
