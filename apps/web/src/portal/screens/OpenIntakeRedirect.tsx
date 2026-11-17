import { portalIntakeRoutes } from "@countersign/core";
import { Navigate } from "react-router-dom";
import { useApi } from "../../api/useApi";
import { PORTAL_PATHS } from "../paths";

/**
 * §1.126.2: while an intake is open and no agent is live, Getting started is the client's home.
 * Home loads this only when no agent is live, so the intake's route contract (and the guide's
 * schemas) stay out of the web's first load (scripts/web-size.mjs). A failed ask leaves Home as it is.
 */
export function OpenIntakeRedirect() {
  const intake = useApi(portalIntakeRoutes.portalCurrentIntake, {});
  return intake.data?.intake ? <Navigate to={PORTAL_PATHS.start} replace /> : null;
}
