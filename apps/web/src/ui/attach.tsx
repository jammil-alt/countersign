// Files in a conversation (docs/plan.md §1.110): the composer's Attach button, files dropped on the
// box, the chips of what goes with the message (each with Remove), and the chips on a message once
// sent. Uploading is the screen's (`Attach.upload`); nothing is sent until the person presses Send.
import type { ReactNode } from "react";
import { useRef } from "react";

export interface AttachedFile {
  id: string;
  name: string;
  contentType: string;
}

export interface AttachWords {
  attach: string;
  uploading: string;
  remove: string;
  failed: string;
}

export const ENGLISH_ATTACH: AttachWords = {
  attach: "Attach",
  uploading: "Uploading…",
  remove: "Remove",
  failed: "We couldn't upload that. Try again.",
};

export interface Attach {
  /** Uploads the files: what was kept, and why any file was refused (words to show). */
  upload(files: File[]): Promise<{ files: AttachedFile[]; refused: string[] }>;
  /** What the picker offers, e.g. "application/pdf,image/*". */
  accept?: string | undefined;
  /** At most this many files on one message. */
  max?: number | undefined;
  words?: Partial<AttachWords> | undefined;
}

export const ATTACH_ACCEPT = "application/pdf,image/png,image/jpeg,image/gif,image/webp";

export function AttachButton({
  attach,
  disabled,
  onFiles,
  testId = "attach",
}: {
  attach: Attach;
  disabled?: boolean | undefined;
  onFiles(files: File[]): void;
  testId?: string;
}) {
  const w = { ...ENGLISH_ATTACH, ...attach.words };
  const input = useRef<HTMLInputElement | null>(null);
  return (
    <>
      <button
        type="button"
        className="ui-voice__button"
        data-testid={testId}
        disabled={disabled}
        onClick={() => input.current?.click()}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <path d="M20 11.5l-7.8 7.8a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8" />
        </svg>
        {w.attach}
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept={attach.accept ?? ATTACH_ACCEPT}
        data-testid={`${testId}-input`}
        onChange={(e) => {
          const picked = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (picked.length > 0) onFiles(picked);
        }}
      />
    </>
  );
}

/** One file: its name, a link when there is one, and Remove while it's still in the box. */
export function FileChip({
  file,
  href,
  onRemove,
  removeLabel = ENGLISH_ATTACH.remove,
  pending,
}: {
  file: Pick<AttachedFile, "name">;
  href?: string | undefined;
  onRemove?: (() => void) | undefined;
  removeLabel?: string;
  pending?: boolean | undefined;
}) {
  const name: ReactNode = href ? (
    <a className="ui-chat-file__name" href={href}>
      {file.name}
    </a>
  ) : (
    <span className="ui-chat-file__name">{file.name}</span>
  );
  return (
    <span className="ui-chat-file" data-pending={pending ? "" : undefined}>
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        aria-hidden="true"
      >
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
        <path d="M14 3v5h5" />
      </svg>
      {name}
      {onRemove ? (
        <button
          type="button"
          className="ui-chat-file__remove"
          aria-label={`${removeLabel} ${file.name}`}
          onClick={onRemove}
        >
          ×
        </button>
      ) : null}
    </span>
  );
}

/** The files a sent message carries. */
export function MessageFiles({
  files,
  href,
  testId,
}: {
  files: readonly AttachedFile[];
  href?: ((id: string) => string) | undefined;
  testId?: string | undefined;
}) {
  if (files.length === 0) return null;
  return (
    <div className="ui-chat-files" data-testid={testId}>
      {files.map((f) => (
        <FileChip key={f.id} file={f} href={href?.(f.id)} />
      ))}
    </div>
  );
}
