import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DESKTOP_DEVICE_HEADER,
  DESKTOP_SIGNATURE_HEADER,
  DESKTOP_TIME_HEADER,
  DesktopFileMeta,
  type DesktopFolder,
  desktopRequestText,
} from "@countersign/core";
import { describe, expect, it } from "vitest";
import { Api } from "./api";
import { Ingest, relativeIn, uploadBody } from "./ingest";
import { newDeviceKey, pkcePair, sha256Hex, signedHeaders } from "./keys";
import { Poller } from "./poller";

const DEVICE = "0192f7a0-0000-7000-8000-0000000000d1";
const FOLDER = "0192f7a0-0000-7000-8000-0000000000b1";
const NOW = new Date("2026-11-17T10:00:00Z");

describe("the computer's key", () => {
  it("signs requests the Worker can check with Web Crypto", async () => {
    const key = newDeviceKey();
    const body = '{"ok":true}';
    const headers = signedHeaders({
      deviceId: DEVICE,
      privatePem: key.privatePem,
      method: "post",
      path: "/api/desktop/jobs/1/result",
      body,
      at: NOW,
    });
    expect(headers[DESKTOP_DEVICE_HEADER]).toBe(DEVICE);
    expect(headers[DESKTOP_TIME_HEADER]).toBe(NOW.toISOString());
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      key.publicJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const text = desktopRequestText({
      deviceId: DEVICE,
      method: "POST",
      path: "/api/desktop/jobs/1/result",
      bodySha256: sha256Hex(body),
      at: NOW.toISOString(),
    });
    const signature = Buffer.from(headers[DESKTOP_SIGNATURE_HEADER] ?? "", "base64url");
    const verify = (t: string) =>
      crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        publicKey,
        signature,
        new TextEncoder().encode(t),
      );
    expect(await verify(text)).toBe(true);
    expect(await verify(text.replace("POST", "GET"))).toBe(false);
  });

  it("makes PKCE pairs the API's schemas take", () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
    expect(challenge).toMatch(/^[A-Za-z0-9\-_]{43}$/);
  });
});

function deviceApi(fetch: (url: string, init: RequestInit) => Promise<Response>) {
  const key = newDeviceKey();
  return new Api({
    origin: "https://staging.mezonas.com/",
    fetch,
    now: () => NOW,
    credentials: () => ({ kind: "none" }),
    renewed: () => undefined,
    ended: () => undefined,
    device: () => ({ deviceId: DEVICE, privatePem: key.privatePem }),
  });
}

describe("the poller", () => {
  const folder: DesktopFolder = {
    id: FOLDER,
    path: "/x",
    label: "Books",
    access: "read",
    ingest: false,
  };

  it("runs each job and posts its result, signed, and keeps the platform's folder list", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const api = deviceApi(async (url, init) => {
      calls.push({ url, init });
      if (init.method === "GET") {
        return Response.json({
          jobs: [
            {
              id: "0192f7a0-0000-7000-8000-00000000a001",
              issuedAt: NOW.toISOString(),
              expiresAt: NOW.toISOString(),
              request: { kind: "files.list", folderId: FOLDER, depth: 1, limit: 10 },
            },
          ],
          folders: [folder],
        });
      }
      return new Response(null, { status: 204 });
    });
    const statuses: string[] = [];
    let kept: DesktopFolder[] = [];
    const poller = new Poller({
      api,
      run: async () => ({ ok: true, output: { entries: [], truncated: false } }),
      folders: async (list) => {
        kept = list;
      },
      status: (s) => statuses.push(s),
      sleep: async () => undefined,
    });
    expect(await poller.once()).toBe(0);
    expect(statuses).toEqual(["online"]);
    expect(kept).toEqual([folder]);
    expect(calls.map((c) => [c.init.method, c.url])).toEqual([
      ["GET", "https://staging.mezonas.com/api/desktop/jobs?wait=25"],
      [
        "POST",
        "https://staging.mezonas.com/api/desktop/jobs/0192f7a0-0000-7000-8000-00000000a001/result",
      ],
    ]);
    const headers = calls[1]?.init.headers as Record<string, string>;
    expect(headers[DESKTOP_SIGNATURE_HEADER]).toBeTruthy();
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      ok: true,
      output: { entries: [], truncated: false },
    });
  });

  it("waits when the API has no desktop routes, backs off when offline, stops when removed", async () => {
    const answer = { status: 404 };
    const api = deviceApi(async () => {
      if (answer.status === 0) throw new Error("offline");
      return new Response("{}", { status: answer.status });
    });
    const statuses: string[] = [];
    const poller = new Poller({
      api,
      run: async () => ({ ok: true, output: {} }),
      folders: async () => undefined,
      status: (s) => statuses.push(s),
    });
    expect(await poller.once()).toBe(5 * 60_000);
    answer.status = 0;
    expect(await poller.once()).toBe(10_000);
    answer.status = 403;
    expect(await poller.once()).toBe(0);
    expect(statuses).toEqual(["waiting", "offline", "unpaired"]);
  });
});

