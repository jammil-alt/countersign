// §1.77: a fake LinkedIn for tests (re-exported by @countersign/connectors/testing; never imported
// by the Worker): the token endpoint (codes and refresh tokens), the organization ACLs and names,
// the posts API (only as a page the token's person administers, with `w_organization_social`;
// keeps every post) and the revoke endpoint. It can refuse the next post, or post and lose the
// answer (the network fails after LinkedIn posted). Shaped as far as we know LinkedIn (NOTES.md).

import type { FetchLike, HttpRequestInit, HttpResponseLike } from "../http";
import { formDecode } from "../http";
import { LINKEDIN_API, LINKEDIN_REVOKE_URL, LINKEDIN_TOKEN_URL } from "./index";

export const FAKE_LINKEDIN = {
  clientId: "86fakeclientid",
  clientSecret: "fake-linkedin-client-secret",
} as const;

export interface FakeLinkedInPost {
  author: string;
  id: string;
  body: Record<string, unknown>;
  version: string | null;
}

interface Grant {
  scopes: string[];
  /** Organization ids the person administers. */
  pages: string[];
  refresh: boolean;
}

export interface FakeLinkedIn {
  fetch: FetchLike;
  requests: { url: string; method: string; body: string | undefined }[];
  posts: FakeLinkedInPost[];
  /** Organization names by id. */
  organizations: Record<string, string>;
  issueCode(grant?: Partial<Grant>): string;
  revoked: string[];
  /** The next post is refused with this status (and nothing posted). */
  refuseNext(status: number): void;
  /** The next post is made, then the connection drops before the answer. */
  loseNextAnswer(): void;
  /** Expire every access token now (a refresh is needed). */
  expireTokens(): void;
}

function answer(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): HttpResponseLike {
  const text = body === undefined ? "" : JSON.stringify(body);
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (n) => h[n.toLowerCase()] ?? null },
    text: async () => text,
  };
}

export function fakeLinkedIn(): FakeLinkedIn {
  let n = 0;
  const codes = new Map<string, Grant>();
  const access = new Map<string, Grant>();
  const refresh = new Map<string, Grant>();
  let refuse: number | null = null;
  let lose = false;
  const state: FakeLinkedIn = {
    fetch: async () => answer(500, {}),
    requests: [],
    posts: [],
    organizations: { "2414183": "Mezonas", "5550001": "Twelve Thirty-Four" },
    revoked: [],
    issueCode(grant = {}) {
      n += 1;
      const code = `code-${n}`;
      codes.set(code, {
        scopes: grant.scopes ?? ["w_organization_social", "r_organization_admin"],
        pages: grant.pages ?? ["2414183"],
        refresh: grant.refresh ?? true,
      });
      return code;
    },
    refuseNext(status) {
      refuse = status;
    },
    loseNextAnswer() {
      lose = true;
    },
    expireTokens() {
      access.clear();
    },
  };

  function tokens(g: Grant) {
    n += 1;
    const accessToken = `li-access-${n}`;
    access.set(accessToken, g);
    const out: Record<string, unknown> = {
      access_token: accessToken,
      expires_in: 5_184_000,
      scope: g.scopes.join(","),
    };
    if (g.refresh) {
      const r = `li-refresh-${n}`;
      refresh.set(r, g);
      out.refresh_token = r;
      out.refresh_token_expires_in = 31_536_000;
    }
    return out;
  }

  const bearer = (init?: HttpRequestInit) => {
    const auth = init?.headers?.authorization ?? "";
    return access.get(auth.replace(/^Bearer /, ""));
  };

  state.fetch = async (url, init) => {
    const method = init?.method ?? "GET";
    state.requests.push({ url, method, body: init?.body });
    if (url === LINKEDIN_TOKEN_URL && method === "POST") {
      const f = formDecode(init?.body ?? "");
      if (
        f.client_id !== FAKE_LINKEDIN.clientId ||
        f.client_secret !== FAKE_LINKEDIN.clientSecret
      ) {
        return answer(401, { error: "invalid_client" });
      }
      if (f.grant_type === "authorization_code") {
        const g = codes.get(f.code ?? "");
        if (!g) return answer(400, { error: "invalid_request" });
        codes.delete(f.code ?? "");
        return answer(200, tokens(g));
      }
      if (f.grant_type === "refresh_token") {
        const g = refresh.get(f.refresh_token ?? "");
        if (!g) return answer(400, { error: "invalid_grant" });
        return answer(200, tokens(g));
      }
      return answer(400, { error: "unsupported_grant_type" });
    }
    if (url === LINKEDIN_REVOKE_URL && method === "POST") {
      const f = formDecode(init?.body ?? "");
      if (f.token) {
        state.revoked.push(f.token);
        access.delete(f.token);
      }
      return answer(200, undefined);
    }
    if (!url.startsWith(`${LINKEDIN_API}/`)) return answer(404, { message: "not found" });
    const g = bearer(init);
    if (!g) return answer(401, { message: "Invalid access token", status: 401 });
    const path = url.slice(LINKEDIN_API.length);
    if (method === "GET" && path.startsWith("/organizationAcls?")) {
      const q = formDecode(path.slice(path.indexOf("?") + 1));
      if (q.q !== "roleAssignee" || !g.scopes.includes("r_organization_admin")) {
        return answer(403, { message: "Not enough permissions" });
      }
      return answer(200, {
        elements: g.pages.map((id) => ({
          organization: `urn:li:organization:${id}`,
          role: "ADMINISTRATOR",
          state: "APPROVED",
          roleAssignee: "urn:li:person:abc",
        })),
        paging: { count: 10, start: 0 },
      });
    }
    const org = /^\/organizations\/(\d+)$/.exec(path);
    if (method === "GET" && org) {
      const name = state.organizations[org[1] ?? ""];
      return name
        ? answer(200, { id: Number(org[1]), localizedName: name, vanityName: name.toLowerCase() })
        : answer(404, { message: "not found" });
    }
    if (method === "POST" && path === "/posts") {
      if (!g.scopes.includes("w_organization_social")) {
        return answer(403, { message: "Not enough permissions to post" });
      }
      const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
      const author = String(body.author ?? "");
      const orgId = /^urn:li:organization:(\d+)$/.exec(author)?.[1];
      if (!orgId || !g.pages.includes(orgId)) {
        return answer(403, { message: "Not an administrator of this organization" });
      }
      if (refuse !== null) {
        const status = refuse;
        refuse = null;
        return answer(status, { message: "Refused by the fake", status });
      }
      n += 1;
      const id = `urn:li:share:${7_000_000 + n}`;
      state.posts.push({
        author,
        id,
        body,
        version: init?.headers?.["linkedin-version"] ?? null,
      });
      if (lose) {
        lose = false;
        throw new Error("the connection dropped");
      }
      return answer(201, undefined, { "x-restli-id": id });
    }
    return answer(404, { message: "not found" });
  };
  return state;
}
