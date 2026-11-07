// `/ops/connections/:connector/callback`: where a tool's sign-in returns the operator who started it
// from the Sandbox client's Connections page (docs/plan.md §1.5). Passes the provider's parameters to
// the API once, which checks the signed state (the client, this operator, a back-office sign-in),
// then goes to that client's Connections. A refusal stays on the page with a way back.
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApiClient } from "../../api/useApi";
import { buttonClass, ErrorNotice, Loading, PageHeader } from "../../ui/primitives";

export function OpsOAuthCallbackScreen() {
  const api = useApiClient();
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
    api
      .call(apiRoutes.opsSandboxAuthorizeCallback, { params: { connector }, body: { params } })
      .then(
        (res) => navigate(`/ops/clients/${res.clientId}/connections`, { replace: true }),
        (e: unknown) => setError(e),
      );
  }, [api, connector, search, navigate]);

  return (
    <div>
      <PageHeader title="Connecting" subtitle="Finishing your sign-in to the Sandbox's tool." />
      {error ? (
        <div className="flex flex-col gap-3">
          <ErrorNotice error={error} />
          <Link to="/ops/clients" className={buttonClass("secondary", "self-start")}>
            Back to clients
          </Link>
        </div>
      ) : (
        <Loading label="Connecting…" />
      )}
    </div>
  );
}
