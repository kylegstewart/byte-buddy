import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createPetMotion } from "./public/pet-motion.js";

const html = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("./public/app.css", import.meta.url), "utf8");
const source = readFileSync(new URL("./public/app.js", import.meta.url), "utf8")
    .replace(/^import .*;\r?\n/gm, "")
    .replace(/wire\(\);\r?\nconnectEvents\(\);\r?\nloadState\(\);\r?\n(?:initUpdates\(\);\r?\n)?setInterval\(tick, 1000 \/ 12\);\s*$/, "");

// This lightweight DOM fixture verifies application contracts, not browser layout or behavior.
function fixture() {
    const nodes = new Map();
    class Element {
        constructor(id, tag = "div") {
            this.id = id; this.tagName = tag.toUpperCase(); this.value = ""; this.checked = false; this.disabled = false;
            this.hidden = false; this.attributes = {}; this.listeners = {}; this.style = {};
        }
        set innerHTML(value) {
            this.html = value; this.writes = (this.writes || 0) + 1;
            for (const [, name, id] of value.matchAll(/<(\w+)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
                const element = nodes.get(id) || new Element(id, name);
                element.parentElement = this;
                nodes.set(id, element);
            }
        }
        get innerHTML() { return this.html || ""; }
        querySelectorAll() { return []; }
        addEventListener(type, handler) { this.listeners[type] = handler; }
        setAttribute(key, value) { this.attributes[key] = value; }
        focus() { this.focused = true; }
    }
    new Element("root").innerHTML = html;
    const requests = [];
    const context = vm.createContext({
        window: {}, document: { getElementById: (id) => nodes.get(id) || null, createElement: (tag) => new Element("", tag) },
        URL, URLSearchParams, console, createPetMotion,
        fetch: async (path, options) => {
            requests.push({ path, body: options.body ? JSON.parse(options.body) : undefined });
            return { ok: true, json: async () => ({ ok: true, result: {} }) };
        },
    });
    vm.runInContext(source, context);
    const run = (code) => vm.runInContext(code, context);
    run(`state = { mode: "live", github: { settings: { enabled: false, organizations: [], repositories: [], needsScope: false } } };
        loadState = async () => {}; renderConnections();`);
    return { nodes, requests, run, set: (id, value) => { nodes.get(id).value = value; } };
}

test("Connections is an accessible GitHub-only tab with narrow themed forms", () => {
    assert.match(html, /id="tab-connections"[^>]*aria-controls="panel-connections"/);
    assert.match(html, /id="panel-connections"[^>]*role="tabpanel"/);
    assert.match(html, /id="reviewConnections"/);
    assert.doesNotMatch(html + source, /setupGate|buddyExperience|ticketConnection|\/api\/connections/);
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => id);
    assert.equal(new Set(ids).size, ids.length);
    assert.match(css, /@media \(max-width: 400px\)/);
    assert.match(css, /\.connection-stack input[^]*background: var\(--db-bg\); color: var\(--db-fg\)/);
});

test("GitHub saves organization/repository union only; empty enabled scope is rejected; drafts survive re-render", async () => {
    const ui = fixture();
    ui.nodes.get("githubConnectionEnabled").checked = true;
    await ui.run("saveGithubConnection();");
    assert.match(ui.nodes.get("connectionStatus").textContent, /at least one/);
    assert.equal(ui.requests.length, 0);
    ui.set("githubOrganizations", "org-one\norg-two\norg-one");
    ui.set("githubRepositories", "owner/repo,another/repo");
    await ui.run("saveGithubConnection();");
    const settings = ui.requests.find((item) => item.path === "/api/github/settings");
    assert.deepEqual(settings.body, { enabled: true, organizations: ["org-one", "org-two"], repositories: ["owner/repo", "another/repo"] });
    assert.equal(ui.requests.some((item) => item.path === "/api/github/sync"), false);
    const writes = ui.nodes.get("savedConnections").writes;
    ui.run("renderConnections(); renderConnections();");
    assert.equal(ui.nodes.get("savedConnections").writes, writes);
    assert.equal(ui.nodes.get("githubOrganizations").value, "org-one\norg-two\norg-one");
    ui.set("githubRepositories", "https://github.com/owner/repo");
    await ui.run("saveGithubConnection();");
    assert.match(ui.nodes.get("connectionStatus").textContent, /not URLs or wildcards/);
});

test("needsScope shows the review notice and blocks manual GitHub sync", () => {
    const ui = fixture();
    assert.equal(ui.nodes.get("connectionGithubSync").disabled, true);
    ui.run('state.github.settings = { enabled: true, organizations: [], repositories: [], needsScope: true }; renderConnections();');
    assert.equal(ui.nodes.get("connectionsNotice").hidden, false);
    assert.equal(ui.nodes.get("connectionGithubSync").disabled, true);
    ui.run('state.github.settings = { enabled: true, organizations: ["team"], repositories: [], needsScope: false }; renderConnections();');
    assert.equal(ui.nodes.get("connectionsNotice").hidden, true);
    assert.equal(ui.nodes.get("connectionGithubSync").disabled, false);
});

test("GitHub summaries disclose selected scope or retained-only history", () => {
    const ui = fixture();
    assert.match(ui.run("githubScopeNote()"), /Imports disabled.*Retained history only/);
    ui.run('state.github.settings = { enabled: true, organizations: ["team"], repositories: ["other/repo"] };');
    assert.match(ui.run("githubScopeNote()"), /Selected scope: org:team, repo:other\/repo/);
});
