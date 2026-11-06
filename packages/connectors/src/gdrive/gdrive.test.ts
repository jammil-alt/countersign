// The gdrive connector against a fake Google Drive (M29): sign-in asks for `drive.file` only and
// makes the connection's folder (found again on a reconnect); `drive.file.upload` files a document
// by month, shows whether a file of that name is there as its before state, makes missing folders,
// and files once per key (a retry after a lost answer finds the first file); approval is on by
// default; `drive.file.list` sees only our files; tokens refresh, and disconnect revokes.
import { DEFAULT_PERMISSIONS, decideToolCall } from "@countersign/core";
import { describe, expect, it } from "vitest";
import type { ConnectionRef, DocumentServices, StoredFile } from "../connector";
import { CredentialCipher, generateEncryptionKey, memoryTenantKeys } from "../credentials";
import { memoryCredentials } from "../credentials-accessor";
import { formDecode, parseUrl } from "../http";
import { captureBefore, executeWrite, runReadTool, ToolCallError } from "../invoke";
import { noopLogger } from "../logger";
import { beginAuthorization, completeAuthorization } from "../oauth/flow";
import { ReconnectRequiredError, SignInRefusedError } from "../oauth/tokens";
import { connectionDefaults } from "../permissions";
import { utf8 } from "../runtime";
import { FAKE_GOOGLE_DRIVE, fakeDriveText, fakeGoogleDrive } from "./fake";
import {
  createGdriveConnector,
  DRIVE_FILE_SCOPE,
  DriveFileExistsError,
  DriveFolderMissingError,
  driveFolderName,
  GDRIVE_TOOLS,
  GOOGLE_DRIVE_AUTH_URL,
  GOOGLE_DRIVE_REVOKE_URL,
} from "./index";
import {
  driveFileName,
  driveQueryLiteral,
  pathSegments,
  resolvePathTemplate,
  templateProblems,
} from "./path";

const REDIRECT = "https://staging.mezonas.com/connections/gdrive/callback";
const NOW = new Date("2026-11-06T15:00:00.000Z");
const TENANT = "0192f7a0-0000-7000-8000-0000000000aa";

const INVOICE: StoredFile = {
  id: "0192f7a0-0000-7000-8000-00000000d0c1",
  bytes: utf8("%PDF-1.4 the October invoice"),
  filename: "Hardwood Supply INV-1042.pdf",
  mimeType: "application/pdf",
  sha256: "x",
};
const RECEIPT: StoredFile = {
  id: "0192f7a0-0000-7000-8000-00000000d0c2",
  bytes: utf8("%PDF-1.4 a receipt"),
  filename: "receipt.pdf",
  mimeType: "application/pdf",
  sha256: "y",
};
const documents: DocumentServices = {
  async read(id) {
    return [INVOICE, RECEIPT].find((d) => d.id === id) ?? null;
  },
};

async function signIn(drive = fakeGoogleDrive(), params: Record<string, string> = {}) {
  const connector = createGdriveConnector({ ...FAKE_GOOGLE_DRIVE, fetch: drive.fetch });
  const grant = await connector.handleCallback?.(
    { code: drive.issueCode(), state: "s", ...params },
    { tenantId: TENANT, userId: "u1", redirectUri: REDIRECT },
  );
  if (!grant) throw new Error("no grant");
  return { connector, grant, drive };
}

async function setup(params: Record<string, string> = { folder_name: "Acme Millwork" }) {
  const { connector, grant, drive } = await signIn(fakeGoogleDrive(), params);
  const connection: ConnectionRef = {
    id: "0192f7a0-0000-7000-8000-000000000003",
    tenantId: TENANT,
    connector: "gdrive",
    status: "connected",
    externalAccountId: grant.externalAccountId,
    config: grant.config ?? {},
    permissions: {},
  };
  // Sign-in stamps the expiry from the real clock; the tests run at NOW.
  const credentials = memoryCredentials({
    ...grant.credentials,
    expiresAt: "2026-11-06T16:00:00Z",
  });
  const ctx = {
    tenantId: TENANT,
    connection,
    credentials,
    logger: noopLogger,
    now: () => NOW,
    services: { documents },
    idempotencyKey: "0192f7a0-run:file-it:0",
  };
  return { connector, grant, drive, ctx, credentials };
}

