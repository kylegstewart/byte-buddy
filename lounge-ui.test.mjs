import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SPEED, approach, clampPoint, createLoungeView, diffMembers, directionForKey, heldVelocity, memberTransform, statusText } from "./public/lounge.js";

const html = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("./public/app.js", import.meta.url), "utf8");

test("lounge tab and panel are wired with tab aria", () => {
    assert.match(html, /<button type="button" role="tab" id="tab-lounge" aria-controls="panel-lounge" aria-selected="false" data-tab="lounge" tabindex="-1">Lounge<\/button>/);
    assert.match(html, /<section id="panel-lounge" role="tabpanel" aria-labelledby="tab-lounge" class="panel lounge" hidden>/);
    assert.match(html, /id="loungeStatus"[^>]*role="status"[^>]*aria-live="polite"/);
    assert.match(html, /<svg id="loungeRoom"[^>]*viewBox="0 0 720 450"[^>]*shape-rendering="crispEdges"[^>]*tabindex="0"[^>]*aria-label=/);
    assert.match(app, /import \{ createLoungeView \} from "\.\/lounge\.js";/);
    assert.match(app, /addEventListener\("lounge"/);
    assert.match(app, /api\("\/api\/lounge"\)/);
});

test("pure helpers clamp, map arrow keys, smooth, and format status", () => {
    assert.deepEqual(clampPoint(-5, -5), { x: 0, y: 0 });
    assert.deepEqual(clampPoint(9999, 9999), { x: 3160, y: 1280 });
    assert.deepEqual(clampPoint(40.26, 80.04), { x: 40.3, y: 80 });
    assert.deepEqual(directionForKey("ArrowLeft"), [-1, 0]);
    assert.equal(directionForKey("w"), null, "arrow keys only");
    assert.equal(directionForKey("q"), null);
    assert.deepEqual(heldVelocity(new Set(["arrowleft", "arrowright"])), [0, 0], "opposites cancel");
    const [dx, dy] = heldVelocity(new Set(["arrowright", "arrowdown"]));
    assert.ok(Math.abs(Math.hypot(dx, dy) - 1) < 1e-9, "diagonals are normalized");
    assert.deepEqual(approach({ x: 0, y: 0 }, { x: 10, y: 0 }, 4), { x: 4, y: 0 });
    assert.deepEqual(approach({ x: 0, y: 0 }, { x: 3, y: 0 }, 4), { x: 3, y: 0 });
    assert.deepEqual(approach({ x: 0, y: 0 }, { x: 500, y: 0 }, 4), { x: 500, y: 0 }, "far jumps snap");
    assert.equal(memberTransform({ x: 50.04, y: 80.26 }), "translate(50px, 80.3px)");
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
        "loungeStatus", "loungeRoom", "loungeMembersLayer", "loungeMemberList", "loungeSceneryFar", "loungeSceneryMid", "loungeSceneryNear", "loungeMap", "loungeLabels"];
    const elements = Object.fromEntries(ids.map((id) => [id, new FakeNode(id)]));
    const doc = { getElementById: (id) => elements[id] || null, createElementNS: (_ns, tag) => new FakeNode(tag) };
    const calls = [];
    const frames = [];
    const clock = { t: 1000 };
    const view = createLoungeView({
        doc, esc: (s) => String(s).replace(/</g, "&lt;"), toast: () => {},
        api: async (path, body) => { calls.push([path, body]); return { status: "connecting", serverUrl: "https://l", org: body?.org, members: [] }; },
        renderBuddy: (opts) => `<g data-stage="${opts.stage}" data-pose="${opts.pose}" data-frame="${opts.frame}" data-look="${opts.look}"></g>`, buddyViewBox: () => "-44 -40 88 46",
        getOrgs: () => ["meyer", "other"], getBuddy: () => ({ stage: 2, name: "Bolt" }),
        raf: (fn) => frames.push(fn), now: () => clock.t,
    });
    // Advances the fake clock frame by frame, running the animation loop like requestAnimationFrame would.
    const run = (ms, step = 16) => {
        for (let elapsed = 0; elapsed < ms; elapsed += step) {
            clock.t += step;
            frames.splice(0).forEach((fn) => fn());
        }
    };
    return { view, elements, calls, frames, run, clock, layer: elements.loungeMembersLayer };
}

const xOf = (node) => Number(/translate\(([\d.]+)px/.exec(node.style.transform)[1]);
const flush = () => new Promise((resolve) => setImmediate(resolve));

const connected = (members) => ({ status: "connected", serverUrl: "https://l", serverUrlSource: "config", org: "meyer", self: { id: "1", login: "me" }, members, error: null });

test("update adds, smooths remote moves in place, and removes members keyed by id", () => {
    const { view, elements, layer, run } = harness();
    view.update(connected([{ id: "1", login: "me", buddy: { stage: 1 }, x: 1600, y: 780 }, { id: "2", login: "<b>", buddy: { stage: 3 }, x: 1640, y: 770 }]));
    assert.equal(layer.children.length, 2);
    const self = layer.children.find((g) => g.attrs["data-id"] === "1");
    const other = layer.children.find((g) => g.attrs["data-id"] === "2");
    assert.equal(self.style.transform, "translate(1600px, 780px)");
    assert.match(self.attrs.class, /lounge-self/);
    assert.match(other.children[1].innerHTML, /&lt;b>/);
    assert.match(other.children[0].innerHTML, /data-stage="3"/);
    assert.match(elements.loungeStatus.textContent, /Connected to meyer · 2 here/);
    assert.match(elements.loungeMemberList.innerHTML, /\(you\)/);
    assert.equal(elements.loungeJoin.hidden, true);
    assert.equal(elements.loungeLeave.hidden, false);

    const label = other.children[1].innerHTML;
    view.update(connected([{ id: "1", login: "me", buddy: { stage: 1 }, x: 1600, y: 780 }, { id: "2", login: "<b>", buddy: { stage: 3 }, x: 1650, y: 770 }]));
    assert.equal(layer.children.find((g) => g.attrs["data-id"] === "2"), other, "same node reused");
    run(48);
    assert.ok(xOf(other) > 1640 && xOf(other) < 1650, "remote buddy walks toward its new spot");
    assert.match(other.children[0].innerHTML, /data-stage="3"/);
    run(400);
    assert.equal(other.style.transform, "translate(1650px, 770px)");
    assert.equal(other.children[1].innerHTML, label, "label not rebuilt for a move");

    view.update(connected([{ id: "1", login: "me", buddy: { stage: 1 }, x: 1600, y: 780 }]));
    run(32);
    assert.deepEqual(layer.children.map((g) => g.attrs["data-id"]), ["1"]);
});

test("walking switches the sprite to animated walk frames and back to standing", () => {
    const { view, elements, run } = harness();
    view.update(connected([{ id: "1", login: "me", buddy: {}, x: 1600, y: 780 }]));
    const sprite = elements.loungeMembersLayer.children[0].children[0];
    assert.match(sprite.innerHTML, /data-pose="stand"/);
    elements.loungeRoom.dispatch("keydown", { key: "ArrowLeft" });
    const frames = new Set();
    for (let i = 0; i < 20; i++) {
        run(16);
        assert.match(sprite.innerHTML, /data-pose="walk"[^>]*data-look="-1"/);
        frames.add(/data-frame="(\d+)"/.exec(sprite.innerHTML)[1]);
    }
    assert.ok(frames.size >= 2, "walk frames advance while moving");
    elements.loungeRoom.dispatch("keyup", { key: "ArrowLeft" });
    run(300);
    assert.match(sprite.innerHTML, /data-pose="stand"/);
});

test("arrow keys move instantly, stop on release, and never use clicks", async () => {
    const { view, elements, calls, run, layer } = harness();
    view.update({ status: "idle", serverUrl: "https://l", serverUrlSource: "config", org: null, self: null, members: [], error: null });
    assert.equal(elements.loungeJoin.disabled, false);
    elements.loungeOrg.value = "meyer";
    elements.loungeJoin.dispatch("click");
    await flush();
    assert.deepEqual(calls, [["/api/lounge/join", { org: "meyer", buddy: { stage: 2, name: "Bolt" } }]]);

    view.update(connected([{ id: "1", login: "me", buddy: {}, x: 1600, y: 780 }]));
    const self = layer.children[0];
    elements.loungeRoom.dispatch("click", { clientX: 50, clientY: 90 });
    elements.loungeRoom.dispatch("keydown", { key: "w" });
    run(100);
    await flush();
    assert.equal(calls.length, 1, "clicks and WASD do not move");
    assert.equal(self.style.transform, "translate(1600px, 780px)");

    elements.loungeRoom.dispatch("keydown", { key: "ArrowRight" });
    run(16);
    assert.ok(xOf(self) > 1600, "moves on the very next frame without waiting for the server");
    for (let i = 0; i < 20; i++) elements.loungeRoom.dispatch("keydown", { key: "ArrowRight" });
    run(484);
    const travelled = xOf(self) - 1600;
    assert.ok(Math.abs(travelled - SPEED * 0.512) < 1, `constant speed despite key repeat (moved ${travelled})`);
    elements.loungeRoom.dispatch("keyup", { key: "ArrowRight" });
    const stopped = self.style.transform;
    run(300);
    assert.equal(self.style.transform, stopped, "no drift after release");

    await flush(); await flush();
    const moves = calls.slice(1);
    assert.ok(moves.every(([path]) => path === "/api/lounge/move"));
    assert.ok(moves.length >= 2 && moves.length <= 7, `throttled sends (${moves.length})`);
    assert.deepEqual(moves.at(-1)[1], clampPoint(xOf(self), 780), "final position sent on release");

    view.update(connected([{ id: "1", login: "me", buddy: {}, x: 1605, y: 780 }]));
    run(32);
    assert.equal(self.style.transform, stopped, "stale server echo does not pull the local buddy back");
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

test("camera holds inside the dead zone, scrolls near edges, and parallax keeps others in world coordinates", () => {
    const { view, elements, run, layer } = harness();
    view.update(connected([{ id: "1", login: "me", buddy: {}, x: 1600, y: 780 }, { id: "2", login: "pal", buddy: {}, x: 1650, y: 770 }]));
    run(1000);
    const camX = () => Number(elements.loungeRoom.attrs.viewBox.split(" ")[0]);
    const shift = (id) => Number(/translate\(([-\d.]+)/.exec(elements[id].attrs.transform)[1]);
    const other = layer.children.find((g) => g.attrs["data-id"] === "2");
    const start = camX();
    elements.loungeRoom.dispatch("keydown", { key: "ArrowRight" });
    run(240);
    elements.loungeRoom.dispatch("keyup", { key: "ArrowRight" });
    run(500);
    assert.equal(camX(), start, "small moves inside the dead zone do not scroll");
    elements.loungeRoom.dispatch("keydown", { key: "ArrowRight" });
    run(2000);
    elements.loungeRoom.dispatch("keyup", { key: "ArrowRight" });
    run(1000);
    const settled = camX();
    assert.ok(settled > start + 100, `camera scrolled right (${start} -> ${settled})`);
    run(1000);
    assert.equal(camX(), settled, "camera settles without recentering");
    assert.equal(other.style.transform, "translate(1650px, 770px)", "remote buddy stays at its world position");
    assert.ok(shift("loungeSceneryFar") > shift("loungeSceneryMid") && shift("loungeSceneryMid") > shift("loungeSceneryNear"), "far layers drift less on screen");
});