describe("sending files", () => {
  it("names files inside their folder only", () => {
    expect(relativeIn("/a/Books", "/a/Books/Inbox/x.pdf")).toBe("Inbox/x.pdf");
    expect(relativeIn("/a/Books", "/a/Other/x.pdf")).toBeNull();
  });

  it("builds a multipart body whose meta the API's schema takes", async () => {
    const meta = {
      folderId: FOLDER,
      path: "Inbox/a.pdf",
      size: 3,
      sha256: sha256Hex("abc"),
      modifiedAt: NOW.toISOString(),
      contentType: "application/pdf",
    };
    const { body, contentType } = await uploadBody(meta, "a.pdf", new TextEncoder().encode("abc"));
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
    const form = await new Request("https://x.invalid/", {
      method: "POST",
      body: new Blob([body as Uint8Array<ArrayBuffer>]),
      headers: { "content-type": contentType },
    }).formData();
    expect(DesktopFileMeta.parse(JSON.parse(String(form.get("meta"))))).toEqual(meta);
    expect(await (form.get("file") as File).text()).toBe("abc");
  });

  it("sends new documents once, and skips old, hidden, lock and other files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mezonas-ingest-"));
    await mkdir(join(dir, "Inbox"));
    await writeFile(join(dir, "Inbox", "Northside 1042.pdf"), "%PDF-1.7");
    await writeFile(join(dir, "Inbox", "~$Costs.xlsx"), "lock");
    await writeFile(join(dir, "setup.exe"), "MZ");
    await writeFile(join(dir, "old.pdf"), "%PDF-1.4");
    await utimes(join(dir, "old.pdf"), new Date("2026-01-01"), new Date("2026-01-01"));
    const uploads: string[] = [];
    const sent = new Map<string, string>();
    const ingest = new Ingest({
      api: deviceApi(async (url, init) => {
        const form = await new Request(url, {
          method: "POST",
          body: init.body as BodyInit,
          headers: init.headers as Record<string, string>,
        }).formData();
        uploads.push(JSON.parse(String(form.get("meta"))).path);
        return new Response(null, { status: 201 });
      }),
      since: () => new Date("2026-11-01"),
      sent: (k) => sent.get(k) ?? null,
      recordSent: async (k, h) => {
        sent.set(k, h);
      },
      log: async () => undefined,
      settleMs: 0,
      sleep: async () => undefined,
    });
    const folder: DesktopFolder = {
      id: FOLDER,
      path: dir,
      label: "Books",
      access: "read",
      ingest: true,
    };
    await ingest.scan(folder);
    await ingest.scan(folder);
    expect(uploads).toEqual(["Inbox/Northside 1042.pdf"]);
  });
});
