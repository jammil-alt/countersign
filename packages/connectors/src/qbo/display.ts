// How each qbo write reads on its approval card (ToolSpec `display`, docs/plan.md §1.x "Inbox and
// run views"): the record by its number and vendor, the fields a person checks, in the client's
// language. Ids, SyncTokens and the guards a write carries (the expected total, the line ids it
// replaces) stay out of the card.
import type { DisplayField, LocalizedText, ToolDisplay } from "@countersign/core";

const T = {
  bill: {
    en: "QuickBooks bill",
    es: "Factura de QuickBooks",
    fr: "Facture QuickBooks",
    "pt-BR": "Conta do QuickBooks",
    it: "Fattura QuickBooks",
    de: "QuickBooks-Rechnung",
  },
  purchase: {
    en: "QuickBooks purchase",
    es: "Compra de QuickBooks",
    fr: "Achat QuickBooks",
    "pt-BR": "Compra do QuickBooks",
    it: "Acquisto QuickBooks",
    de: "QuickBooks-Ausgabe",
  },
  vendorCredit: {
    en: "QuickBooks vendor credit",
    es: "Crédito de proveedor de QuickBooks",
    fr: "Avoir fournisseur QuickBooks",
    "pt-BR": "Crédito de fornecedor do QuickBooks",
    it: "Nota di credito fornitore QuickBooks",
    de: "QuickBooks-Lieferantengutschrift",
  },
  item: {
    en: "QuickBooks item",
    es: "Producto de QuickBooks",
    fr: "Article QuickBooks",
    "pt-BR": "Item do QuickBooks",
    it: "Articolo QuickBooks",
    de: "QuickBooks-Artikel",
  },
  date: { en: "Date", es: "Fecha", fr: "Date", "pt-BR": "Data", it: "Data", de: "Datum" },
  lines: {
    en: "Lines",
    es: "Líneas",
    fr: "Lignes",
    "pt-BR": "Linhas",
    it: "Righe",
    de: "Positionen",
  },
  total: { en: "Total", es: "Total", fr: "Total", "pt-BR": "Total", it: "Totale", de: "Gesamt" },
  memo: {
    en: "Memo",
    es: "Nota",
    fr: "Mémo",
    "pt-BR": "Memorando",
    it: "Promemoria",
    de: "Notiz",
  },
  purchaseCost: {
    en: "Purchase cost",
    es: "Costo de compra",
    fr: "Coût d'achat",
    "pt-BR": "Custo de compra",
    it: "Costo d'acquisto",
    de: "Einkaufspreis",
  },
  attachments: {
    en: "Attachments",
    es: "Adjuntos",
    fr: "Pièces jointes",
    "pt-BR": "Anexos",
    it: "Allegati",
    de: "Anhänge",
  },
  note: {
    en: "Note",
    es: "Nota",
    fr: "Note",
    "pt-BR": "Observação",
    it: "Nota",
    de: "Notiz",
  },
  // v0.12 W1-F
  invoice: {
    en: "QuickBooks invoice",
    es: "Factura de cliente de QuickBooks",
    fr: "Facture client QuickBooks",
    "pt-BR": "Fatura do QuickBooks",
    it: "Fattura cliente QuickBooks",
    de: "QuickBooks-Ausgangsrechnung",
  },
  privateNote: {
    en: "Private note",
    es: "Nota privada",
    fr: "Note privée",
    "pt-BR": "Observação privada",
    it: "Nota privata",
    de: "Private Notiz",
  },
  dueDate: {
    en: "Due date",
    es: "Vencimiento",
    fr: "Échéance",
    "pt-BR": "Vencimento",
    it: "Scadenza",
    de: "Fällig am",
  },
  balance: {
    en: "Open balance",
    es: "Saldo pendiente",
    fr: "Solde dû",
    "pt-BR": "Saldo em aberto",
    it: "Saldo aperto",
    de: "Offener Betrag",
  },
} satisfies Record<string, LocalizedText>;

const date: DisplayField = { label: T.date, kind: "date", now: "before.txnDate" };
const total: DisplayField = {
  label: T.total,
  kind: "money",
  now: "before.total",
  currencyPath: "before.currency",
};

