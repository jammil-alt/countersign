// The client page's language (docs/plan.md §1.18): the client's default for its portal and what its
// agents write for it. The client admin can change it too; each client user may choose their own.
// The back office itself stays in English.
import { clientLanguage, LOCALE_NAMES, LOCALES, parseLocale } from "@countersign/core";
import { useState } from "react";
import { apiRoutes } from "../../api/routes";
import { useApiClient } from "../../api/useApi";
import { Field, Select } from "../../ui/forms";
import { Card, ErrorNotice, SectionLabel } from "../../ui/primitives";

export function ClientLanguageSetting({
  clientId,
  settings,
  onSaved,
}: {
  clientId: string;
  settings: Record<string, unknown>;
  onSaved: () => void;
}) {
  const api = useApiClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const current = clientLanguage(settings);

  async function save(value: string) {
    const language = parseLocale(value);
    if (!language) return;
    setBusy(true);
    setError(null);
    try {
      await api.call(apiRoutes.opsSetClientLanguage, {
        params: { id: clientId },
        body: { language },
      });
      onSaved();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-8" data-testid="ops-client-language">
      <SectionLabel>Language</SectionLabel>
      <Card className="flex flex-col gap-3 p-5">
        <Field
          label="The client's language"
          hint="Their portal and what their agents write for them. People there can still choose their own."
          className="max-w-sm"
        >
          <Select
            data-testid="ops-client-language-select"
            value={current ?? ""}
            disabled={busy}
            onChange={(e) => void save(e.target.value)}
          >
            {current ? null : (
              <option value="" disabled>
                Not set: each person's browser language, else English
              </option>
            )}
            {LOCALES.map((l) => (
              <option key={l} value={l}>
                {LOCALE_NAMES[l]}
              </option>
            ))}
          </Select>
        </Field>
        {error ? <ErrorNotice error={error} /> : null}
      </Card>
    </section>
  );
}
