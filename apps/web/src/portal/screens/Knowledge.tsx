// `/knowledge` (client admin): the client's FAQs and policies, which our agents use when they answer
// for the client (docs/plan.md §1.21). Add one, edit it, archive it; every change is kept. Plain
// English for now: the languages stream moves these strings into message files.
import { useState } from "react";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { StatusFilter } from "../../inbox/StatusFilter";
import { type EntryActions, EntryForm, EntryList } from "../../knowledge/Entries";
import { Card, ErrorNotice, Loading, PageHeader, SectionLabel } from "../../ui/primitives";

type Show = "active" | "all";

export function PortalKnowledgeScreen() {
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
      <PageHeader
        title="Knowledge"
        subtitle="Your FAQs and policies. Our agents use them to answer for you. We keep every earlier version."
      />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <section className="order-2 xl:order-1">
          <SectionLabel
            action={
              <StatusFilter
                value={show}
                onChange={setShow}
                area="portal-knowledge"
                label="Which entries"
                options={[
                  ["active", "In use"],
                  ["all", "All, with archived"],
                ]}
              />
            }
          >
            FAQs and policies
          </SectionLabel>
          {loading && !data ? <Loading /> : null}
          {error ? <ErrorNotice error={error} onRetry={reload} /> : null}
          {data ? (
            <EntryList
              entries={data.entries}
              actions={actions}
              onChanged={reload}
              us="us"
              area="portal-knowledge"
              empty="Nothing here yet. Add a question you're often asked, or a policy, with the form."
            />
          ) : null}
        </section>
        <div className="order-1 xl:order-2">
          <Card className="p-5" testId="portal-knowledge-add">
            <SectionLabel>Add</SectionLabel>
            <EntryForm
              submitLabel="Add"
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
