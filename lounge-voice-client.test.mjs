import test from "node:test";
import assert from "node:assert/strict";
import { createProximityVoice, proximityAudio, validateIceServers } from "./public/lounge-voice.js";
import { isMicrophonePermission } from "./desktop/security.mjs";

const iceServers = [{ urls: ["turns:turn.cloudflare.com:443?transport=tcp"], username: "short-lived", credential: "temporary" }];
const room = () => ({ status: "connected", org: "fixture", self: { id: 1 }, members: [{ id: 1, x: 100, y: 100 }, { id: 2, x: 200, y: 100 }] });
const flush = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise((finish) => { resolve = finish; }); return { promise, resolve }; };
const relayCandidate = "a=candidate:1 1 udp 16777215 203.0.113.1 50000 typ relay raddr 0.0.0.0 rport 0\r\n";

class Track extends EventTarget {
    constructor(kind = "audio") { super(); this.kind = kind; this.enabled = true; this.stopped = false; }
    stop() { this.stopped = true; }
}
class Stream {
    constructor(tracks = [new Track()]) { this.tracks = tracks; }
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks.filter((track) => track.kind === "audio"); }
}
class AudioNode {
    constructor() { this.value = 0; this.gain = this.pan = { value: 0, setTargetAtTime: (value) => { this.value = value; } }; this.fftSize = 256; }
    connect(node) { return node; }
    disconnect() { this.disconnected = true; }
    getFloatTimeDomainData(samples) { samples.fill(0.1); }
}

function harness({ media, request: customRequest, configurePeer } = {}) {
    const tracks = [new Track()];
    const stream = new Stream(tracks);
    const peers = [], contexts = [], requests = [], capture = [], changes = [], elements = [];
    const timers = new Map();
    let permissionReleases = 0;
    let subscriptionId = null;
    let nearby = [{ id: 2, revision: "publisher-2" }];
    class Peer extends EventTarget {
        constructor(configuration) {
            super();
            this.configuration = configuration;
            this.connectionState = "new";
            this.iceGatheringState = "complete";
            this.candidates = relayCandidate;
            this.connects = true;
            peers.push(this);
            configurePeer?.(this, peers.length - 1);
        }
        addTransceiver(track, options) { this.track = track; this.options = options; return { mid: "0" }; }
        async createOffer() { return { type: "offer", sdp: "audio offer" }; }
        async createAnswer() { return { type: "answer", sdp: "audio answer" }; }
        async setLocalDescription(description) { this.localDescription = { ...description, sdp: description.sdp + "\r\n" + this.candidates }; }
        async setRemoteDescription(description) {
            this.remoteDescription = description;
            if (this.connects) this.connectionState = "connected";
            if (description.type === "offer") this.dispatchEvent(Object.assign(new Event("track"), { track: new Track(), transceiver: { mid: "rx" } }));
            this.dispatchEvent(new Event("connectionstatechange"));
        }
        close() { this.connectionState = "closed"; this.dispatchEvent(new Event("connectionstatechange")); }
    }
    class Context {
        constructor() { this.currentTime = 0; this.destination = {}; this.gains = []; contexts.push(this); }
        async resume() {}
        async close() { this.closed = true; }
        createMediaStreamSource() { return new AudioNode(); }
        createAnalyser() { return new AudioNode(); }
        createGain() { const node = new AudioNode(); this.gains.push(node); return node; }
        createStereoPanner() { return new AudioNode(); }
    }
    class Audio {
        constructor() { elements.push(this); }
        async play() { this.playing = true; }
        pause() { this.playing = false; }
    }
    const controller = createProximityVoice({
        PeerConnection: Peer, AudioContext: Context, MediaStream: Stream, Audio,
        mediaDevices: { getUserMedia: async (options) => { capture.push(options); return media ? media(stream) : stream; } },
        releasePermission: () => { permissionReleases++; }, onChange: (state) => changes.push(state),
        schedule: (callback, delay) => { const timer = {}; timers.set(timer, { callback, delay }); return timer; }, cancel: (timer) => timers.delete(timer),
        request: async (body) => {
            requests.push(body);
            if (customRequest) { const result = await customRequest(body, { stream, peers }); if (result !== undefined) return result; }
            switch (body.action) {
                case "join": return { voiceId: "voice-1", radius: 480, iceServers };
                case "publish": return { sessionDescription: { type: "answer", sdp: "audio answer" } };
                case "status": return { peers: nearby, subscriptionId };
                case "listen": subscriptionId = nearby.length ? "sub-1" : null; return { subscriptionId, sessionDescription: nearby.length ? { type: "offer", sdp: "audio offer" } : null, tracks: nearby.length ? [{ mid: "rx", id: 2 }] : [] };
                case "answer": return {};
                case "leave": subscriptionId = null; return {};
                default: assert.fail(body.action);
            }
        },
    });
    controller.update(room());
    return { controller, tracks, peers, contexts, requests, capture, timers, changes, elements, get permissionReleases() { return permissionReleases; }, setNearby: (value) => { nearby = value; subscriptionId = null; },
        async runTimer(delay) { const entry = [...timers.entries()].find(([, timer]) => timer.delay === delay); assert.ok(entry); timers.delete(entry[0]); await entry[1].callback(); await flush(); } };
}

