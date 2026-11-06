// Retention (docs/plan.md §1.35): a retired client's stored files (everything under
// `tenants/<id>/` in object storage: documents, attachments, feedback screenshots) are deleted
// once it has been retired for RETIREMENT_PURGE_DAYS. The rows go after, by the owner's
// `db:purge-client`, which waits for `settings.purge.files_deleted_at`.

import type { ObjectStore } from "@countersign/connectors";
import { RETIREMENT_PURGE_DAYS } from "@countersign/core";
import { auditEvent, type Db, tenant, withTenant } from "@countersign/db";
import { and, isNotNull, lte, sql } from "drizzle-orm";

const DAY_MS = 24 * 60 * 60 * 1000;

export async function purgeRetiredFiles(
  db: Db,
  objects: ObjectStore,
  now: Date,
): Promise<{ tenantId: string; files: number }[]> {
  const due = await db
    .select({ id: tenant.id, settings: tenant.settings })
    .from(tenant)
    .where(
      and(
        isNotNull(tenant.retiredAt),
        lte(tenant.retiredAt, new Date(now.getTime() - RETIREMENT_PURGE_DAYS * DAY_MS)),
        sql`${tenant.settings} #> '{purge,files_deleted_at}' is null`,
      ),
    );
  const done: { tenantId: string; files: number }[] = [];
  for (const t of due) {
    const prefix = `tenants/${t.id.toLowerCase()}/`;
    let files = 0;
    let cursor: string | undefined;
    do {
      const page = await objects.list({ prefix, ...(cursor ? { cursor } : {}), limit: 500 });
      for (const o of page.objects) {
        await objects.delete(o.key);
        files++;
      }
      cursor = page.cursor ?? undefined;
    } while (cursor);
    const settings = t.settings as Record<string, unknown>;
    const purge = (settings.purge as Record<string, unknown> | undefined) ?? {};
    await withTenant(db, t.id, async (tx) => {
      await tx
        .update(tenant)
        .set({
          settings: { ...settings, purge: { ...purge, files_deleted_at: now.toISOString() } },
        })
        .where(sql`${tenant.id} = ${t.id}`);
      await tx.insert(auditEvent).values({
        tenantId: t.id,
        actorKind: "system",
        action: "client.purge_files",
        outcome: "ok",
        target: { files: String(files) },
      });
    });
    done.push({ tenantId: t.id, files });
  }
  return done;
}
