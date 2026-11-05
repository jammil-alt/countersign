// Who may resolve an inbox item (no database): the assignee user, the assignee role, and the
// operator for every item of the Sandbox client.

import { describe, expect, it } from "vitest";
import { type Approver, mayResolve } from "./external-actions";

const operator: Approver = { userId: "op", role: "operator" };
const sandboxOperator: Approver = { ...operator, sandbox: true };
const admin: Approver = { userId: "adm", role: "client_admin" };
const member: Approver = { userId: "usr", role: "client_user" };

const item = (
  assigneeRole: "operator" | "client_admin" | "client_user" | null,
  assigneeUserId: string | null = null,
) => ({
  assigneeRole,
  assigneeUserId,
});

describe("mayResolve", () => {
  it("in a real client, lets the operator resolve only what is assigned to them", () => {
    expect(mayResolve(item("operator"), operator)).toBe(true);
    expect(mayResolve(item("client_admin"), operator)).toBe(false);
    expect(mayResolve(item("client_user"), operator)).toBe(false);
    expect(mayResolve(item(null), operator)).toBe(false);
    expect(mayResolve(item(null, "usr"), operator)).toBe(false);
    expect(mayResolve(item(null, "op"), operator)).toBe(true);
  });

  it("keeps the client's own items with the client", () => {
    expect(mayResolve(item("client_admin"), admin)).toBe(true);
    expect(mayResolve(item("client_user"), admin)).toBe(true);
    expect(mayResolve(item("client_user"), member)).toBe(true);
    expect(mayResolve(item("client_admin"), member)).toBe(false);
    expect(mayResolve(item("operator"), admin)).toBe(false);
    expect(mayResolve(item(null, "usr"), admin)).toBe(false);
  });

  it("in the Sandbox, lets the operator resolve every item, whoever it is assigned to", () => {
    for (const i of [
      item("operator"),
      item("client_admin"),
      item("client_user"),
      item(null),
      item(null, "usr"),
    ]) {
      expect(mayResolve(i, sandboxOperator)).toBe(true);
    }
  });

  it("gives the Sandbox flag no meaning for anyone but the operator", () => {
    expect(mayResolve(item("operator"), { ...member, sandbox: true })).toBe(false);
    expect(mayResolve(item("client_admin"), { ...member, sandbox: true })).toBe(false);
  });
});
