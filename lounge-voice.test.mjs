import test from "node:test";
import assert from "node:assert/strict";
import { createVoiceService } from "./lounge-server/voice.mjs";
import { createLoungeServer } from "./lounge-server/server.mjs";

const ENV = { CF_REALTIME_APP_ID: "app-id", CF_REALTIME_APP_SECRET: "app-secret",
    CF_TURN_KEY_ID: "turn-key", CF_TURN_API_TOKEN: "turn-token" };
const response = (body, status = 200) => Response.json(body, { status });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
};
const audio = (type = "offer", mids = ["0"], direction = "sendonly", padding = "") => ({ type, sdp:
    ["v=0", "o=- 1 1 IN IP4 127.0.0.1", "s=-", "t=0 0", ...mids.flatMap((mid) => [
        "m=audio 9 UDP/TLS/RTP/SAVPF 111", "a=mid:" + mid, "a=" + direction,
        "a=rtcp-mux", "a=rtpmap:111 opus/48000/2", ...(padding ? ["a=padding:" + padding] : []),
    ]), ""].join("\r\n") });
class VoiceError extends Error {
    constructor(status, code, message) { super(message); Object.assign(this, { status, code }); }
}

function cloudflare() {
    const calls = [];
    const sessions = new Map();
    let counter = 0;
    let gate;
    let override;
    const fetchImpl = async (url, options) => {
        const call = { url, ...options, body: options.body ? JSON.parse(options.body) : undefined };
        calls.push(call);
        assert.equal(new URL(url).origin, "https://rtc.live.cloudflare.com");
        assert.equal(options.redirect, "error");
        const turn = url.includes("/turn/");
        assert.equal(options.headers.Authorization, "Bearer " + (turn ? ENV.CF_TURN_API_TOKEN : ENV.CF_REALTIME_APP_SECRET));
        if (gate?.matches(call)) {
            const current = gate;
            gate = undefined;
            current.started.resolve(call);
            await current.release.promise;
        }
        const custom = await override?.(call);
        if (custom) return custom;
        if (turn) return response({ iceServers: [
            { urls: ["stun:stun.cloudflare.com:3478"] },
            { urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp",
                "turn:attacker.invalid:3478", "turn:turn.cloudflare.com:53?transport=udp"],
            username: "short-user", credential: "short-password", extra: "never-forward" },
        ] }, 201);
        if (url.endsWith("/sessions/new")) {
            const sessionId = "sfu-session-" + ++counter;
            sessions.set(sessionId, new Map());
            return response({ sessionId }, 201);
        }
        const sessionId = /\/sessions\/([^/]+)/.exec(url)?.[1];
        const tracks = sessions.get(sessionId);
        assert.ok(tracks, "server-owned SFU session exists");
        if (options.method === "GET") return response({ tracks: [...tracks.values()] });
        if (url.endsWith("/tracks/new")) {
            const local = call.body.tracks[0].location === "local";
            const allocated = call.body.tracks.map((track, index) => ({ ...track,
                mid: local ? track.mid : String(index), status: "active" }));
            for (const track of allocated) tracks.set(track.mid, track);
            return response({ tracks: allocated, requiresImmediateRenegotiation: !local,
                sessionDescription: audio(local ? "answer" : "offer", allocated.map((track) => track.mid), local ? "recvonly" : "sendonly") });
        }
        if (url.endsWith("/tracks/close")) {
            assert.equal(options.method, "PUT");
            assert.equal(call.body.force, true);
            for (const track of call.body.tracks) tracks.delete(track.mid);
            return response({ tracks: call.body.tracks, requiresImmediateRenegotiation: false });
        }
        assert.ok(url.endsWith("/renegotiate"));
        assert.equal(options.method, "PUT");
        return response({});
    };
    return { calls, sessions, fetchImpl,
        override(callback) { override = callback; },
        gate(matches) {
            gate = { matches, started: deferred(), release: deferred() };
            return gate;
        },
        live() { return [...sessions.values()].reduce((sum, tracks) => sum + tracks.size, 0); },
    };
}

