import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLoungeClient, sanitizeBuddy } from './lounge.mjs';
import { createBuddyServer } from './server.mjs';
import { BuddyError } from './store.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Minimal in-memory implementation of the lounge server protocol.
async function fakeLounge(t) {
    const users = { 'gh-me': { id: 1, login: 'me' }, 'gh-me-2': { id: 1, login: 'me' } };
    const sessions = new Map();
    const room = new Map();
    const streams = new Map();
    const log = { session: [], stream: 0, move: [], heartbeat: 0, leave: 0 };
    const write = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const broadcast = (event, data, except) => { for (const [id, res] of streams) if (id !== except) write(res, event, data); };
    const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const auth = (req) => sessions.get(String(req.headers.authorization || '').replace(/^Session /, ''));
    const server = createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        const path = new URL(req.url, 'http://x').pathname;
        if (req.method === 'POST' && path === '/v1/session') {
            const ghToken = String(req.headers.authorization || '').replace(/^Bearer /, '');
            log.session.push({ ghToken, body });
            const user = users[ghToken];
            if (!user) return json(res, 401, { ok: false, code: 'bad_token', error: 'Bad token.' });
            if (body.org === 'blocked') return json(res, 403, { ok: false, code: 'not_member', error: 'Not a member.' });
            const token = `s${log.session.length}`;
            sessions.set(token, { ...user, org: body.org, buddy: body.buddy });
            return json(res, 200, { ok: true, session: token, self: user, org: body.org, staleMs: 45000 });
        }
        const session = auth(req);
        if (!session) return json(res, 401, { ok: false, code: 'bad_session', error: 'Bad session.' });
        if (req.method === 'GET' && path === '/v1/stream') {
            log.stream++;
            const old = streams.get(session.id);
            if (old) { streams.delete(session.id); write(old, 'replaced', {}); old.end(); }
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            const member = { id: session.id, login: session.login, buddy: session.buddy, x: room.get(session.id)?.x ?? 50, y: 90 };
            room.set(member.id, member);
            streams.set(member.id, res);
            res.write(': hello\n\n');
            write(res, 'snapshot', { self: { id: session.id, login: session.login }, org: session.org, members: [...room.values()] });
            broadcast('join', member, member.id);
            req.on('close', () => {
                if (streams.get(member.id) !== res) return;
                streams.delete(member.id);
                room.delete(member.id);
                broadcast('leave', { id: member.id });
            });
            return;
        }
        if (req.method === 'POST' && path === '/v1/move') {
            log.move.push(body);
            const member = room.get(session.id);
            Object.assign(member, { x: body.x, y: body.y });
            broadcast('move', { id: member.id, x: body.x, y: body.y });
            return json(res, 200, { ok: true });
        }
        if (req.method === 'POST' && path === '/v1/heartbeat') { log.heartbeat++; return json(res, 200, { ok: true }); }
        if (req.method === 'POST' && path === '/v1/leave') {
            log.leave++;
            const stream = streams.get(session.id);
            streams.delete(session.id);
            room.delete(session.id);
            stream?.end();
            broadcast('leave', { id: session.id });
            for (const [key, value] of sessions) if (value === session) sessions.delete(key);
            return json(res, 200, { ok: true });
        }
        json(res, 404, { ok: false, code: 'not_found', error: 'Not found.' });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { for (const res of streams.values()) res.destroy(); server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
    return {
        url: `http://127.0.0.1:${server.address().port}`, log, room, streams, sessions,
        addMember(member) { room.set(member.id, member); broadcast('join', member); },
        moveMember(id, x, y) { Object.assign(room.get(id), { x, y }); broadcast('move', { id, x, y }); },
        removeMember(id) { room.delete(id); broadcast('leave', { id }); },
        dropStreams() { for (const res of streams.values()) res.destroy(); },
        invalidateSessions() { sessions.clear(); },
        replace(id) { const res = streams.get(id); streams.delete(id); write(res, 'replaced', {}); res.end(); },
    };
}

function setup(t, { env = {}, tokens = ['gh-me'], ...options } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'lounge-test-'));
    const configPath = join(dir, 'nested', 'lounge.json');
    const calls = { token: 0 };
    const client = createLoungeClient({
        configPath, env, heartbeatMs: 40, backoff: [20, 40],
        getGitHubToken: async () => tokens[Math.min(calls.token++, tokens.length - 1)], ...options,
    });
    const statuses = [];
    client.events.on('change', () => { const { status } = client.state(); if (statuses.at(-1) !== status) statuses.push(status); });
    t.after(async () => { await client.close(); rmSync(dir, { recursive: true, force: true }); });
    return { client, configPath, calls, statuses };
}