export function updateLinesDisplay(entity: "Bill" | "Purchase"): ToolDisplay {
  const bill = entity === "Bill";
  return {
    name: bill ? T.bill : T.purchase,
    description: bill
      ? {
          en: "Replace the bill's lines with the items on the vendor's invoice. The total stays the same.",
          es: "Cambia las líneas de la factura por los artículos de la factura del proveedor. El total no cambia.",
          fr: "Remplace les lignes de la facture par les articles de la facture du fournisseur. Le total ne change pas.",
          "pt-BR":
            "Substitui as linhas da conta pelos itens da nota do fornecedor. O total não muda.",
          it: "Sostituisce le righe della fattura con gli articoli della fattura del fornitore. Il totale non cambia.",
          de: "Ersetzt die Positionen der Rechnung durch die Artikel der Lieferantenrechnung. Der Gesamtbetrag bleibt gleich.",
        }
      : {
          en: "Replace the purchase's lines with the items on the vendor's invoice. The total stays the same.",
          es: "Cambia las líneas de la compra por los artículos de la factura del proveedor. El total no cambia.",
          fr: "Remplace les lignes de l'achat par les articles de la facture du fournisseur. Le total ne change pas.",
          "pt-BR":
            "Substitui as linhas da compra pelos itens da nota do fornecedor. O total não muda.",
          it: "Sostituisce le righe dell'acquisto con gli articoli della fattura del fornitore. Il totale non cambia.",
          de: "Ersetzt die Positionen der Ausgabe durch die Artikel der Lieferantenrechnung. Der Gesamtbetrag bleibt gleich.",
        },
    number: "before.docNumber",
    subject: "before.vendor",
    names: "before.names",
    fields: [
      date,
      {
        label: T.lines,
        kind: "lines",
        now: "before.lines",
        // The lines the change replaces leave; the new ones follow the lines it keeps.
        after: "input.lines",
        adds: true,
        removes: "input.replaceLineIds",
        currencyPath: "before.currency",
        columns: {
          id: "id",
          description: "description",
          qty: "qty",
          unitPrice: "unitPrice",
          amount: "amount",
          // DECISION: a ref without its name (QuickBooks sometimes leaves it off) reads through the
          // same names lists as the ids, which the server fills from synced records if need be.
          refs: [
            { key: "item", names: "items" },
            { key: "account", names: "accounts" },
            { key: "itemId", names: "items" },
            { key: "accountId", names: "accounts" },
          ],
        },
      },
      total,
    ],
  };
}

export function updateMemoDisplay(entity: "Bill" | "Purchase"): ToolDisplay {
  const bill = entity === "Bill";
  return {
    name: bill ? T.bill : T.purchase,
    description: bill
      ? {
          en: "Update the bill's memo. Nothing else changes.",
          es: "Actualiza la nota de la factura. Nada más cambia.",
          fr: "Met à jour le mémo de la facture. Rien d'autre ne change.",
          "pt-BR": "Atualiza o memorando da conta. Nada mais muda.",
          it: "Aggiorna il promemoria della fattura. Nient'altro cambia.",
          de: "Aktualisiert die Notiz der Rechnung. Sonst ändert sich nichts.",
        }
      : {
          en: "Update the purchase's memo. Nothing else changes.",
          es: "Actualiza la nota de la compra. Nada más cambia.",
          fr: "Met à jour le mémo de l'achat. Rien d'autre ne change.",
          "pt-BR": "Atualiza o memorando da compra. Nada mais muda.",
          it: "Aggiorna il promemoria dell'acquisto. Nient'altro cambia.",
          de: "Aktualisiert die Notiz der Ausgabe. Sonst ändert sich nichts.",
        },
    number: "before.docNumber",
    subject: "before.vendor",
    fields: [{ label: T.memo, kind: "text", now: "before.memo", after: "input.memo" }, date, total],
  };
}

export const updatePurchaseCostDisplay: ToolDisplay = {
  name: T.item,
  description: {
    en: "Set the item's purchase cost, which new purchases of it start from. Nothing else changes.",
    es: "Fija el costo de compra del producto, del que parten sus nuevas compras. Nada más cambia.",
    fr: "Fixe le coût d'achat de l'article, repris par ses prochains achats. Rien d'autre ne change.",
    "pt-BR": "Define o custo de compra do item, usado nas próximas compras. Nada mais muda.",
    it: "Imposta il costo d'acquisto dell'articolo, usato nei prossimi acquisti. Nient'altro cambia.",
    de: "Setzt den Einkaufspreis des Artikels, den neue Einkäufe übernehmen. Sonst ändert sich nichts.",
  },
  subject: "before.name",
  fields: [
    {
      label: T.purchaseCost,
      kind: "money",
      now: "before.purchaseCost",
      after: "input.purchaseCost",
      currencyPath: "input.currency",
      currency: "USD",
    },
  ],
};

