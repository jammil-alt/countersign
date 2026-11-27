// Sandbox inbound (2026-11-27): on a Sandbox agent's Workflow tab, under its triggers. Its email
// address, whose first part the operator may name (PUT /api/ops/agents/:id/address), with Copy;
// and "Send a test message": an email, text or WhatsApp from one of the Sandbox's contacts, with
// files uploaded to the Sandbox and kept quiet (`?for=try`), that goes in as a received one would
// (POST /api/ops/sandbox/test-messages) and links to the run it started.
import type { AgentTriggers, TestMessageAnswer, TestMessageChannel } from "@countersign/core";
import { useState } from "react";
import { Link } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { sandboxUploadPath, uploadFiles } from "../../api/upload";
import { useApi } from "../../api/useApi";
import { Field, Select, TextArea, TextInput } from "../../ui/forms";
import { Button, Card } from "../../ui/primitives";
import { errorText, Notice, useAction } from "../agents/ui";

/** A file for a test message: uploaded to the Sandbox and kept quiet, as a try's is. */
function sandboxUpload(file: File, clientId: string): ReturnType<typeof uploadFiles> {
  return uploadFiles([file], undefined, `${sandboxUploadPath(clientId)}?for=try`);
}

const CHANNELS: { id: TestMessageChannel; label: string }[] = [
  { id: "email", label: "Email" },
  { id: "sms", label: "Text" },
  { id: "whatsapp", label: "WhatsApp" },
];

/** The first part of an address: what comes before the first dot. */
export function addressName(address: string): string {
  return address.slice(0, address.indexOf("."));
}

export function SandboxInbound({
  agentId,
  clientId,
  name,
  fired,
  onChanged,
  upload = sandboxUpload,
}: {
  agentId: string;
  clientId: string;
  /** The agent's name, for the words. */
  name: string;
  fired: Pick<AgentTriggers, "address" | "inboundName" | "commandName">;
  /** After the address changed: read the triggers again. */
  onChanged(): void;
  /** The Sandbox upload (tests pass their own). */
  upload?: (file: File, clientId: string) => ReturnType<typeof uploadFiles>;
}) {
  return (
    <Card title="Try it with a message" testId="sandbox-inbound">
      <div className="flex flex-col gap-6">
        <AddressField agentId={agentId} name={name} fired={fired} onChanged={onChanged} />
        <TestMessage agentId={agentId} clientId={clientId} name={name} upload={upload} />
      </div>
    </Card>
  );
}

function AddressField({
  agentId,
  name,
  fired,
  onChanged,
}: {
  agentId: string;
  name: string;
  fired: Pick<AgentTriggers, "address" | "inboundName" | "commandName">;
  onChanged(): void;
}) {
  const current = fired.address ? addressName(fired.address) : (fired.inboundName ?? "");
  const [draft, setDraft] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const action = useAction();
  const value = draft ?? current;

  async function save(next: string | null) {
    const res = await action.call(apiRoutes.opsAgentAddress, {
      params: { id: agentId },
      body: { name: next },
    });
    if (res.ok) {
      setDraft(null);
      setCopied(false);
      onChanged();
    }
  }

  if (!fired.address) {
    return (
      <p className="text-sm text-ink-muted" data-testid="sandbox-address-none">
        {name} gets its email address once it's on. Start its trial in the Sandbox first.
      </p>
    );
  }
  const changed = draft !== null && draft.trim().toLowerCase() !== current;
  return (
    <div className="flex flex-col gap-3" data-testid="sandbox-address">
      <Field
        label="Email address"
        hint={`Mail to it from one of the Sandbox's people starts ${name}, as a client's would. /${fired.commandName ?? current} in a thread follows it.`}
      >
        <div className="flex flex-wrap items-center gap-2">
          <TextInput
            aria-label="First part of the address"
            className="w-48"
            value={value}
            maxLength={30}
            onChange={(e) => setDraft(e.target.value)}
            data-testid="sandbox-address-name"
          />
          <span className="min-w-0 break-all font-mono text-sm text-ink-muted">
            {fired.address.slice(current.length)}
          </span>
        </div>
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        {changed ? (
          <Button
            size="sm"
            variant="primary"
            working={action.busy}
            onClick={() => void save(value.trim().toLowerCase())}
            data-testid="sandbox-address-save"
          >
            Save the address
          </Button>
        ) : (
          <Button
            size="sm"
            onClick={async () => {
              await navigator.clipboard.writeText(fired.address as string);
              setCopied(true);
            }}
            data-testid="sandbox-address-copy"
          >
            {copied ? "Copied" : "Copy"}
          </Button>
        )}
        {fired.inboundName && !changed ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={action.busy}
            onClick={() => void save(null)}
            data-testid="sandbox-address-reset"
          >
            Use {name}'s own name
          </Button>
        ) : null}
        <span className="font-mono text-sm text-ink" data-testid="sandbox-address-full">
          {fired.address}
        </span>
      </div>
      {action.error ? (
        <Notice tone="warning" testId="sandbox-address-error">
          {errorText(action.error)}
        </Notice>
      ) : null}
    </div>
  );
}

