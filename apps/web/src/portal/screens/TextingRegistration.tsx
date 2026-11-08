// P-8: `/settings/texting` (docs/plan.md §1.70): the client admin gives the business details for
// US texting registration (A2P 10DLC) once; we review them and send them to Twilio. The EIN is
// write-only: it goes to the client's vault and comes back only as a masked hint. Where things
// stand and what Twilio asked for are shown in plain words. No SID, fee amount or cost here.
import {
  A2P_BUSINESS_TYPES,
  A2P_COMPANY_TYPES,
  A2P_INDUSTRIES,
  A2P_POSITIONS,
  A2P_USES,
  type A2pBusinessDetails,
  type A2pStage,
  type A2pUse,
} from "@countersign/core";
import { type FormEvent, useEffect, useState } from "react";
import { isApiError } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import type { PlainKey } from "../../i18n/catalog";
import { useI18n } from "../../i18n/i18n";
import { Field, Select, TextArea, TextInput } from "../../ui/forms";
import { Loaded } from "../../ui/page";
import { Badge, Button, Card, EmptyState, type Tone } from "../../ui/primitives";

const STAGE_TONE: Record<A2pStage, Tone> = {
  draft: "warning",
  submitted: "neutral",
  campaign: "neutral",
  ready: "positive",
  needs_changes: "warning",
  suspended: "risk",
};
const STAGE_WORDS: Record<A2pStage, PlainKey> = {
  draft: "texting.stage.draft",
  submitted: "texting.stage.submitted",
  campaign: "texting.stage.campaign",
  ready: "texting.stage.ready",
  needs_changes: "texting.stage.needs_changes",
  suspended: "texting.stage.suspended",
};
const STAGE_HELP: Record<A2pStage, PlainKey> = {
  draft: "texting.stageHelp.draft",
  submitted: "texting.stageHelp.submitted",
  campaign: "texting.stageHelp.campaign",
  ready: "texting.stageHelp.ready",
  needs_changes: "texting.stageHelp.needs_changes",
  suspended: "texting.stageHelp.suspended",
};
const USE_WORDS: Record<A2pUse, PlainKey> = {
  team: "texting.uses.team",
  vendors: "texting.uses.vendors",
  customer_care: "texting.uses.customer_care",
};
const COMPANY_WORDS: Record<(typeof A2P_COMPANY_TYPES)[number], PlainKey> = {
  private: "texting.companyType.private",
  "non-profit": "texting.companyType.non-profit",
  government: "texting.companyType.government",
};

/** Twilio's industry codes as words: `FOOD_AND_BEVERAGE` → "Food and beverage". */
function industryWords(code: string): string {
  const w = code.toLowerCase().split("_").join(" ");
  return w.charAt(0).toUpperCase() + w.slice(1);
}

type Form = Omit<A2pBusinessDetails, "socialLinks"> & { socialLinks?: string | undefined };

const EMPTY: Form = {
  legalName: "",
  businessType: "Limited Liability Corporation",
  industry: "PROFESSIONAL_SERVICES",
  companyType: "private",
  website: "",
  regions: ["USA_AND_CANADA"],
  address: { street: "", city: "", region: "", postalCode: "", country: "US" },
  representative: {
    firstName: "",
    lastName: "",
    title: "",
    position: "CEO",
    phone: "",
    email: "",
  },
  volume: "low",
  uses: ["team", "vendors"],
  optIn: "",
  privacyPolicyUrl: "",
  termsUrl: "",
  hasLinks: false,
  hasPhoneNumbers: false,
};

