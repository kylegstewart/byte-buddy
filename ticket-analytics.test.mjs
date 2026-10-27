import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createStore } from './store.mjs';
import { SOURCE_IT } from './catalog.mjs';

function fixture(t) {
    const root = mkdtempSync(join(process.cwd(), '.buddy-ticket-charts-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    return { store: createStore({ root, userId: 'FIXTURE' }), restart: () => createStore({ root, userId: 'FIXTURE' }) };
}
const ticket = (i, extra = {}) => ({ id: `fixture-${i}`, title: 'Synthetic ticket', assignedTo: 'FIXTURE', isIssue: false, isOpen: false,
    closedOn: new Date(2025, 0, 6 + i, 12).toISOString(), ...extra });
const sum = (rows, key) => rows.reduce((total, row) => total + row[key], 0);

test('ticket charts cover full history, disjoint categories and challenge XP; repeat/restart/reopen reconcile', (t) => {
    const { store, restart } = fixture(t);
    const tickets = Array.from({ length: 30 }, (_, i) => ticket(i, { requester: `requester-${i}`, isIssue: i % 3 !== 0, severity: i % 3 === 2 ? 4 : 1 }));
    store.applySync({ tickets, complete: true });
    const view = store.view();
    const all = view.ticketAnalytics.all;
    assert.equal(view.recent.length, 12);
    assert.equal(sum(all.timeline, 'total'), 30);
    assert.equal(sum(all.timeline, 'normal'), 10);
    assert.equal(sum(all.timeline, 'hd'), 10);
    assert.equal(sum(all.timeline, 'critical'), 10);
    assert.equal(sum(all.timeline, 'xp') + all.undatedXp, view.progress.ticketTotalXp);
    assert.ok(view.progress.bonusXp > 0);
    for (const row of all.timeline) assert.equal(row.total, row.normal + row.hd + row.critical);
    store.applySync({ tickets, complete: true });
    assert.deepEqual(store.view().ticketAnalytics, view.ticketAnalytics);
    assert.deepEqual(restart().view().ticketAnalytics, view.ticketAnalytics);
    store.applySync({ tickets: [{ ...tickets[0], isOpen: true }], complete: false });
    assert.equal(sum(store.view().ticketAnalytics.all.timeline, 'total'), 29);
    assert.equal(sum(store.view().ticketAnalytics.all.timeline, 'xp'), store.view().progress.ticketTotalXp);
    store.applySync({ tickets: [tickets[0]], complete: false });
    assert.deepEqual(store.view().ticketAnalytics, view.ticketAnalytics);
});

test('ticket challenge XP is dated at completion, not the first of the month or import date', (t) => {
    const { store } = fixture(t);
    const tickets = Array.from({ length: 25 }, (_, i) => ticket(i, { closedOn: new Date(2025, 0, 1 + i, 12).toISOString(), requester: `requester-${i}` }));
    store.applySync({ tickets: tickets.reverse(), complete: true });
    const rows = store.view().ticketAnalytics.all.timeline;
    // 25th ticket earns monthly marathon (1000) and 25-requester tier (500).
    assert.ok(rows.find((row) => row.date === '2025-01-25').xp >= 1600);
    // Ten distinct requesters: 100 base + 250 friendly-face bonus.
    assert.ok(rows.find((row) => row.date === '2025-01-10').xp >= 350);
    assert.equal(sum(rows, 'xp'), store.view().progress.ticketTotalXp);
});

test('legacy undated ticket and challenge XP stay in totals without invented chart dates', (t) => {
    const { store } = fixture(t);
    const profile = store.load().profiles.live;
    profile.ledger['undated'] = { id: 'undated', source: SOURCE_IT, kind: 'normal', xp: 100, status: 'rewarded', difficulty: 3 };
    const view = store.view();
    assert.equal(view.ticketAnalytics.all.undatedTickets, 1);
    assert.equal(view.ticketAnalytics.all.undatedXp, 400);
    assert.deepEqual(view.ticketAnalytics.all.timeline, []);
    assert.equal(view.progress.ticketTotalXp, 400);
});

test('demo and live ticket analytics remain isolated', (t) => {
    const { store } = fixture(t);
    store.applySync({ tickets: [ticket(0)], complete: true });
    const live = store.view().ticketAnalytics;
    store.setMode('demo');
    assert.deepEqual(store.view().ticketAnalytics.all.timeline, []);
    store.simulateDemoTicket('hd', 2);
    assert.equal(sum(store.view().ticketAnalytics.all.timeline, 'hd'), 2);
    store.setMode('live');
    assert.deepEqual(store.view().ticketAnalytics, live);
});

test('ticket range aggregates use local calendar boundaries, range-specific counts and dated revocations', (t) => {
    const { store, restart } = fixture(t);
    const now = new Date();
    const date = (days) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - days, 12).toISOString();
    const rows = [0, 6, 7, 29, 30, 89, 90].map((days, i) => ticket(i, {
        closedOn: date(days), isIssue: [1, 2, 3, 6].includes(i), severity: [2, 3].includes(i) ? 3 : 1,
    }));
    store.applySync({ tickets: rows, complete: true });
    store.applySync({ tickets: [{ ...rows[2], isOpen: true, updatedOn: date(1) }], complete: false });
    const view = store.view();
    for (const [range, count, hd, critical] of [['7', 2, 1, 0], ['30', 3, 2, 1], ['90', 5, 2, 1], ['all', 6, 3, 1]]) {
        const analytics = view.ticketAnalytics[range];
        assert.equal(analytics.total, count, range);
        assert.equal(analytics.hd, hd, range);
        assert.equal(analytics.critical, critical, range);
        assert.equal(analytics.reopened, 1, range);
        assert.equal(analytics.ticketXp, sum(analytics.timeline, 'baseXp') + (range === 'all' ? analytics.undatedXp : 0), range);
        assert.equal(analytics.ticketTotalXp, analytics.baseXp + analytics.bonusXp, range);
        assert.equal(sum(analytics.timeline, 'xp') + analytics.undatedXp, analytics.ticketTotalXp, range);
        assert.equal(sum(analytics.timeline, 'reopened'), analytics.reopened, range);
        assert.ok(analytics.currentStreak <= analytics.longestStreak, range);
    }
    const all = view.ticketAnalytics.all;
    for (const key of ['ticketTotalXp', 'ticketXp', 'total', 'hd', 'critical', 'reopened', 'currentStreak', 'longestStreak']) {
        assert.equal(all[key], view.progress[key], key);
    }
    assert.deepEqual(restart().view().ticketAnalytics, view.ticketAnalytics);
});

test('new monthly ticket challenge XP is attributed to the exact historical threshold date', (t) => {
    const { store, restart } = fixture(t);
    const rows = Array.from({ length: 10 }, (_, i) => ticket(i, {
        closedOn: new Date(2025, 1, 3 + i, 12).toISOString(),
        requester: `requester-${i % 5}`, isIssue: i >= 5,
    }));
    store.applySync({ tickets: [...rows].reverse(), complete: true });
    const first = store.view();
    const outreach = first.ticketAnalytics.all.timeline.find((row) => row.date === '2025-02-07');
    const versatile = first.ticketAnalytics.all.timeline.find((row) => row.date === '2025-02-12');
    assert.ok(outreach.bonusXp >= 200);
    assert.ok(versatile.bonusXp >= 300);
    assert.equal(outreach.baseXp, 100);
    assert.equal(versatile.baseXp, 200);
    assert.equal(first.challenges.find((row) => row.id === 'monthly-network').count, 1);
    assert.equal(first.challenges.find((row) => row.id === 'versatile-month').count, 1);
    assert.ok(store.load().profiles.live.challengeKeys.includes('monthly-network:2025-02'));
    assert.ok(store.load().profiles.live.challengeKeys.includes('versatile-month:2025-02'));
    store.applySync({ tickets: rows, complete: true });
    assert.deepEqual(restart().view().ticketAnalytics, first.ticketAnalytics);
});
