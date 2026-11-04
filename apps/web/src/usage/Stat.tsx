// The Mezonas StatCard: one figure, its unit, and a short line of what it includes.
import type { ReactNode } from "react";
import { Card } from "../ui/primitives";

export function Stat({
  label,
  value,
  unit,
  note,
  testId,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  note?: ReactNode;
  testId?: string;
}) {
  return (
    <Card className="flex flex-col gap-2 p-5" {...(testId ? { testId } : {})}>
      <span className="eyebrow text-ink-muted">{label}</span>
      <span className="flex items-baseline gap-2">
        <span className="text-[30px] leading-[1.15] font-medium text-ink figures">{value}</span>
        {unit ? <span className="ds-help text-sm">{unit}</span> : null}
      </span>
      {note ? <span className="text-sm text-ink-muted">{note}</span> : null}
    </Card>
  );
}

/** A row of stats that wraps on narrow screens. */
export function StatRow({ children, cols = 4 }: { children: ReactNode; cols?: 3 | 4 }) {
  return (
    <div
      className={`mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 ${cols === 3 ? "xl:grid-cols-3" : "xl:grid-cols-4"}`}
    >
      {children}
    </div>
  );
}
