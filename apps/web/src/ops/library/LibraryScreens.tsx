// R8: the banks that already had a screen, inside the Library's frame: the skills library (its
// automations are processes here, so the Processes bank shows them), the connectors catalog and
// the website logins (a site is a connector too). One component each, so the route map keeps one
// line per route.
import { OpsBrowserSitesScreen } from "../screens/BrowserSites";
import { OpsConnectorsScreen } from "../screens/Connectors";
import { SkillsScreen } from "../skills/SkillsLibrary";
import { LibraryFrame } from "./LibraryFrame";

export function LibrarySkills() {
  return (
    <LibraryFrame>
      <SkillsScreen automations={false} />
    </LibraryFrame>
  );
}

export function LibraryConnectors() {
  return (
    <LibraryFrame>
      <OpsConnectorsScreen />
    </LibraryFrame>
  );
}

export function LibraryBrowserSites() {
  return (
    <LibraryFrame>
      <OpsBrowserSitesScreen />
    </LibraryFrame>
  );
}
