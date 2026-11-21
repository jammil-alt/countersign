// Zoho CRM's synced records as keys (docs/plan.md §1.164): Leads and Contacts are people, Accounts
// companies, Deals deals. The fields are those `ZOHO_SYNC_FIELDS` reads, and the usual standard
// ones a connection may add (Website, Mobile). A lookup field (a contact's or deal's account, a
// deal's contact) comes as `{ name, id }`. Pure: no I/O.

import type { CrmRecordMapper, MappedRecord, RecordFields } from "./build";

export const ZOHO_CONNECTOR = "zoho_crm";

type Payload = Record<string, unknown>;

/** A text field, or a lookup's name. */
function text(payload: Payload, field: string): string | undefined {
  const v = payload[field];
  if (typeof v === "string") return v.trim() || undefined;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (v && typeof v === "object" && "name" in v) {
    const name = (v as { name?: unknown }).name;
    if (typeof name === "string") return name.trim() || undefined;
  }
  return undefined;
}

/** The values a person sees for the record, as written (only those it has). */
function display(values: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) if (v) out[k] = v.slice(0, 300);
  return out;
}

function personName(p: Payload): string | undefined {
  const parts = [text(p, "First_Name"), text(p, "Last_Name")].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : text(p, "Full_Name");
}

function read(module: string, p: Payload): MappedRecord | null {
  const phone = text(p, "Phone") ?? text(p, "Mobile");
  switch (module) {
    case "Leads": {
      const fields: RecordFields = {
        email: text(p, "Email"),
        phone,
        website: text(p, "Website"),
        company: text(p, "Company"),
        firstName: text(p, "First_Name"),
        lastName: text(p, "Last_Name"),
        name: text(p, "Full_Name"),
      };
      return {
        fields,
        display: display({
          name: personName(p),
          company: text(p, "Company"),
          email: text(p, "Email"),
          phone,
          status: text(p, "Lead_Status"),
        }),
      };
    }
    case "Contacts": {
      const fields: RecordFields = {
        email: text(p, "Email"),
        phone,
        company: text(p, "Account_Name"),
        firstName: text(p, "First_Name"),
        lastName: text(p, "Last_Name"),
        name: text(p, "Full_Name"),
      };
      return {
        fields,
        display: display({
          name: personName(p),
          company: text(p, "Account_Name"),
          email: text(p, "Email"),
          phone,
          title: text(p, "Title"),
        }),
      };
    }
    case "Accounts": {
      const fields: RecordFields = {
        phone,
        website: text(p, "Website"),
        company: text(p, "Account_Name"),
      };
      return {
        fields,
        display: display({
          company: text(p, "Account_Name"),
          phone,
          website: text(p, "Website"),
          industry: text(p, "Industry"),
        }),
      };
    }
    case "Deals": {
      const fields: RecordFields = {
        deal: text(p, "Deal_Name"),
        company: text(p, "Account_Name"),
        name: text(p, "Contact_Name"),
      };
      return {
        fields,
        display: display({
          deal: text(p, "Deal_Name"),
          company: text(p, "Account_Name"),
          name: text(p, "Contact_Name"),
          stage: text(p, "Stage"),
          amount: text(p, "Amount"),
          closing: text(p, "Closing_Date"),
        }),
      };
    }
    default:
      return null;
  }
}

export const zohoMapper: CrmRecordMapper = {
  connector: ZOHO_CONNECTOR,
  modules: { Leads: "person", Contacts: "person", Accounts: "company", Deals: "deal" },
  map(module, payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    return read(module, payload as Payload);
  },
  field(payload, name) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
    // An own field only (the payload's names are Zoho's, never an object's prototype).
    if (!Object.hasOwn(payload, name)) return undefined;
    const p = payload as Payload;
    const v = p[name];
    if (typeof v === "boolean") return v ? "yes" : "no";
    // A multi-select pick list is a list of words.
    if (Array.isArray(v)) {
      const items = v.filter((x): x is string => typeof x === "string" && x.trim() !== "");
      return items.length > 0 ? items.join(", ").slice(0, 300) : undefined;
    }
    return text(p, name)?.slice(0, 300);
  },
};

/** Every connector the Sales area reads records from, by its manifest id. */
export const CRM_MAPPERS: Readonly<Record<string, CrmRecordMapper>> = {
  [ZOHO_CONNECTOR]: zohoMapper,
};
