// v0.14 capture: the capture a client's new WhatsApp conversations start with (docs/plan.md §1.55).
// The operator's alone, with a reason; someone who wasn't a contact before still starts with
// attachments off. Back office words, in English.
import {
  CAPTURE_ATTACHMENTS,
  CAPTURE_MAX_BYTES_CAP,
  type CaptureAttachments,
} from "@countersign/core";
import { type FormEvent, useEffect, useState } from "react";
import { isApiError } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { Field, Select, TextInput } from "../../ui/forms";
import { Button, Card, ErrorNotice, SectionLabel } from "../../ui/primitives";

const LABEL: Record<CaptureAttachments, string> = {
  off: "Off",
  documents: "PDFs and images",
  all: "All files",
};
const MB = 1024 * 1024;

export function CaptureDefault({ clientId }: { clientId: string }) {
  const api = useApiClient();
  const current = useApi(apiRoutes.opsCaptureDefault, { params: { id: clientId } });
  const [archive, setArchive] = useState(true);
  const [attachments, setAttachments] = useState<CaptureAttachments>("off");
  const [maxMb, setMaxMb] = useState("20");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    const c = current.data?.capture;
    if (!c) return;
    setArchive(c.archive);
    setAttachments(c.attachments);
    setMaxMb(String(Math.round(c.maxBytes / MB)));
  }, [current.data]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setNote(null);
    const maxBytes = Math.min(CAPTURE_MAX_BYTES_CAP, Math.max(1, Math.round(Number(maxMb) * MB)));
    try {
      await api.call(apiRoutes.opsSetCaptureDefault, {
        params: { id: clientId },
        body: { capture: { archive, attachments, maxBytes }, ...(reason ? { reason } : {}) },
      });
      setNote("Saved. New conversations start with this.");
      setReason("");
      current.reload();
    } catch (error) {
      setNote(isApiError(error) ? error.message : "That didn't work. Try again.");
    }
  }

  return (
    <section className="mb-6" data-testid="capture-default">
      <SectionLabel>New WhatsApp conversations</SectionLabel>
      {current.error ? <ErrorNotice error={current.error} onRetry={current.reload} /> : null}
      <Card className="p-3">
        <form className="flex flex-wrap items-end gap-4" onSubmit={save}>
          <Field label="Keep messages" className="w-36">
            <Select
              value={archive ? "yes" : "no"}
              onChange={(e) => setArchive(e.target.value === "yes")}
            >
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </Select>
          </Field>
          <Field label="Download attachments" className="w-48">
            <Select
              value={attachments}
              onChange={(e) => setAttachments(e.target.value as CaptureAttachments)}
            >
              {CAPTURE_ATTACHMENTS.map((a) => (
                <option key={a} value={a}>
                  {LABEL[a]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Largest file (MB)" hint="32 at most" className="w-36">
            <TextInput
              type="number"
              min={1}
              max={32}
              value={maxMb}
              onChange={(e) => setMaxMb(e.target.value)}
            />
          </Field>
          <Field label="Reason" className="min-w-48 grow">
            <TextInput value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <Button type="submit" variant="primary">
            Save default
          </Button>
        </form>
        <p className="mt-2 text-sm text-ink-muted">
          Someone who wasn't a contact before starts with attachments off.
        </p>
        {note ? <p className="mt-1 text-sm text-ink-muted">{note}</p> : null}
      </Card>
    </section>
  );
}
