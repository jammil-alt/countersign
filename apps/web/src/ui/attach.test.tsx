// Files in the composer (docs/plan.md §1.110): picked or dropped files go up at once and wait as
// chips; Remove takes one off; Send passes them with the words and empties the box; a refused
// file says why; Send waits while a file is still going up; no Attach without `attach`.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Attach, AttachedFile } from "./attach";
import { MessageFiles } from "./attach";
import { Composer } from "./chat";

const pdf = (name: string) =>
  new File([new Uint8Array([37, 80, 68, 70])], name, { type: "application/pdf" });

function setup(attach: Attach, onSend = vi.fn(async (_t: string, _f: AttachedFile[]) => true)) {
  render(
    <Composer
      label="Message"
      placeholder="Say something"
      onSend={onSend}
      testId="c"
      inputTestId="c-input"
      sendTestId="c-send"
      attach={attach}
    />,
  );
  return { onSend };
}

const kept = (name: string, id = `id-${name}`): AttachedFile => ({
  id,
  name,
  contentType: "application/pdf",
});

describe("attachments in the composer", () => {
  it("uploads what's picked, shows it, and sends it with the words", async () => {
    const upload = vi.fn(async (files: File[]) => ({
      files: files.map((f) => kept(f.name)),
      refused: [],
    }));
    const { onSend } = setup({ upload });
    await userEvent.upload(screen.getByTestId("c-attach-input"), [pdf("a.pdf"), pdf("b.pdf")]);
    await waitFor(() => expect(screen.getByTestId("c-files")).toHaveTextContent("a.pdf"));
    expect(upload).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Remove b.pdf" }));
    expect(screen.getByTestId("c-files")).not.toHaveTextContent("b.pdf");
    await userEvent.type(screen.getByTestId("c-input"), "Send this to Pia");
    await userEvent.click(screen.getByTestId("c-send"));
    expect(onSend).toHaveBeenCalledWith("Send this to Pia", [kept("a.pdf")]);
    expect(screen.queryByTestId("c-files")).toBeNull();
  });

  it("puts the files back when the send fails", async () => {
    const { onSend } = setup(
      { upload: async (files) => ({ files: files.map((f) => kept(f.name)), refused: [] }) },
      vi.fn(async () => false),
    );
    await userEvent.upload(screen.getByTestId("c-attach-input"), pdf("a.pdf"));
    await screen.findByText("a.pdf");
    await userEvent.type(screen.getByTestId("c-input"), "Here");
    await userEvent.click(screen.getByTestId("c-send"));
    expect(onSend).toHaveBeenCalled();
    expect(await screen.findByText("a.pdf")).toBeInTheDocument();
    expect(screen.getByTestId("c-input")).toHaveValue("Here");
  });

  it("takes dropped files, says why one was refused, and holds Send while uploading", async () => {
    let finish: (v: { files: AttachedFile[]; refused: string[] }) => void = () => {};
    setup({ upload: () => new Promise((r) => (finish = r)) });
    await userEvent.type(screen.getByTestId("c-input"), "Look");
    const box = screen.getByTestId("c-input").closest(".ui-chat-composer__box") as HTMLElement;
    fireEvent.drop(box, { dataTransfer: { files: [pdf("x.pdf")], types: ["Files"] } });
    expect(await screen.findByText(/x.pdf · Uploading/)).toBeInTheDocument();
    expect(screen.getByTestId("c-send")).toBeDisabled();
    await act(async () => finish({ files: [], refused: ["x.pdf: attach PDFs or images."] }));
    expect(screen.getByTestId("c-attach-error")).toHaveTextContent("x.pdf: attach PDFs or images.");
    expect(screen.getByTestId("c-send")).toBeEnabled();
  });

  it("isn't offered without attach", () => {
    render(<Composer label="Message" placeholder="Say" onSend={async () => true} testId="c" />);
    expect(screen.queryByTestId("c-attach")).toBeNull();
  });

  it("shows a sent message's files as links", () => {
    render(<MessageFiles files={[kept("inv.pdf", "d1")]} href={(id) => `/records/${id}`} />);
    expect(screen.getByRole("link", { name: "inv.pdf" })).toHaveAttribute("href", "/records/d1");
  });
});
