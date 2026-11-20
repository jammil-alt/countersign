// `/knowledge` (client admin; UI-3a, drafted in the prototype's style): the client's FAQs and
// policies, which our agents use when they answer for the client (docs/plan.md §1.21). Add one,
// edit it, archive it; every change is kept. Words in the reader's language (docs/plan.md §1.18);
// the entries themselves stay as the client wrote them.
// B6 (docs/builder-plan.md §8): the client's charter on top, with Confirm and Edit (we draft it from
// onboarding; agents follow it once confirmed), and "How Mezonas agents work" read only beside it.
import { useState } from "react";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { useI18n } from "../../i18n/i18n";
import { StatusFilter } from "../../inbox/StatusFilter";
import { ActionButton, CharterCard, charterOf, HowAgentsWork } from "../../knowledge/Charter";
import { createInput, type EntryActions, EntryForm, EntryList } from "../../knowledge/Entries";
import { useSession } from "../../session/session";
import { Loaded, Page, PageGrid, Section } from "../../ui/page";
import { Button, Card, PageHeader, Placeholder } from "../../ui/primitives";

type Show = "active" | "all";

/** `embedded`: inside Settings (its Charter and policies section), without a header of its own. */
export function PortalKnowledgeScreen({ embedded = false }: { embedded?: boolean } = {}) {
  const { t } = useI18n();
  const session = useSession();
  const client = session.tenants.find((c) => c.id === session.activeTenantId) ?? session.tenants[0];
  if (client?.role !== "client_admin") {
    return <Placeholder title={t("knowledge.title")}>{t("knowledge.adminOnly")}</Placeholder>;
  }
  return <Knowledge embedded={embedded} />;
}

function Knowledge({ embedded }: { embedded: boolean }) {
  const { t } = useI18n();
  const api = useApiClient();
  const [show, setShow] = useState<Show>("active");
  const [editingCharter, setEditingCharter] = useState(false);
  const state = useApi(apiRoutes.portalKnowledge, { query: { show } });

  const actions: EntryActions = {
    create: (body) => api.call(apiRoutes.portalKnowledgeCreate, { body }),
    edit: (id, body) => api.call(apiRoutes.portalKnowledgeEdit, { params: { id }, body }),
    archive: (id, baseVersion) =>
      api.call(apiRoutes.portalKnowledgeArchive, { params: { id }, body: { baseVersion } }),
  };

  const grid = (
    <PageGrid
      rail={
        <div className="flex flex-col gap-6">
          <Card title={t("knowledge.add")} pad testId="portal-knowledge-add">
            <EntryForm
              submitLabel={t("knowledge.add")}
              testId="portal-knowledge-new"
              onSubmit={async (v) => {
                await actions.create(createInput(v));
                state.reload();
              }}
            />
          </Card>
          <HowAgentsWork testId="portal-knowledge-how" />
        </div>
      }
    >
      <Loaded state={state}>
        {(data) => {
          const charter = charterOf(data.entries);
          const rest = data.entries.filter((e) => e.id !== charter?.id);
          return (
            <>
              <Section title={t("knowledge.charter.section")}>
                <p className="mb-3 text-sm text-ink-muted">{t("knowledge.charter.intro")}</p>
                {charter && editingCharter ? (
                  <Card className="p-5" testId="portal-knowledge-charter-editing">
                    <EntryForm
                      initial={charter}
                      submitLabel={t("common.save")}
                      testId="portal-knowledge-charter-edit"
                      onCancel={() => setEditingCharter(false)}
                      onSubmit={async (v) => {
                        await actions.edit(charter.id, {
                          title: v.title,
                          body: v.body,
                          baseVersion: charter.version,
                        });
                        setEditingCharter(false);
                        state.reload();
                      }}
                    />
                  </Card>
                ) : (
                  <CharterCard
                    entry={charter}
                    audience="portal"
                    area="portal-knowledge"
                    none={t("knowledge.charter.none")}
                    actions={
                      charter ? (
                        <>
                          {charter.confirmed ? null : (
                            <ActionButton
                              variant="primary"
                              label={t("knowledge.charter.confirm")}
                              busyLabel={t("knowledge.charter.confirming")}
                              failed={t("knowledge.charter.problem")}
                              testId="portal-knowledge-charter-confirm"
                              run={async () => {
                                await api.call(apiRoutes.portalKnowledgeConfirm, {
                                  params: { id: charter.id },
                                  body: { baseVersion: charter.version },
                                });
                                state.reload();
                              }}
                            />
                          )}
                          <Button
                            size="sm"
                            data-testid="portal-knowledge-charter-edit-open"
                            onClick={() => setEditingCharter(true)}
                          >
                            {t("knowledge.edit")}
                          </Button>
                        </>
                      ) : undefined
                    }
                  />
                )}
              </Section>
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
                <EntryList
                  entries={rest}
                  actions={actions}
                  onChanged={state.reload}
                  us={t("knowledge.us")}
                  area="portal-knowledge"
                  empty={t("knowledge.empty")}
                />
              </Section>
            </>
          );
        }}
      </Loaded>
    </PageGrid>
  );
  if (embedded) return <div data-testid="portal-knowledge-page">{grid}</div>;
  return (
    <Page testId="portal-knowledge-page">
      <PageHeader title={t("knowledge.title")} subtitle={t("knowledge.subtitle")} />
      {grid}
    </Page>
  );
}
