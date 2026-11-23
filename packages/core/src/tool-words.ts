// A read tool's id in words ("qbo.purchaseorder.query" → "Find purchase orders"), for the screens
// and the generated read skills alike, where no one wrote a title for it (S5.6: the runs read
// "Query purchaseorder").

/** Entity ids that run words together, and plurals that aren't just an "s". */
const ENTITY_PLURALS: Record<string, string> = {
  purchaseorder: "purchase orders",
  purchase_order: "purchase orders",
  journalentry: "journal entries",
  journal_entry: "journal entries",
  vendorcredit: "vendor credits",
  billpayment: "bill payments",
  creditmemo: "credit memos",
  salesreceipt: "sales receipts",
  attachable: "attachments",
  class: "classes",
  item: "products and services",
  entry: "entries",
  company: "companies",
  activity: "activities",
};

/** "purchaseorder" → "purchase orders", "bill" → "bills", "record" → "records". */
export function entityPlural(entity: string): string {
  const key = entity.toLowerCase();
  const known = ENTITY_PLURALS[key];
  if (known) return known;
  const words = key.replace(/[_-]+/g, " ").trim();
  return words.endsWith("s") ? words : `${words}s`;
}

/** "purchaseorder" → "purchase order". */
function entitySingular(entity: string): string {
  const plural = entityPlural(entity);
  if (entity.toLowerCase() === "item") return "product or service";
  if (plural.endsWith("ies")) return `${plural.slice(0, -3)}y`;
  if (plural.endsWith("sses")) return plural.slice(0, -2);
  return plural.endsWith("s") ? plural.slice(0, -1) : plural;
}

const FIND = new Set(["query", "search", "filter", "find"]);
const READ = new Set(["get", "read"]);

/**
 * A read tool's id in words, or null when its verb isn't a read: `<connector>.<entity>.query`
 * (or search, filter) → "Find bills", `.list` → "List attachments", `.get` → "Read a vendor".
 */
export function readToolWords(toolId: string): string | null {
  const parts = toolId.split(".");
  if (parts.length < 3) return null;
  const verb = (parts.at(-1) ?? "").toLowerCase();
  const entity = parts.slice(1, -1).join("_");
  if (!entity) return null;
  if (FIND.has(verb)) return `Find ${entityPlural(entity)}`;
  if (verb === "list") return `List ${entityPlural(entity)}`;
  if (READ.has(verb)) {
    const one = entitySingular(entity);
    return `Read ${/^[aeiou]/.test(one) ? "an" : "a"} ${one}`;
  }
  return null;
}
