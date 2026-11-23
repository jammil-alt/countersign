// S5.7 (overnight fixes, 2026-11-23): the Spanish Workflow chart said "We start it by hand", "the
// run stops" and "Adds bills to QuickBooks Online", and the inbox "Add … to the directory": English
// made on the server. Now said by key and written here in the reader's language.
import type { SopView } from "@countersign/core";
import { beforeAll, describe, expect, it } from "vitest";
import { createTranslator, loadCatalog } from "../i18n/catalog";
import { itemTitle } from "../inbox/titles";
import { localSop, sayText } from "./say";

beforeAll(async () => {
  await loadCatalog("es");
});

const VIEW = {
  scope: { covers: ["We start it by hand"], notCovered: [], never: [] },
  start: {
    triggers: ["We start it by hand"],
    triggersSay: [{ key: "sop.say.trigger.manualUs" }],
    hours: null,
    runByHand: null,
  },
  procedure: [
    {
      line: "step",
      id: "create",
      purpose: "Adds bills to QuickBooks Online.",
      purposeSay: {
        key: "sop.say.purpose.adds",
        params: { what: "bills", where: "QuickBooks Online" },
        paramKeys: { what: "sop.say.entity.bill" },
      },
      approval: {
        level: "ask",
        approvers: [],
        byWhen: "within 1 business day",
        ifNoAnswer: "the run stops",
        ifNoAnswerSay: { key: "sop.say.then.stop" },
        ifRejected: "the change isn't made and the run stops",
        ifRejectedSay: { key: "sop.say.rejected.stop" },
      },
      onError: null,
    },
    {
      line: "step",
      id: "old",
      purpose: "Written before the keys.",
      approval: null,
      onError: null,
    },
  ],
} as unknown as SopView;

describe("what the server said, in Spanish", () => {
  it("writes the SOP's triggers, purposes and outcomes from their keys", () => {
    const t = createTranslator("es");
    const view = localSop(VIEW, t);
    expect(view.start.triggers).toEqual(["Lo iniciamos a mano"]);
    expect(view.scope.covers).toEqual(["Lo iniciamos a mano"]);
    const [create, old] = view.procedure as unknown as {
      purpose: string;
      approval: { ifNoAnswer: string; ifRejected: string } | null;
    }[];
    expect(create?.purpose).toBe("Añade facturas de proveedor a QuickBooks Online.");
    expect(create?.approval?.ifNoAnswer).toBe("la ejecución se detiene");
    expect(create?.approval?.ifRejected).toBe("el cambio no se hace y la ejecución se detiene");
    // A revision made before the keys keeps its English.
    expect(old?.purpose).toBe("Written before the keys.");
  });

  it("keeps the English in English, and for a key it doesn't know", () => {
    const en = createTranslator("en");
    expect(localSop(VIEW, en).start.triggers).toEqual(["We start it by hand"]);
    expect(sayText(createTranslator("es"), { key: "sop.say.unknown" }, "As written")).toBe(
      "As written",
    );
  });

  it("writes a directory suggestion's title from its key, or from its change", () => {
    const t = createTranslator("es");
    expect(
      itemTitle(
        {
          title: "Update Pat Lee in the directory",
          payload: {
            directorySuggestion: {
              title: { key: "directory.suggestions.title.update", params: { name: "Pat Lee" } },
            },
          },
        },
        t,
      ),
    ).toBe("Actualizar Pat Lee en el directorio");
    // An item from before the key: the addition names itself.
    expect(
      itemTitle(
        {
          title: "Add QA Supplies Ltd to the directory",
          payload: {
            directorySuggestion: {
              change: { action: "add_organization", organization: { name: "QA Supplies Ltd" } },
            },
          },
        },
        t,
      ),
    ).toBe("Añadir QA Supplies Ltd al directorio");
    expect(itemTitle({ title: "Sign the bill", payload: {} }, t)).toBe("Sign the bill");
  });
});
