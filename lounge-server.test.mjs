import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createLoungeServer, sanitizeBuddy } from "./lounge-server/server.mjs";

const USERS = {
    "tok-alice": { user: { id: 1, login: "alice" }, orgs: { "org-a": "active" } },
    "tok-bob": { user: { id: 2, login: "bob" }, orgs: { "org-a": "active" } },
    "tok-carol": { user: { id: 3, login: "carol" }, orgs: { "org-b": "active" } },
    "tok-pending": { user: { id: 4, login: "pat" }, orgs: { "org-a": "pending" } },
};
const githubRequests = [];
let mock;
let githubApi;
const servers = [];

function startMock() {
    mock = createServer((req, res) => {
        githubRequests.push({ url: req.url, headers: req.headers });
        const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1];
        const entry = USERS[token];
        const reply = (status, body) => {
            res.writeHead(status, { "Content-Type": "application/json" });
            res.end(JSON.stringify(body));
        };
        if (!entry) return reply(401, { message: "Bad credentials" });
        if (req.url === "/user") return reply(200, { ...entry.user, name: "ignored" });
        const org = /^\/user\/memberships\/orgs\/([^/]+)$/.exec(req.url)?.[1];
        if (org && entry.orgs[org]) return reply(200, { state: entry.orgs[org], role: "member" });
        return reply(404, { message: "Not Found" });
    });
    return new Promise((resolve) => mock.listen(0, "127.0.0.1", () => {
        githubApi = `http://127.0.0.1:${mock.address().port}`;
        resolve();
    }));
}

async function startLounge(options = {}) {
    const lounge = createLoungeServer({ host: "127.0.0.1", port: 0, githubApi, staleMs: 60_000, ...options });
    const { port } = await lounge.listen();
    servers.push(lounge);
    return { lounge, base: `http://127.0.0.1:${port}` };
}

async function post(base, path, { auth, body } = {}) {
    const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
        body: JSON.stringify(body ?? {}),
    });
    return { status: res.status, body: await res.json() };
}

