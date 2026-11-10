// The Websites screen's Scripts (docs/plan.md §1.86 "Scripts (wave 4)"): every script on the
// website logins of the clients we serve, recorded by us or by a client admin. We record (the shared
// recorder, ../../accounts/scripts.tsx), review the steps, name inputs and outputs, test (a dry run
// in our browser that never submits and keeps no file) and publish a version: it is then a browser
// tool for that client alone. A script-draft offer (a browsing path that worked twice, from the
// Escalations) opens here with `?offer=<item>&client=<client>`, its pages already open steps.
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { type Script, ScriptRecorder, ScriptRows, StartScriptForm } from "../../accounts/scripts";
import type { ResponseOf } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { Loaded, Section } from "../../ui/page";
import { Badge, Button, buttonClass, ErrorNotice } from "../../ui/primitives";
import { OPS_PATHS } from "../paths";

type TestResult = ResponseOf<typeof apiRoutes.opsTestBrowserScript>;

/** The inbox subject of a script-draft offer (connectors' BROWSE_SCRIPT_DRAFT_SUBJECT). */
export const SCRIPT_DRAFT_SUBJECT = "browse_script_draft";

/** "Record it as a script" on a script-draft offer in the Escalations. */
export function ScriptOfferLink({
  item,
}: {
  item: { id: string; tenantId: string; subjectType: string | null };
}) {
  if (item.subjectType !== SCRIPT_DRAFT_SUBJECT) return null;
  return (
    <Link
      to={`${OPS_PATHS.browserSites}?offer=${item.id}&client=${item.tenantId}#scripts`}
      className={buttonClass("secondary", "self-start", "sm")}
      data-testid="script-offer-record"
    >
      Record it as a script
    </Link>
  );
}

export function OpsScriptsSection() {
  const list = useApi(apiRoutes.opsBrowserScripts);
  const [params] = useSearchParams();
  const offer = params.get("offer");
  const offerClient = params.get("client");
  const [openId, setOpenId] = useState<string | null>(null);
  const [starting, setStarting] = useState(offer !== null);
  return (
    <Section
      title="Scripts"
      meta={list.data ? `${list.data.scripts.length} recorded` : undefined}
      action={
        <Button
          size="sm"
          data-testid="ops-scripts-record"
          aria-expanded={starting}
          onClick={() => setStarting(!starting)}
        >
          {starting ? "Close" : "Record a script"}
        </Button>
      }
    >
      <div id="scripts" className="flex scroll-mt-24 flex-col gap-4" data-testid="ops-scripts">
        <p className="text-sm text-ink-muted">
          Fixed steps on a client's website login, recorded in our browser after our code signs in.
          A client admin's recording waits here until we publish it; a published version is a
          browser tool for that client alone, and a script that submits is always approved.
        </p>
        <Loaded state={list}>
          {(data) => {
            const open = data.scripts.find((s) => s.id === openId) ?? null;
            const offered = offerClient
              ? data.logins.find((l) => l.clientId === offerClient)?.connectionId
              : undefined;
            return (
              <>
                {starting ? (
                  data.logins.length === 0 ? (
                    <p className="text-sm text-ink-muted">
                      No client has a website login we can record on.
                    </p>
                  ) : (
                    <StartScriptForm
                      side="ops"
                      logins={data.logins}
                      showClient
                      fromOffer={offer}
                      initialLogin={offered ?? null}
                      onStarted={(s) => {
                        setStarting(false);
                        setOpenId(s.id);
                        list.reload();
                      }}
                    />
                  )
                ) : null}
                <ScriptRows scripts={data.scripts} showClient openId={openId} onOpen={setOpenId} />
                {open ? (
                  <ScriptRecorder side="ops" script={open} onChanged={() => list.reload()}>
                    <TestAndPublish script={open} onChanged={() => list.reload()} />
                  </ScriptRecorder>
                ) : null}
              </>
            );
          }}
        </Loaded>
      </div>
    </Section>
  );
}

/** Test the newest version (a dry run that never submits), then publish it. */
function TestAndPublish({ script, onChanged }: { script: Script; onChanged: () => void }) {
  const api = useApiClient();
  const newest = script.versions.at(-1)?.version ?? null;
  const [result, setResult] = useState<TestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (newest === null) return null;
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  const published = script.published?.version === newest;
  return (
    <>
      <Button
        data-testid="script-test"
        disabled={busy}
        onClick={() =>
          void run(async () => {
            setResult(
              await api.call(apiRoutes.opsTestBrowserScript, {
                params: { id: script.id },
                body: { version: newest },
              }),
            );
          })
        }
      >
        Test version {newest}
      </Button>
      <Button
        data-testid="script-publish"
        variant="primary"
        disabled={busy || published}
        onClick={() =>
          void run(async () => {
            await api.call(apiRoutes.opsPublishBrowserScript, {
              params: { id: script.id, version: newest },
            });
            onChanged();
          })
        }
      >
        {published ? `Version ${newest} is published` : `Publish version ${newest}`}
      </Button>
      {error ? <ErrorNotice error={error} /> : null}
      {result ? <TestOutcome result={result} /> : null}
    </>
  );
}

function TestOutcome({ result }: { result: TestResult }) {
  return (
    <div className="flex w-full flex-col gap-2" data-testid="script-test-result">
      <span>
        {result.outcome === "done" ? (
          <Badge tone="positive">Test passed · nothing was submitted</Badge>
        ) : result.outcome === "needs_help" ? (
          <Badge tone="warning">Would ask for help</Badge>
        ) : (
          <Badge tone="risk">Refused</Badge>
        )}
      </span>
      {result.reason ? <p className="text-sm text-ink">{result.reason}</p> : null}
      {result.needsHelp ? <p className="text-sm text-ink">{result.needsHelp.question}</p> : null}
      {result.outputs ? (
        <pre
          className="reference overflow-x-auto text-sm text-ink"
          data-testid="script-test-outputs"
        >
          {JSON.stringify(result.outputs, null, 2)}
        </pre>
      ) : null}
      <ol className="flex flex-col gap-1 text-sm text-ink-muted">
        {result.steps.map((s) => (
          <li key={s.id}>
            {s.id} · {s.op} ·{" "}
            {s.status === "skipped" ? "not clicked (a test never submits)" : s.url}
          </li>
        ))}
      </ol>
    </div>
  );
}