function TestMessage({
  agentId,
  clientId,
  name,
  upload,
}: {
  agentId: string;
  clientId: string;
  name: string;
  upload: (file: File, clientId: string) => ReturnType<typeof uploadFiles>;
}) {
  const contacts = useApi(apiRoutes.opsContacts, { params: { id: clientId } });
  const [channel, setChannel] = useState<TestMessageChannel>("email");
  const [fromId, setFromId] = useState("");
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const [files, setFiles] = useState<{ id: string; filename: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<TestMessageAnswer | null>(null);
  const action = useAction();
  const people = contacts.data?.items ?? [];
  const from = fromId || people[0]?.id || "";

  async function attach(list: FileList | null) {
    if (!list || list.length === 0) return;
    setUploading(true);
    setUploadError(null);
    try {
      for (const file of [...list]) {
        const res = await upload(file, clientId);
        for (const r of res.results) {
          if (r.kind === "document" && r.document) {
            const doc = r.document;
            setFiles((was) =>
              was.some((f) => f.id === doc.id)
                ? was
                : [...was, { id: doc.id, filename: r.filename }],
            );
          } else {
            setUploadError(`${r.filename}: ${r.error ?? "only PDFs and images go with a message"}`);
          }
        }
      }
    } catch (e) {
      setUploadError(errorText(e));
    } finally {
      setUploading(false);
    }
  }

  async function send() {
    if (!from) return;
    setAnswer(null);
    const res = await action.call(apiRoutes.opsSandboxTestMessage, {
      body: {
        agentId,
        channel,
        fromContactId: from,
        ...(channel === "email" && subject.trim() ? { subject: subject.trim() } : {}),
        text,
        ...(files.length > 0 ? { documentIds: files.map((f) => f.id) } : {}),
      },
    });
    if (res.ok) setAnswer(res.data);
  }

  return (
    <div
      className="flex flex-col gap-3 border-t border-line pt-5"
      data-testid="sandbox-test-message"
    >
      <div className="flex flex-col gap-1">
        <h4 className="font-medium text-ink">Send a test message</h4>
        <p className="text-sm text-ink-muted">
          It goes in as a message received from that person would, with no email or text sent. A run
          it starts is live: every write waits for a signature in the trial.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="By">
          <Select
            value={channel}
            onChange={(e) => setChannel(e.target.value as TestMessageChannel)}
            data-testid="sandbox-test-channel"
          >
            {CHANNELS.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="From"
          hint={
            people.length === 0 && !contacts.loading
              ? "Add people to the Sandbox first."
              : undefined
          }
        >
          <Select
            value={from}
            onChange={(e) => setFromId(e.target.value)}
            disabled={people.length === 0}
            data-testid="sandbox-test-from"
          >
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {channel === "email" ? (
        <Field label="Subject">
          <TextInput
            value={subject}
            maxLength={300}
            onChange={(e) => setSubject(e.target.value)}
            data-testid="sandbox-test-subject"
          />
        </Field>
      ) : null}
      <Field label="Message">
        <TextArea
          autoSize
          rows={3}
          value={text}
          maxLength={20000}
          onChange={(e) => setText(e.target.value)}
          data-testid="sandbox-test-text"
        />
      </Field>
      <Field label="Attachments" hint="PDFs and images, kept in the Sandbox.">
        <input
          type="file"
          multiple
          accept="application/pdf,image/*"
          disabled={uploading}
          onChange={(e) => {
            void attach(e.target.files);
            e.target.value = "";
          }}
          data-testid="sandbox-test-files"
        />
      </Field>
      {files.length > 0 ? (
        <ul className="flex flex-wrap gap-2 text-sm" data-testid="sandbox-test-attached">
          {files.map((f) => (
            <li
              key={f.id}
              className="flex items-center gap-1 rounded-sm border border-line px-2 py-1"
            >
              <span className="text-ink">{f.filename}</span>
              <button
                type="button"
                className="text-link hover:underline"
                onClick={() => setFiles((was) => was.filter((x) => x.id !== f.id))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {uploadError ? <Notice tone="warning">{uploadError}</Notice> : null}
      <div>
        <Button
          variant="primary"
          size="sm"
          working={action.busy}
          disabled={!from || uploading || (text.trim() === "" && files.length === 0)}
          onClick={() => void send()}
          data-testid="sandbox-test-send"
        >
          Send to {name}
        </Button>
      </div>
      {action.error ? (
        <Notice tone="warning" testId="sandbox-test-error">
          {errorText(action.error)}
        </Notice>
      ) : null}
      {answer ? <Answer answer={answer} name={name} /> : null}
    </div>
  );
}

function Answer({ answer, name }: { answer: TestMessageAnswer; name: string }) {
  if (answer.status === "refused") {
    return (
      <Notice tone="neutral" testId="sandbox-test-refused">
        Nothing started: {answer.message}.
        {answer.reply ? ` They'd get this reply: "${answer.reply}"` : ""}
      </Notice>
    );
  }
  return (
    <Notice tone="positive" testId="sandbox-test-started">
      {answer.status === "started" ? (
        <>
          {name} started a run.{" "}
          <Link to={`/ops/runs/${answer.runId}`} className="text-link hover:underline">
            Open the run
          </Link>
        </>
      ) : (
        `${name} took the message. No run started from it.`
      )}
      {answer.reply ? ` They'd get this reply: "${answer.reply}"` : ""}
    </Notice>
  );
}
