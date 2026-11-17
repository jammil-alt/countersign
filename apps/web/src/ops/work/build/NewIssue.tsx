// New item in Build (docs/plan.md §1.124.1): an issue for a client (something isn't working), or
// a client's ask (an idea or a change). Builds start from the Builder board.
import type { WorkUrgency } from "@countersign/core";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiRoutes } from "../../../api/routes";
import { useApi, useApiClient } from "../../../api/useApi";
import { ErrorNotice } from "../../../ui/ErrorState";
import { Field, Select, TextInput } from "../../../ui/forms";
import { Page } from "../../../ui/page";
import { Button, Card, PageHeader } from "../../../ui/primitives";
import { OPS_PATHS } from "../../paths";

export function NewIssue() {
  const api = useApiClient();
  const navigate = useNavigate();
  const clients = useApi(apiRoutes.opsClients, { query: { view: "names" } });
  const [kind, setKind] = useState<"problem" | "idea">("problem");
  const [clientId, setClientId] = useState("");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [urgency, setUrgency] = useState<WorkUrgency>("normal");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const list =
    (clients.data as { clients?: { id: string; name: string }[] } | undefined)?.clients ?? [];
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (kind === "problem") {
        const out = await api.call(apiRoutes.opsCreateIssue, {
          body: { clientId, title, text, urgency },
        });
        navigate(OPS_PATHS.issue(out.issue.id));
      } else {
        await api.call(apiRoutes.opsCreateAsk, { body: { clientId, title, text: text || title } });
        navigate(OPS_PATHS.buildTab("enh"));
      }
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Page width="narrow" testId="ops-new-issue">
      <PageHeader eyebrow="Build" title="New item" />
      <Card pad>
        <div className="flex flex-col gap-3">
          <Field label="What is it">
            <Select value={kind} onChange={(e) => setKind(e.target.value as "problem" | "idea")}>
              <option value="problem">Something isn't working (an issue)</option>
              <option value="idea">An idea or a change (an ask)</option>
            </Select>
          </Field>
          <Field label="Client">
            <Select
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              data-testid="new-issue-client"
            >
              <option value="">Pick a client</option>
              {list.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Title">
            <TextInput
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              data-testid="new-issue-title"
            />
          </Field>
          <Field label="What happened, or what they asked">
            <textarea
              className="ds-textarea w-full"
              rows={4}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </Field>
          {kind === "problem" ? (
            <Field label="Urgency">
              <Select value={urgency} onChange={(e) => setUrgency(e.target.value as WorkUrgency)}>
                <option value="critical">Critical: holds the agent</option>
                <option value="high">High</option>
                <option value="normal">Normal</option>
                <option value="low">Low</option>
              </Select>
            </Field>
          ) : null}
          {error ? <ErrorNotice error={error} /> : null}
          <div>
            <Button
              variant="primary"
              disabled={busy || !clientId || !title.trim()}
              onClick={() => void submit()}
            >
              Add it
            </Button>
          </div>
        </div>
      </Card>
    </Page>
  );
}