function fixture(context, options = {}) {
    const cf = cloudflare();
    const rooms = new Map();
    const service = createVoiceService({ env: ENV, fetchImpl: cf.fetchImpl, rooms,
        staleMs: 60_000, ErrorType: VoiceError, ...options });
    context.after(() => service.close());
    const add = (id, org = "org-a", x = 100, y = 100) => {
        const session = { sessionId: "lounge-session-" + id, userId: id, org };
        const member = { id, sessionId: session.sessionId, x, y, lastSeen: Date.now() };
        if (!rooms.has(org)) rooms.set(org, new Map());
        rooms.get(org).set(id, member);
        return { session, member, request: (action, body = {}) => service.handle(session, { action, ...body }) };
    };
    const join = async (person) => { const joined = await person.request("join"); person.voiceId = joined.voiceId; return joined; };
    const signal = (person, action, body = {}) => person.request(action, { voiceId: person.voiceId, ...body });
    const publish = (person, body = {}) => signal(person, "publish", { mid: "0", sessionDescription: audio(), ...body });
    const move = async (person, x, y) => {
        Object.assign(person.member, { x, y });
        await service.moved(person.session.org);
    };
    return { cf, rooms, service, add, join, signal, publish, move };
}

test("voice requires the exact live room session and all four credentials", async (context) => {
    const fixtureOne = fixture(context);
    const person = fixtureOne.add(1);
    await assert.rejects(fixtureOne.service.handle({ ...person.session, sessionId: "old" }, { action: "join" }), { code: "voice_not_in_room" });
    fixtureOne.rooms.clear();
    await assert.rejects(person.request("join"), { code: "voice_not_in_room" });
    assert.equal(fixtureOne.cf.calls.length, 0);
    for (const key of Object.keys(ENV)) {
        const missing = fixture(context, { env: { ...ENV, [key]: "" } });
        await assert.rejects(missing.add(1).request("join"), { status: 503, code: "voice_not_configured" });
        assert.equal(missing.cf.calls.length, 0);
    }
});

test("join returns only short-lived allowlisted TURN credentials with TLS443; publisher identifiers are server-owned", async (context) => {
    const { cf, add, join, publish, signal } = fixture(context);
    const alice = add(1);
    const joined = await join(alice);
    assert.deepEqual(Object.keys(joined).sort(), ["iceServers", "radius", "voiceId"]);
    assert.equal(joined.radius, 480);
    assert.equal(cf.calls[0].body.ttl, 3600);
    assert.ok(joined.iceServers.some((server) => server.urls.includes("turns:turn.cloudflare.com:443?transport=tcp")));
    assert.doesNotMatch(JSON.stringify(joined), /app-secret|turn-token|attacker|extra|:53/);
    const published = await publish(alice, { sessionId: "attacker-session", trackName: "attacker-track" });
    assert.deepEqual(Object.keys(published), ["sessionDescription"]);
    assert.equal(published.sessionDescription.type, "answer");
    const pushed = cf.calls.find((call) => call.url.endsWith("/tracks/new")).body;
    assert.equal(pushed.tracks.length, 1);
    assert.deepEqual(Object.keys(pushed.tracks[0]).sort(), ["kind", "location", "mid", "trackName"]);
    assert.notEqual(pushed.tracks[0].trackName, "attacker-track");
    assert.deepEqual(await signal(alice, "listen"), { subscriptionId: null, sessionDescription: null, tracks: [] });
});

test("status and listen use the same same-org Euclidean radius and never client peer lists", async (context) => {
    const { cf, add, join, signal, publish, move } = fixture(context);
    const listener = add(10);
    const near = add(2, "org-a", 388, 484);
    const diagonal = add(3, "org-a", 500, 500);
    const otherOrg = add(4, "org-b");
    const silent = add(5);
    for (const person of [listener, near, diagonal, otherOrg, silent]) await join(person);
    for (const person of [near, diagonal, otherOrg]) await publish(person);
    const status = await signal(listener, "status");
    assert.deepEqual(status.peers.map((peer) => peer.id), [2]);
    assert.match(status.peers[0].revision, /^[0-9a-f]{48}$/);
    assert.equal(status.subscriptionId, null);
    assert.doesNotMatch(JSON.stringify(status), /sfu-session|trackName|app-secret|short-password/);
    const received = await signal(listener, "listen", { peers: [3, 4], sessionId: "evil" });
    assert.deepEqual(received.tracks, [{ mid: "0", id: 2 }]);
    const pull = cf.calls.filter((call) => call.url.endsWith("/tracks/new")).at(-1);
    assert.equal(pull.body.tracks.length, 1);
    assert.equal(pull.body.sessionDescription, undefined);
    assert.equal(pull.body.tracks[0].location, "remote");
    await move(near, 388.1, 484);
    assert.deepEqual(await signal(listener, "status"), { peers: [], subscriptionId: null });
    assert.ok(cf.calls.some((call) => call.url === pull.url.replace("/new", "/close")));
});

