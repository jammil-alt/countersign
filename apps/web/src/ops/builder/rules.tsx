// The rule-row editor (ARCHITECTURE §10.5): IF field op value, AND/OR, + Add condition. One editor
// for an if's paths, a trigger's filter and, since R8, every check's condition ("confer when the
// total is over $5,000") and a skill's rule rows. Conditions are plain rules over the run, never a
// model (§10.14 "Checks").
import type { PathOption, Rule, RuleOp, Rules } from "@countersign/core";
import { Icon } from "../../ui/icons";
import { type FieldErrors, SmallInput, SmallSelect, TemplateInput } from "./fields";

const OPS: { op: RuleOp; label: string }[] = [
  { op: ">", label: ">" },
  { op: ">=", label: "≥" },
  { op: "<", label: "<" },
  { op: "<=", label: "≤" },
  { op: "=", label: "=" },
  { op: "!=", label: "≠" },
  { op: "contains", label: "contains" },
  { op: "in", label: "in" },
  { op: "is", label: "is" },
  { op: "exists", label: "exists" },
];

/** What a rule's value box holds: numbers and true/false/null as such, lists for `in`. */
export function parseRuleValue(text: string, op: RuleOp): unknown {
  const one = (t: string): unknown => {
    const s = t.trim();
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    if (s === "true") return true;
    if (s === "false") return false;
    if (s === "null") return null;
    return t;
  };
  if (op === "in") {
    return text
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
      .map(one);
  }
  return text === "" ? undefined : one(text);
}

export function ruleValueText(value: unknown): string {
  if (value === undefined) return "";
  if (Array.isArray(value)) return value.map((v) => String(v)).join(", ");
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export const NO_RULES: Rules = { match: "all", rules: [] };

/** Rule rows for one path, a trigger filter or a check's condition. */
export function RulesEditor({
  rules,
  onChange,
  paths,
  errors,
  prefix,
  testPrefix,
  addLabel = "Add condition",
}: {
  rules: Rules;
  onChange(rules: Rules, key: string): void;
  paths: readonly PathOption[];
  errors: FieldErrors;
  /** "when" for a path, "on.filter" for a trigger, "checks.approval.when" for a check. */
  prefix: string;
  testPrefix: string;
  addLabel?: string;
}) {
  const setRule = (i: number, rule: Rule, key: string) =>
    onChange({ ...rules, rules: rules.rules.map((r, j) => (j === i ? rule : r)) }, key);
  return (
    <div className="flex flex-col gap-2">
      {rules.rules.map((rule, i) => {
        const at = `${prefix}.rules.${i}`;
        const messages = [
          ...errors.at(`${at}.field`),
          ...errors.at(`${at}.op`),
          ...errors.at(`${at}.value`),
        ];
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: rules have no ids; their order is their identity.
          <div key={i} className="flex flex-col gap-1" data-testid={`${testPrefix}-rule-${i}`}>
            <div className="flex items-center gap-1.5">
              <span className="w-7 shrink-0 eyebrow text-ink-muted">
                {i === 0 ? "IF" : rules.match === "any" ? "OR" : "AND"}
              </span>
              <div className="min-w-0 flex-1">
                <TemplateInput
                  field={`${at}.field`}
                  testId={`${testPrefix}-rule-${i}-field`}
                  value={rule.field}
                  paths={paths}
                  placeholder="{{steps.…}}"
                  invalid={errors.at(`${at}.field`).length > 0}
                  onChange={(field) => setRule(i, { ...rule, field }, `${at}.field`)}
                />
              </div>
            </div>
            <div className="flex items-center gap-1.5 pl-8">
              <SmallSelect
                aria-label="Operator"
                data-field={`${at}.op`}
                data-testid={`${testPrefix}-rule-${i}-op`}
                value={rule.op}
                className="w-28 shrink-0"
                onChange={(e) => {
                  const op = e.target.value as RuleOp;
                  const { value: _v, ...rest } = rule;
                  setRule(i, op === "exists" ? { ...rest, op } : { ...rule, op }, `${at}.op`);
                }}
              >
                {OPS.map((o) => (
                  <option key={o.op} value={o.op}>
                    {o.label}
                  </option>
                ))}
              </SmallSelect>
              {rule.op === "exists" ? (
                <span className="flex-1" />
              ) : (
                <SmallInput
                  aria-label="Value"
                  data-field={`${at}.value`}
                  data-testid={`${testPrefix}-rule-${i}-value`}
                  value={ruleValueText(rule.value)}
                  invalid={errors.at(`${at}.value`).length > 0}
                  className="min-w-0 flex-1 font-mono"
                  onChange={(e) => {
                    const value = parseRuleValue(e.target.value, rule.op);
                    const { value: _v, ...rest } = rule;
                    setRule(i, value === undefined ? rest : { ...rule, value }, `${at}.value`);
                  }}
                />
              )}
              <button
                type="button"
                aria-label="Remove condition"
                data-testid={`${testPrefix}-rule-${i}-remove`}
                onClick={() =>
                  onChange({ ...rules, rules: rules.rules.filter((_, j) => j !== i) }, "rules")
                }
                className="ds-btn ds-btn--ghost ds-btn--icon ds-btn--sm shrink-0 text-ink-muted hover:text-ink"
              >
                <Icon name="close" />
              </button>
            </div>
            {messages.map((m) => (
              <span key={m} className="pl-8 text-xs text-risk">
                {m}
              </span>
            ))}
          </div>
        );
      })}
      {errors.at(`${prefix}.rules`).map((m) => (
        <span key={m} className="text-xs text-risk">
          {m}
        </span>
      ))}
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          data-field={`${prefix}.rules`}
          data-testid={`${testPrefix}-add-condition`}
          onClick={() =>
            onChange(
              { ...rules, rules: [...rules.rules, { field: "", op: "=", value: "" }] },
              "rules",
            )
          }
          className="ds-btn ds-btn--link text-sm"
        >
          <Icon name="add" />
          {addLabel}
        </button>
        {rules.rules.length > 1 ? (
          <SmallSelect
            aria-label="Match"
            data-testid={`${testPrefix}-match`}
            value={rules.match}
            className="w-36"
            onChange={(e) =>
              onChange({ ...rules, match: e.target.value as "all" | "any" }, "match")
            }
          >
            <option value="all">Match all</option>
            <option value="any">Match any</option>
          </SmallSelect>
        ) : null}
      </div>
    </div>
  );
}
