import test from 'node:test';
import assert from 'node:assert/strict';
import { createGraphQLDetails, compactFiles } from './github-graphql.mjs';

const at = '2026-01-01T12:00:00Z';
const author = { login: 'developer', __typename: 'User' };
const connection = (nodes = [], more = false, cursor = null) => ({ nodes, pageInfo: { hasNextPage: more, endCursor: cursor } });
const review = (id = '11', extra = {}) => ({ fullDatabaseId: id, author, state: 'APPROVED', submittedAt: at, body: 'Good', commit: { oid: 'head' }, ...extra });
const comment = (id = '21', extra = {}) => ({ fullDatabaseId: id, author: { login: 'reviewer[bot]', __typename: 'Bot' },
    body: 'Handle null', createdAt: at, path: 'src/app.js', replyTo: null, pullRequestReview: { fullDatabaseId: '11' }, ...extra });
const pull = (number = 1, extra = {}) => ({
    id: `PR_${number}`, number, title: `PR ${number}`, author, createdAt: at, updatedAt: at, closedAt: at, mergedAt: at,
    state: 'MERGED', isDraft: false, additions: 25, deletions: 4, changedFiles: 2, body: 'Description', headRefOid: 'head',
    labels: connection([{ name: 'bug' }]), reviews: connection([review()]),
    reviewThreads: connection([{ id: `THREAD_${number}`, comments: connection([comment()]) }]),
    files: { ...connection([{ path: 'src/app.js', additions: 20, deletions: 4 }, { path: 'tests/app.test.js', additions: 5, deletions: 0 }]), totalCount: 2 },
    ...extra,
});
const record = (number = 1) => ({ id: `team/project#${number}`, repo: 'team/project', number });
const quota = (remaining = 5000, resetAt = '2026-01-01T13:00:00Z') => ({ cost: 1, remaining, resetAt });
function fixture(handler = () => undefined) {
    let clock = Date.parse(at);
    const calls = [], sleeps = [];
    const request = async (query) => {
        calls.push({ query, at: clock });
        const custom = await handler(query, calls.length);
        if (custom !== undefined) return custom;
        const aliases = [...query.matchAll(/p(\d+):repository.*?pullRequest\(number:(\d+)\)/g)];
        return { data: { rateLimit: quota(), ...Object.fromEntries(aliases.map(([, alias, number]) => [`p${alias}`, { pullRequest: pull(Number(number)) }])) } };
    };
    const adapter = createGraphQLDetails({ request, now: () => clock, sleep: async (ms) => { sleeps.push(ms); clock += ms; } });
    return { ...adapter, calls, sleeps, advance(ms) { clock += ms; }, now: () => clock };
}

test('bulk evidence is one quota probe plus one serial query for ten PRs and uses live schema IDs', async () => {
    const f = fixture();
    const result = await f.fetchBatch(Array.from({ length: 10 }, (_, i) => record(i + 1)));
    assert.equal(f.calls.length, 2);
    assert.deepEqual(f.sleeps, [1000]);
    assert.equal(result.size, 10);
    const item = result.get(record().id);
    assert.equal(item.qualityComplete, true);
    assert.equal(item.raw.head.sha, 'head');
    assert.equal(item.raw.changed_files, 2);
    assert.equal(item.raw.user.type, 'User');
    assert.equal(item.reviews[0].id, '11');
    assert.equal(item.reviews[0].commit_id, 'head');
    assert.equal(item.comments[0].user.type, 'Bot');
    assert.equal(item.comments[0].pull_request_review_id, '11');
    assert.deepEqual(item.files, [{ path: 'tests/app.test.js', additions: 5, deletions: 0 }]);
    assert.ok(f.calls.every(({ query }) => !/\bmutation\b|\bdatabaseId\b/.test(query)));
    await f.fetchBatch([record(11)]);
    assert.equal(f.calls.length, 3); // Reuse quota, not another preflight per PR.
});

