// R8: the Library's Record types bank (`/ops/library/record-types`; ARCHITECTURE §6.1 "Permissions
// per record type", §10.14): the records connectors' tools touch, each with the verbs its tools
// use, the scopes that narrow a verb to some tools (an invoice's notes only), and the tools
// themselves; then our own records a source id can name. A client's access is set per record type
// in its connection matrix; a conversation's `find` names a record type by its id.
import type { LibraryRecordType } from "@countersign/core";
import { useState } from "react";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { Loaded } from "../../ui/page";
import { Card, EmptyState, PageHeader } from "../../ui/primitives";
import { BankSearch, LibraryFrame } from "./LibraryFrame";
import { counted, matches } from "./paths";

export function RecordTypesBank() {
  const state = useApi(apiRoutes.opsLibraryRecordTypes);
  const [search, setSearch] = useState("");
  return (
    <LibraryFrame>
      <PageHeader
        title="Record types"
        subtitle="What each connector's tools read and change. A client's access is set per record type, and delete stays off."
      />
      <div className="-mt-2 flex justify-end">
        <BankSearch
          value={search}
          onChange={setSearch}
          label="Search record types"
          testId="record-types-search"
        />
      </div>
      <Loaded state={state}>
        {(data) => {
          const shown = data.recordTypes.filter((r) =>
            matches(search, r.id, r.label, r.sourceName, ...r.tools.map((t) => t.id)),
          );
          const groups = new Map<string, LibraryRecordType[]>();
          for (const r of shown) {
            groups.set(r.sourceName, [...(groups.get(r.sourceName) ?? []), r]);
          }
          if (data.recordTypes.length === 0) {
            return <EmptyState>No connector declares a record type here.</EmptyState>;
          }
          if (shown.length === 0) return <EmptyState>No record type matches.</EmptyState>;
          return [...groups.entries()].map(([source, types]) => (
            <Card
              key={source}
              testId={`record-types-${types[0]?.connector ?? "platform"}`}
              title={source}
              meta={counted(types.length, "record type")}
            >
              <div className="dt dt-ana overflow-x-auto">
                <table>
                  <thead>
                    <tr className="dt-cols">
                      <th>Record type</th>
                      <th>Verbs</th>
                      <th>Narrower access</th>
                      <th>Tools</th>
                    </tr>
                  </thead>
                  <tbody>
                    {types.map((r) => (
                      <tr key={r.id} data-testid={`record-type-${r.id}`}>
                        <td>
                          <span className="flex flex-col gap-1">
                            <span className="font-medium text-ink">{r.label}</span>
                            <span className="reference text-sm text-ink-muted">{r.id}</span>
                          </span>
                        </td>
                        <td className="text-sm text-ink">{r.verbs.join(", ")}</td>
                        <td className="text-sm">
                          {r.scopes.length === 0 ? (
                            <span className="text-ink-muted">—</span>
                          ) : (
                            <ul className="flex flex-col gap-1">
                              {r.scopes.map((s) => (
                                <li key={s.id} className="text-ink">
                                  {s.label}{" "}
                                  <span className="text-ink-muted">
                                    ({s.verb}: {s.tools.join(", ")})
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </td>
                        <td className="text-sm">
                          {r.tools.length === 0 ? (
                            <span className="text-ink-muted">
                              {r.connector ? "None yet" : "Read through tools and source links"}
                            </span>
                          ) : (
                            <span className="reference text-ink">
                              {r.tools.map((t) => t.id).join(", ")}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ));
        }}
      </Loaded>
    </LibraryFrame>
  );
}
