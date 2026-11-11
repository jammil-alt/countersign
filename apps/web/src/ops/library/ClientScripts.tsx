// Wave 4 (docs/plan.md §1.86 "Scripts (wave 4)"): the picked client's published scripts in the
// Library's Tools bank, under the browser connector. Each is a call of `browser.script.read` (a
// script that only reads) or `browser.script.submit` (one that sends a form: always approved),
// naming the script; it exists for that client alone. Recording and publishing are on the Websites
// screen.
import type { BrowserScriptTool } from "@countersign/core";
import { Link } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { ConnectorMark } from "../../connections/ConnectorMark";
import { Card, EmptyState, Tag } from "../../ui/primitives";
import { usePickedClient } from "../pickedClient";
import { counted, LIBRARY_PATHS } from "./paths";

export function ClientScriptTools() {
  const { clientId } = usePickedClient();
  const state = useApi(
    apiRoutes.opsClientBrowserScriptTools,
    clientId ? { params: { id: clientId } } : null,
  );
  if (!clientId) return null;
  const tools = state.data?.tools ?? [];
  return (
    <Card
      testId="tools-group-browser-scripts"
      title={
        <span className="flex items-center gap-3">
          <ConnectorMark name="Website logins" connector="browser" size="sm" />
          This client's scripts
        </span>
      }
      meta={
        <>
          <span>{counted(tools.length, "script")}</span>
          <Link to={`${LIBRARY_PATHS.browserSites}#scripts`} className="text-ink hover:underline">
            Record or publish
          </Link>
        </>
      }
    >
      {tools.length === 0 ? (
        <div className="ui-card__body">
          <EmptyState>No published script for this client yet.</EmptyState>
        </div>
      ) : (
        <div className="dt dt-ana overflow-x-auto">
          <table>
            <thead>
              <tr className="dt-cols">
                <th>Script</th>
                <th>Does</th>
                <th>Inputs</th>
                <th>Outputs</th>
              </tr>
            </thead>
            <tbody>
              {tools.map((t) => (
                <ScriptToolRow key={`${t.site}:${t.script}`} tool={t} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function ScriptToolRow({ tool: t }: { tool: BrowserScriptTool }) {
  return (
    <tr data-testid={`script-tool-${t.script}`}>
      <td>
        <span className="flex flex-col gap-1">
          <span className="text-ink">{t.name}</span>
          <span className="reference text-xs text-ink-muted">
            {t.tool} · {t.siteName} · {t.script} v{t.version}
          </span>
        </span>
      </td>
      <td className="text-sm">
        {t.sideEffect === "external" ? (
          <Tag tone="person" testId={`script-tool-${t.script}-signed`}>
            Sends a form · a person always signs
          </Tag>
        ) : (
          <span className="text-ink">Reads the site</span>
        )}
      </td>
      <td className="text-sm text-ink">
        {t.inputs.length > 0 ? t.inputs.map((i) => i.label).join(", ") : "—"}
      </td>
      <td className="text-sm text-ink">
        {t.outputs.length > 0 ? t.outputs.map((o) => o.label).join(", ") : "—"}
      </td>
    </tr>
  );
}
