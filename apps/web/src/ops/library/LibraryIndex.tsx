// R8: the Library's index (`/ops/library`): each bank as a card with what it holds and how many,
// opening the bank. A process is assembled from the banks; nothing in it is code (invariant 4).
import type { LibraryIndex as Index } from "@countersign/core";
import { Link } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { Loaded } from "../../ui/page";
import { buttonClass, Card, PageHeader } from "../../ui/primitives";
import { LibraryFrame } from "./LibraryFrame";
import { BANKS, type BankInfo, counted } from "./paths";

/** "3 processes", "15 skills · 85 tool wrappers retiring": the bank's count in words. */
export function bankCount(info: BankInfo, row: Index["banks"][number] | undefined): string {
  if (!row) return "";
  switch (info.bank) {
    case "processes":
      return counted(row.count, "process", "processes");
    case "skills":
      return row.retired > 0
        ? `${counted(row.count, "skill")} · ${row.retired} tool wrappers retiring`
        : counted(row.count, "skill");
    case "tools":
      return counted(row.count, "tool");
    case "connectors":
      return counted(row.count, "connector");
    case "triggers":
      return `6 kinds · ${counted(row.count, "event")}`;
    case "record_types":
      return counted(row.count, "record type");
    case "conditions":
      return counted(row.count, "condition set");
  }
}

export function LibraryIndexScreen() {
  const state = useApi(apiRoutes.opsLibrary);
  return (
    <LibraryFrame>
      <PageHeader
        title="Library"
        subtitle="The banks you build from. A process takes triggers, skills, tools and checks from here; each client's agent is one process and its owner."
        actions={
          <Link to="/ops/templates/new" className={buttonClass("primary")}>
            Make a template
          </Link>
        }
      />
      <Loaded state={state}>
        {(data) => (
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
            {BANKS.map((b) => {
              const row = data.banks.find((r) => r.bank === b.bank);
              return (
                <Card key={b.bank} testId={`library-bank-${b.bank}`} className="flex flex-col">
                  <div className="flex flex-1 flex-col gap-2 px-6 pt-5 pb-4">
                    <h2 className="type-subheading text-ink">
                      <Link to={b.to} className="hover:underline">
                        {b.title}
                      </Link>
                    </h2>
                    <p className="text-sm text-ink-muted">{b.line}</p>
                  </div>
                  <div className="border-t border-line px-6 py-3 text-sm text-ink figures">
                    <span data-testid={`library-bank-${b.bank}-count`}>{bankCount(b, row)}</span>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </Loaded>
    </LibraryFrame>
  );
}
