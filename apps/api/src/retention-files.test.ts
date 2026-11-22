// Lost prospects' client files (docs/plan.md §1.149 q14, §1.220): the hourly retention job, run as
// the Worker, deletes a prospect's file once its last deal closed without a sale more than 12
// months ago, through migration 0094's function, and keeps a younger one.

import { auditEvent, clientFile, deal } from "@countersign/db";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { type ApiHarness, createApiHarness } from "./api.test-helper";
import { purgeLostProspectFiles } from "./compliance/retention";

const h = await createApiHarness();
afterAll(() => h?.close());

const monthsAgo = (n: number) => new Date(Date.now() - n * 31 * 86_400_000);

describe.skipIf(!h)("the retention job: lost prospects' files (§1.220)", () => {
  const H = h as ApiHarness;

  async function lostProspect(name: string, closedAt: Date) {
    const [f] = await H.t.db.insert(clientFile).values({ name }).returning({ id: clientFile.id });
    await H.t.db.insert(deal).values({
      kind: "new",
      company: name,
      title: "Invoice review",
      stage: "lead",
      clientFileId: f?.id as string,
      outcome: "lost",
      closedAt,
    });
    return f?.id as string;
  }

  it("deletes a file 12 months after its deal was lost, as the Worker, and keeps a younger one", async () => {
    const old = await lostProspect("Old Lead Co", monthsAgo(13));
    const young = await lostProspect("Young Lead Co", monthsAgo(6));
    expect(await purgeLostProspectFiles(H.db)).toEqual([old]);
    const left = (await H.t.db.select({ id: clientFile.id }).from(clientFile)).map((r) => r.id);
    expect(left).toContain(young);
    expect(left).not.toContain(old);
    const audit = await H.t.db
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.action, "client_file.purge_lost"));
    expect(audit.map((a) => a.target)).toEqual([{ fileIds: [old], count: 1 }]);
    expect(await purgeLostProspectFiles(H.db)).toEqual([]);
  });
});
