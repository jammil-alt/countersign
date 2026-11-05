// What the browser connector asks of the platform for one client's browser connection
// (ConnectorServices.browser). apps/api provides it, scoped to the connection's client: the
// operator's catalogue (the pinned version and the live tier), a fresh browser, the code service,
// the connection's sign-in counters, documents for downloads, and the session log with screenshots.
// Credentials are not here: they come through the connection's CredentialsAccessor like every
// connector's, for one step.

import type {
  BrowserConnectionState,
  ClaimResult,
  OpenWaitResult,
  PinnedBrowserSite,
} from "@countersign/core";
import type { z } from "zod";
import type { BrowserTab } from "./driver";

/**
 * The code service as a sign-in uses it: open a wait before submitting, then claim the code once.
 * apps/api adds the client's id; a code never reaches a log, a tool result or the model.
 */
export interface BrowserCodesPort {
  openWait(
    input:
      | { identityId: string; siteKey: string; channel: "totp"; ttlSeconds: number }
      | {
          identityId: string;
          siteKey: string;
          channel: "sms" | "email";
          sender: string;
          pattern: string;
          ttlSeconds: number;
        },
  ): Promise<z.output<typeof OpenWaitResult>>;
  claim(input: { identityId: string; waitId: string }): Promise<z.output<typeof ClaimResult>>;
}

/** One browser session (one tool call): what it did, kept on the connection's log. */
export interface BrowserSessionRecord {
  site: string;
  siteVersion: number;
  tool: string;
  /** How it signed in: a fresh sign-in, a kept session, or not at all. */
  signIn: "fresh" | "kept_session" | "none";
  /** Pages opened after sign-in, in order (sign-in pages are not listed or recorded). */
  pages: string[];
  /** What the agent did after sign-in: read a page, downloaded a file. */
  actions: { kind: "read" | "download"; url: string; documentId?: string }[];
  /** Storage keys of the screenshots taken after sign-in. */
  screenshots: string[];
  outcome: "done" | "failed" | "stopped";
  /** Why it failed or stopped; never a secret. */
  reason?: string;
  signedOut: boolean;
  keptSession: boolean;
  startedAt: string;
  endedAt: string;
}

export interface BrowserServices {
  /** The connection's pinned site version and the site's live tier; null if gone. */
  site(ref: { slug: string; versionId: string }): Promise<PinnedBrowserSite | null>;
  /**
   * A fresh browser with one tab, reaching only these hosts where the browser can be held to them
   * (Browser Run's guardrails); null when this deployment has no browser.
   */
  open(options: { hosts: string[] }): Promise<BrowserTab | null>;
  /** The code service; null where it is not bound. */
  codes: BrowserCodesPort | null;
  /** The connection's sign-in counters and stop. */
  state: {
    get(): Promise<BrowserConnectionState | null>;
    put(state: BrowserConnectionState): Promise<void>;
    /**
     * Sign-ins stop until a person checks the account: the connection needs attention, and the
     * operator and the client admin get an inbox item.
     */
    stop(reason: string): Promise<void>;
  };
  /** A downloaded file into the client's documents, as uploads are. */
  storeDocument(file: {
    bytes: Uint8Array;
    filename: string;
    mimeType: string;
    sourceUrl: string;
  }): Promise<{ documentId: string; created: boolean }>;
  /** A screenshot after sign-in, kept as evidence; answers its storage key. */
  saveScreenshot(png: Uint8Array): Promise<string>;
  /** The session's record, on the connection's log. */
  record(session: BrowserSessionRecord): Promise<void>;
  /** Waiting between claims (tests pass a fast one). */
  sleep?(ms: number): Promise<void>;
}
