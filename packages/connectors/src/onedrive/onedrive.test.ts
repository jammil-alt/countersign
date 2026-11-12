// The onedrive connector against a fake OneDrive (§1.97): sign-in asks for the app folder only and
// keeps its id; it offers Google Drive's tools with the same shapes, so both register together;
// `drive.file.upload` files a document by month, made-safe names and all, shows what is there as
// its before state and files once per key (a retry after a lost answer finds the first file, a
// refusal may try again); approval is on by default; `drive.file.list` pages within the folder; an
// AppFolder grant can't reach the person's other files; tokens refresh and rotate.
import { DEFAULT_PERMISSIONS, decideToolCall, type JsonObject } from "@countersign/core";
import { describe, expect, it } from "vitest";
import type { WriteAttemptServices, WriteAttemptState } from "../attempts";
import {
  type ConnectionRef,
  type DocumentServices,
  type StoredFile,
  UnconfirmedWriteError,
} from "../connector";
import { memoryCredentials } from "../credentials-accessor";
import { createGdriveConnector, DriveFileExistsError } from "../gdrive/index";
import { formDecode } from "../http";
import { captureBefore, executeWrite, runReadTool } from "../invoke";
import { noopLogger } from "../logger";
import { FAKE_MICROSOFT_APP } from "../microsoft/fake";
import { GRAPH_API, MICROSOFT_AUTH_URL, MICROSOFT_TOKEN_URL } from "../microsoft/identity";
import { ReconnectRequiredError, SignInRefusedError } from "../oauth/tokens";
import { connectionDefaults } from "../permissions";
import { ConnectorRegistry } from "../registry";
import { utf8 } from "../runtime";
import { fakeOnedrive } from "./fake";
import {
  createOnedriveConnector,
  numberedName,
  ONEDRIVE_CONNECTOR_ID,
  ONEDRIVE_GRAPH_SCOPE,
  ONEDRIVE_TOOLS,
  onedriveName,
  skipTokenOf,
} from "./index";

const REDIRECT = "https://staging.mezonas.com/connections/onedrive/callback";
const NOW = new Date("2026-11-06T15:00:00.000Z");
const TENANT = "0192f7a0-0000-7000-8000-0000000000aa";
const APPFOLDER = `https://graph.microsoft.com/${ONEDRIVE_GRAPH_SCOPE}`;

const INVOICE: StoredFile = {
  id: "0192f7a0-0000-7000-8000-00000000d0c1",
  bytes: utf8("%PDF-1.4 the October invoice"),
  filename: "Hardwood Supply INV: 1042.pdf",
  mimeType: "application/pdf",
  sha256: "x",
};
const documents: DocumentServices = {
  async read(id) {
    return id === INVOICE.id ? INVOICE : null;
  },
};

function memoryAttempts() {
  const started = new Map<string, { details: JsonObject; at: Date }>();
  const refused = new Set<string>();
  const done = new Map<string, JsonObject>();
  const s: WriteAttemptServices = {
    async stateFor(key): Promise<WriteAttemptState> {
      const mine = [...started.entries()].filter(([k]) => k.startsWith(`${key}#`));
      const last = mine.at(-1)?.[1];
      return {
        done: done.get(key) ?? null,
        started: mine.length,
        refused: [...refused].filter((k) => k.startsWith(`${key}#`)).length,
        last: last ? { details: last.details, startedAt: last.at } : null,
      };
    },
    async start({ idempotencyKey, attempt, details, at }) {
      const k = `${idempotencyKey}#${attempt}`;
      if (started.has(k)) return false;
      started.set(k, { details, at });
      return true;
    },
    async refused({ idempotencyKey, attempt }) {
      refused.add(`${idempotencyKey}#${attempt}`);
    },
    async done({ idempotencyKey, output }) {
      if (!done.has(idempotencyKey)) done.set(idempotencyKey, output);
    },
  };
  return { s, started, refused, done };
}

async function signIn(drive = fakeOnedrive(), code = drive.issueCode()) {
  const connector = createOnedriveConnector({ ...FAKE_MICROSOFT_APP, fetch: drive.fetch });
  const grant = await connector.handleCallback?.(
    { code, state: "s" },
    { tenantId: TENANT, userId: "u1", redirectUri: REDIRECT },
  );
  if (!grant) throw new Error("no grant");
  return { connector, grant, drive };
}

