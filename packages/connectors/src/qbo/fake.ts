// A fake QuickBooks Online for tests (re-exported by @countersign/connectors/testing; never imported
// by the Worker): Intuit's token and revoke endpoints and one sandbox company that starts from
// fixtures/qbo. It answers queries, reads, sparse updates (SyncToken checked and bumped, totals
// recomputed, request ids replayed), CDC, attachment upload and download, and can be told to
// expire tokens or throttle. Shapes follow what we know of QBO (NOTES.md lists what is unchecked),
// so a mistake there is a mistake here too.

import { dec } from "@countersign/core";
import companyInfo from "../../../../fixtures/qbo/company-info.json";
import faultStale from "../../../../fixtures/qbo/fault-stale.json";
import faultThrottle from "../../../../fixtures/qbo/fault-throttle.json";
import faultUnauthorized from "../../../../fixtures/qbo/fault-unauthorized.json";
import accounts from "../../../../fixtures/qbo/query-account.json";
import attachables from "../../../../fixtures/qbo/query-attachable.json";
import bills from "../../../../fixtures/qbo/query-bill.json";
import customers from "../../../../fixtures/qbo/query-customer.json";
import invoices from "../../../../fixtures/qbo/query-invoice.json";
import items from "../../../../fixtures/qbo/query-item.json";
import payments from "../../../../fixtures/qbo/query-payment.json";
import purchases from "../../../../fixtures/qbo/query-purchase.json";
import vendors from "../../../../fixtures/qbo/query-vendor.json";
import credits from "../../../../fixtures/qbo/query-vendorcredit.json";
import agedReceivables from "../../../../fixtures/qbo/report-aged-receivable-detail.json";
import tokenCode from "../../../../fixtures/qbo/token-authorization-code.json";
import tokenInvalid from "../../../../fixtures/qbo/token-invalid-grant.json";
import tokenRefresh from "../../../../fixtures/qbo/token-refresh.json";
import type { HttpResponseLike } from "../http";
import { formDecode, parseUrl } from "../http";
import { fromBase64, fromUtf8, utf8 } from "../runtime";
import {
  QBO_API_BASE,
  QBO_REVOKE_URL,
  QBO_TOKEN_URL,
  type QboFetch,
  type QboRequestInit,
} from "./api";

export const FAKE_QBO_REALM = "9130357766900456";
export const FAKE_QBO_CLIENT = { clientId: "ABfakeClientId", clientSecret: "fake-client-secret" };
const FILES = "https://qbo-files.fake.example";

export const QBO_FIXTURES = {
  tokenCode,
  tokenRefresh,
  tokenInvalid,
  companyInfo,
  bills,
  purchases,
  credits,
  vendors,
  items,
  attachables,
  // v0.12 W1-F
  customers,
  invoices,
  payments,
  accounts,
  agedReceivables,
  faultStale,
  faultUnauthorized,
  faultThrottle,
} as const;

type Entity = Record<string, unknown> & { Id: string; SyncToken?: string };

export interface FakeQboRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** Text bodies as they were; multipart bodies as their length. */
  body: string | null;
}

function response(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
  bytes?: Uint8Array,
): HttpResponseLike {
  const text = typeof body === "string" ? body : body === undefined ? "" : JSON.stringify(body);
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (n) => h[n.toLowerCase()] ?? null },
    text: async () => text,
    arrayBuffer: async () => {
      const b = bytes ?? utf8(text);
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    },
  };
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Resolves a QBO query field against a record: case-insensitive keys, any element of arrays. */
function values(record: unknown, path: string[]): unknown[] {
  if (path.length === 0) {
    if (record && typeof record === "object" && "value" in (record as object)) {
      return [(record as { value: unknown }).value];
    }
    return [record];
  }
  if (Array.isArray(record)) return record.flatMap((r) => values(r, path));
  if (!record || typeof record !== "object") return [];
  const [head, ...rest] = path as [string, ...string[]];
  const key = Object.keys(record).find((k) => k.toLowerCase() === head.toLowerCase());
  return key === undefined ? [] : values((record as Record<string, unknown>)[key], rest);
}

