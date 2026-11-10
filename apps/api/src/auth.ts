// What packages/auth needs from the database (its directories), and which sign-in adapter this
// deployment uses. packages/auth stays free of the database; this is where the two meet.

import {
  type AuthAdapter,
  type AuthDirectory,
  type AuthRefusal,
  createDevAdapter,
  createWorkOSAdapter,
  type DevAdapter,
  type DevDirectory,
  type ProvisioningDirectory,
  refuse,
  type SecondFactorPolicy,
  type WorkOSAdapter,
  type WorkOSClient,
  workosStateOf,
} from "@countersign/auth";
import {
  appUser,
  type Db,
  type UserMembership,
  userMemberships,
  userWithMemberships,
} from "@countersign/db";
import { eq, sql } from "drizzle-orm";
import type { Bindings } from "./env";

const toMembership = (m: UserMembership) => ({
  tenantId: m.tenantId,
  tenantName: m.tenantName,
  role: m.role,
});

/** app_user and membership reads (app_user is global; memberships through `own_memberships`). */
export function authDirectory(db: Db): AuthDirectory & DevDirectory {
  const one = async (where: ReturnType<typeof eq>) => {
    const [row] = await db
      .select({ id: appUser.id, email: appUser.email, name: appUser.name })
      .from(appUser)
      .where(where);
    return row ?? null;
  };
  return {
    user: (userId) => one(eq(appUser.id, userId)),
    userByEmail: (email) => one(eq(appUser.email, email.trim().toLowerCase())),
    async memberships(userId) {
      return (await userMemberships(db, userId)).map(toMembership);
    },
    // Each session route's sign-in check: one transaction for both (docs/plan.md §1.82).
    async account(userId) {
      const { user, memberships } = await userWithMemberships(db, userId);
      return { user, memberships: memberships.map(toMembership) };
    },
  };
}

/**
 * WorkOS sign-in provisioning: the WorkOS user is found by its id, or claims the invited
 * `app_user` row with its (verified) email. Nobody without a row was invited, and an address
 * already tied to a different WorkOS user is never merged.
 */
// DECISION: an `app_user` row is the invitation (the operator creates it with the membership), so
// provisioning never creates users; WorkOS organizations are not used to grant access in v1.
export function provisioningDirectory(db: Db): ProvisioningDirectory {
  return {
    provision(input) {
      return db.transaction(async (tx) => {
        const [byWorkos] = await tx
          .select()
          .from(appUser)
          .where(eq(appUser.workosUserId, input.workosUserId));
        if (byWorkos) {
          if (input.name && !byWorkos.name) {
            await tx.update(appUser).set({ name: input.name }).where(eq(appUser.id, byWorkos.id));
          }
          return { ok: true, userId: byWorkos.id } as const;
        }
        const [byEmail] = await tx
          .select()
          .from(appUser)
          .where(eq(appUser.email, input.email))
          .for("update");
        if (!byEmail) return { ok: false, reason: "not_invited" } as const;
        if (byEmail.workosUserId) return { ok: false, reason: "email_taken" } as const;
        if (!input.emailVerified) return { ok: false, reason: "email_not_verified" } as const;
        await tx
          .update(appUser)
          .set({
            workosUserId: input.workosUserId,
            name: sql`coalesce(${appUser.name}, ${input.name})`,
          })
          .where(eq(appUser.id, byEmail.id));
        return { ok: true, userId: byEmail.id } as const;
      });
    },
  };
}

export type AdapterChoice =
  | { ok: true; adapter: AuthAdapter; dev: DevAdapter | null; workos: WorkOSAdapter | null }
  | { ok: false; refusal: AuthRefusal };

/**
 * `AUTH_PROVIDER` picks the adapter (default: workos when WORKOS_CLIENT_ID is set, else dev).
 * A misconfigured WorkOS never falls back to dev, and dev never runs in production.
 */
export function chooseAdapter(
  env: Bindings,
  db: Db,
  workosClient?: WorkOSClient,
  secondFactor?: SecondFactorPolicy,
): AdapterChoice {
  const provider =
    env.AUTH_PROVIDER?.trim().toLowerCase() || (env.WORKOS_CLIENT_ID?.trim() ? "workos" : "dev");
  if (provider === "workos") {
    const state = workosStateOf(env);
    if (state.state === "off") {
      return {
        ok: false,
        refusal: refuse("misconfigured", "AUTH_PROVIDER is workos but WORKOS_CLIENT_ID is empty"),
      };
    }
    if (state.state === "misconfigured") {
      return { ok: false, refusal: refuse("misconfigured", state.problems.join("; ")) };
    }
    const workos = createWorkOSAdapter({
      config: state.config,
      directory: provisioningDirectory(db),
      ...(workosClient ? { workos: workosClient } : {}),
      ...(secondFactor ? { secondFactor } : {}),
    });
    return { ok: true, adapter: workos, dev: null, workos };
  }
  if (provider !== "dev") {
    return { ok: false, refusal: refuse("misconfigured", `unknown AUTH_PROVIDER ${provider}`) };
  }
  try {
    const dev = createDevAdapter({ directory: authDirectory(db), env });
    return { ok: true, adapter: dev, dev, workos: null };
  } catch {
    return {
      ok: false,
      refusal: refuse("adapter_disabled", "the dev sign-in cannot be used in production"),
    };
  }
}
