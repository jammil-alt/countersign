// The screenshot that goes with feedback: the page as the person saw it, without the feedback
// layer, cropped to their viewport, as a JPEG under the API's size limit.
//
// The page is redrawn from the DOM into a canvas by modern-screenshot (MIT), loaded only when
// somebody actually sends feedback, so nobody else pays for it. Nothing leaves the browser here:
// the picture goes only to Mezonas' own API (upload.ts), never to error tracking or a model.

import { FEEDBACK_SCREENSHOT_MAX_BYTES } from "@countersign/core";

const MAX_SCALE = 2;
const QUALITIES = [0.85, 0.7, 0.55, 0.4];

/** Marks the feedback layer: everything inside it is left out of the picture. */
export const FEEDBACK_LAYER_ATTR = "data-feedback-layer";

function toJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

function shrink(source: HTMLCanvasElement, factor: number): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(source.width * factor));
  out.height = Math.max(1, Math.round(source.height * factor));
  out.getContext("2d")?.drawImage(source, 0, 0, out.width, out.height);
  return out;
}

/** The viewport as a JPEG, or null when the browser can't draw it. */
export async function captureViewport(): Promise<Blob | null> {
  try {
    const { domToCanvas } = await import("modern-screenshot");
    const scale = Math.min(window.devicePixelRatio || 1, MAX_SCALE);
    const root = document.documentElement;
    const full = await domToCanvas(root, {
      scale,
      backgroundColor: getComputedStyle(document.body).backgroundColor || null,
      filter: (node) => !(node instanceof Element && node.hasAttribute(FEEDBACK_LAYER_ATTR)),
    });
    // Crop to what was on screen.
    const view = document.createElement("canvas");
    view.width = Math.round(window.innerWidth * scale);
    view.height = Math.round(window.innerHeight * scale);
    view
      .getContext("2d")
      ?.drawImage(
        full,
        Math.round(window.scrollX * scale),
        Math.round(window.scrollY * scale),
        view.width,
        view.height,
        0,
        0,
        view.width,
        view.height,
      );
    let canvas = view;
    for (let round = 0; round < 3; round++) {
      for (const q of QUALITIES) {
        const blob = await toJpeg(canvas, q);
        if (blob && blob.size <= FEEDBACK_SCREENSHOT_MAX_BYTES) return blob;
      }
      canvas = shrink(canvas, 0.6);
    }
    return null;
  } catch (error) {
    console.warn("feedback screenshot failed", error);
    return null;
  }
}
