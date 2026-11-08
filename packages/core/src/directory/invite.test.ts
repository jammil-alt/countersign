import { describe, expect, it } from "vitest";
import { ContactInviteBody } from "../api/onboarding";
import { canInviteContact, contactAccess, isOwnPerson } from "./invite";
import { CONTACT_RELATIONSHIPS } from "./kinds";

describe("canInviteContact", () => {
  const email = "sam@shop.example.com";

  it("offers a login to employees and contractors with an email", () => {
    expect(canInviteContact({ relationship: "employee", email }, null)).toBe(true);
    expect(canInviteContact({ relationship: "contractor", email })).toBe(true);
  });

  it("offers a login to anyone in the client's own organization", () => {
    const own = { kinds: ["own"] as const };
    expect(canInviteContact({ relationship: null, email }, own)).toBe(true);
    expect(canInviteContact({ relationship: "other", email }, { kinds: ["vendor", "own"] })).toBe(
      true,
    );
  });

  it("never offers one to vendors, customers, partners or others", () => {
    for (const relationship of ["vendor", "customer", "partner", "other"] as const) {
      expect(canInviteContact({ relationship, email }, null)).toBe(false);
      expect(canInviteContact({ relationship, email }, { kinds: ["vendor", "customer"] })).toBe(
        false,
      );
    }
    expect(canInviteContact({ relationship: null, email }, null)).toBe(false);
    expect(canInviteContact({ email }, { kinds: [] })).toBe(false);
  });

  it("needs an email address", () => {
    expect(canInviteContact({ relationship: "employee", email: null })).toBe(false);
    expect(canInviteContact({ relationship: "employee", email: "  " })).toBe(false);
    expect(canInviteContact({ relationship: "employee" }, { kinds: ["own"] })).toBe(false);
    // Still one of the client's own people: the screens hint "Add an email to invite".
    expect(isOwnPerson({ relationship: "employee", email: null })).toBe(true);
  });

  it("covers every relationship", () => {
    const yes = CONTACT_RELATIONSHIPS.filter((r) => canInviteContact({ relationship: r, email }));
    expect(yes).toEqual(["employee", "contractor"]);
  });
});

describe("contactAccess", () => {
  const members = [
    { email: "lee@shop.example.com", signedIn: true },
    { email: "new@shop.example.com", signedIn: false },
    { email: "dev@shop.example.com", signedIn: null },
  ];

  it("reads member, invited and none by email, case aside", () => {
    expect(contactAccess("Lee@Shop.example.com", members)).toBe("member");
    expect(contactAccess("new@shop.example.com", members)).toBe("invited");
    // The dev sign-in can't tell: a member, as the Team page shows them.
    expect(contactAccess("dev@shop.example.com", members)).toBe("member");
    expect(contactAccess("someone@shop.example.com", members)).toBeNull();
    expect(contactAccess(null, members)).toBeNull();
    expect(contactAccess("", members)).toBeNull();
  });
});

describe("ContactInviteBody", () => {
  it("takes a role and can sign, never an email or a name", () => {
    expect(ContactInviteBody.parse({ role: "client_user" })).toEqual({ role: "client_user" });
    expect(ContactInviteBody.parse({ role: "client_admin", canSign: true }).canSign).toBe(true);
    expect(
      ContactInviteBody.safeParse({ role: "client_user", email: "x@example.com" }).success,
    ).toBe(false);
    expect(ContactInviteBody.safeParse({ role: "client_user", name: "X" }).success).toBe(false);
    expect(ContactInviteBody.safeParse({ role: "operator" }).success).toBe(false);
  });
});
