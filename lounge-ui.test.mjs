import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { clampPoint, clientToRoom, createLoungeView, diffMembers, memberTransform, statusText, stepForKey } from "./public/lounge.js";

const html = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("./public/app.js", import.meta.url), "utf8");

test("lounge tab and panel are wired with tab aria", () => {
    assert.match(html, /<button type="button" role="tab" id="tab-lounge" aria-controls="panel-lounge" aria-selected="false" data-tab="lounge" tabindex="-1">Lounge<\/button>/);
    assert.match(html, /<section id="panel-lounge" role="tabpanel" aria-labelledby="tab-lounge" class="panel lounge" hidden>/);
    assert.match(html, /id="loungeStatus"[^>]*role="status"[^>]*aria-live="polite"/);
    assert.match(html, /<svg id="loungeRoom"[^>]*viewBox="0 0 160 120"[^>]*shape-rendering="crispEdges"[^>]*tabindex="0"[^>]*aria-label=/);
    assert.match(app, /import \{ createLoungeView \} from "\.\/lounge\.js";/);
    assert.match(app, /addEventListener\("lounge"/);
    assert.match(app, /api\("\/api\/lounge"\)/);
});

test("pure helpers clamp, convert, step, and format status", () => {
    assert.deepEqual(clampPoint(0, 0), { x: 8, y: 64 });
    assert.deepEqual(clampPoint(999, 999), { x: 152, y: 112 });
    assert.deepEqual(clampPoint(40.26, 80.04), { x: 40.3, y: 80 });
    assert.deepEqual(clientToRoom(110, 70, { left: 10, top: 10, width: 320, height: 240 }), { x: 50, y: 64 });
    assert.equal(clientToRoom(1, 1, { left: 0, top: 0, width: 0, height: 0 }), null);
    assert.deepEqual(stepForKey("ArrowLeft"), [-6, 0]);
    assert.deepEqual(stepForKey("W"), [0, -6]);
    assert.equal(stepForKey("q"), null);
    assert.equal(memberTransform({ x: 50, y: 200 }), "translate(50px, 112px)");
    assert.equal(statusText({ status: "idle" }), "Not in the lounge.");
    assert.equal(statusText({ status: "connecting" }), "Connecting…");
    assert.equal(statusText({ status: "connected", org: "meyer", members: [{}, {}] }), "Connected to meyer · 2 here");
    assert.equal(statusText({ status: "reconnecting" }), "Reconnecting…");
    assert.equal(statusText({ status: "error", error: { code: "forbidden", message: "Not a member" } }), "Not a member");
});

test("diffMembers plans keyed adds, updates, and removals", () => {
    const plan = diffMembers(["a", "b"], [{ id: "b" }, { id: "c" }, { id: "c" }]);
    assert.deepEqual(plan.add, ["c"]);
    assert.deepEqual(plan.update, ["b"]);
    assert.deepEqual(plan.remove, ["a"]);
    assert.equal(plan.next.size, 2);
});

class FakeNode {
    constructor(tag) {
        this.tag = tag; this.attrs = {}; this.style = {}; this.dataset = {}; this.children = []; this.parent = null;
        this.listeners = {}; this.innerHTML = ""; this.textContent = ""; this.value = ""; this.hidden = false; this.disabled = false;
    }
    setAttribute(name, value) { this.attrs[name] = String(value); }
    getAttribute(name) { return this.attrs[name]; }
    appendChild(child) { child.parent?.children.splice(child.parent.children.indexOf(child), 1); child.parent = this; this.children.push(child); return child; }
    remove() { this.parent?.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    dispatch(type, event = {}) { for (const fn of this.listeners[type] || []) fn({ preventDefault() {}, ...event }); }
    getBoundingClientRect() { return { left: 0, top: 0, width: 160, height: 120 }; }
}

function harness() {
    const ids = ["loungeUrlForm", "loungeUrl", "loungeUrlSave", "loungeUrlNote", "loungeOrg", "loungeOrgHint", "loungeJoin", "loungeLeave",
        "loungeStatus", "loungeRoom", "loungeMembersLayer", "loungeMemberList"];
    const elements = Object.fromEntries(ids.map((id) => [id, new FakeNode(id)]));
    const doc = { getElementById: (id) => elements[id] || null, createElementNS: (_ns, tag) => new FakeNode(tag) };
    const calls = [];
    const timers = [];
    const view = createLoungeView({
        doc, esc: (s) => String(s).replace(/</g, "&lt;"), toast: () => {},
        api: async (path, body) => { calls.push([path, body]); return { status: "connecting", serverUrl: "https://l", org: body?.org, members: [] }; },
        renderBuddy: (opts) => `<g data-stage="${opts.stage}"></g>`, buddyViewBox: () => "-44 -40 88 46",
        getOrgs: () => ["meyer", "other"], getBuddy: () => ({ stage: 2, name: "Bolt" }), setTimer: (fn) => timers.push(fn),
    });
    return { view, elements, calls, timers, layer: elements.loungeMembersLayer };
}

const connected = (members) => ({ status: "connected", serverUrl: "https://l", serverUrlSource: "config", org: "meyer", self: { id: "1", login: "me" }, members, error: null });

test("update adds, moves in place, and removes members keyed by id", () => {
    const { view, elements, layer, timers } = harness();
    view.update(connected([{ id: "1", login: "me", buddy: { stage: 1 }, x: 20, y: 80 }, { id: "2", login: "<b>", buddy: { stage: 3 }, x: 40, y: 70 }]));
    assert.equal(layer.children.length, 2);
    const self = layer.children.find((g) => g.attrs["data-id"] === "1");
    assert.equal(self.style.transform, "translate(20px, 80px)");
    assert.match(self.attrs.class, /lounge-self/);
    assert.match(layer.children.find((g) => g.attrs["data-id"] === "2").innerHTML, /&lt;b>/);
    assert.match(elements.loungeStatus.textContent, /Connected to meyer · 2 here/);
    assert.match(elements.loungeMemberList.innerHTML, /\(you\)/);
    assert.equal(elements.loungeJoin.hidden, true);
    assert.equal(elements.loungeLeave.hidden, false);

    const html = self.innerHTML;
    view.update(connected([{ id: "1", login: "me", buddy: { stage: 1 }, x: 30, y: 90 }, { id: "2", login: "<b>", buddy: { stage: 3 }, x: 40, y: 70 }]));
    assert.equal(layer.children.length, 2);
    assert.equal(layer.children.find((g) => g.attrs["data-id"] === "1"), self, "same node reused");
    assert.equal(self.style.transform, "translate(30px, 90px)");
    assert.equal(self.innerHTML, html, "buddy markup not rebuilt for a move");

    view.update(connected([{ id: "1", login: "me", buddy: { stage: 1 }, x: 30, y: 90 }]));
    assert.deepEqual(layer.children.map((g) => g.attrs["data-id"]), ["1"]);
    timers.forEach((fn) => fn());
    assert.deepEqual(layer.children.map((g) => g.attrs["data-id"]), ["1"]);
});

test("join posts org and buddy; room keys and clicks send moves only when connected", async () => {
    const { view, elements, calls } = harness();
    view.update({ status: "idle", serverUrl: "https://l", serverUrlSource: "config", org: null, self: null, members: [], error: null });
    assert.equal(elements.loungeJoin.disabled, false);
    elements.loungeOrg.value = "meyer";
    elements.loungeRoom.dispatch("click", { clientX: 50, clientY: 90 });
    elements.loungeJoin.dispatch("click");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, [["/api/lounge/join", { org: "meyer", buddy: { stage: 2, name: "Bolt" } }]]);

    view.update(connected([{ id: "1", login: "me", buddy: {}, x: 20, y: 80 }]));
    elements.loungeRoom.dispatch("keydown", { key: "ArrowRight" });
    await new Promise((resolve) => setImmediate(resolve));
    elements.loungeRoom.dispatch("click", { clientX: 50, clientY: 90 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls.slice(1), [["/api/lounge/move", { x: 26, y: 80 }], ["/api/lounge/move", { x: 50, y: 90 }]]);
});

test("env-sourced url and missing orgs disable controls", () => {
    const { view, elements } = harness();
    view.update({ status: "idle", serverUrl: "https://env", serverUrlSource: "env", members: [] });
    assert.equal(elements.loungeUrl.disabled, true);
    assert.equal(elements.loungeUrlSave.disabled, true);
    assert.equal(elements.loungeUrlNote.textContent, "Set by BYTE_BUDDY_LOUNGE_URL");
    view.unavailable();
    assert.equal(elements.loungeJoin.disabled, true);
    assert.equal(elements.loungeStatus.dataset.status, "unavailable");
});
