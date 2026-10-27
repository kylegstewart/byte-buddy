import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { BUDDIES, newEvolution, evolutionView } from './evolution.mjs';
import { createStore, STATE_VERSION } from './store.mjs';
import { createSplitStorage } from './storage.mjs';
import { xpForLevel, SOURCE_IT } from './catalog.mjs';
import { createBuddyServer } from './server.mjs';

const userId = 'evolution-fixture';
function fixture(t, xp = 0, version = STATE_VERSION) {
    const root = fs.mkdtempSync(join(process.cwd(), '.evolution-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const seed = createStore({ root: join(root, 'seed'), userId });
    const raw = seed.exportState();
    raw.version = version;
    raw.profiles.live.migrationXp = xp;
    if (version === 3) for (const profile of Object.values(raw.profiles)) delete profile.evolution;
    const target = join(root, 'target');
    const store = createStore({ root: target, userId });
    fs.mkdirSync(dirname(store.legacyFile), { recursive: true });
    const original = JSON.stringify(raw);
    fs.writeFileSync(store.legacyFile, original);
    return { root, target, raw, store, original, restart: () => createStore({ root: target, userId }) };
}
const change = (store, action, type = 'robot', stage) => {
    const view = store.view({ summary: true });
    return store.evolve({ action, type, stage, mode: view.mode, revision: view.evolution.revision });
};
const code = (value) => (error) => error.code === value;

test('all five lines use the approved costs and legacy credit matrix', () => {
    assert.deepEqual(BUDDIES.map((b) => b.id), ['robot', 'cat', 'dog', 'dragon', 'slime']);
    for (const [index, bonus] of [0, 5000, 20000, 50000, 100000].entries()) {
        const e = evolutionView(newEvolution(123, index + 1), 123);
        assert.equal(e.balance, 123 + bonus);
        assert.equal(e.legacyCredit, bonus);
        for (const type of e.types) {
            assert.equal(type.stages.length, 5);
            assert.deepEqual(type.stages.map((s) => s.cost), [0, 5000, 15000, 30000, 50000]);
            assert.deepEqual(e.buddies[type.id], { owned: 1, selected: 1, spent: 0 });
        }
    }
});

test('legacy stages 1–5 reset once with retroactive XP and equivalent credit; original bytes stay immutable', (t) => {
    for (const [index, level] of [1, 5, 15, 30, 45].entries()) {
        const xp = xpForLevel(level);
        const f = fixture(t, xp, 3);
        const view = f.store.view();
        assert.equal(view.progress.xp, xp);
        assert.equal(view.progress.level, level);
        assert.equal(view.progress.stage, 1);
        assert.equal(view.evolution.legacyStage, index + 1);
        assert.equal(view.evolution.balance, xp + [0, 5000, 20000, 50000, 100000][index]);
        assert.deepEqual(f.restart().view().evolution, view.evolution);
        f.store.rename('Shared'); f.store.interact('pet');
        assert.equal(fs.readFileSync(f.store.legacyFile, 'utf8'), f.original);
    }
});

test('version-3 split migration preserves evidence refs, XP, awards, unlocks, care and original; rollback is current', (t) => {
    const f = fixture(t, 150000);
    f.store.applySync({ tickets: [{ id: '123', assignedTo: userId, isOpen: false, isIssue: true, closedOn: '2026-01-06T12:00:00Z' }], complete: true });
    f.store.rename('Preserved'); f.store.interact('pet');
    const expected = f.store.view();
    const raw = f.store.exportState();
    raw.version = 3;
    for (const profile of Object.values(raw.profiles)) delete profile.evolution;
    const sourceManifest = JSON.parse(fs.readFileSync(f.store.file, 'utf8'));
    const projections = Object.fromEntries(['live', 'demo'].map((mode) => [mode, JSON.parse(fs.readFileSync(join(dirname(f.store.file), sourceManifest.storage.projections[mode].name), 'utf8'))]));
    const root = join(f.root, 'v3');
    const store = createStore({ root, userId });
    fs.mkdirSync(dirname(store.legacyFile), { recursive: true });
    fs.writeFileSync(store.legacyFile, 'immutable original');
    createSplitStorage(dirname(store.file)).write(raw, projections);
    const before = JSON.parse(fs.readFileSync(store.file, 'utf8'));
    const view = store.view();
    const after = JSON.parse(fs.readFileSync(store.file, 'utf8'));
    assert.equal(after.version, STATE_VERSION);
    assert.deepEqual(after.storage.evidence, before.storage.evidence);
    assert.equal(view.progress.xp, expected.progress.xp);
    assert.equal(view.progress.level, expected.progress.level);
    assert.deepEqual(view.achievements, expected.achievements);
    assert.deepEqual(view.catalog, expected.catalog);
    assert.equal(view.name, expected.name);
    assert.deepEqual(view.care, expected.care);
    const exported = store.exportState();
    for (const mode of ['live', 'demo']) for (const key of ['ledger', 'github', 'unlocked', 'achievements', 'challengeKeys', 'migrationXp', 'treatsEarned', 'treatsSpent']) assert.deepEqual(exported.profiles[mode][key], JSON.parse(JSON.stringify(raw.profiles[mode][key])), `${mode}.${key}`);
    change(store, 'upgrade', 'cat');
    const rollback = JSON.parse(fs.readFileSync(store.exportRollback(), 'utf8'));
    assert.equal(rollback.profiles.live.evolution.buddies.cat.owned, 2);
    assert.equal(rollback.profiles.live.evolution.buddies.cat.spent, 5000);
    assert.equal(fs.readFileSync(store.legacyFile, 'utf8'), 'immutable original');
    assert.deepEqual(createStore({ root, userId }).view().evolution, store.view().evolution);
});

test('all 20 upgrades share credits; spending never lowers XP/level; owned display and full refund survive restart', (t) => {
    const f = fixture(t, 500000);
    const initial = f.store.view();
    const manifest = JSON.parse(fs.readFileSync(f.store.file, 'utf8'));
    for (const type of BUDDIES) {
        change(f.store, 'switch', type.id);
        for (let stage = 2; stage <= 5; stage++) {
            change(f.store, 'upgrade', type.id);
            assert.equal(f.store.view().evolution.buddies[type.id].owned, stage);
        }
        assert.throws(() => change(f.store, 'upgrade', type.id), code('fully_evolved'));
        change(f.store, 'select', type.id, 1);
        assert.equal(f.store.view().progress.stage, 1);
    }
    const view = f.store.view();
    assert.equal(view.evolution.available, 0);
    assert.equal(view.evolution.spent, 500000);
    assert.equal(view.progress.xp, initial.progress.xp);
    assert.equal(view.progress.level, initial.progress.level);
    assert.equal(view.analyticsRevision, initial.analyticsRevision);
    const after = JSON.parse(fs.readFileSync(f.store.file, 'utf8'));
    assert.deepEqual(after.storage.evidence, manifest.storage.evidence);
    assert.deepEqual(after.storage.projections, manifest.storage.projections);
    const restored = f.restart();
    assert.deepEqual(restored.view().evolution, view.evolution);
    assert.equal(change(restored, 'reset').refunded, 500000);
    assert.equal(restored.view().evolution.available, 500000);
    assert.equal(change(restored, 'reset').refunded, 0);
    assert.ok(restored.view().celebrations.every((c) => c.type !== 'evolution'));
});

test('insufficient credits, forged/stale requests and cross-mode purchases cannot mutate the wallet', (t) => {
    const { store, restart } = fixture(t, 5000);
    const old = store.view().evolution.revision;
    change(store, 'upgrade', 'cat');
    assert.throws(() => store.evolve({ action: 'upgrade', type: 'cat', revision: old, mode: 'live' }), code('evolution_changed'));
    const before = store.view().evolution;
    assert.throws(() => change(store, 'upgrade', 'dog'), code('insufficient_credits'));
    assert.throws(() => change(store, 'select', 'cat', 3), code('stage_locked'));
    assert.throws(() => change(store, 'select', 'cat', 1.5), code('stage_locked'));
    assert.throws(() => change(store, 'switch', '__proto__'), code('invalid_buddy'));
    assert.throws(() => change(store, 'grant', 'cat'), code('invalid_evolution'));
    assert.deepEqual(restart().view().evolution, before);
    store.setMode('demo');
    assert.throws(() => store.evolve({ action: 'reset', revision: before.revision, mode: 'live' }), code('evolution_changed'));
    store.simulateDemoTicket('critical', 20);
    change(store, 'upgrade', 'dragon');
    store.setMode('live');
    assert.deepEqual(store.view().evolution, before);
    assert.equal(store.view().evolution.buddies.dragon.owned, 1);
});

test('XP corrections preserve purchased stages, create debt and cannot mint credits on reopen/reclose', (t) => {
    const f = fixture(t);
    const raw = f.raw;
    raw.profiles.live.ledger[`${SOURCE_IT}:900`] = { id: '900', source: SOURCE_IT, title: 'Fixture', kind: 'normal', xp: 20000, status: 'rewarded', rewardedAt: '2026-01-06T12:00:00Z', closedOn: '2026-01-06T12:00:00Z' };
    fs.writeFileSync(f.store.legacyFile, JSON.stringify(raw));
    change(f.store, 'upgrade', 'cat'); change(f.store, 'upgrade', 'cat');
    const original = f.store.view().evolution;
    const sync = (isOpen) => f.store.applySync({ tickets: [{ id: '900', isIssue: false, isOpen, assignedTo: userId, closedOn: '2026-01-06T12:00:00Z' }], complete: true });
    for (let i = 0; i < 3; i++) {
        sync(true);
        const e = f.store.view().evolution;
        assert.equal(e.buddies.cat.owned, 3);
        assert.equal(e.available, 0);
        assert.ok(e.deficit > 0);
        assert.throws(() => change(f.store, 'upgrade', 'dog'), code('insufficient_credits'));
        sync(false);
        assert.equal(f.store.view().evolution.balance, original.balance);
    }
    sync(true);
    assert.equal(change(f.store, 'reset').refunded, 20000);
    assert.equal(f.store.view().evolution.spent, 0);
    assert.equal(f.store.view().evolution.deficit, 0);
});

test('failed atomic publish rolls back spending, selected buddy, revision and celebration', (t) => {
    const { store, restart } = fixture(t, 5000);
    const before = store.view().evolution;
    const prior = fs.readFileSync(store.file, 'utf8');
    const rename = fs.renameSync;
    fs.renameSync = () => { throw new Error('fixture publish failure'); };
    syncBuiltinESMExports();
    try { assert.throws(() => change(store, 'upgrade', 'dog'), /fixture publish failure/); }
    finally { fs.renameSync = rename; syncBuiltinESMExports(); }
    assert.deepEqual(store.view().evolution, before);
    assert.equal(fs.readFileSync(store.file, 'utf8'), prior);
    assert.deepEqual(restart().view().evolution, before);
    assert.equal(change(store, 'upgrade', 'dog').evolution.available, 0);
});

test('evolution HTTP API is authenticated and returns current wallet without a GitHub refresh', async (t) => {
    const { store } = fixture(t, 5000);
    let refreshes = 0;
    const server = createBuddyServer({ store, sync: {}, github: { requestRefresh() { refreshes++; } } });
    t.after(() => server.close());
    const page = await server.urlFor('fixture');
    const html = await (await fetch(page)).text();
    const config = JSON.parse(html.match(/window\.BUDDY_CONFIG\s*=\s*(\{[^;]+\})/)[1]);
    const url = new URL(page).origin;
    const body = { action: 'upgrade', type: 'cat', mode: 'live', revision: store.view().evolution.revision };
    const denied = await fetch(`${url}/api/evolution`, { method: 'POST', body: JSON.stringify(body) });
    assert.equal(denied.status, 401);
    const response = await fetch(`${url}/api/evolution`, { method: 'POST', headers: { 'x-buddy-token': config.token }, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).result.evolution.active, 'cat');
    const repeated = await fetch(`${url}/api/evolution`, { method: 'POST', headers: { 'x-buddy-token': config.token }, body: JSON.stringify(body) });
    assert.equal(repeated.status, 400);
    assert.equal(store.view().evolution.spent, 5000);
    assert.equal(refreshes, 0);
});