test("proximity mix fades smoothly, pans left/right, and silences absent or distant players", () => {
    const center = { x: 0, y: 0 };
    assert.deepEqual(proximityAudio(center, center), { gain: 1, pan: 0 });
    assert.deepEqual(proximityAudio(center, { x: 480, y: 0 }), { gain: 0, pan: 1 });
    assert.deepEqual(proximityAudio(center, { x: -1000, y: 0 }), { gain: 0, pan: -1 });
    for (const invalid of [null, { x: NaN, y: 0 }]) assert.deepEqual(proximityAudio(center, invalid), { gain: 0, pan: 0 });
    assert.ok(proximityAudio(center, { x: 100, y: 0 }).gain > proximityAudio(center, { x: 300, y: 0 }).gain);
});

test("voice ICE allows Cloudflare TLS443 and refuses non-Cloudflare relays or unsafe ports", () => {
    assert.deepEqual(validateIceServers(iceServers), iceServers);
    for (const servers of [[], null, [{ urls: "turn:private.invalid:443" }], [{ urls: "turn:turn.cloudflare.com:53" }], [{ urls: "https://turn.cloudflare.com:443" }], [{ urls: ["stun:stun.cloudflare.com:3478", "turn:127.0.0.1:3478"] }]]) assert.throws(() => validateIceServers(servers));
});

test("desktop microphone policy denies cameras, screen capture, foreign documents and subframes", () => {
    const app = "http://127.0.0.1:1234/i/desktop";
    const request = { isMainFrame: true, requestingUrl: app, mediaTypes: ["audio"] };
    assert.equal(isMicrophonePermission("media", request, app), true);
    for (const details of [{ ...request, isMainFrame: false }, { ...request, requestingUrl: "https://github.com" }, { ...request, requestingUrl: app + "?untrusted" }, { ...request, mediaTypes: ["audio", "video"] }, { ...request, mediaTypes: [] }, { ...request, mediaTypes: ["video"] }]) assert.equal(isMicrophonePermission("media", details, app), false);
    assert.equal(isMicrophonePermission("display-capture", request, app), false);
    assert.equal(isMicrophonePermission("media", { ...request, mediaType: "audio" }, app, true), true);
    assert.equal(isMicrophonePermission("media", { ...request, mediaType: "unknown" }, app, true), false);
});

test("opt-in publishes only a disabled microphone track and receives server-authorized audio", async () => {
    const fixture = harness();
    assert.equal(fixture.capture.length, 0);
    await fixture.controller.start("chosen-microphone");
    assert.equal(fixture.controller.state.status, "connected");
    assert.deepEqual(fixture.requests.map((request) => request.action), ["join", "publish", "status", "listen", "answer"]);
    assert.equal(fixture.capture[0].video, false);
    assert.deepEqual(fixture.capture[0].audio.deviceId, { exact: "chosen-microphone" });
    assert.equal(fixture.peers[0].options.direction, "sendonly");
    assert.equal(fixture.tracks[0].enabled, false);
    assert.equal(fixture.controller.state.nearby, 1);
    fixture.controller.talking(true);
    assert.equal(fixture.tracks[0].enabled, true);
    fixture.controller.talking(false);
    assert.equal(fixture.tracks[0].enabled, false);
    await fixture.controller.stop();
    assert.ok(fixture.tracks[0].stopped && fixture.contexts[0].closed);
    assert.equal(fixture.permissionReleases, 1);
    assert.ok(fixture.peers.every((peer) => peer.connectionState === "closed"));
    assert.equal(fixture.timers.size, 0);
    assert.equal(fixture.requests.at(-1).action, "leave");
});

