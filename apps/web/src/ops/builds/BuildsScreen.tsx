// `/ops/builds/:id` (docs/plan.md §1.108): the build itself (BuildView). The board of every build
// by phase is the Agent lab's Drafts tab, and New there starts one (owner, 2026-11-17); the old
// `/ops/builds` address redirects to it (../routes.tsx).
import { useParams } from "react-router-dom";
import { Page } from "../../ui/page";
import { BuildView } from "./BuildView";

export function BuildScreen() {
  const { id } = useParams();
  if (!id) return null;
  return (
    <Page testId="build">
      <BuildView key={id} id={id} />
    </Page>
  );
}
