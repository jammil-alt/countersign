// The one line under the builder's bar that says whose agent this is and what it owes its
// template (docs/builder-plan.md §12.1; docs/plan.md §1.170).
//
// A client's agent: "From the template Clerk · v3"; "Customized: 2 steps changed, 1 added" (opens
// the list the host passes); "Template v4 is out · Review the update" (the merge screen, where a
// person reviews it: invariant 11); "Offer to the template" (a promotion, the same screen); Detach,
// or Relink once detached. A template: "Runs at 3 clients" (opens Where it runs), "2 behind", and
// "Assign to a client" (a fork: that client's own draft). Publishing a template changes no
// client's agent, and nothing here writes to one except its own Detach and Relink.
//
// It reads what the agent page already has (GET /api/ops/agents/:id for the agent and, for a
// client's agent, for its template) and asks only for the template's copies (used-by) and whether
// the client's saved version differs from its base (customizations).
import { type ReactNode, useState } from "react";
import { Link } from "react-router-dom";
import type { ResponseOf } from "../../../api/client";
import { type AgentSummary, apiRoutes } from "../../../api/routes";
import { useApi } from "../../../api/useApi";
import { Badge, Button, cx } from "../../../ui/primitives";
import { baseTemplateVersion } from "../../agents/Lineage";
import { errorText, Notice, Select, useAction } from "../../agents/ui";
import { AssignForm, WhereItRuns } from "../../lab/TemplateParts";
import { plural } from "../status";
import "../flow.css";
import { customizedLine } from "./CustomizationsList";

type AgentDetail = ResponseOf<typeof apiRoutes.opsAgent>;

export interface LineageStripProps {
  agent: AgentSummary;
  /** GET /api/ops/agents/:id for this agent. */
  detail: Pick<AgentDetail, "live" | "latest" | "update">;
  /** A client agent's template (GET /api/ops/agents/:templateId), once the page has it. */
  template?: Pick<AgentDetail, "agent" | "versions"> | null | undefined;
  /** A client agent's draft against its template: `customizedSteps` from ../../builder/model. */
  customized?: ReadonlyMap<string, "changed" | "added"> | undefined;
  /** What "Customized" opens under the strip: the host's <CustomizationsList />. */
  customizations?: ReactNode;
  /** Controls what is open under the strip; the strip keeps it itself when absent. */
  open?: LineagePanel | null | undefined;
  onOpen?: ((panel: LineagePanel | null) => void) | undefined;
  /** After Detach or Relink: the host reloads the agent. */
  onChanged?: (() => void) | undefined;
}

/** What is open under the strip. */
export type LineagePanel = "customizations" | "runs" | "assign" | "relink";

export function LineageStrip(props: LineageStripProps) {
  const [own, setOwn] = useState<LineagePanel | null>(null);
  const open = props.open !== undefined ? props.open : own;
  const toggle = (panel: LineagePanel) => {
    const next = open === panel ? null : panel;
    setOwn(next);
    props.onOpen?.(next);
  };
  const close = () => {
    setOwn(null);
    props.onOpen?.(null);
  };
  return props.agent.kind === "template" ? (
    <TemplateStrip {...props} open={open} toggle={toggle} close={close} />
  ) : (
    <ClientStrip {...props} open={open} toggle={toggle} close={close} />
  );
}

interface Opening {
  open: LineagePanel | null;
  toggle(panel: LineagePanel): void;
  close(): void;
}

function Strip({ children, below }: { children: ReactNode; below?: ReactNode }) {
  return (
    <div className="flow-lineage" data-testid="flow-lineage">
      <div className="flow-lineage__line">{children}</div>
      {below ? (
        <div className="flow-lineage__below" data-testid="flow-lineage-below">
          {below}
        </div>
      ) : null}
    </div>
  );
}

function Dot() {
  return (
    <span aria-hidden className="text-ink-faint">
      ·
    </span>
  );
}

