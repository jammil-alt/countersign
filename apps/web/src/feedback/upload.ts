// Sends feedback: the comment first (`POST` → id), then the picture (`PUT …/screenshot`, JPEG), so a
// failed upload loses only the picture.
import { buildPath, type FeedbackSubmission, routes } from "@countersign/core";
import type { ApiClient } from "../api/client";

export type ScreenshotOutcome = "sent" | "failed" | "none";

export async function sendFeedback(
  client: ApiClient,
  surface: "ops" | "portal",
  submission: FeedbackSubmission,
  picture: Blob | null,
  doFetch: typeof fetch = (input, init) => globalThis.fetch(input, init),
): Promise<{ id: string; screenshot: ScreenshotOutcome }> {
  const send = surface === "ops" ? routes.opsSendFeedback : routes.portalSendFeedback;
  const { id } = await client.call(send, { body: submission });
  if (!picture) return { id, screenshot: "none" };
  const put =
    surface === "ops" ? routes.opsFeedbackUploadScreenshot : routes.portalFeedbackScreenshot;
  try {
    const res = await doFetch(buildPath(put.path, { id }), {
      method: "PUT",
      body: picture,
      credentials: "same-origin",
      headers: { "content-type": "image/jpeg", accept: "application/json" },
    });
    return { id, screenshot: res.ok ? "sent" : "failed" };
  } catch {
    return { id, screenshot: "failed" };
  }
}
