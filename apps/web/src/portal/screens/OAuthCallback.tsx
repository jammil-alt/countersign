// `/connections/:connector/callback`: where a tool's sign-in (Zoho, later QuickBooks) sends the
// client back. Passes the provider's parameters to the API once, which checks the state against
// this session, then returns to Connections.
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApiClient } from "../../api/useApi";
import { openPlaidLink, pendingLink } from "../../connections/plaidLink";
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
    // v0.12 bankfeed: a bank that signs in by OAuth sends the person back here mid-Link; Link
    // opens again with the token this tab kept, and its result goes to the callback route.
    if (connector === "bankfeed" && search.has("oauth_state_id")) {
      const pending = pendingLink();
      if (!pending) {
        setError(new Error(t("callback.linkLost")));
        return;
      }
      openPlaidLink(pending, window.location.href)
        .then((done) =>
          done
            ? api.call(apiRoutes.portalAuthorizeCallback, {
                params: { connector },
                body: { params: { public_token: done.publicToken, state: done.state } },
              })
            : null,
        )
        .then(
          () => navigate("/accounts", { replace: true }),
          (e: unknown) => setError(e),
        );
      return;
    }
    const params = Object.fromEntries(search.entries());
    api.call(apiRoutes.portalAuthorizeCallback, { params: { connector }, body: { params } }).then(
      () => navigate("/accounts", { replace: true }),
      (e: unknown) => setError(e),
    );
  }, [api, connector, search, navigate, t]);

  return (
    <div>
      <PageHeader title={t("callback.title")} subtitle={t("callback.subtitle")} />
      {error ? (
        <div className="flex flex-col gap-3">
          <ErrorNotice error={error} />
          <Link to="/accounts" className={buttonClass("secondary", "self-start")}>
            {t("callback.back")}
          </Link>
        </div>
      ) : (
        <Loading label={t("callback.connecting")} />
      )}
    </div>
  );
}