test("receiver answer renegotiates only its server-owned session and stale answers fail", async (context) => {
    const { add, join, publish, signal, cf } = fixture(context);
    const listener = add(1);
    const publisher = add(2);
    await join(listener); await join(publisher); await publish(publisher);
    const first = await signal(listener, "listen");
    await assert.rejects(signal(listener, "answer", { subscriptionId: "guessed", sessionDescription: audio("answer", ["0"], "recvonly") }), { code: "voice_stale" });
    await assert.rejects(signal(listener, "answer", { subscriptionId: first.subscriptionId, sessionDescription: audio("answer", ["0"], "sendrecv") }), { code: "bad_voice_sdp" });
    assert.deepEqual(await signal(listener, "answer", { subscriptionId: first.subscriptionId,
        sessionDescription: audio("answer", ["0"], "recvonly") }), {});
    assert.equal(cf.calls.filter((call) => call.url.endsWith("/renegotiate")).length, 1);
    const second = await signal(listener, "listen");
    assert.notEqual(second.subscriptionId, first.subscriptionId);
    await assert.rejects(signal(listener, "answer", { subscriptionId: first.subscriptionId,
        sessionDescription: audio("answer", ["0"], "recvonly") }), { code: "voice_stale" });
});

test("moving either endpoint revokes answered and unanswered subscriptions without waiting for status", async (context) => {
    for (const answered of [false, true]) {
        for (const moving of ["listener", "publisher"]) {
            const { add, join, publish, signal, move, cf } = fixture(context);
            const listener = add(1); const publisher = add(2);
            await join(listener); await join(publisher); await publish(publisher);
            const received = await signal(listener, "listen");
            if (answered) await signal(listener, "answer", { subscriptionId: received.subscriptionId,
                sessionDescription: audio("answer", ["0"], "recvonly") });
            const pull = cf.calls.filter((call) => call.url.endsWith("/tracks/new")).at(-1);
            await move(moving === "listener" ? listener : publisher, 2000, 100);
            assert.ok(cf.calls.some((call) => call.url === pull.url.replace("/new", "/close")));
            assert.deepEqual(await signal(listener, "status"), { peers: [], subscriptionId: null });
            await assert.rejects(signal(listener, "answer", { subscriptionId: received.subscriptionId,
                sessionDescription: audio("answer", ["0"], "recvonly") }), { code: "voice_stale" });
        }
    }
});

test("publisher generation changes revoke receivers and leave is idempotent", async (context) => {
    const { add, join, publish, signal, cf } = fixture(context);
    const listener = add(1); const publisher = add(2);
    await join(listener); await join(publisher); await publish(publisher);
    const revision = (await signal(listener, "status")).peers[0].revision;
    await signal(listener, "listen");
    await publish(publisher);
    const updated = await signal(listener, "status");
    assert.notEqual(updated.peers[0].revision, revision);
    assert.equal(updated.subscriptionId, null);
    await signal(listener, "listen");
    assert.deepEqual(await signal(publisher, "leave"), {});
    assert.deepEqual(await signal(publisher, "leave"), {});
    assert.equal(cf.live(), 0);
    await assert.rejects(signal(publisher, "publish", { mid: "0", sessionDescription: audio() }), { code: "voice_stale" });
});

test("SDP rejects video, data, multiple audio, wrong mids, malformed and oversized input before upstream", async (context) => {
    const { add, join, publish, cf } = fixture(context);
    const person = add(1); await join(person);
    for (const sdp of [audio().sdp.replace("m=audio", "m=video"),
        audio().sdp + "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n",
        audio("offer", ["0", "1"]).sdp, audio().sdp.replace("a=mid:0", "a=mid:1"),
        "v=0\r\n", audio("offer", ["0"], "recvonly").sdp,
        audio("offer", ["0"], "sendonly", "x".repeat(97 * 1024)).sdp]) {
        await assert.rejects(publish(person, { sessionDescription: { type: "offer", sdp } }), { code: "bad_voice_sdp" });
    }
    assert.equal(cf.calls.length, 1);
    await publish(person, { sessionDescription: audio("offer", ["0"], "sendonly", "x".repeat(20_000)) });
});

