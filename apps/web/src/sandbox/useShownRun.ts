import type { SandboxRun } from "@countersign/core";
import { useState } from "react";

/**
 * The run to show: the last read of it, or what a "Send to me" answered (the run with that send
 * listed) until the next read replaces it. Both sides' run pages use it.
 */
export function useShownRun(read: SandboxRun | undefined): {
  run: SandboxRun | undefined;
  answered: (run: SandboxRun) => void;
} {
  const [sent, setSent] = useState<{ after: SandboxRun | undefined; run: SandboxRun } | null>(null);
  const run = sent && sent.after === read ? sent.run : read;
  return { run, answered: (next) => setSent({ after: read, run: next }) };
}
