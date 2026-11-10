// `/settings/hours`, Business hours (R8, docs/plan.md §1.86; ARCHITECTURE §10.14 "The Library and
// the client's settings"): the client's week (several stretches a day, closed days), its zone, US
// federal holidays on or off, and its closed dates. The default is Monday to Friday, 8am to 6pm.
// The client admin changes them (`PUT /api/settings/business-hours`); everyone on the team reads
// them. The zone is the client's own, set with its details, so it is shown here, never edited:
// the route takes no zone.
import { Link } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { BusinessHoursCard } from "../../hours/HoursParts";
import { useI18n } from "../../i18n/i18n";
import { Loaded } from "../../ui/page";
import { askSloan } from "../paths";

export function PortalBusinessHours({ isAdmin }: { isAdmin: boolean }) {
  const { t } = useI18n();
  const api = useApiClient();
  const state = useApi(apiRoutes.portalBusinessHours);
  return (
    <Loaded state={state}>
      {(data) => (
        <div className="flex flex-col gap-3" data-testid="portal-business-hours-page">
          <BusinessHoursCard
            data={data}
            {...(isAdmin
              ? { onSave: (body) => api.call(apiRoutes.portalSetBusinessHours, { body }) }
              : {})}
            zoneNote={
              // DECISION: the zone is changed with the client's details (by us), so the page
              // asks Sloan rather than offering a zone picker the route would refuse.
              <>
                {t("businessHours.zoneNote")}{" "}
                <Link
                  to={askSloan(t("businessHours.zonePrompt"))}
                  className="text-link hover:underline"
                  data-testid="portal-business-hours-zone-ask"
                >
                  {t("businessHours.zoneLink")}
                </Link>
              </>
            }
            testId="portal-business-hours"
          />
          {isAdmin ? null : (
            <p className="text-sm text-ink-muted" data-testid="portal-business-hours-read-only">
              {t("businessHours.readOnly")}
            </p>
          )}
        </div>
      )}
    </Loaded>
  );
}
