// docs/plan.md §1.212: one click turns an approved or corrected change into a test case of the
// template its agent came from (the client's case: it runs and shows in that client only).
import { evalsRoutes } from "@countersign/core";
import { useState } from "react";
import { useApiClient } from "../../api/useApi";
import { Button, ErrorNotice } from "../../ui/primitives";

export function SaveAsCase({ itemId }: { itemId: string }) {
  const api = useApiClient();
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const out = await api.call(evalsRoutes.opsSaveCaseFromInbox, {
        params: { id: itemId },
        body: {},
      });
      setSaved(out.created ? "Saved as a test case." : "Already saved as a test case.");
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  if (saved) {
    return (
      <p className="text-sm text-ink-muted" data-testid={`save-case-${itemId}-done`}>
        {saved}
      </p>
    );
  }
  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        size="sm"
        variant="ghost"
        working={busy}
        data-testid={`save-case-${itemId}`}
        onClick={() => void save()}
      >
        Save as a test case
      </Button>
      {error ? <ErrorNotice error={error} /> : null}
    </div>
  );
}
