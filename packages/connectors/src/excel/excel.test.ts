// The excel connector against a fake Microsoft (§1.97): sign-in asks for exactly Files.ReadWrite
// with OpenID's scopes and refuses a grant without it or with more, keeping nothing; tokens refresh
// (rotating) and an expired grant asks for a reconnect; a workbook the client didn't pick is refused
// before Graph is called; reads are capped; `excel.rows.append` adds rows once per key, also after
// a lost answer; `excel.range.update` is refused when the cells changed since the proposal and
// keeps what it replaced; nothing we write runs as a formula; approval is on by default.
import type { JsonObject } from "@countersign/core";
import { DEFAULT_PERMISSIONS, decideToolCall } from "@countersign/core";
import { describe, expect, it } from "vitest";
import type { WriteAttemptServices, WriteAttemptState } from "../attempts";
import { type ConnectionRef, UnconfirmedWriteError } from "../connector";
import { memoryCredentials } from "../credentials-accessor";
import { formDecode } from "../http";
import { captureBefore, executeWrite, runReadTool, ToolCallError } from "../invoke";
import { noopLogger } from "../logger";
import {
  MICROSOFT_AUTH_URL,
  MICROSOFT_CONSUMER_TENANT,
  MICROSOFT_TOKEN_URL,
  MicrosoftNotConfiguredError,
} from "../microsoft/identity";
import { ReconnectRequiredError, SignInRefusedError } from "../oauth/tokens";
import { connectionDefaults } from "../permissions";
import {
  EXCEL_XLSX_MIME,
  excelHolds,
  excelValue,
  isExcelItemId,
  isExcelWorkbookFile,
  worksheetNameProblem,
} from "./cells";
import { FAKE_EXCEL_ACCOUNT, FAKE_EXCEL_APP, fakeExcel } from "./fake";
import {
  createExcelConnector,
  EXCEL_FILES_SCOPE,
  EXCEL_TOOLS,
  excelConfigOf,
  excelRestoreInput,
  isExcelConnector,
  type PickedWorkbook,
  pickedWorkbook,
  WorkbookChangedError,
  WorkbookNotAvailableError,
  WorkbookNotPickedError,
  withPickedWorkbooks,
} from "./index";

const REDIRECT = "https://staging.mezonas.com/connections/excel/callback";
const NOW = new Date("2026-11-12T15:00:00.000Z");
const TENANT = "0192f7a0-0000-7000-8000-0000000000aa";
const PAT = FAKE_EXCEL_ACCOUNT;
const TID = "4a1b2c3d-0000-4000-8000-0000000000a1";
const SCOPES = `openid email offline_access ${EXCEL_FILES_SCOPE}`;
const KEY = "0192f7a0-run:log-cost:0";

const COSTS = [
  ["Date", "Vendor", "Amount"],
  ["Oct 1", "Hardwood Supply", 412.5],
  ["Oct 3", "Edge Banding Co", 88],
];

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
  return { attempts: s, started, refused, done };
}

async function signIn(excel = fakeExcel(), code = excel.issueCode({ tid: TID })) {
  const connector = createExcelConnector({ ...FAKE_EXCEL_APP, fetch: excel.fetch });
  const grant = await connector.handleCallback?.(
    { code, state: "s" },
    { tenantId: TENANT, userId: "u1", redirectUri: REDIRECT },
  );
  if (!grant) throw new Error("no grant");
  return { connector, grant, excel };
}

async function setup() {
  const { connector, grant, excel } = await signIn();
  const costs = excel.seed("Shop costs.xlsx", { Costs: COSTS, Notes: [["hello"]] });
  const payroll = excel.seed("Payroll.xlsx", { Sheet1: [["Name", "Pay"]] });
  const picked: PickedWorkbook = {
    id: costs.id,
    name: "Shop costs.xlsx",
    url: null,
    account: PAT,
    tid: TID,
    addedAt: NOW.toISOString(),
  };
  const connection: ConnectionRef = {
    id: "0192f7a0-0000-7000-8000-000000000005",
    tenantId: TENANT,
    connector: "excel",
    status: "connected",
    externalAccountId: grant.externalAccountId,
    config: withPickedWorkbooks(grant.config ?? {}, [picked]),
    permissions: {},
  };
  const credentials = memoryCredentials({
    ...grant.credentials,
    expiresAt: "2026-11-12T16:00:00Z",
  });
  const mem = memoryAttempts();
  const ctx = {
    tenantId: TENANT,
    connection,
    credentials,
    logger: noopLogger,
    now: () => NOW,
    services: { attempts: mem.attempts },
    idempotencyKey: KEY,
  };
  return { connector, excel, ctx, credentials, costs, payroll, ...mem };
}

const graphCalls = (excel: ReturnType<typeof fakeExcel>) =>
  excel.requests.filter((r) => r.url !== MICROSOFT_TOKEN_URL);