function compare(a: unknown, b: string): number {
  const s = String(a);
  if (/^\d{4}-\d{2}-\d{2}T/.test(s) && /^\d{4}-\d{2}-\d{2}T/.test(b)) {
    return Date.parse(s) - Date.parse(b);
  }
  if (/^-?\d+(\.\d+)?$/.test(s) && /^-?\d+(\.\d+)?$/.test(b) && !/^\d{4}-/.test(b)) {
    return Number(s) - Number(b);
  }
  return s < b ? -1 : s > b ? 1 : 0;
}

function unquote(v: string): string {
  return v.trim().replace(/^'|'$/g, "").replace(/\\'/g, "'").replace(/\\\\/g, "\\");
}

/** Splits on ` and ` outside quotes. */
function splitAnd(where: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < where.length; i++) {
    const ch = where[i] as string;
    if (ch === "\\" && quoted) {
      cur += ch + (where[i + 1] ?? "");
      i++;
      continue;
    }
    if (ch === "'") quoted = !quoted;
    if (!quoted && where.slice(i, i + 5).toLowerCase() === " and ") {
      out.push(cur);
      cur = "";
      i += 4;
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

function matches(record: Entity, cond: string): boolean {
  const m = /^([\w.]+)\s+(=|>=|<=|>|<|like|in)\s+(.+)$/i.exec(cond);
  if (!m) throw new Error(`fake QBO can't read the condition: ${cond}`);
  const [, field, opRaw, rhs] = m as unknown as [string, string, string, string];
  const op = opRaw.toLowerCase();
  const have = values(record, field.split("."));
  if (op === "in") {
    const list = rhs
      .replace(/^\(|\)$/g, "")
      .split(",")
      .map(unquote);
    return have.some((h) => list.includes(String(h)));
  }
  const want = unquote(rhs);
  return have.some((h) => {
    if (op === "like") {
      const re = new RegExp(
        `^${want.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*")}$`,
        "i",
      );
      return re.test(String(h));
    }
    const c = compare(h, want);
    return op === "="
      ? c === 0 || String(h).toLowerCase() === want.toLowerCase()
      : op === ">="
        ? c >= 0
        : op === "<="
          ? c <= 0
          : op === ">"
            ? c > 0
            : c < 0;
  });
}

const ENTITY_PATHS: Record<string, string> = {
  bill: "Bill",
  purchase: "Purchase",
  vendorcredit: "VendorCredit",
  vendor: "Vendor",
  item: "Item",
  attachable: "Attachable",
  invoice: "Invoice",
  customer: "Customer",
  payment: "Payment",
  account: "Account",
};

export interface FakeQboOptions {
  /** Authorization codes the token endpoint accepts. */
  codes?: string[];
  /** The fake's clock (MetaData times, CDC). */
  now?: () => Date;
}

/** One sandbox company and Intuit's OAuth endpoints, from fixtures. */
export function fakeQbo(opts: FakeQboOptions = {}) {
  const now = opts.now ?? (() => new Date());
  const codes = new Set(opts.codes ?? ["fixture-code"]);
  const requests: FakeQboRequest[] = [];
  const store = new Map<string, Map<string, Entity>>();
  const deleted: { entity: string; id: string; at: string }[] = [];
  const files = new Map<string, Uint8Array>();
  const replies = new Map<string, unknown>();
  let validAccess = new Set<string>();
  let refreshToken: string | null = null;
  const revoked: string[] = [];
  let tokenSerial = 1;
  let throttle = 0;
  let nextId = 1000;
  let nextBillId = 900;
  let lastModified = "";

  function table(entity: string): Map<string, Entity> {
    let t = store.get(entity);
    if (!t) {
      t = new Map();
      store.set(entity, t);
    }
    return t;
  }
  function seed(entity: string, rows: unknown[]) {
    for (const r of rows) table(entity).set(String((r as Entity).Id), clone(r) as Entity);
  }
  seed("Bill", bills.QueryResponse.Bill);
  seed("Purchase", purchases.QueryResponse.Purchase);
  seed("VendorCredit", credits.QueryResponse.VendorCredit);
  seed("Vendor", vendors.QueryResponse.Vendor);
  seed("Item", items.QueryResponse.Item);
  seed("Attachable", attachables.QueryResponse.Attachable);
  seed("Customer", customers.QueryResponse.Customer);
  seed("Invoice", invoices.QueryResponse.Invoice);
  seed("Payment", payments.QueryResponse.Payment);
  seed("Account", accounts.QueryResponse.Account);
  files.set("5000000000000401", utf8("%PDF-1.4\n% Cascade Hardwoods invoice 77812\n%%EOF\n"));

  const stamp = () => {
    // Strictly increasing, so CDC sees every change.
    let t = now().toISOString();
    if (t <= lastModified) t = new Date(Date.parse(lastModified) + 1).toISOString();
    lastModified = t;
    return t;
  };

  function touch(entity: string, row: Entity, created = false) {
    const t = stamp();
    const meta = (row.MetaData ?? {}) as Record<string, unknown>;
    row.MetaData = { ...meta, ...(created ? { CreateTime: t } : {}), LastUpdatedTime: t };
    table(entity).set(row.Id, row);
  }

  function linesTotal(row: Entity): string {
    const lines = Array.isArray(row.Line) ? (row.Line as { Amount?: number }[]) : [];
    return lines.reduce((s, l) => s.plus(dec(String(l.Amount ?? 0))), dec("0")).toString();
  }

  function runQuery(sql: string): Record<string, unknown> {
    const m = /^select \* from (\w+)(.*)$/is.exec(sql.trim());
    if (!m) throw new Error(`fake QBO can't read the query: ${sql}`);
    const entity = m[1] as string;
    let rest = (m[2] as string).trim();
    const take = (re: RegExp) => {
      const hit = re.exec(rest);
      if (!hit) return null;
      rest = rest.replace(hit[0], " ").trim();
      return hit[1] as string;
    };
    const max = Number(take(/maxresults\s+(\d+)/i) ?? "100");
    const start = Number(take(/startposition\s+(\d+)/i) ?? "1");
    const order = take(/orderby\s+(.+)$/i);
    const where = take(/^where\s+(.+)$/i);
    let rows = [...table(entity).values()];
    if (where) for (const c of splitAnd(where)) rows = rows.filter((r) => matches(r, c));
    if (order) {
      const [field = "", dir] = order.trim().split(/\s+/);
      rows.sort((a, b) => {
        const av = String(values(a, field.split("."))[0] ?? "");
        const bv = String(values(b, field.split("."))[0] ?? "");
        const c = compare(av, bv);
        return dir?.toLowerCase() === "desc" ? -c : c;
      });
    }
    const page = rows.slice(start - 1, start - 1 + max).map((r) => clone(r));
    return {
      QueryResponse: page.length
        ? { [entity]: page, startPosition: start, maxResults: page.length }
        : {},
      time: now().toISOString(),
    };
  }

  function update(entity: string, body: Entity): HttpResponseLike {
    const current = table(entity).get(String(body.Id));
    if (!current) {
      return response(400, {
        Fault: { Error: [{ Message: "Object Not Found", code: "610" }], type: "ValidationFault" },
      });
    }
    if (String(body.SyncToken) !== String(current.SyncToken)) return response(400, faultStale);
    if (body.sparse !== true) throw new Error("the fake only takes sparse updates");
    // v0.12 W1-F: the only invoice write is the private note; the fake refuses anything more, so
    // a test proves nothing else is ever sent.
    if (entity === "Invoice") {
      const extra = Object.keys(body).filter(
        (k) => !["Id", "SyncToken", "sparse", "PrivateNote"].includes(k),
      );
      if (extra.length > 0) throw new Error(`an invoice update carried ${extra.join(", ")}`);
    }
    const next: Entity = clone(current);
    for (const [k, v] of Object.entries(body)) {
      if (k === "sparse" || k === "SyncToken" || k === "Id") continue;
      next[k] = clone(v);
    }
    if (Array.isArray(body.Line)) {
      const used = new Set(
        (body.Line as { Id?: string }[]).map((l) => l.Id).filter((x): x is string => Boolean(x)),
      );
      let n = Math.max(0, ...[...used].map(Number)) + 1;
      next.Line = (body.Line as Record<string, unknown>[]).map((l, i) => {
        const line: Record<string, unknown> = { ...l, LineNum: i + 1 };
        if (!line.Id) {
          line.Id = String(n);
          n += 1;
        }
        const d = line.ItemBasedExpenseLineDetail as
          | { Qty?: number; UnitPrice?: number }
          | undefined;
        if (d && d.Qty !== undefined && d.UnitPrice !== undefined) {
          const product = dec(String(d.Qty))
            .times(dec(String(d.UnitPrice)))
            .toDecimalPlaces(2);
          if (!product.equals(dec(String(line.Amount)))) {
            throw new FakeFault(400, "6070", "Amount is not equal to UnitPrice * Qty");
          }
        }
        return line;
      });
      if (entity === "Bill" || entity === "Purchase" || entity === "VendorCredit") {
        next.TotalAmt = Number(linesTotal(next));
        if (entity === "Bill") next.Balance = next.TotalAmt;
      }
    }
    next.SyncToken = String(Number(current.SyncToken ?? "0") + 1);
    touch(entity, next);
    return response(200, { [entity]: clone(next), time: now().toISOString() });
  }

  // v0.12 W1-F: a new bill (POST /bill without an Id): lines checked like an update's, the total
  // and balance computed, the vendor named, a new id and SyncToken 0.
  function createBill(body: Entity & { VendorRef?: { value?: string } }): HttpResponseLike {
    const vendor = table("Vendor").get(String(body.VendorRef?.value ?? ""));
    if (!vendor) {
      return response(400, {
        Fault: {
          Error: [{ Message: "Invalid Reference Id", code: "2500" }],
          type: "ValidationFault",
        },
      });
    }
    const lines = (Array.isArray(body.Line) ? body.Line : []) as Record<string, unknown>[];
    const row: Entity = {
      ...clone(body),
      Id: String(nextBillId++),
      SyncToken: "0",
      domain: "QBO",
      sparse: false,
      VendorRef: { value: vendor.Id, name: vendor.DisplayName },
      CurrencyRef: (body.CurrencyRef as object | undefined) ?? { value: "USD" },
      Line: lines.map((l, i) => {
        const d = l.ItemBasedExpenseLineDetail as { Qty?: number; UnitPrice?: number } | undefined;
        if (d && d.Qty !== undefined && d.UnitPrice !== undefined) {
          const product = dec(String(d.Qty))
            .times(dec(String(d.UnitPrice)))
            .toDecimalPlaces(2);
          if (!product.equals(dec(String(l.Amount)))) {
            throw new FakeFault(400, "6070", "Amount is not equal to UnitPrice * Qty");
          }
        }
        return { ...l, Id: String(i + 1), LineNum: i + 1 };
      }),
    };
    row.TotalAmt = Number(linesTotal(row));
    row.Balance = row.TotalAmt;
    touch("Bill", row, true);
    return response(200, { Bill: clone(row), time: now().toISOString() });
  }

  // v0.12 W1-F: QuickBooks' AgedReceivableDetail, built from the company's invoices in the shape
  // of fixtures/qbo/report-aged-receivable-detail.json (sections by how far past due).
  function agedReceivableDetail(query: Record<string, string>): HttpResponseLike {
    const asOf = query.report_date ?? now().toISOString().slice(0, 10);
    const sections: [string, (days: number) => boolean][] = [
      ["Current", (d) => d <= 0],
      ["1 - 30 days past due", (d) => d >= 1 && d <= 30],
      ["31 - 60 days past due", (d) => d >= 31 && d <= 60],
      ["61 - 90 days past due", (d) => d >= 61 && d <= 90],
      ["91 or more days past due", (d) => d >= 91],
    ];
    const open = [...table("Invoice").values()].filter((inv) => {
      const balance = dec(String(inv.Balance ?? 0));
      const customer = (inv.CustomerRef as { value?: string } | undefined)?.value;
      return (
        balance.greaterThan(0) &&
        String(inv.TxnDate ?? "") <= asOf &&
        (!query.customer || customer === query.customer)
      );
    });
    const money = (v: unknown) => dec(String(v ?? 0)).toFixed(2);
    const blank = (title: string) => [
      { value: title },
      ...Array.from({ length: 6 }, () => ({ value: "" })),
    ];
    const rows = sections.flatMap(([title, inBucket]) => {
      const here = open.filter((inv) => {
        const due = String(inv.DueDate ?? inv.TxnDate ?? asOf);
        return inBucket(Math.round((Date.parse(asOf) - Date.parse(due)) / 86_400_000));
      });
      if (here.length === 0) return [];
      return [
        {
          Header: { ColData: blank(title) },
          Rows: {
            Row: here.map((inv) => {
              const c = inv.CustomerRef as { value: string; name?: string };
              return {
                ColData: [
                  { value: String(inv.TxnDate ?? "") },
                  { value: "Invoice", id: inv.Id },
                  { value: String(inv.DocNumber ?? "") },
                  { value: c.name ?? "", id: c.value },
                  { value: String(inv.DueDate ?? "") },
                  { value: money(inv.TotalAmt) },
                  { value: money(inv.Balance) },
                ],
                type: "Data",
              };
            }),
          },
          Summary: { ColData: blank(`Total for ${title}`) },
          type: "Section",
        },
      ];
    });
    return response(200, {
      Header: { ...agedReceivables.Header, StartPeriod: asOf, EndPeriod: asOf },
      Columns: agedReceivables.Columns,
      Rows: {
        Row: [
          ...rows,
          { Summary: { ColData: blank("TOTAL") }, type: "Section", group: "GrandTotal" },
        ],
      },
    });
  }

  function upload(contentType: string, body: Uint8Array): HttpResponseLike {
    const boundary = /boundary=([^;]+)/.exec(contentType)?.[1];
    if (!boundary)
      return response(400, { Fault: { Error: [{ Message: "no boundary", code: "2" }] } });
    const latin = Array.from(body, (b) => String.fromCharCode(b)).join("");
    const parts = latin.split(`--${boundary}`).slice(1, -1);
    let metadata: Record<string, unknown> | null = null;
    let file: Uint8Array | null = null;
    let fileName = "";
    let fileType = "";
    for (const part of parts) {
      const split = part.indexOf("\r\n\r\n");
      const head = part.slice(0, split);
      const content = part.slice(split + 4, part.length - 2);
      if (/name="file_metadata_0"/.test(head)) {
        metadata = JSON.parse(fromUtf8(Uint8Array.from(content, (c) => c.charCodeAt(0))));
      } else if (/name="file_content_0"/.test(head)) {
        file = Uint8Array.from(content, (c) => c.charCodeAt(0));
        fileName = /filename="([^"]*)"/.exec(head)?.[1] ?? "";
        fileType = /Content-Type:\s*(.+)/i.exec(head)?.[1]?.trim() ?? "";
      }
    }
    if (!metadata || !file) {
      return response(400, { Fault: { Error: [{ Message: "missing parts", code: "2" }] } });
    }
    const id = `50000000000${String(nextId++).padStart(5, "0")}`;
    const row: Entity = {
      Id: id,
      SyncToken: "0",
      domain: "QBO",
      sparse: false,
      FileName: (metadata.FileName as string | undefined) ?? fileName,
      ContentType: (metadata.ContentType as string | undefined) ?? fileType,
      Size: file.length,
      AttachableRef: metadata.AttachableRef,
      ...(metadata.Note ? { Note: metadata.Note } : {}),
    };
    touch("Attachable", row, true);
    files.set(id, file);
    return response(200, {
      AttachableResponse: [{ Attachable: clone(row) }],
      time: now().toISOString(),
    });
  }

  function cdc(query: Record<string, string>): HttpResponseLike {
    const since = query.changedSince ?? "";
    const entities = (query.entities ?? "").split(",").filter(Boolean);
    const blocks = entities.map((entity) => {
      const changed = [...table(entity).values()].filter(
        (r) => compare(values(r, ["MetaData", "LastUpdatedTime"])[0], since) >= 0,
      );
      const gone = deleted
        .filter((d) => d.entity === entity && compare(d.at, since) >= 0)
        .map((d) => ({
          domain: "QBO",
          status: "Deleted",
          Id: d.id,
          MetaData: { LastUpdatedTime: d.at },
        }));
      const rows = [...changed.map(clone), ...gone];
      return rows.length ? { [entity]: rows, startPosition: 1, maxResults: rows.length } : {};
    });
    return response(200, { CDCResponse: [{ QueryResponse: blocks }], time: now().toISOString() });
  }

  function issue(answer: { access_token: string; refresh_token: string }): unknown {
    validAccess.add(answer.access_token);
    refreshToken = answer.refresh_token;
    return answer;
  }

  function basicOk(headers: Record<string, string>): boolean {
    const auth = headers.authorization ?? "";
    if (!auth.startsWith("Basic ")) return false;
    const [id, secret] = fromUtf8(fromBase64(auth.slice(6))).split(":");
    return id === FAKE_QBO_CLIENT.clientId && secret === FAKE_QBO_CLIENT.clientSecret;
  }

  const doFetch: QboFetch = async (rawUrl: string, init: QboRequestInit = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(
      Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    requests.push({
      url: rawUrl,
      method,
      headers,
      body:
        init.body === undefined
          ? null
          : typeof init.body === "string"
            ? init.body
            : `<${init.body.length} bytes>`,
    });
    try {
      if (rawUrl === QBO_TOKEN_URL) {
        if (!basicOk(headers)) return response(401, { error: "invalid_client" });
        const form = formDecode(typeof init.body === "string" ? init.body : "");
        if (form.grant_type === "authorization_code") {
          if (!form.code || !codes.has(form.code) || !form.redirect_uri) {
            return response(400, tokenInvalid);
          }
          codes.delete(form.code);
          return response(200, issue(tokenCode));
        }
        if (form.grant_type === "refresh_token") {
          if (
            !refreshToken ||
            form.refresh_token !== refreshToken ||
            revoked.includes(form.refresh_token)
          ) {
            return response(400, tokenInvalid);
          }
          tokenSerial += 1;
          const answer =
            tokenSerial === 2
              ? tokenRefresh
              : {
                  ...tokenRefresh,
                  access_token: `${tokenRefresh.access_token}-${tokenSerial}`,
                  refresh_token: `${tokenRefresh.refresh_token}-${tokenSerial}`,
                };
          return response(200, issue(answer));
        }
        return response(400, { error: "unsupported_grant_type" });
      }
      if (rawUrl === QBO_REVOKE_URL) {
        if (!basicOk(headers)) return response(401, { error: "invalid_client" });
        const { token } = JSON.parse(typeof init.body === "string" ? init.body : "{}") as {
          token?: string;
        };
        if (token) revoked.push(token);
        if (token === refreshToken) {
          refreshToken = null;
          validAccess = new Set();
        }
        return response(200, "");
      }
      if (rawUrl.startsWith(`${FILES}/`)) {
        const id = rawUrl.slice(FILES.length + 1).split("?")[0] ?? "";
        const bytes = files.get(id);
        if (!bytes) return response(404, "not found");
        const row = table("Attachable").get(id);
        return response(
          200,
          "",
          { "content-type": String(row?.ContentType ?? "application/pdf") },
          bytes,
        );
      }
      const url = parseUrl(rawUrl);
      const base = `${QBO_API_BASE.sandbox}/v3/company/`;
      if (!url || !rawUrl.startsWith(base)) return response(404, "unknown host");
      const token = (headers.authorization ?? "").replace(/^Bearer /, "");
      if (!validAccess.has(token)) return response(401, faultUnauthorized);
      if (throttle > 0) {
        throttle -= 1;
        return response(429, faultThrottle, { "retry-after": "1" });
      }
      const [realm, ...segments] = url.pathname.slice("/v3/company/".length).split("/");
      if (realm !== FAKE_QBO_REALM) return response(403, { Fault: { Error: [{ code: "100" }] } });
      const query = formDecode(rawUrl.split("?")[1] ?? "");
      if (!query.minorversion) throw new Error("every call sends a minor version");
      const [first = "", second] = segments.map(decodeURIComponent);
      const requestId = query.requestid;
      if (requestId && replies.has(requestId)) {
        return replies.get(requestId) as HttpResponseLike;
      }
      let res: HttpResponseLike;
      if (method === "GET" && first === "companyinfo") res = response(200, companyInfo);
      else if (method === "GET" && first === "query")
        res = response(200, runQuery(query.query ?? ""));
      else if (method === "GET" && first === "cdc") res = cdc(query);
      else if (method === "GET" && first === "reports" && second === "AgedReceivableDetail") {
        res = agedReceivableDetail(query);
      } else if (method === "GET" && first === "download" && second) {
        res = files.has(second)
          ? response(200, `${FILES}/${second}?X-Amz-Signature=fake`, {
              "content-type": "text/plain",
            })
          : response(400, { Fault: { Error: [{ Message: "Object Not Found", code: "610" }] } });
      } else if (method === "GET" && ENTITY_PATHS[first] && second) {
        const entity = ENTITY_PATHS[first] as string;
        const row = table(entity).get(second);
        res = row
          ? response(200, { [entity]: clone(row), time: now().toISOString() })
          : response(400, { Fault: { Error: [{ Message: "Object Not Found", code: "610" }] } });
      } else if (method === "POST" && first === "upload") {
        res = upload(headers["content-type"] ?? "", init.body as Uint8Array);
      } else if (method === "POST" && ENTITY_PATHS[first] && !second) {
        const body = JSON.parse(init.body as string) as Entity;
        res =
          first === "bill" && body.Id === undefined
            ? createBill(body)
            : update(ENTITY_PATHS[first] as string, body);
      } else {
        res = response(404, { Fault: { Error: [{ Message: `no route ${method} ${first}` }] } });
      }
      if (requestId && res.ok) replies.set(requestId, res);
      return res;
    } catch (error) {
      if (error instanceof FakeFault) {
        return response(error.status, {
          Fault: { Error: [{ Message: error.message, code: error.code }], type: "ValidationFault" },
        });
      }
      throw error;
    }
  };

  return {
    fetch: doFetch,
    requests,
    /** Calls to the company API (not OAuth), optionally by method and path segment. */
    apiCalls(method?: string, segment?: string) {
      return requests.filter(
        (r) =>
          r.url.startsWith(QBO_API_BASE.sandbox) &&
          (method === undefined || r.method === method) &&
          (segment === undefined || r.url.includes(`/${segment}`)),
      );
    },
    get(entity: string, id: string): Entity | undefined {
      const r = table(entity).get(id);
      return r ? clone(r) : undefined;
    },
    /** Someone changes a record in QuickBooks (its SyncToken moves on). */
    put(entity: string, row: Entity, created = !table(entity).has(row.Id)) {
      touch(entity, clone(row), created);
    },
    /**
     * A customer pays an invoice in QuickBooks (v0.12 W1-F): a new Payment linked to it, and the
     * invoice's balance goes down by the amount (a new SyncToken), as QuickBooks does.
     */
    receivePayment(invoiceId: string, amount: string): string {
      const inv = table("Invoice").get(invoiceId);
      if (!inv) throw new Error(`no invoice ${invoiceId}`);
      const paymentId = String(600 + table("Payment").size);
      touch(
        "Payment",
        {
          Id: paymentId,
          SyncToken: "0",
          domain: "QBO",
          sparse: false,
          TxnDate: now().toISOString().slice(0, 10),
          CustomerRef: clone(inv.CustomerRef),
          CurrencyRef: clone(inv.CurrencyRef ?? { value: "USD" }),
          TotalAmt: Number(amount),
          UnappliedAmt: 0,
          Line: [{ Amount: Number(amount), LinkedTxn: [{ TxnId: invoiceId, TxnType: "Invoice" }] }],
        },
        true,
      );
      const next = clone(inv);
      next.Balance = Number(
        dec(String(inv.Balance ?? 0))
          .minus(dec(amount))
          .toString(),
      );
      next.SyncToken = String(Number(inv.SyncToken ?? "0") + 1);
      touch("Invoice", next);
      return paymentId;
    },
    remove(entity: string, id: string) {
      table(entity).delete(id);
      deleted.push({ entity, id, at: stamp() });
    },
    /** Someone attaches a file to a record in QuickBooks; answers the attachable's id. */
    attachFile(
      entity: string,
      id: string,
      file: { fileName: string; bytes: Uint8Array; contentType: string },
    ) {
      const attachableId = `50000000000${String(nextId++).padStart(5, "0")}`;
      touch(
        "Attachable",
        {
          Id: attachableId,
          SyncToken: "0",
          domain: "QBO",
          sparse: false,
          FileName: file.fileName,
          ContentType: file.contentType,
          Size: file.bytes.length,
          AttachableRef: [{ EntityRef: { type: entity, value: id }, IncludeOnSend: false }],
        },
        true,
      );
      files.set(attachableId, file.bytes);
      return attachableId;
    },
    fileOf(attachableId: string): Uint8Array | undefined {
      return files.get(attachableId);
    },
    /** The access tokens stop working (they expired); a refresh brings a new one. */
    expireAccessTokens() {
      validAccess = new Set();
    },
    /** The next `n` company API calls answer 429. */
    throttleNext(n: number) {
      throttle = n;
    },
    revoked,
    get refreshToken() {
      return refreshToken;
    },
  };
}

class FakeFault extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type FakeQbo = ReturnType<typeof fakeQbo>;
