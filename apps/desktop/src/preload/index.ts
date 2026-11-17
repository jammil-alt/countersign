// The window's only way to the main process (docs/plan.md §1.124): `window.mezonas`, with the
// bridge's methods and nothing else. No Node, no file system, no network from the window.

import { contextBridge, ipcRenderer } from "electron";
import { type DesktopBridge, type DesktopView, IPC } from "../shared/ipc";

const call =
  (method: string) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(IPC.call, method, ...args);

const bridge: DesktopBridge = {
  view: call("view") as DesktopBridge["view"],
  onView(listener) {
    const handler = (_e: unknown, view: DesktopView) => listener(view);
    ipcRenderer.on(IPC.viewChanged, handler);
    return () => ipcRenderer.removeListener(IPC.viewChanged, handler);
  },
  signIn: call("signIn") as DesktopBridge["signIn"],
  signOut: call("signOut") as DesktopBridge["signOut"],
  pair: call("pair") as DesktopBridge["pair"],
  unpair: call("unpair") as DesktopBridge["unpair"],
  chooseFolder: call("chooseFolder") as DesktopBridge["chooseFolder"],
  addFolder: call("addFolder") as DesktopBridge["addFolder"],
  updateFolder: call("updateFolder") as DesktopBridge["updateFolder"],
  removeFolder: call("removeFolder") as DesktopBridge["removeFolder"],
  showFolder: call("showFolder") as DesktopBridge["showFolder"],
  openDesk: call("openDesk") as DesktopBridge["openDesk"],
  setSettings: call("setSettings") as DesktopBridge["setSettings"],
  dismissNotice: call("dismissNotice") as DesktopBridge["dismissNotice"],
};

contextBridge.exposeInMainWorld("mezonas", bridge);
