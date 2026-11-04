// `/knowledge` (client admin): the client's FAQs and policies, which our agents use when they answer
// for the client (docs/plan.md §1.21). Add one, edit it, archive it; every change is kept. Words in
// the reader's language (docs/plan.md §1.18); the entries themselves stay as the client wrote them.
import { useState } from "react";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { useI18n } from "../../i18n/i18n";
import { StatusFilter } from "../../inbox/StatusFilter";
import { type EntryActions, EntryForm, EntryList } from "../../knowledge/Entries";
import { Card, ErrorNotice, Loading, PageHeader, SectionLabel } from "../../ui/primitives";

type Show = "active" | "all";

export function PortalKnowledgeScreen() {
  const { t } = useI18n();
  const api = useApiClient();
  const [show, setShow] = useState<Show>("active");
  const { data, error, loading, reload } = useApi(apiRoutes.portalKnowledge, { query: { show } });

  const actions: EntryActions = {
    create: (body) => api.call(apiRoutes.portalKnowledgeCreate, { body }),
    edit: (id, body) => api.call(apiRoutes.portalKnowledgeEdit, { params: { id }, body }),
    archive: (id, baseVersion) =>
      api.call(apiRoutes.portalKnowledgeArchive, { params: { id }, body: { baseVersion } }),
  };

  return (
    <div className="max-w-5xl">
      <PageHeader title={t("knowledge.title")} subtitle={t("knowledge.subtitle")} />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <section className="order-2 xl:order-1">
          <SectionLabel
            action={
              <StatusFilter
                value={show}
                onChange={setShow}
                area="portal-knowledge"
                label={t("knowledge.which")}
                options={[
                  ["active", t("knowledge.show.active")],
                  ["all", t("knowledge.show.all")],
                ]}
              />
            }
          >
            {t("knowledge.section")}
          </SectionLabel>
          {loading && !data ? <Loading /> : null}
          {error ? <ErrorNotice error={error} onRetry={reload} /> : null}
          {data ? (
            <EntryList
              entries={data.entries}
              actions={actions}
              onChanged={reload}
              us={t("knowledge.us")}
              area="portal-knowledge"
              empty={t("knowledge.empty")}
            />
          ) : null}
        </section>
        <div className="order-1 xl:order-2">
          <Card className="p-5" testId="portal-knowledge-add">
            <SectionLabel>{t("knowledge.add")}</SectionLabel>
            <EntryForm
              submitLabel={t("knowledge.add")}
              testId="portal-knowledge-new"
              onSubmit={async (v) => {
                await actions.create(v);
                reload();
              }}
            />
          </Card>
        </div>
      </div>
    </div>
  );
}
