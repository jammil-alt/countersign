// R8: the Library's Triggers bank (`/ops/library/triggers`; ARCHITECTURE §10.8, §10.14): what starts
// a process. The six kinds as the agent page's trigger panel explains them (../triggers), each
// with the templates that start that way; then every event a trigger can wait for (the event
// catalogue), with who emits it and the templates waiting for it. Triggers are added in the
// builder, on a process; this bank only reads.
import type { LibraryProcess } from "@countersign/core";
import { useState } from "react";
import { Link } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { Columns, Loaded, Section } from "../../ui/page";
import { Card, EmptyState, PageHeader, Tag } from "../../ui/primitives";
import { KIND_TITLE, TRIGGER_KINDS, type TriggerKind } from "../triggers/AddTrigger";
import { KINDS } from "../triggers/TriggersScreen";
import { BankSearch, LibraryFrame } from "./LibraryFrame";
import { builderPath } from "./ProcessesBank";
import { counted, matches } from "./paths";

interface Use {
  process: LibraryProcess;
  workflow: string;
}

/** A trigger's stored kind as one of the six (a `/command` is a message trigger). */
function sixKind(kind: string): TriggerKind | null {
  if (kind === "command") return "message";
  return (TRIGGER_KINDS as readonly string[]).includes(kind) ? (kind as TriggerKind) : null;
}

/** Each template workflow that starts this way, once. */
function usesBy(
  processes: readonly LibraryProcess[],
  test: (t: { kind: string; event: string | null }) => boolean,
): Use[] {
  return processes.flatMap((p) =>
    p.workflows.filter((w) => w.triggers.some(test)).map((w) => ({ process: p, workflow: w.slug })),
  );
}

function UseLinks({ uses, testId }: { uses: readonly Use[]; testId: string }) {
  if (uses.length === 0) return <span className="text-ink-muted">No template yet</span>;
  return (
    <span className="flex flex-wrap gap-x-2" data-testid={testId}>
      {uses.map((u) => (
        <Link
          key={`${u.process.id}/${u.workflow}`}
          to={builderPath(u.process.slug, u.workflow)}
          state={{ agentId: u.process.id }}
          className="text-ink hover:underline"
        >
          {u.process.name}
        </Link>
      ))}
    </span>
  );
}

export function TriggersBank() {
  const events = useApi(apiRoutes.opsEventCatalog);
  const processes = useApi(apiRoutes.opsLibraryProcesses);
  const [search, setSearch] = useState("");
  const templates = processes.data?.processes ?? [];
  const kinds = TRIGGER_KINDS.filter((k) =>
    matches(search, KIND_TITLE[k], KINDS[k].tag, KINDS[k].text, KINDS[k].examples),
  );
  return (
    <LibraryFrame>
      <PageHeader
        title="Triggers"
        subtitle="What starts a process. A process has one to ten triggers; you add them in the builder."
      />
      <div className="-mt-2 flex justify-end">
        <BankSearch
          value={search}
          onChange={setSearch}
          label="Search triggers and events"
          testId="triggers-search"
        />
      </div>
      <Section title="Six kinds">
        {kinds.length === 0 ? (
          <EmptyState>No kind matches.</EmptyState>
        ) : (
          <Columns count={3}>
            {kinds.map((k) => (
              <Card key={k} testId={`trigger-kind-${k}`} className="flex flex-col">
                <div className="flex flex-1 flex-col gap-2 px-6 pt-5 pb-4">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="type-subheading text-ink">{KIND_TITLE[k]}</h3>
                    <Tag>{KINDS[k].tag}</Tag>
                  </div>
                  <p className="text-sm text-ink">{KINDS[k].text}</p>
                  <p className="text-sm text-ink-muted">{KINDS[k].examples}</p>
                </div>
                <div className="border-t border-line px-6 py-3 text-sm">
                  {processes.data ? (
                    <UseLinks
                      uses={usesBy(templates, (t) => sixKind(t.kind) === k)}
                      testId={`trigger-kind-${k}-uses`}
                    />
                  ) : null}
                </div>
              </Card>
            ))}
          </Columns>
        )}
      </Section>
      <Loaded state={events}>
        {(data) => {
          const shown = data.events.filter((e) =>
            matches(search, e.type, e.description, e.connector ?? "platform"),
          );
          return (
            <Section title="Events" meta={counted(data.events.length, "event")}>
              {shown.length === 0 ? (
                <EmptyState>No event matches.</EmptyState>
              ) : (
                <Card>
                  <div className="dt dt-ana overflow-x-auto">
                    <table data-testid="trigger-events">
                      <thead>
                        <tr className="dt-cols">
                          <th>Event</th>
                          <th>From</th>
                          <th>Templates waiting for it</th>
                        </tr>
                      </thead>
                      <tbody>
                        {shown.map((e) => (
                          <tr key={e.type} data-testid={`trigger-event-${e.type}`}>
                            <td>
                              <span className="flex flex-col gap-1">
                                <span className="reference text-ink">{e.type}</span>
                                <span className="text-sm text-ink-muted">{e.description}</span>
                              </span>
                            </td>
                            <td className="text-sm text-ink">{e.connector ?? "Platform"}</td>
                            <td className="text-sm">
                              {processes.data ? (
                                <UseLinks
                                  uses={usesBy(
                                    templates,
                                    (t) => t.kind === "event" && t.event === e.type,
                                  )}
                                  testId={`trigger-event-${e.type}-uses`}
                                />
                              ) : null}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              )}
            </Section>
          );
        }}
      </Loaded>
    </LibraryFrame>
  );
}
