import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ECONOMY } from './economy.mjs';
import { ACHIEVEMENTS, CHALLENGES, ITEMS, REWARDS, SOURCE_IT, levelCost, levelForXp, stageForLevel, xpForLevel } from './catalog.mjs';
import { contributionEvents, githubAnalytics, githubChallenges, inspectPR, utcDay, utcWeek } from './github.mjs';
import { createStore, STATE_VERSION } from './store.mjs';

// No source adapters, server, extension entrypoint, network calls, or personal save files.
// Scratch roots are unique project-local directories, removed even when assertions fail.
const here = dirname(fileURLToPath(import.meta.url));
const identity = { login: 'fixture-dev', id: 900001, host: 'github.com' };
const userId = 'progression-fixture';
const now = new Date('2026-02-20T18:00:00.000Z');
const at = '2026-01-06T12:00:00.000Z';
const mergedAt = '2026-01-06T15:00:00.000Z';
const reviewAt = '2026-01-06T14:00:00.000Z';
const approved = (extra = {}) => ({
    id: 'review-1', author: 'fixture-peer', authorType: 'User',
    submittedAt: reviewAt, state: 'APPROVED', body: 'Looks good.', commitId: 'head-1', ...extra,
});
const comment = (extra = {}) => ({
    id: 'comment-1', author: 'fixture-peer', authorType: 'User', createdAt: reviewAt,
    path: 'src/example.js', reviewId: 'review-1', body: 'Please fix the missing null guard.', ...extra,
});
const pr = (number = 1, extra = {}) => ({
    id: `fixture/repo#${number}`, repo: 'fixture/repo', number, title: `Fixture PR ${number}`,
    url: `https://github.com/fixture/repo/pull/${number}`,
    author: identity.login, authorType: 'User', state: 'merged', draft: false,
    createdAt: at, updatedAt: mergedAt, mergedAt, closedAt: mergedAt,
    additions: 80, deletions: 20, changedFiles: 2, bodyPresent: true,
    headCommitId: 'head-1', qualityComplete: true, filesComplete: true, reviews: [approved()], comments: [],
    files: [{ path: 'src/example.js' }], ...extra,
});
const reviewedPr = (number = 1, extra = {}) => pr(number, {
    author: 'fixture-colleague', state: 'open', mergedAt: null, closedAt: null,
    reviews: [approved({ author: identity.login })], ...extra,
});
const recordsOf = (records) => Object.fromEntries(records.map((record) => [record.id, record]));
const eventsOf = (records) => contributionEvents(recordsOf(records), identity);
const kindsOf = (records) => eventsOf(records).map((event) => event.kind);
const challenge = (result, id) => result.rows.find((row) => row.id === id);
const ticket = (extra = {}) => ({
    id: 'ticket-fixture', title: 'Synthetic normal ticket', isIssue: false, isOpen: false,
    assignedTo: userId, closedOn: '2026-01-06T12:00:00.000Z',
    createdOn: '2026-01-05T12:00:00.000Z', ...extra,
});
function isolatedStore(t) {
    const root = mkdtempSync(join(here, '.progression-test-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    return { root, store: createStore({ root, userId }), restart: () => createStore({ root, userId }) };
}
const sync = (store, records, extra = {}) => store.applyGitHubSync({ identity, records, complete: true, ...extra });
const errorCode = (code) => (error) => error.code === code;

test('GitHub rebalance retains 75 percent of configured awards and caps, including challenge XP', () => {
    const original = { opened: 10, merged: 120, reviewed: 50, constructive: 25, helpful: 25, clean: 30,
        firstPass: 15, focused: 20, complex: 30, readiness: 5, responsive: 10, turnaround: 10, documentation: 10, tests: 15 };
    for (const [key, value] of Object.entries(original)) assert.equal(ECONOMY.github[key], Math.round(value * .75), key);
    for (const [key, value] of Object.entries({ opened: 30, merged: 600, reviewed: 200, bonus: 150, total: 850 })) {
        assert.equal(ECONOMY.github.dailyCaps[key], Math.round(value * .75), key);
    }
    const oldChallenges = { daily: 30, mergeWeek: 150, quality: 100, reviews: 100, constructive: 150,
        cleanStreak: 100, consistency: 200, improvement: 150, balanced: 100, focused: 100, team: 150 };
    for (const [rule, value] of Object.entries(oldChallenges)) {
        assert.equal(CHALLENGES.find((c) => c.category === 'github' && c.rule === rule).xp, Math.round(value * .75), rule);
    }
    assert.equal(ECONOMY.github.minLines, 5);
    assert.equal(ECONOMY.github.reviewBodyMinLength, 40);
    assert.equal(REWARDS.normal.xp, 100);
    assert.equal(REWARDS.hd.xp, 200);
    assert.equal(REWARDS.critical.xp, 400);
});

test('authored merged and personally merged are explicit overlapping roles, never duplicate XP or quality', () => {
    const merger = { mergedBy: identity.login.toUpperCase(), mergedByType: 'User', mergerComplete: true };
    const records = [
        pr(1, { mergedBy: 'fixture-peer', mergedByType: 'User', mergerComplete: true }),
        pr(2, merger),
        pr(3, { ...merger, author: 'fixture-colleague' }),
        pr(4),
    ];
    const events = eventsOf(records);
    const baseline = eventsOf(records.map(({ mergedBy, mergedByType, mergerComplete, ...record }) => record));
    assert.deepEqual(events.filter((e) => e.kind !== 'mergedBy'), baseline);
    const roles = events.filter((e) => e.kind === 'mergedBy');
    assert.equal(roles.length, 2);
    assert.ok(roles.every((e) => e.dataOnly && e.xp === 0 && e.rawXp === 0 && !e.quality));
    assert.equal(roles.find((e) => e.prId.endsWith('#2')).reviewedMerge, false, 'Self-merges cannot earn release challenge XP.');
    const metrics = githubAnalytics(events, recordsOf(records), identity, [], 'all', now);
    assert.equal(metrics.merged, 3);
    assert.equal(metrics.authoredMerged, 3);
    assert.equal(metrics.mergedBy, 2);
    assert.equal(metrics.unknownMerger, 1);
    assert.equal(metrics.qualitySample, 3);
    assert.equal(metrics.timeline[0].authoredMerged, 3);
    assert.equal(metrics.timeline[0].mergedBy, 2);
    assert.equal(metrics.timeline[0].baseXp, metrics.baseXp);
    assert.equal(metrics.timeline[0].bonusXp, 0);
    const recent = githubAnalytics(events, recordsOf(records), identity, [], '7', now);
    assert.equal(recent.authoredMerged, 0);
    assert.equal(recent.mergedBy, 0);
});

test('merger attribution is unknown unless verified, and role-only events cannot consume XP caps or quality', () => {
    for (const patch of [{ mergedBy: identity.login }, { mergedBy: identity.login, mergerComplete: false },
        { mergedBy: 'someone-else', mergerComplete: true }, { mergedBy: identity.login, mergedByType: 'Bot', mergerComplete: true }]) {
        assert.equal(kindsOf([pr(1, patch)]).includes('mergedBy'), false);
    }
    const others = Array.from({ length: 30 }, (_, i) => pr(i + 1, { author: 'fixture-colleague', mergedBy: identity.login,
        mergedByType: 'User', mergerComplete: true, reviews: [] }));
    const events = eventsOf(others);
    assert.equal(events.length, 30);
    assert.equal(events.reduce((sum, event) => sum + event.xp, 0), 0);
    const metrics = githubAnalytics(events, recordsOf(others), identity, [], 'all', now);
    assert.equal(metrics.mergedBy, 30);
    assert.equal(metrics.authoredMerged, 0);
    assert.equal(metrics.qualitySample, 0);
    assert.equal(metrics.cleanRate, null);
    assert.equal(metrics.repositories, 0, 'Release roles are not authored/review contribution evidence.');
    assert.equal(githubChallenges(events, [], now).completions.length, 0);
});

test('new evidence-based GitHub challenges use deterministic historical completion dates and IDs', () => {
    const own = Array.from({ length: 10 }, (_, i) => pr(i + 1, {
        mergedAt: new Date(Date.UTC(2026, 0, 6 + i, 15)).toISOString(),
        files: [{ path: 'tests/example.test.js' }, { path: 'docs/example.md' }],
    }));
    const released = Array.from({ length: 5 }, (_, i) => pr(i + 20, { author: 'fixture-colleague', mergedBy: identity.login,
        mergedByType: 'User', mergerComplete: true, mergedAt: new Date(Date.UTC(2026, 0, 6 + i, 15)).toISOString() }));
    const events = eventsOf([...own, ...released]);
    const result = githubChallenges(events, [], now);
    for (const [id, date] of [['gh-test-builder', own[9].mergedAt], ['gh-documentarian', own[4].mergedAt], ['gh-release-steward', released[4].mergedAt]]) {
        const completion = result.completions.find((c) => c.challengeId === id);
        assert.equal(completion.id, `${id}:once`);
        assert.equal(completion.at, date);
        assert.ok(completion.xp > 0);
    }
    assert.deepEqual(githubChallenges([...events].reverse(), [], now), result);
    const noFiles = eventsOf(own.map((record) => ({ ...record, filesComplete: false })));
    assert.equal(githubChallenges(noFiles, [], now).completions.some((c) => ['gh-test-builder', 'gh-documentarian'].includes(c.challengeId)), false);
});

test('all medals have tier/category metadata and care or combined milestones are not mislabeled as tickets', () => {
    for (const achievement of ACHIEVEMENTS) {
        assert.ok(['Bronze', 'Silver', 'Gold', 'Platinum'].includes(achievement.tier), achievement.id);
        assert.ok(['ticket', 'github', 'care', 'overall'].includes(achievement.category), achievement.id);
    }
    for (const id of ['best-friends', 'snack-attack', 'playmate']) assert.equal(ACHIEVEMENTS.find((a) => a.id === id).category, 'care');
    for (const id of ['challenger', 'completionist', 'maxed-out', 'veteran', 'gh-rounded']) assert.equal(ACHIEVEMENTS.find((a) => a.id === id).category, 'overall');
});

test('new ticket challenges and achievements replay without duplicate treats or changed base rewards', (t) => {
    const { store, restart } = isolatedStore(t);
    const tickets = Array.from({ length: 30 }, (_, i) => ticket({
        id: `new-ticket-${i}`, requester: `requester-${i % 6}`, isIssue: i >= 10,
        severity: i >= 20 ? 3 : 1, difficulty: 3,
        closedOn: new Date(2026, 0, 1 + i, 12).toISOString(),
    }));
    store.applySync({ tickets: [...tickets].reverse(), complete: true });
    const first = store.view();
    for (const id of ['development-ten', 'support-ten', 'critical-five', 'problem-solver', 'monthly-network', 'versatile-month']) {
        assert.equal(first.challenges.find((c) => c.id === id).count, 1, id);
    }
    assert.equal(first.progress.ticketXp, 10 * 100 + 10 * 200 + 10 * 400);
    const medal = first.achievements.find((a) => a.id === 'ticket-critical-5');
    assert.equal(medal.unlockedAt, tickets[24].closedOn);
    const earned = store.load().profiles.live.treatsEarned;
    store.applySync({ tickets, complete: true });
    assert.equal(store.load().profiles.live.treatsEarned, earned);
    const restored = restart();
    assert.deepEqual(restored.view().progress, first.progress);
    restored.applySync({ tickets: [{ ...tickets[24], isOpen: true }], complete: false });
    restored.applySync({ tickets: [tickets[24]], complete: false });
    assert.equal(restored.load().profiles.live.treatsEarned, earned);
    assert.equal(restored.view().achievements.find((a) => a.id === 'ticket-critical-5').unlockedAt, medal.unlockedAt);
});

test('cached GitHub rebalance can lower level without revoking permanently earned unlocks', (t) => {
    const { store, restart } = isolatedStore(t);
    sync(store, [pr()]);
    const profile = store.load().profiles.live;
    profile.unlocked.push('body-obsidian', 'neck-chain');
    profile.achievements['maxed-out'] = '2025-01-01T12:00:00Z';
    profile.levelSeen = 50;
    // Persist deliberately edited fixture metadata through the normal hot-state commit.
    store.rename(store.view().name);
    const restored = restart();
    const view = restored.view();
    assert.ok(view.progress.level < 50);
    assert.ok(restored.load().profiles.live.unlocked.includes('body-obsidian'));
    assert.ok(restored.load().profiles.live.unlocked.includes('neck-chain'));
    assert.equal(view.achievements.find((a) => a.id === 'maxed-out').unlockedAt, '2025-01-01T12:00:00Z');
    assert.equal(view.progress.githubBaseXp, eventsOf([pr()]).reduce((sum, e) => sum + e.xp, 0));
    assert.equal(restored.load().profiles.live.treatsEarned, profile.treatsEarned);
});

test('catalog curve matches configured economy at every level boundary and evolution threshold', () => {
    assert.deepEqual(REWARDS, {
        normal: { xp: 100, treats: 1, label: 'Ticket closed' },
        hd: { xp: 200, treats: 2, label: 'Help Desk issue resolved' },
        critical: { xp: 400, treats: 3, label: 'Critical production issue resolved' },
    });
    for (let level = 1; level <= 55; level++) {
        assert.equal(levelCost(level), ECONOMY.levels.base + ECONOMY.levels.step * (level - 1));
        assert.equal(xpForLevel(level + 1) - xpForLevel(level), levelCost(level));
        assert.equal(levelForXp(xpForLevel(level)), level);
        assert.equal(levelForXp(xpForLevel(level + 1) - 1), level);
    }
    for (const [level, stage] of [[1, 1], [4, 1], [5, 2], [14, 2], [15, 3], [30, 4], [45, 5]]) {
        assert.equal(stageForLevel(level), stage);
    }
});

test('catalog integrates unique GitHub IDs and valid achievement reward item references', () => {
    for (const entries of [ACHIEVEMENTS, CHALLENGES, ITEMS]) {
        assert.equal(new Set(entries.map((entry) => entry.id)).size, entries.length);
    }
    assert.equal(CHALLENGES.filter((entry) => entry.category === 'github').length, 17);
    assert.ok(ACHIEVEMENTS.some((entry) => entry.id === 'gh-merge-1'));
    const itemIds = new Set(ITEMS.map((item) => item.id));
    for (const entry of ACHIEVEMENTS) for (const reward of entry.rewards) assert.ok(itemIds.has(reward), reward);
});

test('verified authored merge earns expected base/quality events but no review XP', () => {
    const record = pr();
    const quality = inspectPR(record, identity.login.toUpperCase());
    assert.equal(quality.authored, true);
    assert.equal(quality.sampled, true);
    assert.equal(quality.clean, true);
    assert.deepEqual(kindsOf([record]).sort(), ['opened', 'merged', 'focused', 'clean', 'firstPass', 'readiness', 'turnaround'].sort());
    const events = eventsOf([record]);
    assert.equal(events.find((event) => event.kind === 'merged').xp, ECONOMY.github.merged);
    assert.equal(events.find((event) => event.kind === 'opened').id, 'fixture/repo#1:opened');
});

test('closed-unmerged PR receives opened XP only; draft/tiny/empty changes receive none', () => {
    assert.deepEqual(kindsOf([pr(1, { state: 'closed', mergedAt: null })]), ['opened']);
    for (const patch of [
        { draft: true }, { additions: 2, deletions: 2 }, { changedFiles: 0 },
    ]) assert.deepEqual(eventsOf([pr(1, patch)]), []);
    assert.equal(kindsOf([pr(1, { bodyPresent: false })]).includes('opened'), false);
});

test('bot-authored PRs, self-reviews, bot reviews, and ordinary comments cannot farm review XP', () => {
    assert.deepEqual(eventsOf([pr(1, { authorType: 'Bot' })]), []);
    assert.equal(kindsOf([pr(1, { reviews: [approved({ author: identity.login })] })]).includes('reviewed'), false);
    for (const patch of [
        { author: 'dependabot[bot]', authorType: 'Bot' },
        { author: 'copilot', authorType: 'User' },
        { reviews: [approved({ author: identity.login, authorType: 'Bot' })] },
        { reviews: [approved({ author: 'another-peer' })], comments: [comment({ author: identity.login })] },
    ]) assert.equal(kindsOf([reviewedPr(1, patch)]).includes('reviewed'), false);
});

test('human external reviews are deduplicated per PR; short comments require linked actionable inline evidence', () => {
    const own = approved({ author: identity.login });
    assert.equal(eventsOf([reviewedPr(1, { reviews: [own, { ...own, id: 'review-2' }] })]).filter((e) => e.kind === 'reviewed').length, 1);
    const short = { ...own, state: 'COMMENTED', body: 'LGTM' };
    assert.deepEqual(eventsOf([reviewedPr(1, { reviews: [short] })]), []);
    const long = { ...short, body: 'I checked the error handling and verified the retry behavior in this implementation.' };
    assert.ok(kindsOf([reviewedPr(1, { reviews: [long] })]).includes('reviewed'));
    const inline = comment({ author: identity.login });
    assert.ok(kindsOf([reviewedPr(1, { reviews: [short], comments: [inline] })]).includes('constructive'));
    assert.deepEqual(eventsOf([reviewedPr(1, { reviews: [short], comments: [{ ...inline, reviewId: 'unrelated' }] })]), []);
});

for (const [label, patch] of [
    ['no reviews', { reviews: [] }],
    ['incomplete snapshot', { qualityComplete: false }],
    ['comment-only decision', { reviews: [approved({ state: 'COMMENTED' })] }],
    ['bot-only approval', { reviews: [approved({ author: 'fixture-bot[bot]', authorType: 'Bot' })] }],
    ['self approval', { reviews: [approved({ author: identity.login })] }],
    ['post-merge approval', { reviews: [approved({ submittedAt: '2026-01-06T16:00:00.000Z' })] }],
]) {
    test(`${label}: unknown review evidence is never counted as verified clean`, () => {
        const record = pr(1, patch);
        const quality = inspectPR(record, identity.login);
        assert.equal(quality.sampled, false);
        assert.equal(quality.clean, false);
        assert.equal(kindsOf([record]).includes('clean'), false);
        assert.equal(kindsOf([record]).includes('firstPass'), false);
        const analytics = githubAnalytics(eventsOf([record]), recordsOf([record]), identity, [], 'all', now);
        assert.equal(analytics.unknownQuality, 1);
        assert.equal(analytics.qualitySample, 0);
        assert.equal(analytics.cleanRate, null);
    });
}

test('human change requests count findings and distinct review commits, not a clean first pass', () => {
    const record = pr(1, { reviews: [
        approved({ id: 'r1', state: 'CHANGES_REQUESTED', commitId: 'c1', submittedAt: '2026-01-06T12:30:00.000Z' }),
        approved({ id: 'r2', state: 'CHANGES_REQUESTED', commitId: 'c1', submittedAt: '2026-01-06T13:00:00.000Z' }),
        approved({ id: 'r3', state: 'CHANGES_REQUESTED', commitId: 'c2', submittedAt: '2026-01-06T13:30:00.000Z' }),
        approved({ id: 'r4' }),
    ] });
    const quality = inspectPR(record, identity.login);
    assert.equal(quality.sampled, true);
    assert.equal(quality.approved, true);
    assert.equal(quality.findings, 3);
    assert.equal(quality.iterations, 2);
    assert.equal(quality.clean, false);
    assert.equal(kindsOf([record]).includes('firstPass'), false);
    const blocked = inspectPR(pr(2, { reviews: [approved(), approved({ author: 'other', state: 'CHANGES_REQUESTED' })] }), identity.login);
    assert.equal(blocked.approved, false);
});

for (const [label, patch] of [
    ['missing head commit', { headCommitId: undefined }],
    ['empty head commit', { headCommitId: '' }],
    ['stale approval commit', { reviews: [approved({ commitId: 'older-head' })] }],
    ['missing approval commit', { reviews: [approved({ commitId: undefined })] }],
]) {
    test(`${label}: human approval is not proof of clean current-head review`, () => {
        const record = pr(1, patch);
        const quality = inspectPR(record, identity.login);
        assert.equal(quality.sampled, false, 'No human decision establishes review evidence for the current head.');
        assert.equal(quality.approved, false);
        assert.equal(quality.clean, false);
        const kinds = kindsOf([record]);
        assert.ok(kinds.includes('merged'));
        assert.equal(kinds.includes('clean'), false);
        assert.equal(kinds.includes('firstPass'), false);
        assert.equal(kinds.includes('turnaround'), false);
        const analytics = githubAnalytics(eventsOf([record]), recordsOf([record]), identity, [], 'all', now);
        assert.equal(analytics.qualitySample, 0);
        assert.equal(analytics.unknownQuality, 1);
        assert.equal(analytics.clean, 0);
        assert.equal(analytics.cleanRate, null);
    });
}

test('new current-head approval restores clean eligibility after a stale approval', () => {
    const stale = approved({ id: 'old-review', commitId: 'older-head', submittedAt: '2026-01-06T13:00:00.000Z' });
    const record = pr(1, { reviews: [stale, approved()] });
    assert.equal(inspectPR(record, identity.login).approved, true);
    assert.equal(inspectPR(record, identity.login).clean, true);
    assert.ok(kindsOf([record]).includes('clean'));
    assert.ok(kindsOf([record]).includes('firstPass'));
});

test('actionable human/CodeRabbit findings and ambiguous feedback block clean; thanks do not', () => {
    const humanFinding = inspectPR(pr(1, { comments: [comment()] }), identity.login);
    assert.equal(humanFinding.findings, 1);
    assert.equal(humanFinding.automated, 0);
    const bot = comment({ author: 'coderabbitai[bot]', authorType: 'Bot', body: '⚠️ Potential issue\nPlease guard null input.' });
    const botFinding = inspectPR(pr(1, { comments: [bot] }), identity.login);
    assert.equal(botFinding.clean, false);
    assert.equal(botFinding.automated, 1);
    for (const body of ['What happens for an empty response?', 'The review service could not finish its analysis.']) {
        const unknown = inspectPR(pr(1, { comments: [{ ...bot, body }] }), identity.login);
        assert.equal(unknown.clean, false);
        assert.equal(unknown.findings, 0);
    }
    assert.equal(inspectPR(pr(1, { comments: [comment({ body: 'Interesting approach.' })] }), identity.login).clean, false);
    assert.equal(inspectPR(pr(1, { comments: [comment({ body: 'Thanks!' })] }), identity.login).clean, true);
    assert.equal(inspectPR(pr(1, { comments: [comment({ createdAt: '2026-01-06T16:00:00.000Z' })] }), identity.login).clean, true);
});

test('actionable review bodies block clean without inline comments, including human approvals and CodeRabbit findings', () => {
    for (const review of [
        approved({ body: 'Please fix the missing null guard before this ships.' }),
        approved({ author: 'coderabbitai[bot]', authorType: 'Bot', state: 'COMMENTED', body: '⚠️ Potential issue\nGuard against missing input.' }),
    ]) {
        const record = pr(1, { reviews: [approved(), { ...review, id: 'finding-review' }] });
        const quality = inspectPR(record, identity.login);
        assert.equal(quality.sampled, true);
        assert.equal(quality.clean, false);
        assert.equal(quality.findings, 1);
        assert.equal(quality.automated, Number(review.authorType === 'Bot'));
        assert.equal(kindsOf([record]).includes('clean'), false);
        assert.equal(kindsOf([record]).includes('firstPass'), false);
    }
    const changes = inspectPR(pr(1, { reviews: [approved({ state: 'CHANGES_REQUESTED', body: 'Please fix the missing input validation.' })] }), identity.login);
    assert.equal(changes.sampled, true);
    assert.equal(changes.findings, 1, 'A change-request body must not duplicate the change-request finding.');
    assert.equal(changes.clean, false);
});

test('body-only constructive feedback needs 40 trimmed actionable characters and uses its own submission date', () => {
    const first = approved({ author: identity.login });
    const feedbackAt = '2026-01-07T16:00:00.000Z';
    const body = 'Please fix the missing null guard.'.padEnd(40, '!');
    assert.equal(body.length, 40);
    const feedback = approved({
        id: 'later-review', author: identity.login, state: 'COMMENTED',
        body, submittedAt: feedbackAt,
    });
    const record = reviewedPr(1, { reviews: [first, feedback] });
    const quality = inspectPR(record, identity.login);
    assert.equal(quality.constructive, true);
    assert.equal(quality.constructiveAt, feedbackAt);
    assert.equal(quality.helpful, false, 'A review body alone is not an explicit linked author acknowledgment.');
    const events = eventsOf([record]);
    assert.equal(events.find((e) => e.kind === 'reviewed').at, first.submittedAt);
    assert.equal(events.find((e) => e.kind === 'constructive').at, feedbackAt);
    for (const insufficient of [
        body.slice(0, 39),
        `  ${body.slice(0, 39)}  `,
        'I checked the implementation and verified the behavior on all relevant execution paths.',
    ]) {
        assert.equal(inspectPR(reviewedPr(1, { reviews: [first, { ...feedback, body: insufficient }] }), identity.login).constructive, false);
    }
});

test('inline constructive and helpful events use actual feedback and author-reply timestamps, not first review', () => {
    const first = approved({ author: identity.login });
    const own = comment({ author: identity.login, createdAt: '2026-01-07T23:45:00.000Z' });
    const reply = comment({
        id: 'acknowledgment', author: 'fixture-colleague', inReplyToId: own.id,
        body: 'Good catch, fixed!', createdAt: '2026-01-08T00:15:00.000Z',
    });
    const laterReply = { ...reply, id: 'later-acknowledgment', createdAt: '2026-01-09T10:00:00.000Z' };
    const record = reviewedPr(1, { reviews: [first], comments: [laterReply, reply, own] });
    const quality = inspectPR(record, identity.login);
    assert.equal(quality.constructiveAt, own.createdAt);
    assert.equal(quality.helpfulAt, reply.createdAt);
    const events = eventsOf([record]);
    assert.equal(events.find((e) => e.kind === 'reviewed').at, first.submittedAt);
    assert.equal(events.find((e) => e.kind === 'constructive').at, own.createdAt);
    assert.equal(events.find((e) => e.kind === 'helpful').at, reply.createdAt);
    assert.equal(events.filter((e) => e.kind === 'helpful').length, 1);
    const analytics = githubAnalytics(events, recordsOf([record]), identity, [], 'all', now);
    assert.equal(analytics.timeline.find((e) => e.date === '2026-01-07').xp, ECONOMY.github.constructive);
    assert.equal(analytics.timeline.find((e) => e.date === '2026-01-08').xp, ECONOMY.github.helpful);
    assert.deepEqual(eventsOf([{ ...record, comments: [...record.comments].reverse() }]), events);
});

test('author acknowledgments with missing/invalid dates or predating feedback cannot earn helpful credit', () => {
    const own = comment({ author: identity.login, createdAt: '2026-01-07T16:00:00.000Z' });
    for (const createdAt of [undefined, 'not-a-date', '2026-01-07T15:59:59.000Z']) {
        const reply = comment({ id: 'invalid-ack', author: 'fixture-colleague', inReplyToId: own.id, body: 'Thanks, fixed!', createdAt });
        const record = reviewedPr(1, { comments: [own, reply] });
        assert.equal(inspectPR(record, identity.login).constructive, true);
        assert.equal(inspectPR(record, identity.login).helpful, false);
        assert.equal(kindsOf([record]).includes('helpful'), false);
    }
});

test('helpful requires an explicit linked author reply; reaction/resolution/third-party thanks is insufficient', () => {
    const own = comment({ author: identity.login });
    const reply = comment({ id: 'reply-1', author: 'fixture-colleague', inReplyToId: own.id, body: 'Good catch, fixed. Thanks!', createdAt: '2026-01-06T14:30:00.000Z' });
    const good = reviewedPr(1, { comments: [own, reply] });
    assert.equal(inspectPR(good, identity.login).helpful, true);
    assert.ok(kindsOf([good]).includes('helpful'));
    for (const comments of [
        [{ ...own, resolved: true, reactions: { '+1': 1 } }],
        [own, { ...reply, author: 'third-party' }],
        [own, { ...reply, inReplyToId: 'another-thread' }],
        [own, { ...reply, body: 'I disagree.' }],
    ]) assert.equal(inspectPR(reviewedPr(1, { comments }), identity.login).helpful, false);
    assert.equal(kindsOf([reviewedPr(1, { comments: [own, reply], qualityComplete: false })]).includes('helpful'), false);
});

test('historical event order and every daily cap are independent of API input order', () => {
    const records = [
        ...Array.from({ length: 12 }, (_, i) => pr(i + 1)),
        ...Array.from({ length: 8 }, (_, i) => reviewedPr(i + 50)),
        pr(100, { createdAt: '2026-01-07T12:00:00.000Z', mergedAt: '2026-01-07T15:00:00.000Z', reviews: [] }),
    ];
    const events = eventsOf(records);
    assert.deepEqual(eventsOf([...records].reverse()), events);
    const firstDay = events.filter((e) => utcDay(e.at) === '2026-01-06');
    assert.equal(firstDay.reduce((sum, e) => sum + e.xp, 0), ECONOMY.github.dailyCaps.total);
    for (const group of ['opened', 'merged', 'reviewed', 'bonus']) {
        assert.ok(firstDay.filter((e) => e.group === group).reduce((sum, e) => sum + e.xp, 0) <= ECONOMY.github.dailyCaps[group]);
    }
    for (const e of events) assert.ok(e.xp >= 0 && e.xp <= e.rawXp);
    assert.equal(events.find((e) => e.prId === 'fixture/repo#100' && e.kind === 'merged').xp, ECONOMY.github.merged);
});

test('missing identities, malformed PR IDs/numbers/dates and future timestamps do not award events', () => {
    assert.deepEqual(contributionEvents(recordsOf([pr()]), null), []);
    for (const patch of [{ id: '' }, { repo: '' }, { number: 0 }, { number: 1.5 }, { createdAt: 'not-a-date' }]) {
        assert.deepEqual(eventsOf([pr(1, patch)]), []);
    }
    assert.deepEqual(eventsOf([pr(1, { createdAt: '2099-01-01T00:00:00Z', mergedAt: '2099-01-02T00:00:00Z' })]), []);
});

test('complete file evidence gates complex/readiness/tests/docs bonuses', () => {
    const record = pr(1, { additions: 240, deletions: 10, changedFiles: 3, files: [{ path: 'tests/example.test.js' }, { path: 'docs/design.md' }] });
    assert.equal(inspectPR(record, identity.login).complex, true);
    const kinds = kindsOf([record]);
    for (const kind of ['complex', 'tests', 'documentation', 'readiness']) assert.ok(kinds.includes(kind), kind);
    const incomplete = kindsOf([{ ...record, filesComplete: false }]);
    for (const kind of ['complex', 'tests', 'documentation', 'readiness']) assert.equal(incomplete.includes(kind), false, kind);
});

test('daily, weekly and monthly challenges use UTC occurrence keys, with historical periods retained', () => {
    assert.equal(utcWeek('2026-01-04T23:59:59Z'), '2025-12-29');
    assert.equal(utcWeek('2026-01-05T00:00:00Z'), '2026-01-05');
    const records = [];
    for (const [month, day] of [['01', '06'], ['02', '03']]) {
        for (let i = 0; i < 5; i++) {
            const n = records.length + 1;
            const createdAt = `2026-${month}-${day}T10:00:00.000Z`;
            const merged = `2026-${month}-${day}T15:00:00.000Z`;
            records.push(pr(n, { createdAt, mergedAt: merged, reviews: [approved({ submittedAt: merged })] }));
        }
        for (let i = 0; i < 3; i++) {
            records.push(reviewedPr(records.length + 1, {
                createdAt: `2026-${month}-${day}T10:00:00.000Z`,
                reviews: [approved({ author: identity.login, submittedAt: `2026-${month}-${day}T14:00:00.000Z` })],
            }));
        }
    }
    const tickets = ['01', '02'].map((month) => ({ xp: 200, closedOn: `2026-${month}-06T12:00:00.000Z` }));
    const result = githubChallenges(eventsOf(records), tickets, now);
    for (const id of ['gh-daily', 'gh-merge-master', 'gh-balanced', 'gh-team']) assert.equal(challenge(result, id).count, 2, id);
    assert.equal(challenge(result, 'gh-daily').progress, 0);
    assert.equal(challenge(result, 'gh-merge-master').progress, 0);
    assert.equal(challenge(result, 'gh-team').progress, 3);
    assert.equal(challenge(result, 'gh-balanced').progress, 200);
    assert.equal(challenge(result, 'gh-quality-first').count, 1);
    assert.equal(challenge(result, 'gh-helping-hand').count, 1);
    assert.equal(challenge(result, 'gh-focused').count, 1);
    assert.ok(result.completions.some((e) => e.id === 'gh-merge-master:2026-01-05'));
    assert.ok(result.completions.some((e) => e.id === 'gh-balanced:2026-02'));
    assert.equal(new Set(result.completions.map((e) => e.id)).size, result.completions.length);
    assert.equal(challenge(githubChallenges(eventsOf(records), [{ xp: 199, closedOn: tickets[0].closedOn }], now), 'gh-balanced').count, 0);
});

function qualityEvents(findings, { unknown = -1, lines = 100 } = {}) {
    return findings.map((n, i) => ({
        id: `quality-${i}:merged`, prId: `quality-${i}`, repo: 'fixture/repo', kind: 'merged',
        at: new Date(Date.UTC(2026, 0, i + 1, 15)).toISOString(), xp: 120,
        quality: { sampled: i !== unknown, clean: n === 0 && i !== unknown, findings: n, lines, automated: 0, iterations: n ? 1 : 0, changes: n > 0 },
    }));
}

test('quality improvement needs two non-overlapping complete groups of five and at least 20% density reduction', () => {
    const base = [1, 1, 1, 1, 1];
    const improved = [...base, 1, 1, 1, 1, 0];
    const result = githubChallenges(qualityEvents(improved), [], now);
    assert.equal(result.improvements, 1);
    assert.equal(challenge(result, 'gh-improvement').count, 1);
    assert.equal(githubChallenges(qualityEvents([...base, ...base]), [], now).improvements, 0);
    assert.equal(githubChallenges(qualityEvents(improved.slice(0, 9)), [], now).improvements, 0);
    assert.equal(githubChallenges(qualityEvents(improved, { unknown: 2 }), [], now).improvements, 0);
    assert.equal(githubChallenges(qualityEvents(Array(10).fill(0)), [], now).improvements, 0);
    assert.equal(githubChallenges(qualityEvents([...improved, ...improved]), [], now).improvements, 2);
    const analytics = githubAnalytics(qualityEvents(improved), {}, identity, [], 'all', now);
    assert.equal(analytics.qualityTrend.previous, 1);
    assert.equal(analytics.qualityTrend.current, .8);
    assert.equal(analytics.improvements, 1);
});

test('analytics preserve unknown denominator, finite date ranges, bonuses, merge rate, and repository counts', () => {
    const records = [pr(), pr(2, { reviews: [] }), pr(3, { state: 'closed', mergedAt: null }), reviewedPr(4, { repo: 'fixture/other', id: 'fixture/other#4' })];
    const events = eventsOf(records);
    const bonuses = githubChallenges(events, [], now).completions;
    const all = githubAnalytics(events, recordsOf(records), identity, bonuses, 'all', now);
    assert.equal(all.merged, 2);
    assert.equal(all.reviewed, 1);
    assert.equal(all.qualitySample, 1);
    assert.equal(all.unknownQuality, 1);
    assert.equal(all.cleanRate, 1);
    assert.equal(all.mergeRate, 2 / 3);
    assert.equal(all.repositories, 2);
    assert.equal(all.xp, all.baseXp + all.bonusXp);
    assert.equal(all.timeline.reduce((sum, bucket) => sum + bucket.xp, 0), all.xp);
    const recent = githubAnalytics(events, recordsOf(records), identity, bonuses, '7', now);
    assert.equal(recent.xp, 0);
    assert.equal(recent.cleanRate, null);
    assert.equal(recent.mergeRate, null);
});

test('clean streak completion timestamp must identify the third consecutive clean merge, not the third merge overall', () => {
    const events = qualityEvents([1, 0, 0, 0]);
    const result = githubChallenges(events, [], now);
    assert.equal(result.bestCleanStreak, 3);
    assert.equal(result.completions.find((e) => e.challengeId === 'gh-clean-streak').at, events[3].at);
});

test('consistent contributor completion is earned on the fourth distinct consecutive week', () => {
    const events = qualityEvents([0, 0, 0, 0, 0, 0]);
    const dates = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-12', '2026-01-19', '2026-01-26'];
    for (let i = 0; i < events.length; i++) events[i].at = `${dates[i]}T15:00:00.000Z`;
    const result = githubChallenges(events, [], now);
    assert.equal(challenge(result, 'gh-consistent').count, 1);
    assert.equal(result.completions.find((e) => e.challengeId === 'gh-consistent').at, events[5].at);
});

test('fresh isolated store loads, persists v3 and exposes finite zero progression', (t) => {
    const { store, restart } = isolatedStore(t);
    const view = store.view();
    assert.equal(view.progress.xp, 0);
    assert.equal(view.progress.level, 1);
    assert.equal(view.progress.levelProgress, 0);
    assert.equal(view.progress.githubXp, 0);
    assert.equal(view.name, 'Bit');
    assert.equal(JSON.parse(readFileSync(store.file, 'utf8')).version, STATE_VERSION);
    assert.equal(restart().view().progress.xp, 0);
});

test('v2 migration preserves stored ticket XP, name, unlocks, achievements and old level fraction across restart', (t) => {
    const { store, restart } = isolatedStore(t);
    const earnedAt = '2025-12-01T12:00:00.000Z';
    const raw = {
        version: 2, userId, name: 'Fixture Byte', mode: 'live',
        profiles: { live: {
            ledger: { [`${SOURCE_IT}:legacy-a`]: {
                id: 'legacy-a', source: SOURCE_IT, title: 'Imported legacy fixture', kind: 'normal',
                xp: 540, status: 'rewarded', closedOn: at,
            } },
            unlocked: ['hat-crown'], achievements: { 'first-fix': earnedAt }, treatsEarned: 8, treatsSpent: 2,
        } },
    };
    mkdirSync(dirname(store.file), { recursive: true });
    writeFileSync(store.legacyFile, JSON.stringify(raw));
    const view = store.view();
    assert.equal(view.name, raw.name);
    assert.equal(view.progress.ticketXp, 540);
    assert.equal(store.ledgerEntry('legacy-a').xp, 540);
    assert.equal(view.progress.level, 2);
    assert.ok(Math.abs(view.progress.levelProgress - .5) <= 1 / levelCost(2));
    assert.equal(view.progress.migrationXp, Math.ceil(xpForLevel(2) + .5 * levelCost(2) - 540));
    assert.equal(store.load().profiles.live.achievements['first-fix'], earnedAt);
    assert.ok(store.load().profiles.live.unlocked.includes('hat-crown'));
    assert.equal(view.treats, 6);
    const reloaded = restart().view();
    assert.equal(reloaded.progress.xp, view.progress.xp);
    assert.equal(reloaded.progress.migrationXp, view.progress.migrationXp);
    assert.equal(reloaded.progress.levelProgress, view.progress.levelProgress);
});

test('historical GitHub sync/repeat/restart award XP, achievements and challenge keys once', (t) => {
    const { store, restart } = isolatedStore(t);
    const records = [pr(1), pr(2), pr(3), reviewedPr(4)];
    const first = sync(store, records);
    assert.ok(first.xpAwarded > 0);
    const before = structuredClone(store.load().profiles.live);
    assert.ok(before.achievements['gh-merge-1']);
    assert.ok(before.unlocked.includes('body-github'));
    assert.ok(before.challengeKeys.includes('gh-quality-first:once'));
    const expected = githubChallenges(eventsOf(records), [], now).completions;
    assert.equal(first.githubXp, eventsOf(records).reduce((s, e) => s + e.xp, 0) + expected.reduce((s, e) => s + e.xp, 0));
    assert.equal(before.treatsEarned, 0, 'Historical import is quiet, not a retroactive treat flood.');
    assert.equal(sync(store, [...records].reverse()).xpAwarded, 0);
    const loaded = restart();
    assert.equal(sync(loaded, records).xpAwarded, 0);
    assert.deepEqual(loaded.load().profiles.live.challengeKeys, before.challengeKeys);
    assert.equal(loaded.load().profiles.live.treatsEarned, before.treatsEarned);
    assert.equal(loaded.load().profiles.live.achievements['gh-merge-1'], before.achievements['gh-merge-1']);
    assert.equal(loaded.view().progress.githubXp, first.githubXp);
});

test('new GitHub challenge treats after initial sync are granted once even after repeat and restart', (t) => {
    const { store, restart } = isolatedStore(t);
    sync(store, []);
    const records = Array.from({ length: 5 }, (_, i) => pr(i + 1));
    sync(store, records);
    const before = structuredClone(store.load().profiles.live);
    const completions = githubChallenges(eventsOf(records), [], now).completions;
    assert.equal(before.treatsEarned, completions.reduce((sum, e) => sum + e.treats, 0));
    assert.ok(before.treatsEarned > 0);
    assert.equal(sync(store, records).xpAwarded, 0);
    const loaded = restart();
    assert.equal(sync(loaded, records).xpAwarded, 0);
    assert.equal(loaded.load().profiles.live.treatsEarned, before.treatsEarned);
    assert.deepEqual(loaded.load().profiles.live.challengeKeys, before.challengeKeys);
});

test('historical backfill order reaches the same capped XP and does not delete missing records', (t) => {
    const left = isolatedStore(t).store;
    const right = isolatedStore(t).store;
    const records = Array.from({ length: 12 }, (_, i) => pr(i + 1));
    sync(left, records);
    sync(right, records.slice(6), { complete: false, warnings: ['fixture partial'], cursor: { page: 2 } });
    sync(right, records.slice(0, 6));
    assert.equal(right.view().progress.githubXp, left.view().progress.githubXp);
    assert.deepEqual(Object.keys(right.load().profiles.live.github.records).sort(), Object.keys(left.load().profiles.live.github.records).sort());
    sync(right, []);
    assert.equal(Object.keys(right.load().profiles.live.github.records).length, records.length);
    assert.equal(right.view().progress.githubXp, left.view().progress.githubXp);
});

test('partial GitHub refresh preserves warnings/cursor, ignores stale snapshots, persists failure metadata', (t) => {
    const { store, restart } = isolatedStore(t);
    const current = pr(1, { updatedAt: '2026-01-08T12:00:00.000Z' });
    sync(store, [current], { complete: false, warnings: ['review fetch incomplete'], cursor: { next: 2 } });
    const gh = store.load().profiles.live.github;
    assert.deepEqual(gh.lastSync.warnings, ['review fetch incomplete']);
    assert.deepEqual(gh.cursor, { next: 2 });
    assert.equal(gh.lastSync.complete, false);
    const before = store.view().progress.githubXp;
    sync(store, [pr(1, { state: 'open', mergedAt: null, updatedAt: at })]);
    assert.equal(store.view().progress.githubXp, before);
    assert.equal(gh.records[current.id].state, 'merged');
    store.recordGitHubFailure('fixture failure');
    assert.equal(restart().view().github.lastAttempt.error, 'fixture failure');
    assert.equal(restart().view().progress.githubXp, before);
});

test('different GitHub identity/host is rejected without changing records or XP', (t) => {
    const { store } = isolatedStore(t);
    sync(store, [pr()]);
    const before = structuredClone(store.load().profiles.live.github);
    for (const changed of [{ ...identity, id: 900002 }, { ...identity, host: 'github.enterprise.invalid' }]) {
        assert.throws(() => sync(store, [pr(2)], { identity: changed }), errorCode('github_identity_changed'));
    }
    assert.deepEqual(store.load().profiles.live.github, before);
    assert.throws(() => sync(store, [], { identity: { login: identity.login, id: '900001', host: 'github.com' } }), errorCode('github_identity'));
});

test('GitHub settings validate atomically, normalize scope, reset cursor, retain earned history and block busy changes', (t) => {
    const { store, restart } = isolatedStore(t);
    sync(store, [pr()], { cursor: { next: 2 } });
    for (const patch of [
        { enabled: 'true' }, { repositories: 'fixture/repo' }, { repositories: ['https://github.com/fixture/repo'] },
        { repositories: ['bad/repo/extra'] }, { repositories: [null] }, { repositories: Array(101).fill('fixture/repo') },
    ]) {
        const before = structuredClone(store.load().profiles.live.github.settings);
        assert.throws(() => store.setGitHubSettings(patch));
        assert.deepEqual(store.load().profiles.live.github.settings, before);
    }
    assert.throws(() => store.setGitHubSettings({ enabled: false, repositories: ['invalid'] }));
    assert.equal(store.load().profiles.live.github.settings.enabled, true);
    const xp = store.view().progress.githubXp;
    assert.deepEqual(store.setGitHubSettings({ enabled: false, repositories: ['Fixture/Repo', 'fixture/repo', 'fixture/other'] }), {
        enabled: false, repositories: ['fixture/other', 'fixture/repo'], organizations: [], needsScope: false,
    });
    assert.equal(store.load().profiles.live.github.cursor, null);
    assert.equal(store.view().github.lastSync.complete, false);
    assert.equal(store.view().progress.githubXp, xp);
    assert.equal(restart().view().github.settings.enabled, false);
    store.setRuntime({ githubSyncing: true });
    assert.throws(() => store.setGitHubSettings({ enabled: true }), errorCode('github_busy'));
});

test('normal ticket import/repeat/reopen/reclose retain original stored XP and never duplicate treats', (t) => {
    const { store, restart } = isolatedStore(t);
    const record = ticket();
    const first = store.applySync({ tickets: [record], complete: true });
    assert.equal(first.xpAwarded, REWARDS.normal.xp);
    assert.equal(first.totalClosed, 1);
    const original = store.view();
    assert.equal(store.applySync({ tickets: [record], complete: true }).xpAwarded, 0);
    const reopened = store.applySync({ tickets: [{ ...record, isOpen: true }], complete: true });
    assert.equal(reopened.reopened, 1);
    assert.equal(store.view().progress.ticketXp, 0);
    assert.equal(store.view().progress.reopened, 1);
    assert.ok(store.load().profiles.live.achievements['first-fix']);
    assert.ok(store.load().profiles.live.unlocked.includes('hat-beanie'));
    const reclosed = store.applySync({ tickets: [{ ...record, isIssue: true, severity: 4 }], complete: true });
    assert.equal(reclosed.reclosed, 1);
    assert.equal(reclosed.xpAwarded, REWARDS.normal.xp);
    assert.equal(store.ledgerEntry(record.id).xp, REWARDS.normal.xp);
    assert.equal(store.view().treats, original.treats);
    assert.equal(restart().view().progress.ticketXp, REWARDS.normal.xp);
});

test('initial normal ticket import caps treats, skips other assignees, and complete-only absence revokes rewards', (t) => {
    const { store } = isolatedStore(t);
    const records = Array.from({ length: 20 }, (_, i) => ticket({ id: `ordinary-${i}` }));
    const result = store.applySync({ tickets: [...records, ticket({ id: 'foreign', assignedTo: 'other-user' })], complete: true });
    assert.equal(result.newlyRewarded, 20);
    assert.equal(result.skipped, 1);
    assert.equal(store.view().progress.ticketXp, 2000);
    assert.equal(store.view().treats, 15);
    store.applySync({ tickets: [], complete: false });
    assert.equal(store.view().progress.total, 20);
    store.applySync({ tickets: [], complete: true });
    assert.equal(store.view().progress.total, 0);
    assert.equal(store.view().treats, 15);
});

test('demo ticket simulation/reset stays separate while real ticket and GitHub sync always target live profile', (t) => {
    const { store, restart } = isolatedStore(t);
    assert.throws(() => store.simulateDemoTicket('normal'), errorCode('demo_mode_required'));
    store.applySync({ tickets: [ticket()] });
    sync(store, [pr()]);
    const liveXp = store.view().progress.xp;
    store.setMode('demo');
    assert.equal(store.view().progress.xp, 0);
    const simulated = store.simulateDemoTicket('normal', 2);
    assert.equal(simulated.demo, true);
    assert.equal(store.view().progress.ticketXp, 200);
    assert.equal(store.view().progress.githubXp, 0);
    sync(store, [pr(2)]);
    store.applySync({ tickets: [ticket({ id: 'second-real' })] });
    assert.equal(store.view().progress.ticketXp, 200);
    assert.equal(store.view().progress.githubXp, 0);
    store.resetDemo();
    assert.equal(store.view().progress.xp, 0);
    store.setMode('live');
    assert.ok(store.view().progress.xp > liveXp);
    assert.equal(store.view().progress.total, 2);
    assert.equal(store.view().github.summary.merged, 2);
    assert.equal(restart().view().progress.xp, store.view().progress.xp);
});
