import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { createStore } from "./store.mjs";
import { createDesktopConfig, validateUserId } from "./desktop/config.mjs";
import { createDesktopRuntime } from "./desktop/runtime.mjs";
import { createDesktopUpdater } from "./desktop/updates.mjs";
import { createLoungeClient } from "./lounge.mjs";
import { isAppDocument, safeExternalUrl } from "./desktop/security.mjs";
import { createItSource, readServerConfig, resolveUserId, TicketSourceError } from "./itsource.mjs";

function fixture(t) {
    const root = mkdtempSync(join(process.cwd(), ".desktop-test-"));
    t.after(() => { if (resolve(root).startsWith(`${process.cwd()}${sep}`)) rmSync(root, { recursive: true, force: true }); });
    return root;
}


test("desktop configuration is independent, atomic and rejects unsafe profile paths", (t) => {
    const root = fixture(t);
    const config = createDesktopConfig(join(root, "desktop"));
    const defaults = config.read();
    assert.equal(defaults.mcpConfigPath, "");
    config.write({ ...defaults, userId: "developer", mcpConfigPath: join(root, "mcp.json") });
    assert.equal(config.read().userId, "DEVELOPER");
    for (const bad of ["../escape", ".", "CON", "user/name", "COM1", "name."]) assert.throws(() => validateUserId(bad));
    assert.throws(() => config.write({ ...defaults, mcpConfigPath: "relative.json" }));
    assert.equal(readdirSync(join(root, "desktop")).filter((name) => name.endsWith(".tmp")).length, 0);
});


test("desktop starts fresh instead of importing a Copilot save and retains its own progress across restarts", async (context) => {
    const root = fixture(context);
    const legacy = createStore({ root: join(root, "copilot"), userId: "DEV" });
    legacy.rename("Legacy buddy");
    const original = readFileSync(legacy.file, "utf8");
    const desktopRoot = join(root, "desktop");
    const config = createDesktopConfig(desktopRoot);
    config.write({ ...config.read(), userId: "DEV", pendingImport: { source: legacy.file, kind: "file" } });
    writeFileSync(config.file, JSON.stringify({ ...config.read(), pendingImport: { source: legacy.file, kind: "file" } }));
    assert.equal(config.read().pendingImport, undefined);
    const runtime = createDesktopRuntime({ root: desktopRoot, config: config.read() });
    context.after(() => runtime.close());
    await runtime.start();
    assert.equal(runtime.store.exportState().name, "Bit");
    assert.deepEqual(runtime.store.exportState().profiles.live.ledger, {});
    runtime.store.rename("Desktop buddy");
    await runtime.close();
    const reopened = createDesktopRuntime({ root: desktopRoot, config: config.read() });
    context.after(() => reopened.close());
    await reopened.start();
    assert.equal(reopened.store.exportState().name, "Desktop buddy");
    assert.equal(readFileSync(legacy.file, "utf8"), original);
});

test("explicit standalone MCP configuration launches local stdio with only the existing read tools", async (t) => {
    const root = fixture(t);
    const mock = join(root, "mcp.mjs");
    writeFileSync(mock, `import readline from 'node:readline';
      for await (const line of readline.createInterface({input:process.stdin})) {
        const m=JSON.parse(line); if (!m.id) continue;
        const value=m.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{}}:{content:[{type:'text',text:JSON.stringify(m.params.name==='search_tickets'?{tickets:[{taskId:123,taskTitle:'Local fixture',assignedTo:{userId:'DEV'},isOpen:false}],totalPages:1}:{closedByDate:'2026-01-05T12:00:00Z',closedByUser:{userId:'DEV'}})}]};
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:value})+'\\n');
      }`);
    const configPath = join(root, "mcp.json");
    writeFileSync(configPath, JSON.stringify({ mcpServers: { tickets: { type: "stdio", command: process.execPath, args: [mock], env: { MCP_USERNAME: "dev" } } } }));
    const options = { configPath, serverName: "tickets" };
    assert.equal(resolveUserId(options), "DEV");
    const source = createItSource({ getConfig: () => readServerConfig(options) });
    t.after(() => source.stop());
    const result = await source.fetchAssignedTickets("DEV");
    assert.equal(result.tickets[0].id, "123");
    assert.equal(result.complete, true);
    assert.equal((await source.fetchClosure("123")).closedBy, "DEV");
});