for (const [role, index, action] of [["publisher", 0, "publish"], ["receiver", 1, "answer"]]) {
    test(`${role} uses gathered candidates at the deadline when other ICE probes are still pending`, async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const fixture = harness({ configurePeer: (peer, number) => {
            if (number === index) { peer.iceGatheringState = "gathering"; peer.candidates = ""; }
        } });
        t.after(() => fixture.controller.stop());
        const starting = fixture.controller.start();
        await flush();
        assert.equal(fixture.peers.length, index + 1);
        t.mock.timers.tick(1000);
        const peer = fixture.peers[index];
        peer.localDescription.sdp += relayCandidate;
        peer.dispatchEvent(Object.assign(new Event("icecandidate"), { candidate: { type: "relay" } }));
        t.mock.timers.tick(10_999);
        await flush();
        assert.equal(fixture.requests.some((request) => request.action === action), false);
        assert.equal(fixture.tracks[0].enabled, false);
        t.mock.timers.tick(1);
        await starting;
        assert.equal(fixture.controller.state.status, "connected");
        assert.equal(peer.iceGatheringState, "gathering");
        const signaled = fixture.requests.find((request) => request.action === action);
        assert.equal(signaled.sessionDescription.type, index === 0 ? "offer" : "answer");
        assert.equal(signaled.sessionDescription.sdp, peer.localDescription.sdp);
        assert.match(signaled.sessionDescription.sdp, /typ relay/);
        assert.equal(fixture.tracks[0].enabled, false);
        await fixture.controller.stop();
        assert.equal(fixture.timers.size, 0);
        assert.ok(fixture.peers.every((connection) => connection.connectionState === "closed"));
    });

    test(`${role} reports an ICE gathering failure when the deadline has no candidates`, async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const fixture = harness({ configurePeer: (peer, number) => {
            if (number === index) { peer.iceGatheringState = "gathering"; peer.candidates = ""; }
        } });
        t.after(() => fixture.controller.stop());
        const starting = fixture.controller.start();
        await flush();
        t.mock.timers.tick(12_000);
        await starting;
        assert.equal(fixture.controller.state.status, "error");
        assert.match(fixture.controller.state.message, /could not gather any network candidates/);
        assert.equal(fixture.requests.some((request) => request.action === action), false);
        assert.equal(fixture.requests.at(-1).action, "leave");
        assert.ok(fixture.tracks[0].stopped && fixture.contexts[0].closed);
        assert.ok(fixture.peers.every((peer) => peer.connectionState === "closed"));
        assert.equal(fixture.permissionReleases, 1);
        assert.equal(fixture.timers.size, 0);
    });

    test(`stopping the ${role} during ICE gathering cancels the deadline without late signaling`, async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const fixture = harness({ configurePeer: (peer, number) => { if (number === index) peer.iceGatheringState = "gathering"; } });
        const starting = fixture.controller.start();
        await flush();
        await fixture.controller.stop();
        await starting;
        t.mock.timers.tick(12_000);
        await flush();
        assert.equal(fixture.controller.state.status, "off");
        assert.equal(fixture.requests.some((request) => request.action === action), false);
        assert.equal(fixture.requests.filter((request) => request.action === "leave").length, 1);
        assert.ok(fixture.tracks[0].stopped);
        assert.equal(fixture.timers.size, 0);
    });

    test(`${role} distinguishes a media connection timeout from ICE gathering failure`, async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const fixture = harness({ configurePeer: (peer, number) => { if (number === index) peer.connects = false; } });
        t.after(() => fixture.controller.stop());
        const starting = fixture.controller.start();
        await flush();
        assert.ok(fixture.requests.some((request) => request.action === action));
        t.mock.timers.tick(20_000);
        await starting;
        assert.equal(fixture.controller.state.status, "error");
        assert.match(fixture.controller.state.message, /media connection timed out after signaling/);
        assert.equal(fixture.requests.at(-1).action, "leave");
        assert.ok(fixture.tracks[0].stopped && fixture.contexts[0].closed);
        assert.equal(fixture.timers.size, 0);
    });
}

