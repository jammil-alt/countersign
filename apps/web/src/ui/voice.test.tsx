// Voice typing in the composer (docs/plan.md §1.109), against a fake microphone and recorder:
// Dictate records, Stop writes it out into the box (after what's there, never sent on its own), a
// blocked microphone or a failure says so, and the button is absent where the browser can't record.
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./chat";

class FakeRecorder {
  static isTypeSupported = (t: string) => t === "audio/webm;codecs=opus";
  static last: FakeRecorder | null = null;
  mimeType: string;
  state = "inactive";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(_stream: unknown, options?: { mimeType?: string }) {
    this.mimeType = options?.mimeType ?? "";
    FakeRecorder.last = this;
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }) });
    this.onstop?.();
  }
}

const stopTrack = vi.fn();
let micAllowed = true;

beforeEach(() => {
  micAllowed = true;
  stopTrack.mockReset();
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: async () => {
        if (!micAllowed) throw new Error("NotAllowedError");
        return { getTracks: () => [{ stop: stopTrack }] };
      },
    },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function setup(transcribe: (audio: Blob) => Promise<string>, onSend = vi.fn(async () => true)) {
  render(
    <Composer
      label="Message"
      placeholder="Say something"
      onSend={onSend}
      testId="c"
      inputTestId="c-input"
      sendTestId="c-send"
      voice={{ transcribe }}
    />,
  );
  return { onSend };
}

describe("voice typing", () => {
  it("records, writes it out after what's in the box, and sends nothing on its own", async () => {
    const heard: Blob[] = [];
    const { onSend } = setup(async (audio) => {
      heard.push(audio);
      return "add a step that emails AP";
    });
    await userEvent.type(screen.getByTestId("c-input"), "Please");
    const button = screen.getByTestId("c-voice");
    expect(button).toHaveTextContent("Dictate");
    await userEvent.click(button);
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(button).toHaveTextContent("Stop · 0:00");
    expect(FakeRecorder.last?.mimeType).toBe("audio/webm;codecs=opus");
    await userEvent.click(button);
    await waitFor(() =>
      expect(screen.getByTestId("c-input")).toHaveValue("Please add a step that emails AP"),
    );
    expect(heard[0]?.type).toBe("audio/webm");
    expect(heard[0]?.size).toBe(3);
    // The microphone is let go, and nothing was sent.
    expect(stopTrack).toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    expect(button).toHaveTextContent("Dictate");
  });

  it("says when the microphone is blocked, and when it couldn't write it out", async () => {
    setup(async () => {
      throw new Error("voice typing sends data to OpenAI, which has no signed BAA");
    });
    micAllowed = false;
    await userEvent.click(screen.getByTestId("c-voice"));
    expect(screen.getByTestId("c-voice-error")).toHaveTextContent(
      "Your browser didn't let us use the microphone.",
    );
    micAllowed = true;
    await userEvent.click(screen.getByTestId("c-voice"));
    await act(async () => {
      FakeRecorder.last?.stop();
    });
    expect(await screen.findByTestId("c-voice-error")).toHaveTextContent(
      "Voice typing sends data to OpenAI, which has no signed BAA.",
    );
  });

  it("drops a recording when the composer goes away, and lets go of the microphone", async () => {
    const transcribe = vi.fn(async () => "x");
    const view = render(
      <Composer
        label="Message"
        placeholder="Say"
        onSend={async () => true}
        testId="c"
        voice={{ transcribe }}
      />,
    );
    await userEvent.click(screen.getByTestId("c-voice"));
    view.unmount();
    expect(stopTrack).toHaveBeenCalled();
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("isn't offered where the browser can't record", () => {
    vi.stubGlobal("MediaRecorder", undefined);
    setup(async () => "x");
    expect(screen.queryByTestId("c-voice")).toBeNull();
  });
});