async function session(base, token, org = "org-a", buddy = { name: "Buddy" }) {
    const res = await post(base, "/v1/session", { auth: `Bearer ${token}`, body: { org, buddy } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.session;
}

// Minimal SSE client over fetch streaming.
async function stream(base, sessionToken, { query = false } = {}) {
    const controller = new AbortController();
    const url = `${base}/v1/stream${query ? `?s=${sessionToken}` : ""}`;
    const res = await fetch(url, {
        headers: query ? {} : { Authorization: `Session ${sessionToken}` },
        signal: controller.signal,
    });
    if (res.status !== 200) return { status: res.status, body: await res.json() };
    const events = [];
    const consumed = new Set();
    let notify = () => {};
    let endedResolve;
    const ended = new Promise((resolve) => { endedResolve = resolve; });
    (async () => {
        const decoder = new TextDecoder();
        let buffer = "";
        try {
            for await (const chunk of res.body) {
                buffer += decoder.decode(chunk, { stream: true });
                let index;
                while ((index = buffer.indexOf("\n\n")) >= 0) {
                    const block = buffer.slice(0, index);
                    buffer = buffer.slice(index + 2);
                    let type = "message";
                    let data = "";
                    for (const line of block.split("\n")) {
                        if (line.startsWith("event: ")) type = line.slice(7);
                        else if (line.startsWith("data: ")) data += line.slice(6);
                    }
                    if (data) events.push({ type, data: JSON.parse(data) });
                }
                notify();
            }
        } catch {
            // aborted
        }
        endedResolve();
        notify();
    })();
    const client = {
        status: 200,
        events,
        ended,
        async next(type, timeoutMs = 1000) {
            const deadline = Date.now() + timeoutMs;
            for (;;) {
                const index = events.findIndex((event, i) => event.type === type && !consumed.has(i));
                if (index >= 0) {
                    consumed.add(index);
                    return events[index].data;
                }
                if (Date.now() > deadline) throw new Error(`timed out waiting for ${type}; got ${JSON.stringify(events)}`);
                await new Promise((resolve) => {
                    notify = resolve;
                    setTimeout(resolve, 20);
                });
            }
        },
        of: (type) => events.filter((event) => event.type === type).map((event) => event.data),
        close: () => controller.abort(),
    };
    return client;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForMembers(base, count, timeoutMs = 1000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const health = await (await fetch(`${base}/healthz`)).json();
        if (health.members === count) return health;
        if (Date.now() > deadline) throw new Error(`expected ${count} members, health=${JSON.stringify(health)}`);
        await sleep(20);
    }
}

async function leaveAll(base, ...sessionTokens) {
    for (const token of sessionTokens) await post(base, "/v1/leave", { auth: `Session ${token}` });
    await waitForMembers(base, 0);
}

let main;
before(async () => {
    await startMock();
    main = await startLounge();
});
after(async () => {
    for (const lounge of servers) await lounge.close();
    await new Promise((resolve) => mock.close(resolve));
});

test("session creation succeeds and sends required GitHub headers", async () => {
    githubRequests.length = 0;
    const res = await post(main.base, "/v1/session", {
        auth: "Bearer tok-alice", body: { org: "Org-A", buddy: { name: "  Robo  ", hat: "crown", evil: true } },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.match(res.body.session, /^[0-9a-f]{64}$/);
    assert.deepEqual(res.body.self, { id: 1, login: "alice" });
    assert.equal(res.body.org, "org-a");
    assert.equal(res.body.staleMs, 60_000);
    assert.deepEqual(githubRequests.map((r) => r.url), ["/user", "/user/memberships/orgs/org-a"]);
    for (const { headers } of githubRequests) {
        assert.equal(headers.accept, "application/vnd.github+json");
        assert.equal(headers["x-github-api-version"], "2022-11-28");
        assert.equal(headers["user-agent"], "byte-buddy-lounge");
    }
    const stored = main.lounge.sessions.get(res.body.session);
    assert.equal(stored.buddy.name, "Robo");
    assert.equal(stored.buddy.hat, "crown");
    assert.equal("evil" in stored.buddy, false);
    assert.ok(!JSON.stringify([...main.lounge.sessions.values()]).includes("tok-alice"), "GitHub token must not be stored");
    await leaveAll(main.base, res.body.session);
    assert.equal(main.lounge.sessions.has(res.body.session), false);
});

test("session auth failures", async () => {
    const cases = [
        [{ auth: "Bearer nope", body: { org: "org-a" } }, 401, "bad_token"],
        [{ body: { org: "org-a" } }, 401, "bad_token"],
        [{ auth: "Bearer tok-carol", body: { org: "org-a" } }, 403, "not_member"],
        [{ auth: "Bearer tok-pending", body: { org: "org-a" } }, 403, "not_member"],
        [{ auth: "Bearer tok-alice", body: { org: "-bad-" } }, 400, "bad_org"],
        [{ auth: "Bearer tok-alice", body: { org: "a/b" } }, 400, "bad_org"],
        [{ auth: "Bearer tok-alice", body: {} }, 400, "bad_org"],
    ];
    for (const [request, status, code] of cases) {
        const res = await post(main.base, "/v1/session", request);
        assert.equal(res.status, status, JSON.stringify(request));
        assert.deepEqual([res.body.ok, res.body.code], [false, code]);
        assert.equal(typeof res.body.error, "string");
    }
    assert.equal(main.lounge.sessions.size, 0);
});

test("allowedOrgs rejects other orgs before calling GitHub", async () => {
    const { base } = await startLounge({ allowedOrgs: ["ORG-A"] });
    githubRequests.length = 0;
    const res = await post(base, "/v1/session", { auth: "Bearer tok-carol", body: { org: "org-b" } });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, "org_not_allowed");
    assert.equal(githubRequests.length, 0);
    assert.equal((await post(base, "/v1/session", { auth: "Bearer tok-alice", body: { org: "org-a" } })).status, 200);
});

test("bad sessions are rejected", async () => {
    for (const path of ["/v1/move", "/v1/heartbeat", "/v1/leave"]) {
        const res = await post(main.base, path, { auth: "Session deadbeef", body: { x: 1, y: 1 } });
        assert.deepEqual([res.status, res.body.code], [401, "bad_session"]);
    }
    const res = await stream(main.base, "deadbeef");
    assert.deepEqual([res.status, res.body.code], [401, "bad_session"]);
});

test("snapshot, join broadcast, org isolation, and leave on stream close", async () => {
    const sa = await session(main.base, "tok-alice", "org-a", { name: "Ally", body: "#123456" });
    const sb = await session(main.base, "tok-bob");
    const sc = await session(main.base, "tok-carol", "org-b");

    const alice = await stream(main.base, sa);
    const snapA = await alice.next("snapshot");
    assert.deepEqual(snapA.self, { id: 1, login: "alice" });
    assert.equal(snapA.org, "org-a");
    assert.equal(snapA.members.length, 1);
    const [selfMember] = snapA.members;
    assert.deepEqual(Object.keys(selfMember).sort(), ["buddy", "id", "login", "x", "y"]);
    assert.equal(selfMember.buddy.name, "Ally");
    assert.equal(selfMember.buddy.body, "#123456");
    assert.ok(selfMember.x >= 760 && selfMember.x <= 2420 && selfMember.y >= 750 && selfMember.y <= 810);

    const carol = await stream(main.base, sc, { query: true });
    const snapC = await carol.next("snapshot");
    assert.deepEqual(snapC.members.map((m) => m.login), ["carol"]);

    const bob = await stream(main.base, sb);
    const snapB = await bob.next("snapshot");
    assert.deepEqual(snapB.members.map((m) => m.login).sort(), ["alice", "bob"]);
    const joined = await alice.next("join");
    assert.equal(joined.login, "bob");
    assert.equal(bob.of("join").length, 0, "joiner does not receive its own join");

    const moved = await post(main.base, "/v1/move", { auth: `Session ${sb}`, body: { x: 1000, y: -5 } });
    assert.deepEqual(moved.body, { ok: true, x: 1000, y: 0 });
    assert.deepEqual(await alice.next("move"), { id: 2, x: 1000, y: 0 });
    assert.deepEqual(await bob.next("move"), { id: 2, x: 1000, y: 0 });
    const precise = await post(main.base, "/v1/move", { auth: `Session ${sa}`, body: { x: 50.26, y: 80.04 } });
    assert.deepEqual([precise.body.x, precise.body.y], [50.3, 80]);
    assert.deepEqual(await bob.next("move"), { id: 1, x: 50.3, y: 80 });

    bob.close();
    assert.deepEqual(await alice.next("leave"), { id: 2 });
    await waitForMembers(main.base, 2);
    assert.ok(main.lounge.sessions.has(sb), "session survives stream close");

    await sleep(50);
    assert.equal(carol.events.length, 1, "org-b sees nothing from org-a");
    assert.ok(alice.events.every((e) => e.data.id !== 3 && e.data.login !== "carol"), "org-a sees nothing from org-b");

    const health = await (await fetch(`${main.base}/healthz`)).json();
    assert.deepEqual(health, { ok: true, rooms: 2, members: 2 });
    assert.ok(!JSON.stringify(health).includes("alice"));

    const raw = JSON.stringify({
        sessions: [...main.lounge.sessions.values()],
        members: [...main.lounge.rooms.values()].flatMap((room) => [...room.values()].map(({ res, ...m }) => m)),
    });
    for (const token of Object.keys(USERS)) assert.ok(!raw.includes(token));

    alice.close();
    carol.close();
    await leaveAll(main.base, sa, sb, sc);
});

test("move requires a live stream and is rate limited", async () => {
    const sa = await session(main.base, "tok-alice");
    const notIn = await post(main.base, "/v1/move", { auth: `Session ${sa}`, body: { x: 10, y: 70 } });
    assert.deepEqual([notIn.status, notIn.body.code], [409, "not_in_room"]);

    const alice = await stream(main.base, sa);
    await alice.next("snapshot");
    const bad = await post(main.base, "/v1/move", { auth: `Session ${sa}`, body: { x: "a", y: 70 } });
    assert.equal(bad.status, 400);
    const statuses = [];
    for (let i = 0; i < 20; i++) {
        statuses.push((await post(main.base, "/v1/move", { auth: `Session ${sa}`, body: { x: 10 + i, y: 70 } })).status);
    }
    assert.equal(statuses.filter((s) => s === 200).length, 15);
    assert.equal(statuses.filter((s) => s === 429).length, 5);
    const limited = await post(main.base, "/v1/move", { auth: `Session ${sa}`, body: { x: 10, y: 70 } });
    assert.equal(limited.body.code, "rate_limited");
    alice.close();
    await leaveAll(main.base, sa);
});

test("same user reconnect replaces the old stream without duplicates", async () => {
    const sb = await session(main.base, "tok-bob");
    const bob = await stream(main.base, sb);
    await bob.next("snapshot");

    const sa1 = await session(main.base, "tok-alice", "org-a", { name: "First" });
    const first = await stream(main.base, sa1);
    await first.next("snapshot");
    await bob.next("join");
    await post(main.base, "/v1/move", { auth: `Session ${sa1}`, body: { x: 33, y: 99 } });
    await bob.next("move");

    const sa2 = await session(main.base, "tok-alice", "org-a", { name: "Second" });
    const second = await stream(main.base, sa2);
    const snap = await second.next("snapshot");
    assert.deepEqual(snap.members.map((m) => m.login).sort(), ["alice", "bob"]);
    const self = snap.members.find((m) => m.id === 1);
    assert.deepEqual([self.x, self.y, self.buddy.name], [33, 99, "Second"]);

    await first.next("replaced");
    await first.ended;
    const update = await bob.next("update");
    assert.deepEqual([update.id, update.buddy.name, update.x, update.y], [1, "Second", 33, 99]);
    await sleep(50);
    assert.equal(bob.of("leave").length, 0, "no leave for a replaced stream");
    assert.equal(bob.of("join").length, 1, "no second join for a replaced stream");
    await waitForMembers(main.base, 2);

    const bob2 = await stream(main.base, sb);
    const snap2 = await bob2.next("snapshot");
    assert.equal(snap2.members.filter((m) => m.id === 1).length, 1);

    second.close();
    bob.close();
    bob2.close();
    await leaveAll(main.base, sa1, sa2, sb);
});

test("reconnect within stale window keeps position", async () => {
    const sa = await session(main.base, "tok-alice");
    const a1 = await stream(main.base, sa);
    await a1.next("snapshot");
    await post(main.base, "/v1/move", { auth: `Session ${sa}`, body: { x: 12.5, y: 111 } });
    a1.close();
    await waitForMembers(main.base, 0);
    const a2 = await stream(main.base, sa);
    const snap = await a2.next("snapshot");
    assert.deepEqual([snap.members[0].x, snap.members[0].y], [12.5, 111]);
    a2.close();
    await leaveAll(main.base, sa);
});

test("/v1/leave removes the member, broadcasts leave, and deletes the session", async () => {
    const sa = await session(main.base, "tok-alice");
    const sb = await session(main.base, "tok-bob");
    const alice = await stream(main.base, sa);
    await alice.next("snapshot");
    const bob = await stream(main.base, sb);
    await bob.next("snapshot");
    const res = await post(main.base, "/v1/leave", { auth: `Session ${sb}` });
    assert.deepEqual(res, { status: 200, body: { ok: true } });
    assert.deepEqual(await alice.next("leave"), { id: 2 });
    await bob.ended;
    const again = await post(main.base, "/v1/heartbeat", { auth: `Session ${sb}` });
    assert.equal(again.body.code, "bad_session");
    alice.close();
    await leaveAll(main.base, sa);
});

test("stale members are evicted when heartbeats stop", async () => {
    const { base } = await startLounge({ staleMs: 300, sweepMs: 50 });
    const sa = await session(base, "tok-alice");
    const sb = await session(base, "tok-bob");
    const alice = await stream(base, sa);
    await alice.next("snapshot");
    const bob = await stream(base, sb);
    await bob.next("snapshot");

    for (let i = 0; i < 6; i++) {
        await sleep(100);
        const hb = await post(base, "/v1/heartbeat", { auth: `Session ${sa}` });
        assert.deepEqual(hb.body, { ok: true });
    }
    assert.deepEqual(await alice.next("leave", 1000), { id: 2 });
    await bob.ended;
    const health = await waitForMembers(base, 1);
    assert.equal(health.rooms, 1);
    alice.close();
    await waitForMembers(base, 0);
});

test("room full and misc errors", async () => {
    const { base } = await startLounge({ maxRoom: 1 });
    const sa = await session(base, "tok-alice");
    const sb = await session(base, "tok-bob");
    const alice = await stream(base, sa);
    await alice.next("snapshot");
    const full = await stream(base, sb);
    assert.deepEqual([full.status, full.body.code], [403, "room_full"]);
    const big = await post(base, "/v1/heartbeat", { auth: `Session ${sa}`, body: { pad: "x".repeat(20_000) } });
    assert.deepEqual([big.status, big.body.code], [413, "too_large"]);
    const missing = await fetch(`${base}/nope`);
    assert.equal(missing.status, 404);
    alice.close();
});

test("sanitizeBuddy drops unknown keys and defaults invalid values", () => {
    assert.deepEqual(sanitizeBuddy({ stage: 11, type: "Robot", body: "red", eye: "#ABCDEF", hat: "UP", name: 5, x: 1 }), {
        stage: 0, type: "robot", variant: null, body: "#3fb8af", eye: "#ABCDEF",
        hat: null, glasses: null, headphones: null, neck: null, name: null,
    });
    assert.equal(sanitizeBuddy({ name: "  a very long buddy name that keeps going " }).name.length, 24);
    assert.equal(sanitizeBuddy(null).type, "robot");
});