export const attachDisplay: ToolDisplay = {
  name: T.bill,
  nameBy: {
    path: "input.entity",
    names: { Bill: T.bill, Purchase: T.purchase, VendorCredit: T.vendorCredit },
  },
  description: {
    en: "Attach the invoice file to this record in QuickBooks.",
    es: "Adjunta el archivo de la factura a este registro en QuickBooks.",
    fr: "Joint le fichier de la facture à cet enregistrement dans QuickBooks.",
    "pt-BR": "Anexa o arquivo da nota a este registro no QuickBooks.",
    it: "Allega il file della fattura a questo record in QuickBooks.",
    de: "Hängt die Rechnungsdatei an diesen Datensatz in QuickBooks an.",
  },
  number: "before.docNumber",
  subject: "before.vendor",
  fields: [
    {
      label: T.attachments,
      kind: "files",
      now: "before.attachments",
      // The file being attached, read when the change was proposed.
      after: "before.adding",
      adds: true,
      columns: { id: "id", description: "fileName", size: "size" },
    },
    { label: T.note, kind: "text", after: "input.note" },
  ],
};

// ── v0.12 W1-F: accounts receivable and create bill ────────────────────────────────────────────

/** "QuickBooks invoice 1043 · Lakeside Builders", the private note now and after. */
export const addNoteDisplay: ToolDisplay = {
  name: T.invoice,
  description: {
    en: "Add a dated line to the invoice's private note. Nothing else changes, and the customer doesn't see it.",
    es: "Añade una línea con fecha a la nota privada de la factura. Nada más cambia y el cliente no la ve.",
    fr: "Ajoute une ligne datée à la note privée de la facture. Rien d'autre ne change et le client ne la voit pas.",
    "pt-BR":
      "Adiciona uma linha com data à observação privada da fatura. Nada mais muda e o cliente não a vê.",
    it: "Aggiunge una riga datata alla nota privata della fattura. Nient'altro cambia e il cliente non la vede.",
    de: "Fügt der privaten Notiz der Rechnung eine datierte Zeile hinzu. Sonst ändert sich nichts, und der Kunde sieht sie nicht.",
  },
  number: "before.docNumber",
  subject: "before.customer",
  fields: [
    {
      label: T.privateNote,
      kind: "text",
      now: "before.privateNote",
      after: "before.privateNoteAfter",
    },
    {
      label: T.balance,
      kind: "money",
      now: "before.balance",
      currencyPath: "before.currency",
    },
    { label: T.dueDate, kind: "date", now: "before.dueDate" },
  ],
};

/** A new bill: its vendor and number, dates, lines with their items' and accounts' names, total. */
// DECISION: a new bill has nothing "now", so every field reads only its `after`; the before state
// carries the vendor as QuickBooks names it and the names of the items and accounts the lines use,
// read when the change is proposed (the card shows names, never ids).
export const billCreateDisplay: ToolDisplay = {
  name: T.bill,
  description: {
    en: "Create this bill in QuickBooks. Nothing else changes.",
    es: "Crea esta factura en QuickBooks. Nada más cambia.",
    fr: "Crée cette facture dans QuickBooks. Rien d'autre ne change.",
    "pt-BR": "Cria esta conta no QuickBooks. Nada mais muda.",
    it: "Crea questa fattura in QuickBooks. Nient'altro cambia.",
    de: "Legt diese Rechnung in QuickBooks an. Sonst ändert sich nichts.",
  },
  number: "input.docNumber",
  subject: "before.vendor",
  names: "before.names",
  fields: [
    { label: T.date, kind: "date", after: "input.txnDate" },
    { label: T.dueDate, kind: "date", after: "input.dueDate" },
    {
      label: T.lines,
      kind: "lines",
      after: "input.lines",
      currencyPath: "input.currency",
      columns: {
        description: "description",
        qty: "qty",
        unitPrice: "unitPrice",
        amount: "amount",
        refs: [
          { key: "itemId", names: "items" },
          { key: "accountId", names: "accounts" },
        ],
      },
    },
    {
      label: T.total,
      kind: "money",
      after: "input.expectedTotal",
      currencyPath: "input.currency",
      currency: "USD",
    },
    { label: T.memo, kind: "text", after: "input.privateNote" },
  ],
};