const patches = (excel: ReturnType<typeof fakeExcel>) =>
  excel.requests.filter((r) => r.method === "PATCH");

const ROW = ["Oct 7", "Hardwood Supply", 129.95];

describe("excel sign-in", () => {
  it("asks for exactly Files.ReadWrite with OpenID's scopes, on Excel's own app", async () => {
    const connector = createExcelConnector(FAKE_EXCEL_APP);
    expect(connector.isConfigured?.()).toBe(true);
    expect(isExcelConnector(connector)).toBe(true);
    const unset = createExcelConnector({});
    expect(unset.isConfigured?.()).toBe(false);
    await expect(
      unset.authorize?.({ tenantId: TENANT, userId: "u1", state: "s", redirectUri: REDIRECT }),
    ).rejects.toThrow(MicrosoftNotConfiguredError);
    await expect(
      unset.authorize?.({ tenantId: TENANT, userId: "u1", state: "s", redirectUri: REDIRECT }),
    ).rejects.toThrow(/EXCEL_CLIENT_ID, EXCEL_CLIENT_SECRET/);
    const { redirectUrl } = (await connector.authorize?.({
      tenantId: TENANT,
      userId: "u1",
      state: "the-state",
      redirectUri: REDIRECT,
    })) ?? { redirectUrl: "" };
    const [base, query = ""] = redirectUrl.split("?");
    expect(base).toBe(MICROSOFT_AUTH_URL);
    expect(formDecode(query)).toEqual({
      client_id: FAKE_EXCEL_APP.clientId,
      response_type: "code",
      redirect_uri: REDIRECT,
      response_mode: "query",
      scope: SCOPES,
      prompt: "select_account",
      state: "the-state",
    });
    expect(connector.manifest.tools.map((t) => [t.id, t.verb, t.sideEffect, t.entity])).toEqual([
      [EXCEL_TOOLS.read, "read", "none", "row"],
      [EXCEL_TOOLS.append, "create", "external", "row"],
      [EXCEL_TOOLS.update, "update", "external", "row"],
    ]);
    expect(connector.manifest.tools.map((t) => t.undo)).toEqual([
      undefined,
      { kind: "none" },
      { kind: "restore" },
    ]);
    // Disconnect can't revoke at Microsoft: only our tokens are dropped.
    expect(connector.revoke).toBeUndefined();
  });

  it("keeps the account and its directory, and no workbooks: a reconnect keeps the picked list", async () => {
    const { grant, excel } = await signIn();
    expect(grant.externalAccountId).toBe(PAT);
    expect(grant.config).toEqual({ address: PAT, tid: TID, scopes: ["Files.ReadWrite"] });
    expect(grant.credentials).toMatchObject({
      address: PAT,
      accessToken: excel.issued().accessTokens[0],
      refreshToken: excel.issued().refreshTokens[0],
    });
    const call = excel.requests.find((r) => r.url === MICROSOFT_TOKEN_URL);
    expect(formDecode(call?.body ?? "")).toMatchObject({
      grant_type: "authorization_code",
      client_id: FAKE_EXCEL_APP.clientId,
      redirect_uri: REDIRECT,
      scope: SCOPES,
    });
    // Nothing but the token endpoint: the address comes from the ID token.
    expect(graphCalls(excel)).toEqual([]);
  });

  it("takes a personal account with User.Read and profile beside Files.ReadWrite", async () => {
    const excel = fakeExcel();
    const { grant } = await signIn(
      excel,
      excel.issueCode({
        address: "Pat.Lee@Outlook.example",
        tid: MICROSOFT_CONSUMER_TENANT,
        claim: "preferred_username",
        scopes: ["Files.ReadWrite", "User.Read", "openid", "profile", "email", "offline_access"],
      }),
    );
    expect(grant.config).toMatchObject({
      address: "pat.lee@outlook.example",
      tid: MICROSOFT_CONSUMER_TENANT,
    });
  });

  it("refuses a grant without Files.ReadWrite or with more, keeping nothing", async () => {
    const excel = fakeExcel();
    await expect(
      signIn(excel, excel.issueCode({ scopes: ["openid", "email", "offline_access"] })),
    ).rejects.toBeInstanceOf(SignInRefusedError);
    await expect(
      signIn(excel, excel.issueCode({ scopes: ["Files.Read", "openid", "offline_access"] })),
    ).rejects.toThrow(/permission to open the workbooks/);
    for (const more of [
      "Files.ReadWrite.All",
      "https://graph.microsoft.com/Files.Read.All",
      "Sites.Read.All",
      "Sites.Selected",
      "Mail.Send",
    ]) {
      await expect(
        signIn(excel, excel.issueCode({ scopes: [EXCEL_FILES_SCOPE, more, "openid"] })),
        more,
      ).rejects.toThrow(/more access/);
    }
    expect(graphCalls(excel)).toEqual([]);
  });

  it("refreshes before expiry and keeps the rotated refresh token; an expired grant asks for a reconnect", async () => {
    const { connector, excel, ctx, credentials, costs } = await setup();
    await credentials.set({ ...(credentials.current() ?? {}), expiresAt: "2026-11-12T14:00:00Z" });
    await runReadTool(connector, EXCEL_TOOLS.read, { workbookId: costs.id }, ctx);
    const refresh = excel.requests.filter(
      (r) => r.url === MICROSOFT_TOKEN_URL && r.body.includes("grant_type=refresh_token"),
    );
    expect(refresh).toHaveLength(1);
    expect(formDecode(refresh[0]?.body ?? "")).toMatchObject({
      client_id: FAKE_EXCEL_APP.clientId,
      scope: SCOPES,
    });
    expect(credentials.current()).toMatchObject({
      accessToken: excel.issued().accessTokens[1],
      refreshToken: excel.issued().refreshTokens[1],
    });

    // A token Microsoft refuses mid-way: one refresh, then the read.
    excel.expireAccessTokens();
    await runReadTool(connector, EXCEL_TOOLS.read, { workbookId: costs.id }, ctx);
    expect(credentials.current()).toMatchObject({
      accessToken: excel.issued().accessTokens[2],
      refreshToken: excel.issued().refreshTokens[2],
    });

    // invalid_grant (revoked, expired, password changed): the person connects again.
    excel.expireRefreshTokens();
    excel.expireAccessTokens();
    await expect(
      runReadTool(connector, EXCEL_TOOLS.read, { workbookId: costs.id }, ctx),
    ).rejects.toBeInstanceOf(ReconnectRequiredError);
  });
});

