import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createStore } from './store.mjs';
import { createBuddyServer } from './server.mjs';

// All data and writes are synthetic and project-local. No adapters or live imports.
const here = dirname(fileURLToPath(import.meta.url));
const userId = 'performance-fixture';
const identity = { login: 'fixture-dev', id: 900001, host: 'github.com' };
const ticket = (id, extra = {}) => ({
    id: String(id), title: `Synthetic ticket ${id}`, assignedTo: userId,
    isIssue: false, isOpen: false, closedOn: '2026-01-06T12:00:00.000Z', ...extra,
});
const pr = (number, extra = {}) => ({
    id: `fixture/repo#${number}`, repo: 'fixture/repo', number, title: `Synthetic PR ${number}`,
    url: `https://github.com/fixture/repo/pull/${number}`,
    author: identity.login, authorType: 'User', state: 'merged', draft: false,
    createdAt: '2026-01-06T12:00:00.000Z', updatedAt: '2026-01-06T15:00:00.000Z',
    mergedAt: '2026-01-06T15:00:00.000Z', closedAt: '2026-01-06T15:00:00.000Z',
    additions: 80, deletions: 20, changedFiles: 2, bodyPresent: true,
    headCommitId: 'head', qualityComplete: true, filesComplete: true,
    reviews: [{ id: `review-${number}`, author: 'fixture-peer', authorType: 'User',
        submittedAt: '2026-01-06T14:00:00.000Z', state: 'APPROVED', body: 'Looks good.', commitId: 'head' }],
    comments: [], files: [{ path: 'src/example.js' }], ...extra,
});
function fixture(t) {
    const root = fs.mkdtempSync(join(here, '.performance-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return { root, store: createStore({ root, userId }), restart: () => createStore({ root, userId }) };
}
function syntheticHistory(store) {
    const state = store.load();
    const profile = state.profiles.live;
    profile.github.identity = identity;
    profile.github.historyInitialized = true;
    for (let i = 0; i < 1600; i++) {
        const day = new Date(Date.UTC(2025, 0, 1 + i % 600, 12));
        const at = day.toISOString();
        const reviewed = i % 3 === 0;
        const record = pr(i + 1, {
            author: reviewed ? 'fixture-colleague' : identity.login,
            createdAt: at, updatedAt: at, mergedAt: at, closedAt: at,
            reviews: [{ id: `review-${i}`, author: reviewed ? identity.login : 'fixture-peer',
                authorType: 'User', submittedAt: at, state: 'APPROVED', commitId: 'head',
                body: 'I verified the error handling and checked the implementation. ' + 'Synthetic review evidence. '.repeat(285) }],
        });
        profile.github.records[record.id] = record;
        profile.ledger[`it:${i}`] = {
            id: String(i), source: 'it', title: `Synthetic ticket ${i}`, kind: i % 3 ? 'normal' : 'hd',
            xp: i % 3 ? 100 : 200, status: 'rewarded', closedOn: at, createdOn: at,
            requester: `fixture-requester-${i % 75}`, rewardedAt: at,
        };
    }
    const { storage, ...legacy } = state;
    fs.writeFileSync(store.legacyFile, JSON.stringify(legacy, null, 2));
    fs.rmSync(store.file, { force: true });
    fs.rmSync(join(dirname(store.file), 'buddy.hot.backup.json'), { force: true });
}
function timings(action, count) {
    const values = [];
    for (let i = 0; i < count; i++) {
        const start = performance.now();
        action(i);
        values.push(performance.now() - start);
    }
    values.sort((a, b) => a - b);
    return { medianMs: +values[Math.floor(values.length / 2)].toFixed(3), p95Ms: +values[Math.min(values.length - 1, Math.floor(values.length * .95))].toFixed(3) };
}

test('isolated 1600-PR performance benchmark', { skip: process.env.BUDDY_BENCH !== '1' }, (t) => {
    const { store: seed, restart } = fixture(t);
    syntheticHistory(seed);
    const store = restart();
    const start = performance.now();
    const view = store.view();
    const coldViewMs = +(performance.now() - start).toFixed(3);
    assert.equal(view.progress.total, 1600);
    assert.equal(view.github.summary.merged, 1066);
    assert.equal(view.github.summary.reviewed, 534);
    assert.equal(JSON.stringify(view).includes('Synthetic review evidence.'), false);
    const manifest = JSON.parse(fs.readFileSync(store.file, 'utf8'));
    const referencedBytes = (refs) => Object.values(refs).reduce((sum, ref) => sum + fs.statSync(join(dirname(store.file), ref.name)).size, 0);
    const result = {
        fixture: { prs: 1600, tickets: 1600, legacyBytes: fs.statSync(store.legacyFile).size, hotBytes: fs.statSync(store.file).size,
            evidenceBytes: referencedBytes(manifest.storage.evidence), projectionBytes: referencedBytes(manifest.storage.projections),
            viewBytes: Buffer.byteLength(JSON.stringify(view)), summaryBytes: Buffer.byteLength(JSON.stringify(store.view({ summary: true }))) },
        coldViewMs, views: timings(() => store.view(), 12),
        runtimeViews: timings((i) => { store.setRuntime({ githubProgress: { processed: i } }); store.view(); }, 12),
    };
    const originals = { writeFileSync: fs.writeFileSync, copyFileSync: fs.copyFileSync, renameSync: fs.renameSync };
    const writes = { writes: 0, backups: 0, renames: 0, bytes: 0 };
    fs.writeFileSync = (...args) => { writes.writes++; writes.bytes += Buffer.byteLength(args[1]); return originals.writeFileSync(...args); };
    fs.copyFileSync = (...args) => { writes.backups++; return originals.copyFileSync(...args); };
    fs.renameSync = (...args) => { writes.renames++; return originals.renameSync(...args); };
    syncBuiltinESMExports();
    try {
        result.pet = timings(() => store.interact('pet'), 6);
        result.rename = timings((i) => store.rename(`Fixture ${i}`), 6);
        result.persistence = writes;
    } finally {
        Object.assign(fs, originals);
        syncBuiltinESMExports();
    }
    assert.equal(restart().view().name, 'Fixture 5');
    console.log(`BUDDY_BENCH ${JSON.stringify(result)}`);
});

test('derived progression invalidates for ticket details, reopen/reclose, GitHub evidence and demo reset', (t) => {
    const { store, restart } = fixture(t);
    const original = ticket(1);
    store.applySync({ tickets: [original], complete: true });
    const first = store.view();
    store.applySync({ tickets: [original], complete: true });
    assert.equal(store.view().progress.xp, first.progress.xp);
    store.applySync({ tickets: [{ ...original, difficulty: 3 }], complete: true });
    assert.ok(store.view().progress.bonusXp > first.progress.bonusXp);
    store.applySync({ tickets: [{ ...original, isOpen: true }], complete: false });
    assert.equal(store.view().progress.total, 0);
    assert.equal(store.view().progress.reopened, 1);
    store.applySync({ tickets: [original], complete: true });
    assert.equal(store.view().progress.total, 1);
    const record = pr(1);
    store.applyGitHubSync({ identity, records: [record], complete: true });
    const github = store.view().progress.githubXp;
    assert.ok(github > 0);
    assert.equal(store.view().github.summary.clean, 1);
    store.applyGitHubSync({ identity, records: [record], complete: true });
    assert.equal(store.view().progress.githubXp, github);
    store.applyGitHubSync({ identity, records: [{ ...record, qualityComplete: false }], complete: true });
    assert.ok(store.view().progress.githubXp < github);
    assert.equal(store.view().github.summary.clean, 0);
    assert.equal(store.view().github.coverage.pending, 1);
    assert.deepEqual(restart().view().progress, store.view().progress);
    const liveXp = store.view().progress.xp;
    store.setMode('demo');
    assert.equal(store.view().progress.total, 0);
    store.simulateDemoTicket('critical', 2);
    assert.equal(store.view().progress.critical, 2);
    store.resetDemo();
    assert.equal(store.view().progress.xp, 0);
    store.setMode('live');
    assert.equal(store.view().progress.xp, liveXp);
});

test('cached view data is detached, runtime changes stay fresh, care achievements still settle', (t) => {
    const { store } = fixture(t);
    store.applyGitHubSync({ identity, records: [pr(1)], complete: true });
    store.load().care.counts.pet = 99;
    const expected = store.view();
    const edited = store.view();
    edited.github.analytics.all.timeline.length = 0;
    edited.github.summary.merged = 999;
    edited.github.settings.repositories.push('fiction/other');
    edited.progress.githubMetrics.clean = 999;
    edited.care.counts.pet = 0;
    edited.prefs.motion = 'edited';
    edited.celebrations.length = 0;
    assert.deepEqual(store.view().github, expected.github);
    assert.deepEqual(store.view().care.counts, expected.care.counts);
    assert.deepEqual(store.view().prefs, expected.prefs);
    assert.deepEqual(store.view().celebrations, expected.celebrations);
    const before = fs.readFileSync(store.file, 'utf8');
    store.setRuntime({ githubSyncing: true, githubProgress: { processed: 42 }, syncing: true });
    const runtime = store.view();
    assert.equal(runtime.github.progress.processed, 42);
    assert.equal(runtime.github.syncing, true);
    assert.equal(runtime.sync.syncing, true);
    assert.equal(fs.readFileSync(store.file, 'utf8'), before);
    store.interact('pet');
    const after = store.view();
    assert.equal(after.care.counts.pet, 100);
    assert.ok(after.achievements.find((a) => a.id === 'best-friends').unlockedAt);
    assert.equal(after.progress.xp, expected.progress.xp);
    store.setRuntime({ githubSyncing: false });
    store.setGitHubSettings({ repositories: ['fiction/other'], enabled: false });
    assert.equal(store.view().github.coverage.discovered, 0);
    assert.equal(store.view().github.settings.enabled, false);
    store.recordGitHubFailure('Synthetic failure');
    assert.equal(store.view().github.lastAttempt.error, 'Synthetic failure');
    store.recordSyncFailure('Synthetic ticket failure', 'fixture');
    assert.equal(store.view().sync.lastAttempt.error, 'Synthetic ticket failure');
});

test('UTC day and exact rolling-window boundaries expire cached GitHub analytics without mutation', (t) => {
    const now = Date.UTC(2026, 9, 25, 23, 59, 59);
    t.mock.timers.enable({ apis: ['Date'], now });
    const { store } = fixture(t);
    const at = new Date(now).toISOString();
    const reviewed = pr(1, {
        author: 'fixture-colleague', state: 'open', mergedAt: null, closedAt: null,
        createdAt: at, reviews: [{ id: 'own', author: identity.login, authorType: 'User',
            submittedAt: at, state: 'APPROVED', body: 'Looks good.', commitId: 'head' }],
    });
    store.applyGitHubSync({ identity, records: [reviewed], complete: true });
    assert.equal(store.view().challenges.find((c) => c.id === 'gh-daily').progress, 1);
    t.mock.timers.setTime(now - 1);
    assert.equal(store.view().github.summary.reviewed, 0);
    t.mock.timers.setTime(now);
    assert.equal(store.view().github.summary.reviewed, 1);
    t.mock.timers.setTime(now + 1000);
    assert.equal(store.view().challenges.find((c) => c.id === 'gh-daily').progress, 0);
    for (const days of [7, 30, 90]) {
        t.mock.timers.setTime(now + days * 86_400_000);
        assert.equal(store.view().github.analytics[String(days)].reviewed, 1);
        t.mock.timers.setTime(now + days * 86_400_000 + 1);
        assert.equal(store.view().github.analytics[String(days)].reviewed, 0);
    }
});

test('local day/week/month rollovers invalidate ticket totals and future events become eligible', (t) => {
    const midnight = new Date(2026, 10, 1).getTime();
    t.mock.timers.enable({ apis: ['Date'], now: midnight - 1000 });
    const { store } = fixture(t);
    store.applySync({ tickets: [ticket(1, { closedOn: new Date(midnight - 2000).toISOString() })] });
    assert.equal(store.view().progress.today, 1);
    assert.equal(store.view().progress.month, 1);
    const future = new Date(midnight + 1000).toISOString();
    store.applyGitHubSync({ identity, records: [pr(1, {
        createdAt: future, mergedAt: future, closedAt: future, reviews: [],
    })] });
    assert.equal(store.view().github.summary.merged, 0);
    t.mock.timers.setTime(midnight);
    assert.equal(store.view().progress.today, 0);
    assert.equal(store.view().progress.month, 0);
    t.mock.timers.setTime(midnight + 1000);
    assert.equal(store.view().github.summary.merged, 1);
    const monday = new Date(2026, 10, 2).getTime();
    t.mock.timers.setTime(monday - 1);
    assert.equal(store.view().progress.week, 1);
    t.mock.timers.setTime(monday);
    assert.equal(store.view().progress.week, 0);
});

test('durable mutations immediately survive restart and keep the previous atomic backup', (t) => {
    const { store, restart } = fixture(t);
    store.applySync({ tickets: [ticket(1)], complete: true });
    const saved = fs.readFileSync(store.file, 'utf8');
    store.rename('Durable fixture');
    assert.equal(fs.readFileSync(join(dirname(store.file), 'buddy.hot.backup.json'), 'utf8'), saved);
    assert.equal(restart().view().name, 'Durable fixture');
    store.interact('pet');
    assert.equal(restart().view().care.counts.pet, 1);
    assert.ok(fs.readdirSync(dirname(store.file)).includes('buddy.hot.backup.json'));
    assert.ok(fs.readdirSync(dirname(store.file)).some((name) => name.startsWith('evidence-live-tickets-')));
    assert.equal(fs.readdirSync(dirname(store.file)).some((name) => name.endsWith('.tmp')), false);
});

test('SSE coalesces change invalidations, preserves independent effects, and never starts GitHub sync', async (t) => {
    const { store } = fixture(t);
    let syncCalls = 0;
    const server = createBuddyServer({
        store, sync: { refresh: () => { syncCalls++; } }, github: { requestRefresh: () => { syncCalls++; } },
    });
    t.after(() => server.close());
    const url = await server.urlFor('performance-fixture');
    const html = await (await fetch(url)).text();
    const token = html.match(/"token":"([a-f0-9]+)"/)[1];
    const controller = new AbortController();
    t.after(() => controller.abort());
    const response = await fetch(new URL(`/api/events?t=${token}`, url), { signal: controller.signal });
    const reader = response.body.getReader();
    await reader.read(); // Initial SSE retry confirms the subscriber is connected.
    store.setRuntime({ githubProgress: { processed: 1 } });
    store.setRuntime({ githubProgress: { processed: 2 } });
    store.events.emit('fx', { fx: 'pet' });
    store.events.emit('fx', { fx: 'play' });
    let text = '';
    while (!text.includes('event: change')) text += new TextDecoder().decode((await reader.read()).value);
    assert.equal((text.match(/event: change/g) || []).length, 1);
    assert.equal((text.match(/event: fx/g) || []).length, 2);
    assert.ok(text.indexOf('event: fx') < text.indexOf('event: change'));
    const state = await (await fetch(new URL(`/api/state?t=${token}`, url))).json();
    assert.equal(state.github.progress.processed, 2);
    assert.equal(syncCalls, 0);
    controller.abort();
    await server.close();
    assert.equal(store.events.listenerCount('change'), 0);
    assert.equal(store.events.listenerCount('fx'), 0);
});
