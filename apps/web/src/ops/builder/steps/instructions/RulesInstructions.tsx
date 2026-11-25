// Rules' instructions (§5): rule rows (when these conditions hold, set these fields) and values.
// A row's conditions are the builder's rule editor; what it sets is field → fixed value.

import { Button } from "../../../../ui/primitives";
import { NO_ERRORS, SmallInput } from "../../fields";
import { RulesEditor } from "../../rules";
import type { InstructionsProps } from "./shared";

type Row = NonNullable<NonNullable<InstructionsProps["step"]["rules"]>["rows"]>[number];

export function RulesInstructions({ step, onChange }: InstructionsProps) {
  const rows = step.rules?.rows ?? [];
  const setRows = (next: Row[]) => onChange({ ...step, rules: { ...step.rules, rows: next } });
  const setRow = (i: number, row: Row) => setRows(rows.map((r, j) => (j === i ? row : r)));
  return (
    <div className="flex flex-col gap-3" data-testid="instructions-rules">
      {rows.map((row, i) => {
        const set = Object.entries(row.set ?? {});
        return (
          <div key={row.id} className="flex flex-col gap-2 border border-line p-3">
            <SmallInput
              aria-label={`Rule ${i + 1} name`}
              placeholder="What this rule does"
              value={row.name ?? ""}
              onChange={(e) => setRow(i, { ...row, name: e.target.value })}
            />
            <RulesEditor
              rules={row.when}
              paths={[]}
              errors={NO_ERRORS}
              prefix={`rules.rows.${i}.when`}
              testPrefix={`rule-${i}`}
              addLabel="Only when…"
              onChange={(when) => setRow(i, { ...row, when })}
            />
            {set.map(([key, value]) => (
              <div key={key} className="flex items-center gap-1.5">
                <span className="w-32 shrink-0 text-sm text-ink">{key}</span>
                <SmallInput
                  aria-label={`Rule ${i + 1} sets ${key}`}
                  value={String(value ?? "")}
                  onChange={(e) =>
                    setRow(i, { ...row, set: { ...row.set, [key]: e.target.value } })
                  }
                />
              </div>
            ))}
            <AddSet onAdd={(key) => setRow(i, { ...row, set: { ...row.set, [key]: "" } })} />
            <Button
              size="sm"
              variant="ghost"
              className="self-start"
              onClick={() => setRows(rows.filter((_, j) => j !== i))}
            >
              Remove this rule
            </Button>
          </div>
        );
      })}
      <Button
        size="sm"
        className="self-start"
        onClick={() =>
          setRows([
            ...rows,
            { id: `rule-${rows.length + 1}`, when: { match: "all", rules: [] } } as Row,
          ])
        }
      >
        Add a rule
      </Button>
    </div>
  );
}

function AddSet({ onAdd }: { onAdd(key: string): void }) {
  return (
    <form
      className="flex items-center gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        const input = e.currentTarget.elements.namedItem("key") as HTMLInputElement;
        if (input.value.trim()) onAdd(input.value.trim());
        input.value = "";
      }}
    >
      <SmallInput
        name="key"
        aria-label="Field to set"
        placeholder="Field to set"
        className="w-40"
      />
      <Button type="submit" size="sm">
        Set it
      </Button>
    </form>
  );
}