describe("picked workbooks", () => {
  it("describes a workbook in the person's own OneDrive, and refuses anything else", async () => {
    const { connector, excel, ctx, costs } = await setup();
    expect(await connector.describeWorkbooks(ctx, [costs.id])).toEqual([
      {
        id: costs.id,
        name: "Shop costs.xlsx",
        url: `https://onedrive.live.com/edit.aspx?resid=${encodeURIComponent(costs.id)}`,
      },
    ]);
    const csv = excel.seed("Prices.csv", { Sheet1: [] }, { mimeType: "text/csv" });
    const xls = excel.seed("Old.xls", { Sheet1: [] }, { mimeType: "application/vnd.ms-excel" });
    const theirs = excel.seed("Boss.xlsx", { Sheet1: [] }, { owner: "boss@shop.example" });
    excel.share(theirs.id, PAT);
    for (const id of [csv.id, xls.id, theirs.id, "../../me/drive/root", "D4648F06C91D9D3D!999"]) {
      await expect(connector.describeWorkbooks(ctx, [id]), id).rejects.toBeInstanceOf(
        WorkbookNotAvailableError,
      );
    }
  });

  it("searches the person's own .xlsx workbooks only", async () => {
    const { connector, excel, ctx, costs, payroll } = await setup();
    excel.seed("Shop prices.csv", { Sheet1: [] }, { mimeType: "text/csv" });
    const theirs = excel.seed("Shop plan.xlsx", { Sheet1: [] }, { owner: "boss@shop.example" });
    excel.share(theirs.id, PAT);
    const deep = excel.seed("Shop 2025.xlsx", { Sheet1: [] }, { folder: "/Finance/Old%20years" });
    const found = await connector.searchWorkbooks(ctx, "shop");
    expect(found.map((f) => f.id)).toEqual([costs.id, deep.id]);
    expect(found[1]).toMatchObject({
      folder: "Finance/Old years",
      modifiedAt: "2026-11-01T10:00:00Z",
    });
    // An empty search lists .xlsx files; a quote is escaped for OData.
    expect((await connector.searchWorkbooks(ctx, "  ")).map((f) => f.id)).toEqual([
      costs.id,
      payroll.id,
      deep.id,
    ]);
    await connector.searchWorkbooks(ctx, "Pat's");
    expect(excel.requests.at(-1)?.url).toContain("search(q='Pat''s')");
    await expect(connector.searchWorkbooks(ctx, "a\nb")).rejects.toThrow(/control characters/);
  });

  it("refuses a workbook the client didn't pick, before calling Microsoft", async () => {
    const { connector, excel, ctx, payroll } = await setup();
    const sent = excel.requests.length;
    await expect(
      runReadTool(connector, EXCEL_TOOLS.read, { workbookId: payroll.id }, ctx),
    ).rejects.toBeInstanceOf(WorkbookNotPickedError);
    await expect(
      executeWrite(connector, EXCEL_TOOLS.append, { workbookId: payroll.id, rows: [ROW] }, ctx),
    ).rejects.toBeInstanceOf(WorkbookNotPickedError);
    await expect(
      captureBefore(
        connector,
        EXCEL_TOOLS.update,
        { workbookId: payroll.id, range: "A1:A1", values: [["x"]] },
        ctx,
      ),
    ).rejects.toBeInstanceOf(WorkbookNotPickedError);
    expect(excel.requests.length).toBe(sent);
    expect(excel.cells(payroll.id)).toEqual([["Name", "Pay"]]);
  });

  it("refuses a workbook picked by another account, or the same address in another directory", async () => {
    const { connector, excel, ctx, costs } = await setup();
    const base = { id: costs.id, name: "Shop costs.xlsx", url: null, addedAt: "x" };
    const sent = excel.requests.length;
    for (const w of [
      { ...base, account: "old@shop.example", tid: TID },
      { ...base, account: PAT, tid: MICROSOFT_CONSUMER_TENANT },
      { ...base, account: PAT },
    ]) {
      const config = withPickedWorkbooks(ctx.connection.config, [w]);
      await expect(
        runReadTool(
          connector,
          EXCEL_TOOLS.read,
          { workbookId: costs.id },
          { ...ctx, connection: { ...ctx.connection, config } },
        ),
      ).rejects.toBeInstanceOf(WorkbookNotPickedError);
    }
    expect(excel.requests.length).toBe(sent);
    expect(() => excelConfigOf({})).toThrow(ReconnectRequiredError);
    expect(pickedWorkbook(excelConfigOf(ctx.connection.config), costs.id).name).toBe(
      "Shop costs.xlsx",
    );
  });
});

