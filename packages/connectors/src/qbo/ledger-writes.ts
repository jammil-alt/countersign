// The ledger's set-up in QuickBooks (docs/plan.md §1.79, owner 2026-11-08: "full control, always
// behind an approval gate"): create and change accounts, classes and locations (QuickBooks'
// Department). Every one is `approval: "always"`: a person signs each change, whatever a step, the
// client's matrix or the agent's mode says (core `isAlwaysSigned`; workflow validation refuses a
// step set to run without one). Nothing is deleted: QuickBooks makes an account, class or location
// inactive, which is an update here.
//
// A change names the version it was read at (`syncToken`) and is refused when QuickBooks moved on
// since; a retried write that finds its change already there reports it done. A new name already
// in use (under the same parent) is refused before anyone is asked.

import { CurrencyCode, type ToolDisplay } from "@countersign/core";
import { z } from "zod";
import { defineWriteTool, type ToolContext, type ToolDefinition } from "../connector";
import { QboApiError, type QboClient, qboLiteral, qboRequestId } from "./api";
import { QboId, SyncToken } from "./records";
import { type ClientFor, notFound, stale } from "./tool-kit";

export const LEDGER_WRITE_TOOLS = {
  accountCreate: "qbo.account.create",
  accountUpdate: "qbo.account.update",
  classCreate: "qbo.class.create",
  classUpdate: "qbo.class.update",
  locationCreate: "qbo.location.create",
  locationUpdate: "qbo.location.update",
} as const;

/** R5: the update that takes back each create (it makes the new record inactive). */
const REVERSED_BY: Partial<Record<string, string>> = {
  [LEDGER_WRITE_TOOLS.accountCreate]: LEDGER_WRITE_TOOLS.accountUpdate,
  [LEDGER_WRITE_TOOLS.classCreate]: LEDGER_WRITE_TOOLS.classUpdate,
  [LEDGER_WRITE_TOOLS.locationCreate]: LEDGER_WRITE_TOOLS.locationUpdate,
};

/** QuickBooks' account types, as a new account or a change of type names them. */
export const QBO_ACCOUNT_TYPES = [
  "Bank",
  "Other Current Asset",
  "Fixed Asset",
  "Other Asset",
  "Accounts Receivable",
  "Equity",
  "Expense",
  "Other Expense",
  "Cost of Goods Sold",
  "Accounts Payable",
  "Credit Card",
  "Long Term Liability",
  "Other Current Liability",
  "Income",
  "Other Income",
] as const;

