// End-to-end: real lounge server process + independent extension processes (real lounge.mjs behind the real
// local server.mjs), driven through the same HTTP/SSE routes the canvas iframe uses. Only GitHub is mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const USERS = {
    'tok-alice': { id: 1, login: 'alice', orgs: ['org-a'] },
    'tok-bob': { id: 2, login: 'bob', orgs: ['org-a'] },
    'tok-carol': { id: 3, login: 'carol', orgs: ['org-b'] },
};

function startMockGitHub() {
    const server = createServer((req, res) => {
        const user = USERS[(req.headers.authorization || '').replace(/^Bearer /, '')];
        const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
        if (!user) return reply(401, { message: 'Bad credentials' });
        if (req.url === '/user') return reply(200, { id: user.id, login: user.login });
        const m = req.url.match(/^\/user\/memberships\/orgs\/([^/]+)$/);
        if (m && user.orgs.includes(m[1].toLowerCase())) return reply(200, { state: 'active', role: 'member' });
        reply(404, { message: 'Not Found' });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function waitForLine(child, pattern) {
    return new Promise((resolve, reject) => {
        let buf = '';
        const onData = (chunk) => {
            buf += chunk;
            const m = buf.match(pattern);
            if (m) { child.stdout.off('data', onData); resolve(m); }
        };
        child.stdout.setEncoding('utf8').on('data', onData);
        child.once('exit', (code) => reject(new Error(`process exited (${code}) before ready: ${buf}`)));
    });
}

const PEER = `
import { createBuddyServer } from ${JSON.stringify(pathToFileURL(join(here, 'server.mjs')).href)};
import { createLoungeClient } from ${JSON.stringify(pathToFileURL(join(here, 'lounge.mjs')).href)};
import { EventEmitter } from 'node:events';
const lounge = createLoungeClient({ configPath: process.env.PEER_CONFIG, getGitHubToken: async () => process.env.PEER_TOKEN,
    heartbeatMs: 500, backoff: [100, 200, 400] });
const store = { events: new EventEmitter(), view: () => ({}) };
const server = createBuddyServer({ store, sync: {}, github: {}, lounge });
console.log('PEER_URL ' + await server.urlFor('e2e'));
`;

async function startPeer(token, loungeUrl, dir) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', PEER], {
        env: { ...process.env, PEER_TOKEN: token, PEER_CONFIG: join(dir, `${token}-${Date.now()}.json`), BYTE_BUDDY_LOUNGE_URL: loungeUrl },
        stdio: ['ignore', 'pipe', 'inherit'],
    });
    const [, url] = await waitForLine(child, /PEER_URL (\S+)/);
    const html = await (await fetch(url)).text();
    const { token: apiToken } = JSON.parse(html.match(/window\.BUDDY_CONFIG\s*=\s*(\{[^;]+\})/)[1]);
    const base = new URL(url).origin;
    const headers = { 'x-buddy-token': apiToken, 'content-type': 'application/json' };
    // Iframe-equivalent SSE subscription: track the latest "lounge" state pushed to the canvas.
    const abort = new AbortController();
    const peer = { child, latest: null, waiters: new Set() };
    const res = await fetch(`${base}/api/events`, { headers, signal: abort.signal });
    (async () => {
        const decoder = new TextDecoder();
        let buf = '';
        try {
            for await (const chunk of res.body) {
                buf += decoder.decode(chunk, { stream: true });
                let i;
                while ((i = buf.indexOf('\n\n')) >= 0) {
                    const block = buf.slice(0, i); buf = buf.slice(i + 2);
                    if (!/^event: lounge$/m.test(block)) continue;
                    peer.latest = JSON.parse(block.match(/^data: (.*)$/m)[1]);
                    for (const w of peer.waiters) w();
                }
            }
        } catch { /* aborted */ }
    })();
    peer.post = async (path, body = {}) => {
        const r = await fetch(`${base}/api/lounge/${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
        const data = await r.json();
        assert.equal(r.status, 200, `${path}: ${JSON.stringify(data)}`);
        return data.result;
    };
    peer.until = (predicate, label, ms = 5000) => new Promise((resolve, reject) => {
        const check = () => { if (peer.latest && predicate(peer.latest)) { clearTimeout(timer); peer.waiters.delete(check); resolve(peer.latest); } };
        const timer = setTimeout(() => { peer.waiters.delete(check); reject(new Error(`timeout: ${label}; last=${JSON.stringify(peer.latest)}`)); }, ms);
        peer.waiters.add(check);
        check();
    });
    peer.alive = () => child.exitCode === null && child.signalCode === null;
    peer.kill = () => { abort.abort(); if (!peer.alive()) return Promise.resolve(); const exited = new Promise((r) => child.once('exit', r)); child.kill('SIGKILL'); return exited; };
    return peer;
}

const logins = (s) => s.members.map((m) => m.login).sort().join(',');

test('two independent extension processes share an org lounge; other orgs are isolated', { timeout: 60_000 }, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'lounge-e2e-'));
    const github = await startMockGitHub();
    const loungeProc = spawn(process.execPath, [join(here, 'lounge-server', 'server.mjs')], {
        env: { ...process.env, PORT: '0', HOST: '127.0.0.1', LOUNGE_GITHUB_API: `http://127.0.0.1:${github.address().port}` },
        stdio: ['ignore', 'pipe', 'inherit'],
    });
    const peers = [];
    t.after(async () => {
        await Promise.all(peers.map((p) => p.kill()));
        loungeProc.kill();
        github.closeAllConnections(); github.close();
        rmSync(dir, { recursive: true, force: true });
    });
    const [, port] = await waitForLine(loungeProc, /listening on port (\d+)/);
    const loungeUrl = `http://127.0.0.1:${port}`;
    const start = async (tok) => { const p = await startPeer(tok, loungeUrl, dir); peers.push(p); return p; };

    const alice = await start('tok-alice');
    const bob = await start('tok-bob');
    const carol = await start('tok-carol');

    // 1. Join: both org-a users see each other live, without refreshing.
    await alice.post('join', { org: 'org-a', buddy: { name: 'Sprocket', stage: 2, type: 'robot', body: '#ff0000' } });
    await alice.until((s) => s.status === 'connected' && logins(s) === 'alice', 'alice alone');
    await bob.post('join', { org: 'org-a', buddy: { name: 'Gizmo' } });
    await bob.until((s) => logins(s) === 'alice,bob', 'bob sees alice');
    const aliceView = await alice.until((s) => logins(s) === 'alice,bob', 'alice sees bob arrive');
    assert.equal(aliceView.members.find((m) => m.login === 'bob').buddy.name, 'Gizmo');
    assert.equal(aliceView.self.login, 'alice');

    // 2. Org isolation: carol (org-b) gets her own room; org-a never sees her.
    await carol.post('join', { org: 'org-b', buddy: { name: 'Bolt' } });
    await carol.until((s) => s.status === 'connected' && logins(s) === 'carol', 'carol alone in org-b');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(logins(alice.latest), 'alice,bob');
    assert.equal(logins(bob.latest), 'alice,bob');

    // 3. Movement is visible to the other user (clamped to the room).
    await alice.post('move', { x: 42, y: 99 });
    await bob.until((s) => { const a = s.members.find((m) => m.login === 'alice'); return a && a.x === 42 && a.y === 99; }, 'bob sees alice move');
    await alice.post('move', { x: 9999, y: -5 });
    await bob.until((s) => { const a = s.members.find((m) => m.login === 'alice'); return a && a.x === 3160 && a.y === 0; }, 'clamped move');

    // 4. Hard crash: bob's whole process dies; alice sees him leave with no stale buddy.
    await bob.kill();
    await alice.until((s) => logins(s) === 'alice', 'alice sees bob leave after crash');

    // 5. Bob comes back from a fresh process: exactly one bob.
    const bob2 = await start('tok-bob');
    await bob2.post('join', { org: 'org-a', buddy: { name: 'Gizmo' } });
    await alice.until((s) => logins(s) === 'alice,bob', 'bob rejoins once');
    await bob2.until((s) => logins(s) === 'alice,bob', 'bob2 sees alice');

    // 6. Same account from a second machine replaces the first: no duplicate buddy.
    const alice2 = await start('tok-alice');
    await alice2.post('join', { org: 'org-a', buddy: { name: 'Sprocket II' } });
    await alice.until((s) => s.status === 'error' && s.error?.code === 'replaced', 'first alice window replaced');
    const bobView = await bob2.until((s) => s.members.some((m) => m.buddy?.name === 'Sprocket II'), 'bob sees replaced buddy');
    assert.equal(logins(bobView), 'alice,bob');

    // 7. Explicit leave propagates live.
    await alice2.post('leave');
    await bob2.until((s) => logins(s) === 'bob', 'bob sees alice leave');
    await alice2.until((s) => s.status === 'idle', 'alice2 canvas shows idle after leave');
    assert.equal(logins(carol.latest), 'carol');
});
