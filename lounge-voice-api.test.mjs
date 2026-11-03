import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createBuddyServer } from "./server.mjs";

async function fixture(context, desktop = true) {
    const calls = [];
    const lounge = { events: new EventEmitter(), state: () => ({ status: "idle" }), close: async () => {},
        voice: async (body) => { calls.push(body); return { voiceId: "fixture" }; }, move: () => { assert.fail("Oversized movement must not reach the Lounge"); } };
    const server = createBuddyServer({ desktop, lounge, store: { events: new EventEmitter() }, sync: {}, github: {} });
    context.after(() => server.close());
    const url = await server.urlFor("voice-fixture");
    const page = await fetch(url);
    const config = JSON.parse(/window.BUDDY_CONFIG = ([^;]+);/.exec(await page.text())[1]);
    const base = new URL(url).origin;
    const headers = { "x-buddy-token": config.token, "content-type": "application/json" };
    return { base, headers, page, calls, post: (body, options = {}) => fetch(base + "/api/lounge/voice", { method: "POST", headers, body: JSON.stringify(body), ...options }) };
}

test("desktop voice API requires the local capability token and same origin", async (context) => {
    const app = await fixture(context);
    assert.equal((await app.post({ action: "join" }, { headers: {} })).status, 401);
    assert.equal((await app.post({ action: "join" }, { headers: { ...app.headers, origin: "https://untrusted.invalid" } })).status, 403);
    assert.equal((await app.post({ action: "join" }, { headers: { ...app.headers, origin: app.base } })).status, 200);
    assert.deepEqual(app.calls, [{ action: "join" }]);
    assert.match(app.page.headers.get("permissions-policy"), /microphone=\(self\), camera=\(\), display-capture=\(\)/);
    assert.match(app.page.headers.get("content-security-policy"), /connect-src 'self'/);
    const module = await fetch(app.base + "/static/lounge-voice.js");
    assert.equal(module.status, 200);
    assert.match(module.headers.get("content-type"), /javascript/);
});

test("Copilot does not expose desktop voice signaling", async (context) => {
    const app = await fixture(context, false);
    assert.equal((await app.post({ action: "join" })).status, 404);
    assert.equal(app.calls.length, 0);
});

test("only voice signaling accepts SDP above the normal 64KiB body limit", async (context) => {
    const app = await fixture(context);
    const body = { action: "publish", sessionDescription: { type: "offer", sdp: "a".repeat(90 * 1024) } };
    assert.equal((await app.post(body)).status, 200);
    assert.equal(app.calls[0].sessionDescription.sdp.length, 90 * 1024);
    await assert.rejects(fetch(app.base + "/api/lounge/move", { method: "POST", headers: app.headers, body: JSON.stringify(body) }));
    await assert.rejects(app.post({ action: "publish", sdp: "a".repeat(129 * 1024) }));
    assert.equal(app.calls.length, 1);
});
