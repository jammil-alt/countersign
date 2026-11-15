// Voice typing (docs/plan.md §1.109): a recording sent to be written out, the words back. The body
// is the recording's bytes (the API client sends JSON only), as the feedback screenshot's is.
import { routes } from "@countersign/core";
import type { Voice } from "../ui/voice";
import { ApiError } from "./client";
import { noteWrite } from "./store";

/**
 * Writes out a recording: the back office's route (with the client the conversation is about, so a
 * client in HIPAA mode is refused) or the portal's. Throws an ApiError with the server's words.
 */
export async function transcribe(
  surface: "ops" | "portal",
  audio: Blob,
  clientId?: string | null,
  doFetch: typeof fetch = (input, init) => globalThis.fetch(input, init),
): Promise<string> {
  const route = surface === "ops" ? routes.opsTranscribe : routes.portalTranscribe;
  const url =
    surface === "ops" && clientId
      ? `${route.path}?client=${encodeURIComponent(clientId)}`
      : route.path;
  const label = `${route.method} ${route.path}`;
  let res: Response;
  try {
    res = await doFetch(url, {
      method: "POST",
      body: audio,
      credentials: "same-origin",
      headers: { "content-type": audio.type || "audio/webm", accept: "application/json" },
    });
  } catch (cause) {
    throw new ApiError({
      status: 0,
      code: "network",
      message: "you seem to be offline",
      route: label,
      cause,
    });
  }
  const body = (await res.json().catch(() => null)) as {
    text?: unknown;
    error?: { code?: string; message?: string };
  } | null;
  if (!res.ok || typeof body?.text !== "string") {
    throw new ApiError({
      status: res.status,
      code: body?.error?.code ?? `http_${res.status}`,
      message: body?.error?.message ?? "we couldn't write that out",
      route: label,
      body,
    });
  }
  // Nothing stored changes, but a POST is a write to the store's accounting.
  noteWrite();
  return body.text;
}

/** The composer's voice typing for a surface (and, in the back office, the client it's about). */
export function voiceFor(
  surface: "ops" | "portal",
  clientId?: string | null,
  words?: Voice["words"],
): Voice {
  // The back office reads the server's reason (a client in HIPAA mode, voice off); the portal its
  // own language's words, so a client never reads our English.
  return {
    transcribe:
      surface === "portal" && words?.failed
        ? (audio) =>
            transcribe(surface, audio, clientId).catch(() => {
              throw new Error(words.failed);
            })
        : (audio) => transcribe(surface, audio, clientId),
    words,
  };
}
