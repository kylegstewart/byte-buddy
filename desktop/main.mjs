import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDesktopConfig, validateUserId } from "./config.mjs";
import { createDesktopRuntime } from "./runtime.mjs";
import { createGitHubAuth } from "./github-auth.mjs";
import { createDesktopUpdater } from "./updates.mjs";
import { isAppDocument, safeExternalUrl } from "./security.mjs";
import { copilotHome, readServerConfig } from "../itsource.mjs";

app.setName("Byte Buddy");
app.enableSandbox();
const here = dirname(fileURLToPath(import.meta.url));
const root = process.env.BYTE_BUDDY_DATA_DIR ? resolve(process.env.BYTE_BUDDY_DATA_DIR) : join(app.getPath("appData"), "Byte Buddy Desktop");
mkdirSync(root, { recursive: true });
app.setPath("userData", root);
let window;
let runtime;
let appUrl;
let quitting = false;
const configuration = createDesktopConfig(root);
const auth = createGitHubAuth();
const updater = createDesktopUpdater({ current: app.getVersion() });
const trustedLoungeServers = new Set();

async function authorizeLounge(url) {
    if (trustedLoungeServers.has(url)) return true;
    if (!window || window.isDestroyed()) return false;
    const confirmation = await dialog.showMessageBox(window, { type: "warning", buttons: ["Cancel", "Trust server and join"], defaultId: 0, cancelId: 0, message: "Trust this Lounge server with your GitHub credential?", detail: `Server: ${url}\n\nThe existing Lounge protocol sends your GitHub CLI token to this server to verify organization membership. The server operator could misuse it with your token's permissions. Join only a server and operator you trust. Buddy appearance and presence are shared; ticket/MCP data is not. This trust lasts until Byte Buddy closes.` });
    if (confirmation.response !== 1) return false;
    trustedLoungeServers.add(url);
    return true;
}

function restart() {
    app.relaunch();
    app.quit();
}

function handle(channel, callback) {
    ipcMain.handle(channel, async (event, ...args) => {
        if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !isAppDocument(event.senderFrame.url, appUrl)) throw new Error("Untrusted desktop request.");
        return callback(...args);
    });
}

async function openExternal(value) {
    const url = safeExternalUrl(value);
    if (!url) throw new Error("Only HTTP/HTTPS links can open in your browser.");
    await shell.openExternal(url);
}

function registerDesktopCommands() {
    handle("desktop:status", () => {
        const config = configuration.read();
        return { version: app.getVersion(), packaged: app.isPackaged, root, userId: config.userId, mcpConfigPath: config.mcpConfigPath, serverName: config.serverName, github: auth.status() };
    });
    handle("desktop:github-check", () => auth.check());
    handle("desktop:github-login", () => auth.login());
    handle("desktop:github-cancel", () => auth.cancel());
    handle("desktop:github-device", () => {
        const status = auth.status();
        if (status.status !== "signing-in" || !status.code) throw new Error("No active GitHub device code is ready. Check your existing sign-in or start a new sign-in first.");
        return openExternal("https://github.com/login/device");
    });
    handle("desktop:install-github", () => openExternal("https://cli.github.com/"));
    handle("desktop:configure-mcp", async (settings) => {
        const userId = validateUserId(settings?.userId);
        const serverName = settings?.serverName;
        if (typeof serverName !== "string" || !/^[A-Za-z0-9._-]{1,100}$/.test(serverName)) throw new Error("Enter a valid MCP server name.");
        const choice = await dialog.showOpenDialog(window, { title: "Choose your local MCP configuration JSON", defaultPath: join(copilotHome(), "mcp-config.json"), properties: ["openFile"], filters: [{ name: "MCP configuration", extensions: ["json"] }] });
        if (choice.canceled) return { cancelled: true };
        const configPath = choice.filePaths[0];
        const server = readServerConfig({ configPath, serverName });
        const confirmation = await dialog.showMessageBox(window, { type: "question", buttons: ["Cancel", "Connect and restart"], defaultId: 0, cancelId: 0, message: "Allow this local MCP command?", detail: `Byte Buddy will run "${server.command}" with your user permissions to read tickets for ${userId}. Select only configuration you trust. No MCP credentials or tickets are sent to the Lounge. Changing the username selects its separate local save.` });
        if (confirmation.response !== 1) return { cancelled: true };
        configuration.write({ ...configuration.read(), userId, serverName, mcpConfigPath: configPath });
        setImmediate(restart);
        return { restarting: true };
    });
    handle("desktop:disconnect-mcp", async () => {
        const confirmation = await dialog.showMessageBox(window, { type: "question", buttons: ["Cancel", "Disconnect and restart"], defaultId: 0, cancelId: 0, message: "Disconnect ticket sync?", detail: "Ticket history, rewards and all saves remain on this computer." });
        if (confirmation.response !== 1) return { cancelled: true };
        configuration.write({ ...configuration.read(), mcpConfigPath: "" });
        setImmediate(restart);
        return { restarting: true };
    });
    handle("desktop:open-data", async () => {
        const error = await shell.openPath(root);
        if (error) throw new Error(error);
    });
    handle("desktop:check-updates", () => updater.check());
    handle("desktop:download-update", async () => {
        const url = updater.downloadUrl();
        if (!url) throw new Error("Check for a desktop update first.");
        await openExternal(url);
    });
}

