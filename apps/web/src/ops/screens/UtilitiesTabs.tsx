// Utilities (`/ops/utilities/*`): the back office's housekeeping pages, under one sidebar entry
// with a tab each (2026-11-10, the owner, after Plenary Labs' Admin): Feedback, Audit queue (wave
// 6's runs picked for a person to check), Audit log and Requests. Each page keeps its own header,
// with "Utilities" above its title, and these tabs under it.
// DECISION (merge of main): website logins stay in the Library (R8, beside the connectors), so
// they are not a tab here; /ops/utilities/websites redirects to the Library's page.
import { Tabs } from "../../ui/primitives";
import { OPS_PATHS } from "../paths";

export const UTILITIES_TABS = [
  { to: OPS_PATHS.feedback, label: "Feedback" },
  { to: OPS_PATHS.runAudit, label: "Audit queue" },
  { to: OPS_PATHS.audit, label: "Audit log" },
  { to: OPS_PATHS.requests, label: "Requests" },
] as const;

export function UtilitiesTabs() {
  return (
    <div className="-mt-2 mb-2" data-testid="utilities-tabs">
      <Tabs items={UTILITIES_TABS.map((t) => ({ ...t }))} />
    </div>
  );
}
