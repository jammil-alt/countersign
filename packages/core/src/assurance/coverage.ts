// Every register control, for one agent, in one of three states (docs/agent-assurance-plan.md §4a;
// owner, 2026-11-21: "Are all controls highlighted?"): checked for this agent by a check of
// `CHECKS`, inherited from the platform (the same for every agent, with the register's status),
// or not applicable, with why. A test holds the lists to the register: a new control must be
// placed here, or it fails.

import { CONTROLS, type Control, type ControlStatus } from "../compliance/controls";
import { CHECKS } from "./checks";

export const COVERAGE_STATES = ["checked", "inherited", "not_applicable"] as const;
export type CoverageState = (typeof COVERAGE_STATES)[number];

/** The same for every agent: proved for the platform, shown with the register's status. */
export const INHERITED_CONTROLS: readonly string[] = [
  "GOV-1",
  "GOV-2",
  "GOV-3",
  "GOV-4",
  "GOV-5",
  "GOV-6",
  "ACC-1",
  "ACC-3",
  "ACC-5",
  "ISO-3",
  "DAT-1",
  "DAT-2",
  "DAT-4",
  "LOG-2",
  "LOG-3",
  "CHG-1",
  "CHG-2",
  "CHG-3",
  "CHG-4",
  "CHG-5",
  "CHG-6",
  "CHG-7",
  "CHG-8",
  "INC-1",
  "INC-2",
  "BCK-1",
  "BCK-2",
  "VEN-2",
  "LIF-2",
];

/** Controls that don't apply to an agent's work, with why; `hipaa` decides VEN-4. */
export function notApplicable(hipaa: boolean): { id: string; why: string }[] {
  return [
    { id: "DAT-5", why: "It takes no card payments" },
    { id: "LIF-1", why: "Checked when a client leaves" },
    ...(hipaa ? [] : [{ id: "VEN-4", why: "A BAA with you, needed only in HIPAA mode" }]),
  ];
}

/** The register's controls a check of `CHECKS` proves. */
export function checkedControls(): string[] {
  return [...new Set(CHECKS.flatMap((c) => c.controls))];
}

export type CoverageEntry = {
  id: string;
  title: string;
  state: CoverageState;
  /** The register's status: in place, partly, planned. */
  status: ControlStatus;
  why: string | null;
  soc2: readonly string[];
  hipaa: readonly string[];
};

/** Every register control in its state, in the register's order. */
export function agentCoverage(
  hipaa: boolean,
  controls: readonly Control[] = CONTROLS,
): CoverageEntry[] {
  const checked = new Set(checkedControls());
  const na = new Map(notApplicable(hipaa).map((x) => [x.id, x.why]));
  const inherited = new Set([...INHERITED_CONTROLS, ...(hipaa ? ["VEN-4"] : [])]);
  return controls.map((c) => {
    const state: CoverageState = checked.has(c.id)
      ? "checked"
      : na.has(c.id)
        ? "not_applicable"
        : "inherited";
    if (state === "inherited" && !inherited.has(c.id)) {
      throw new Error(`register control ${c.id} isn't placed for agents (assurance/coverage.ts)`);
    }
    return {
      id: c.id,
      title: c.title,
      state,
      status: c.status,
      why: na.get(c.id) ?? null,
      soc2: c.maps.soc2 ?? [],
      hipaa: hipaa ? (c.maps.hipaa ?? []) : [],
    };
  });
}

/** A control's SOC 2 criteria, and HIPAA sections for a client in HIPAA mode (§6, "Standards"). */
export function controlRefs(
  ids: readonly string[],
  hipaa: boolean,
  controls: readonly Control[] = CONTROLS,
) {
  const soc2 = new Set<string>();
  const hip = new Set<string>();
  for (const id of ids) {
    const c = controls.find((x) => x.id === id);
    for (const r of c?.maps.soc2 ?? []) soc2.add(r);
    if (hipaa) for (const r of c?.maps.hipaa ?? []) hip.add(r);
  }
  return { soc2: [...soc2], hipaa: [...hip] };
}
