// The gsheets connector against a fake Google Sheets (W4-D): sign-in asks for `drive.file` only and
// refuses anything broader, keeping nothing; tokens go to the vault encrypted; a sheet the client
// didn't pick is refused before Google is called; `sheets.rows.append` adds rows once per key, also
// after a lost answer; `sheets.range.update` is refused when the cells changed since the proposal;
// nothing we write runs as a formula; approval is on by default; disconnect never revokes.
import { DEFAULT_PERMISSIONS, decideToolCall } from "@countersign/core";
import { describe, expect, it } from "vitest";
import type { ConnectionRef } from "../connector";
import { CredentialCipher, generateEncryptionKey, memoryTenantKeys } from "../credentials";
import { memoryCredentials } from "../credentials-accessor";
import { GOOGLE_DRIVE_REVOKE_URL } from "../gdrive/index";
import { formDecode, parseUrl } from "../http";
import { captureBefore, executeWrite, runReadTool, ToolCallError } from "../invoke";
import { noopLogger } from "../logger";
import { beginAuthorization, completeAuthorization } from "../oauth/flow";
import { ReconnectRequiredError, SignInRefusedError } from "../oauth/tokens";
import { connectionDefaults } from "../permissions";
import {
  columnLetters,
  columnNumber,
  holdsWritten,
  isNumericText,
  parseA1,
  qualifiedRange,
  splitQualifiedRange,
  writtenCell,
} from "./a1";
import { FAKE_GOOGLE_SHEETS, fakeGoogleSheets } from "./fake";
import {
  createGsheetsConnector,
  GSHEETS_TOOLS,
  isGsheetsConnector,
  type PickedSheet,
  SheetChangedError,
  SheetNotAvailableError,
  SheetNotPickedError,
  sheetsActionTag,
  withPickedSheets,
} from "./index";

const DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";
const REDIRECT = "https://staging.mezonas.com/connections/gsheets/callback";
const NOW = new Date("2026-11-06T15:00:00.000Z");
const TENANT = "0192f7a0-0000-7000-8000-0000000000aa";
const PAT = "pat.lee@gmail.test";

const BUDGET: (string | number | null)[][] = [
  ["Date", "Vendor", "Amount"],
  ["2026-10-01", "Hardwood Supply", 412.5],
  ["2026-10-03", "Edge Banding Co", 88],
];

async function signIn(sheets = fakeGoogleSheets(), opts: { address?: string } = {}) {
  const connector = createGsheetsConnector({ ...FAKE_GOOGLE_SHEETS, fetch: sheets.fetch });
  const grant = await connector.handleCallback?.(
    { code: sheets.issueCode(opts), state: "s" },
    { tenantId: TENANT, userId: "u1", redirectUri: REDIRECT },
  );
  if (!grant) throw new Error("no grant");
  return { connector, grant, sheets };
}

async function setup() {
  const { connector, grant, sheets } = await signIn();
  const budget = sheets.seed("Shop budget", { Costs: BUDGET, Notes: [["hello"]] });
  const other = sheets.seed("Payroll", { Sheet1: [["Name", "Pay"]] });
  sheets.pick(budget.id);
  sheets.pick(other.id, "someone.else@gmail.test");
  const picked: PickedSheet = {
    id: budget.id,
    name: "Shop budget",
    url: null,
    account: PAT,
    addedAt: NOW.toISOString(),
  };
  const connection: ConnectionRef = {
    id: "0192f7a0-0000-7000-8000-000000000003",
    tenantId: TENANT,
    connector: "gsheets",
    status: "connected",
    externalAccountId: grant.externalAccountId,
    config: withPickedSheets(grant.config ?? {}, [picked]),
    permissions: {},
  };
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
    idempotencyKey: "0192f7a0-run:log-cost:0",
  };
  return { connector, sheets, ctx, budget, other };
}

const ROW = ["2026-10-07", "Hardwood Supply", 129.95];