test("nearby cap chooses the closest twelve and preserves subscription ordering while moving", async (context) => {
    const { add, join, publish, signal, move } = fixture(context);
    const listener = add(20); await join(listener);
    let moving;
    for (const id of [14, 9, 3, 8, 1, 11, 2, 7, 4, 6, 5, 12, 13]) {
        const person = add(id, "org-a", id === 1 ? 500 : 100); await join(person); await publish(person);
        if (id === 2) moving = person;
    }
    const expected = [2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14];
    assert.deepEqual((await signal(listener, "status")).peers.map((peer) => peer.id), expected);
    const subscription = await signal(listener, "listen");
    assert.deepEqual(subscription.tracks.map((track) => track.id), expected);
    await move(moving, 110, 100);
    assert.equal((await signal(listener, "status")).subscriptionId, subscription.subscriptionId);
});

test("listen allocation racing movement is retired, including tracks created after revocation", async (context) => {
    const { add, join, publish, signal, cf, move } = fixture(context);
    const listener = add(1); const publisher = add(2);
    await join(listener); await join(publisher); await publish(publisher);
    const gate = cf.gate((call) => call.url.endsWith("/tracks/new") && call.body.tracks[0].location === "remote");
    const pending = signal(listener, "listen");
    const rejected = assert.rejects(pending, { code: "voice_stale" });
    const pulled = await gate.started.promise;
    await move(publisher, 2000, 100);
    await move(publisher, 100, 100);
    gate.release.resolve(); await rejected;
    assert.ok(cf.calls.some((call) => call.url === pulled.url.replace("/new", "/close")));
    assert.equal(cf.live(), 1);
    assert.equal((await signal(listener, "status")).subscriptionId, null);
});

test("publish racing leave and stream replacement cannot resurrect late tracks", async (context) => {
    for (const replacement of [false, true]) {
        const { add, join, publish, signal, service, rooms, cf } = fixture(context);
        const person = add(1); await join(person);
        const gate = cf.gate((call) => call.url.endsWith("/tracks/new"));
        const pending = publish(person);
        const rejected = assert.rejects(pending, { code: "voice_stale" });
        await gate.started.promise;
        if (replacement) {
            rooms.get("org-a").set(1, { ...person.member, sessionId: "replacement" });
            await service.removed(person.member, "org-a");
        } else await signal(person, "leave");
        gate.release.resolve(); await rejected;
        assert.equal(cf.live(), 0);
    }
});

test("answer racing revocation is stale and cannot restore the receive tracks", async (context) => {
    const { add, join, publish, signal, move, cf } = fixture(context);
    const listener = add(1); const publisher = add(2);
    await join(listener); await join(publisher); await publish(publisher);
    const subscription = await signal(listener, "listen");
    const gate = cf.gate((call) => call.url.endsWith("/renegotiate"));
    const rejected = assert.rejects(signal(listener, "answer", { subscriptionId: subscription.subscriptionId,
        sessionDescription: audio("answer", ["0"], "recvonly") }), { code: "voice_stale" });
    await gate.started.promise;
    await move(listener, 2000, 100);
    gate.release.resolve(); await rejected;
    assert.equal(cf.live(), 1);
});

test("join replacement invalidates an in-flight TURN response and rate limits cannot reset with new voice IDs", async (context) => {
    const { add, join, cf, signal } = fixture(context);
    const person = add(1);
    const gate = cf.gate((call) => call.url.includes("/turn/"));
    const rejected = assert.rejects(join(person), { code: "voice_stale" });
    await gate.started.promise;
    const replacement = await join(person);
    gate.release.resolve(); await rejected;
    person.voiceId = replacement.voiceId;
    await join(person); await join(person);
    await assert.rejects(join(person), { code: "voice_rate_limited" });
    assert.equal(cf.calls.filter((call) => call.url.includes("/turn/")).length, 4);
    for (let count = 0; count < 30; count++) await signal(person, "listen");
    await assert.rejects(signal(person, "listen"), { code: "voice_rate_limited" });
});