/** A plain button that reads as a link, with whether what it opens is open. */
function Opener(p: { testId: string; open: boolean; onClick(): void; children: ReactNode }) {
  return (
    <button
      type="button"
      className={cx("flow-lineage__link", p.open && "is-open")}
      aria-expanded={p.open}
      data-testid={p.testId}
      onClick={p.onClick}
    >
      {p.children}
    </button>
  );
}

function ClientStrip(props: LineageStripProps & Opening) {
  const { agent, detail, template, open } = props;
  const hasTemplate = !!agent.templateId;
  // Whether the saved version differs from its base: a promotion offers saved versions only.
  const saved = useApi(
    apiRoutes.opsCustomizations,
    hasTemplate && !agent.testCopy ? { params: { id: agent.id } } : null,
  );
  const action = useAction();
  const [confirmDetach, setConfirmDetach] = useState(false);
  const published = [...(template?.versions ?? [])]
    .filter((v) => v.status !== "draft")
    .sort((a, b) => b.version - a.version);
  const [relinkTo, setRelinkTo] = useState("");
  const relinkChoice = relinkTo || published[0]?.id || "";

  if (!hasTemplate) {
    return (
      <Strip>
        <span data-testid="flow-lineage-from">
          Written for this client, from no template. Edits here change only this agent.
        </span>
      </Strip>
    );
  }

  const name = template?.agent.name ?? null;
  const base = baseTemplateVersion(detail, template ?? undefined);
  const from = (
    <span data-testid="flow-lineage-from">
      {agent.testCopy ? "The test copy of the template " : "From the template "}
      {name && template ? (
        <Link to={`/ops/templates/${template.agent.slug}`} className="flow-lineage__link">
          {name}
        </Link>
      ) : null}
      {base ? ` · v${base}` : ""}
    </span>
  );
  if (agent.testCopy) {
    return (
      <Strip>
        {from}
        <Dot />
        <span>It only runs tests. Edit the template, not this copy.</span>
      </Strip>
    );
  }

  const update = detail.update;
  const out = update?.templateLiveVersionId
    ? (template?.versions.find((v) => v.id === update.templateLiveVersionId)?.version ?? null)
    : null;
  const line = props.customized ? customizedLine(props.customized) : "";
  const hasLive = !!detail.live;
  const promotable = hasLive && (saved.data?.changes.length ?? 0) > 0;

  async function detach() {
    setConfirmDetach(false);
    const res = await action.call(apiRoutes.opsDetach, { params: { id: agent.id } });
    if (res.ok) props.onChanged?.();
  }
  async function relink() {
    const res = await action.call(apiRoutes.opsRelink, {
      params: { id: agent.id },
      body: { templateVersionId: relinkChoice },
    });
    if (res.ok) {
      props.close();
      props.onChanged?.();
    }
  }

  const below =
    open === "customizations" ? (
      (props.customizations ?? null)
    ) : open === "relink" ? (
      <div className="flex flex-wrap items-center gap-2" data-testid="flow-lineage-relink-form">
        <span className="text-sm text-ink-muted">
          Takes this template version as its base again, so updates reach it.
        </span>
        <Select
          aria-label="Template version"
          className="w-40"
          value={relinkChoice}
          onChange={(e) => setRelinkTo(e.target.value)}
          data-testid="flow-lineage-relink-version"
        >
          {published.map((v) => (
            <option key={v.id} value={v.id}>
              Template v{v.version}
              {v.status === "live" ? " (live)" : ""}
            </option>
          ))}
        </Select>
        <Button
          size="sm"
          data-testid="flow-lineage-relink-confirm"
          disabled={action.busy || !relinkChoice}
          onClick={relink}
        >
          {action.busy ? "Relinking…" : "Relink"}
        </Button>
        <Button size="sm" variant="ghost" onClick={props.close}>
          Cancel
        </Button>
      </div>
    ) : null;

  return (
    <Strip below={below}>
      {from}
      <Dot />
      {line ? (
        <Opener
          testId="flow-lineage-customized"
          open={open === "customizations"}
          onClick={() => props.toggle("customizations")}
        >
          Customized: {line}
        </Opener>
      ) : (
        <span data-testid="flow-lineage-same">The steps are the template's</span>
      )}
      {agent.linked && update?.available ? (
        <>
          <Dot />
          <span className="flex items-center gap-2" data-testid="flow-lineage-update">
            <Badge tone="accent">
              {out ? `Template v${out} is out` : "A template update is out"}
            </Badge>
            <Link
              to={`/ops/agents/${agent.id}/merge?mode=update`}
              className="flow-lineage__link"
              data-testid="flow-lineage-review-update"
              title={update.releaseNote ?? undefined}
            >
              Review the update
            </Link>
          </span>
        </>
      ) : null}
      {promotable ? (
        <>
          <Dot />
          <Link
            to={`/ops/agents/${agent.id}/merge?mode=promote`}
            className="flow-lineage__link"
            data-testid="flow-lineage-promote"
          >
            Offer to the template
          </Link>
        </>
      ) : null}
      <span className="flow-lineage__end">
        {agent.linked ? (
          confirmDetach ? (
            <>
              <span>Detach? It will take no more template updates.</span>
              <Button
                size="sm"
                data-testid="flow-lineage-detach-confirm"
                disabled={action.busy}
                onClick={detach}
              >
                {action.busy ? "Detaching…" : "Detach"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmDetach(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <button
              type="button"
              className="flow-lineage__link"
              data-testid="flow-lineage-detach"
              onClick={() => setConfirmDetach(true)}
            >
              Detach
            </button>
          )
        ) : (
          <>
            <span data-testid="flow-lineage-detached">Detached: it takes no template updates</span>
            {hasLive && published.length > 0 ? (
              <Opener
                testId="flow-lineage-relink"
                open={open === "relink"}
                onClick={() => props.toggle("relink")}
              >
                Relink
              </Opener>
            ) : null}
          </>
        )}
      </span>
      {action.error ? (
        <Notice tone="warning" testId="flow-lineage-error">
          {errorText(action.error)}
        </Notice>
      ) : null}
    </Strip>
  );
}

function TemplateStrip(props: LineageStripProps & Opening) {
  const { agent, detail, open } = props;
  const usedBy = useApi(apiRoutes.opsUsedBy, { params: { id: agent.id } });
  const copies = usedBy.data?.agents ?? [];
  const behind = copies.filter((u) => u.agent.linked && u.behind > 0).length;
  const live = detail.live;

  const below =
    open === "runs" ? (
      <WhereItRuns templateId={agent.id} />
    ) : open === "assign" && live ? (
      <AssignForm templateId={agent.id} version={live.version} onCancel={props.close} />
    ) : null;

  return (
    <Strip below={below}>
      <span data-testid="flow-lineage-from">
        Template. Publishing it changes no client's agent: each one reviews the update.
      </span>
      <Dot />
      {usedBy.data ? (
        copies.length > 0 ? (
          <Opener
            testId="flow-lineage-runs"
            open={open === "runs"}
            onClick={() => props.toggle("runs")}
          >
            Runs at {plural(copies.length, "client")}
          </Opener>
        ) : (
          <span data-testid="flow-lineage-runs">No client has it yet</span>
        )
      ) : usedBy.error ? (
        <button
          type="button"
          className="flow-lineage__link"
          data-testid="flow-lineage-runs-retry"
          onClick={usedBy.reload}
        >
          We couldn't load its clients. Try again
        </button>
      ) : (
        <span className="text-ink-faint">Loading its clients…</span>
      )}
      {behind > 0 ? (
        <Badge tone="accent" testId="flow-lineage-behind">
          {behind} behind
        </Badge>
      ) : null}
      <span className="flow-lineage__end">
        {live ? (
          <Button
            size="sm"
            variant="secondary"
            aria-expanded={open === "assign"}
            data-testid="flow-lineage-assign"
            onClick={() => props.toggle("assign")}
          >
            Assign to a client
          </Button>
        ) : (
          <span data-testid="flow-lineage-unpublished">Publish it to assign it to a client</span>
        )}
      </span>
    </Strip>
  );
}