describe("google sheets sign-in", () => {
  it("asks for drive.file only, with offline access and consent every time", async () => {
    const connector = createGsheetsConnector(FAKE_GOOGLE_SHEETS);
    expect(connector.isConfigured?.()).toBe(true);
    expect(createGsheetsConnector({}).isConfigured?.()).toBe(false);
    expect(isGsheetsConnector(connector)).toBe(true);
    const { redirectUrl } = (await connector.authorize?.({
      tenantId: TENANT,
      userId: "u1",
      state: "the-state",
      redirectUri: REDIRECT,
    })) ?? { redirectUrl: "" };
    const [, query = ""] = redirectUrl.split("?");
    expect(formDecode(query)).toEqual({
      client_id: FAKE_GOOGLE_SHEETS.clientId,
      redirect_uri: REDIRECT,
      response_type: "code",
      scope: DRIVE_FILE,
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "false",
      state: "the-state",
    });
    expect(connector.manifest.tools.map((t) => [t.id, t.verb, t.sideEffect, t.entity])).toEqual([
      [GSHEETS_TOOLS.read, "read", "none", "row"],
      [GSHEETS_TOOLS.append, "create", "external", "row"],
      [GSHEETS_TOOLS.update, "update", "external", "row"],
    ]);
  });

  it("keeps the account, and no sheets: a reconnect keeps the picked list", async () => {
    const { grant, sheets } = await signIn();
    expect(grant.externalAccountId).toBe(PAT);
    expect(grant.config).toEqual({ address: PAT, scopes: ["drive.file"] });
    expect(grant.credentials).toMatchObject({
      address: PAT,
      accessToken: sheets.issued().accessTokens[0],
      refreshToken: sheets.issued().refreshTokens[0],
      scope: DRIVE_FILE,
    });
  });

  it("refuses a grant without drive.file or with any broader scope, keeping nothing", async () => {
    const sheets = fakeGoogleSheets();
    const connector = createGsheetsConnector({ ...FAKE_GOOGLE_SHEETS, fetch: sheets.fetch });
    const call = (code: string) =>
      connector.handleCallback?.(
        { code, state: "s" },
        { tenantId: TENANT, userId: "u1", redirectUri: REDIRECT },
      );
    await expect(call(sheets.issueCode({ scopes: [] }))).rejects.toBeInstanceOf(SignInRefusedError);
    for (const broader of [
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/drive.readonly",
    ]) {
      await expect(call(sheets.issueCode({ scopes: [DRIVE_FILE, broader] }))).rejects.toThrow(
        /more access/,
      );
    }
    // Refused before anything else was asked of Google (no account lookup).
    expect(
      sheets.requests.filter((r) => parseUrl(r.url)?.origin !== "https://oauth2.googleapis.com"),
    ).toEqual([]);
  });

  it("goes through the platform's OAuth flow: tokens kept only encrypted in the vault", async () => {
    const sheets = fakeGoogleSheets();
    const connector = createGsheetsConnector({ ...FAKE_GOOGLE_SHEETS, fetch: sheets.fetch });
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
      params: { code: sheets.issueCode(), state: begun.state },
      session,
      connectionId,
      redirectUri: REDIRECT,
      stateSecret: secret,
      cipher,
    });
    const refresh = sheets.issued().refreshTokens[0] as string;
    const access = sheets.issued().accessTokens[0] as string;
    for (const t of [refresh, access]) {
      expect(JSON.stringify(done.credentials)).not.toContain(t);
      expect(JSON.stringify(done.grant.config)).not.toContain(t);
    }
    expect(
      await cipher.decrypt(done.credentials, { tenantId: TENANT, connectionId }),
    ).toMatchObject({
      refreshToken: refresh,
    });
  });

  it("never revokes at Google: disconnect drops only our tokens", async () => {
    const { connector, sheets } = await setup();
    expect(connector.revoke).toBeUndefined();
    expect(sheets.requests.some((r) => r.url === GOOGLE_DRIVE_REVOKE_URL)).toBe(false);
  });
});

