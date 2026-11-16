// A fake OneDrive for tests (re-exported by @countersign/connectors/testing; never imported by the
// Worker): the shared fake Microsoft sign-in, and Graph's drive routes the connector calls — the
// app folder (`special/approot`, made on first use), items by id and by name under a folder,
// folder creation and simple uploads with `conflictBehavior=fail`, and children with paging. An
// AppFolder grant reaches only the app folder and what is under it; anything else is 403, as
// Microsoft keeps it. Shaped like Graph's answers as far as we know them (NOTES.md).

import { formDecode, type HttpResponseLike, parseUrl, type UrlLike } from "../http";
import {
  fakeMicrosoftIdentity,
  graphErrorResponse,
  jsonResponse,
  unauthorized,
} from "../microsoft/fake";
import { GRAPH_API, type GraphFetch } from "../microsoft/identity";
import { fromUtf8, utf8 } from "../runtime";
import { ONEDRIVE_GRAPH_SCOPE } from "./index";

export interface FakeDriveItem {
  id: string;
  name: string;
  parentId: string | null;
  folder: boolean;
  bytes?: Uint8Array;
  mimeType?: string;
  created: string;
  modified: string;
}

export interface FakeOnedrive {
  fetch: GraphFetch;
  identity: ReturnType<typeof fakeMicrosoftIdentity>;
  items: Map<string, FakeDriveItem>;
  requests: { url: string; method: string }[];
  issueCode: ReturnType<typeof fakeMicrosoftIdentity>["issueCode"];
  /** The app folder's id, once something made it. */
  appRoot(): string | null;
  /** The item at this path under the app folder (`Bills/2026/10/x.pdf`), or undefined. */
  at(path: string): FakeDriveItem | undefined;
  /** The text of a file at a path under the app folder. */
  text(path: string): string | undefined;
  /** A file outside the app folder (the person's own), which an AppFolder grant can't reach. */
  addOutside(name: string): FakeDriveItem;
  /** The next this-many uploads fail with this status (nothing stored). */
  failUploads(count: number, status: number): void;
  /** The next upload is stored, but its answer is lost (the call throws). */
  loseNextUploadAnswer(): void;
}

const APP_NAME = "Mezonas";