describe("excel.range.read", () => {
  it("reads a worksheet's used cells as data, with a limit", async () => {
    const { connector, ctx, costs } = await setup();
    const all = await runReadTool(connector, EXCEL_TOOLS.read, { workbookId: costs.id }, ctx);
    expect(all.output).toEqual({
      workbookId: costs.id,
      workbook: "Shop costs.xlsx",
      sheet: "Costs",
      range: "A1:C3",
      values: [
        ["Date", "Vendor", "Amount"],
        ["Oct 1", "Hardwood Supply", "412.5"],
        ["Oct 3", "Edge Banding Co", "88"],
      ],
      truncated: false,
    });
    expect(all.summary).toBe("Read A1:C3 of Shop costs.xlsx in Excel");
    const some = await runReadTool(
      connector,
      EXCEL_TOOLS.read,
      { workbookId: costs.id, range: "B2:C", render: "unformatted", limit: 1 },
      ctx,
    );
    expect(some.output).toMatchObject({
      range: "B2:C2",
      values: [["Hardwood Supply", 412.5]],
      truncated: true,
    });
    const notes = await runReadTool(
      connector,
      EXCEL_TOOLS.read,
      { workbookId: costs.id, sheet: "Notes", range: "A1:A1" },
      ctx,
    );
    expect(notes.output).toMatchObject({ sheet: "Notes", values: [["hello"]] });
  });

  it("never reads past the last row with data, and shows formulas only when asked", async () => {
    const { connector, excel, ctx, costs } = await setup();
    excel.edit(costs.id, "Costs", 4, 3, { formula: "=SUM(C2:C3)", value: 500.5 });
    const beyond = await runReadTool(
      connector,
      EXCEL_TOOLS.read,
      { workbookId: costs.id, range: "A100:C200" },
      ctx,
    );
    expect(beyond.output).toMatchObject({ values: [], truncated: false });
    const big = await runReadTool(
      connector,
      EXCEL_TOOLS.read,
      { workbookId: costs.id, range: "C1:C1000000", render: "formula" },
      ctx,
    );
    expect(big.output).toMatchObject({
      range: "C1:C4",
      values: [["Amount"], [412.5], [88], ["=SUM(C2:C3)"]],
    });
    const asked = excel.requests.filter((r) => r.url.includes("range(address="));
    expect(asked.at(-1)?.url).toContain("range(address='C1:C4')");
    const shown = await runReadTool(
      connector,
      EXCEL_TOOLS.read,
      { workbookId: costs.id, range: "C4:C4", render: "unformatted" },
      ctx,
    );
    expect(shown.output).toMatchObject({ values: [[500.5]] });
  });

  it("reads an empty worksheet as no rows", async () => {
    const { connector, excel, ctx } = await setup();
    const blank = excel.seed("Blank.xlsx", { Sheet1: [] });
    const config = withPickedWorkbooks(ctx.connection.config, [
      { id: blank.id, name: "Blank.xlsx", url: null, account: PAT, tid: TID, addedAt: "x" },
    ]);
    const read = await runReadTool(
      connector,
      EXCEL_TOOLS.read,
      { workbookId: blank.id },
      { ...ctx, connection: { ...ctx.connection, config } },
    );
    expect(read.output).toMatchObject({ range: "A1:A1", values: [], truncated: false });
  });

  it("refuses ranges and names Excel can't have, before calling Microsoft", async () => {
    const { connector, excel, ctx, costs } = await setup();
    const sent = excel.requests.length;
    for (const range of ["2:5", "A1:", "XFE1", "A1048577", "C3:A1", "A:CZ", "A0", "Sheet1!A1"]) {
      await expect(
        runReadTool(connector, EXCEL_TOOLS.read, { workbookId: costs.id, range }, ctx),
        range,
      ).rejects.toBeInstanceOf(ToolCallError);
    }
    for (const sheet of ["", "a/b", "x".repeat(32), "'quoted'", "a\nb"]) {
      await expect(
        runReadTool(connector, EXCEL_TOOLS.read, { workbookId: costs.id, sheet }, ctx),
        sheet,
      ).rejects.toBeInstanceOf(ToolCallError);
    }
    expect(excel.requests.length).toBe(sent);
    await expect(
      runReadTool(connector, EXCEL_TOOLS.read, { workbookId: costs.id, sheet: "Nope" }, ctx),
    ).rejects.toThrow(/no worksheet named "Nope"/);
  });

  it("says when the workbook is gone", async () => {
    const { connector, excel, ctx, costs } = await setup();
    excel.items.delete(costs.id);
    await expect(
      runReadTool(connector, EXCEL_TOOLS.read, { workbookId: costs.id }, ctx),
    ).rejects.toThrow(/won't open this workbook/);
  });
});

describe("excel.rows.append", () => {
  it("is behind approval by default", async () => {
    const { connector } = await setup();
    expect(connector.manifest.defaultPermissions).toBeUndefined();
    const matrix = connectionDefaults(connector.manifest);
    expect(matrix).toMatchObject({
      read: "auto",
      create: "approval",
      update: "approval",
      delete: "off",
    });
    expect(DEFAULT_PERMISSIONS.create).toBe("approval");
    for (const verb of ["create", "update"] as const) {
      expect(decideToolCall({ sideEffect: "external", verb, matrix, agentMode: "act" })).toBe(
        "approval",
      );
    }
    // Only the operator's step setting and an `auto` matrix together let it run on its own.
    expect(
      decideToolCall({
        sideEffect: "external",
        verb: "create",
        matrix: { ...matrix, create: "auto" },
        stepApproval: "not_required",
        agentMode: "act",
      }),
    ).toBe("run");
  });

  it("shows the row count and last row as its before state, writing nothing", async () => {
    const { connector, excel, ctx, costs } = await setup();
    const { before } = await captureBefore(
      connector,
      EXCEL_TOOLS.append,
      { workbookId: costs.id, rows: [ROW] },
      ctx,
    );
    expect(before).toEqual({
      workbook: { id: costs.id, name: "Shop costs.xlsx" },
      sheet: { id: "{00000000-0001-0000-0000-000000000000}", name: "Costs" },
      rowCount: 3,
      lastRow: ["Oct 3", "Edge Banding Co", 88],
      nextRow: 4,
      adding: 1,
    });
    expect(patches(excel)).toEqual([]);
    expect(excel.cells(costs.id)).toEqual(COSTS);
  });

  it("appends after the last row once per key: a retry returns the first result", async () => {
    const { connector, excel, ctx, costs, started } = await setup();
    const first = await executeWrite(
      connector,
      EXCEL_TOOLS.append,
      { workbookId: costs.id, rows: [ROW] },
      ctx,
    );
    expect(first.summary).toBe("Added 1 row(s) to Excel at A4:C4");
    expect(first.output).toEqual({
      workbookId: costs.id,
      sheet: "Costs",
      range: "A4:C4",
      firstRow: 4,
      rows: 1,
      alreadyDone: false,
    });
    expect(excel.cells(costs.id)).toEqual([...COSTS, ROW]);
    // The attempt was recorded before Graph was called, with where the rows go.
    expect([...started.values()][0]?.details).toMatchObject({ range: "A4:C4", attempt: 1 });
    // A retried step (same key): the first result comes back; nothing is added again.
    const again = await executeWrite(
      connector,
      EXCEL_TOOLS.append,
      { workbookId: costs.id, rows: [ROW] },
      ctx,
    );
    expect(again.output).toMatchObject({ range: "A4:C4", firstRow: 4, alreadyDone: true });
    expect(excel.cells(costs.id)).toHaveLength(4);
    expect(patches(excel)).toHaveLength(1);
    // Another action adds its own rows below, padded to a rectangle.
    const next = await executeWrite(
      connector,
      EXCEL_TOOLS.append,
      { workbookId: costs.id, rows: [ROW, ["Oct 8", "Glue"]] },
      { ...ctx, idempotencyKey: "0192f7a0-run:log-cost:1" },
    );
    expect(next.output).toMatchObject({ range: "A5:C6", firstRow: 5, rows: 2 });
    expect(excel.cells(costs.id)).toEqual([...COSTS, ROW, ROW, ["Oct 8", "Glue"]]);
  });

  it("confirms its own rows after a lost answer instead of adding them twice", async () => {
    const { connector, excel, ctx, costs, done } = await setup();
    excel.loseNextWriteAnswer();
    const input = { workbookId: costs.id, rows: [ROW] };
    await expect(executeWrite(connector, EXCEL_TOOLS.append, input, ctx)).rejects.toThrow(
      /\(504\)/,
    );
    expect(excel.cells(costs.id)).toHaveLength(4);
    expect(done.size).toBe(0);
    const retry = await executeWrite(connector, EXCEL_TOOLS.append, input, ctx);
    expect(retry.output).toMatchObject({ alreadyDone: true, range: "A4:C4", firstRow: 4 });
    expect(excel.cells(costs.id)).toHaveLength(4);
    expect(patches(excel)).toHaveLength(1);
    expect(done.get(KEY)).toMatchObject({ range: "A4:C4", alreadyDone: false });
  });

  it("never writes again when a lost answer's cells don't hold its rows", async () => {
    const { connector, excel, ctx, costs } = await setup();
    excel.loseNextWriteAnswer();
    const input = { workbookId: costs.id, rows: [ROW] };
    await expect(executeWrite(connector, EXCEL_TOOLS.append, input, ctx)).rejects.toThrow(
      /\(504\)/,
    );
    // Someone changed the new row before the retry: we can't tell what happened.
    excel.edit(costs.id, "Costs", 4, 3, 130);
    const retry = executeWrite(connector, EXCEL_TOOLS.append, input, ctx);
    await expect(retry).rejects.toBeInstanceOf(UnconfirmedWriteError);
    await expect(executeWrite(connector, EXCEL_TOOLS.append, input, ctx)).rejects.toThrow(
      /may have been added/,
    );
    expect(patches(excel)).toHaveLength(1);
    expect(excel.cells(costs.id)).toHaveLength(4);
  });

  it("tries again after Microsoft turned it down, and stops after three", async () => {
    const { connector, excel, ctx, costs, refused } = await setup();
    const input = { workbookId: costs.id, rows: [ROW] };
    excel.refuseNextWrite(409, "editModeCannotAcquireLock");
    await expect(executeWrite(connector, EXCEL_TOOLS.append, input, ctx)).rejects.toThrow(
      /\(409\)/,
    );
    expect(refused.size).toBe(1);
    const ok = await executeWrite(connector, EXCEL_TOOLS.append, input, ctx);
    expect(ok.output).toMatchObject({ range: "A4:C4", alreadyDone: false });

    const key2 = { ...ctx, idempotencyKey: "0192f7a0-run:log-cost:2" };
    for (let i = 0; i < 3; i++) {
      excel.refuseNextWrite(429, "tooManyRequests");
      await expect(executeWrite(connector, EXCEL_TOOLS.append, input, key2)).rejects.toThrow(
        /\(429\)/,
      );
    }
    await expect(executeWrite(connector, EXCEL_TOOLS.append, input, key2)).rejects.toThrow(
      /3 times/,
    );
    expect(excel.cells(costs.id)).toHaveLength(4);
  });

  it("refuses to write without the platform's record of attempts", async () => {
    const { connector, excel, ctx, costs } = await setup();
    await expect(
      executeWrite(
        connector,
        EXCEL_TOOLS.append,
        { workbookId: costs.id, rows: [ROW] },
        { ...ctx, services: {} },
      ),
    ).rejects.toThrow(/record of attempts/);
    expect(patches(excel)).toEqual([]);
  });

  it("writes text as text: nothing becomes a formula, a date or a number", async () => {
    const { connector, excel, ctx, costs } = await setup();
    const evil = ['=HYPERLINK("https://evil.example","Pay")', "+1+1", "-2+3", "@SUM(A1)"];
    await executeWrite(
      connector,
      EXCEL_TOOLS.append,
      {
        workbookId: costs.id,
        rows: [[...evil, "-12.50", "2026-10-07", "TRUE", -3, true, "plain"]],
      },
      ctx,
    );
    expect(excel.cells(costs.id).at(-1)).toEqual([
      '\'=HYPERLINK("https://evil.example","Pay")',
      "'+1+1",
      "'-2+3",
      "'@SUM(A1)",
      "-12.50",
      "2026-10-07",
      "TRUE",
      -3,
      true,
      "plain",
    ]);
    const sent = JSON.parse(patches(excel)[0]?.body ?? "{}");
    expect(Object.keys(sent)).toEqual(["values"]);
    expect(sent.values[0].slice(0, 2)).toEqual([
      '\'\'=HYPERLINK("https://evil.example","Pay")',
      "''+1+1",
    ]);
    expect(sent.values[0].slice(4)).toEqual([
      "'-12.50",
      "'2026-10-07",
      "'TRUE",
      -3,
      true,
      "'plain",
    ]);
  });

  it("refuses too many cells, empty rows and bad values before calling Microsoft", async () => {
    const { connector, excel, ctx, costs } = await setup();
    const sent = excel.requests.length;
    const wide = Array.from({ length: 101 }, () => "x");
    const many = Array.from({ length: 30 }, () => Array.from({ length: 70 }, () => 1));
    const long = Array.from({ length: 40 }, () => ["y".repeat(30_000)]);
    for (const input of [
      { workbookId: costs.id, rows: [] },
      { workbookId: costs.id, rows: [wide] },
      { workbookId: costs.id, rows: many },
      { workbookId: costs.id, rows: long },
      { workbookId: costs.id, rows: [["x".repeat(32_768)]] },
      { workbookId: costs.id, rows: [[null, ""]] },
      { workbookId: costs.id, sheet: "a\nb", rows: [ROW] },
      { workbookId: costs.id, rows: [[Number.POSITIVE_INFINITY]] },
      { workbookId: "not an id", rows: [ROW] },
    ]) {
      await expect(executeWrite(connector, EXCEL_TOOLS.append, input, ctx)).rejects.toBeInstanceOf(
        ToolCallError,
      );
    }
    expect(excel.requests.length).toBe(sent);
  });
});

describe("excel.range.update", () => {
  const CHANGE = (id: string) => ({ workbookId: id, range: "C2:C3", values: [[415], ["=1+1"]] });

  it("shows the cells' current contents, then changes them as text", async () => {
    const { connector, excel, ctx, costs } = await setup();
    const proposal = await captureBefore(connector, EXCEL_TOOLS.update, CHANGE(costs.id), ctx);
    expect(proposal.before).toEqual({
      workbook: { id: costs.id, name: "Shop costs.xlsx" },
      sheet: { id: "{00000000-0001-0000-0000-000000000000}", name: "Costs" },
      range: "C2:C3",
      values: [[412.5], [88]],
    });
    expect(patches(excel)).toEqual([]);
    const done = await executeWrite(connector, EXCEL_TOOLS.update, CHANGE(costs.id), {
      ...ctx,
      proposedBefore: proposal.before,
    });
    expect(done.output).toEqual({
      workbookId: costs.id,
      sheet: "Costs",
      range: "C2:C3",
      updatedCells: 2,
      alreadyDone: false,
    });
    expect(done.summary).toBe("Changed C2:C3 in Excel");
    expect(excel.cells(costs.id).map((r) => r[2])).toEqual(["Amount", 415, "'=1+1"]);
    expect(patches(excel)[0]?.url).toContain(
      `/me/drive/items/${encodeURIComponent(costs.id)}/workbook/worksheets/${encodeURIComponent("{00000000-0001-0000-0000-000000000000}")}/range(address='C2:C3')`,
    );
  });

  it("is refused when the cells changed since the proposal", async () => {
    const { connector, excel, ctx, costs } = await setup();
    const proposal = await captureBefore(connector, EXCEL_TOOLS.update, CHANGE(costs.id), ctx);
    excel.edit(costs.id, "Costs", 3, 3, 90);
    await expect(
      executeWrite(connector, EXCEL_TOOLS.update, CHANGE(costs.id), {
        ...ctx,
        proposedBefore: proposal.before,
      }),
    ).rejects.toBeInstanceOf(WorkbookChangedError);
    expect(excel.cells(costs.id).map((r) => r[2])).toEqual(["Amount", 412.5, 90]);
    expect(patches(excel)).toEqual([]);
  });

  it("writes once: a retry after a lost answer finds the cells already changed", async () => {
    const { connector, excel, ctx, costs } = await setup();
    const proposal = await captureBefore(connector, EXCEL_TOOLS.update, CHANGE(costs.id), ctx);
    const wctx = { ...ctx, proposedBefore: proposal.before };
    excel.loseNextWriteAnswer();
    await expect(
      executeWrite(connector, EXCEL_TOOLS.update, CHANGE(costs.id), wctx),
    ).rejects.toThrow(/\(504\)/);
    const retry = await executeWrite(connector, EXCEL_TOOLS.update, CHANGE(costs.id), wctx);
    expect(retry.output).toMatchObject({ alreadyDone: true, updatedCells: 0 });
    expect(patches(excel)).toHaveLength(1);
  });

  it("doesn't take a formula for text it wrote", async () => {
    const { connector, excel, ctx, costs } = await setup();
    excel.edit(costs.id, "Costs", 3, 3, { formula: "=1+1", value: 2 });
    const done = await executeWrite(connector, EXCEL_TOOLS.update, CHANGE(costs.id), ctx);
    expect(done.output).toMatchObject({ alreadyDone: false, updatedCells: 2 });
    expect(excel.cells(costs.id)[2]?.[2]).toBe("'=1+1");
  });

  it("keeps a null cell as it is, and refuses a shape that doesn't fit the range", async () => {
    const { connector, excel, ctx, costs } = await setup();
    await executeWrite(
      connector,
      EXCEL_TOOLS.update,
      { workbookId: costs.id, range: "B2:C2", values: [[null, 1]] },
      ctx,
    );
    expect(excel.cells(costs.id)[1]).toEqual(["Oct 1", "Hardwood Supply", 1]);
    for (const input of [
      { workbookId: costs.id, range: "B2:C2", values: [[1]] },
      { workbookId: costs.id, range: "B2:C", values: [[1, 2]] },
      { workbookId: costs.id, range: "A1:Z100", values: [[1]] },
      { workbookId: costs.id, range: "XFD1:XFE1", values: [[1, 2]] },
    ]) {
      await expect(executeWrite(connector, EXCEL_TOOLS.update, input, ctx)).rejects.toBeInstanceOf(
        ToolCallError,
      );
    }
  });

  it("gives the undo that puts back what it replaced, unless a cell held a formula", async () => {
    const { connector, excel, ctx, costs } = await setup();
    const input = {
      workbookId: costs.id,
      range: "B2:C3",
      values: [
        [null, 1],
        ["", 2],
      ],
    };
    const { before } = await captureBefore(connector, EXCEL_TOOLS.update, input, ctx);
    const parsed = { ...input, sheet: undefined } as Parameters<typeof excelRestoreInput>[0];
    const restore = excelRestoreInput(parsed, before as Parameters<typeof excelRestoreInput>[1]);
    expect(restore).toEqual({
      workbookId: costs.id,
      sheet: "Costs",
      range: "B2:C3",
      values: [
        [null, 412.5],
        ["Edge Banding Co", 88],
      ],
    });
    excel.edit(costs.id, "Costs", 3, 3, { formula: "=C2*2", value: 825 });
    const withFormula = await captureBefore(connector, EXCEL_TOOLS.update, input, ctx);
    expect(
      excelRestoreInput(parsed, withFormula.before as Parameters<typeof excelRestoreInput>[1]),
    ).toBeNull();
    expect(excelRestoreInput(parsed, null)).toBeNull();
  });
});

describe("Excel's cells and names", () => {
  it("prefixes every text so Excel stores it as given", () => {
    expect(excelValue("plain")).toBe("'plain");
    expect(excelValue("=1+1")).toBe("''=1+1");
    expect(excelValue("-12.5")).toBe("'-12.5");
    expect(excelValue("")).toBe("");
    expect(excelValue(3)).toBe(3);
    expect(excelValue(false)).toBe(false);
    expect(excelValue(null)).toBeNull();
    expect(excelHolds("'=1+1", "=1+1")).toBe(true);
    expect(excelHolds("=1+1", "=1+1")).toBe(false);
    expect(excelHolds("12.5", "12.5")).toBe(true);
    expect(excelHolds("", "")).toBe(true);
    expect(excelHolds("x", null)).toBe(true);
    expect(excelHolds(null, "x")).toBe(false);
  });

  it("checks worksheet names, item ids and the .xlsx type", () => {
    expect(worksheetNameProblem("Costs 2026")).toBeNull();
    expect(worksheetNameProblem("Bob's")).toBeNull();
    for (const bad of ["", "a:b", "a[1]", "x".repeat(32), "'a", "a'", "a\tb"]) {
      expect(worksheetNameProblem(bad), bad).not.toBeNull();
    }
    expect(isExcelItemId("D4648F06C91D9D3D!54927")).toBe(true);
    expect(isExcelItemId("01BYE5RZ6QN3ZWBTUFOFD3GSPGOHDJD36K")).toBe(true);
    for (const bad of ["ab", "a/b", "a b", "a'b", "a%21b", "x".repeat(201)]) {
      expect(isExcelItemId(bad), bad).toBe(false);
    }
    expect(isExcelWorkbookFile("Costs.XLSX", EXCEL_XLSX_MIME)).toBe(true);
    expect(isExcelWorkbookFile("Costs.xlsx", undefined)).toBe(true);
    expect(isExcelWorkbookFile("Costs.xlsm", undefined)).toBe(false);
    expect(isExcelWorkbookFile("Costs.xlsx", "text/csv")).toBe(false);
    expect(isExcelWorkbookFile(".xlsx", EXCEL_XLSX_MIME)).toBe(false);
  });
});