describe("picked sheets", () => {
  it("describes a picked spreadsheet, and refuses one Google didn't grant us", async () => {
    const { connector, ctx, budget, other } = await setup();
    expect(await connector.describeSheets(ctx, [budget.id])).toEqual([
      {
        id: budget.id,
        name: "Shop budget",
        url: `https://docs.google.com/spreadsheets/d/${budget.id}/edit`,
      },
    ]);
    await expect(connector.describeSheets(ctx, [other.id])).rejects.toBeInstanceOf(
      SheetNotAvailableError,
    );
    await expect(connector.describeSheets(ctx, ["../../etc"])).rejects.toBeInstanceOf(
      SheetNotAvailableError,
    );
  });

  it("refuses a sheet the client didn't pick, before calling Google", async () => {
    const { connector, sheets, ctx, other } = await setup();
    // Google would open it (granted to this account some other way): still not picked here.
    sheets.pick(other.id, PAT);
    const sent = sheets.requests.length;
    await expect(
      runReadTool(connector, GSHEETS_TOOLS.read, { spreadsheetId: other.id }, ctx),
    ).rejects.toBeInstanceOf(SheetNotPickedError);
    await expect(
      executeWrite(connector, GSHEETS_TOOLS.append, { spreadsheetId: other.id, rows: [ROW] }, ctx),
    ).rejects.toBeInstanceOf(SheetNotPickedError);
    await expect(
      captureBefore(
        connector,
        GSHEETS_TOOLS.update,
        { spreadsheetId: other.id, range: "A1:A1", values: [["x"]] },
        ctx,
      ),
    ).rejects.toBeInstanceOf(SheetNotPickedError);
    expect(sheets.requests.length).toBe(sent);
    expect(sheets.cells(other.id)).toEqual([["Name", "Pay"]]);
  });

  it("refuses a sheet picked by another Google account than the one connected now", async () => {
    const { connector, ctx, budget } = await setup();
    const config = withPickedSheets(ctx.connection.config, [
      { id: budget.id, name: "Shop budget", url: null, account: "old@gmail.test", addedAt: "x" },
    ]);
    await expect(
      runReadTool(
        connector,
        GSHEETS_TOOLS.read,
        { spreadsheetId: budget.id },
        {
          ...ctx,
          connection: { ...ctx.connection, config },
        },
      ),
    ).rejects.toBeInstanceOf(SheetNotPickedError);
  });
});

describe("sheets.range.read", () => {
  it("reads a tab's cells as data, with a limit", async () => {
    const { connector, ctx, budget } = await setup();
    const all = await runReadTool(connector, GSHEETS_TOOLS.read, { spreadsheetId: budget.id }, ctx);
    expect(all.output).toEqual({
      spreadsheetId: budget.id,
      spreadsheet: "Shop budget",
      sheet: "Costs",
      range: "A1:Z3",
      values: [
        ["Date", "Vendor", "Amount"],
        ["2026-10-01", "Hardwood Supply", "412.5"],
        ["2026-10-03", "Edge Banding Co", "88"],
      ],
      truncated: false,
    });
    const some = await runReadTool(
      connector,
      GSHEETS_TOOLS.read,
      { spreadsheetId: budget.id, range: "B2:C", render: "unformatted", limit: 1 },
      ctx,
    );
    expect(some.output).toMatchObject({
      range: "B2:C2",
      values: [["Hardwood Supply", 412.5]],
      truncated: true,
    });
    const notes = await runReadTool(
      connector,
      GSHEETS_TOOLS.read,
      { spreadsheetId: budget.id, sheet: "Notes", range: "A1:A1" },
      ctx,
    );
    expect(notes.output).toMatchObject({ sheet: "Notes", values: [["hello"]] });
  });

  it("refuses ranges it can't read, before calling Google", async () => {
    const { connector, sheets, ctx, budget } = await setup();
    const sent = sheets.requests.length;
    for (const range of ["2:5", "A1:", "ZZZZ1", "C3:A1", "A:CZ", "A0", "Sheet1!A1"]) {
      await expect(
        runReadTool(connector, GSHEETS_TOOLS.read, { spreadsheetId: budget.id, range }, ctx),
        range,
      ).rejects.toBeInstanceOf(ToolCallError);
    }
    expect(sheets.requests.length).toBe(sent);
    await expect(
      runReadTool(connector, GSHEETS_TOOLS.read, { spreadsheetId: budget.id, sheet: "Nope" }, ctx),
    ).rejects.toThrow(/no tab named "Nope"/);
  });
});

