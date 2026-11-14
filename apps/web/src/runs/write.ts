// The skill model (owner, 2026-11-10; ARCHITECTURE §10.14), wave A: how a write step reads on the
// client's timeline. A write to our own records reads "Saved to your records"; a change to one of
// the client's own tools reads "Changed in QuickBooks Online", by the connector's name, which the
// client knows. Before it has run it says what it will do ("Changes QuickBooks Online"). Never a
// tool id, a model or a cost: the API sends only the kind and the connector's name.
import type { TimelineWrite } from "@countersign/core";
import type { Translate } from "../i18n/catalog";

export function writeLine(t: Translate, write: TimelineWrite, status: string): string {
  const done = status === "succeeded";
  if (write.kind === "save_to_records") return t(done ? "run.write.saved" : "run.write.saves");
  if (write.connector === null) {
    return t(done ? "run.write.changedInTool" : "run.write.changesInTool");
  }
  return done
    ? t("run.write.changedIn", { connector: write.connector })
    : t("run.write.changesIn", { connector: write.connector });
}