function waitFor(client, predicate, ms = 2000) {
    return new Promise((resolve, reject) => {
        const check = () => { if (predicate(client.state())) { cleanup(); resolve(client.state()); } };
        const timer = setTimeout(() => { cleanup(); reject(new Error(`timeout; state=${JSON.stringify(client.state())}`)); }, ms);
        const cleanup = () => { clearTimeout(timer); client.events.off('change', check); };
        client.events.on('change', check);
        check();
    });
}

test('URL validation, persistence and env override', async (t) => {
    const { client, configPath } = setup(t);
    await assert.rejects(client.join({ org: 'acme' }), { code: 'no_server' });
    await assert.rejects(client.setServerUrl('http://lounge.example.com'), (error) => error instanceof BuddyError && error.code === 'insecure_url');
    await assert.rejects(client.setServerUrl('not a url'), { code: 'invalid_url' });
    await assert.rejects(client.setServerUrl('ftp://lounge.example.com'), { code: 'invalid_url' });
    for (const url of ['http://localhost:8787', 'http://[::1]:8787', 'https://lounge.example.com/']) await client.setServerUrl(url);
    assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), { url: 'https://lounge.example.com' });
    assert.equal(client.state().serverUrlSource, 'config');
    await assert.rejects(client.join({}), { code: 'no_org' });
    await assert.rejects(client.join({ org: 'bad org!' }), { code: 'invalid_org' });
    await client.setServerUrl('');
    assert.equal(client.state().serverUrl, null);

    const envClient = setup(t, { env: { BYTE_BUDDY_LOUNGE_URL: 'http://lounge.example.com' } }).client;
    assert.equal(envClient.state().serverUrl, 'http://lounge.example.com');
    assert.equal(envClient.state().serverUrlSource, 'env');
    await assert.rejects(envClient.setServerUrl('https://other.example.com'), { code: 'env_override' });
    await assert.rejects(envClient.join({ org: 'acme' }), { code: 'insecure_url' });
});

test('buddy is sanitized to the shared schema', () => {
    assert.deepEqual(sanitizeBuddy({ stage: 3, type: 'cat', variant: 'tabby', body: '#112233', eye: 'red', hat: 'crown', glasses: 'BAD!', headphones: null, neck: 'scarf', name: '  Sparky  ', secret: 'x' }),
        { stage: 3, type: 'cat', variant: 'tabby', body: '#112233', eye: '#7cf8ff', hat: 'crown', glasses: null, headphones: null, neck: 'scarf', name: 'Sparky' });
    assert.deepEqual(sanitizeBuddy(null), { stage: 0, type: 'robot', variant: null, body: '#3fb8af', eye: '#7cf8ff', hat: null, glasses: null, headphones: null, neck: null, name: null });
});

