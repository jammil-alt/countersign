// A client's time zone, picked from the IANA zones the browser knows rather than typed, so a
// misspelt zone can't be saved (the API checks it again: IanaTimeZone in packages/core).
import { timeZoneChoices } from "@countersign/core";
import { type SelectHTMLAttributes, useMemo } from "react";
import { Select } from "./forms";

/** "America/Argentina/Buenos_Aires" → "America / Argentina / Buenos Aires". */
export function timeZoneLabel(zone: string): string {
  return zone.replace(/_/g, " ").split("/").join(" / ");
}

export function TimeZoneSelect({
  value,
  onChange,
  ...rest
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, "value" | "onChange"> & {
  value: string;
  onChange: (zone: string) => void;
  invalid?: boolean;
}) {
  // DECISION (QA, runs and dates): the zone is a select of `Intl.supportedValuesOf("timeZone")`,
  // UTC first then A to Z by IANA name; the saved zone stays a choice even if the browser's list
  // leaves it out.
  const zones = useMemo(() => timeZoneChoices(value), [value]);
  return (
    <Select {...rest} value={value} onChange={(e) => onChange(e.target.value)}>
      {zones.map((z) => (
        <option key={z} value={z}>
          {timeZoneLabel(z)}
        </option>
      ))}
    </Select>
  );
}
