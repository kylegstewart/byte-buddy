import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubSource } from './github-source.mjs';
import { createGitHubSyncService } from './github-sync.mjs';
import { contributionEvents, githubChallenges, githubAnalytics, githubView, githubScope, githubScopedDerived } from './github.mjs';

const at = '2026-01-01T12:00:00Z';
const now = new Date('2026-01-02T12:00:00Z');
const identity = { login: 'developer', id: 123, host: 'github.com' };
const record = (repo, number = 1, extra = {}) => ({
    id: `${repo.toLowerCase()}#${number}`, repo, number, title: repo,
    url: `https://github.com/${repo}/pull/${number}`, author: identity.login, authorType: 'User',
    state: 'merged', createdAt: at, updatedAt: at, mergedAt: at, closedAt: at,
    additions: 20, deletions: 0, changedFiles: 1, draft: false, bodyPresent: true,
    qualityComplete: true, filesComplete: true, mergerChecked: true, mergerComplete: true,
    mergedBy: identity.login, mergedByType: 'User', reviews: [], comments: [], files: [], ...extra,
});
const profile = (settings, records) => ({ github: { settings, records, identity } });
const queries = (calls) => calls.filter((endpoint) => endpoint.startsWith('/search/')).map((endpoint) => new URL(`https://api.github.com${endpoint}`).searchParams.get('q'));
function transport({ search = () => ({ items: [], total_count: 0, incomplete_results: false }), user = identity } = {}) {
    const calls = [];
    return { calls, request: async (endpoint) => {
        calls.push(endpoint);
        if (endpoint === '/user') return { ...user, type: 'User' };
        if (endpoint.startsWith('/search/')) return search(endpoint);
        throw new Error(`Unexpected endpoint: ${endpoint}`);
    } };
}

test('explicit union canonicalizes organization and repository qualifiers and eliminates covered repositories', async () => {
    const f = transport();
    const result = await createGitHubSource(f).fetchActivity({ organizations: ['Team', 'TEAM'], repositories: ['Team/covered', 'Other/Project', 'other/project'] });
    assert.equal(result.complete, true);
    assert.equal(queries(f.calls).length, 6);
    assert.equal(queries(f.calls).filter((q) => q.includes(' org:team ')).length, 3);
    assert.equal(queries(f.calls).filter((q) => q.includes(' repo:other/project ')).length, 3);
    assert.ok(queries(f.calls).every((q) => !q.includes('repo:team/covered')));
    assert.equal(result.scopeFingerprint, githubScope({ organizations: ['team'], repositories: ['team/covered', 'other/project'] }).fingerprint);
});

test('empty selection never authenticates or requests and preserves retained evidence', async () => {
    const f = transport();
    const records = { old: record('old/project') };
    const result = await createGitHubSource(f).fetchActivity({ identity, records });
    assert.equal(result.paused, true);
    assert.equal(result.reason, 'empty_scope');
    assert.equal(result.records[0], records.old);
    assert.deepEqual(f.calls, []);
});

test('invalid organization scopes fail without any requests', async () => {
    for (const organizations of ['team', [null], ['team repo:other/project'], ['../team'], ['']]) {
        const f = transport();
        await assert.rejects(createGitHubSource(f).fetchActivity({ organizations }), { code: 'github_invalid_scope' });
        assert.deepEqual(f.calls, []);
    }
});

test('org discovery rejects incorrectly scoped search results and keeps cached outside evidence untouched', async () => {
    const retained = record('old/project');
    const f = transport({ search: () => ({ total_count: 1, incomplete_results: false, items: [{
        number: 1, repository_url: 'https://api.github.com/repos/outsider/project', pull_request: {}, user: { login: identity.login },
    }] }) });
    const result = await createGitHubSource(f).fetchActivity({ identity, organizations: ['team'], records: [retained] });
    assert.equal(result.complete, false);
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].id, retained.id);
    assert.ok(f.calls.every((endpoint) => !endpoint.startsWith('/repos/')));
});

test('version 4 union checkpoint resumes and organization changes restart full history', async () => {
    const f = transport({ search: () => ({ total_count: 0, incomplete_results: true, items: [] }) });
    const first = await createGitHubSource(f).fetchActivity({ organizations: ['Team'] });
    const cursor = JSON.parse(first.cursor);
    assert.equal(cursor.version, 4);
    assert.deepEqual(cursor.organizations, ['team']);
    assert.equal(cursor.scopeFingerprint, first.scopeFingerprint);
    const resumedTransport = transport();
    const resumed = await createGitHubSource(resumedTransport).fetchActivity({ identity, organizations: ['TEAM'], cursor: first.cursor });
    assert.equal(resumed.watermark, first.watermark);
    assert.equal(resumed.warnings.length, 0);
    const changedTransport = transport();
    const changed = await createGitHubSource(changedTransport).fetchActivity({ identity, organizations: ['Other'], cursor: first.cursor, lastSync: { at } });
    assert.ok(changed.warnings.some((warning) => warning.includes('changed scope')));
    assert.ok(queries(changedTransport.calls).every((q) => q.includes('org:other') && !q.includes('updated:')));
    const incrementalTransport = transport();
    await createGitHubSource(incrementalTransport).fetchActivity({ identity, organizations: ['other'], lastSync: { at, discoveryVersion: 3, scopeFingerprint: first.scopeFingerprint } });
    assert.ok(queries(incrementalTransport.calls).every((q) => !q.includes('updated:')));
});

test('explicit selection still pins the numeric authenticated account', async () => {
    const f = transport({ user: { ...identity, id: 456 } });
    await assert.rejects(createGitHubSource(f).fetchActivity({ identity, organizations: ['team'] }), { code: 'github_identity_mismatch' });
    assert.equal(queries(f.calls).length, 0);
});