async function setup() {
  const { connector, grant, drive } = await signIn();
  const connection: ConnectionRef = {
    id: "0192f7a0-0000-7000-8000-000000000007",
    tenantId: TENANT,
    connector: ONEDRIVE_CONNECTOR_ID,
    status: "connected",
    externalAccountId: grant.externalAccountId,
    config: grant.config ?? {},
    permissions: {},
  };
  const credentials = memoryCredentials({
    ...grant.credentials,
    expiresAt: "2026-11-06T16:00:00Z",
  });
  const attempts = memoryAttempts();
  const ctx = {
    tenantId: TENANT,
    connection,
    credentials,
    logger: noopLogger,
    now: () => NOW,
    services: { documents, attempts: attempts.s },
    idempotencyKey: "0192f7a0-run:file-it:0",
  };
  return { connector, grant, drive, ctx, credentials, attempts };
}

const BY_MONTH = { documentId: INVOICE.id, path: "Bills/{yyyy}/{MM}", date: "2026-10-15" };
const puts = (drive: ReturnType<typeof fakeOnedrive>) =>
  drive.requests.filter((r) => r.method === "PUT");

describe("onedrive sign-in", () => {
  it("asks for the app folder only, with OpenID's scopes, and offers Drive's tools", async () => {
    const connector = createOnedriveConnector(FAKE_MICROSOFT_APP);
    expect(connector.isConfigured?.()).toBe(true);
    expect(createOnedriveConnector({}).isConfigured?.()).toBe(false);
    const { redirectUrl } = (await connector.authorize?.({
      tenantId: TENANT,
      userId: "u1",
      state: "the-state",
      redirectUri: REDIRECT,
    })) ?? { redirectUrl: "" };
    const [base, query = ""] = redirectUrl.split("?");
    expect(base).toBe(MICROSOFT_AUTH_URL);
    expect(formDecode(query)).toEqual({
      client_id: FAKE_MICROSOFT_APP.clientId,
      response_type: "code",
      redirect_uri: REDIRECT,
      response_mode: "query",
      scope: `openid email offline_access ${APPFOLDER}`,
      prompt: "select_account",
      state: "the-state",
    });
    expect(connector.manifest.sharedNamespaces).toEqual(["drive"]);
    expect(connector.manifest.tools.map((t) => [t.id, t.verb, t.sideEffect, t.entity])).toEqual([
      [ONEDRIVE_TOOLS.list, "read", "none", "file"],
      [ONEDRIVE_TOOLS.upload, "create", "external", "file"],
    ]);
  });

  it("keeps the app folder as the connection's folder, and the address from the ID token", async () => {
    const { grant, drive } = await signIn();
    expect(grant.externalAccountId).toBe("pat.lee@shop.example");
    expect(grant.config).toEqual({
      address: "pat.lee@shop.example",
      folderId: drive.appRoot(),
      folderName: "Mezonas",
      folderUrl: `https://onedrive.example/${drive.appRoot()}`,
      scopes: [ONEDRIVE_GRAPH_SCOPE],
    });
    expect(grant.credentials).toMatchObject({
      address: "pat.lee@shop.example",
      scope: expect.stringContaining(APPFOLDER),
    });
  });

  it("refuses a grant without the app folder or with more access; a code works once", async () => {
    const drive = fakeOnedrive();
    const connector = createOnedriveConnector({ ...FAKE_MICROSOFT_APP, fetch: drive.fetch });
    const call = (code: string) =>
      connector.handleCallback?.(
        { code, state: "s" },
        { tenantId: TENANT, userId: "u1", redirectUri: REDIRECT },
      );
    await expect(
      call(drive.issueCode({ scopes: ["openid", "email", "offline_access"] })),
    ).rejects.toThrow(/permission to file documents/);
    await expect(
      call(drive.issueCode({ scopes: [APPFOLDER, "Files.ReadWrite", "openid", "offline_access"] })),
    ).rejects.toThrow(/more access/);
    // `User.Read` and the short form are fine.
    await expect(
      call(
        drive.issueCode({
          scopes: ["files.readwrite.appfolder", "User.Read", "openid", "email", "offline_access"],
        }),
      ),
    ).resolves.toBeTruthy();
    const code = drive.issueCode();
    await call(code);
    await expect(call(code)).rejects.toThrow(/invalid_grant/);
    await expect(call(drive.issueCode({ claim: "none" }))).rejects.toBeInstanceOf(
      SignInRefusedError,
    );
  });

  it("registers beside Google Drive: one shared drive.file.upload, answered by the bound one", () => {
    const registry = new ConnectorRegistry([createGdriveConnector(), createOnedriveConnector()]);
    expect(registry.get(ONEDRIVE_CONNECTOR_ID)?.manifest.id).toBe("onedrive");
  });
});

