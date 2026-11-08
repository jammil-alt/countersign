// P-8: the back office's review of a client's US texting registration (docs/plan.md §1.70). The
// operator reads the client's details (the EIN only as a masked hint), Twilio's statuses and
// reasons, may edit the campaign's words, reads the fees this submit charges, gives a reason and
// submits. Back office: English only.
import type {
  A2pCampaignText,
  A2pRegistrationView,
  A2pStage,
  MessagingSetup,
} from "@countersign/core";
import { useState } from "react";
import { apiRoutes } from "../../api/routes";
import { useApiClient } from "../../api/useApi";
import { Field, TextArea, TextInput } from "../../ui/forms";
import { Badge, Button, Card, SectionLabel, type Tone } from "../../ui/primitives";

const STAGE: Record<A2pStage, { label: string; tone: Tone }> = {
  draft: { label: "Waiting on details", tone: "neutral" },
  submitted: { label: "With Twilio", tone: "accent" },
  campaign: { label: "Campaign in review", tone: "accent" },
  ready: { label: "Texting is ready", tone: "positive" },
  needs_changes: { label: "Needs changes", tone: "risk" },
  suspended: { label: "On hold", tone: "risk" },
};

const MISSING: Record<string, string> = {
  details: "the client's business details",
  ein: "the EIN",
  stage: "Twilio's answer (it has the registration now)",
  settings: "TWILIO_PRIMARY_PROFILE_SID and TWILIO_A2P_EMAIL on this deployment",
};

type Act = (call: () => Promise<{ setup: MessagingSetup }>) => Promise<void>;

const usd = (v: string) => `$${Number.parseFloat(v).toFixed(2)}`;

