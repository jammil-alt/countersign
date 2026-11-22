// The desktop app's API against a real database as cs_worker (docs/plan.md §1.151, §1.199):
// pairing a computer and its folders (a client admin only), the computer's signed requests
// (signature, time and key checked; a removed computer refused), jobs queued by `services.desktop`
// and answered once, files into documents, and the contract: no route returns the computer's key.

import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  type ConnectionRef,
  createDesktopConnector,
  DesktopJobError,
  DesktopUnavailableError,
  memoryCredentials,
  noopLogger,
  runReadTool,
} from "@countersign/connectors";
import {
  allRoutes,
  buildPath,
  DESKTOP_DEVICE_HEADER,
  DESKTOP_SIGNATURE_HEADER,
  DESKTOP_TIME_HEADER,
  type DesktopFileMeta,
  type DesktopFolder,
  desktopRequestText,
  type RouteSpec,
} from "@countersign/core";
import {
  auditEvent,
  connection,
  desktopDevice,
  desktopJob,
  document,
  withTenant,
} from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { type ApiHarness, admin, createApiHarness, OPERATOR, user } from "./api.test-helper";
import { dbDesktopServices } from "./desktop/services";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

/** A computer's key, as apps/desktop makes it (keys.ts). */
function computerKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  return {
    privateKey,
    publicKey: { kty: "EC" as const, crv: "P-256" as const, x: String(jwk.x), y: String(jwk.y) },
  };
}
type Key = ReturnType<typeof computerKey>;

const h = await createApiHarness({ connectors: () => [createDesktopConnector()] });
const H = h as ApiHarness;
afterAll(() => h?.close());