test('merger actor is fetched in the existing bulk query with no per-PR calls or guessed attribution', async () => {
    for (const mergedBy of [{ login: 'release-manager', __typename: 'User' }, null]) {
        const f = fixture((query) => query.includes('p0:') ? { data: { rateLimit: quota(), p0: { pullRequest: pull(1, { mergedBy }) } } } : undefined);
        const item = (await f.fetchBatch([record()])).get(record().id);
        assert.equal(item.error, undefined);
        assert.equal(f.calls.length, 2);
        assert.match(f.calls[1].query, /mergedBy \{ login __typename \}/);
        assert.deepEqual(item.raw.merged_by, mergedBy ? { login: 'release-manager', type: 'User' } : null);
        assert.equal(item.raw.user.login, author.login, 'Author and merger are separate evidence.');
        assert.equal(item.qualityComplete, true);
    }
    const f = fixture();
    const item = (await f.fetchBatch([record()])).get(record().id);
    assert.equal(Object.hasOwn(item.raw, 'merged_by'), false, 'An omitted actor is unknown, never inferred from the author.');
});

test('all review, thread, comment, file and label cursors are consumed before evidence is complete', async () => {
    const raw = pull(1, {
        changedFiles: 3, reviews: connection([review()], true, 'review-page'),
        reviewThreads: connection([{ id: 'THREAD_1', comments: connection([comment()], true, 'comment-page') }], true, 'thread-page'),
        files: { ...pull().files, totalCount: 3, pageInfo: { hasNextPage: true, endCursor: 'file-page' } },
        labels: connection([{ name: 'bug' }], true, 'label-page'),
    });
    const f = fixture((query) => {
        if (query.includes('p0:')) return { data: { rateLimit: quota(), p0: { pullRequest: raw } } };
        const pages = [
            ['review-page', 'reviews', connection([review('12', { state: 'CHANGES_REQUESTED' })])],
            ['thread-page', 'reviewThreads', connection([{ id: 'THREAD_2', comments: connection([comment('23')]) }])],
            ['comment-page', 'comments', connection([comment('22', { replyTo: { fullDatabaseId: '21' } })])],
            ['file-page', 'files', connection([{ path: 'README.md', additions: 1, deletions: 0 }])],
            ['label-page', 'labels', connection([{ name: 'enhancement' }])],
        ];
        for (const [cursor, name, page] of pages) if (query.includes(`after:"${cursor}"`)) return { data: { rateLimit: quota(), node: { [name]: page } } };
    });
    const item = (await f.fetchBatch([record()])).get(record().id);
    assert.equal(item.error, undefined);
    assert.equal(item.qualityComplete, true);
    assert.equal(item.reviews.length, 2);
    assert.equal(item.comments.length, 3);
    assert.equal(item.comments[1].in_reply_to_id, '21');
    assert.equal(item.files.length, 2);
    assert.equal(item.raw.labels.length, 2);
    assert.equal(f.calls.length, 7);
    assert.ok(f.calls.every((call, i) => i === 0 || call.at - f.calls[i - 1].at >= 1000));
});

test('permissions and transient alias errors are isolated, without trusting partial evidence', async () => {
    const f = fixture((query) => query.includes('p0:') ? {
        data: { rateLimit: quota(), p0: null, p1: null, p2: { pullRequest: pull(3) } },
        errors: [{ type: 'FORBIDDEN', path: ['p0', 'pullRequest'] }, { extensions: { code: 'INTERNAL' }, path: ['p1', 'pullRequest', 'reviews'] }],
    } : undefined);
    const result = await f.fetchBatch([record(), record(2), record(3)]);
    assert.equal(result.get(record().id).error.status, 403);
    assert.equal(result.get(record(2).id).error.status, null);
    assert.equal(result.get(record(3).id).qualityComplete, true);
});

test('null inaccessible PRs are permanent but omitted aliases remain unknown', async () => {
    for (const [data, status] of [[{ p0: null }, 404], [{ p0: { pullRequest: null } }, 404], [{}, null], [{ p0: {} }, null]]) {
        const f = fixture((query) => query.includes('p0:') ? { data: { rateLimit: quota(), ...data } } : undefined);
        assert.equal((await f.fetchBatch([record()])).get(record().id).error.status, status);
    }
});

