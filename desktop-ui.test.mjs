import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
const source = readFileSync(new URL("./public/desktop.js", import.meta.url), "utf8");

async function fixture() {
    const nodes = new Map();
    for (const match of html.matchAll(/<\w+\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
        const listeners = {};
        nodes.set(match[1], { textContent: "", disabled: false, value: "", hidden: /\shidden(?:\s|>)/.test(match[0]), listeners, addEventListener: (event, callback) => { listeners[event] = callback; } });
    }
    let auth = { status: "unchecked", code: null, message: "Check sign-in" };
    let checks = 0;
    const bridge = {
        status: async () => ({ version: "1.3.0", userId: "DEV", root: "fixture", serverName: "tickets", github: auth }),
        githubCheck: async () => { checks++; return auth; },
        githubLogin: async () => auth,
        githubCancel: async () => ({ status: "signed-out", code: null, message: "Cancelled" }),
    };
    const context = vm.createContext({ window: { byteBuddyDesktop: bridge, BUDDY_CONFIG: { desktop: false } }, document: { getElementById: (id) => nodes.get(id), documentElement: { dataset: {} } }, setTimeout: () => 1, clearTimeout: () => {} });
    vm.runInContext(source, context);
    await vm.runInContext("initDesktop()", context);
    return { nodes, checks: () => checks, setAuth(value) { auth = value; }, render(value) { vm.runInContext(`renderAuth(${JSON.stringify(value)})`, context); } };
}

test("desktop device sign-in stays hidden until a real code is available", async () => {
    const ui = await fixture();
    ui.render({ status: "signing-in", code: null, message: "Requesting code" });
    assert.equal(ui.nodes.get("desktopGithubDevice").hidden, true);
    assert.equal(ui.nodes.get("desktopGithubCode").hidden, true);
    assert.equal(ui.nodes.get("desktopGithubCancel").hidden, false);
    assert.equal(ui.nodes.get("desktopGithubLogin").disabled, true);
    ui.render({ status: "signing-in", code: "ABCD-1234", message: "Ready" });
    assert.equal(ui.nodes.get("desktopGithubDevice").hidden, false);
    assert.equal(ui.nodes.get("desktopGithubCode").textContent, "One-time GitHub code: ABCD-1234");
});

test("Check existing sign-in transitions a pending device UI into the connected state", async () => {
    const ui = await fixture();
    ui.render({ status: "signing-in", code: "ABCD-1234", message: "Pending" });
    ui.setAuth({ status: "signed-in", code: null, login: "fixture-user", message: "Signed in as fixture-user" });
    await ui.nodes.get("desktopGithubCheck").listeners.click();
    assert.equal(ui.checks(), 1);
    assert.equal(ui.nodes.get("desktopGithubDevice").hidden, true);
    assert.equal(ui.nodes.get("desktopGithubCancel").hidden, true);
    assert.equal(ui.nodes.get("desktopGithubCode").hidden, true);
    assert.equal(ui.nodes.get("desktopGithubLogin").disabled, true);
    assert.equal(ui.nodes.get("desktopGithubLogin").textContent, "GitHub connected");
    assert.match(ui.nodes.get("desktopGithubStatus").textContent, /fixture-user/);
});

test("cancelling clears the displayed code and re-enables sign-in", async () => {
    const ui = await fixture();
    ui.render({ status: "signing-in", code: "ABCD-1234", message: "Pending" });
    await ui.nodes.get("desktopGithubCancel").listeners.click();
    assert.equal(ui.nodes.get("desktopGithubLogin").disabled, false);
    assert.equal(ui.nodes.get("desktopGithubCode").textContent, "");
    assert.equal(ui.nodes.get("desktopGithubDevice").hidden, true);
    assert.equal(ui.nodes.get("desktopGithubCancel").hidden, true);
});

test("desktop onboarding and its native bridge no longer offer legacy save import", async () => {
    const ui = await fixture();
    assert.equal(ui.nodes.has("desktopImportFolder"), false);
    assert.equal(ui.nodes.has("desktopImportFile"), false);
    assert.match(ui.nodes.get("desktopStatus").textContent, /Copilot saves are not imported/);
    const preload = readFileSync(new URL("./desktop/preload.cjs", import.meta.url), "utf8");
    assert.doesNotMatch(preload, /importSave|desktop:import-save/);
});