describe("sheets.rows.append", () => {
  it("is behind approval by default", async () => {
    const { connector } = await setup();
    const matrix = connectionDefaults(connector.manifest);
    expect(matrix).toMatchObject({
      read: "auto",
      create: "approval",
      update: "approval",
      delete: "off",
    });
    expect(connector.manifest.defaultPermissions).toBeUndefined();
    expect(DEFAULT_PERMISSIONS.create).toBe("approval");
    for (const verb of ["create", "update"] as const) {
      expect(decideToolCall({ sideEffect: "external", verb, matrix, agentMode: "act" })).toBe(
        "approval",
      );
    }
  });

  it("shows the row count and last row as its before state, writing nothing", async () => {
    const { connector, sheets, ctx, budget } = await setup();
    const sent = sheets.requests.length;
    const { before } = await captureBefore(
      connector,
      GSHEETS_TOOLS.append,
      { spreadsheetId: budget.id, rows: [ROW] },
      ctx,
    );
    expect(before).toEqual({
      spreadsheet: { id: budget.id, name: "Shop budget" },
      sheet: { id: 0, title: "Costs" },
      rowCount: 3,
      lastRow: ["2026-10-03", "Edge Banding Co", 88],
      nextRow: 4,
      adding: 1,
    });
    expect(sheets.requests.slice(sent).filter((r) => r.method !== "GET")).toEqual([]);
    expect(sheets.cells(budget.id)).toEqual(BUDGET);
  });

  it("appends after the last row once per key", async () => {
    const { connector, sheets, ctx, budget } = await setup();
    const first = await executeWrite(
      connector,
      GSHEETS_TOOLS.append,
      { spreadsheetId: budget.id, rows: [ROW] },
      ctx,
    );
    expect(first.summary).toBe("Added 1 row(s) to Google Sheets at A4:C4");
    expect(first.output).toEqual({
      spreadsheetId: budget.id,
      sheet: "Costs",
      range: "A4:C4",
      firstRow: 4,
      rows: 1,
      alreadyDone: false,
    });
    expect(sheets.cells(budget.id)).toEqual([...BUDGET, ROW]);
    // A retried step (same key): the rows come back; nothing is added again.
    const again = await executeWrite(
      connector,
      GSHEETS_TOOLS.append,
      { spreadsheetId: budget.id, rows: [ROW] },
      ctx,
    );
    expect(again.output).toMatchObject({ range: "A4:C4", alreadyDone: true });
    expect(sheets.cells(budget.id)).toHaveLength(4);
    // Another action adds its own rows below.
    await executeWrite(
      connector,
      GSHEETS_TOOLS.append,
      { spreadsheetId: budget.id, rows: [ROW, ["2026-10-08", "Glue", 12]] },
      { ...ctx, idempotencyKey: "0192f7a0-run:log-cost:1" },
    );
    expect(sheets.cells(budget.id)).toHaveLength(6);
    // The marker is on the rows, in Google's own metadata.
    const tag = await sheetsActionTag(ctx.idempotencyKey);
    expect(sheets.spreadsheets.get(budget.id)?.metadata.find((m) => m.value === tag)).toMatchObject(
      {
        key: "mezonasAction",
        startIndex: 3,
        endIndex: 4,
      },
    );
  });

  it("finds its own rows after a lost answer instead of adding them twice", async () => {
    const { connector, sheets, ctx, budget } = await setup();
    sheets.loseNextWriteAnswer();
    const input = { spreadsheetId: budget.id, rows: [ROW] };
    await expect(executeWrite(connector, GSHEETS_TOOLS.append, input, ctx)).rejects.toThrow(
      /\(503\)/,
    );
    expect(sheets.cells(budget.id)).toHaveLength(4);
    // Someone adds a row by hand before the retry: ours is still found where it went.
    sheets.edit(budget.id, "Costs", 5, 1, "added by hand");
    const retry = await executeWrite(connector, GSHEETS_TOOLS.append, input, ctx);
    expect(retry.output).toMatchObject({ alreadyDone: true, range: "A4:C4", firstRow: 4 });
    expect(sheets.cells(budget.id)).toHaveLength(5);
    expect(sheets.cells(budget.id).filter((r) => r[1] === "Hardwood Supply")).toHaveLength(2);
  });

  it("writes text as text: nothing becomes a formula", async () => {
    const { connector, sheets, ctx, budget } = await setup();
    const evil = ['=HYPERLINK("https://evil.example","Pay")', "+1+1", "-2+3", "@SUM(A1)", "\t=1"];
    await executeWrite(
      connector,
      GSHEETS_TOOLS.append,
      { spreadsheetId: budget.id, rows: [[...evil, "-12.50", -3, "plain"]] },
      ctx,
    );
    const last = sheets.cells(budget.id).at(-1);
    expect(last).toEqual([
      '\'=HYPERLINK("https://evil.example","Pay")',
      "'+1+1",
      "'-2+3",
      "'@SUM(A1)",
      "'\t=1",
      "-12.50",
      -3,
      "plain",
    ]);
    // Typed values in the batch: stringValue, never formulaValue.
    const batch = sheets.requests.find((r) => r.url.endsWith(":batchUpdate"));
    expect(batch?.body).not.toContain("formulaValue");
    expect(batch?.body).toContain('"stringValue":"\'=HYPERLINK');
  });

  it("refuses too many cells and an open-ended tab name before calling Google", async () => {
    const { connector, sheets, ctx, budget } = await setup();
    const sent = sheets.requests.length;
    const wide = Array.from({ length: 101 }, () => "x");
    const many = Array.from({ length: 30 }, () => Array.from({ length: 70 }, () => 1));
    for (const input of [
      { spreadsheetId: budget.id, rows: [] },
      { spreadsheetId: budget.id, rows: [wide] },
      { spreadsheetId: budget.id, rows: many },
      { spreadsheetId: budget.id, sheet: "a\nb", rows: [ROW] },
      { spreadsheetId: budget.id, rows: [[Number.POSITIVE_INFINITY]] },
    ]) {
      await expect(
        executeWrite(connector, GSHEETS_TOOLS.append, input, ctx),
      ).rejects.toBeInstanceOf(ToolCallError);
    }
    expect(sheets.requests.length).toBe(sent);
  });
});

