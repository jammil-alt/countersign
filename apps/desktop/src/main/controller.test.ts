import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { MOBILE_SESSION_HEADER } from "@countersign/core";
import { beforeEach, describe, expect, it } from "vitest";
import { Controller, describeJob, type Shell } from "./controller";
import { Store } from "./store";
import { type Crypt, Vault } from "./vault";

const TENANT = "0192f7a0-0000-7000-8000-000000000001";
const DEVICE = "0192f7a0-0000-7000-8000-0000000000d1";
const CONNECTION = "0192f7a0-0000-7000-8000-000000000005";
const NOW = new Date("2026-11-17T10:00:00Z");

const plainCrypt: Crypt = {
  available: () => true,
  encrypt: (s) => Buffer.from(`sealed:${s}`),
  decrypt: (b) => b.toString().replace(/^sealed:/, ""),
};

interface Fake {
  role: "client_admin" | "client_user";
  inbox: { id: string; title: string }[];
  requests: { method: string; path: string; body: unknown; session: string | null }[];
  /** The folder list Mezonas keeps for the computer. */
  folders: unknown[];
}

function fakeApi(fake: Fake) {
  return async (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const headers = (init.headers ?? {}) as Record<string, string>;
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    fake.requests.push({
      method: init.method ?? "GET",
      path: u.pathname,
      body,
      session: headers[MOBILE_SESSION_HEADER] ?? null,
    });
    const route = `${init.method} ${u.pathname}`;
    if (route === "POST /api/mobile/session") {
      return Response.json({ session: "sealed-session", expiresAt: "2026-11-17T22:00:00Z" });
    }
    if (route === "GET /api/session") {
      return Response.json({
        user: { id: "u1", email: "ana@hartley.test", name: "Ana Ruiz" },
        operator: false,
        tenants: [{ id: TENANT, name: "Hartley Millwork", role: fake.role }],
        activeTenantId: TENANT,
        language: { effective: "en", user: null, client: null },
      });
    }
    if (route === "GET /api/inbox") {
      return Response.json({
        items: fake.inbox.map((i) => ({
          ...i,
          kind: "approval",
          payload: {},
          status: "open",
          runId: null,
          dueAt: null,
          createdAt: NOW.toISOString(),
          resolvedAt: null,
          resolvedBy: null,
        })),
      });
    }
    if (route === "POST /api/desktop/devices") {
      return Response.json(
        {
          deviceId: DEVICE,
          tenantId: TENANT,
          clientName: "Hartley Millwork",
          connectionId: CONNECTION,
        },
        { status: 201 },
      );
    }
    if (route === `PUT /api/desktop/devices/${DEVICE}/folders`) {
      fake.folders = body.folders;
      return Response.json(body);
    }
    if (route === "GET /api/desktop/jobs") {
      return Response.json({ jobs: [], folders: fake.folders });
    }
    return Response.json({ error: { code: "not_found", message: "no" } }, { status: 404 });
  };
}

let dir: string;
let home: string;
let fake: Fake;
let opened: string[];
let notes: string[];
let picked: string | null;
let controller: Controller;

beforeEach(async () => {
  // Not under the system's temporary folder: the folder rules refuse /tmp and /private.
  const base = join(import.meta.dirname, "../../node_modules/.tmp");
  await mkdir(base, { recursive: true });
  dir = await mkdtemp(join(base, "mezonas-app-"));
  home = join(dir, "home");
  await mkdir(join(home, "Documents", "Books"), { recursive: true });
  await mkdir(join(home, ".ssh"), { recursive: true });
  fake = { role: "client_admin", inbox: [], requests: [], folders: [] };
  opened = [];
  notes = [];
  picked = null;
  const shell: Shell = {
    openExternal: async (url) => {
      opened.push(url);
    },
    notify: (_title, body) => notes.push(body),
    chooseFolder: async () => picked,
    showFolder: async () => undefined,
    setOpenAtLogin: () => undefined,
    homedir: home,
    platform: "mac",
    appVersion: "0.1.0",
    computerName: "Ana's MacBook",
  };
  controller = new Controller({
    origin: "https://staging.mezonas.com",
    store: new Store(join(dir, "data"), () => NOW),
    vault: new Vault(join(dir, "data"), plainCrypt),
    shell,
    fetch: fakeApi(fake),
    now: () => NOW,
  });
  await controller.start();
});

async function signIn() {
  await controller.signIn();
  const challenge = new URL(opened[0] ?? "").searchParams.get("challenge");
  expect(challenge).toMatch(/^[A-Za-z0-9\-_]{43}$/);
  await controller.handleUrl("mezonas://signed-in?code=handoff-code");
}