export function PortalTextingRegistration() {
  const { t } = useI18n();
  const api = useApiClient();
  const state = useApi(apiRoutes.portalTextingRegistration);
  const reg = state.data?.registration;
  const [form, setForm] = useState<Form>(EMPTY);
  const [ein, setEin] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (reg?.details) setForm(reg.details);
  }, [reg?.details]);

  const set = (patch: Partial<Form>) => {
    setSaved(false);
    setForm((f) => ({ ...f, ...patch }));
  };
  const address = (patch: Partial<Form["address"]>) =>
    set({ address: { ...form.address, ...patch } });
  const rep = (patch: Partial<Form["representative"]>) =>
    set({ representative: { ...form.representative, ...patch } });

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { socialLinks, address: a, ...rest } = form;
      await api.call(apiRoutes.portalSaveTextingRegistration, {
        body: {
          details: {
            ...rest,
            address: { ...a, streetSecondary: a.streetSecondary || undefined },
            ...(socialLinks ? { socialLinks } : {}),
          },
          ...(ein.trim() ? { ein: ein.trim() } : {}),
        },
      });
      setEin("");
      setSaved(true);
      state.reload();
    } catch (err) {
      setError(isApiError(err) ? err.message : t("texting.problem"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Loaded state={state}>
      {() =>
        !reg?.available ? (
          <EmptyState>{t("texting.notAvailable")}</EmptyState>
        ) : (
          <div className="flex flex-col gap-4" data-testid="portal-texting">
            <Card pad title={t("texting.status")} testId="portal-texting-status">
              <div className="flex flex-col gap-2">
                <Badge tone={STAGE_TONE[reg.stage]} testId="portal-texting-stage">
                  {t(STAGE_WORDS[reg.stage])}
                </Badge>
                <p className="text-sm text-ink-muted">{t(STAGE_HELP[reg.stage])}</p>
                {reg.needs.length > 0 ? (
                  <div data-testid="portal-texting-needs">
                    <p className="text-sm font-medium text-ink">{t("texting.needs")}</p>
                    <ul className="list-disc pl-5 text-sm text-ink">
                      {reg.needs.map((n) => (
                        <li key={n}>{n}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <p className="text-sm text-ink-muted">{t("texting.fees")}</p>
              </div>
            </Card>
            {reg.editable ? (
              <form
                className="flex flex-col gap-4"
                onSubmit={save}
                data-testid="portal-texting-form"
              >
                <Card pad title={t("texting.business")}>
                  <div className="flex flex-col gap-3">
                    <Field label={t("texting.legalName")} hint={t("texting.legalNameHelp")}>
                      <TextInput
                        required
                        value={form.legalName}
                        onChange={(e) => set({ legalName: e.target.value })}
                        data-testid="portal-texting-legal-name"
                      />
                    </Field>
                    <div className="flex flex-wrap gap-3">
                      <Field label={t("texting.businessType")} className="min-w-56 flex-1">
                        <Select
                          value={form.businessType}
                          onChange={(e) =>
                            set({ businessType: e.target.value as Form["businessType"] })
                          }
                        >
                          {A2P_BUSINESS_TYPES.map((b) => (
                            <option key={b} value={b}>
                              {b}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <Field label={t("texting.industry")} className="min-w-56 flex-1">
                        <Select
                          value={form.industry}
                          onChange={(e) => set({ industry: e.target.value as Form["industry"] })}
                        >
                          {A2P_INDUSTRIES.map((i) => (
                            <option key={i} value={i}>
                              {industryWords(i)}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <Field label={t("texting.companyType")} className="min-w-56 flex-1">
                        <Select
                          value={form.companyType}
                          onChange={(e) =>
                            set({ companyType: e.target.value as Form["companyType"] })
                          }
                        >
                          {A2P_COMPANY_TYPES.map((c) => (
                            <option key={c} value={c}>
                              {t(COMPANY_WORDS[c])}
                            </option>
                          ))}
                        </Select>
                      </Field>
                    </div>
                    <Field label={t("texting.website")} hint={t("texting.websiteHelp")}>
                      <TextInput
                        required
                        type="url"
                        value={form.website}
                        onChange={(e) => set({ website: e.target.value })}
                        data-testid="portal-texting-website"
                      />
                    </Field>
                    <Field
                      label={t("texting.ein")}
                      hint={
                        reg.einSet && reg.einHint
                          ? t("texting.einSet", { hint: reg.einHint })
                          : t("texting.einHelp")
                      }
                    >
                      <TextInput
                        value={ein}
                        autoComplete="off"
                        inputMode="numeric"
                        placeholder={reg.einHint ?? "12-3456789"}
                        onChange={(e) => setEin(e.target.value)}
                        data-testid="portal-texting-ein"
                      />
                    </Field>
                  </div>
                </Card>
                <Card pad title={t("texting.address")}>
                  <div className="flex flex-wrap gap-3">
                    <Field label={t("texting.street")} className="min-w-64 flex-1">
                      <TextInput
                        required
                        value={form.address.street}
                        onChange={(e) => address({ street: e.target.value })}
                      />
                    </Field>
                    <Field label={t("texting.streetSecondary")} className="min-w-40 flex-1">
                      <TextInput
                        value={form.address.streetSecondary ?? ""}
                        onChange={(e) => address({ streetSecondary: e.target.value })}
                      />
                    </Field>
                    <Field label={t("texting.city")} className="min-w-40 flex-1">
                      <TextInput
                        required
                        value={form.address.city}
                        onChange={(e) => address({ city: e.target.value })}
                      />
                    </Field>
                    <Field label={t("texting.region")} className="w-24">
                      <TextInput
                        required
                        maxLength={2}
                        value={form.address.region}
                        onChange={(e) => address({ region: e.target.value.toUpperCase() })}
                      />
                    </Field>
                    <Field label={t("texting.postalCode")} className="w-32">
                      <TextInput
                        required
                        value={form.address.postalCode}
                        onChange={(e) => address({ postalCode: e.target.value })}
                      />
                    </Field>
                  </div>
                </Card>
                <Card pad title={t("texting.rep")}>
                  <div className="flex flex-wrap gap-3">
                    <Field label={t("texting.firstName")} className="min-w-40 flex-1">
                      <TextInput
                        required
                        value={form.representative.firstName}
                        onChange={(e) => rep({ firstName: e.target.value })}
                      />
                    </Field>
                    <Field label={t("texting.lastName")} className="min-w-40 flex-1">
                      <TextInput
                        required
                        value={form.representative.lastName}
                        onChange={(e) => rep({ lastName: e.target.value })}
                      />
                    </Field>
                    <Field label={t("texting.title")} className="min-w-40 flex-1">
                      <TextInput
                        required
                        value={form.representative.title}
                        onChange={(e) => rep({ title: e.target.value })}
                      />
                    </Field>
                    <Field label={t("texting.position")} className="min-w-40 flex-1">
                      <Select
                        value={form.representative.position}
                        onChange={(e) =>
                          rep({ position: e.target.value as Form["representative"]["position"] })
                        }
                      >
                        {A2P_POSITIONS.map((p) => (
                          <option key={p} value={p}>
                            {p}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field
                      label={t("texting.phone")}
                      hint={t("texting.phoneHelp")}
                      className="min-w-48 flex-1"
                    >
                      <TextInput
                        required
                        type="tel"
                        value={form.representative.phone}
                        onChange={(e) => rep({ phone: e.target.value.trim() })}
                      />
                    </Field>
                    <Field label={t("texting.email")} className="min-w-56 flex-1">
                      <TextInput
                        required
                        type="email"
                        value={form.representative.email}
                        onChange={(e) => rep({ email: e.target.value.trim() })}
                      />
                    </Field>
                  </div>
                </Card>
                <Card pad title={t("texting.texts")}>
                  <div className="flex flex-col gap-3">
                    <Field label={t("texting.volume")} className="max-w-xs">
                      <Select
                        value={form.volume}
                        onChange={(e) => set({ volume: e.target.value as Form["volume"] })}
                        data-testid="portal-texting-volume"
                      >
                        <option value="low">{t("texting.volume.low")}</option>
                        <option value="standard">{t("texting.volume.standard")}</option>
                      </Select>
                    </Field>
                    <fieldset className="flex flex-col gap-2">
                      <legend className="text-sm font-medium text-ink">{t("texting.uses")}</legend>
                      {A2P_USES.map((u) => (
                        <label key={u} className="flex items-center gap-2 text-sm text-ink">
                          <input
                            type="checkbox"
                            className="size-4 accent-slate"
                            checked={form.uses.includes(u)}
                            data-testid={`portal-texting-use-${u}`}
                            onChange={(e) =>
                              set({
                                uses: e.target.checked
                                  ? [...form.uses, u]
                                  : form.uses.filter((x) => x !== u),
                              })
                            }
                          />
                          {t(USE_WORDS[u])}
                        </label>
                      ))}
                      <p className="text-sm text-ink-muted">{t("texting.noMarketing")}</p>
                    </fieldset>
                    <Field label={t("texting.optIn")} hint={t("texting.optInHelp")}>
                      <TextArea
                        required
                        rows={3}
                        minLength={40}
                        value={form.optIn}
                        onChange={(e) => set({ optIn: e.target.value })}
                        data-testid="portal-texting-opt-in"
                      />
                    </Field>
                    <div className="flex flex-wrap gap-3">
                      <Field label={t("texting.privacy")} className="min-w-64 flex-1">
                        <TextInput
                          required
                          type="url"
                          value={form.privacyPolicyUrl}
                          onChange={(e) => set({ privacyPolicyUrl: e.target.value })}
                        />
                      </Field>
                      <Field label={t("texting.terms")} className="min-w-64 flex-1">
                        <TextInput
                          required
                          type="url"
                          value={form.termsUrl}
                          onChange={(e) => set({ termsUrl: e.target.value })}
                        />
                      </Field>
                    </div>
                    <label className="flex items-center gap-2 text-sm text-ink">
                      <input
                        type="checkbox"
                        className="size-4 accent-slate"
                        checked={form.hasLinks}
                        onChange={(e) => set({ hasLinks: e.target.checked })}
                      />
                      {t("texting.hasLinks")}
                    </label>
                    <label className="flex items-center gap-2 text-sm text-ink">
                      <input
                        type="checkbox"
                        className="size-4 accent-slate"
                        checked={form.hasPhoneNumbers}
                        onChange={(e) => set({ hasPhoneNumbers: e.target.checked })}
                      />
                      {t("texting.hasPhones")}
                    </label>
                  </div>
                </Card>
                {error ? (
                  <p className="ds-error text-sm" data-testid="portal-texting-error">
                    {error}
                  </p>
                ) : null}
                {saved ? (
                  <p className="text-sm text-ink" data-testid="portal-texting-saved">
                    {t("texting.saved")}
                  </p>
                ) : null}
                <Button
                  type="submit"
                  variant="primary"
                  className="self-start"
                  disabled={busy || form.uses.length === 0}
                  data-testid="portal-texting-save"
                >
                  {t("texting.save")}
                </Button>
              </form>
            ) : reg.stage === "ready" ? null : (
              <p className="text-sm text-ink-muted" data-testid="portal-texting-locked">
                {t("texting.locked")}
              </p>
            )}
          </div>
        )
      }
    </Loaded>
  );
}