describe("sheets.range.update", () => {
  const CHANGE = (id: string) => ({ spreadsheetId: id, range: "C2:C3", values: [[415], ["=1+1"]] });

  it("shows the cells' current values, then changes them, written raw", async () => {
    const { connector, sheets, ctx, budget } = await setup();
    const proposal = await captureBefore(connector, GSHEETS_TOOLS.update, CHANGE(budget.id), ctx);
    expect(proposal.before).toEqual({
      spreadsheet: { id: budget.id, name: "Shop budget" },
      sheet: { id: 0, title: "Costs" },
      range: "C2:C3",
      values: [[412.5], [88]],
    });
    const done = await executeWrite(connector, GSHEETS_TOOLS.update, CHANGE(budget.id), {
      ...ctx,
      proposedBefore: proposal.before,
    });
    expect(done.output).toEqual({
      spreadsheetId: budget.id,
      sheet: "Costs",
      range: "C2:C3",
      updatedCells: 2,
      alreadyDone: false,
    });
    expect(sheets.cells(budget.id).map((r) => r[2])).toEqual(["Amount", 415, "'=1+1"]);
    const put = sheets.requests.find((r) => r.method === "PUT");
    const url = put?.url ?? "";
    expect(parseUrl(url)?.origin).toBe("https://sheets.googleapis.com");
    expect(formDecode(url.slice(url.indexOf("?") + 1)).valueInputOption).toBe("RAW");
  });

  it("is refused when the cells changed since the proposal", async () => {
    const { connector, sheets, ctx, budget } = await setup();
    const proposal = await captureBefore(connector, GSHEETS_TOOLS.update, CHANGE(budget.id), ctx);
    sheets.edit(budget.id, "Costs", 3, 3, 90);
    await expect(
      executeWrite(connector, GSHEETS_TOOLS.update, CHANGE(budget.id), {
        ...ctx,
        proposedBefore: proposal.before,
      }),
    ).rejects.toBeInstanceOf(SheetChangedError);
    expect(sheets.cells(budget.id).map((r) => r[2])).toEqual(["Amount", 412.5, 90]);
    expect(sheets.requests.some((r) => r.method === "PUT")).toBe(false);
  });

  it("writes once: a retry after a lost answer finds the cells already changed", async () => {
    const { connector, sheets, ctx, budget } = await setup();
    const proposal = await captureBefore(connector, GSHEETS_TOOLS.update, CHANGE(budget.id), ctx);
    const wctx = { ...ctx, proposedBefore: proposal.before };
    sheets.loseNextWriteAnswer();
    await expect(
      executeWrite(connector, GSHEETS_TOOLS.update, CHANGE(budget.id), wctx),
    ).rejects.toThrow(/\(503\)/);
    const retry = await executeWrite(connector, GSHEETS_TOOLS.update, CHANGE(budget.id), wctx);
    expect(retry.output).toMatchObject({ alreadyDone: true, updatedCells: 0 });
    expect(sheets.requests.filter((r) => r.method === "PUT")).toHaveLength(1);
  });

  it("keeps a null cell as it is, and refuses a shape that doesn't fit the range", async () => {
    const { connector, sheets, ctx, budget } = await setup();
    await executeWrite(
      connector,
      GSHEETS_TOOLS.update,
      { spreadsheetId: budget.id, range: "B2:C2", values: [[null, 1]] },
      ctx,
    );
    expect(sheets.cells(budget.id)[1]).toEqual(["2026-10-01", "Hardwood Supply", 1]);
    for (const input of [
      { spreadsheetId: budget.id, range: "B2:C2", values: [[1]] },
      { spreadsheetId: budget.id, range: "B2:C", values: [[1, 2]] },
      { spreadsheetId: budget.id, range: "A1:Z100", values: [[1]] },
    ]) {
      await expect(
        executeWrite(connector, GSHEETS_TOOLS.update, input, ctx),
      ).rejects.toBeInstanceOf(ToolCallError);
    }
  });

  it("refreshes after a 401; an expired grant asks for a reconnect", async () => {
    const { connector, sheets, ctx, budget } = await setup();
    sheets.expireAccessTokens();
    await runReadTool(connector, GSHEETS_TOOLS.read, { spreadsheetId: budget.id }, ctx);
    expect(ctx.credentials.current()).toMatchObject({
      accessToken: sheets.issued().accessTokens[1],
    });
    const dead = memoryCredentials({
      ...(ctx.credentials.current() ?? {}),
      refreshToken: "1//gone",
    });
    sheets.expireAccessTokens();
    await expect(
      runReadTool(
        connector,
        GSHEETS_TOOLS.read,
        { spreadsheetId: budget.id },
        { ...ctx, credentials: dead },
      ),
    ).rejects.toBeInstanceOf(ReconnectRequiredError);
  });
});

