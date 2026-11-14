// R8 (docs/plan.md §1.86; ARCHITECTURE §10.14 "The Library and the client's settings"): the
// Library's frame, the banks the operator builds from as tabs above each bank's page. The banks
// that had a screen keep it (Skills, Connectors with its website logins); the rest are ./*Bank.tsx.
// The frame loads nothing itself, so a bank's page is the only thing that asks the API.
import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { TextInput } from "../../ui/forms";
import { Tabs } from "../../ui/primitives";
import { BANKS, LIBRARY_PATHS } from "./paths";

export function LibraryFrame({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const items = [
    { to: LIBRARY_PATHS.index, label: "Overview", end: true },
    ...BANKS.map((b) => ({
      to: b.to,
      label: b.title,
      ...(b.also?.some((p) => pathname.startsWith(p)) ? { active: true } : {}),
    })),
  ];
  return (
    <div className="ui-page" data-testid="library">
      <div className="flex flex-col gap-1">
        <p className="eyebrow text-ink-muted">Library</p>
        <Tabs items={items} />
      </div>
      {children}
    </div>
  );
}

/** A bank's search box: the same size and place on every bank. */
export function BankSearch({
  value,
  onChange,
  label,
  testId,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  testId: string;
}) {
  return (
    <div className="w-full sm:w-64">
      <TextInput
        type="search"
        aria-label={label}
        placeholder={label}
        data-testid={testId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