test('global query errors never become clean evidence or permanent PR permission errors', async () => {
    const f = fixture((query) => query.includes('p0:') ? { data: { rateLimit: quota(), p0: { pullRequest: pull() } },
        errors: [{ type: 'INTERNAL', message: 'private diagnostic' }] } : undefined);
    await assert.rejects(f.fetchBatch([record()]), (error) => error.status === null && !error.message.includes('private diagnostic'));
});

test('node overflow reduces a batch serially and preserves healthy records', async () => {
    const f = fixture((query) => query.includes('p1:') ? { errors: [{ type: 'MAX_NODE_LIMIT_EXCEEDED' }] } : undefined);
    const result = await f.fetchBatch([record(), record(2)]);
    assert.equal(f.calls.length, 4);
    assert.equal(result.get(record().id).qualityComplete, true);
    assert.equal(result.get(record(2).id).qualityComplete, true);
});

test('a single overflowing PR does not discard later healthy split batches', async () => {
    const f = fixture((query) => query.includes('p1:') || query.includes('number:1)')
        ? { errors: [{ type: 'MAX_NODE_LIMIT_EXCEEDED' }] } : undefined);
    const result = await f.fetchBatch([record(), record(2)]);
    assert.equal(result.get(record().id).error.code, 'github_graphql_overflow');
    assert.equal(result.get(record(2).id).qualityComplete, true);
    assert.equal(f.calls.length, 4);
});

test('global authentication failures are an account pause, not permanent PR evidence', async () => {
    const f = fixture((query) => query.includes('p0:') ? { data: null, errors: [{ type: 'UNAUTHORIZED' }] } : undefined);
    await assert.rejects(f.fetchBatch([record()]), { status: 401 });
});

test('failed pagination and repeated IDs/cursors never imply empty or clean evidence', async () => {
    const scenarios = [
        { raw: pull(1, { reviews: null }) },
        { raw: pull(1, { files: { ...pull().files, totalCount: 3 } }) },
        { raw: pull(1, { reviews: connection([review(), review()]) }) },
        { raw: pull(1, { reviews: { nodes: [], pageInfo: {} } }) },
        { raw: pull(1, { reviews: connection([review()], true, null) }) },
        { raw: pull(1, { reviews: connection([review()], true, 'same') }), next: connection([review('12')], true, 'same') },
        { raw: pull(1, { reviews: connection([review()], true, 'next') }), next: connection([review()]) },
        { raw: pull(1, { reviews: connection([review()], true, 'next') }), errors: [{ type: 'INTERNAL', path: ['node', 'reviews'] }] },
        { raw: pull(1, { headRefOid: undefined }) },
        { raw: pull(1, { reviewThreads: connection([{ id: 'THREAD', comments: connection([comment('21', { replyTo: undefined })]) }]) }) },
        { raw: pull(1, { reviewThreads: connection([{ id: 'THREAD_1', comments: connection([comment()]) }, { id: 'THREAD_2', comments: connection([comment()]) }]) }) },
    ];
    for (const scenario of scenarios) {
        const f = fixture((query) => query.includes('p0:') ? { data: { rateLimit: quota(), p0: { pullRequest: scenario.raw } } }
            : query.includes('node(id:') ? { data: { rateLimit: quota(), node: { reviews: scenario.next } }, errors: scenario.errors } : undefined);
        const item = (await f.fetchBatch([record()])).get(record().id);
        assert.ok(item.error);
        assert.equal(item.files, undefined);
        assert.ok(f.calls.length <= 3);
    }
});

test('deleted authors preserve stable detail and file evidence but never grant complete quality', async () => {
    for (const extra of [{ author: null }, { reviews: connection([review('11', { author: null })]) },
        { reviewThreads: connection([{ id: 'THREAD', comments: connection([comment('21', { author: null })]) }]) }]) {
        const f = fixture((query) => query.includes('p0:') ? { data: { rateLimit: quota(), p0: { pullRequest: pull(1, extra) } } } : undefined);
        const item = (await f.fetchBatch([record()])).get(record().id);
        assert.equal(item.error, undefined);
        assert.equal(item.qualityComplete, false);
        assert.equal(item.filesComplete, true);
        assert.equal(item.raw.additions, 25);
    }
});