test("desktop runtime preserves the existing UI/API and never starts GitHub imports on launch", async (t) => {
    const root = fixture(t);
    let githubCalls = 0;
    const runtime = createDesktopRuntime({ root, config: { userId: "DEV", mcpConfigPath: "" }, githubSource: { fetchActivity() { githubCalls++; throw new Error("not requested"); } }, ticketSource: { fetchAssignedTickets() { throw new TicketSourceError("Company network is unavailable."); }, stop() {} } });
    t.after(() => runtime.close());
    const url = await runtime.start();
    const page = await fetch(url);
    const html = await page.text();
    assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.match(html, /script nonce=/);
    const cfg = JSON.parse(/window.BUDDY_CONFIG = ([^;]+);/.exec(html)[1]);
    assert.equal(cfg.desktop, true);
    const base = new URL(url).origin;
    const headers = { "x-buddy-token": cfg.token, "content-type": "application/json" };
    const state = await (await fetch(`${base}/api/state`, { headers })).json();
    assert.equal(state.name, "Bit");
    assert.equal(githubCalls, 0);
    assert.equal((await fetch(`${base}/api/state`)).status, 401);
    assert.equal((await fetch(`${base}/api/state`, { headers: { ...headers, origin: "https://untrusted.example" } })).status, 403);
    assert.equal((await fetch(`${base}/api/update/install`, { method: "POST", headers, body: "{}" })).status, 404);
    const sync = await (await fetch(`${base}/api/sync`, { method: "POST", headers, body: "{}" })).json();
    assert.match(sync.error, /Company network/);
    assert.doesNotMatch(sync.error, /Copilot session/);
});

test("desktop Lounge requires destination consent before reading or forwarding a GitHub token", async (t) => {
    const root = fixture(t);
    let credentials = 0;
    let requests = 0;
    const destinations = [];
    const lounge = createLoungeClient({ configPath: join(root, "lounge.json"), env: {},
        authorizeSession: async (url) => { destinations.push(url); return false; },
        getGitHubToken: async () => { credentials++; return "never-send"; },
        fetch: async () => { requests++; throw new Error("No request should be sent"); } });
    t.after(() => lounge.close());
    await lounge.setServerUrl("https://trusted.example");
    await assert.rejects(lounge.join({ org: "fixture" }), /No GitHub credential was sent/);
    assert.deepEqual(destinations, ["https://trusted.example"]);
    assert.equal(credentials, 0);
    assert.equal(requests, 0);
    assert.equal(lounge.state().error.code, "untrusted_server");
});

test("Lounge authentication rejects redirects instead of replaying credentials", async (t) => {
    const root = fixture(t);
    const lounge = createLoungeClient({ configPath: join(root, "lounge.json"), env: {},
        getGitHubToken: async () => "fixture-token",
        fetch: async (_url, options) => { assert.equal(options.redirect, "error"); throw new TypeError("redirect"); } });
    t.after(() => lounge.close());
    await lounge.setServerUrl("https://trusted.example");
    await assert.rejects(lounge.join({ org: "fixture" }), /unreachable/);
    assert.equal(lounge.state().status, "error");
});

test("native bridge policy rejects foreign frames and dangerous external protocols", () => {
    const app = "http://127.0.0.1:1234/i/desktop";
    assert.equal(isAppDocument(`${app}#home`, app), true);
    for (const bad of ["https://github.com", "http://127.0.0.1:1235/i/desktop", "http://127.0.0.1:1234/static/app.js", `${app}?token=bad`]) assert.equal(isAppDocument(bad, app), false);
    for (const bad of ["file:///C:/Windows", "javascript:alert(1)", "ms-settings:test", "http://127.0.0.1:8000", "https://user:secret@example.com"]) assert.equal(safeExternalUrl(bad), null);
    assert.equal(safeExternalUrl("https://github.com/login/device"), "https://github.com/login/device");
});


test("desktop updates require a release installer and never install gist files", async () => {
    const missing = createDesktopUpdater({ current: "1.3.0", fetchImpl: async () => ({ status: 404 }) });
    assert.equal((await missing.check()).available, false);
    const updater = createDesktopUpdater({ current: "1.3.0", fetchImpl: async () => ({ ok: true, json: async () => ({ tag_name: "v1.4.0", assets: [{ name: "Setup.exe", browser_download_url: "https://untrusted.example/setup.exe" }, { name: "Byte Buddy Setup.exe", browser_download_url: "https://github.com/kylegstewart/byte-buddy/releases/download/v1.4.0/Setup.exe" }] }) }) });
    assert.equal(updater.downloadUrl(), null);
    assert.equal((await updater.check()).available, true);
    assert.match(updater.downloadUrl(), /^https:\/\/github.com\/kylegstewart\/byte-buddy\/releases\/download\//);
});
