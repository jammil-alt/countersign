// The `Directory` Durable Object: one per client (named by the client id), listing that client's
// identities so `alerts({tenantId})` can read them all. Ids only: no secrets, no codes.

import { DurableObject } from "cloudflare:workers";
import type { CodesEnv } from "./env";

// DECISION: a second Durable Object class, per client, beside `Identity` (the design names only
// IDENTITY): alerts are kept by each identity, and listing a client's identities needs an index
// that no identity holds. One object per client keeps clients apart here as everywhere else.
export class Directory extends DurableObject<CodesEnv> {
  /** The table is made on first use, so a client with no identities leaves nothing stored. */
  private hasTable(): boolean {
    return (
      this.ctx.storage.sql
        .exec("select count(*) as n from sqlite_master where type = 'table' and name = 'identity'")
        .one().n === 1
    );
  }

  async add(identityId: string): Promise<void> {
    this.ctx.storage.sql.exec(
      "create table if not exists identity (id text primary key, created_at integer not null)",
    );
    this.ctx.storage.sql.exec(
      "insert into identity (id, created_at) values (?, ?) on conflict (id) do nothing",
      identityId,
      Date.now(),
    );
  }

  async remove(identityId: string): Promise<void> {
    if (!this.hasTable()) return;
    this.ctx.storage.sql.exec("delete from identity where id = ?", identityId);
  }

  async list(): Promise<string[]> {
    if (!this.hasTable()) return [];
    return this.ctx.storage.sql
      .exec<{ id: string }>("select id from identity order by created_at, id")
      .toArray()
      .map((r) => r.id);
  }
}
