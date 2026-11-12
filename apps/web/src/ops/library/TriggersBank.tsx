// R8: the Library's Triggers bank (`/ops/library/triggers`; ARCHITECTURE §10.8, §10.14): what starts
// a process. The six kinds as the agent page's trigger panel explains them (../triggers), each
// with the templates that start that way; then every event a trigger can wait for (the event
// catalogue), with who emits it and the templates waiting for it. Triggers are added in the
// builder, on a process; this bank only reads.
//
// Plain words (2026-11-12): each event reads by its name in words and one line (`brief`); the row
// opens a side sheet with the whole description, its id and the templates waiting for it.
import type { LibraryProcess } from "@countersign/core";
import { useState } from "react";
import { Link } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { eventLabel } from "../../runs/labels";
import { brief, saysMore } from "../../ui/brief";
import { Columns, Loaded, Section } from "../../ui/page";
import { Card, EmptyState, PageHeader, Tag } from "../../ui/primitives";
import { SheetSection, SideSheet } from "../../ui/sheet";
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

/** "document.extracted" → "A document has been read". */
function eventTitle(type: string): string {
  const words = eventLabel(type);
  return words.charAt(0).toUpperCase() + words.slice(1);
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
  const [openType, setOpenType] = useState<string | null>(null);
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
            matches(search, eventTitle(e.type), e.type, e.description, e.connector ?? "platform"),
          );
          const opened = openType ? data.events.find((e) => e.type === openType) : undefined;
          return (
            <Section title="Events" meta={counted(data.events.length, "event")}>
              {opened ? (
                <SideSheet
                  testId="trigger-event-sheet"
                  onClose={() => setOpenType(null)}
                  eyebrow={
                    <span className="text-sm text-ink-muted">
                      Event · {opened.connector ?? "Platform"}
                    </span>
                  }
                  title={eventTitle(opened.type)}
                >
                  <p className="text-ink">{brief(opened.description)}</p>
                  {saysMore(opened.description) ? (
                    <SheetSection label="In full">
                      <p className="text-sm text-ink" data-testid="trigger-event-sheet-description">
                        {opened.description}
                      </p>
                    </SheetSection>
                  ) : null}
                  <SheetSection label="Templates waiting for it">
                    {processes.data ? (
                      <UseLinks
                        uses={usesBy(
                          templates,
                          (t) => t.kind === "event" && t.event === opened.type,
                        )}
                        testId="trigger-event-sheet-uses"
                      />
                    ) : null}
                  </SheetSection>
                  <SheetSection label="Id">
                    <span className="reference text-ink-muted">{opened.type}</span>
                  </SheetSection>
                </SideSheet>
              ) : null}
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
                              <span className="flex min-w-[16rem] flex-col gap-0.5 py-1">
                                <button
                                  type="button"
                                  onClick={() => setOpenType(e.type)}
                                  aria-haspopup="dialog"
                                  data-testid={`trigger-event-${e.type}-open`}
                                  className="self-start text-left font-medium text-ink hover:underline"
                                >
                                  {eventTitle(e.type)}
                                </button>
                                <span className="max-w-xl text-sm text-ink-muted">
                                  {brief(e.description)}
                                </span>
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