export function A2pRegistrationPanel({
  clientId,
  registration: r,
  busy,
  act,
}: {
  clientId: string;
  registration: A2pRegistrationView;
  busy: boolean;
  act: Act;
}) {
  const api = useApiClient();
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [edit, setEdit] = useState<A2pCampaignText | null>(null);
  const stage = STAGE[r.stage];
  const campaign = edit ?? r.campaign;
  const canSubmit = r.missing.length === 0 && reason.trim().length >= 3 && confirmed && !busy;
  const d = r.details;
  return (
    <div className="flex flex-col gap-4" data-testid="ops-a2p-registration">
      <div className="flex items-center gap-2">
        <Badge tone={stage.tone} testId="ops-a2p-stage">
          {stage.label}
        </Badge>
        <span className="text-sm text-ink-muted">
          {r.brandType === "standard" ? "Standard brand" : "Low-Volume Standard brand"}, use case{" "}
          {r.useCase}. Never marketing.
        </span>
      </div>

      {d ? (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm" data-testid="ops-a2p-details">
          <dt className="text-ink-muted">Legal name</dt>
          <dd>{d.legalName}</dd>
          <dt className="text-ink-muted">EIN</dt>
          <dd data-testid="ops-a2p-ein">{r.einHint ?? "Not given"}</dd>
          <dt className="text-ink-muted">Type, industry</dt>
          <dd>
            {d.businessType}, {d.industry}, {d.companyType}
          </dd>
          <dt className="text-ink-muted">Website</dt>
          <dd>{d.website}</dd>
          <dt className="text-ink-muted">Address</dt>
          <dd>
            {d.address.street}, {d.address.city}, {d.address.region} {d.address.postalCode}
          </dd>
          <dt className="text-ink-muted">Representative</dt>
          <dd>
            {d.representative.firstName} {d.representative.lastName}, {d.representative.title} (
            {d.representative.email}, {d.representative.phone})
          </dd>
          <dt className="text-ink-muted">Texts to</dt>
          <dd>{d.uses.join(", ")}</dd>
          <dt className="text-ink-muted">Volume</dt>
          <dd>{d.volume === "standard" ? "6,000 or more a day" : "Fewer than 6,000 a day"}</dd>
        </dl>
      ) : (
        <p className="text-sm text-ink-muted">
          The client admin hasn't given the business details yet (portal, Settings, US texting).
        </p>
      )}

      {r.statuses.brand || r.statuses.customerProfile ? (
        <p className="text-sm text-ink-muted" data-testid="ops-a2p-statuses">
          Profile {r.statuses.customerProfile ?? "none"}, trust product{" "}
          {r.statuses.trustProduct ?? "none"}, brand {r.statuses.brand ?? "none"}, campaign{" "}
          {r.statuses.campaign ?? "none"}. Brand updates used: {r.brandUpdates} of 3.
        </p>
      ) : null}

      {r.issues.length > 0 ? (
        <Card className="p-4" testId="ops-a2p-issues">
          <SectionLabel>What Twilio said</SectionLabel>
          <ul className="list-disc pl-5 text-sm">
            {r.issues.map((i) => (
              <li key={`${i.source}-${i.code}-${i.description}`}>
                {i.words}
                {i.code ? <span className="text-ink-muted"> (code {i.code})</span> : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {campaign && (r.stage === "draft" || r.stage === "needs_changes") ? (
        <div className="flex flex-col gap-3" data-testid="ops-a2p-campaign">
          <SectionLabel>Campaign words{r.campaignEdited || edit ? " (edited)" : ""}</SectionLabel>
          <Field label="Description">
            <TextArea
              rows={3}
              value={campaign.description}
              onChange={(e) => setEdit({ ...campaign, description: e.target.value })}
              data-testid="ops-a2p-description"
            />
          </Field>
          {campaign.samples.map((s, i) => (
            <Field key={`sample-${i.toString()}`} label={`Sample ${i + 1}`}>
              <TextArea
                rows={2}
                value={s}
                onChange={(e) =>
                  setEdit({
                    ...campaign,
                    samples: campaign.samples.map((x, k) => (k === i ? e.target.value : x)),
                  })
                }
                data-testid={`ops-a2p-sample-${i}`}
              />
            </Field>
          ))}
          <Field label="How people agree (message flow)">
            <TextArea
              rows={3}
              value={campaign.messageFlow}
              onChange={(e) => setEdit({ ...campaign, messageFlow: e.target.value })}
            />
          </Field>
        </div>
      ) : null}

      {r.stage === "draft" || r.stage === "needs_changes" ? (
        <Card className="p-4" testId="ops-a2p-fees">
          <SectionLabel>
            What this submit charges (Twilio's fees, passed to the client)
          </SectionLabel>
          <ul className="text-sm">
            {r.fees.lines.map((l) => (
              <li key={l.kind} className="flex justify-between gap-4">
                <span>{l.label}</span>
                <span>
                  {usd(l.amountUsd)}
                  {l.monthly ? " a month" : ""}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-sm" data-testid="ops-a2p-fees-now">
            Charged by this submit and the campaign: {usd(r.fees.nowUsd)}, then the monthly fee.
            Recorded as the client's credits.
          </p>
          <form
            className="mt-3 flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!canSubmit) return;
              void act(() =>
                api.call(apiRoutes.opsA2pSubmit, {
                  params: { id: clientId },
                  body: {
                    reason: reason.trim(),
                    confirmFees: true,
                    ...(edit ? { campaign: edit } : {}),
                  },
                }),
              ).then(() => {
                setReason("");
                setConfirmed(false);
                setEdit(null);
              });
            }}
          >
            {r.missing.length > 0 ? (
              <p className="text-sm" data-testid="ops-a2p-missing">
                Can't submit yet: {r.missing.map((m) => MISSING[m] ?? m).join("; ")}.
              </p>
            ) : null}
            <Field label="Why you are submitting">
              <TextInput
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                data-testid="ops-a2p-reason"
              />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-slate"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                data-testid="ops-a2p-confirm"
              />
              I read the fees above
            </label>
            <Button
              type="submit"
              variant="primary"
              disabled={!canSubmit}
              data-testid="ops-a2p-submit"
            >
              {r.stage === "needs_changes" ? "Submit again to Twilio" : "Submit to Twilio"}
            </Button>
          </form>
        </Card>
      ) : null}

      {r.recorded.length > 0 ? (
        <p className="text-sm text-ink-muted" data-testid="ops-a2p-recorded">
          Fees recorded: {r.recorded.map((f) => `${f.kind} ${usd(f.amountUsd)}`).join(", ")}.
        </p>
      ) : null}
      {r.submissions.length > 0 ? (
        <p className="text-sm text-ink-muted">
          Last submitted{" "}
          {new Date(r.submissions[r.submissions.length - 1]?.at ?? "").toLocaleString()} by{" "}
          {r.submissions[r.submissions.length - 1]?.by}: "
          {r.submissions[r.submissions.length - 1]?.reason}"
        </p>
      ) : null}
    </div>
  );
}