test('join connects, applies join/move/leave events and heartbeats; token never persisted', async (t) => {
    const lounge = await fakeLounge(t);
    lounge.room.set(2, { id: 2, login: 'alice', buddy: {}, x: 20, y: 70 });
    const { client, configPath } = setup(t);
    await client.setServerUrl(lounge.url);
    const state = await client.join({ org: 'Acme', buddy: { type: 'cat', name: 'Kit', token: 'nope' } });
    assert.equal(state.status, 'connected');
    assert.equal(state.org, 'acme');
    assert.deepEqual(state.self, { id: 1, login: 'me' });
    assert.deepEqual(state.members.map((m) => m.login), ['alice', 'me']);
    assert.equal(lounge.log.session[0].body.buddy.token, undefined);
    assert.equal(lounge.log.session[0].body.buddy.name, 'Kit');

    lounge.addMember({ id: 3, login: 'bob', buddy: {}, x: 30, y: 80 });
    await waitFor(client, (s) => s.members.length === 3);
    lounge.moveMember(3, 99, 100);
    await waitFor(client, (s) => s.members.find((m) => m.id === 3)?.x === 99);
    lounge.removeMember(2);
    const after = await waitFor(client, (s) => s.members.length === 2);
    assert.deepEqual(after.members.map((m) => m.login), ['bob', 'me']);
    await sleep(120);
    assert.ok(lounge.log.heartbeat >= 1);

    const saved = readFileSync(configPath, 'utf8');
    assert.doesNotMatch(saved, /gh-me|s1/);
    assert.deepEqual(Object.keys(JSON.parse(saved)), ['url']);
});

test('reconnects after a dropped stream without duplicate members', async (t) => {
    const lounge = await fakeLounge(t);
    const { client, calls, statuses } = setup(t);
    await client.setServerUrl(lounge.url);
    await client.join({ org: 'acme' });
    lounge.dropStreams();
    await waitFor(client, (s) => s.status === 'reconnecting');
    const state = await waitFor(client, (s) => s.status === 'connected');
    assert.deepEqual(state.members.map((m) => m.id), [1]);
    assert.deepEqual([...statuses], ['idle', 'connecting', 'connected', 'reconnecting', 'connected']);
    assert.equal(lounge.log.stream, 2);
    assert.equal(calls.token, 1, 'valid session is reused');
});

test('401 on the stream recreates the session with a fresh token', async (t) => {
    const lounge = await fakeLounge(t);
    const { client, calls } = setup(t, { tokens: ['gh-me', 'gh-me-2'] });
    await client.setServerUrl(lounge.url);
    await client.join({ org: 'acme' });
    lounge.invalidateSessions();
    lounge.dropStreams();
    await waitFor(client, (s) => s.status === 'reconnecting');
    const state = await waitFor(client, (s) => s.status === 'connected');
    assert.equal(calls.token, 2);
    assert.deepEqual(lounge.log.session.map((s) => s.ghToken), ['gh-me', 'gh-me-2']);
    assert.equal(state.members.length, 1);
});

test('403 and bad token fail without retry', async (t) => {
    const lounge = await fakeLounge(t);
    const { client } = setup(t);
    await client.setServerUrl(lounge.url);
    await assert.rejects(client.join({ org: 'blocked' }), (error) => error instanceof BuddyError && error.code === 'not_member');
    assert.equal(client.state().status, 'error');
    assert.equal(client.state().error.code, 'not_member');
    const bad = setup(t, { tokens: ['nope'] }).client;
    await bad.setServerUrl(lounge.url);
    await assert.rejects(bad.join({ org: 'acme' }), { code: 'bad_token' });
    await sleep(100);
    assert.equal(lounge.log.session.length, 2);
});

test('replaced moves to error and does not reconnect', async (t) => {
    const lounge = await fakeLounge(t);
    const { client } = setup(t);
    await client.setServerUrl(lounge.url);
    await client.join({ org: 'acme' });
    lounge.replace(1);
    const state = await waitFor(client, (s) => s.status === 'error');
    assert.equal(state.error.code, 'replaced');
    assert.equal(state.error.message, 'Joined from another window');
    assert.deepEqual(state.members, []);
    await sleep(150);
    assert.equal(lounge.log.stream, 1);
    assert.equal(lounge.log.leave, 0, 'must not kick the window that replaced us');
    assert.equal((await client.join({ org: 'acme' })).status, 'connected');
});

test('leave returns to idle and tells the server', async (t) => {
    const lounge = await fakeLounge(t);
    const { client } = setup(t);
    await client.setServerUrl(lounge.url);
    await client.join({ org: 'acme' });
    const state = await client.leave();
    assert.equal(state.status, 'idle');
    assert.equal(state.org, null);
    assert.deepEqual(state.members, []);
    assert.equal(lounge.log.leave, 1);
    assert.equal(lounge.room.size, 0);
    await sleep(100);
    assert.equal(lounge.log.stream, 1);
});