async function boot() {
    await app.whenReady();
    const config = configuration.read();
    runtime = createDesktopRuntime({ root, config, authorizeLounge });
    appUrl = await runtime.start();
    window = new BrowserWindow({ title: "Byte Buddy", icon: join(here, "assets", "icon.png"), width: 960, height: 900, minWidth: 480, minHeight: 560, show: false,
        webPreferences: { preload: join(here, "preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false, navigateOnDragDrop: false } });
    const browserSession = window.webContents.session;
    browserSession.setPermissionRequestHandler((_contents, _permission, respond) => respond(false));
    browserSession.setPermissionCheckHandler(() => false);
    window.webContents.setWindowOpenHandler(({ url }) => { if (safeExternalUrl(url)) void openExternal(url).catch(() => {}); return { action: "deny" }; });
    window.webContents.on("will-navigate", (event, url) => {
        if (isAppDocument(url, appUrl)) return;
        event.preventDefault();
        if (safeExternalUrl(url)) void openExternal(url).catch(() => {});
    });
    window.webContents.on("will-attach-webview", (event) => event.preventDefault());
    registerDesktopCommands();
    Menu.setApplicationMenu(Menu.buildFromTemplate([
        { label: "Byte Buddy", submenu: [{ label: "Open local data folder", click: () => { void shell.openPath(root); } }, { type: "separator" }, { role: "quit" }] },
        { label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
        { label: "View", submenu: [{ role: "reload" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { role: "togglefullscreen" }, ...(!app.isPackaged ? [{ role: "toggleDevTools" }] : [])] },
    ]));
    window.once("ready-to-show", () => { if (!process.argv.includes("--smoke-test")) window.show(); });
    await window.loadURL(appUrl);
    if (process.argv.includes("--smoke-test")) {
        const result = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => { const deadline = Date.now() + 15000; const check = () => { if (!document.getElementById('app')?.hasAttribute('aria-busy') && document.getElementById('desktopStatus')?.textContent.startsWith('Desktop ') && !document.getElementById('desktopConnections')?.hidden) resolve({ name: document.getElementById('buddyName').textContent, desktopBridge: typeof window.byteBuddyDesktop?.status === 'function', nodeUnavailable: typeof require === 'undefined' && typeof process === 'undefined', desktop: window.BUDDY_CONFIG.desktop, title: document.title, freshStart: !document.getElementById('desktopImportFolder') && typeof window.byteBuddyDesktop.importSave === 'undefined', deviceHidden: document.getElementById('desktopGithubDevice').hidden && document.getElementById('desktopGithubCode').hidden }); else if (Date.now() > deadline) reject(new Error('Desktop UI did not initialize')); else setTimeout(check, 100); }; check(); })`);
        if (!result.desktopBridge || !result.nodeUnavailable || !result.desktop) throw new Error("Desktop security smoke test failed.");
        writeFileSync(join(root, "smoke.json"), JSON.stringify(result, null, 2));
        process.stdout.write(`BYTE_BUDDY_SMOKE_OK ${JSON.stringify(result)}\n`);
        app.quit();
    }
}

app.on("before-quit", (event) => {
    if (quitting || !runtime) return;
    event.preventDefault();
    quitting = true;
    auth.close();
    const timeout = new Promise((done) => { const timer = setTimeout(done, 8000); timer.unref(); });
    void Promise.race([runtime.close(), timeout]).catch(() => {}).finally(() => app.quit());
});
app.on("window-all-closed", () => app.quit());
if (!app.requestSingleInstanceLock()) app.quit();
else {
    app.on("second-instance", () => { if (window?.isMinimized()) window.restore(); window?.focus(); });
    void boot().catch((error) => { if (process.argv.includes("--smoke-test")) process.stderr.write(`${error.stack}\n`); else dialog.showErrorBox("Byte Buddy could not start", error.message); app.exit(1); });
}
