// §1.231.2: every connector that signs in with OAuth says which scopes it asks for, so the check
// "Sign-ins grant no more than we ask for" can compare a grant with them; and the grants each
// provider gives for our own ask read as within it.

import { DECLARED_OAUTH_SCOPES, declaredOAuthScopes } from "@countersign/connectors";
import { scopesBeyond } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { createPlatform, deploymentConnectors } from "./platform";

const platform = createPlatform({ connectors: deploymentConnectors({}, false) });

describe("OAuth scopes declared (§1.231.2)", () => {
  it("lists every OAuth connector of the deployment, and nothing else", () => {
    const oauth = platform.connectors
      .list()
      .filter((c) => c.manifest.auth === "oauth2")
      .map((c) => c.manifest.id)
      .sort();
    expect(Object.keys(DECLARED_OAUTH_SCOPES).sort()).toEqual(oauth);
  });

  it("reads the grants providers give for our ask as within it", () => {
    const within = (id: string, granted: string) =>
      scopesBeyond(granted.split(/[\s,]+/), declaredOAuthScopes(id) ?? []);
    expect(
      within(
        "gmail",
        "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.send",
      ),
    ).toEqual([]);
    expect(
      within("outlook", "https://graph.microsoft.com/Mail.Send openid profile email User.Read"),
    ).toEqual([]);
    expect(within("slack", "chat:write,channels:read")).toEqual([]);
    expect(within("gmail", "openid https://www.googleapis.com/auth/gmail.readonly")).toEqual([
      "https://www.googleapis.com/auth/gmail.readonly",
    ]);
  });
});
