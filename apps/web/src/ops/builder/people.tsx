// Who a step asks or tells (ARCHITECTURE §10.14 "Checks", "The Library and the client's settings"):
// a role (the client admin, a client user, the lead, us), or someone on the client's People list,
// a user of the client or a directory contact, by id. Approvers, conferees and notice recipients
// are picked here. The list is the client's own (GET /api/ops/clients/:id/hours, which lists the
// People with their hours); a template has only the roles.
import { cx } from "../../ui/primitives";
import { SmallSelect } from "./fields";

export interface Member {
  userId: string;
  email: string;
  name: string | null;
  role: string;
}

/** Someone on the client's People list. */
export interface PersonOption {
  id: string;
  name: string;
  kind: "user" | "contact";
}

export interface People {
  members: readonly Member[];
  /** The client's People list (users and contacts); empty for a template. */
  people: readonly PersonOption[];
}

export const NO_PEOPLE: People = { members: [], people: [] };

const ROLES: { value: string; label: string }[] = [
  { value: "client_admin", label: "Client admin" },
  { value: "client_user", label: "Client user" },
  { value: "operator", label: "Operator" },
];

/** A person's name by id, or a role's label; undefined when nobody by that id is known. */
export function personName(people: People, id: string): string | undefined {
  const role = ROLES.find((r) => r.value === id)?.label;
  if (role) return role;
  if (id === "lead") return "The client's lead";
  const m = people.members.find((x) => x.userId === id);
  if (m) return m.name ?? m.email;
  return people.people.find((p) => p.id === id)?.name;
}

/** The team (users) and, where allowed, the directory's contacts, each once. */
function choices(people: People, contacts: boolean) {
  const users = new Map<string, string>();
  for (const m of people.members) users.set(m.userId, m.name ?? m.email);
  for (const p of people.people) if (p.kind === "user" && !users.has(p.id)) users.set(p.id, p.name);
  const others = contacts ? people.people.filter((p) => p.kind === "contact") : [];
  return { users: [...users], contacts: others };
}

/** A role or one of the client's people. */
export function PersonPicker({
  value,
  onChange,
  people,
  field,
  testId,
  allowDefault,
  allowLead,
  allowContacts,
  invalid,
  className,
  label,
}: {
  value: string | undefined;
  onChange(value: string | undefined): void;
  people: People;
  field: string;
  testId: string;
  /** The empty choice's words (the default approver, "Add someone"); absent: no empty choice. */
  allowDefault?: string | undefined;
  /** v0.12 W1-C: a person step may be a lead check, for the client's lead. */
  allowLead?: boolean | undefined;
  /** Directory contacts (a conferee may be one); approvers and recipients are the team. */
  allowContacts?: boolean | undefined;
  invalid?: boolean | undefined;
  className?: string | undefined;
  label?: string | undefined;
}) {
  const { users, contacts } = choices(people, allowContacts === true);
  const known =
    value === undefined ||
    value === "" ||
    ROLES.some((r) => r.value === value) ||
    (allowLead === true && value === "lead") ||
    users.some(([id]) => id === value) ||
    contacts.some((c) => c.id === value);
  return (
    <SmallSelect
      aria-label={label}
      data-field={field}
      data-testid={testId}
      value={value ?? ""}
      invalid={invalid === true}
      className={className}
      onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
    >
      {allowDefault ? <option value="">{allowDefault}</option> : null}
      <optgroup label="Roles">
        {ROLES.map((r) => (
          <option key={r.value} value={r.value}>
            {r.label}
          </option>
        ))}
        {allowLead ? <option value="lead">The client's lead</option> : null}
      </optgroup>
      {users.length ? (
        <optgroup label="The client's team">
          {users.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </optgroup>
      ) : null}
      {contacts.length ? (
        <optgroup label="Contacts">
          {contacts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </optgroup>
      ) : null}
      {known ? null : <option value={value}>{value}</option>}
    </SmallSelect>
  );
}

/** Several people (a notice's recipients, who is told when a deadline passes). */
export function PeopleList({
  value,
  onChange,
  people,
  field,
  testId,
  max,
  allowLead,
  invalid,
}: {
  value: readonly string[];
  onChange(value: string[]): void;
  people: People;
  field: string;
  testId: string;
  max: number;
  allowLead?: boolean | undefined;
  invalid?: boolean | undefined;
}) {
  return (
    <div className="flex flex-col gap-1.5" data-field={field} data-testid={testId} tabIndex={-1}>
      {value.length ? (
        <ul className="flex flex-wrap gap-1.5">
          {value.map((who, i) => (
            <li
              key={who}
              className={cx(
                "ds-pill flex items-center gap-1 border px-2 py-0.5 text-xs",
                invalid ? "border-risk" : "border-line",
              )}
            >
              {personName(people, who) ?? who}
              <button
                type="button"
                aria-label={`Remove ${personName(people, who) ?? who}`}
                data-testid={`${testId}-remove-${i}`}
                className="text-ink-muted hover:text-ink"
                onClick={() => onChange(value.filter((x) => x !== who))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {value.length < max ? (
        <PersonPicker
          label="Add someone"
          field={`${field}.add`}
          testId={`${testId}-add`}
          value=""
          people={people}
          allowDefault="Add someone…"
          allowLead={allowLead}
          onChange={(v) => {
            if (v && !value.includes(v)) onChange([...value, v]);
          }}
        />
      ) : null}
    </div>
  );
}