test('low cached quota is refreshed after reset instead of pausing forever', async () => {
    let remaining = 199;
    const f = fixture((query) => !query.includes('p0:') ? { data: { rateLimit: quota(remaining, '2026-01-01T12:00:05Z') } } : undefined);
    await assert.rejects(f.fetchBatch([record()]), { code: 'github_rate_limited', retryAt: Date.parse('2026-01-01T12:00:05Z') });
    const calls = f.calls.length;
    await assert.rejects(f.fetchBatch([record()]), { code: 'github_rate_limited' });
    assert.equal(f.calls.length, calls);
    f.advance(5000);
    remaining = 5000;
    const result = await f.fetchBatch([record()]);
    assert.equal(result.get(record().id).qualityComplete, true);
    assert.equal(f.calls.length, calls + 2);
});

test('primary cost reserve prevents expensive bulk queries before exhausting the shared quota', async () => {
    const f = fixture(() => ({ data: { rateLimit: quota(1199) } }));
    await assert.rejects(f.fetchBatch(Array.from({ length: 10 }, (_, i) => record(i + 1))), { code: 'github_rate_limited' });
    assert.equal(f.calls.length, 1);
});

test('Retry-After seconds and HTTP dates, reset headers and GraphQL limits pause subsequent requests', async () => {
    for (const [response, wait] of [
        [{ status: 429, headers: { 'Retry-After': '120' }, data: {} }, 120_000],
        [{ status: 403, headers: { 'Retry-After': 'Thu, 01 Jan 2026 12:02:00 GMT' }, data: { message: 'secondary rate limit' } }, 120_000],
        [{ status: 403, headers: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String(Date.parse(at) / 1000 + 180) }, data: {} }, 180_000],
        [{ data: { rateLimit: quota(0, '2026-01-01T12:03:00Z') }, errors: [{ type: 'RATE_LIMITED' }] }, 180_000],
    ]) {
        let limited = true;
        const f = fixture((query) => query.includes('p0:') && limited ? response : undefined);
        const deadline = Date.parse(at) + 1000 + wait;
        let retryAt;
        await assert.rejects(f.fetchBatch([record()]), (error) => { retryAt = error.retryAt; return error.code === 'github_rate_limited'; });
        assert.ok(retryAt >= deadline - 1000 && retryAt <= deadline);
        const count = f.calls.length;
        await assert.rejects(f.fetchBatch([record()]), { code: 'github_rate_limited' });
        assert.equal(f.calls.length, count);
        f.advance(wait + 1000);
        limited = false;
        assert.equal((await f.fetchBatch([record()])).get(record().id).qualityComplete, true);
    }
});

test('missing quota evidence blocks bulk queries and empty batches perform no requests', async () => {
    const f = fixture(() => ({ data: {} }));
    assert.equal((await f.fetchBatch([])).size, 0);
    assert.equal(f.calls.length, 0);
    await assert.rejects(f.fetchBatch([record()]));
    assert.equal(f.calls.length, 1);
});

test('bulk or pagination responses cannot reuse stale quota when rate-limit evidence disappears', async () => {
    const f = fixture((query) => query.includes('p0:') ? { data: { p0: { pullRequest: pull() } } } : undefined);
    await assert.rejects(f.fetchBatch([record()]));
    await assert.rejects(f.fetchBatch([record()]));
    assert.equal(f.calls.length, 4); // Each retry must re-probe instead of trusting stale quota.
});

test('concurrent callers still execute requests serially with conservative inter-request pacing', async () => {
    let active = 0, maximum = 0;
    const f = fixture(async () => {
        active++;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setImmediate(resolve));
        active--;
    });
    await Promise.all([f.fetchBatch([record()]), f.fetchBatch([record(2)])]);
    assert.equal(maximum, 1);
    assert.ok(f.calls.every((call, i) => i === 0 || call.at - f.calls[i - 1].at >= 1000));
});

test('compaction retains only progression evidence across both path separators', () => {
    const files = ['src/app.js', 'tests/app.js', 'src\\Tests\\Service.cs', 'ServiceTests.cs', 'README.md', 'docs\\guide.rst', '__tests__/unit.js', 'app.spec.ts']
        .map((path) => ({ path }));
    assert.deepEqual(compactFiles(files), files.slice(1));
});