/** A request signed as apps/desktop signs it (api.ts asDevice). */
async function asDevice(
  deviceId: string,
  key: Key,
  method: string,
  path: string,
  body: Uint8Array | string = "",
  opts: { contentType?: string; at?: Date; tamper?: boolean } = {},
) {
  const at = (opts.at ?? new Date()).toISOString();
  const text = desktopRequestText({
    deviceId,
    method,
    path: path.split("?")[0] ?? path,
    bodySha256: createHash("sha256").update(body).digest("hex"),
    at,
  });
  const signature = sign("sha256", Buffer.from(opts.tamper ? `${text}x` : text), {
    key: key.privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  const res = await H.app.request(
    path,
    {
      method,
      headers: {
        accept: "application/json",
        [DESKTOP_DEVICE_HEADER]: deviceId,
        [DESKTOP_TIME_HEADER]: at,
        [DESKTOP_SIGNATURE_HEADER]: signature,
        ...(method === "GET" ? {} : { "content-type": opts.contentType ?? "application/json" }),
      },
      ...(method === "GET"
        ? {}
        : { body: typeof body === "string" ? body : (body as Uint8Array<ArrayBuffer>) }),
    },
    H.env,
  );
  const textBody = await res.text();
  let json: unknown = null;
  try {
    json = textBody ? JSON.parse(textBody) : null;
  } catch {
    json = textBody;
  }
  return { status: res.status, json };
}

async function pair(client: "a" | "b" = "a", name = "Front office PC") {
  const key = computerKey();
  const r = await H.call(admin(client), "POST", "/api/desktop/devices", {
    name,
    platform: "windows",
    appVersion: "0.1.0",
    publicKey: key.publicKey,
  });
  expect(r.status).toBe(200);
  return { key, paired: j(r.json) as { deviceId: string; connectionId: string; tenantId: string } };
}

const folder = (over: Partial<DesktopFolder> = {}): DesktopFolder => ({
  id: crypto.randomUUID(),
  path: "C:\\Users\\ana\\Documents\\Accounting",
  label: "Accounting",
  access: "read_write",
  ingest: true,
  ...over,
});

async function connRef(tenantId: string, connectionId: string): Promise<ConnectionRef> {
  const [row] = await withTenant(H.db, tenantId, (tx) =>
    tx.select().from(connection).where(eq(connection.id, connectionId)),
  );
  if (!row) throw new Error("no connection");
  return {
    id: row.id,
    tenantId: row.tenantId,
    connector: row.connector,
    status: row.status,
    externalAccountId: row.externalAccountId,
    config: row.config as ConnectionRef["config"],
    permissions: {},
  };
}

/** Takes the computer's jobs as the app does, and answers each with `answer`. */
async function answerAll(
  deviceId: string,
  key: Key,
  answer: (request: Record<string, unknown>) => unknown,
) {
  for (let i = 0; i < 50; i++) {
    const got = await asDevice(deviceId, key, "GET", "/api/desktop/jobs?wait=0");
    expect(got.status).toBe(200);
    const jobs = j(got.json).jobs as { id: string; request: Record<string, unknown> }[];
    if (jobs.length === 0) {
      await new Promise((done) => setTimeout(done, 20));
      continue;
    }
    for (const job of jobs) {
      const r = await asDevice(
        deviceId,
        key,
        "POST",
        `/api/desktop/jobs/${job.id}/result`,
        JSON.stringify(answer(job.request)),
      );
      expect(r.status).toBe(200);
    }
    return jobs;
  }
  throw new Error("no job arrived");
}

describe.skipIf(!h)("the desktop app's API", () => {
  it("pairs a computer for a client admin only, and never answers its key", async () => {
    const key = computerKey();
    const body = { name: "PC", platform: "mac", appVersion: "0.1.0", publicKey: key.publicKey };
    expect((await H.call(user("a"), "POST", "/api/desktop/devices", body)).status).toBe(403);
    expect((await H.call(OPERATOR, "POST", "/api/desktop/devices", body)).status).toBe(403);
    expect((await H.call(null, "POST", "/api/desktop/devices", body)).status).toBe(401);

    const { key: k, paired } = await pair("a");
    expect(paired).toMatchObject({ tenantId: H.A.tenantId, clientName: expect.any(String) });
    const [row] = await withTenant(H.db, H.A.tenantId, (tx) =>
      tx.select().from(desktopDevice).where(eq(desktopDevice.id, paired.deviceId)),
    );
    expect(row).toMatchObject({ connectionId: paired.connectionId, platform: "windows" });
    expect(row?.publicKey).toEqual(k.publicKey);
    const [conn] = await withTenant(H.db, H.A.tenantId, (tx) =>
      tx.select().from(connection).where(eq(connection.id, paired.connectionId)),
    );
    expect(conn).toMatchObject({ connector: "desktop", status: "connected" });
    expect(conn?.config).toMatchObject({ deviceId: paired.deviceId, folders: [] });
  });

  it("takes the folder list from a client admin, checked, and gives it to the computer", async () => {
    const { key, paired } = await pair("a", "Folders PC");
    const path = `/api/desktop/devices/${paired.deviceId}/folders`;
    const given = [folder(), folder({ path: "D:\\Books", label: "Books", access: "read" })];
    expect((await H.call(user("a"), "PUT", path, { folders: given })).status).toBe(403);
    expect((await H.call(admin("b"), "PUT", path, { folders: given })).status).toBe(404);
    for (const bad of [
      [folder({ path: "\\\\server\\share\\Books" })],
      [folder({ path: "relative\\Books" })],
      [folder(), folder({ path: "c:\\users\\ana\\documents\\accounting" })],
    ]) {
      expect((await H.call(admin("a"), "PUT", path, { folders: bad })).status).toBe(400);
    }
    const r = await H.call(admin("a"), "PUT", path, { folders: given });
    expect(r.status).toBe(200);
    expect(j(r.json).folders).toEqual(given);
    const jobs = await asDevice(paired.deviceId, key, "GET", "/api/desktop/jobs?wait=0");
    expect(jobs.status).toBe(200);
    expect(j(jobs.json)).toEqual({ jobs: [], folders: given });
  });

  it("refuses a request that isn't the computer's, out of time, or from a removed computer", async () => {
    const { key, paired } = await pair("a", "Refused PC");
    const path = "/api/desktop/jobs?wait=0";
    expect((await asDevice(paired.deviceId, key, "GET", path)).status).toBe(200);
    // Another key, a changed text, an unknown computer, no signature at all.
    expect((await asDevice(paired.deviceId, computerKey(), "GET", path)).status).toBe(401);
    expect((await asDevice(paired.deviceId, key, "GET", path, "", { tamper: true })).status).toBe(
      401,
    );
    expect((await asDevice(crypto.randomUUID(), key, "GET", path)).status).toBe(401);
    expect((await H.app.request(path, { method: "GET" }, H.env)).status).toBe(401);
    // A signature over another body.
    const signedOther = await asDevice(
      paired.deviceId,
      key,
      "POST",
      `/api/desktop/jobs/${crypto.randomUUID()}/result`,
      '{"ok":true,"output":{}}',
    );
    expect(signedOther.status).toBe(404);
    // The clock: 400, so the app keeps trying once its clock is right.
    const late = await asDevice(paired.deviceId, key, "GET", path, "", {
      at: new Date(Date.now() - 10 * 60_000),
    });
    expect(late.status).toBe(400);
    expect(j(late.json).error.code).toBe("clock");

    // Another client's admin can't remove it; its own can.
    expect(
      (await H.call(admin("b"), "DELETE", `/api/desktop/devices/${paired.deviceId}`)).status,
    ).toBe(404);
    expect(
      (await H.call(admin("a"), "DELETE", `/api/desktop/devices/${paired.deviceId}`)).status,
    ).toBe(200);
    expect((await asDevice(paired.deviceId, key, "GET", path)).status).toBe(401);
    const [row] = await withTenant(H.db, H.A.tenantId, (tx) =>
      tx.select().from(desktopDevice).where(eq(desktopDevice.id, paired.deviceId)),
    );
    expect(row?.revokedAt).not.toBeNull();
    expect(row?.publicKey).toBeNull();
    const [conn] = await withTenant(H.db, H.A.tenantId, (tx) =>
      tx.select().from(connection).where(eq(connection.id, paired.connectionId)),
    );
    expect(conn?.status).toBe("disconnected");
    // And a job for it is never queued: the computer can't answer.
    const services = dbDesktopServices(H.db, await connRef(H.A.tenantId, paired.connectionId));
    await expect(
      services.run(paired.connectionId, {
        kind: "files.list",
        folderId: crypto.randomUUID(),
        depth: 1,
        limit: 10,
      }),
    ).rejects.toBeInstanceOf(DesktopUnavailableError);

    const refusals = await withTenant(H.db, H.A.tenantId, (tx) =>
      tx
        .select()
        .from(auditEvent)
        .where(and(eq(auditEvent.tenantId, H.A.tenantId), eq(auditEvent.outcome, "refused"))),
    );
    expect(
      refusals.some(
        (r) =>
          (r.target as Record<string, string>).device === paired.deviceId && r.httpStatus === 401,
      ),
    ).toBe(true);
  });

  it("hands a step's job to the computer and gives back its answer, once", async () => {
    const { key, paired } = await pair("a", "Jobs PC");
    const books = folder({ label: "Books" });
    await H.call(admin("a"), "PUT", `/api/desktop/devices/${paired.deviceId}/folders`, {
      folders: [books],
    });
    const ref = await connRef(H.A.tenantId, paired.connectionId);
    const services = dbDesktopServices(H.db, ref, { everyMs: 20 });

    // Through the connector's own tool, as a run calls it.
    const pending = runReadTool(
      createDesktopConnector(),
      "desktop.files.list",
      { folderId: books.id },
      {
        tenantId: H.A.tenantId,
        connection: ref,
        credentials: memoryCredentials({}),
        logger: noopLogger,
        now: () => new Date(),
        services: { desktop: services },
      },
    );
    const output = {
      entries: [{ path: "a.pdf", kind: "file", size: 3, modifiedAt: null }],
      truncated: false,
    };
    const jobs = await answerAll(paired.deviceId, key, (request) => {
      expect(request).toMatchObject({ kind: "files.list", folderId: books.id });
      return { ok: true, output };
    });
    expect((await pending).output).toEqual(output);

    // Answered once: a second answer is refused, and another computer can't answer it.
    const jobId = jobs[0]?.id ?? "";
    const again = await asDevice(
      paired.deviceId,
      key,
      "POST",
      `/api/desktop/jobs/${jobId}/result`,
      JSON.stringify({ ok: true, output }),
    );
    expect(again.status).toBe(409);
    const other = await pair("a", "Other PC");
    const foreign = await asDevice(
      other.paired.deviceId,
      other.key,
      "POST",
      `/api/desktop/jobs/${jobId}/result`,
      JSON.stringify({ ok: true, output }),
    );
    expect(foreign.status).toBe(404);

    // A refusal from the computer reaches the step as the computer's words.
    const refused = services.run(paired.connectionId, {
      kind: "file.read",
      folderId: books.id,
      path: "Notes/a.txt",
    });
    await answerAll(paired.deviceId, key, () => ({
      ok: false,
      error: { code: "not_found", message: "Notes/a.txt isn't there" },
    }));
    expect(await refused).toEqual({
      ok: false,
      error: { code: "not_found", message: "Notes/a.txt isn't there" },
    });
    // A malformed answer is refused at the route.
    const bad = services.run(paired.connectionId, {
      kind: "file.read",
      folderId: books.id,
      path: "b.txt",
    });
    const got = await asDevice(paired.deviceId, key, "GET", "/api/desktop/jobs?wait=5");
    const badJob = j(got.json).jobs[0].id;
    expect(
      (
        await asDevice(
          paired.deviceId,
          key,
          "POST",
          `/api/desktop/jobs/${badJob}/result`,
          JSON.stringify({ ok: "yes" }),
        )
      ).status,
    ).toBe(400);
    await asDevice(
      paired.deviceId,
      key,
      "POST",
      `/api/desktop/jobs/${badJob}/result`,
      JSON.stringify({ ok: false, error: { code: "failed", message: "x" } }),
    );
    expect((await bad).ok).toBe(false);
  });

  it("gives up on a job the computer doesn't take in time, and on an answer that never comes", async () => {
    const { key, paired } = await pair("a", "Asleep PC");
    const ref = await connRef(H.A.tenantId, paired.connectionId);
    let clock = Date.now();
    const timing = {
      now: () => new Date(clock),
      sleep: async () => {
        clock += 30_000;
      },
    };
    await expect(
      dbDesktopServices(H.db, ref, timing).run(paired.connectionId, {
        kind: "files.list",
        folderId: crypto.randomUUID(),
        depth: 1,
        limit: 10,
      }),
    ).rejects.toBeInstanceOf(DesktopUnavailableError);
    // (This job's own expiry is by the database's clock, not the test's: take it out of the way.)
    await asDevice(paired.deviceId, key, "GET", "/api/desktop/jobs?wait=0");
    // A job past its expiry is never handed out.
    await withTenant(H.db, H.A.tenantId, (tx) =>
      tx.insert(desktopJob).values({
        tenantId: H.A.tenantId,
        deviceId: paired.deviceId,
        kind: "files.list",
        request: { kind: "files.list", folderId: crypto.randomUUID(), depth: 1, limit: 10 },
        issuedAt: new Date(Date.now() - 200_000),
        expiresAt: new Date(Date.now() - 80_000),
      }),
    );
    const got = await asDevice(paired.deviceId, key, "GET", "/api/desktop/jobs?wait=0");
    expect(j(got.json).jobs).toEqual([]);

    // Taken, then silence: a failure the step can see (the write's key keeps a retry to once).
    clock = Date.now();
    let taken = false;
    const silent = dbDesktopServices(H.db, ref, {
      now: () => new Date(clock),
      sleep: async () => {
        if (!taken) {
          const r = await asDevice(paired.deviceId, key, "GET", "/api/desktop/jobs?wait=0");
          taken = j(r.json).jobs.length > 0;
        }
        clock += 30_000;
      },
    }).run(paired.connectionId, {
      kind: "files.list",
      folderId: crypto.randomUUID(),
      depth: 1,
      limit: 10,
    });
    await expect(silent).rejects.toBeInstanceOf(DesktopJobError);
    expect(taken).toBe(true);
  });

  it("stores a file from a folder set to send as a document, once", async () => {
    const { key, paired } = await pair("a", "Scanner PC");
    const inbox = folder({ label: "Scans", ingest: true });
    const quiet = folder({
      path: "C:\\Users\\ana\\Documents\\Quiet",
      label: "Quiet",
      ingest: false,
    });
    await H.call(admin("a"), "PUT", `/api/desktop/devices/${paired.deviceId}/folders`, {
      folders: [inbox, quiet],
    });
    const bytes = new TextEncoder().encode("%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n%%EOF");
    const upload = async (f: DesktopFolder, path = "Invoices/inv-1.pdf", data = bytes) => {
      const meta: DesktopFileMeta = {
        folderId: f.id,
        path,
        size: data.length,
        sha256: createHash("sha256").update(data).digest("hex"),
        modifiedAt: new Date().toISOString(),
        contentType: "application/pdf",
      };
      const form = new FormData();
      form.set("meta", JSON.stringify(meta));
      form.set(
        "file",
        new Blob([data as Uint8Array<ArrayBuffer>], { type: meta.contentType }),
        "inv-1.pdf",
      );
      const req = new Request("https://local.invalid/", { method: "POST", body: form });
      const body = new Uint8Array(await req.arrayBuffer());
      return asDevice(paired.deviceId, key, "POST", "/api/desktop/files", body, {
        contentType: req.headers.get("content-type") ?? "",
      });
    };
    expect((await upload(quiet)).status).toBe(403);
    expect((await upload(folder())).status).toBe(403);
    expect((await upload(inbox, "Invoices/run.exe")).status).toBe(415);
    const first = await upload(inbox);
    expect(first.status).toBe(200);
    expect(j(first.json).created).toBe(true);
    const second = await upload(inbox);
    expect(j(second.json)).toEqual({ documentId: j(first.json).documentId, created: false });
    const [doc] = await withTenant(H.db, H.A.tenantId, (tx) =>
      tx
        .select()
        .from(document)
        .where(eq(document.id, j(first.json).documentId)),
    );
    expect(doc).toMatchObject({
      source: "connector",
      connectionId: paired.connectionId,
      filename: "inv-1.pdf",
      mimeType: "application/pdf",
    });
    expect(doc?.meta).toMatchObject({ desktop: { deviceId: paired.deviceId, folderId: inbox.id } });
    await H.settle();
  });

  it("returns the computer's key from no route a person can call (contract)", async () => {
    const { key, paired } = await pair("a", "Contract PC");
    await H.call(admin("a"), "PUT", `/api/desktop/devices/${paired.deviceId}/folders`, {
      folders: [folder()],
    });
    // Statically: no response schema names a public key.
    for (const [name, r] of Object.entries(allRoutes) as [string, RouteSpec][]) {
      const shape = JSON.stringify(r.response.toJSONSchema?.({ unrepresentable: "any" }) ?? {});
      expect(shape.includes("publicKey") || shape.includes("public_key"), name).toBe(false);
    }
    // And at run time: every GET route without parameters, as the client's admin and user and
    // as the operator, answers nothing with the key's halves in it.
    const gets = (Object.values(allRoutes) as RouteSpec[]).filter(
      (r) => r.method === "GET" && r.auth === "session" && !r.path.includes(":"),
    );
    expect(gets.length).toBeGreaterThan(20);
    for (const who of [admin("a"), user("a"), OPERATOR]) {
      for (const r of gets) {
        const res = await H.call(who, "GET", buildPath(r.path, undefined));
        const text = JSON.stringify(res.json);
        expect(text.includes(key.publicKey.x), `${who} ${r.path}`).toBe(false);
        expect(text.includes(key.publicKey.y), `${who} ${r.path}`).toBe(false);
      }
    }
    await H.settle();
  });
});
