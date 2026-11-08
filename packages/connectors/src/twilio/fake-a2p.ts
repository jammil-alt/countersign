// P-8: the fake Twilio's A2P 10DLC resources (docs/plan.md §1.70), shaped as Twilio's docs show
// them (NOTES.md, "A2P 10DLC by API"): Trust Hub's customer profiles, trust products, end users and
// supporting documents; addresses; BrandRegistrations; Messaging Services with their numbers, use
// cases and Usa2p campaign. Tests only; never imported by the Worker.

import type { HttpResponseLike } from "../http";

function json(status: number, body?: unknown): HttpResponseLike {
  const text = body === undefined ? "" : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (n) => (n.toLowerCase() === "content-type" ? "application/json" : null) },
    text: async () => text,
  };
}
const notFound = () => json(404, { code: 20404, message: "not found" });
const hex32 = (n: number) => n.toString(16).padStart(32, "0");

export interface FakeBundle {
  sid: string;
  account: string;
  kind: "CustomerProfiles" | "TrustProducts";
  status: string;
  email: string;
  assignments: string[];
  errors: unknown[];
}
export interface FakeEndUser {
  sid: string;
  account: string;
  type: string;
  attributes: Record<string, unknown>;
}
export interface FakeBrand {
  sid: string;
  account: string;
  profile: string;
  trustProduct: string;
  lowVolume: boolean;
  updates: number;
  errors: unknown[];
}
export interface FakeService {
  sid: string;
  account: string;
  name: string;
  inbound: string;
  useInboundWebhookOnNumber: boolean;
  numbers: Set<string>;
}
export interface FakeCampaign {
  service: string;
  brand: string;
  usecase: string;
  description: string;
  messageFlow: string;
  samples: string[];
  optOutKeywords: string[];
  errors: unknown[];
}

/** The primary profile Mezonas' account has (any BU the test names may stand in for it). */
export const FAKE_PRIMARY_PROFILE = `BU${"f".repeat(32)}`;

/** Splits a form body into its fields, a repeated field keeping every value. */
function lists(body: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const pair of body.split("&")) {
    if (!pair) continue;
    const at = pair.indexOf("=");
    const k = decodeURIComponent((at < 0 ? pair : pair.slice(0, at)).replace(/\+/g, " "));
    const v = at < 0 ? "" : decodeURIComponent(pair.slice(at + 1).replace(/\+/g, " "));
    out.set(k, [...(out.get(k) ?? []), v]);
  }
  return out;
}

