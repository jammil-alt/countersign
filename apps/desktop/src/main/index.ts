// The Mezonas desktop app's Electron shell (docs/plan.md §1.151): one window, a tray icon that
// keeps the app running when the window is closed, the `mezonas://` link for sign-in, the OS's
// notifications, folder picker and keychain, and updates. Everything else is controller.ts.
//
// The window is locked down: no Node, a sandbox, context isolation, only the app's own files, no
// navigation and no new windows; links to Mezonas open in the person's browser.

import { homedir, hostname } from "node:os";
import { join, normalize, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { MOBILE_APP_SCHEME } from "@countersign/core";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification,
  nativeImage,
  net,
  protocol,
  safeStorage,
  shell,
  Tray,
} from "electron";
import { autoUpdater } from "electron-updater";
import { BRIDGE_METHODS, type BridgeMethod, IPC } from "../shared/ipc";
import { Controller } from "./controller";
import { devicePlatform } from "./guard";
import { Store } from "./store";
import { Vault } from "./vault";

/** Which Mezonas this build talks to: the build's choice, else production. */
// DECISION: production by default; a staging build sets MEZONAS_API_URL when it is built
// (scripts/build.mjs), and a developer may set it when starting the app.
const ORIGIN =
  process.env.MEZONAS_API_URL || process.env.MEZONAS_BUILD_API_URL || "https://app.mezonas.com";
/** Local `wrangler dev` only: sign in with the dev adapter as this email. Ignored when packaged. */
const DEV_USER = app.isPackaged ? undefined : process.env.MEZONAS_DEV_USER;

/**
 * The window's own files are served on `app://mezonas/`, a private scheme, not `file://`: module
 * scripts load, and the window's origin is fixed, so IPC can check who calls.
 */
// DECISION: Electron's own advice over loadFile: a file:// page may read any file it can name.
const APP_ORIGIN = "app://mezonas";
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: false } },
]);

let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let controller: Controller | null = null;
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// Sign-in comes back as mezonas://signed-in?code=…
if (process.defaultApp && process.argv[1]) {
  app.setAsDefaultProtocolClient(MOBILE_APP_SCHEME, process.execPath, [process.argv[1]]);
} else {
  app.setAsDefaultProtocolClient(MOBILE_APP_SCHEME);
}

function takeUrl(url: string | undefined): void {
  if (url?.startsWith(`${MOBILE_APP_SCHEME}://`)) {
    void controller?.handleUrl(url);
    showWindow();
  }
}

// macOS hands links over here; Windows starts a second copy with the link in its arguments.
app.on("open-url", (event, url) => {
  event.preventDefault();
  takeUrl(url);
});
app.on("second-instance", (_event, argv) => {
  takeUrl(argv.find((a) => a.startsWith(`${MOBILE_APP_SCHEME}://`)));
  showWindow();
});

function assetPath(...parts: string[]): string {
  return join(app.getAppPath(), "dist", ...parts);
}

function showWindow(): void {
  if (!window) createWindow();
  window?.show();
  window?.focus();
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 760,
    minHeight: 540,
    show: false,
    title: "Mezonas",
    backgroundColor: "#00000000",
    webPreferences: {
      preload: assetPath("preload", "index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`${ORIGIN}/`)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.once("ready-to-show", () => window?.show());
  // Closing the window keeps the app running in the tray: jobs and files keep going.
  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      window?.hide();
    }
  });
  window.on("closed", () => {
    window = null;
  });
  void window.loadURL(`${APP_ORIGIN}/index.html`);
}