// UNCHECKED (NOTES.md): QuickBooks' limits on a name (100 characters, no colon or double quote)
// and on an account's description (100 characters).
const Name = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((v) => !/[:"]/.test(v), "a name can't contain a colon or a double quote");
const Description = z.string().trim().max(100);
const AcctNum = z.string().trim().min(1).max(20);

type LedgerEntity = "Account" | "Class" | "Department";

const PATH: Record<LedgerEntity, string> = {
  Account: "/account",
  Class: "/class",
  Department: "/department",
};
const WORD: Record<LedgerEntity, string> = {
  Account: "account",
  Class: "class",
  Department: "location",
};
const A: Record<LedgerEntity, string> = { Account: "an", Class: "a", Department: "a" };

const RawRow = z.looseObject({
  Id: z.union([z.string(), z.number()]).transform(String),
  SyncToken: z.union([z.string(), z.number()]).transform(String).optional(),
  Name: z.string(),
  FullyQualifiedName: z.string().optional(),
  AcctNum: z.string().optional(),
  Description: z.string().optional(),
  AccountType: z.string().optional(),
  AccountSubType: z.string().optional(),
  ParentRef: z
    .looseObject({ value: z.union([z.string(), z.number()]).transform(String) })
    .optional(),
  Active: z.boolean().optional(),
});

/** One account, class or location as a change reads it (its before state). */
const Current = z.object({
  id: z.string(),
  syncToken: z.string(),
  name: z.string(),
  fullName: z.string(),
  number: z.string().nullable(),
  description: z.string().nullable(),
  accountType: z.string().nullable(),
  accountSubType: z.string().nullable(),
  parent: z.object({ id: z.string(), name: z.string() }).nullable(),
  active: z.boolean(),
});
type Current = z.infer<typeof Current>;

async function readRow(client: QboClient, entity: LedgerEntity, id: string) {
  const raw = await client.read(entity, id);
  if (!raw) return null;
  return RawRow.parse(raw);
}

async function current(
  client: QboClient,
  entity: LedgerEntity,
  id: string,
): Promise<Current | null> {
  const r = await readRow(client, entity, id);
  if (!r) return null;
  const parent = r.ParentRef ? await readRow(client, entity, r.ParentRef.value) : null;
  return {
    id: r.Id,
    syncToken: r.SyncToken ?? "0",
    name: r.Name,
    fullName: r.FullyQualifiedName ?? r.Name,
    number: r.AcctNum ?? null,
    description: r.Description ?? null,
    accountType: r.AccountType ?? null,
    accountSubType: r.AccountSubType ?? null,
    parent: parent ? { id: parent.Id, name: parent.FullyQualifiedName ?? parent.Name } : null,
    active: r.Active !== false,
  };
}

/** A parent the change names: the company's, active, of the same kind (and, for an account, type). */
async function parentOf(
  client: QboClient,
  entity: LedgerEntity,
  id: string | null | undefined,
  self?: string,
): Promise<{ id: string; name: string; accountType: string | null } | null> {
  if (!id) return null;
  if (id === self) {
    throw new QboApiError(
      422,
      "OWN_PARENT",
      `${A[entity]} ${WORD[entity]} can't be its own parent`,
      false,
    );
  }
  const p = await readRow(client, entity, id);
  if (!p || p.Active === false) {
    throw new QboApiError(
      422,
      "UNKNOWN_PARENT",
      `${WORD[entity]} ${id} isn't one of this company's active ${WORD[entity]}s`,
      false,
    );
  }
  return { id: p.Id, name: p.FullyQualifiedName ?? p.Name, accountType: p.AccountType ?? null };
}

/** The same name under the same parent, already in use (QuickBooks answers 6240 otherwise). */
async function nameTaken(
  client: QboClient,
  entity: LedgerEntity,
  name: string,
  parentId: string | null,
  except?: string,
): Promise<{ id: string; accountType: string | null } | null> {
  // UNCHECKED (NOTES.md): `Name =` on Account, Class and Department, inactive ones included.
  const { rows } = await client.query(
    `select * from ${entity} where Name = ${qboLiteral(name)} and Active in (true, false) maxresults 100`,
    entity,
  );
  for (const raw of rows) {
    const r = RawRow.safeParse(raw);
    if (!r.success || r.data.Id === except) continue;
    const sameParent = (r.data.ParentRef?.value ?? null) === parentId;
    if (sameParent && r.data.Name.trim().toLowerCase() === name.trim().toLowerCase()) {
      return { id: r.data.Id, accountType: r.data.AccountType ?? null };
    }
  }
  return null;
}

function duplicate(entity: LedgerEntity, name: string, id: string): QboApiError {
  return new QboApiError(
    409,
    "DUPLICATE_NAME",
    `there is already ${A[entity]} ${WORD[entity]} named ${name} in QuickBooks (${id})`,
    false,
  );
}

const Created = z.object({
  id: z.string(),
  syncToken: z.string(),
  name: z.string(),
  fullName: z.string(),
  alreadyDone: z.boolean(),
});

function created(answer: unknown, entity: LedgerEntity, alreadyDone: boolean) {
  const r = RawRow.parse((answer as Record<string, unknown>)[entity] ?? answer);
  return {
    id: r.Id,
    syncToken: r.SyncToken ?? "0",
    name: r.Name,
    fullName: r.FullyQualifiedName ?? r.Name,
    alreadyDone,
  };
}

// ── Approval cards ───────────────────────────────────────────────────────────────────────────────

const L = (en: string, es: string, fr: string, pt: string, it: string, de: string) => ({
  en,
  es,
  fr,
  "pt-BR": pt,
  it,
  de,
});

const W = {
  account: L(
    "QuickBooks account",
    "Cuenta de QuickBooks",
    "Compte QuickBooks",
    "Conta do QuickBooks",
    "Conto QuickBooks",
    "QuickBooks-Konto",
  ),
  class: L(
    "QuickBooks class",
    "Clase de QuickBooks",
    "Classe QuickBooks",
    "Classe do QuickBooks",
    "Classe QuickBooks",
    "QuickBooks-Klasse",
  ),
  location: L(
    "QuickBooks location",
    "Ubicación de QuickBooks",
    "Emplacement QuickBooks",
    "Local do QuickBooks",
    "Sede QuickBooks",
    "QuickBooks-Standort",
  ),
  name: L("Name", "Nombre", "Nom", "Nome", "Nome", "Name"),
  type: L("Type", "Tipo", "Type", "Tipo", "Tipo", "Typ"),
  subType: L(
    "Detail type",
    "Tipo de detalle",
    "Type de détail",
    "Tipo de detalhe",
    "Tipo di dettaglio",
    "Detailtyp",
  ),
  number: L("Number", "Número", "Numéro", "Número", "Numero", "Nummer"),
  description: L(
    "Description",
    "Descripción",
    "Description",
    "Descrição",
    "Descrizione",
    "Beschreibung",
  ),
  parent: L("Under", "Dentro de", "Sous", "Dentro de", "Sotto", "Unter"),
  active: L("Active", "Activa", "Active", "Ativa", "Attivo", "Aktiv"),
  create: L(
    "Add this to the company's books in QuickBooks. Nothing else changes.",
    "Añade esto a la contabilidad de la empresa en QuickBooks. Nada más cambia.",
    "Ajoute ceci à la comptabilité de l'entreprise dans QuickBooks. Rien d'autre ne change.",
    "Adiciona isto à contabilidade da empresa no QuickBooks. Nada mais muda.",
    "Aggiunge questo alla contabilità dell'azienda in QuickBooks. Nient'altro cambia.",
    "Fügt dies der Buchhaltung der Firma in QuickBooks hinzu. Sonst ändert sich nichts.",
  ),
  update: L(
    "Change this in the company's books in QuickBooks. It applies to everything already booked there.",
    "Cambia esto en la contabilidad de la empresa en QuickBooks. Se aplica a todo lo ya registrado.",
    "Modifie ceci dans la comptabilité de l'entreprise dans QuickBooks. Cela s'applique à tout ce qui y est déjà enregistré.",
    "Altera isto na contabilidade da empresa no QuickBooks. Vale para tudo o que já foi lançado.",
    "Modifica questo nella contabilità dell'azienda in QuickBooks. Vale per tutto ciò che è già registrato.",
    "Ändert dies in der Buchhaltung der Firma in QuickBooks. Es gilt für alles, was dort schon gebucht ist.",
  ),
};

function createDisplay(entity: LedgerEntity): ToolDisplay {
  const isAccount = entity === "Account";
  return {
    name: entity === "Account" ? W.account : entity === "Class" ? W.class : W.location,
    description: W.create,
    fields: [
      { label: W.name, kind: "text", after: "input.name" },
      ...(isAccount
        ? ([
            { label: W.type, kind: "text", after: "input.accountType" },
            { label: W.subType, kind: "text", after: "input.accountSubType" },
            { label: W.number, kind: "text", after: "input.number" },
            { label: W.description, kind: "text", after: "input.description" },
          ] as const)
        : []),
      { label: W.parent, kind: "ref", after: "before.parent" },
    ],
  };
}

function updateDisplay(entity: LedgerEntity): ToolDisplay {
  const isAccount = entity === "Account";
  return {
    name: entity === "Account" ? W.account : entity === "Class" ? W.class : W.location,
    description: W.update,
    subject: "before.current",
    fields: [
      { label: W.name, kind: "text", now: "before.current.name", after: "input.name" },
      ...(isAccount
        ? ([
            {
              label: W.type,
              kind: "text",
              now: "before.current.accountType",
              after: "input.accountType",
            },
            {
              label: W.subType,
              kind: "text",
              now: "before.current.accountSubType",
              after: "input.accountSubType",
            },
            { label: W.number, kind: "text", now: "before.current.number", after: "input.number" },
            {
              label: W.description,
              kind: "text",
              now: "before.current.description",
              after: "input.description",
            },
          ] as const)
        : []),
      { label: W.parent, kind: "ref", now: "before.current.parent", after: "before.newParent" },
      { label: W.active, kind: "text", now: "before.current.active", after: "input.active" },
    ],
  };
}

// ── Create ───────────────────────────────────────────────────────────────────────────────────────

export const AccountCreateInput = z.object({
  name: Name,
  accountType: z.enum(QBO_ACCOUNT_TYPES),
  /** QuickBooks' detail type (AccountSubType), e.g. `SuppliesMaterials`; its default when absent. */
  accountSubType: z.string().trim().min(1).max(100).optional(),
  number: AcctNum.optional(),
  description: Description.optional(),
  /** A sub-account: the parent's id. */
  parentId: QboId.optional(),
  currency: CurrencyCode.optional(),
});

export const DimensionCreateInput = z.object({
  name: Name,
  parentId: QboId.optional(),
});

function createTool(
  entity: LedgerEntity,
  id: string,
  permissionEntity: string,
  clientFor: ClientFor,
): ToolDefinition {
  const isAccount = entity === "Account";
  const input = isAccount ? AccountCreateInput : DimensionCreateInput;
  type In = z.infer<typeof AccountCreateInput> & z.infer<typeof DimensionCreateInput>;
  const check = async (client: QboClient, i: In, ctx: ToolContext) => {
    const parent = await parentOf(client, entity, i.parentId);
    // QuickBooks keeps a sub-account under a parent of the same type.
    if (isAccount && parent && parent.accountType !== i.accountType) {
      throw new QboApiError(
        422,
        "PARENT_TYPE",
        `a sub-account has its parent's type (${parent.name} is ${parent.accountType})`,
        false,
      );
    }
    // DECISION: a name in use is refused when the change is proposed. When it is written (the
    // action's key), a retry of this same write is QuickBooks' to recognise by its request id
    // (it answers the first result again), and any other write of a name in use is refused by
    // QuickBooks (6240) and turned into the same refusal in `run`.
    if (!("idempotencyKey" in ctx)) {
      const taken = await nameTaken(client, entity, i.name, parent?.id ?? null);
      if (taken) throw duplicate(entity, i.name, taken.id);
    }
    return { parent };
  };
  const reversedBy = REVERSED_BY[id];
  return defineWriteTool({
    id,
    entity: permissionEntity,
    description: isAccount
      ? "Add an account to the company's chart of accounts in QuickBooks: name, type, detail type, number, description, and its parent for a sub-account. Always signed by a person. Refused if the name is already used there."
      : `Add ${A[entity]} ${WORD[entity]} to the company's books in QuickBooks, under a parent if it has one. Always signed by a person. Refused if the name is already used there.`,
    verb: "create",
    approval: "always",
    // R5 DECISION: taken back by making the new record inactive with its update tool (QuickBooks'
    // own "delete" for names, which keeps the record), never by a delete: that stays off.
    undo: reversedBy ? { kind: "reverse", tool: reversedBy } : { kind: "none" },
    summary: `Added the ${WORD[entity]} {{fullName}} in QuickBooks`,
    display: createDisplay(entity),
    input,
    output: Created,
    beforeSchema: z.object({ parent: z.object({ id: z.string(), name: z.string() }).nullable() }),
    async before(i, ctx) {
      const { parent } = await check(await clientFor(ctx), i as In, ctx);
      return { parent: parent ? { id: parent.id, name: parent.name } : null };
    },
    // R5: the update that reverses it makes the new record inactive, at the version the create
    // left it. DECISION: that version is the create's own answer (`syncToken`), so a record
    // anyone changed since is refused by the update as stale and nothing is written; a create's
    // before state (its parent) can't show such a change itself.
    ...(reversedBy
      ? {
          undoInput: ({ output }: { output: z.infer<typeof Created> }) => ({
            id: output.id,
            syncToken: output.syncToken,
            active: false,
          }),
        }
      : {}),
    async run(i, ctx) {
      const client = await clientFor(ctx);
      const v = i as In;
      await check(client, v, ctx);
      const body = {
        Name: v.name,
        ...(v.parentId
          ? { ParentRef: { value: v.parentId }, ...(isAccount ? {} : { SubClass: true }) }
          : {}),
        ...(isAccount
          ? {
              AccountType: v.accountType,
              ...(v.accountSubType ? { AccountSubType: v.accountSubType } : {}),
              ...(v.number ? { AcctNum: v.number } : {}),
              ...(v.description ? { Description: v.description } : {}),
              ...(v.parentId ? { SubAccount: true } : {}),
              ...(v.currency ? { CurrencyRef: { value: v.currency } } : {}),
            }
          : {}),
      };
      ctx.logger.info(`creating ${A[entity]} ${WORD[entity]}`, { entity });
      try {
        const answer = await client.post(PATH[entity], body, {
          requestid: await qboRequestId(ctx.idempotencyKey),
        });
        return created(answer, entity, false);
      } catch (error) {
        // QuickBooks' "Duplicate Name Exists": the name was taken since it was proposed.
        if (error instanceof QboApiError && error.code === "6240") {
          const taken = await nameTaken(client, entity, v.name, v.parentId ?? null);
          throw duplicate(entity, v.name, taken?.id ?? "?");
        }
        throw error;
      }
    },
  });
}

// ── Update ───────────────────────────────────────────────────────────────────────────────────────

const UpdateBase = {
  id: QboId,
  /** The version the change was read at; refused if QuickBooks moved on since. */
  syncToken: SyncToken,
  name: Name.optional(),
  /** A new parent's id, or null to make it top level. */
  parentId: QboId.nullable().optional(),
  /** false makes it inactive (QuickBooks' "delete"); true makes it active again. */
  active: z.boolean().optional(),
};

export const AccountUpdateInput = z
  .object({
    ...UpdateBase,
    accountType: z.enum(QBO_ACCOUNT_TYPES).optional(),
    accountSubType: z.string().trim().min(1).max(100).optional(),
    number: AcctNum.nullable().optional(),
    description: Description.nullable().optional(),
  })
  .refine((v) => Object.keys(v).some((k) => !["id", "syncToken"].includes(k)), "say what changes");

export const DimensionUpdateInput = z
  .object(UpdateBase)
  .refine((v) => Object.keys(v).some((k) => !["id", "syncToken"].includes(k)), "say what changes");

type UpdateIn = z.infer<typeof AccountUpdateInput>;

/** Whether the record already reads as the change asks (a retried write that went through). */
function alreadyAs(c: Current, i: UpdateIn): boolean {
  return (
    (i.name === undefined || c.name === i.name) &&
    (i.parentId === undefined || (c.parent?.id ?? null) === i.parentId) &&
    (i.active === undefined || c.active === i.active) &&
    (i.accountType === undefined || c.accountType === i.accountType) &&
    (i.accountSubType === undefined || c.accountSubType === i.accountSubType) &&
    (i.number === undefined || c.number === i.number) &&
    (i.description === undefined || (c.description ?? null) === i.description)
  );
}

/**
 * R5: the update that puts back what a ledger update changed: each field it set takes its value
 * from before the change, at the version the record is at now (the undo runs only when nobody
 * changed it since our write). Null when a field can't be put back (QuickBooks had no type or
 * detail type to return to) or nothing would change.
 */
export function ledgerRestoreInput(
  input: UpdateIn,
  before: { current: Current } | null,
  now: { current: Current } | null,
): Record<string, unknown> | null {
  if (!before || !now) return null;
  const was = before.current;
  const out: Record<string, unknown> = { id: input.id, syncToken: now.current.syncToken };
  if (input.name !== undefined) out.name = was.name;
  if (input.parentId !== undefined) out.parentId = was.parent?.id ?? null;
  if (input.active !== undefined) out.active = was.active;
  if (input.accountType !== undefined) {
    if (was.accountType === null) return null;
    out.accountType = was.accountType;
  }
  if (input.accountSubType !== undefined) {
    if (was.accountSubType === null) return null;
    out.accountSubType = was.accountSubType;
  }
  if (input.number !== undefined) out.number = was.number;
  if (input.description !== undefined) out.description = was.description;
  return Object.keys(out).length > 2 ? out : null;
}

function updateTool(
  entity: LedgerEntity,
  id: string,
  permissionEntity: string,
  clientFor: ClientFor,
): ToolDefinition {
  const isAccount = entity === "Account";
  const input = isAccount ? AccountUpdateInput : DimensionUpdateInput;
  return defineWriteTool({
    id,
    entity: permissionEntity,
    description: isAccount
      ? "Change an account in the company's chart of accounts in QuickBooks: its name, type, detail type, number, description or parent, or make it inactive (or active again). Name the version you read (syncToken). Always signed by a person; it applies to everything already booked to the account."
      : `Change ${A[entity]} ${WORD[entity]} in the company's books in QuickBooks: its name or parent, or make it inactive (or active again). Name the version you read (syncToken). Always signed by a person.`,
    verb: "update",
    approval: "always",
    // R5: the before state is written back with this tool, if the record hasn't changed since.
    undo: { kind: "restore" },
    summary: `Changed the ${WORD[entity]} {{fullName}} in QuickBooks`,
    display: updateDisplay(entity),
    input,
    output: Created,
    beforeSchema: z.object({
      current: Current,
      newParent: z.object({ id: z.string(), name: z.string() }).nullable(),
    }),
    // R5: the before state is the whole record, not the input's shape (ledgerRestoreInput).
    undoInput: ({ input: i, before, current: now }) =>
      ledgerRestoreInput(i as UpdateIn, before, now),
    async before(raw, ctx) {
      const i = raw as UpdateIn;
      const client = await clientFor(ctx);
      const c = await current(client, entity, i.id);
      if (!c) throw notFound(entity, i.id);
      const parent =
        i.parentId === undefined ? c.parent : await parentOf(client, entity, i.parentId, c.id);
      if (i.name !== undefined || i.parentId !== undefined) {
        const taken = await nameTaken(client, entity, i.name ?? c.name, parent?.id ?? null, c.id);
        if (taken) throw duplicate(entity, i.name ?? c.name, taken.id);
      }
      return { current: c, newParent: parent ? { id: parent.id, name: parent.name } : null };
    },
    async run(raw, ctx) {
      const i = raw as UpdateIn;
      const client = await clientFor(ctx);
      const c = await current(client, entity, i.id);
      if (!c) throw notFound(entity, i.id);
      if (alreadyAs(c, i)) {
        return {
          id: c.id,
          syncToken: c.syncToken,
          name: c.name,
          fullName: c.fullName,
          alreadyDone: true,
        };
      }
      if (c.syncToken !== i.syncToken) throw stale(entity, i.id, i.syncToken, c.syncToken);
      if (i.parentId) await parentOf(client, entity, i.parentId, c.id);
      // UNCHECKED (NOTES.md): a sparse update needs Name (sent unchanged when it isn't changing),
      // and SubAccount/SubClass false with no ParentRef to make one top level.
      const body: Record<string, unknown> = {
        Id: c.id,
        SyncToken: c.syncToken,
        sparse: true,
        Name: i.name ?? c.name,
        ...(i.active === undefined ? {} : { Active: i.active }),
      };
      if (i.parentId !== undefined) {
        const sub = isAccount ? "SubAccount" : entity === "Class" ? "SubClass" : "SubDepartment";
        if (i.parentId === null) body[sub] = false;
        else Object.assign(body, { [sub]: true, ParentRef: { value: i.parentId } });
      }
      if (isAccount) {
        if (i.accountType !== undefined) body.AccountType = i.accountType;
        if (i.accountSubType !== undefined) body.AccountSubType = i.accountSubType;
        if (i.number !== undefined) body.AcctNum = i.number ?? "";
        if (i.description !== undefined) body.Description = i.description ?? "";
      }
      ctx.logger.info(`changing ${A[entity]} ${WORD[entity]}`, { entity, id: c.id });
      const answer = await client.post(PATH[entity], body, {
        requestid: await qboRequestId(ctx.idempotencyKey),
      });
      return created(answer, entity, false);
    },
  });
}

/** The six ledger writes, each always signed. */
export function ledgerWriteTools(clientFor: ClientFor): ToolDefinition[] {
  return [
    createTool("Account", LEDGER_WRITE_TOOLS.accountCreate, "account", clientFor),
    updateTool("Account", LEDGER_WRITE_TOOLS.accountUpdate, "account", clientFor),
    createTool("Class", LEDGER_WRITE_TOOLS.classCreate, "class", clientFor),
    updateTool("Class", LEDGER_WRITE_TOOLS.classUpdate, "class", clientFor),
    createTool("Department", LEDGER_WRITE_TOOLS.locationCreate, "location", clientFor),
    updateTool("Department", LEDGER_WRITE_TOOLS.locationUpdate, "location", clientFor),
  ];
}
