// Utilities (`/ops/utilities/*`): the back office's housekeeping pages, under one sidebar entry
// with a tab each (2026-11-10, the owner, after Plenary Labs' Admin): Feedback, Audit queue (wave
// 6's runs picked for a person to check) and Requests. The audit log moved to Security (§1.102).
// DECISION (staging QA, 2026-11-22): every page here is titled "Utilities", as the sidebar names it,
// and these tabs under the title say which page it is. A page titled "Feedback" beside the
// sidebar's own feedback tool (Report a problem) read as the same thing.
// DECISION (merge of main): website logins stay in the Library (R8, beside the connectors), so
// they are not a tab here; /ops/utilities/websites redirects to the Library's page.
import { Tabs } from "../../ui/primitives";
import { OPS_PATHS } from "../paths";

export const UTILITIES_TABS = [
  { to: OPS_PATHS.feedback, label: "Feedback" },
  { to: OPS_PATHS.runAudit, label: "Audit queue" },
] as const;

export function UtilitiesTabs() {
  return (
    <div className="-mt-2 mb-2" data-testid="utilities-tabs">
      <Tabs items={UTILITIES_TABS.map((t) => ({ ...t }))} />
    </div>
  );
}
