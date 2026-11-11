// The Websites screen's Scripts (docs/plan.md §1.86 "Scripts (wave 4)"): every script on the
// website logins of the clients we serve, recorded by us or by a client admin. We record (the shared
// recorder, ../../accounts/scripts.tsx), review the steps, name inputs and outputs, test (a dry run
// in our browser that never submits and keeps no file) and publish a version: it is then a browser
// tool for that client alone. A script-draft offer (a browsing path that worked twice, from the
// Escalations) opens here with `?offer=<item>&client=<client>`, its pages already open steps.
import type { BrowserScriptDefinition, ScriptStep } from "@countersign/core";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ScriptRecorder, ScriptRows, StartScriptForm } from "../../accounts/scripts";
import type { ResponseOf } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { Loaded, Section } from "../../ui/page";
import { Badge, Button, buttonClass, ErrorNotice, Tag } from "../../ui/primitives";
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

/** A script as the back office reads it: each saved version with its stored definition. */
type OpsScript = ResponseOf<typeof apiRoutes.opsBrowserScripts>["scripts"][number];

/** Test the newest version (a dry run that never submits), then publish it, its steps shown. */
// DECISION: publishing needs the version's steps on screen: without the stored definition the
// button stays off, so nothing is published that the operator hasn't seen.
function TestAndPublish({ script, onChanged }: { script: OpsScript; onChanged: () => void }) {
  const api = useApiClient();
  const newest = script.versions.at(-1)?.version ?? null;
  const definition = script.versions.at(-1)?.definition ?? null;
  const differs = script.recordingDiffers;
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
      <div className="flex w-full flex-col gap-3">
        {differs ? (
          <p
            className="rounded-sm border border-signal-tint bg-signal-tint px-3.5 py-3 text-sm text-signal-ink"
            data-testid="script-recording-differs"
          >
            <strong>Not saved yet.</strong> The recording has changes that aren't in version{" "}
            {newest}. Publishing sends version {newest} as shown below; save the recording as a
            version first to publish the changes.
          </p>
        ) : null}
        {definition ? (
          <VersionSteps version={newest} definition={definition} />
        ) : (
          <p className="text-sm text-ink-muted" data-testid="script-version-unseen">
            We can't show version {newest}'s steps here, so it can't be published from this screen
            yet.
          </p>
        )}
      </div>
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
        disabled={busy || published || !definition}
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

const OP_WORDS: Record<ScriptStep["op"], string> = {
  open: "Open",
  fill: "Fill",
  click: "Click",
  read_field: "Read a field",
  read_table: "Read a table",
  download: "Download",
};

/** One step of a version exactly as stored: its element or address, and what it fills or reads. */
function StepDetail({ step }: { step: ScriptStep }) {
  switch (step.op) {
    case "open":
      return <span className="reference break-all">{step.url}</span>;
    case "fill":
      return (
        <span>
          <span className="reference">{step.selector}</span> with{" "}
          {"input" in step.value ? (
            <>
              the input <span className="reference">{step.value.input}</span>
            </>
          ) : (
            <>
              the fixed text <span className="reference break-all">“{step.value.text}”</span>
            </>
          )}
        </span>
      );
    case "click":
      return (
        <span className="flex flex-wrap items-center gap-2">
          <span className="reference">{step.selector}</span>{" "}
          {step.submits ? (
            <Badge tone="accent" testId={`script-version-submit-${step.id}`}>
              Sends the form · the write
            </Badge>
          ) : (
            <span className="text-ink-muted">doesn't send anything</span>
          )}
        </span>
      );
    case "read_field":
      return (
        <span>
          <span className="reference">{step.selector}</span> as the output{" "}
          <span className="reference">{step.output}</span>
        </span>
      );
    case "read_table":
      return (
        <span>
          table {step.table + 1} as the output <span className="reference">{step.output}</span>
        </span>
      );
    case "download":
      return (
        <span>
          <span className="reference break-all">{step.url}</span> as the output{" "}
          <span className="reference">{step.output}</span>
        </span>
      );
  }
}

/** The version publishing sends, exactly as stored: what it does, takes, reads and undoes. */
export function VersionSteps({
  version,
  definition,
}: {
  version: number;
  definition: BrowserScriptDefinition;
}) {
  const undo = definition.undo;
  return (
    <section className="flex flex-col gap-2" data-testid="script-version-steps">
      <h4 className="eyebrow text-ink-muted">Version {version} · what publishing sends</h4>
      <p className="text-sm text-ink" data-testid="script-version-effect">
        {definition.sideEffect === "external"
          ? "Sends a form on the site: a write, approved by a person every time."
          : "Only reads: it never sends a form."}{" "}
        {undo.kind === "reverse" ? (
          <>
            Undone by the script <span className="reference">{undo.script}</span>
            {Object.keys(undo.inputs).length > 0 ? (
              <>
                {" "}
                with{" "}
                {Object.entries(undo.inputs)
                  .map(([name, from]) =>
                    "input" in from
                      ? `${name} from the input ${from.input}`
                      : `${name} from the output ${from.output}`,
                  )
                  .join(", ")}
              </>
            ) : null}
            .
          </>
        ) : (
          "No undo."
        )}
      </p>
      {definition.inputs.length > 0 ? (
        <p className="text-sm text-ink">
          Inputs:{" "}
          {definition.inputs.map((i, n) => (
            <span key={i.name}>
              {n > 0 ? ", " : ""}
              <span className="reference">{i.name}</span> ({i.label}, {i.type})
            </span>
          ))}
        </p>
      ) : null}
      {definition.outputs.length > 0 ? (
        <p className="text-sm text-ink">
          Outputs:{" "}
          {definition.outputs.map((o, n) => (
            <span key={o.name}>
              {n > 0 ? ", " : ""}
              <span className="reference">{o.name}</span> ({o.label}, {o.type})
            </span>
          ))}
        </p>
      ) : null}
      <ol className="flex flex-col divide-y divide-line text-sm text-ink">
        {definition.steps.map((s, n) => (
          <li
            key={s.id}
            className="flex flex-wrap items-baseline gap-2 py-1.5"
            data-testid={`script-version-step-${s.id}`}
          >
            <span className="text-ink-muted">{n + 1}.</span> <Tag>{OP_WORDS[s.op]}</Tag>{" "}
            <StepDetail step={s} />
          </li>
        ))}
      </ol>
    </section>
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
      {result.screenshotWithheld ? (
        <p className="text-sm text-ink-muted" data-testid="script-test-withheld">
          A page showed a value from the vault, so no screenshot of this test is shown.
        </p>
      ) : null}
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