export function fakeOnedrive(): FakeOnedrive {
  const identity = fakeMicrosoftIdentity([`https://graph.microsoft.com/${ONEDRIVE_GRAPH_SCOPE}`]);
  const items = new Map<string, FakeDriveItem>();
  const requests: FakeOnedrive["requests"] = [];
  let n = 0;
  let appRootId: string | null = null;
  let failing = { count: 0, status: 500 };
  let loseAnswer = false;
  const stamp = () => new Date(Date.UTC(2026, 10, 6, 15, 0, n)).toISOString();

  // The drive's own root, which an AppFolder grant can't see.
  const driveRoot: FakeDriveItem = {
    id: "ROOT",
    name: "root",
    parentId: null,
    folder: true,
    created: stamp(),
    modified: stamp(),
  };
  items.set(driveRoot.id, driveRoot);

  function make(
    parentId: string,
    name: string,
    folder: boolean,
    extra: Partial<FakeDriveItem> = {},
  ) {
    const item: FakeDriveItem = {
      id: `01FAKE${String(++n).padStart(4, "0")}`,
      name,
      parentId,
      folder,
      created: stamp(),
      modified: stamp(),
      ...extra,
    };
    items.set(item.id, item);
    return item;
  }

  function appRoot(): FakeDriveItem {
    if (!appRootId) {
      const apps =
        [...items.values()].find((i) => i.parentId === "ROOT" && i.name === "Apps") ??
        make("ROOT", "Apps", true);
      appRootId = make(apps.id, APP_NAME, true).id;
    }
    return items.get(appRootId) as FakeDriveItem;
  }

  function underAppRoot(item: FakeDriveItem): boolean {
    let cur: FakeDriveItem | undefined = item;
    while (cur) {
      if (cur.id === appRootId) return true;
      cur = cur.parentId ? items.get(cur.parentId) : undefined;
    }
    return false;
  }

  function json(item: FakeDriveItem) {
    return {
      id: item.id,
      name: item.name,
      createdDateTime: item.created,
      lastModifiedDateTime: item.modified,
      webUrl: `https://onedrive.example/${item.id}`,
      parentReference: item.parentId ? { id: item.parentId } : {},
      ...(item.folder
        ? { folder: { childCount: childrenOf(item.id).length } }
        : {
            file: { mimeType: item.mimeType ?? "application/octet-stream" },
            size: item.bytes?.length ?? 0,
          }),
    };
  }

  const childrenOf = (id: string) =>
    [...items.values()]
      .filter((i) => i.parentId === id)
      .sort((a, b) => Number(b.folder) - Number(a.folder) || a.name.localeCompare(b.name));

  const childNamed = (id: string, name: string) =>
    [...items.values()].find(
      (i) => i.parentId === id && i.name.toLowerCase() === name.toLowerCase(),
    );

  const notFound = () =>
    graphErrorResponse(404, "itemNotFound", "The resource could not be found.");
  const denied = () => graphErrorResponse(403, "accessDenied", "Access denied");

  function route(
    method: string,
    url: UrlLike,
    body: string | Uint8Array | undefined,
    headers: Record<string, string> | undefined,
  ): HttpResponseLike {
    const grant = identity.grantFor(headers);
    if (!grant) return unauthorized();
    const appOnly =
      identity.hasScope(grant, ONEDRIVE_GRAPH_SCOPE) &&
      !identity.hasScope(grant, "Files.ReadWrite");
    if (!appOnly && !identity.hasScope(grant, "Files.ReadWrite")) return denied();
    const reach = (item: FakeDriveItem | undefined) =>
      !item ? notFound() : appOnly && !underAppRoot(item) ? denied() : null;

    const q = url.href.indexOf("?");
    const params = formDecode(q < 0 ? "" : url.href.slice(q + 1));
    const path = decodeURIComponent(url.pathname.replace(/^\/v1\.0/, ""));
    if (method === "GET" && path === "/me/drive/special/approot") {
      return jsonResponse(200, json(appRoot()));
    }
    // /me/drive/items/{id}:/{name}:/content (upload)
    const upload = /^\/me\/drive\/items\/([^/:]+):\/(.+):\/content$/.exec(path);
    if (upload && method === "PUT") {
      const parent = items.get(upload[1] as string);
      const refused = reach(parent);
      if (refused) return refused;
      if (failing.count > 0) {
        failing.count--;
        return graphErrorResponse(failing.status, "generalException", "Something went wrong");
      }
      const name = upload[2] as string;
      const existing = childNamed(parent?.id as string, name);
      if (existing && params["@microsoft.graph.conflictBehavior"] === "fail") {
        return graphErrorResponse(
          409,
          "nameAlreadyExists",
          "The specified item name already exists.",
        );
      }
      if (existing) items.delete(existing.id);
      const bytes = typeof body === "string" ? utf8(body) : (body ?? new Uint8Array());
      const item = make(parent?.id as string, name, false, {
        bytes,
        mimeType: headers?.["content-type"] ?? "application/octet-stream",
      });
      if (loseAnswer) {
        loseAnswer = false;
        throw new Error("the connection closed before OneDrive answered");
      }
      return jsonResponse(201, json(item));
    }
    // /me/drive/items/{id}:/{name} (by name under a folder)
    const byName = /^\/me\/drive\/items\/([^/:]+):\/(.+)$/.exec(path);
    if (byName && method === "GET") {
      const parent = items.get(byName[1] as string);
      const refused = reach(parent);
      if (refused) return refused;
      const found = childNamed(parent?.id as string, byName[2] as string);
      return found ? jsonResponse(200, json(found)) : notFound();
    }
    const children = /^\/me\/drive\/items\/([^/:]+)\/children$/.exec(path);
    if (children) {
      const parent = items.get(children[1] as string);
      const refused = reach(parent);
      if (refused) return refused;
      if (method === "POST") {
        const req = JSON.parse(
          typeof body === "string" ? body : fromUtf8(body ?? new Uint8Array()),
        ) as {
          name: string;
          folder?: object;
          "@microsoft.graph.conflictBehavior"?: string;
        };
        if (childNamed(parent?.id as string, req.name)) {
          return graphErrorResponse(
            409,
            "nameAlreadyExists",
            "The specified item name already exists.",
          );
        }
        return jsonResponse(201, json(make(parent?.id as string, req.name, Boolean(req.folder))));
      }
      const all = childrenOf(parent?.id as string);
      const top = Number(params.$top ?? "200");
      const skip = Number(params.$skiptoken ?? "0");
      const page = all.slice(skip, skip + top);
      const next =
        skip + top < all.length
          ? `${GRAPH_API}/me/drive/items/${parent?.id}/children?$top=${top}&$skiptoken=${skip + top}`
          : undefined;
      return jsonResponse(200, {
        value: page.map(json),
        ...(next ? { "@odata.nextLink": next } : {}),
      });
    }
    const byId = /^\/me\/drive\/items\/([^/:]+)$/.exec(path);
    if (byId && method === "GET") {
      const item = items.get(byId[1] as string);
      const refused = reach(item);
      if (refused) return refused;
      return jsonResponse(200, json(item as FakeDriveItem));
    }
    return graphErrorResponse(400, "invalidRequest", `no fake for ${method} ${path}`);
  }

  function at(path: string): FakeDriveItem | undefined {
    if (!appRootId) return undefined;
    let cur: FakeDriveItem | undefined = items.get(appRootId);
    for (const name of path.split("/").filter(Boolean)) {
      cur = cur ? childNamed(cur.id, name) : undefined;
    }
    return cur;
  }

  return {
    identity,
    items,
    requests,
    issueCode: (opts) => identity.issueCode(opts),
    appRoot: () => appRootId,
    at,
    text: (path) => {
      const b = at(path)?.bytes;
      return b ? fromUtf8(b) : undefined;
    },
    addOutside: (name) => make("ROOT", name, false, { bytes: utf8("private") }),
    failUploads(count, status) {
      failing = { count, status };
    },
    loseNextUploadAnswer() {
      loseAnswer = true;
    },
    fetch: async (url, init) => {
      requests.push({ url, method: init?.method ?? "GET" });
      const token = identity.handle(url, init);
      if (token) return token;
      const u = parseUrl(url);
      if (u?.origin !== "https://graph.microsoft.com") {
        throw new Error(`the fake OneDrive was asked for ${url}`);
      }
      return route(init?.method ?? "GET", u, init?.body, init?.headers);
    },
  };
}