describe("signing in", () => {
  it("opens the browser at the phone's sign-in and redeems the handoff with the verifier", async () => {
    await signIn();
    expect(opened[0]).toMatch(/^https:\/\/staging\.mezonas\.com\/api\/mobile\/sign-in\?challenge=/);
    // §1.219: the desktop app names itself, for the confirm page and the audit rows.
    expect(opened[0]).toMatch(/&app=desktop$/);
    const redeem = fake.requests.find((r) => r.path === "/api/mobile/session");
    expect(redeem?.body).toMatchObject({ code: "handoff-code" });
    expect(controller.view().person).toEqual({
      name: "Ana Ruiz",
      email: "ana@hartley.test",
      clientName: "Hartley Millwork",
      admin: true,
    });
    // Later requests carry the session in the phone's header.
    expect(fake.requests.find((r) => r.path === "/api/session")?.session).toBe("sealed-session");
  });

  it("ignores links it didn't ask for and says why sign-in failed", async () => {
    await controller.handleUrl("mezonas://signed-in?code=unasked");
    expect(controller.view().person).toBeNull();
    expect(controller.view().notice?.tone).toBe("risk");
    await controller.signIn();
    await controller.handleUrl("mezonas://signed-in?error=operator");
    expect(controller.view().notice?.text).toMatch(/back office/);
  });
});

describe("pairing and folders", () => {
  it("only an admin adds the computer; its key's public half goes to Mezonas", async () => {
    fake.role = "client_user";
    await signIn();
    expect(await controller.pair("Front office PC")).toMatchObject({ ok: false, message: /admin/ });
    fake.role = "client_admin";
    await controller.handleUrl("mezonas://signed-in?code=x");
    await signIn();
    expect(await controller.pair("Front office PC")).toEqual({ ok: true });
    const pairing = fake.requests.find((r) => r.path === "/api/desktop/devices");
    expect(pairing?.body).toMatchObject({
      name: "Front office PC",
      platform: "mac",
      publicKey: { kty: "EC", crv: "P-256" },
    });
    expect(JSON.stringify(pairing?.body)).not.toContain("PRIVATE");
    expect(controller.view().device).toEqual({
      name: "Front office PC",
      clientName: "Hartley Millwork",
    });
    controller.stop();
  });

  it("gives a work folder, refuses home and hidden folders, and sends the list to Mezonas", async () => {
    await signIn();
    await controller.pair("Front office PC");
    picked = home;
    expect(await controller.chooseFolder()).toMatchObject({ ok: false, message: /home folder/ });
    picked = join(home, ".ssh");
    expect(await controller.chooseFolder()).toMatchObject({ ok: false, message: /Hidden/ });
    picked = join(home, "Documents", "Books");
    const choice = await controller.chooseFolder();
    expect(choice).toMatchObject({ ok: true, label: "Books" });
    if (!choice?.ok) throw new Error("not chosen");
    expect(
      await controller.addFolder({
        path: choice.path,
        label: "Books",
        access: "read_write",
        ingest: true,
      }),
    ).toEqual({ ok: true });
    // The window can't slip in a folder the picker would refuse.
    expect(
      await controller.addFolder({ path: home, label: "All", access: "read_write", ingest: false }),
    ).toMatchObject({ ok: false });
    const put = fake.requests.filter((r) => r.method === "PUT");
    expect(put).toHaveLength(1);
    expect((put[0]?.body as { folders: unknown[] } | undefined)?.folders).toHaveLength(1);
    expect(controller.view().folders[0]).toMatchObject({
      label: "Books",
      onMezonas: true,
      writable: true,
    });
    controller.stop();
  });
});

describe("the Desk", () => {
  it("tells the person about new items with a count, never their contents", async () => {
    fake.inbox = [{ id: "i1", title: "Pay Northside Lumber $412.50" }];
    await signIn();
    expect(notes).toEqual([]);
    fake.inbox.push({ id: "i2", title: "Add Acme as a vendor" }, { id: "i3", title: "x" });
    await controller.refreshDesk();
    expect(notes).toEqual(["2 new items wait on you."]);
    expect(controller.view().desk?.map((d) => d.id)).toEqual(["i1", "i2", "i3"]);
    controller.stop();
  });
});

describe("activity", () => {
  it("says what a job did in plain words, without the file's contents", () => {
    const folders = [
      { id: "f", path: "/x", label: "Books", access: "read_write" as const, ingest: false },
    ];
    expect(
      describeJob(
        {
          kind: "xlsx.append",
          folderId: "f",
          path: "Costs.xlsx",
          rows: [["secret", 1]],
          idempotencyKey: "k-123456",
        },
        { ok: true, output: { alreadyDone: false } },
        folders,
      ),
    ).toEqual(["write", "Added 1 row(s) to Costs.xlsx in Books"]);
    expect(
      describeJob(
        {
          kind: "xlsx.update",
          folderId: "f",
          path: "Costs.xlsx",
          range: "B2:B2",
          values: [[1]],
          expect: null,
          idempotencyKey: "k-123456",
        },
        { ok: false, error: { code: "file_open", message: "Costs.xlsx is open." } },
        folders,
      ),
    ).toEqual(["refused", "Didn't change Costs.xlsx in Books: Costs.xlsx is open."]);
  });
});
