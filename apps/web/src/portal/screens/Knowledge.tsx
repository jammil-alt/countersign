// `/knowledge` (client admin; UI-3a, drafted in the prototype's style): the client's FAQs and
// policies, which our agents use when they answer for the client (docs/plan.md §1.21). Add one,
// edit it, archive it; every change is kept. Words in the reader's language (docs/plan.md §1.18);
// the entries themselves stay as the client wrote them.
import { useState } from "react";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { useI18n } from "../../i18n/i18n";
import { StatusFilter } from "../../inbox/StatusFilter";
import { type EntryActions, EntryForm, EntryList } from "../../knowledge/Entries";
import { useSession } from "../../session/session";
import { Loaded, Page, PageGrid, Section } from "../../ui/page";
import { Card, PageHeader, Placeholder } from "../../ui/primitives";

type Show = "active" | "all";

export function PortalKnowledgeScreen() {
  const { t } = useI18n();
  const session = useSession();
  const client = session.tenants.find((c) => c.id === session.activeTenantId) ?? session.tenants[0];
  if (client?.role !== "client_admin") {
    return <Placeholder title={t("knowledge.title")}>{t("knowledge.adminOnly")}</Placeholder>;
  }
  return <Knowledge />;
}

function Knowledge() {
  const { t } = useI18n();
  const api = useApiClient();
  const [show, setShow] = useState<Show>("active");
  const state = useApi(apiRoutes.portalKnowledge, { query: { show } });

  const actions: EntryActions = {
    create: (body) => api.call(apiRoutes.portalKnowledgeCreate, { body }),
    edit: (id, body) => api.call(apiRoutes.portalKnowledgeEdit, { params: { id }, body }),
    archive: (id, baseVersion) =>
      api.call(apiRoutes.portalKnowledgeArchive, { params: { id }, body: { baseVersion } }),
  };

  return (
    <Page testId="portal-knowledge-page">
      <PageHeader title={t("knowledge.title")} subtitle={t("knowledge.subtitle")} />
      <PageGrid
        rail={
          <Card title={t("knowledge.add")} pad testId="portal-knowledge-add">
            <EntryForm
              submitLabel={t("knowledge.add")}
              testId="portal-knowledge-new"
              onSubmit={async (v) => {
                await actions.create(v);
                state.reload();
              }}
            />
          </Card>
        }
      >
        <Section
          title={t("knowledge.section")}
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
          <Loaded state={state}>
            {(data) => (
              <EntryList
                entries={data.entries}
                actions={actions}
                onChanged={state.reload}
                us={t("knowledge.us")}
                area="portal-knowledge"
                empty={t("knowledge.empty")}
              />
            )}
          </Loaded>
        </Section>
      </PageGrid>
    </Page>
  );
}