const BY_MONTH = {
  documentId: INVOICE.id,
  path: "Bills/{yyyy}/{MM}",
  date: "2026-10-15",
};

describe("google drive sign-in", () => {
  it("asks for drive.file only, with offline access and consent every time", async () => {
    const connector = createGdriveConnector(FAKE_GOOGLE_DRIVE);
    expect(connector.isConfigured?.()).toBe(true);
    expect(createGdriveConnector({}).isConfigured?.()).toBe(false);
    const { redirectUrl } = (await connector.authorize?.({
      tenantId: TENANT,
      userId: "u1",
      state: "the-state",
      redirectUri: REDIRECT,
    })) ?? { redirectUrl: "" };
    const [base, query = ""] = redirectUrl.split("?");
    expect(base).toBe(GOOGLE_DRIVE_AUTH_URL);
    expect(formDecode(query)).toEqual({
      client_id: FAKE_GOOGLE_DRIVE.clientId,
      redirect_uri: REDIRECT,
      response_type: "code",
      scope: DRIVE_FILE_SCOPE,
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "false",
      state: "the-state",
    });
    expect(connector.manifest.tools.map((t) => [t.id, t.verb, t.sideEffect, t.entity])).toEqual([
      [GDRIVE_TOOLS.list, "read", "none", "file"],
      [GDRIVE_TOOLS.upload, "create", "external", "file"],
    ]);
    expect(connector.manifest.permissionEntities).toEqual([
      { id: "file", label: "Files", verbs: ["read", "create"] },
    ]);
  });

  it("makes the connection's folder at sign-in and keeps its id in config", async () => {
    const { grant, drive } = await signIn(fakeGoogleDrive(), { folder_name: "Acme Millwork" });
    const folder = [...drive.files.values()].find((f) => f.name === "Mezonas - Acme Millwork");
    expect(folder?.parents).toEqual(["root"]);
    expect(grant.externalAccountId).toBe("pat.lee@gmail.test");
    expect(grant.config).toEqual({
      address: "pat.lee@gmail.test",
      folderId: folder?.id,
      folderName: "Mezonas - Acme Millwork",
      folderUrl: `https://drive.google.com/drive/folders/${folder?.id}`,
      scopes: ["drive.file"],
    });
    expect(grant.credentials).toMatchObject({
      address: "pat.lee@gmail.test",
      accessToken: drive.issued().accessTokens[0],
      refreshToken: drive.issued().refreshTokens[0],
      scope: DRIVE_FILE_SCOPE,
    });
  });

  it("finds its folder again on a reconnect, and names it Mezonas without a chosen name", async () => {
    const drive = fakeGoogleDrive();
    const first = await signIn(drive, { folder_name: "Acme Millwork" });
    const again = await signIn(drive, { folder_name: "Acme Millwork" });
    expect(again.grant.config?.folderId).toBe(first.grant.config?.folderId);
    const plain = await signIn(drive);
    expect(plain.grant.config?.folderName).toBe("Mezonas");
    expect([...drive.files.values()].filter((f) => f.parents[0] === "root")).toHaveLength(2);
    expect(driveFolderName(" Acme/Bills\r\nX ")).toBe("Mezonas - Acme Bills  X");
    expect(driveFolderName("   ")).toBe("Mezonas");
  });

  it("refuses a grant without drive.file or with more than we ask for; a code works once", async () => {
    const drive = fakeGoogleDrive();
    const connector = createGdriveConnector({ ...FAKE_GOOGLE_DRIVE, fetch: drive.fetch });
    const call = (code: string) =>
      connector.handleCallback?.(
        { code, state: "s" },
        { tenantId: TENANT, userId: "u1", redirectUri: REDIRECT },
      );
    await expect(call(drive.issueCode({ scopes: [] }))).rejects.toBeInstanceOf(SignInRefusedError);
    await expect(
      call(
        drive.issueCode({
          scopes: [DRIVE_FILE_SCOPE, "https://www.googleapis.com/auth/drive.readonly"],
        }),
      ),
    ).rejects.toThrow(/more access/);
    // Nothing was made for a refused grant.
    expect(drive.files.size).toBe(0);
    const code = drive.issueCode();
    await call(code);
    await expect(call(code)).rejects.toThrow(/invalid_grant/);
  });

  it("goes through the platform's OAuth flow: signed state, encrypted credentials", async () => {
    const drive = fakeGoogleDrive();
    const connector = createGdriveConnector({ ...FAKE_GOOGLE_DRIVE, fetch: drive.fetch });
    const secret = "a-test-secret-that-is-at-least-32-bytes-long";
    const session = { tenantId: TENANT, userId: "u1" };
    const cipher = (await CredentialCipher.create({ current: generateEncryptionKey() })).forClients(
      memoryTenantKeys(),
    );
    const begun = await beginAuthorization({
      connector,
      ...session,
      redirectUri: REDIRECT,
      stateSecret: secret,
    });
    const connectionId = "0192f7a0-0000-7000-8000-0000000000cc";
    const done = await completeAuthorization({
      connector,
      params: { code: drive.issueCode(), state: begun.state, folder_name: "Acme" },
      session,
      connectionId,
      redirectUri: REDIRECT,
      stateSecret: secret,
      cipher,
    });
    expect(done.grant.config).toMatchObject({ folderName: "Mezonas - Acme" });
    const token = drive.issued().refreshTokens[0] as string;
    expect(JSON.stringify(done.credentials)).not.toContain(token);
    expect(JSON.stringify(done.grant)).not.toContain(token);
    expect(
      await cipher.decrypt(done.credentials, { tenantId: TENANT, connectionId }),
    ).toMatchObject({ refreshToken: token });
  });

  it("revokes the refresh token at Google on disconnect", async () => {
    const { connector, ctx, grant, drive } = await setup();
    await connector.revoke?.(ctx);
    const call = drive.requests.find((r) => r.url === GOOGLE_DRIVE_REVOKE_URL);
    expect(call?.body).toBe(`token=${encodeURIComponent(String(grant.credentials.refreshToken))}`);
    await expect(connector.revoke?.(ctx)).resolves.toBeUndefined();
  });
});