function trayMenu(): void {
  if (!tray || !controller) return;
  const v = controller.view();
  const waiting = v.desk?.length ?? 0;
  tray.setToolTip(waiting > 0 ? `Mezonas: ${waiting} waiting on you` : "Mezonas");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Mezonas", click: showWindow },
      {
        label: waiting > 0 ? `Your Desk (${waiting} waiting)` : "Your Desk",
        click: () => void controller?.openDesk(),
      },
      { type: "separator" },
      {
        label:
          v.connection === "online"
            ? "Connected"
            : v.connection === "offline"
              ? "Can't reach Mezonas"
              : v.device
                ? "Waiting for Mezonas"
                : "Not added to Mezonas",
        enabled: false,
      },
      { type: "separator" },
      {
        label: "Quit Mezonas",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

app.whenReady().then(async () => {
  // Only files inside dist/renderer, by their path; anything else is not found.
  const rendererDir = assetPath("renderer");
  protocol.handle("app", (request) => {
    const url = new URL(request.url);
    const file = normalize(join(rendererDir, decodeURIComponent(url.pathname)));
    if (url.host !== "mezonas" || !file.startsWith(rendererDir + sep)) {
      return new Response("Not found", { status: 404 });
    }
    return net.fetch(pathToFileURL(file).toString());
  });
  const data = app.getPath("userData");
  controller = new Controller({
    origin: ORIGIN,
    store: new Store(data),
    vault: new Vault(data, {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (s) => safeStorage.encryptString(s),
      decrypt: (b) => safeStorage.decryptString(b),
    }),
    devUser: DEV_USER,
    shell: {
      openExternal: async (url) => {
        // Only Mezonas's own pages leave the app.
        if (url.startsWith(`${ORIGIN}/`)) await shell.openExternal(url);
      },
      notify: (title, body, onClick) => {
        if (!Notification.isSupported()) return;
        const n = new Notification({ title, body, silent: false });
        n.on("click", onClick);
        n.show();
      },
      chooseFolder: async () => {
        const options: Electron.OpenDialogOptions = {
          title: "Choose a folder for Mezonas",
          buttonLabel: "Choose",
          properties: ["openDirectory", "createDirectory"],
        };
        const r = window
          ? await dialog.showOpenDialog(window, options)
          : await dialog.showOpenDialog(options);
        return r.canceled ? null : (r.filePaths[0] ?? null);
      },
      showFolder: async (path) => {
        await shell.openPath(path);
      },
      setOpenAtLogin: (openAtLogin) => {
        if (app.isPackaged) app.setLoginItemSettings({ openAtLogin, args: ["--hidden"] });
      },
      homedir: homedir(),
      platform: devicePlatform(),
      appVersion: app.getVersion(),
      computerName: hostname().replace(/\.local$/, ""),
    },
  });

  // The window's calls: only the bridge's methods, each with plain data.
  ipcMain.handle(IPC.call, async (event, method: unknown, ...args: unknown[]) => {
    if (!event.senderFrame?.url.startsWith(`${APP_ORIGIN}/`)) throw new Error("refused");
    if (!BRIDGE_METHODS.includes(method as BridgeMethod)) throw new Error("unknown method");
    const c = controller;
    if (!c) throw new Error("not ready");
    const fn = (c as unknown as Record<string, (...a: unknown[]) => unknown>)[method as string];
    return fn?.apply(c, args);
  });
  controller.onView((view) => {
    window?.webContents.send(IPC.viewChanged, view);
    trayMenu();
  });

  const icon = nativeImage.createFromPath(assetPath("renderer", "tray.png"));
  if (process.platform === "darwin") icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.on("click", showWindow);

  await controller.start();
  trayMenu();
  // Started at login: stay in the tray until the person opens the window.
  const atLogin =
    process.argv.includes("--hidden") || app.getLoginItemSettings().wasOpenedAtLogin === true;
  if (!atLogin) showWindow();
  takeUrl(process.argv.find((a) => a.startsWith(`${MOBILE_APP_SCHEME}://`)));

  if (app.isPackaged) {
    // Signed updates from the feed in electron-builder.yml; checked now and every 6 hours.
    autoUpdater.autoInstallOnAppQuit = true;
    void autoUpdater.checkForUpdatesAndNotify().catch(() => undefined);
    setInterval(
      () => void autoUpdater.checkForUpdatesAndNotify().catch(() => undefined),
      6 * 3_600_000,
    );
  }
});

app.on("activate", showWindow);
app.on("before-quit", () => {
  quitting = true;
  controller?.stop();
});
// Keep running in the tray when every window is closed, on every platform.
app.on("window-all-closed", () => undefined);