test("close retries invalidate voice and its source publishers; item failures cannot be mistaken for success", async (context) => {
    const { add, join, publish, signal, move, cf } = fixture(context);
    const listener = add(1); const publisher = add(2);
    await join(listener); await join(publisher); await publish(publisher);
    await signal(listener, "listen");
    let failed = false;
    cf.override((call) => {
        if (!failed && call.url.endsWith("/tracks/close")) {
            failed = true;
            return response({ tracks: call.body.tracks.map((track) => ({ ...track, errorCode: "temporary_failure" })) });
        }
    });
    await move(publisher, 2000, 100);
    await assert.rejects(signal(listener, "status"), { code: "voice_stale" });
    await assert.rejects(signal(publisher, "status"), { code: "voice_stale" });
    assert.equal(cf.live(), 0);
});

test("exhausted cleanup disables new voice, retains unresolved work, and keeps errors generic", async (context) => {
    const { add, join, publish, signal, cf } = fixture(context);
    const person = add(1); await join(person); await publish(person);
    cf.override((call) => call.url.endsWith("/tracks/close") ? response({ errorCode: "private", errorDescription: "app-secret private-sdp" }, 503) : undefined);
    await assert.rejects(signal(person, "leave"), (error) => {
        assert.equal(error.code, "voice_unavailable");
        assert.doesNotMatch(error.message, /app-secret|private-sdp/);
        return true;
    });
    assert.equal(cf.calls.filter((call) => call.url.endsWith("/tracks/close")).length, 3);
    await assert.rejects(join(person), { status: 503, code: "voice_unavailable" });
    cf.override(undefined);
});

test("room removal, expiry, and server shutdown close all published and receiver tracks", async (context) => {
    const { add, join, publish, signal, service, rooms, cf } = fixture(context);
    const listener = add(1); const publisher = add(2);
    await join(listener); await join(publisher); await publish(publisher);
    await signal(listener, "listen");
    publisher.member.lastSeen = Date.now() - 70_000;
    await service.moved("org-a");
    assert.deepEqual(await signal(listener, "status"), { peers: [], subscriptionId: null });
    await service.close();
    assert.equal(cf.live(), 0);
    assert.equal(rooms.get("org-a").size, 2);
});

async function httpFixture(context, configured = true, options = {}) {
    const cf = cloudflare();
    const lounge = createLoungeServer({ host: "127.0.0.1", port: 0, env: configured ? ENV : {}, staleMs: 60_000,
        fetch: (url, init) => {
            if (!url.startsWith("https://api.github.com")) return cf.fetchImpl(url, init);
            const id = Number(init.headers.Authorization.split(" ")[1].slice(4));
            return Promise.resolve(response(url.endsWith("/user") ? { id, login: "user" + id } : { state: "active" }));
        }, ...options });
    const { port } = await lounge.listen();
    const base = "http://127.0.0.1:" + port;
    context.after(() => lounge.close());
    const post = async (path, body, authorization) => {
        const result = await fetch(base + path, { method: "POST", headers: {
            "Content-Type": "application/json", ...(authorization ? { Authorization: authorization } : {}),
        }, body: JSON.stringify(body) });
        return { status: result.status, body: await result.json() };
    };
    const session = async (id = 1) => (await post("/v1/session", { org: "org-a" }, "Bearer tok-" + id)).body.session;
    const stream = async (token) => {
        const controller = new AbortController();
        const response = await fetch(base + "/v1/stream", { headers: { Authorization: "Session " + token }, signal: controller.signal });
        const reader = response.body.getReader();
        await reader.read();
        context.after(() => { controller.abort(); reader.cancel().catch(() => {}); });
        return { close: () => controller.abort(), response };
    };
    const voice = (token, body) => post("/v1/voice", body, "Session " + token);
    return { lounge, cf, base, post, session, stream, voice };
}