describe("drive.file.upload on OneDrive", () => {
  it("is behind approval by default", async () => {
    const connector = createOnedriveConnector(FAKE_MICROSOFT_APP);
    const matrix = connectionDefaults(connector.manifest);
    expect(matrix).toMatchObject({ create: "approval", delete: "off" });
    expect(DEFAULT_PERMISSIONS.create).toBe("approval");
    expect(
      decideToolCall({ sideEffect: "external", verb: "create", matrix, agentMode: "act" }),
    ).toBe("approval");
  });

  it("shows the folder, the made-safe name and whether a file is there as its before state", async () => {
    const { connector, ctx, drive } = await setup();
    const { before } = await captureBefore(connector, ONEDRIVE_TOOLS.upload, BY_MONTH, ctx);
    expect(before).toEqual({
      folder: { id: drive.appRoot(), name: "Mezonas" },
      path: "Bills/2026/10",
      fileName: "Hardwood Supply INV- 1042.pdf",
      exists: false,
      existing: null,
      folderExists: false,
      document: {
        id: INVOICE.id,
        fileName: INVOICE.filename,
        mimeType: "application/pdf",
        size: INVOICE.bytes.length,
      },
    });
    // Reads only.
    expect(drive.at("Bills")).toBeUndefined();
  });

  it("files by month, making the folders, once per key", async () => {
    const { connector, ctx, drive } = await setup();
    const first = await executeWrite(connector, ONEDRIVE_TOOLS.upload, BY_MONTH, ctx);
    const file = drive.at("Bills/2026/10/Hardwood Supply INV- 1042.pdf");
    expect(drive.text("Bills/2026/10/Hardwood Supply INV- 1042.pdf")).toBe(
      "%PDF-1.4 the October invoice",
    );
    expect(file?.mimeType).toBe("application/pdf");
    expect(first.output).toEqual({
      fileId: file?.id,
      name: "Hardwood Supply INV- 1042.pdf",
      path: "Bills/2026/10",
      folderId: drive.at("Bills/2026/10")?.id,
      webViewLink: `https://onedrive.example/${file?.id}`,
      size: INVOICE.bytes.length,
      alreadyDone: false,
    });
    const again = await executeWrite(connector, ONEDRIVE_TOOLS.upload, BY_MONTH, ctx);
    expect(again.output).toEqual({ ...(first.output as object), alreadyDone: true });
    expect(puts(drive)).toHaveLength(1);
  });

  it("refuses a name that is there, or files it beside with keep_both", async () => {
    const { connector, ctx, drive } = await setup();
    await executeWrite(connector, ONEDRIVE_TOOLS.upload, BY_MONTH, ctx);
    await expect(
      executeWrite(connector, ONEDRIVE_TOOLS.upload, BY_MONTH, { ...ctx, idempotencyKey: "k2" }),
    ).rejects.toBeInstanceOf(DriveFileExistsError);
    const both = await executeWrite(
      connector,
      ONEDRIVE_TOOLS.upload,
      { ...BY_MONTH, ifExists: "keep_both", fileName: "Hardwood Supply INV: 1042.pdf" },
      { ...ctx, idempotencyKey: "k3" },
    );
    expect((both.output as { name: string }).name).toBe("Hardwood Supply INV- 1042 (2).pdf");
    expect(drive.at("Bills/2026/10/Hardwood Supply INV- 1042 (2).pdf")).toBeDefined();
  });

  it("after a lost answer, finds the file it filed instead of filing it twice", async () => {
    const { connector, ctx, drive, attempts } = await setup();
    drive.loseNextUploadAnswer();
    await expect(executeWrite(connector, ONEDRIVE_TOOLS.upload, BY_MONTH, ctx)).rejects.toThrow(
      /closed before OneDrive answered/,
    );
    const retry = await executeWrite(connector, ONEDRIVE_TOOLS.upload, BY_MONTH, ctx);
    expect(retry.output).toMatchObject({
      name: "Hardwood Supply INV- 1042.pdf",
      alreadyDone: true,
    });
    expect(puts(drive)).toHaveLength(1);
    expect(attempts.done.size).toBe(1);
  });

  it("tries again after OneDrive refused or failed, since nothing was stored", async () => {
    const { connector, ctx, drive, attempts } = await setup();
    drive.failUploads(1, 400);
    await expect(executeWrite(connector, ONEDRIVE_TOOLS.upload, BY_MONTH, ctx)).rejects.toThrow(
      /refused/,
    );
    expect(attempts.refused.size).toBe(1);
    drive.failUploads(1, 503);
    await expect(executeWrite(connector, ONEDRIVE_TOOLS.upload, BY_MONTH, ctx)).rejects.toThrow(
      /503/,
    );
    // A 503 left the attempt open: the retry checks the name, finds nothing, and files it.
    const third = await executeWrite(connector, ONEDRIVE_TOOLS.upload, BY_MONTH, ctx);
    expect(third.output).toMatchObject({ alreadyDone: false });
    expect(puts(drive)).toHaveLength(3);
    expect(drive.at("Bills/2026/10")?.id).toBeDefined();
  });

  it("asks a person to check when a file of the recorded name is there but not the same size", async () => {
    const { connector, ctx, drive, attempts } = await setup();
    drive.failUploads(1, 503);
    await expect(executeWrite(connector, ONEDRIVE_TOOLS.upload, BY_MONTH, ctx)).rejects.toThrow();
    const recorded = [...attempts.started.values()][0]?.details;
    const folder = drive.items.get(String(recorded?.folderId));
    drive.items.set("OTHER", {
      id: "OTHER",
      name: String(recorded?.name),
      parentId: folder?.id ?? null,
      folder: false,
      bytes: utf8("someone else's"),
      created: NOW.toISOString(),
      modified: NOW.toISOString(),
    });
    await expect(
      executeWrite(connector, ONEDRIVE_TOOLS.upload, BY_MONTH, ctx),
    ).rejects.toBeInstanceOf(UnconfirmedWriteError);
  });
});