export function fakeA2p(next: () => number) {
  const bundles = new Map<string, FakeBundle>();
  const endUsers = new Map<string, FakeEndUser>();
  const documents = new Map<string, { account: string; addressSid: string }>();
  const addressBook = new Map<string, { account: string; form: Record<string, string> }>();
  const brandRecords = new Map<string, FakeBrand>();
  const services = new Map<string, FakeService>();
  const campaignRecords = new Map<string, FakeCampaign>();
  /** Every call that charged a fee (a real brand, a campaign): what a bill would show. */
  const charged: { kind: "brand" | "vetting"; sid: string }[] = [];

  const mine = <T extends { account: string }>(m: Map<string, T>, sid: string, caller: string) => {
    const v = m.get(sid);
    return v && v.account === caller ? v : undefined;
  };

  function evaluate(b: FakeBundle) {
    const types = b.assignments.map(
      (s) =>
        endUsers.get(s)?.type ?? (s.startsWith("RD") ? "doc" : s.startsWith("BU") ? "bundle" : "?"),
    );
    const results: unknown[] = [];
    const need = (ok: boolean, name: string, field?: string) => {
      if (ok) return;
      results.push({
        friendly_name: name,
        object_type: "business",
        passed: false,
        failure_reason: `${name} is missing. Please add one to the regulatory bundle.`,
        error_code: 22214,
        valid: [],
        invalid: field
          ? [
              {
                friendly_name: name,
                object_field: field,
                failure_reason: `${name} is invalid.`,
                error_code: 22215,
              },
            ]
          : [],
      });
    };
    if (b.kind === "CustomerProfiles") {
      const business = b.assignments
        .map((s) => endUsers.get(s))
        .find((e) => e?.type === "customer_profile_business_information");
      need(Boolean(business), "Business");
      const ein = String(business?.attributes.business_registration_number ?? "");
      need(
        !business || /^\d{2}-\d{7}$/.test(ein),
        "Business Registration Number",
        "business_registration_number",
      );
      need(types.includes("authorized_representative_1"), "Authorized Representative");
      need(types.includes("doc"), "Business Address");
      need(
        b.assignments.some((s) => bundles.get(s) === undefined && s.startsWith("BU")),
        "Primary Customer Profile",
      );
    } else {
      need(types.includes("us_a2p_messaging_profile_information"), "Messaging Profile");
      need(
        b.assignments.some((s) => bundles.get(s)?.kind === "CustomerProfiles"),
        "Customer Profile",
      );
    }
    return {
      sid: `EL${hex32(next())}`,
      status: results.length === 0 ? "compliant" : "noncompliant",
      results,
    };
  }

  const bundleView = (b: FakeBundle) => ({
    sid: b.sid,
    account_sid: b.account,
    friendly_name: "",
    status: b.status,
    email: b.email,
    errors: b.errors.length ? b.errors : null,
  });

  return {
    bundles,
    endUsers,
    documents,
    addressBook,
    brandRecords,
    services,
    campaignRecords,
    charged,
    /** A bundle's review outcome, as Twilio's reviewers would set it. */
    setBundle(sid: string, status: string, errors: unknown[] = []) {
      const b = bundles.get(sid);
      if (!b) throw new Error(`no bundle ${sid}`);
      b.status = status;
      b.errors = errors;
    },

    trustHub(
      caller: string,
      method: string,
      path: string,
      form: Record<string, string>,
    ): HttpResponseLike {
      const kind = path.match(/^\/(CustomerProfiles|TrustProducts)$/);
      if (kind?.[1] && method === "POST") {
        if (!form.FriendlyName || !form.Email || !form.PolicySid) {
          return json(400, {
            code: 20001,
            message: "FriendlyName, Email and PolicySid are required",
          });
        }
        const b: FakeBundle = {
          sid: `BU${hex32(next())}`,
          account: caller,
          kind: kind[1] as FakeBundle["kind"],
          status: "draft",
          email: form.Email,
          assignments: [],
          errors: [],
        };
        bundles.set(b.sid, b);
        return json(201, bundleView(b));
      }
      const one = path.match(/^\/(CustomerProfiles|TrustProducts)\/(BU[0-9a-f]{32})$/);
      if (one?.[2]) {
        const b = mine(bundles, one[2], caller);
        if (!b) return notFound();
        if (method === "GET") return json(200, bundleView(b));
        if (method === "POST" && form.Status) {
          b.status = form.Status;
          if (form.Status === "pending-review") b.errors = [];
          return json(200, bundleView(b));
        }
      }
      const assign = path.match(
        /^\/(CustomerProfiles|TrustProducts)\/(BU[0-9a-f]{32})\/EntityAssignments$/,
      );
      if (assign?.[2] && method === "POST") {
        const b = mine(bundles, assign[2], caller);
        if (!b) return notFound();
        const obj = form.ObjectSid ?? "";
        if (!b.assignments.includes(obj)) b.assignments.push(obj);
        return json(201, { sid: `BV${hex32(next())}`, object_sid: obj });
      }
      const evals = path.match(
        /^\/(CustomerProfiles|TrustProducts)\/(BU[0-9a-f]{32})\/Evaluations$/,
      );
      if (evals?.[2] && method === "POST") {
        const b = mine(bundles, evals[2], caller);
        if (!b) return notFound();
        return json(201, evaluate(b));
      }
      if (path === "/EndUsers" && method === "POST") {
        let attributes: Record<string, unknown>;
        try {
          attributes = JSON.parse(form.Attributes ?? "{}");
        } catch {
          return json(400, { code: 20001, message: "Attributes must be JSON" });
        }
        const e: FakeEndUser = {
          sid: `IT${hex32(next())}`,
          account: caller,
          type: form.Type ?? "",
          attributes,
        };
        endUsers.set(e.sid, e);
        return json(201, { sid: e.sid, type: e.type, attributes });
      }
      const eu = path.match(/^\/EndUsers\/(IT[0-9a-f]{32})$/);
      if (eu?.[1] && method === "POST") {
        const e = mine(endUsers, eu[1], caller);
        if (!e) return notFound();
        e.attributes = JSON.parse(form.Attributes ?? "{}");
        return json(200, { sid: e.sid, type: e.type, attributes: e.attributes });
      }
      if (path === "/SupportingDocuments" && method === "POST") {
        const attrs = JSON.parse(form.Attributes ?? "{}") as { address_sids?: string };
        const a = attrs.address_sids ? addressBook.get(attrs.address_sids) : undefined;
        if (!a || a.account !== caller)
          return json(400, { code: 22217, message: "address not found" });
        const sid = `RD${hex32(next())}`;
        documents.set(sid, { account: caller, addressSid: attrs.address_sids ?? "" });
        return json(201, { sid, status: "DRAFT", type: form.Type });
      }
      return notFound();
    },

    /** The account's `Addresses` (on the REST API), or null for any other path. */
    addresses(
      account: string,
      method: string,
      rest: string,
      form: Record<string, string>,
    ): HttpResponseLike | null {
      if (rest === "/Addresses.json" && method === "POST") {
        const sid = `AD${hex32(next())}`;
        addressBook.set(sid, { account, form });
        return json(201, { sid, account_sid: account, iso_country: form.IsoCountry });
      }
      const one = rest.match(/^\/Addresses\/(AD[0-9a-f]{32})\.json$/);
      if (one?.[1] && method === "POST") {
        const a = addressBook.get(one[1]);
        if (!a || a.account !== account) return notFound();
        a.form = { ...a.form, ...form };
        return json(200, { sid: one[1], account_sid: account });
      }
      return null;
    },

    /** Messaging's A2P paths, or null to fall through to the fake's own (status reads). */
    messaging(
      caller: string,
      method: string,
      path: string,
      form: Record<string, string>,
      query: Record<string, string>,
      body: string,
      shared: {
        brands: Map<string, string>;
        campaigns: Map<string, string>;
        numbers: Map<string, { sid: string; account_sid: string }>;
      },
    ): HttpResponseLike | null {
      if (path === "/a2p/BrandRegistrations" && method === "POST") {
        const profile = mine(bundles, form.CustomerProfileBundleSid ?? "", caller);
        const trust = mine(bundles, form.A2PProfileBundleSid ?? "", caller);
        if (!profile || !trust?.assignments.includes(profile.sid)) {
          return json(400, {
            code: 21706,
            message: "The customer profile or A2P trust product is not valid",
          });
        }
        const sid = `BN${hex32(next())}`;
        const b: FakeBrand = {
          sid,
          account: caller,
          profile: profile.sid,
          trustProduct: trust.sid,
          lowVolume: form.SkipAutomaticSecVet === "true",
          updates: 0,
          errors: [],
        };
        brandRecords.set(sid, b);
        shared.brands.set(sid, "PENDING");
        if (form.Mock !== "true") charged.push({ kind: "brand", sid });
        return json(201, {
          sid,
          account_sid: caller,
          status: "PENDING",
          brand_type: "STANDARD",
          tcr_id: null,
          errors: [],
          mock: form.Mock === "true",
        });
      }
      const brand = path.match(/^\/a2p\/BrandRegistrations\/(BN[0-9a-f]{32})$/);
      if (brand?.[1]) {
        const b = mine(brandRecords, brand[1], caller);
        if (!b) return null; // a brand set by a test with setBrand only
        const status = shared.brands.get(b.sid) ?? "PENDING";
        if (method === "POST") {
          if (status !== "FAILED")
            return json(400, { code: 21730, message: `The brand is ${status}, not FAILED` });
          if (b.updates >= 3)
            return json(400, { code: 21724, message: "Brand update limit reached" });
          b.updates++;
          b.errors = [];
          shared.brands.set(b.sid, "PENDING");
          return json(200, { sid: b.sid, status: "PENDING", tcr_id: "BFAKE01", errors: [] });
        }
        if (method === "GET") {
          return json(200, {
            sid: b.sid,
            status,
            brand_type: "STANDARD",
            tcr_id: "BFAKE01",
            errors: b.errors,
            failure_reason: null,
          });
        }
      }
      if (path === "/Services" && method === "POST") {
        if (!form.FriendlyName)
          return json(400, { code: 20001, message: "FriendlyName is required" });
        const svc: FakeService = {
          sid: `MG${hex32(next())}`,
          account: caller,
          name: form.FriendlyName,
          inbound: form.InboundRequestUrl ?? "",
          useInboundWebhookOnNumber: form.UseInboundWebhookOnNumber === "true",
          numbers: new Set(),
        };
        services.set(svc.sid, svc);
        return json(201, {
          sid: svc.sid,
          account_sid: caller,
          friendly_name: svc.name,
          us_app_to_person_registered: false,
        });
      }
      const usecases = path.match(/^\/Services\/(MG[0-9a-f]{32})\/Compliance\/Usa2p\/Usecases$/);
      if (usecases?.[1] && method === "GET") {
        if (!mine(services, usecases[1], caller)) return notFound();
        const b = mine(brandRecords, query.BrandRegistrationSid ?? "", caller);
        if (!b || shared.brands.get(b.sid) !== "APPROVED")
          return json(400, { code: 21711, message: "The brand is not approved" });
        const codes = b.lowVolume
          ? ["LOW_VOLUME", "2FA", "ACCOUNT_NOTIFICATION"]
          : [
              "2FA",
              "ACCOUNT_NOTIFICATION",
              "CUSTOMER_CARE",
              "DELIVERY_NOTIFICATION",
              "MARKETING",
              "MIXED",
            ];
        return json(200, {
          us_app_to_person_usecases: codes.map((code) => ({
            code,
            name: code,
            post_approval_required: false,
          })),
        });
      }
      const usa2p = path.match(/^\/Services\/(MG[0-9a-f]{32})\/Compliance\/Usa2p$/);
      if (usa2p?.[1] && method === "POST") {
        const svc = mine(services, usa2p[1], caller);
        if (!svc) return notFound();
        if (campaignRecords.has(svc.sid))
          return json(409, { code: 21710, message: "The service already has a campaign" });
        const b = mine(brandRecords, form.BrandRegistrationSid ?? "", caller);
        if (!b || shared.brands.get(b.sid) !== "APPROVED")
          return json(400, { code: 21711, message: "The brand is not approved" });
        const all = lists(body);
        const samples = all.get("MessageSamples") ?? [];
        const bad =
          (form.Description ?? "").length < 40 ||
          (form.MessageFlow ?? "").length < 40 ||
          samples.length < 2 ||
          samples.length > 5 ||
          samples.some((x) => x.length < 20 || x.length > 1024) ||
          form.HasEmbeddedLinks === undefined ||
          form.HasEmbeddedPhone === undefined;
        if (bad)
          return json(400, {
            code: 21714,
            message: "Campaign fields are missing or the wrong length",
          });
        const allowed = b.lowVolume ? ["LOW_VOLUME"] : ["MIXED", "MARKETING", "CUSTOMER_CARE"];
        if (!allowed.includes(form.UsAppToPersonUsecase ?? "")) {
          return json(400, {
            code: 21712,
            message: "The use case is not available for this brand",
          });
        }
        campaignRecords.set(svc.sid, {
          service: svc.sid,
          brand: b.sid,
          usecase: form.UsAppToPersonUsecase ?? "",
          description: form.Description ?? "",
          messageFlow: form.MessageFlow ?? "",
          samples,
          optOutKeywords: all.get("OptOutKeywords") ?? [],
          errors: [],
        });
        shared.campaigns.set(svc.sid, "PENDING");
        charged.push({ kind: "vetting", sid: svc.sid });
        return json(201, {
          sid: "QE2c6890da8086d771620e9b13fadeba0b",
          campaign_status: "PENDING",
          us_app_to_person_usecase: form.UsAppToPersonUsecase,
          errors: [],
        });
      }
      if (usa2p?.[1] && method === "GET") {
        const svc = mine(services, usa2p[1], caller);
        if (!svc) return null; // a campaign set by a test with setCampaign only
        const c = campaignRecords.get(svc.sid);
        const status = shared.campaigns.get(svc.sid);
        return json(200, {
          compliance:
            c && status
              ? [
                  {
                    sid: "QE2c6890da8086d771620e9b13fadeba0b",
                    campaign_status: status,
                    us_app_to_person_usecase: c.usecase,
                    errors: c.errors,
                  },
                ]
              : [],
        });
      }
      const qe = path.match(/^\/Services\/(MG[0-9a-f]{32})\/Compliance\/Usa2p\/(QE[0-9a-f]{32})$/);
      if (qe?.[1] && method === "DELETE") {
        const svc = mine(services, qe[1], caller);
        if (!svc || !campaignRecords.has(svc.sid)) return notFound();
        campaignRecords.delete(svc.sid);
        shared.campaigns.delete(svc.sid);
        return json(204);
      }
      const pns = path.match(/^\/Services\/(MG[0-9a-f]{32})\/PhoneNumbers$/);
      if (pns?.[1]) {
        const svc = mine(services, pns[1], caller);
        if (!svc) return notFound();
        if (method === "GET") {
          return json(200, {
            phone_numbers: [...svc.numbers].map((sid) => ({ sid, service_sid: svc.sid })),
          });
        }
        if (method === "POST") {
          const n = shared.numbers.get(form.PhoneNumberSid ?? "");
          if (!n || n.account_sid !== caller)
            return json(400, { code: 21452, message: "The number is not in this account" });
          if (svc.numbers.has(n.sid))
            return json(409, { code: 21710, message: "The number is already in the service" });
          svc.numbers.add(n.sid);
          return json(201, { sid: n.sid, service_sid: svc.sid });
        }
      }
      return null;
    },
  };
}
export type FakeA2p = ReturnType<typeof fakeA2p>;