describe("A1 notation and cells", () => {
  it("parses ranges with index loops and writes them back", () => {
    expect(columnNumber("A")).toBe(1);
    expect(columnNumber("zz")).toBe(702);
    expect(columnNumber("ZZZ")).toBe(18278);
    expect(columnNumber("AAAA")).toBeNull();
    expect(columnLetters(27)).toBe("AA");
    expect(columnLetters(18278)).toBe("ZZZ");
    expect(parseA1("B3")).toEqual({
      ok: true,
      range: { startCol: 2, startRow: 3, endCol: 2, endRow: 3 },
    });
    expect(parseA1("A2:C")).toEqual({
      ok: true,
      range: { startCol: 1, startRow: 2, endCol: 3, endRow: null },
    });
    expect(parseA1("a:c").ok).toBe(true);
    for (const bad of [
      "",
      "A",
      "A:C5",
      "A1:B2:C3",
      "A01",
      "1A",
      "A1:",
      ":A1",
      `A${"9".repeat(30)}`,
    ]) {
      expect(parseA1(bad).ok, bad).toBe(false);
    }
  });

  it("quotes tab names and reads Google's ranges back", () => {
    expect(qualifiedRange("Bob's costs", "A1:B2")).toBe("'Bob''s costs'!A1:B2");
    expect(splitQualifiedRange("'Bob''s costs'!A1:B2")).toEqual({
      title: "Bob's costs",
      cells: "A1:B2",
    });
    expect(splitQualifiedRange("Sheet1!A1")).toEqual({ title: "Sheet1", cells: "A1" });
    expect(splitQualifiedRange("'open")).toBeNull();
  });

  it("escapes text that could start a formula, and leaves numbers alone", () => {
    expect(writtenCell("=1+1")).toBe("'=1+1");
    expect(writtenCell("@x")).toBe("'@x");
    expect(writtenCell("+x")).toBe("'+x");
    expect(writtenCell("-x")).toBe("'-x");
    expect(writtenCell("\r=1")).toBe("'\r=1");
    expect(writtenCell("-12.5")).toBe("-12.5");
    expect(writtenCell("+3e5")).toBe("+3e5");
    expect(writtenCell("a=b")).toBe("a=b");
    expect(writtenCell(-4)).toBe(-4);
    expect(writtenCell(null)).toBeNull();
    expect(isNumericText("1.")).toBe(true);
    expect(isNumericText("-")).toBe(false);
    expect(isNumericText("1e")).toBe(false);
    expect(holdsWritten("=1+1", "'=1+1")).toBe(true);
    expect(holdsWritten("'=1+1", "'=1+1")).toBe(true);
    expect(holdsWritten("x", null)).toBe(true);
    expect(holdsWritten("", "")).toBe(true);
    expect(holdsWritten(null, "x")).toBe(false);
  });
});