test("ICE gathering that completes before the deadline negotiates without waiting for the timer", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const fixture = harness({ configurePeer: (peer, index) => { if (index === 0) peer.iceGatheringState = "gathering"; } });
    t.after(() => fixture.controller.stop());
    const starting = fixture.controller.start();
    await flush();
    t.mock.timers.tick(500);
    fixture.peers[0].iceGatheringState = "complete";
    fixture.peers[0].dispatchEvent(new Event("icegatheringstatechange"));
    await starting;
    assert.equal(fixture.controller.state.status, "connected");
    t.mock.timers.tick(12_000);
    await flush();
    assert.equal(fixture.controller.state.status, "connected");
});

test("completed ICE gathering without candidates fails before publishing", async () => {
    const fixture = harness({ configurePeer: (peer) => { peer.candidates = ""; } });
    await fixture.controller.start();
    assert.equal(fixture.controller.state.status, "error");
    assert.match(fixture.controller.state.message, /could not gather any network candidates/);
    assert.deepEqual(fixture.requests.map((request) => request.action), ["join", "leave"]);
    assert.ok(fixture.tracks[0].stopped);
});

test("failed peers do not signal gathered candidates while other ICE probes are pending", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const fixture = harness({ configurePeer: (peer) => { peer.iceGatheringState = "gathering"; } });
    const starting = fixture.controller.start();
    await flush();
    fixture.peers[0].connectionState = "failed";
    fixture.peers[0].dispatchEvent(new Event("icegatheringstatechange"));
    await starting;
    t.mock.timers.tick(12_000);
    await flush();
    assert.equal(fixture.controller.state.status, "error");
    assert.match(fixture.controller.state.message, /voice connection failed/);
    assert.deepEqual(fixture.requests.map((request) => request.action), ["join", "leave"]);
    assert.ok(fixture.tracks[0].stopped);
    assert.equal(fixture.timers.size, 0);
});

test("mute/deafen cannot reopen a held microphone, and position updates silence missing peers", async () => {
    const fixture = harness();
    await fixture.controller.start();
    const gain = fixture.contexts[0].gains.at(-1);
    assert.ok(gain.value > 0);
    fixture.controller.talking(true);
    fixture.controller.mute(true);
    fixture.controller.talking(true);
    assert.equal(fixture.tracks[0].enabled, false);
    fixture.controller.mute(false);
    assert.equal(fixture.tracks[0].enabled, false);
    fixture.controller.deafen(true);
    fixture.controller.talking(true);
    assert.equal(gain.value, 0);
    assert.equal(fixture.tracks[0].enabled, false);
    fixture.controller.deafen(false);
    assert.ok(gain.value > 0);
    fixture.controller.position({ x: 1000, y: 100 });
    assert.equal(gain.value, 0);
    fixture.controller.position({ x: 100, y: 100 });
    fixture.controller.update({ ...room(), members: [{ id: 1, x: 100, y: 100 }] });
    assert.equal(gain.value, 0);
    await fixture.controller.stop();
});

test("remote media activation stays muted and releases elements when receivers change or stop", async () => {
    const fixture = harness();
    await fixture.controller.start();
    assert.equal(fixture.elements.length, 1);
    assert.equal(fixture.elements[0].muted, true);
    assert.equal(fixture.elements[0].playing, true);
    assert.ok(fixture.elements[0].srcObject);
    fixture.setNearby([]);
    await fixture.runTimer(1500);
    assert.equal(fixture.elements[0].playing, false);
    assert.equal(fixture.elements[0].srcObject, null);
    fixture.setNearby([{ id: 2, revision: "replacement" }]);
    await fixture.runTimer(1500);
    await fixture.controller.stop();
    assert.equal(fixture.elements[1].playing, false);
    assert.equal(fixture.elements[1].srcObject, null);
});

test("speaking indicators measure audio and clear when deafened or stopped", async () => {
    const fixture = harness();
    await fixture.controller.start();
    fixture.controller.talking(true);
    await fixture.runTimer(80);
    assert.deepEqual(fixture.controller.state.speaking.sort(), ["1", "2"]);
    fixture.controller.deafen(true);
    await fixture.runTimer(80);
    assert.deepEqual(fixture.controller.state.speaking, []);
    await fixture.controller.stop();
});