test('moves are clamped and throttled to the latest position', async (t) => {
    const lounge = await fakeLounge(t);
    const { client } = setup(t);
    await client.setServerUrl(lounge.url);
    await client.join({ org: 'acme' });
    assert.throws(() => client.move({ x: 'a', y: 1 }), { code: 'invalid_move' });
    for (let i = 0; i < 30; i++) client.move({ x: 20 + i, y: 80 });
    await sleep(250);
    assert.ok(lounge.log.move.length <= 4, `sent ${lounge.log.move.length} moves`);
    assert.deepEqual(lounge.log.move.at(-1), { x: 49, y: 80 });
    await waitFor(client, (s) => s.members[0].x === 49);
    client.move({ x: 1000, y: -5 });
    await sleep(150);
    assert.deepEqual(lounge.log.move.at(-1), { x: 152, y: 64 });
});

test('buddy server exposes lounge routes, broadcasts lounge events and auto-leaves', async (t) => {
    const events = new EventEmitter();
    let current = { status: 'idle', members: [] };
    const calls = [];
    const lounge = {
        events, state: () => current,
        join: async (body) => { calls.push(['join', body]); if (body.org === 'bad') throw new BuddyError('no_org', 'Nope.'); current = { status: 'connected', org: body.org, members: [] }; events.emit('change'); return current; },
        leave: async () => { calls.push(['leave']); current = { status: 'idle', members: [] }; events.emit('change'); return current; },
        move: (body) => { calls.push(['move', body]); return current; },
        setServerUrl: async (url) => { calls.push(['config', url]); return current; },
        close: async () => { calls.push(['close']); },
    };
    const store = { events: new EventEmitter(), view: () => ({}) };
    const server = createBuddyServer({ store, sync: {}, github: {}, lounge, loungeIdleMs: 60 });
    let closed = false;
    t.after(() => closed || server.close());
    const url = await server.urlFor('fixture');
    const html = await (await fetch(url)).text();
    const config = JSON.parse(html.match(/window\.BUDDY_CONFIG\s*=\s*(\{[^;]+\})/)[1]);
    const base = new URL(url).origin;
    const headers = { 'x-buddy-token': config.token, 'content-type': 'application/json' };
    assert.equal((await fetch(`${base}/api/lounge`)).status, 401);
    assert.deepEqual(await (await fetch(`${base}/api/lounge`, { headers })).json(), current);
    if (existsSync(new URL('./public/lounge.js', import.meta.url))) assert.equal((await fetch(`${base}/static/lounge.js`)).status, 200);

    const sse = new AbortController();
    const stream = await fetch(`${base}/api/events`, { headers, signal: sse.signal });
    const reader = stream.body.getReader();
    const post = (path, body) => fetch(`${base}/api/lounge/${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    let res = await post('join', { org: 'acme', buddy: { name: 'x' } });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).result.status, 'connected');
    let text = '';
    while (!text.includes('event: lounge')) text += new TextDecoder().decode((await reader.read()).value);
    assert.match(text, /event: lounge\ndata: \{"status":"connected","org":"acme"/);
    res = await post('join', { org: 'bad' });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'no_org');
    assert.equal((await post('move', { x: 10, y: 70 })).status, 200);
    assert.equal((await post('config', { url: 'https://x.example' })).status, 200);
    assert.deepEqual(calls.slice(0, 4), [['join', { org: 'acme', buddy: { name: 'x' } }], ['join', { org: 'bad', buddy: undefined }], ['move', { x: 10, y: 70 }], ['config', 'https://x.example']]);

    sse.abort();
    await sleep(200);
    assert.deepEqual(calls.at(-1), ['leave'], 'auto-leave after the last panel closed');
    closed = true;
    await server.close();
    assert.deepEqual(calls.at(-1), ['close']);
});
