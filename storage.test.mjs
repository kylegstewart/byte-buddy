import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, dirname } from 'node:path';
import { createStore } from './store.mjs';
import { createBuddyServer } from './server.mjs';

const userId = 'split-fixture';
const identity = { login: 'fixture', id: 42, host: 'github.com' };
function fixture(t) {
    const root = fs.mkdtempSync(join(process.cwd(), '.split-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return { root, store: createStore({ root, userId }), restart: () => createStore({ root, userId }) };
}
const tickets = [{ id: '123', title: 'Fixture', assignedTo: userId, isIssue: true, isOpen: false, closedOn: '2026-01-05T12:00:00Z' }];
const pr = { id: 'fixture/repo#1', repo: 'fixture/repo', number: 1, author: 'fixture', authorType: 'User', title: 'Fixture', state: 'merged', createdAt: '2026-01-05T12:00:00Z', mergedAt: '2026-01-06T12:00:00Z', additions: 20, deletions: 2, changedFiles: 1, filesComplete: true, qualityComplete: true, reviews: [], comments: [] };
const plain = (value) => JSON.parse(JSON.stringify(value));

test('legacy migration preserves evidence, XP, award IDs, unlocks and immutable original; rollback exports CURRENT state', (t) => {
    const { root, store: seed, restart } = fixture(t);
    seed.applySync({ tickets, complete: true });
    seed.applyGitHubSync({ identity, records: [pr], complete: true });
    seed.setMode('demo'); seed.simulateDemoTicket('critical', 2); seed.setMode('live');
    const originalState = seed.exportState();
    const expected = seed.view();
    // Build an independent legacy-only fixture, not an edit to an authoritative split store.
    const legacyRoot = join(root, 'legacy');
    const store = createStore({ root: legacyRoot, userId });
    fs.mkdirSync(dirname(store.legacyFile), { recursive: true });
    const text = JSON.stringify(originalState, null, 2);
    fs.writeFileSync(store.legacyFile, text);
    const actual = store.view();
    assert.deepEqual(actual.progress, expected.progress);
    assert.deepEqual(actual.achievements, expected.achievements);
    assert.deepEqual(actual.catalog, expected.catalog);
    assert.deepEqual(plain(store.exportState().profiles), plain(originalState.profiles));
    assert.equal(fs.readFileSync(store.legacyFile, 'utf8'), text);
    store.rename('New name'); store.interact('pet');
    store.applyGitHubSync({ identity, records: [pr], complete: true });
    store.applySync({ tickets, complete: true });
    assert.equal(store.view().progress.xp, expected.progress.xp);
    const exported = JSON.parse(fs.readFileSync(store.exportRollback(), 'utf8'));
    assert.equal(exported.name, 'New name');
    assert.equal(exported.care.counts.pet, 1);
    assert.equal(exported.storage, undefined);
    assert.deepEqual(exported.profiles.live.github.records, { [pr.id]: pr });
    assert.equal(fs.readFileSync(store.legacyFile, 'utf8'), text);
    const restored = createStore({ root: legacyRoot, userId });
    assert.equal(restored.view().name, 'New name');
    assert.equal(restored.view().progress.xp, expected.progress.xp);
    assert.deepEqual(restart().view().progress, seed.view().progress);
    const rollbackRoot = join(root, 'rollback');
    const rollback = createStore({ root: rollbackRoot, userId });
    fs.mkdirSync(dirname(rollback.legacyFile), { recursive: true });
    fs.writeFileSync(rollback.legacyFile, JSON.stringify(exported));
    assert.deepEqual(rollback.view().progress, restored.view().progress);
    assert.deepEqual(rollback.view().achievements, restored.view().achievements);
});

test('hot mutations retain immutable evidence and projections; settled restart/Home do not read cold evidence', (t) => {
    const { store, restart } = fixture(t);
    store.applySync({ tickets }); store.applyGitHubSync({ identity, records: [pr] });
    const before = JSON.parse(fs.readFileSync(store.file, 'utf8'));
    store.interact('pet'); store.rename('Fast');
    const after = JSON.parse(fs.readFileSync(store.file, 'utf8'));
    assert.deepEqual(after.storage.evidence, before.storage.evidence);
    assert.deepEqual(after.storage.projections, before.storage.projections);
    assert.equal(after.profiles.live.ledger, undefined);
    assert.equal(after.profiles.live.github.records, undefined);
    const projection = JSON.parse(fs.readFileSync(join(dirname(store.file), after.storage.projections.live.name), 'utf8'));
    assert.equal(projection.progress.githubDerived, undefined);
    assert.equal(projection.progress.githubMetrics, undefined);
    assert.equal(projection.github.events, undefined);
    assert.equal(projection.github.summary, undefined);
    const read = fs.readFileSync;
    const coldReads = [];
    fs.readFileSync = (path, ...args) => { if (String(path).includes('evidence-')) coldReads.push(String(path)); return read(path, ...args); };
    syncBuiltinESMExports();
    try {
        const restored = restart();
        assert.equal(restored.view({ summary: true }).name, 'Fast');
        restored.interact('pet');
        assert.equal(coldReads.length, 0);
    } finally { fs.readFileSync = read; syncBuiltinESMExports(); }
});

test('ticket writes leave GitHub generations unchanged; demo reset never resurrects old evidence', (t) => {
    const { store, restart } = fixture(t);
    store.applyGitHubSync({ identity, records: [pr] });
    const before = JSON.parse(fs.readFileSync(store.file, 'utf8'));
    store.applySync({ tickets });
    const after = JSON.parse(fs.readFileSync(store.file, 'utf8'));
    assert.deepEqual(after.storage.evidence['live:github'], before.storage.evidence['live:github']);
    assert.notDeepEqual(after.storage.evidence['live:tickets'], before.storage.evidence['live:tickets']);
    store.setMode('demo'); store.simulateDemoTicket('hd', 3); store.resetDemo();
    assert.equal(restart().view().progress.total, 0);
    store.setMode('live');
    assert.equal(restart().view().progress.total, 1);
});

test('corrupt manifests fail closed, never silently loading an old legacy save', (t) => {
    const { store, restart } = fixture(t);
    store.rename('Current');
    fs.writeFileSync(store.legacyFile, JSON.stringify({ name: 'STALE' }));
    fs.writeFileSync(store.file, 'broken');
    fs.writeFileSync(join(dirname(store.file), 'buddy.hot.backup.json'), 'broken');
    assert.throws(() => restart().view(), /refusing stale legacy fallback/);
});

test('interrupted cold generation publication leaves the previous manifest readable', (t) => {
    const { store, restart } = fixture(t);
    store.applySync({ tickets });
    const before = fs.readFileSync(store.file, 'utf8');
    const write = fs.writeFileSync;
    fs.writeFileSync = (path, ...args) => { if (String(path).includes('projection-live')) throw new Error('fixture disk failure'); return write(path, ...args); };
    syncBuiltinESMExports();
    try { assert.throws(() => store.applyGitHubSync({ identity, records: [pr] }), /fixture disk failure/); }
    finally { fs.writeFileSync = write; syncBuiltinESMExports(); }
    assert.equal(fs.readFileSync(store.file, 'utf8'), before);
    const restored = restart().view();
    assert.equal(restored.progress.total, 1);
    assert.equal(restored.progress.githubXp, 0);
});

test('backup recovery remains writable without replacing the known-good backup with corrupt content', (t) => {
    const { store, restart } = fixture(t);
    store.applySync({ tickets });
    store.rename('Committed');
    const backup = join(dirname(store.file), 'buddy.hot.backup.json');
    const prior = fs.readFileSync(backup, 'utf8');
    fs.writeFileSync(store.file, 'corrupt');
    const recovered = restart();
    assert.equal(recovered.view().progress.total, 1);
    recovered.rename('Recovered');
    assert.equal(fs.readFileSync(backup, 'utf8'), prior);
    assert.equal(restart().view().name, 'Recovered');
});

test('missing or corrupt projections rebuild and persist from verified evidence without changing XP', (t) => {
    const { store, restart } = fixture(t);
    store.applySync({ tickets }); store.applyGitHubSync({ identity, records: [pr] });
    const expected = store.view().progress;
    const manifest = JSON.parse(fs.readFileSync(store.file, 'utf8'));
    fs.writeFileSync(join(dirname(store.file), manifest.storage.projections.live.name), '{}');
    fs.rmSync(join(dirname(store.file), manifest.storage.projections.demo.name));
    assert.deepEqual(restart().view().progress, expected);
    const repaired = JSON.parse(fs.readFileSync(store.file, 'utf8'));
    assert.notEqual(repaired.storage.projections.live.name, manifest.storage.projections.live.name);
    assert.deepEqual(restart().view().progress, expected);
});

test('cold evidence checksum errors cannot silently reset or overwrite progression', (t) => {
    const { store, restart } = fixture(t);
    store.applySync({ tickets });
    const manifest = JSON.parse(fs.readFileSync(store.file, 'utf8'));
    fs.writeFileSync(join(dirname(store.file), manifest.storage.evidence['live:tickets'].name), '{}');
    const restored = restart();
    assert.equal(restored.view({ summary: true }).progress.total, 1);
    assert.throws(() => restored.exportState(), /checksum mismatch/);
    assert.throws(() => restored.applySync({ tickets }), /checksum mismatch/);
    assert.deepEqual(JSON.parse(fs.readFileSync(store.file, 'utf8')), manifest);
});

test('failed hot manifest publication preserves current state and cleans unpublished generations', (t) => {
    const { store, restart } = fixture(t);
    store.applySync({ tickets });
    const before = fs.readFileSync(store.file, 'utf8');
    const names = fs.readdirSync(dirname(store.file)).sort();
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => { if (to === store.file) throw new Error('fixture publication failure'); return rename(from, to); };
    syncBuiltinESMExports();
    try { assert.throws(() => store.applyGitHubSync({ identity, records: [pr] }), /publication failure/); }
    finally { fs.renameSync = rename; syncBuiltinESMExports(); }
    assert.equal(fs.readFileSync(store.file, 'utf8'), before);
    assert.deepEqual(fs.readdirSync(dirname(store.file)).sort(), names);
    assert.equal(restart().view().progress.githubXp, 0);
});

test('failed initial migration leaves only the immutable original and can be retried', (t) => {
    const { root, store: seed } = fixture(t);
    seed.applySync({ tickets });
    const original = JSON.stringify(seed.exportState());
    const migratedRoot = join(root, 'migration');
    const store = createStore({ root: migratedRoot, userId });
    fs.mkdirSync(dirname(store.legacyFile), { recursive: true });
    fs.writeFileSync(store.legacyFile, original);
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => { if (to === store.file) throw new Error('migration publication failure'); return rename(from, to); };
    syncBuiltinESMExports();
    try { assert.throws(() => store.view(), /migration publication failure/); }
    finally { fs.renameSync = rename; syncBuiltinESMExports(); }
    assert.equal(fs.readFileSync(store.legacyFile, 'utf8'), original);
    assert.deepEqual(fs.readdirSync(dirname(store.legacyFile)), ['buddy.json']);
    assert.equal(createStore({ root: migratedRoot, userId }).view().progress.xp, seed.view().progress.xp);
});

test('cleanup after restart retains both manifests references and removes superseded committed generations only', (t) => {
    const { store, restart } = fixture(t);
    store.applySync({ tickets });
    const old = JSON.parse(fs.readFileSync(store.file, 'utf8'));
    store.applyGitHubSync({ identity, records: [pr] });
    const restored = restart();
    restored.rename('Retain referenced files');
    const dir = dirname(store.file);
    for (const name of ['buddy.hot.json', 'buddy.hot.backup.json']) {
        const manifest = JSON.parse(fs.readFileSync(join(dir, name), 'utf8'));
        for (const ref of [...Object.values(manifest.storage.evidence), ...Object.values(manifest.storage.projections)]) assert.ok(fs.existsSync(join(dir, ref.name)));
    }
    assert.equal(fs.existsSync(join(dir, old.storage.projections.live.name)), false);
    assert.equal(restart().view().name, 'Retain referenced files');
});

test('concurrent processes never commit references to evidence another process removed', (t) => {
    const { store: first, restart } = fixture(t);
    first.applySync({ tickets });
    const second = restart();
    second.view();
    first.applySync({ tickets: [...tickets, { ...tickets[0], id: '124' }] });
    first.applySync({ tickets: [...tickets, { ...tickets[0], id: '124' }, { ...tickets[0], id: '125' }] });
    second.rename('Stale process');
    second.rename('Stale process again');
    first.rename('Fresh process');
    const dir = dirname(first.file);
    for (const name of ['buddy.hot.json', 'buddy.hot.backup.json']) {
        const manifest = JSON.parse(fs.readFileSync(join(dir, name), 'utf8'));
        for (const ref of Object.values(manifest.storage.evidence)) assert.ok(fs.existsSync(join(dir, ref.name)), `${name} references missing ${ref.name}`);
    }
    const restored = restart().view();
    assert.equal(restored.name, 'Fresh process');
    assert.equal(restored.progress.total, 3);
});

test('undated legacy XP stays in totals but is not invented as a dated cumulative baseline', (t) => {
    const { store } = fixture(t);
    store.applySync({ tickets });
    const state = store.load();
    state.profiles.live.ledger.undated = { ...Object.values(state.profiles.live.ledger)[0], id: 'undated', title: 'Legacy', xp: 99, closedOn: null, rewardedAt: null };
    store.rename('Undated fixture');
    const analytics = store.analytics({ source: 'ticket', range: 'all' });
    assert.ok(analytics.metrics.undatedXp >= 99);
    assert.equal(analytics.timeline.at(-1).cumulativeXp, analytics.timeline.reduce((sum, row) => sum + row.xp, 0));
});

test('derived revisions stay stable for care but change after same-clock evidence recomputation and mode changes', (t) => {
    const { store } = fixture(t);
    t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 26, 12) });
    store.applyGitHubSync({ identity, records: [pr] });
    const first = store.view({ summary: true }).analyticsRevision;
    store.rename('Metadata only');
    assert.equal(store.view({ summary: true }).analyticsRevision, first);
    store.setGitHubSettings({ repositories: ['fixture/repo'] });
    const scoped = store.view({ summary: true }).analyticsRevision;
    assert.notEqual(scoped, first);
    store.setMode('demo');
    assert.notEqual(store.view({ summary: true }).analyticsRevision, scoped);
});