test("revoked subscriptions and new nearby publishers rebuild only the receiving peer", async () => {
    const fixture = harness();
    await fixture.controller.start();
    fixture.setNearby([]);
    await fixture.runTimer(1500);
    assert.equal(fixture.peers[1].connectionState, "closed");
    assert.equal(fixture.peers[0].connectionState, "connected");
    assert.equal(fixture.controller.state.nearby, 0);
    fixture.setNearby([{ id: 2, revision: "replacement" }]);
    await fixture.runTimer(1500);
    assert.equal(fixture.peers.length, 3);
    assert.equal(fixture.capture.length, 1);
    await fixture.controller.stop();
});

test("microphone denial cleans up without capturing or interrupting Lounge presence", async () => {
    const fixture = harness({ media: () => { throw Object.assign(new Error("denied"), { name: "NotAllowedError" }); } });
    await fixture.controller.start();
    assert.equal(fixture.controller.state.status, "error");
    assert.match(fixture.controller.state.message, /permission was denied/);
    assert.equal(fixture.requests.at(-1).action, "leave");
    assert.equal(fixture.peers.length, 0);
    assert.ok(fixture.contexts[0].closed);
});

test("an unconfigured voice backend fails before microphone access", async () => {
    const fixture = harness({ request: (body) => { if (body.action === "join") throw new Error("Voice is not configured on this server."); } });
    await fixture.controller.start();
    assert.equal(fixture.controller.state.status, "error");
    assert.equal(fixture.capture.length, 0);
    assert.ok(fixture.contexts[0].closed);
});

test("cancelled capture stops microphone tracks arriving after a pending prompt", async () => {
    const pending = deferred();
    const fixture = harness({ media: () => pending.promise });
    const starting = fixture.controller.start();
    await flush();
    assert.equal(fixture.capture.length, 1);
    await fixture.controller.stop();
    pending.resolve(new Stream(fixture.tracks));
    await starting;
    assert.ok(fixture.tracks[0].stopped);
    assert.equal(fixture.peers.length, 0);
    assert.equal(fixture.controller.state.status, "off");
});

test("a late server join is left without restarting cancelled voice", async () => {
    const pending = deferred();
    const fixture = harness({ request: (body) => body.action === "join" ? pending.promise : undefined });
    const starting = fixture.controller.start();
    await flush();
    await fixture.controller.stop();
    pending.resolve({ voiceId: "late-voice", radius: 480, iceServers });
    await starting;
    assert.equal(fixture.capture.length, 0);
    assert.deepEqual(fixture.requests.at(-1), { action: "leave", voiceId: "late-voice" });
    assert.equal(fixture.controller.state.status, "off");
});

test("stopping during publish cannot resume audio or create a receiver", async () => {
    const pending = deferred();
    const fixture = harness({ request: (body) => body.action === "publish" ? pending.promise : undefined });
    const starting = fixture.controller.start();
    await flush();
    await fixture.controller.stop();
    pending.resolve({ sessionDescription: { type: "answer", sdp: "late" } });
    await starting;
    assert.ok(fixture.tracks[0].stopped);
    assert.equal(fixture.peers.length, 1);
    assert.equal(fixture.controller.state.status, "off");
});

test("Lounge reconnects, org changes, unplugged microphones and network failures release capture", async () => {
    for (const reason of ["reconnect", "org", "microphone", "network"]) {
        const fixture = harness();
        await fixture.controller.start();
        fixture.controller.talking(true);
        if (reason === "reconnect") fixture.controller.update({ ...room(), status: "reconnecting" });
        if (reason === "org") fixture.controller.update({ ...room(), org: "other" });
        if (reason === "microphone") fixture.tracks[0].dispatchEvent(new Event("ended"));
        if (reason === "network") { fixture.peers[0].connectionState = "failed"; fixture.peers[0].dispatchEvent(new Event("connectionstatechange")); }
        await flush();
        assert.ok(fixture.tracks[0].stopped, reason);
        assert.equal(fixture.tracks[0].enabled, false, reason);
        assert.equal(fixture.controller.state.talking, false, reason);
        assert.ok(fixture.contexts[0].closed, reason);
    }
});

test("voice does not auto-join and repeated opt-in does not recapture", async () => {
    const fixture = harness();
    fixture.controller.update({ status: "idle" });
    await fixture.controller.start();
    assert.equal(fixture.capture.length, 0);
    fixture.controller.update(room());
    await fixture.controller.start();
    await fixture.controller.start();
    assert.equal(fixture.capture.length, 1);
    await fixture.controller.stop();
});
