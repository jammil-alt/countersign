// §1.164 "Webhook JSON" in the builder's trigger inspector: the operator pastes a sample of what a
// webhook trigger's hook receives; core infers its shape (field names and types) in the browser
// and the trigger keeps only that shape, never the sample's values, so `{{trigger.data.…}}` is
// typed and Reshape data proposes from it. Clearing it puts the trigger back to "any path reads".
import { parseSamplePayload, processes, samplePaths, type TriggerOn } from "@countersign/core";
import { useMemo, useState } from "react";
import { Button } from "../../ui/primitives";
import { TextArea } from "../agents/ui";
import type { FieldErrors } from "./fields";
import { Row } from "./fields";

type WebhookOn = Extract<TriggerOn, { type: "webhook" }>;

export function WebhookSample({
  on,
  errors,
  onChange,
}: {
  on: WebhookOn;
  errors: FieldErrors;
  onChange(next: WebhookOn, key: string): void;
}) {
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const paths = useMemo(() => (on.dataSchema ? samplePaths(on.dataSchema) : []), [on]);

  const use = () => {
    const r = parseSamplePayload(text);
    if (!r.ok) {
      setProblem(r.message);
      return;
    }
    setProblem(null);
    setText("");
    onChange({ ...on, dataSchema: r.schema }, "trigger:dataSchema");
  };
  const clear = () => {
    const { dataSchema: _d, ...rest } = on;
    onChange(rest, "trigger:dataSchema");
  };

  return (
    <section
      className="flex flex-col gap-3 border-t border-line pt-4"
      data-testid="builder-webhook-sample"
    >
      <h3 className="eyebrow text-ink-muted">Sample payload</h3>
      <p className="text-sm text-ink">
        Paste one delivery your hook receives. We keep its field names and types, never its values,
        so later steps can read <span className="reference">trigger.data</span> by name.
      </p>
      {on.dataSchema ? (
        <>
          <p className="text-sm text-ink" data-testid="builder-webhook-sample-count">
            {paths.length} {paths.length === 1 ? "field" : "fields"} from the sample.
          </p>
          <ul className="flex flex-col text-sm" data-testid="builder-webhook-sample-fields">
            {paths.map((p) => (
              <li key={p.path} className="flex flex-wrap justify-between gap-2 py-0.5">
                <span className="reference">{`data.${p.path}`}</span>
                <span className="text-xs text-ink-muted">
                  {processes.typeWords(p.types) || "anything"}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="text-sm text-ink-muted" data-testid="builder-webhook-sample-none">
          No sample yet: any field of the delivery can be read, unchecked.
        </p>
      )}
      <Row
        label={on.dataSchema ? "Replace with another sample" : "Sample (JSON)"}
        field="on.dataSchema"
        errors={errors}
      >
        <TextArea
          aria-label="Sample payload (JSON)"
          data-testid="builder-webhook-sample-text"
          rows={6}
          className="font-mono"
          value={text}
          invalid={problem !== null}
          onChange={(e) => {
            setText(e.target.value);
            setProblem(null);
          }}
        />
      </Row>
      {problem ? (
        <p className="ds-error text-xs" data-testid="builder-webhook-sample-problem">
          {problem}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          data-testid="builder-webhook-sample-use"
          disabled={text.trim() === ""}
          onClick={use}
        >
          Use this sample
        </Button>
        {on.dataSchema ? (
          <Button
            size="sm"
            variant="ghost"
            data-testid="builder-webhook-sample-clear"
            onClick={clear}
          >
            Clear the sample
          </Button>
        ) : null}
      </div>
    </section>
  );
}
