// The back office (`/ops/*`, operator only). App.tsx loads this module lazily, behind the operator
// check, so client users never download it (plan §1.2 "Back office and portal in one app"). The
// workflow builder is a further lazy chunk inside it, loaded when an operator opens a workflow.
// The routes live in ./routes.tsx.
import { Route, Routes } from "react-router-dom";
import { I18nProvider } from "../i18n/i18n";
import { NotFoundPage } from "../ui/primitives";
import { OpsLayout } from "./OpsLayout";
import { opsRoutes } from "./routes";

export default function OpsApp() {
  // The back office stays in English (plan §1.18), whatever the browser or a client reads; the
  // components it shares with the portal render English here.
  return (
    <I18nProvider locale="en">
      <OpsLayout>
        <Routes>
          {opsRoutes}
          {/* An address no screen answers: "Page not found" and the way Home, never "Not built yet". */}
          <Route path="*" element={<NotFoundPage home="/ops" />} />
        </Routes>
      </OpsLayout>
    </I18nProvider>
  );
}
