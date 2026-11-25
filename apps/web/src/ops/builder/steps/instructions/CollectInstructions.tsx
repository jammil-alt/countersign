// Collect reports (§5): the reports people send. Kept to the few things a report needs; the
// rest take the schema's defaults (monthly, pdf or spreadsheet, followed up).

import { processes, uuidv7 } from "@countersign/core";
import { Button } from "../../../../ui/primitives";
import { Row, SmallInput } from "../../fields";
import { PersonPicker } from "../../people";
import type { InstructionsProps } from "./shared";

type Collect = NonNullable<InstructionsProps["step"]["collect"]>;

export function newReport(n: number): Collect["items"][number] {
  return processes.CollectItem.parse({
    id: uuidv7(),
    name: `Report ${n}`,
    owner: "seat:client_admin",
    due: "3 days",
  });
}

export function CollectInstructions({ step, env, onChange }: InstructionsProps) {
  const c: Collect = step.collect ?? { items: [], ifMissing: "stop" };
  const set = (patch: Partial<Collect>) => onChange({ ...step, collect: { ...c, ...patch } });
  const setItem = (i: number, patch: Partial<Collect["items"][number]>) =>
    set({ items: c.items.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  return (
    <div className="flex flex-col gap-3" data-testid="instructions-collect">
      {c.items.map((item, i) => (
        <div key={item.id} className="flex flex-col gap-2 border border-line p-3">
          <SmallInput
            aria-label={`Report ${i + 1} name`}
            value={item.name}
            onChange={(e) => setItem(i, { name: e.target.value })}
          />
          <Row label="Sent by">
            <PersonPicker
              label={`Report ${i + 1} sent by`}
              value={item.owner.replace(/^seat:/, "")}
              people={env.people}
              field={`collect.items.${i}.owner`}
              testId={`collect-owner-${i}`}
              onChange={(who) => setItem(i, { owner: who ?? item.owner })}
            />
          </Row>
          <Row label="Due after the step starts">
            <SmallInput
              aria-label={`Report ${i + 1} due`}
              className="w-40"
              value={item.due}
              onChange={(e) => setItem(i, { due: e.target.value })}
            />
          </Row>
          <Button
            size="sm"
            variant="ghost"
            className="self-start"
            onClick={() => set({ items: c.items.filter((_, j) => j !== i) })}
          >
            Remove this report
          </Button>
        </div>
      ))}
      <Button
        size="sm"
        className="self-start"
        onClick={() => set({ items: [...c.items, newReport(c.items.length + 1)] })}
      >
        Add a report
      </Button>
    </div>
  );
}
