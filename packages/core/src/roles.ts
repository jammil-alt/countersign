import { z } from "zod";

/** ARCHITECTURE §4. Operators build and run agents; client roles use the portal. */
export const Role = z.enum(["operator", "client_admin", "client_user"]);
export type Role = z.infer<typeof Role>;
export const ROLES = Role.options;
export const CLIENT_ROLES = ["client_admin", "client_user"] as const satisfies readonly Role[];

export function isOperatorRole(role: Role): boolean {
  return role === "operator";
}

export function isClientRole(role: Role): boolean {
  return role === "client_admin" || role === "client_user";
}