test("HTTP voice authenticates before signaling, missing config leaves presence working, and body cap is voice-only", async (context) => {
    const missing = await httpFixture(context, false);
    assert.equal((await missing.post("/v1/voice", { action: "join" })).status, 401);
    assert.equal((await missing.post("/v1/voice", { action: "join" }, "Bearer tok-1")).status, 401);
    const token = await missing.session();
    assert.equal((await missing.voice(token, { action: "join" })).body.code, "voice_not_in_room");
    await missing.stream(token);
    const result = await missing.voice(token, { action: "join" });
    assert.equal(result.status, 503);
    assert.equal(result.body.code, "voice_not_configured");
    assert.deepEqual((await missing.post("/v1/heartbeat", {}, "Session " + token)).body, { ok: true });
    assert.equal((await fetch(missing.base + "/healthz").then((result) => result.json())).members, 1);
    const live = await httpFixture(context);
    const session = await live.session(); await live.stream(session);
    const joined = await live.voice(session, { action: "join" });
    const published = await live.voice(session, { action: "publish", voiceId: joined.body.voiceId,
        mid: "0", sessionDescription: audio("offer", ["0"], "sendonly", "x".repeat(20_000)) });
    assert.equal(published.status, 200);
    assert.equal(published.body.ok, true);
    assert.equal((await live.post("/v1/heartbeat", { padding: "x".repeat(20_000) }, "Session " + session)).status, 413);
    assert.equal((await live.voice(session, { action: "join", padding: "x".repeat(130 * 1024) })).status, 413);
    const replaced = await live.session(); await live.stream(replaced);
    assert.equal((await live.voice(session, { action: "join" })).body.code, "voice_not_in_room");
    await live.post("/v1/leave", {}, "Session " + session);
    assert.equal((await fetch(live.base + "/healthz").then((result) => result.json())).members, 1);
    await live.lounge.close();
    assert.equal(live.cf.live(), 0);
});

test("HTTP movement, SSE disconnect, and expiry actively force-close receiver tracks", async (context) => {
    for (const reason of ["move", "disconnect", "expire", "leave"]) {
        const live = await httpFixture(context, true, reason === "expire" ? { staleMs: 150, sweepMs: 15 } : {});
        const first = await live.session(1); const second = await live.session(2);
        await live.stream(first); const other = await live.stream(second);
        await live.post("/v1/move", { x: 100, y: 100 }, "Session " + first);
        await live.post("/v1/move", { x: 100, y: 100 }, "Session " + second);
        const listener = (await live.voice(first, { action: "join" })).body.voiceId;
        const publisher = (await live.voice(second, { action: "join" })).body.voiceId;
        await live.voice(second, { action: "publish", voiceId: publisher, mid: "0", sessionDescription: audio() });
        assert.ok((await live.voice(first, { action: "listen", voiceId: listener })).body.subscriptionId);
        if (reason === "move") await live.post("/v1/move", { x: 2000, y: 100 }, "Session " + second);
        else if (reason === "disconnect") other.close();
        else if (reason === "leave") await live.post("/v1/leave", {}, "Session " + second);
        const deadline = Date.now() + 1500;
        while (live.cf.live() > (reason === "move" ? 1 : 0) && Date.now() < deadline) await delay(10);
        assert.equal(live.cf.live(), reason === "move" ? 1 : 0, reason);
    }
});

test("voice IDs cannot cross members or organizations, and peer operations do not overlap", async (context) => {
    const { add, join, publish, signal, cf } = fixture(context);
    const first = add(1); const other = add(2); const outsider = add(3, "org-b");
    await join(first); await join(other); await join(outsider);
    for (const person of [other, outsider]) {
        for (const action of ["status", "listen", "publish", "answer", "leave"]) {
            await assert.rejects(person.request(action, { voiceId: first.voiceId }), { code: "voice_stale" });
        }
    }
    const gate = cf.gate((call) => call.url.endsWith("/tracks/new"));
    const pending = publish(first);
    await gate.started.promise;
    await assert.rejects(publish(first), { code: "voice_busy" });
    await assert.rejects(signal(first, "listen"), { code: "voice_busy" });
    assert.equal(cf.calls.filter((call) => call.url.endsWith("/tracks/new")).length, 1);
    gate.release.resolve(); await pending;
});

test("a receiver retired during session creation never starts a late subscription request", async (context) => {
    const { add, join, publish, signal, cf, move } = fixture(context);
    const listener = add(1); const publisher = add(2);
    await join(listener); await join(publisher); await publish(publisher);
    const gate = cf.gate((call) => call.url.endsWith("/sessions/new"));
    const rejected = assert.rejects(signal(listener, "listen"), { code: "voice_stale" });
    await gate.started.promise;
    await move(listener, 2000, 100);
    gate.release.resolve(); await rejected;
    assert.equal(cf.calls.filter((call) => call.url.endsWith("/tracks/new")).length, 1);
});