test('views derive scope before events, caps, challenges, analytics, recent activity and coverage', () => {
    const records = [record('outside/project', 1, { state: 'closed', mergedAt: null, mergerComplete: false }),
        record('Team/Project', 2), record('other/project', 3), record('outside/project', 4, { mergerComplete: false })];
    const p = profile({ organizations: ['TEAM'], repositories: ['OTHER/PROJECT'] }, records);
    const career = { events: contributionEvents(records, identity, undefined, now), analytics: {} };
    career.challenges = githubChallenges(career.events, [], now);
    career.analytics.all = githubAnalytics(career.events, records, identity, career.challenges.completions, 'all', now);
    const before = JSON.stringify({ p, career });
    const view = githubView(p, [], now, career);
    assert.equal(view.coverage.discovered, 2);
    assert.equal(view.coverage.unknownMerger, 0);
    assert.equal(view.summary.authoredMerged, 2);
    assert.equal(view.summary.mergeRate, 1);
    assert.equal(view.summary.unknownMerger, 0);
    assert.ok(view.events.every((event) => !event.repo.startsWith('outside/')));
    assert.ok(view.recent.every((event) => !event.repo.startsWith('outside/')));
    for (const value of Object.values(view.analytics)) assert.equal(value.authoredMerged, 2);
    assert.equal(JSON.stringify({ p, career }), before, 'View derivation never changes career data or rewards.');
    const derived = githubScopedDerived(p, [], now);
    assert.deepEqual(githubView(p, [], now, derived).summary, view.summary);
    p.github.settings = { organizations: [], repositories: [] };
    const retained = githubView(p, [], now, career);
    assert.equal(retained.events, career.events);
    assert.equal(retained.coverage.discovered, 4);
    assert.equal(retained.summary.authoredMerged, 3);
    assert.equal(githubView(p, [], now, derived).summary.authoredMerged, 3, 'Clearing selection also discards old scoped derivation.');
});

test('daily caps are applied after scope filtering without changing canonical award IDs', () => {
    const records = Array.from({ length: 30 }, (_, i) => record('outside/project', i + 1));
    records.push(record('team/project', 1));
    const career = contributionEvents(records, identity, undefined, now);
    const view = githubView(profile({ organizations: ['team'], repositories: [] }, records), [], now);
    const careerSelected = career.filter((event) => event.repo === 'team/project');
    assert.ok(view.events.reduce((sum, event) => sum + event.xp, 0) > careerSelected.reduce((sum, event) => sum + event.xp, 0));
    assert.deepEqual(view.events.map((event) => event.id), careerSelected.map((event) => event.id));
});

test('scoped challenges cannot inherit career completions from excluded repositories', () => {
    const records = Array.from({ length: 5 }, (_, i) => record('outside/project', i + 1));
    records.push(record('team/project', 6));
    const p = profile({ organizations: ['team'], repositories: [] }, records);
    const events = contributionEvents(records, identity, undefined, now);
    const career = { events, challenges: githubChallenges(events, [], now), analytics: {} };
    assert.ok(career.challenges.completions.some((row) => row.challengeId === 'gh-merge-master'));
    const view = githubView(p, [], now, career);
    assert.ok(!view.challenges.completions.some((row) => row.challengeId === 'gh-merge-master'));
    assert.equal(view.summary.authoredMerged, 1);
});

function syncFixture(settings = { organizations: ['team'], repositories: [] }) {
    const gh = { identity, settings, records: {}, lastSync: null, cursor: null };
    const applied = [], failures = [], runtime = [];
    const store = {
        load: () => ({ profiles: { live: { github: gh } } }), setRuntime: (value) => runtime.push(value),
        applyGitHubSync: (value) => { applied.push(value); return { synced: true }; },
        recordGitHubFailure: (message, value) => { failures.push(value); gh.lastAttempt = { ok: false, ...value }; },
    };
    return { gh, store, applied, failures, runtime };
}

test('sync remains manual only, forwards union scope, and empty scope preserves persistent cooldown', async () => {
    const f = syncFixture();
    let calls = 0;
    const service = createGitHubSyncService({ store: f.store, now: () => 1000, source: { fetchActivity: async (input) => {
        calls++;
        assert.deepEqual(input.organizations, ['team']);
        assert.deepEqual(input.repositories, []);
        assert.equal(input.identity, identity);
        return { complete: true, processed: 0 };
    } } });
    service.start(); service.syncIfStale();
    assert.equal(calls, 0);
    await service.refresh();
    assert.equal(calls, 1);
    f.gh.lastSync = { retryAt: 9000, pauseReason: 'rate_limit' };
    f.gh.settings = { organizations: [], repositories: [] };
    assert.equal((await service.refresh()).reason, 'empty_scope');
    assert.equal(service.requestRefresh().retryAt, 9000);
    f.gh.settings = { organizations: ['other'], repositories: [] };
    assert.deepEqual(await service.refresh(), { paused: true, retryAt: 9000, reason: 'rate_limit' });
    assert.equal(calls, 1);
});

test('scope changes during a flight reject stale results without erasing a rate-limit deadline', async () => {
    const f = syncFixture();
    const service = createGitHubSyncService({ store: f.store, now: () => 1000, source: { fetchActivity: async () => {
        f.gh.settings = { organizations: ['other'], repositories: [] };
        return { complete: false, retryAt: 9000, pauseReason: 'rate_limit' };
    } } });
    assert.deepEqual(await service.refresh(), { paused: true, reason: 'scope_changed', retryAt: 9000 });
    assert.equal(f.applied.length, 0);
    assert.deepEqual(f.failures, [{ retryAt: 9000, pauseReason: 'rate_limit' }]);
    assert.equal((await service.refresh()).retryAt, 9000);
});
