// A requirements request on the client admin's Desk (docs/plan.md §1.124.1; cases-plan §3.2): the
// new agent's intake questions, some filled in from what we know. A draft is saved as they go and
// the answers sent once; the operator sees how many are answered.
import type { PortalRequirementsForm } from "@countersign/core";
import { useState } from "react";
import { useParams } from "react-router-dom";
import { apiRoutes } from "../api/routes";
import { useApi, useApiClient } from "../api/useApi";
import { useI18n } from "../i18n/i18n";
import { Field, Select, TextArea } from "../ui/forms";
import { Loaded, Page } from "../ui/page";
import { Button, Card, PageHeader } from "../ui/primitives";

export function RequirementsScreen() {
  const { itemId = "" } = useParams();
  const state = useApi(apiRoutes.portalRequirements, { params: { id: itemId } });
  return (
    <Page width="narrow" testId="portal-requirements">
      <Loaded state={state}>{(form) => <Form form={form} />}</Loaded>
    </Page>
  );
}

function Form({ form }: { form: PortalRequirementsForm }) {
  const { t, fmt } = useI18n();
  const api = useApiClient();
  const [answers, setAnswers] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const f of form.fields) out[f.key] = form.answers[f.key] ?? f.prefill?.value ?? "";
    return out;
  });
  const [current, setCurrent] = useState(form);
  const [busy, setBusy] = useState(false);
  const save = async (submit: boolean) => {
    setBusy(true);
    try {
      const route = submit ? apiRoutes.portalSubmitRequirements : apiRoutes.portalSaveRequirements;
      setCurrent(await api.call(route, { params: { id: form.itemId }, body: { answers } }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageHeader
        title={t("requirements.title")}
        subtitle={
          current.dueOn ? t("requirements.due", { date: fmt.date(current.dueOn) }) : undefined
        }
      />
      <p className="mb-4 text-sm text-ink-muted" data-testid="requirements-progress">
        {t("requirements.progress", {
          answered: String(current.answered),
          total: String(current.total),
        })}
      </p>
      {current.submitted ? <p data-testid="requirements-sent">{t("requirements.sent")}</p> : null}
      <Card pad>
        <div className="flex flex-col gap-4">
          {form.fields.map((f) => (
            <Field key={f.key} label={f.label} hint={f.hint}>
              {f.kind === "choice" && f.choices ? (
                <Select
                  value={answers[f.key] ?? ""}
                  disabled={current.submitted}
                  onChange={(e) => setAnswers((a) => ({ ...a, [f.key]: e.target.value }))}
                >
                  <option value="" />
                  {f.choices.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </Select>
              ) : (
                <TextArea
                  rows={2}
                  value={answers[f.key] ?? ""}
                  disabled={current.submitted}
                  onChange={(e) => setAnswers((a) => ({ ...a, [f.key]: e.target.value }))}
                />
              )}
            </Field>
          ))}
          {current.submitted ? null : (
            <div className="flex gap-2">
              <Button disabled={busy} onClick={() => void save(false)}>
                {t("requirements.save")}
              </Button>
              <Button variant="primary" disabled={busy} onClick={() => void save(true)}>
                {t("requirements.submit")}
              </Button>
            </div>
          )}
        </div>
      </Card>
    </>
  );
}
