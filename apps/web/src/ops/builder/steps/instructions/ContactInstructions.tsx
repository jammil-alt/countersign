// An outside contact's instructions (§5): who, the channel, the goal, what may be shared, the most
// turns, and whether each message needs approval first.

import { TextArea } from "../../../agents/ui";
import { Row, SmallInput, SmallSelect } from "../../fields";
import type { InstructionsProps } from "./shared";

type Contact = NonNullable<InstructionsProps["step"]["contact"]>;

export const newContact = (): Contact => ({
  with: "",
  channel: "email",
  goal: "",
  mayShare: [],
  maxTurns: 4,
  messages: { first: "required", later: "required" },
  deadline: { after: "3 days", hours: "clock", ifNoAnswer: "stop" },
});

export function ContactInstructions({ step, onChange }: InstructionsProps) {
  const c = step.contact ?? newContact();
  const set = (patch: Partial<Contact>) => onChange({ ...step, contact: { ...c, ...patch } });
  return (
    <div className="flex flex-col gap-3" data-testid="instructions-contact">
      <Row label="Who with">
        <SmallInput
          aria-label="Who with"
          value={c.with}
          placeholder="The vendor's contact, {{…}}"
          onChange={(e) => set({ with: e.target.value })}
        />
      </Row>
      <Row label="By">
        <SmallSelect
          aria-label="Channel"
          value={c.channel}
          onChange={(e) => set({ channel: e.target.value as Contact["channel"] })}
        >
          <option value="email">Email</option>
          <option value="sms">Text</option>
          <option value="whatsapp">WhatsApp</option>
          <option value="call">Call</option>
        </SmallSelect>
      </Row>
      <Row label="The goal">
        <TextArea
          aria-label="The goal"
          rows={3}
          value={c.goal}
          onChange={(e) => set({ goal: e.target.value })}
        />
      </Row>
      <Row label="May share" hint="One thing per line.">
        <TextArea
          aria-label="May share"
          rows={2}
          value={c.mayShare.join("\n")}
          onChange={(e) => set({ mayShare: e.target.value.split("\n").filter((l) => l.trim()) })}
        />
      </Row>
      <Row label="Most turns">
        <SmallInput
          aria-label="Most turns"
          type="number"
          min={1}
          max={20}
          className="w-24"
          value={c.maxTurns}
          onChange={(e) =>
            set({ maxTurns: Math.min(20, Math.max(1, Number(e.target.value) || 1)) })
          }
        />
      </Row>
      <Row
        label="Approve each message"
        hint="Every message is an approved send unless you say otherwise."
      >
        <div className="flex gap-2">
          <SmallSelect
            aria-label="First message"
            value={c.messages.first}
            onChange={(e) =>
              set({
                messages: { ...c.messages, first: e.target.value as Contact["messages"]["first"] },
              })
            }
          >
            <option value="required">First message: ask first</option>
            <option value="not_required">First message: send</option>
          </SmallSelect>
          <SmallSelect
            aria-label="Later messages"
            value={c.messages.later}
            onChange={(e) =>
              set({
                messages: { ...c.messages, later: e.target.value as Contact["messages"]["later"] },
              })
            }
          >
            <option value="required">Later messages: ask first</option>
            <option value="within_goal">Later messages: send within the goal</option>
          </SmallSelect>
        </div>
      </Row>
    </div>
  );
}
