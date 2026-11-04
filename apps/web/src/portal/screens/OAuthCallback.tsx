// `/connections/:connector/callback`: where a tool's sign-in (Zoho, later QuickBooks) sends the
// client back. Passes the provider's parameters to the API once, which checks the state against
// this session, then returns to Connections.
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApiClient } from "../../api/useApi";
import { useI18n } from "../../i18n/i18n";
import { buttonClass, ErrorNotice, Loading, PageHeader } from "../../ui/primitives";

export function OAuthCallbackScreen() {
  const api = useApiClient();
  const { t } = useI18n();
  const { connector = "" } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState<unknown>(null);
  // A code works once: don't send it twice (React may run effects twice in development).
  const sent = useRef(false);

  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    const params = Object.fromEntries(search.entries());
    api.call(apiRoutes.portalAuthorizeCallback, { params: { connector }, body: { params } }).then(
      () => navigate("/connections", { replace: true }),
      (e: unknown) => setError(e),
    );
  }, [api, connector, search, navigate]);

  return (
    <div>
      <PageHeader title={t("callback.title")} subtitle={t("callback.subtitle")} />
      {error ? (
        <div className="flex flex-col gap-3">
          <ErrorNotice error={error} />
          <Link to="/connections" className={buttonClass("secondary", "self-start")}>
            {t("callback.back")}
          </Link>
        </div>
      ) : (
        <Loading label={t("callback.connecting")} />
      )}
    </div>
  );
}
