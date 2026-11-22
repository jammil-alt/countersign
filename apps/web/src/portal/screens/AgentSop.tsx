// The agent page's SOP tab (docs/sop-plan.md S1; owner, 2026-11-21: it takes the Manual tab's
// place): the agent's SOP as the client reads it, from the portal's own route (a view made by code:
// never the bundle, instructions, prompts or cost, invariant 11). "Ask about this" opens Sloan with
// the line quoted; "This is wrong" sends a request about the line to us, as the manual's did.
// Section 14, architecture and security (docs/agent-assurance-plan.md §5), comes from its own route,
// so the SOP shows at once and the checks follow.

import { assuranceRoutes, sopRoutes } from "@countersign/core";
import { Link } from "react-router-dom";
import { useApi } from "../../api/useApi";
import { AssuranceBody } from "../../assurance/AssuranceView";
import { useI18n } from "../../i18n/i18n";
import { SopDocument } from "../../sop/SopDocument";
import { Loaded } from "../../ui/page";
import { SkeletonRows } from "../../ui/skeleton";
import { askSloan, PORTAL_PATHS } from "../paths";
import { WrongForm } from "./LineFeedback";

function SecuritySection({ id }: { id: string }) {
  const assurance = useApi(assuranceRoutes.portalAgentAssurance, { params: { id } });
  return (
    <Loaded state={assurance} skeleton={<SkeletonRows rows={6} columns={1} />}>
      {(view) => <AssuranceBody view={view} audience="client" />}
    </Loaded>
  );
}

export function AgentSop({ id }: { id: string }) {
  const { t } = useI18n();
  const sop = useApi(sopRoutes.portalAgentSop, { params: { id } });
  return (
    <div data-testid="portal-agent-sop">
      {/* S2: every agent's SOP in a row, with filters across them. */}
      <p className="mb-3 text-sm" data-print="hide">
        <Link
          to={PORTAL_PATHS.procedures}
          className="ds-btn ds-btn--link"
          data-testid="sop-all-procedures"
        >
          {t("procedures.link")}
        </Link>
      </p>
      <Loaded state={sop} skeleton={<SkeletonRows rows={8} columns={1} />}>
        {(view) => (
          <SopDocument
            view={view}
            askHref={(line) => askSloan(t("sop.askText", { agent: view.agent.name, line }))}
            wrong={(line, close) => <WrongForm agentId={id} line={line} onClose={close} />}
            security={{ title: t("assurance.sec"), node: <SecuritySection id={id} /> }}
          />
        )}
      </Loaded>
    </div>
  );
}