describe("drive.file.upload", () => {
  it("is behind approval by default (M29)", async () => {
    const { connector } = await setup();
    const matrix = connectionDefaults(connector.manifest);
    expect(matrix).toMatchObject({ read: "auto", create: "approval", delete: "off" });
    expect(connector.manifest.defaultPermissions).toBeUndefined();
    expect(DEFAULT_PERMISSIONS.create).toBe("approval");
    expect(
      decideToolCall({ sideEffect: "external", verb: "create", matrix, agentMode: "act" }),
    ).toBe("approval");
  });

  it("shows whether the file is there as its before state, and writes nothing then", async () => {
    const { connector, drive, ctx } = await setup();
    const count = drive.files.size;
    const sent = drive.requests.length;
    const { before } = await captureBefore(connector, GDRIVE_TOOLS.upload, BY_MONTH, ctx);
    expect(before).toEqual({
      folder: { id: ctx.connection.config.folderId, name: "Mezonas - Acme Millwork" },
      path: "Bills/2026/10",
      fileName: "Hardwood Supply INV-1042.pdf",
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
    expect(drive.files.size).toBe(count);
    expect(drive.requests.slice(sent).filter((r) => r.method !== "GET")).toEqual([]);
  });

  it("files a document by month, making the folders, once per key", async () => {
    const { connector, drive, ctx } = await setup();
    const first = await executeWrite(connector, GDRIVE_TOOLS.upload, BY_MONTH, ctx);
    expect(first.summary).toBe("Filed Hardwood Supply INV-1042.pdf in Google Drive");
    expect(first.output).toMatchObject({
      name: "Hardwood Supply INV-1042.pdf",
      path: "Bills/2026/10",
      size: INVOICE.bytes.length,
      alreadyDone: false,
    });
    const uploaded = drive.uploaded();
    expect(uploaded.map((f) => f.path)).toEqual([
      "Mezonas - Acme Millwork/Bills/2026/10/Hardwood Supply INV-1042.pdf",
    ]);
    expect(fakeDriveText(uploaded[0] as never)).toBe("%PDF-1.4 the October invoice");
    expect(uploaded[0]?.mimeType).toBe("application/pdf");

    // A retried step (same key): the first file comes back; nothing is uploaded again.
    const again = await executeWrite(connector, GDRIVE_TOOLS.upload, BY_MONTH, ctx);
    expect(again.output).toMatchObject({ fileId: uploaded[0]?.id, alreadyDone: true });
    expect(drive.uploaded()).toHaveLength(1);

    // Another document the same month reuses the folders; another month makes its own.
    await executeWrite(
      connector,
      GDRIVE_TOOLS.upload,
      { ...BY_MONTH, documentId: RECEIPT.id },
      { ...ctx, idempotencyKey: "0192f7a0-run:file-it:1" },
    );
    await executeWrite(
      connector,
      GDRIVE_TOOLS.upload,
      { ...BY_MONTH, documentId: RECEIPT.id, date: "2026-11-02" },
      { ...ctx, idempotencyKey: "0192f7a0-run:file-it:2" },
    );
    expect(
      drive
        .uploaded()
        .map((f) => f.path)
        .sort(),
    ).toEqual([
      "Mezonas - Acme Millwork/Bills/2026/10/Hardwood Supply INV-1042.pdf",
      "Mezonas - Acme Millwork/Bills/2026/10/receipt.pdf",
      "Mezonas - Acme Millwork/Bills/2026/11/receipt.pdf",
    ]);
    const folders = [...drive.files.values()].filter((f) => f.name === "Bills");
    expect(folders).toHaveLength(1);

    // Without a date, today's month (UTC).
    const today = await executeWrite(
      connector,
      GDRIVE_TOOLS.upload,
      { documentId: INVOICE.id, path: "Bills/{yyyy}/{MM}" },
      { ...ctx, idempotencyKey: "0192f7a0-run:file-it:3" },
    );
    expect(today.output).toMatchObject({ path: "Bills/2026/11" });
  });

  it("finds its own upload after a lost answer instead of filing it twice", async () => {
    const { connector, drive, ctx } = await setup();
    drive.loseNextUploadAnswer();
    await expect(executeWrite(connector, GDRIVE_TOOLS.upload, BY_MONTH, ctx)).rejects.toThrow(
      /\(503\)/,
    );
    expect(drive.uploaded()).toHaveLength(1);
    const retry = await executeWrite(connector, GDRIVE_TOOLS.upload, BY_MONTH, ctx);
    expect(retry.output).toMatchObject({ alreadyDone: true, fileId: drive.uploaded()[0]?.id });
    expect(drive.uploaded()).toHaveLength(1);
  });

  it("refuses a name already in the folder unless told to keep both", async () => {
    const { connector, drive, ctx } = await setup();
    await executeWrite(connector, GDRIVE_TOOLS.upload, BY_MONTH, ctx);
    const next = { ...ctx, idempotencyKey: "0192f7a0-run2:file-it:0" };
    const { before } = await captureBefore(connector, GDRIVE_TOOLS.upload, BY_MONTH, next);
    expect(before).toMatchObject({
      exists: true,
      folderExists: true,
      existing: { id: drive.uploaded()[0]?.id, name: "Hardwood Supply INV-1042.pdf" },
    });
    await expect(
      executeWrite(connector, GDRIVE_TOOLS.upload, BY_MONTH, next),
    ).rejects.toBeInstanceOf(DriveFileExistsError);
    expect(drive.uploaded()).toHaveLength(1);
    await executeWrite(
      connector,
      GDRIVE_TOOLS.upload,
      { ...BY_MONTH, ifExists: "keep_both" },
      next,
    );
    expect(drive.uploaded()).toHaveLength(2);
    // A different name is fine.
    await executeWrite(
      connector,
      GDRIVE_TOOLS.upload,
      { ...BY_MONTH, fileName: "INV-1042 copy.pdf" },
      { ...ctx, idempotencyKey: "0192f7a0-run3:file-it:0" },
    );
    expect(drive.uploaded()).toHaveLength(3);
  });

  it("refuses bad paths and documents of another client before calling Drive", async () => {
    const { connector, drive, ctx } = await setup();
    const before = drive.requests.length;
    for (const path of ["Bills/../..", "Bills/{hh}", "Bills/{yyyy", "a/b/c/d/e/f/g/h/i"]) {
      await expect(
        executeWrite(connector, GDRIVE_TOOLS.upload, { ...BY_MONTH, path }, ctx),
      ).rejects.toBeInstanceOf(ToolCallError);
    }
    await expect(
      executeWrite(connector, GDRIVE_TOOLS.upload, { ...BY_MONTH, fileName: "a/b.pdf" }, ctx),
    ).rejects.toBeInstanceOf(ToolCallError);
    expect(drive.requests.length).toBe(before);
    await expect(
      executeWrite(
        connector,
        GDRIVE_TOOLS.upload,
        { ...BY_MONTH, documentId: "0192f7a0-0000-7000-8000-00000000dead" },
        ctx,
      ),
    ).rejects.toThrow(/not this client's/);
    expect(drive.uploaded()).toHaveLength(0);
  });

  it("sends the file only to Google's upload host", async () => {
    const { connector, drive, ctx } = await setup();
    drive.nextUploadLocation("https://evil.example/upload?upload_id=x");
    await expect(executeWrite(connector, GDRIVE_TOOLS.upload, BY_MONTH, ctx)).rejects.toThrow(
      /no usable upload address/,
    );
    expect(drive.requests.some((r) => parseUrl(r.url)?.origin === "https://evil.example")).toBe(
      false,
    );
  });

  it("stops when the connection's folder is gone", async () => {
    const { connector, drive, ctx } = await setup();
    const folder = drive.files.get(String(ctx.connection.config.folderId));
    if (folder) folder.trashed = true;
    await expect(
      executeWrite(connector, GDRIVE_TOOLS.upload, BY_MONTH, ctx),
    ).rejects.toBeInstanceOf(DriveFolderMissingError);
  });

  it("refreshes before expiry and after a 401; an expired grant asks for a reconnect", async () => {
    const { connector, drive, ctx, credentials } = await setup();
    await credentials.set({
      ...(credentials.current() ?? {}),
      expiresAt: "2026-11-06T14:00:00.000Z",
    });
    await executeWrite(connector, GDRIVE_TOOLS.upload, BY_MONTH, ctx);
    expect(credentials.current()).toMatchObject({ accessToken: drive.issued().accessTokens[1] });
    drive.expireAccessTokens();
    await executeWrite(
      connector,
      GDRIVE_TOOLS.upload,
      { ...BY_MONTH, documentId: RECEIPT.id },
      { ...ctx, idempotencyKey: "k2" },
    );
    expect(drive.uploaded()).toHaveLength(2);
    drive.expireAccessTokens();
    drive.expireRefreshTokens();
    await expect(
      executeWrite(connector, GDRIVE_TOOLS.upload, BY_MONTH, { ...ctx, idempotencyKey: "k3" }),
    ).rejects.toBeInstanceOf(ReconnectRequiredError);
  });
});

describe("drive.file.list", () => {
  it("lists only our files in the folder, and nothing for a folder not made yet", async () => {
    const { connector, drive, ctx } = await setup();
    const empty = await runReadTool(connector, GDRIVE_TOOLS.list, BY_MONTH, ctx);
    expect(empty.output).toEqual({
      path: "Bills/2026/10",
      folderId: null,
      files: [],
      nextPageToken: null,
    });
    await executeWrite(connector, GDRIVE_TOOLS.upload, BY_MONTH, ctx);
    const month = drive.uploaded()[0]?.parents[0] as string;
    drive.seedForeignFile("someone else's.pdf", month);
    const listed = await runReadTool(connector, GDRIVE_TOOLS.list, BY_MONTH, ctx);
    expect(listed.output).toMatchObject({
      path: "Bills/2026/10",
      folderId: month,
      files: [
        {
          name: "Hardwood Supply INV-1042.pdf",
          folder: false,
          mimeType: "application/pdf",
          size: INVOICE.bytes.length,
        },
      ],
    });
    const top = await runReadTool(connector, GDRIVE_TOOLS.list, {}, ctx);
    expect((top.output as { files: { name: string; folder: boolean }[] }).files).toEqual([
      expect.objectContaining({ name: "Bills", folder: true }),
    ]);
  });
});

describe("path templates", () => {
  const date = { year: 2026, month: 3, day: 7 };
  it("fills the date tokens and splits into folders", () => {
    expect(resolvePathTemplate("Bills/{yyyy}/{MM}", date)).toEqual({
      ok: true,
      segments: ["Bills", "2026", "03"],
    });
    expect(resolvePathTemplate("/ {yy}-{MM}-{dd} receipts /", date)).toEqual({
      ok: true,
      segments: ["26-03-07 receipts"],
    });
    expect(resolvePathTemplate("", date)).toEqual({ ok: true, segments: [] });
    expect(pathSegments("a//b/ /c")).toEqual(["a", "b", "c"]);
  });

  it("refuses unknown tokens, open braces, dot folders, control characters and deep paths", () => {
    expect(templateProblems("{hh}")).toEqual(["{hh} is not one of {yyyy}, {yy}, {MM}, {dd}"]);
    // The workflow's own `{{…}}` is not a date token.
    expect(templateProblems("{{yyyy}}")[0]).toMatch(/\{\{yyyy\} is not one of/);
    expect(templateProblems("{yyyy")).toEqual(["a { has no closing }"]);
    expect(templateProblems("yyyy}")).toEqual(["a } has no opening {"]);
    expect(templateProblems("a/../b")[0]).toMatch(/can't be a folder name/);
    expect(templateProblems("a\u0000b")[0]).toMatch(/control/);
    expect(templateProblems("a/b/c/d/e/f/g/h/i")[0]).toMatch(/more than 8/);
    expect(templateProblems("x".repeat(101))[0]).toMatch(/longer than 100/);
    expect(templateProblems("{".repeat(301))).toEqual(["the path is longer than 300 characters"]);
  });

  it("makes stored file names safe and escapes query literals", () => {
    expect(driveFileName("a/b\\c\r\n.pdf")).toBe("a_b_c__.pdf");
    expect(driveFileName("  ")).toBe("document");
    const long = driveFileName(`${"x".repeat(300)}.pdf`);
    expect(long).toHaveLength(200);
    expect(long.endsWith(".pdf")).toBe(true);
    expect(driveQueryLiteral("O'Brien \\ Co")).toBe("'O\\'Brien \\\\ Co'");
  });
});
