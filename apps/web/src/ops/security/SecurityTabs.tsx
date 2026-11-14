// The Security section's tabs (docs/plan.md §1.100), shared by its pages and the audit log.
import { Tabs } from "../../ui/primitives";
import { SECURITY_PATHS } from "./paths";

export const SECURITY_TABS = [
  { to: SECURITY_PATHS.overview, label: "Overview", end: true },
  { to: SECURITY_PATHS.controls, label: "Controls" },
  { to: SECURITY_PATHS.vendors, label: "Vendors" },
  { to: SECURITY_PATHS.policies, label: "Policies and routines" },
  { to: SECURITY_PATHS.clients, label: "Clients" },
  { to: SECURITY_PATHS.audit, label: "Audit log" },
] as const;

export function SecurityTabs() {
  return (
    <div className="-mt-2 mb-6" data-testid="security-tabs" data-print="hide">
      <Tabs items={SECURITY_TABS.map((t) => ({ ...t }))} />
    </div>
  );
}