test('summary payload omits timelines; paginated ranges preserve all-history accumulation and reject stale revisions', async (t) => {
    const { store } = fixture(t);
    const now = Date.UTC(2026, 9, 26, 12);
    t.mock.timers.enable({ apis: ['Date'], now });
    store.applySync({ tickets: [1, 2, 3].map((id) => ({ ...tickets[0], id: String(id), closedOn: new Date(now - (4 - id) * 86400000).toISOString() })) });
    const summary = store.view({ summary: true });
    assert.equal(summary.ticketAnalytics, undefined);
    assert.equal(summary.progress.githubMetrics, undefined);
    assert.equal(summary.github.analytics, undefined);
    assert.equal(summary.github.summary.timeline, undefined);
    const a = store.analytics({ source: 'ticket', range: '7', limit: 1 });
    const b = store.analytics({ source: 'ticket', range: '7', offset: 1, limit: 1, revision: a.revision });
    assert.equal(a.hasMore, true);
    assert.ok(b.timeline[0].cumulativeXp > a.timeline[0].cumulativeXp);
    assert.equal(a.metrics.total, 3);
    store.interact('pet');
    assert.equal(store.view({ summary: true }).analyticsRevision, a.revision);
    store.applySync({ tickets: [...tickets, { ...tickets[0], id: 'new' }] });
    assert.throws(() => store.analytics({ source: 'ticket', revision: a.revision }), /Analytics changed/);
    assert.throws(() => store.analytics({ source: 'ticket', limit: 367 }), /valid source/);
    assert.throws(() => store.analytics({ source: 'github', range: 'invalid' }), /valid source/);
    const server = createBuddyServer({ store, sync: {}, github: { requestRefresh() { assert.fail('Browsing must not sync'); } } });
    t.after(() => server.close());
    const url = await server.urlFor('fixture');
    const html = await (await fetch(url)).text();
    const actualToken = /"token":"([a-f0-9]+)"/.exec(html)[1];
    const base = new URL('/api/analytics?source=ticket&range=all&limit=1', url);
    assert.equal((await fetch(base)).status, 401);
    const headers = { 'x-buddy-token': actualToken };
    assert.equal((await fetch(base, { headers })).status, 200);
    base.searchParams.set('offset', '-1');
    assert.equal((await fetch(base, { headers })).status, 400);
    base.searchParams.set('offset', '0'); base.searchParams.set('revision', 'stale');
    assert.equal((await fetch(base, { headers })).status, 409);
    const exported = await (await fetch(new URL('/api/export', url), { headers })).json();
    assert.equal(Object.values(exported.profiles.live.ledger).find((entry) => entry.id === '123').id, '123');
});