test("lost allocation responses are not retried or treated as resolved by an empty snapshot", async (context) => {
    const { add, join, publish, signal, cf } = fixture(context);
    const listener = add(1); const publisher = add(2);
    await join(listener); await join(publisher); await publish(publisher);
    cf.override((call) => {
        if (call.url.endsWith("/tracks/new") && call.body.tracks[0].location === "remote") {
            throw new Error("private app-secret SDP response lost");
        }
    });
    await assert.rejects(signal(listener, "listen"), (error) => {
        assert.equal(error.code, "voice_upstream");
        assert.doesNotMatch(error.message, /private|app-secret|SDP/);
        return true;
    });
    assert.equal(cf.calls.filter((call) => call.url.endsWith("/tracks/new") && call.body.tracks[0].location === "remote").length, 1);
    assert.equal(cf.calls.filter((call) => call.method === "GET").length, 3);
    await assert.rejects(join(publisher), { code: "voice_unavailable" });
    assert.equal(cf.live(), 0);
});

test("partial allocation errors close successful tracks and malformed upstream SDP is generic", async (context) => {
    for (const malformed of [false, true]) {
        const { add, join, publish, signal, cf } = fixture(context);
        const listener = add(1); const publisher = add(2);
        await join(listener); await join(publisher); await publish(publisher);
        cf.override((call) => {
            if (call.url.endsWith("/tracks/new") && call.body.tracks[0].location === "remote") {
                return response({ tracks: [{ ...call.body.tracks[0], mid: "0",
                    ...(malformed ? {} : { errorCode: "private", errorDescription: "app-secret private-sdp" }) }],
                sessionDescription: malformed ? { type: "offer", sdp: 17 } : audio() });
            }
        });
        await assert.rejects(signal(listener, "listen"), (error) => {
            assert.equal(error.code, "voice_upstream");
            assert.doesNotMatch(error.message, /app-secret|private-sdp/);
            return true;
        });
        assert.ok(cf.calls.some((call) => call.url.endsWith("/tracks/close")));
    }
});

test("receiver SDP strips publisher resource labels while preserving transport and mid mapping", async (context) => {
    const { add, join, publish, signal, cf } = fixture(context);
    const listener = add(1); const publisher = add(2);
    await join(listener); await join(publisher); await publish(publisher);
    cf.override((call) => {
        if (call.url.endsWith("/tracks/new") && call.body.tracks[0].location === "remote") {
            const track = call.body.tracks[0];
            return response({ tracks: [{ ...track, mid: "0" }], sessionDescription: { ...audio(),
                sdp: audio().sdp + "a=msid:" + track.sessionId + " " + track.trackName + "\r\n" +
                "a=ssrc:123 msid:" + track.sessionId + " " + track.trackName + "\r\n" +
                "a=msid-semantic: WMS " + track.sessionId + "\r\n" } });
        }
    });
    const result = await signal(listener, "listen");
    const pulled = cf.calls.filter((call) => call.url.endsWith("/tracks/new")).at(-1).body.tracks[0];
    assert.ok(!JSON.stringify(result).includes(pulled.sessionId));
    assert.ok(!JSON.stringify(result).includes(pulled.trackName));
    assert.deepEqual(result.tracks, [{ mid: "0", id: 2 }]);
});

test("redacted multi-track receiver SDP keeps distinct track identities for each mid", async (context) => {
    const { add, join, publish, signal, cf } = fixture(context);
    const listener = add(1); const first = add(2); const second = add(3);
    for (const person of [listener, first, second]) await join(person);
    await publish(first); await publish(second);
    cf.override((call) => {
        if (call.url.endsWith("/tracks/new") && call.body.tracks[0].location === "remote") {
            const tracks = call.body.tracks.map((track, index) => ({ ...track, mid: String(index) }));
            const offer = audio("offer", ["0", "1"]);
            offer.sdp = offer.sdp.replace(/a=mid:([01])/g, (line, mid) => line + "\r\na=msid:" +
                tracks[Number(mid)].sessionId + " " + tracks[Number(mid)].trackName);
            return response({ tracks, sessionDescription: offer });
        }
    });
    const received = await signal(listener, "listen");
    assert.deepEqual([...received.sessionDescription.sdp.matchAll(/^a=msid:([^\r\n]+)/gm)].map((match) => match[1]),
        ["- audio-0", "- audio-1"]);
    assert.ok(!received.sessionDescription.sdp.replaceAll("\r\n", "").includes("\n"));
    await signal(listener, "answer", { subscriptionId: received.subscriptionId,
        sessionDescription: audio("answer", ["0", "1"], "recvonly") });
});