describe("drive.file.list on OneDrive", () => {
  it("lists a folder by path, a page at a time, and an empty answer for a missing one", async () => {
    const { connector, ctx } = await setup();
    for (const [i, name] of ["a.pdf", "b.pdf", "c.pdf"].entries()) {
      await executeWrite(
        connector,
        ONEDRIVE_TOOLS.upload,
        { ...BY_MONTH, fileName: name },
        { ...ctx, idempotencyKey: `list-${i}` },
      );
    }
    const first = await runReadTool(
      connector,
      ONEDRIVE_TOOLS.list,
      { path: "Bills/{yyyy}/{MM}", date: "2026-10-01", limit: 2 },
      ctx,
    );
    const page1 = first.output as { files: { name: string }[]; nextPageToken: string | null };
    expect(page1.files.map((f) => f.name)).toEqual(["a.pdf", "b.pdf"]);
    expect(page1.nextPageToken).toBe("2");
    const second = await runReadTool(
      connector,
      ONEDRIVE_TOOLS.list,
      { path: "Bills/{yyyy}/{MM}", date: "2026-10-01", limit: 2, pageToken: page1.nextPageToken },
      ctx,
    );
    expect((second.output as { files: { name: string }[] }).files.map((f) => f.name)).toEqual([
      "c.pdf",
    ]);
    const top = await runReadTool(connector, ONEDRIVE_TOOLS.list, {}, ctx);
    expect((top.output as { files: { name: string; folder: boolean }[] }).files).toEqual([
      expect.objectContaining({ name: "Bills", folder: true }),
    ]);
    const none = await runReadTool(connector, ONEDRIVE_TOOLS.list, { path: "Receipts" }, ctx);
    expect(none.output).toEqual({
      path: "Receipts",
      folderId: null,
      files: [],
      nextPageToken: null,
    });
  });

  it("an app-folder grant can't reach the person's other files", async () => {
    const { drive, grant } = await setup();
    const outside = drive.addOutside("payroll.xlsx");
    const res = await drive.fetch(`${GRAPH_API}/me/drive/items/${outside.id}`, {
      headers: { authorization: `Bearer ${String(grant.credentials.accessToken)}` },
    });
    expect(res.status).toBe(403);
  });
});

describe("onedrive tokens", () => {
  it("refreshes an expired token with the same scopes, keeps the rotated one, and asks for a reconnect when the grant is gone", async () => {
    const { connector, ctx, drive, credentials } = await setup();
    drive.identity.expireAccessTokens();
    await runReadTool(connector, ONEDRIVE_TOOLS.list, {}, ctx);
    const refresh = drive.requests.filter((r) => r.url === MICROSOFT_TOKEN_URL);
    expect(refresh.length).toBeGreaterThanOrEqual(2);
    const stored = await credentials.get();
    expect(stored?.refreshToken).toBe(drive.identity.issued().refreshTokens.at(-1));
    drive.identity.expireAccessTokens();
    drive.identity.expireRefreshTokens();
    await expect(runReadTool(connector, ONEDRIVE_TOOLS.list, {}, ctx)).rejects.toBeInstanceOf(
      ReconnectRequiredError,
    );
  });
});

describe("onedrive names", () => {
  it("makes names safe for OneDrive and numbers them for keep_both", () => {
    expect(onedriveName('a"b*c:d<e>f?g/h\\i|j')).toBe("a-b-c-d-e-f-g-h-i-j");
    expect(onedriveName("  report.  ")).toBe("report");
    expect(onedriveName("...")).toBe("document");
    expect(numberedName("x.pdf", 1)).toBe("x.pdf");
    expect(numberedName("x.pdf", 3)).toBe("x (3).pdf");
    expect(numberedName("notes", 2)).toBe("notes (2)");
    expect(skipTokenOf(`${GRAPH_API}/me/drive/items/A/children?$top=2&$skiptoken=abc`)).toBe("abc");
    expect(skipTokenOf(undefined)).toBeNull();
  });
});
