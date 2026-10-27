import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStore } from './store.mjs';
import { createGitHubSyncService } from './github-sync.mjs';
import { createGitHubSource } from './github-source.mjs';
import { createBuddyServer } from './server.mjs';
import { inspectPR, contributionEvents } from './github.mjs';
import { ECONOMY } from './economy.mjs';

function fixture(t) {
    const root = mkdtempSync(join(process.cwd(), '.buddy-integration-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const store = createStore({ root, userId: 'FIXTURE' });
    store.setGitHubSettings({ repositories: ['org/repo'] });
    return store;
}
const identity = { login: 'fixture', id: 42, host: 'github.com' };

test('GitHub never fetches on startup, stale checks or elapsed retry deadlines without a manual click', async (t) => {
    const store = fixture(t);
    let calls = 0, clock = Date.now();
    const service = createGitHubSyncService({ store, now: () => clock,
        schedule() { assert.fail('manual-only synchronization cannot create retry timers'); },
        source: { async fetchActivity() {
            calls++;
            return calls === 1 ? { identity, complete: false, cursor: 'saved', retryAt: clock + 120000, pauseReason: 'rate_limit' }
                : { identity, complete: true };
        } },
    });
    t.after(() => service.stop());
    service.start();
    service.syncIfStale();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 0);
    await service.refresh();
    assert.equal(calls, 1);
    clock += 120001;
    service.start();
    service.syncIfStale();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    await service.refresh();
    assert.equal(calls, 2);
    assert.doesNotMatch(readFileSync(new URL('./extension.mjs', import.meta.url), 'utf8'), /github\.(start|syncIfStale)\(/);
});

test('manual sync single-flight, scope and failure preserve cache', async (t) => {
    const store = fixture(t);
    let calls = 0, params, release;
    let clock = Date.now();
    const pending = new Promise((resolve) => { release = resolve; });
    const source = { async fetchActivity(input) { params = input; calls++; await pending; return { identity, records: [], complete: true, warnings: [] }; } };
    const service = createGitHubSyncService({ store, source, now: () => clock });
    const a = service.refresh(), b = service.refresh();
    assert.equal(calls, 1);
    assert.equal(store.view().github.syncing, true);
    assert.throws(() => store.setGitHubSettings({ repositories: ['org/new'] }), /Wait/);
    release();
    assert.deepEqual(await a, await b);
    assert.equal(store.view().github.syncing, false);
    service.syncIfStale();
    assert.equal(calls, 1);
    clock += 31 * 60_000;
    store.setGitHubSettings({ repositories: ['org/repo'] });
    await service.refresh();
    assert.deepEqual(params.repositories, ['org/repo']);
    assert.equal(params.lastSync.complete, true);
    store.setGitHubSettings({ enabled: false });
    assert.equal((await service.refresh()).reason, "disabled");
    assert.equal(calls, 2);
    store.setGitHubSettings({ enabled: true });
    const failed = createGitHubSyncService({ store, source: { async fetchActivity() { throw new Error('access denied fixture'); } }, now: () => clock });
    const old = store.view().progress.xp;
    await assert.rejects(failed.refresh(), /access denied/);
    assert.equal(store.view().progress.xp, old);
    assert.match(store.view().github.lastAttempt.error, /access denied/);
    assert.equal((await failed.refresh()).paused, true);
    failed.stop();
});

test('sync watermark, scope completion and partial bootstrap are persisted atomically', (t) => {
    const store = fixture(t);
    store.setGitHubSettings({ repositories: ['org/repo'] });
    const watermark = '2025-01-01T00:00:00Z';
    store.applyGitHubSync({ identity, complete: false, cursor: 'opaque', watermark });
    let saved = JSON.parse(readFileSync(store.file, 'utf8')).profiles.live.github;
    assert.equal(saved.lastSync.at, watermark);
    assert.equal(saved.scopeChanged, undefined);
    assert.equal(saved.historyInitialized, undefined);
    assert.equal(saved.cursor, 'opaque');
    store.applyGitHubSync({ identity, complete: true, watermark });
    saved = JSON.parse(readFileSync(store.file, 'utf8')).profiles.live.github;
    assert.equal(saved.lastSync.at, watermark);
    assert.equal(saved.historyInitialized, true);
    assert.equal(saved.cursor, null);
    store.setGitHubSettings({ repositories: ['ORG/REPO', 'org/repo'] });
    assert.equal(store.load().profiles.live.github.scopeChanged, undefined);
    assert.equal(store.load().profiles.live.github.lastSync.complete, true);
});

test('partial imports continue automatically, persist each batch and stop when complete', async (t) => {
    const store = fixture(t);
    let clock = Date.now(), calls = 0, pending;
    const scheduled = [];
    const service = createGitHubSyncService({ store, now: () => clock,
        schedule(fn, delay) { const job = { fn, delay }; scheduled.push(job); return job; },
        cancel() {},
        source: { async fetchActivity(input) {
            calls++;
            if (calls === 1) return { identity, records: [], complete: false, cursor: 'next', processed: 40 };
            assert.equal(input.cursor, calls === 2 ? 'next' : null);
            await new Promise((resolve) => { pending = resolve; });
            return { identity, records: [], complete: true, processed: 1 };
        } },
    });
    t.after(() => service.stop());
    const importing = service.refresh();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.load().profiles.live.github.cursor, 'next');
    assert.equal(JSON.parse(readFileSync(store.file, 'utf8')).profiles.live.github.cursor, 'next');
    assert.equal(store.view().github.syncing, true);
    assert.equal(scheduled.length, 0);
    assert.equal(calls, 2);
    assert.deepEqual(service.requestRefresh(), { syncing: true, joined: true });
    const joined = service.refresh();
    pending();
    assert.deepEqual(await importing, await joined);
    assert.equal(store.load().profiles.live.github.cursor, null);
    assert.equal(store.view().github.lastSync.complete, true);
    assert.equal(scheduled.length, 0);
    // Completion does not reject an immediate manual incremental refresh.
    assert.deepEqual(service.requestRefresh(), { syncing: true, joined: false });
    await new Promise((resolve) => setImmediate(resolve));
    pending();
    await service.refresh();
    assert.equal(calls, 3);
});

test('real source and service finish a multi-batch import and persist complete coverage', async (t) => {
    const store = fixture(t);
    let clock = Date.now(), next;
    const raw = (number) => ({ number, repository_url: 'https://api.github.com/repos/org/repo',
        pull_request: {}, user: { login: identity.login, type: 'User' }, title: 'Fixture PR',
        created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-02T00:00:00Z',
        state: 'closed', merged_at: '2025-01-02T00:00:00Z', draft: false, body: 'Fixture description',
        additions: 10, deletions: 0, changed_files: 1, head: { sha: 'head' }, labels: [] });
    const source = createGitHubSource({ request: async (endpoint) => {
        if (endpoint === '/user') return { ...identity, type: 'User' };
        if (endpoint.startsWith('/search/')) return { total_count: 45, incomplete_results: false, items: Array.from({ length: 45 }, (_, i) => raw(i + 1)) };
        const match = /^\/repos\/org\/repo\/pulls\/(\d+)(?:\/(reviews|comments|files))?/.exec(endpoint);
        assert.ok(match);
        if (!match[2]) return raw(Number(match[1]));
        return match[2] === 'files' ? [{ filename: 'a.js', additions: 10, deletions: 0 }] : [];
    } });
    const service = createGitHubSyncService({ store, source, now: () => clock,
        schedule(fn) { next = fn; return { fn }; }, cancel() {},
    });
    t.after(() => service.stop());
    await service.refresh();
    assert.equal(next, undefined);
    const saved = JSON.parse(readFileSync(store.file, 'utf8')).profiles.live.github;
    assert.equal(saved.lastSync.complete, true);
    assert.equal(saved.cursor, null);
    assert.equal(Object.keys(store.exportState().profiles.live.github.records).length, 45);
    assert.deepEqual(store.view().github.coverage, { processed: 45, discovered: 45, pending: 0, unavailable: 0, discovering: false, unknownMerger: 45 });
});

test('stalled imports back off and rate-limit deadlines survive restart', async (t) => {
    const store = fixture(t);
    let clock = Date.now();
    let delay;
    const retryAt = clock + 20 * 60_000;
    const source = { async fetchActivity() { return { identity, complete: false, cursor: 'pending', processed: 0, retryAt, pauseReason: 'rate_limit' }; } };
    const service = createGitHubSyncService({ store, source, now: () => clock,
        schedule(fn, ms) { delay = ms; return { fn }; }, cancel() {},
    });
    t.after(() => service.stop());
    await service.refresh();
    assert.equal(delay, undefined); // No automatic retry timers, even after a quota pause.
    const restarted = createGitHubSyncService({ store, source, now: () => clock });
    t.after(() => restarted.stop());
    assert.deepEqual(await restarted.refresh(), { paused: true, retryAt, reason: 'rate_limit' });
    clock = retryAt;
    const stalled = createGitHubSyncService({ store, now: () => clock, source: { async fetchActivity() {
        return { identity, complete: false, cursor: 'different-order', processed: 0 };
    } }, schedule(fn, ms) { delay = ms; return { fn }; }, cancel() {} });
    t.after(() => stalled.stop());
    await stalled.refresh();
    assert.equal(delay, undefined);
    assert.deepEqual(stalled.requestRefresh(), { paused: true, retryAt: clock + 5 * 60_000, reason: 'error' });
});

test('stopping in-flight import does not schedule another batch', async (t) => {
    const store = fixture(t);
    let release, scheduled = 0;
    const service = createGitHubSyncService({ store,
        source: { async fetchActivity() { await new Promise((resolve) => { release = resolve; }); return { identity, complete: false, cursor: 'next', processed: 1 }; } },
        schedule() { scheduled++; },
    });
    const done = service.refresh();
    service.stop();
    release();
    await done;
    assert.equal(scheduled, 0);
});

test('coverage exposes processed and discovered PR counts without calling unknown quality clean', (t) => {
    const store = fixture(t);
    const record = reviewedPR();
    store.applyGitHubSync({ identity, records: [record, { ...record, id: 'org/repo#2', number: 2, qualityComplete: false }], complete: false, cursor: JSON.stringify({ search: [{}] }) });
    assert.deepEqual(store.view().github.coverage, { processed: 1, discovered: 2, pending: 1, unavailable: 0, discovering: true, unknownMerger: 2 });
});

function reviewedPR(overrides = {}) {
    return { id: 'org/repo#1', repo: 'org/repo', number: 1, author: 'fixture', authorType: 'User', createdAt: '2025-01-01T00:00:00Z', mergedAt: '2025-01-10T00:00:00Z', state: 'merged', additions: 100, deletions: 0, changedFiles: 2, headCommitId: 'head', qualityComplete: true, filesComplete: true, bodyPresent: true, files: [], reviews: [{ id: 1, author: 'teammate', authorType: 'User', state: 'APPROVED', submittedAt: '2025-01-04T00:00:00Z', commitId: 'head', body: '' }], comments: [], ...overrides };
}

test('contribution multipliers apply before caps without changing activity identity', () => {
    const pr = reviewedPR();
    const regular = contributionEvents({ [pr.id]: pr }, identity);
    const boosted = contributionEvents({ [pr.id]: pr }, identity, { ...ECONOMY.github, multiplier: 2 });
    assert.deepEqual(boosted.map((e) => e.id), regular.map((e) => e.id));
    assert.equal(boosted.find((e) => e.kind === 'merged').rawXp, ECONOMY.github.merged * 2);
    assert.ok(boosted.reduce((s, e) => s + e.xp, 0) <= ECONOMY.github.dailyCaps.total);
});

test('historical bootstrap stays quiet across partial batches without losing XP or unlocks', (t) => {
    const store = fixture(t);
    const treatsBefore = store.load().profiles.live.treatsEarned;
    const first = reviewedPR();
    store.applyGitHubSync({ identity, records: [first], complete: false, cursor: 'next' });
    const xp = store.view().progress.githubXp;
    store.applyGitHubSync({ identity, records: [reviewedPR({ id: 'org/repo#2', number: 2 }), reviewedPR({ id: 'org/repo#3', number: 3 })], complete: true });
    assert.equal(store.load().profiles.live.treatsEarned, treatsBefore);
    assert.ok(store.view().progress.githubXp > xp);
    assert.ok(store.load().profiles.live.unlocked.includes('body-github'));
});

test('normalized findings do not double-count inline threads, review summaries and request decisions', () => {
    const pr = reviewedPR();
    pr.reviews.push({ id: 2, author: 'coderabbitai[bot]', authorType: 'Bot', state: 'COMMENTED', submittedAt: '2025-01-03T00:00:00Z', body: '⚠️ Potential issue: missing validation' });
    pr.comments.push({ id: 10, reviewId: 2, author: 'coderabbitai[bot]', authorType: 'Bot', createdAt: '2025-01-03T00:00:00Z', body: '⚠️ Potential issue: missing validation', path: 'a.js' });
    pr.comments.push({ ...pr.comments[0], id: 11, inReplyToId: 10 });
    const q = inspectPR(pr, identity.login);
    assert.equal(q.findings, 1);
    assert.equal(q.automated, 1);
    assert.equal(q.clean, false);
    const human = reviewedPR({ reviews: [{ ...pr.reviews[0], state: 'CHANGES_REQUESTED', body: 'Please fix validation.' }], comments: [{ ...pr.comments[0], author: 'teammate', authorType: 'User', reviewId: 1, body: 'Please fix validation.' }] });
    assert.equal(inspectPR(human, identity.login).findings, 1);
});

test('dismissal invalidates quality sample and later feedback cannot earn a premature responsiveness bonus', () => {
    const pr = reviewedPR();
    pr.reviews.push({ ...pr.reviews[0], id: 2, state: 'DISMISSED', submittedAt: '2025-01-05T00:00:00Z' });
    assert.equal(inspectPR(pr, identity.login).sampled, false);
    const external = reviewedPR({ author: 'teammate', reviews: [{ id: 3, author: 'fixture', authorType: 'User', state: 'APPROVED', body: '', submittedAt: '2025-01-01T01:00:00Z', commitId: 'head' }], comments: [{ id: 12, reviewId: 3, author: 'fixture', authorType: 'User', body: 'Please fix the input validation before parsing.', path: 'a.js', createdAt: '2025-01-03T00:00:00Z' }] });
    const events = contributionEvents({ [external.id]: external }, identity);
    assert.equal(events.some((e) => e.kind === 'responsive'), false);
    assert.equal(events.find((e) => e.kind === 'constructive').at, '2025-01-03T00:00:00Z');
});

test('server delivers real UI, authenticated GitHub routes and state; rejects bad input', async (t) => {
    const store = fixture(t);
    let refreshed = 0;
    const server = createBuddyServer({ store, sync: { refresh: async () => ({ method: 'direct', result: {} }) }, github: { requestRefresh: () => { refreshed++; return { syncing: true, joined: false }; } } });
    t.after(() => server.close());
    const url = await server.urlFor('fixture');
    const html = await (await fetch(url)).text();
    assert.match(html, /githubProgress/);
    const config = JSON.parse(html.match(/window\.BUDDY_CONFIG\s*=\s*(\{[^;]+\})/)[1]);
    const base = new URL(url).origin;
    assert.equal((await fetch(`${base}/api/state`)).status, 401);
    const headers = { 'x-buddy-token': config.token, 'content-type': 'application/json' };
    const view = await (await fetch(`${base}/api/state`, { headers })).json();
    assert.equal(view.github.identity, null);
    assert.equal(view.github.summary.cleanRate, null);
    let res = await fetch(`${base}/api/github/settings`, { method: 'POST', headers, body: JSON.stringify({ repositories: ['org/repo'], enabled: true }) });
    assert.equal(res.status, 200);
    res = await fetch(`${base}/api/github/settings`, { method: 'POST', headers, body: JSON.stringify({ repositories: ['https://bad'] }) });
    assert.equal(res.status, 400);
    res = await fetch(`${base}/api/github/sync`, { method: 'POST', headers, body: '{}' });
    assert.equal(res.status, 200);
    assert.equal(refreshed, 1);
    const app = await fetch(`${base}/static/app.js`);
    assert.equal(app.status, 200);
    const script = await app.text();
    assert.match(script, /[Mm]anual/);
    assert.doesNotMatch(script, /resumes automatically/);
});

test('stopped imports resume durable cursors in a new service without restarting discovery', async (t) => {
    const store = fixture(t);
    let release;
    const first = createGitHubSyncService({ store, source: { async fetchActivity() {
        await new Promise((resolve) => { release = resolve; });
        return { identity, complete: false, cursor: 'saved-history-cursor', processed: 40 };
    } } });
    const done = first.refresh();
    first.stop();
    release();
    await done;
    const restored = createStore({ root: join(store.file, '..', '..', '..'), userId: 'FIXTURE' });
    const next = createGitHubSyncService({ store: restored, source: { async fetchActivity(input) {
        assert.equal(input.cursor, 'saved-history-cursor');
        return { identity, complete: true };
    } } });
    t.after(() => next.stop());
    await next.refresh();
    assert.equal(restored.load().profiles.live.github.cursor, null);
});

test('discovery-only progress continues without a delay and a failed import pause persists', async (t) => {
    const store = fixture(t);
    let calls = 0;
    const source = { async fetchActivity() {
        calls++;
        return calls === 1 ? { identity, complete: false, cursor: 'discovery-next', processed: 0, canContinue: true }
            : { identity, complete: true };
    } };
    const service = createGitHubSyncService({ store, source, schedule() { assert.fail('healthy import must not schedule a delay'); } });
    t.after(() => service.stop());
    await service.refresh();
    assert.equal(calls, 2);
    const retryAt = Date.now() + 120_000;
    const failed = createGitHubSyncService({ store, source: { async fetchActivity() {
        throw Object.assign(new Error('secondary rate limit'), { code: 'github_rate_limited', retryAt });
    } } });
    t.after(() => failed.stop());
    await assert.rejects(failed.refresh(), /secondary/);
    const restored = createStore({ root: join(store.file, '..', '..', '..'), userId: 'FIXTURE' });
    const next = createGitHubSyncService({ store: restored, source: { async fetchActivity() { assert.fail('persisted rate limit must prevent requests'); } } });
    t.after(() => next.stop());
    assert.deepEqual(next.requestRefresh(), { paused: true, retryAt, reason: 'rate_limit' });
});

test('HTTP refresh starts and joins a running import without holding the connection open', async (t) => {
    const store = fixture(t);
    let calls = 0, release;
    const service = createGitHubSyncService({ store, source: { async fetchActivity() {
        calls++;
        await new Promise((resolve) => { release = resolve; });
        return { identity, complete: true };
    } } });
    const server = createBuddyServer({ store, sync: {}, github: service });
    t.after(() => { service.stop(); return server.close(); });
    const url = await server.urlFor('fixture');
    const html = await (await fetch(url)).text();
    const config = JSON.parse(html.match(/window\.BUDDY_CONFIG\s*=\s*(\{[^;]+\})/)[1]);
    const endpoint = `${new URL(url).origin}/api/github/sync`;
    const request = () => fetch(endpoint, { method: 'POST', headers: { 'x-buddy-token': config.token, 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(2000) }).then((res) => res.json());
    assert.deepEqual((await request()).result, { syncing: true, joined: false });
    assert.deepEqual((await request()).result, { syncing: true, joined: true });
    assert.equal(calls, 1);
    const done = service.refresh();
    release();
    await done;
});

test('unavailable evidence coverage persists without inventing quality or repeat XP', (t) => {
    const store = fixture(t);
    const pr = reviewedPR({ qualityComplete: false, filesComplete: false,
        detailFailure: { updatedAt: null, attempts: 1, terminal: true, retryAt: null, status: 404, message: 'Unavailable' } });
    store.applyGitHubSync({ identity, complete: true, records: [pr] });
    const xp = store.view().progress.xp;
    const restored = createStore({ root: join(store.file, '..', '..', '..'), userId: 'FIXTURE' });
    assert.deepEqual(restored.view().github.coverage, { processed: 0, discovered: 1, pending: 0, unavailable: 1, discovering: false, unknownMerger: 1 });
    assert.equal(restored.view().github.summary.cleanRate, null);
    restored.applyGitHubSync({ identity, complete: true, records: [pr] });
    assert.equal(restored.view().progress.xp, xp);
});
