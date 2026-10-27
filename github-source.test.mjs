import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createGitHubSource as sourceFactory, GitHubSourceError } from "./github-source.mjs";

const identity = { login: "kylegstewart", id: 169726395, host: "github.com" };
const user = { ...identity, type: "User" };
const at = "2026-01-01T12:00:00Z";
const repo = "accessible/team";
// Existing transport fixtures use an explicit repository; production has no implicit all-repositories scope.
const createGitHubSource = (options) => {
    const source = sourceFactory(options);
    return { fetchActivity: (input = {}) => source.fetchActivity({ repositories: [repo], ...input }) };
};
const actor = (login = identity.login, type = "User") => ({ login, type });
const pull = (number, extra = {}) => ({
    number, url: `https://api.github.com/repos/${repo}/pulls/${number}`,
    repository_url: `https://api.github.com/repos/${repo}`,
    pull_request: { url: `https://api.github.com/repos/${repo}/pulls/${number}`, merged_at: at },
    user: actor(), title: `PR ${number}`, created_at: at, updated_at: at, closed_at: at,
    state: "closed", draft: false, body: "A private PR description that must not be retained",
    labels: [{ name: "bug" }], ...extra,
});
const detail = (number, extra = {}) => ({
    ...pull(number), merged_at: at, head: { sha: "abc123" }, additions: 20, deletions: 4, changed_files: 1, ...extra,
});
const review = (id = 11, extra = {}) => ({
    id, user: actor("colleague"), state: "APPROVED", submitted_at: at,
    body: "Looks good", commit_id: "abc123", ...extra,
});
const comment = (id = 21, extra = {}) => ({
    id, user: actor("coderabbitai[bot]", "Bot"), body: "Handle null input.",
    created_at: at, path: "src\\file.js", pull_request_review_id: 11, in_reply_to_id: null, ...extra,
});
const file = { filename: "src\\file.js", additions: 20, deletions: 4, patch: "must not persist" };
const searchResult = (items = [], extra = {}) => ({ total_count: items.length, incomplete_results: false, items, ...extra });
const queryOf = (endpoint) => new URL(`https://api.github.com${endpoint}`).searchParams;

function fixture({ search, pr, reviews, comments, files, intercept } = {}) {
    const calls = [];
    const request = async (endpoint) => {
        calls.push(endpoint);
        const custom = await intercept?.(endpoint);
        if (custom !== undefined) return custom;
        if (endpoint === "/user") return user;
        if (endpoint.startsWith("/search/issues?")) {
            return search ? search(queryOf(endpoint), endpoint) : searchResult([pull(1)]);
        }
        const match = /^\/repos\/accessible\/team\/pulls\/(\d+)(?:\/(reviews|comments|files))?(?:\?|$)/.exec(endpoint);
        assert.ok(match, `Unexpected or unsafe endpoint: ${endpoint}`);
        const number = Number(match[1]);
        const page = Number(queryOf(endpoint).get("page") || 1);
        if (!match[2]) return pr ? pr(number) : detail(number);
        if (match[2] === "reviews") return reviews ? reviews(number, page) : [review()];
        if (match[2] === "comments") return comments ? comments(number, page) : [comment()];
        return files ? files(number, page) : [file];
    };
    return { request, calls };
}

test("detail fetching uses at most four parallel requests and drains history without losing records", async () => {
    let active = 0, maximum = 0;
    const f = fixture({ search: () => searchResult(Array.from({ length: 45 }, (_, i) => pull(i + 1))) });
    const source = createGitHubSource({ request: async (endpoint) => {
        if (!endpoint.startsWith('/repos/')) return f.request(endpoint);
        active++;
        maximum = Math.max(maximum, active);
        try { await new Promise((resolve) => setImmediate(resolve)); return await f.request(endpoint); }
        finally { active--; }
    } });
    const first = await source.fetchActivity();
    assert.equal(maximum, 4);
    assert.equal(first.processed, 40);
    assert.equal(first.complete, false);
    const last = await source.fetchActivity({ identity, records: first.records, cursor: first.cursor });
    assert.equal(last.complete, true);
    assert.equal(last.processed, 5);
    assert.equal(last.records.length, 45);
    assert.ok(last.records.every((record) => record.qualityComplete && record.filesComplete));
});

test("normalizes REST evidence, preserves bot attribution, and discards unrelated payloads", async () => {
    const f = fixture();
    const result = await createGitHubSource(f).fetchActivity({ onProgress() { throw new Error("UI failure"); } });
    assert.equal(result.complete, true);
    assert.deepEqual(result.identity, identity);
    assert.equal(result.records.length, 1); // Author/reviewer search deduplicated.
    const record = result.records[0];
    assert.equal(record.id, "accessible/team#1");
    assert.equal(record.state, "merged");
    assert.equal(record.author, identity.login);
    assert.equal(record.authorType, "User");
    assert.equal(record.bodyPresent, true);
    assert.equal(record.qualityComplete, true);
    assert.equal(record.filesComplete, true);
    assert.deepEqual(record.files, [{ path: file.filename, additions: 20, deletions: 4 }]);
    assert.deepEqual(record.labels, ["bug"]);
    assert.equal(record.reviews[0].commitId, "abc123");
    assert.equal(record.headCommitId, "abc123");
    assert.equal(record.comments[0].authorType, "Bot");
    assert.equal(record.comments[0].reviewId, "11");
    assert.equal(record.comments[0].inReplyToId, null);
    assert.equal(Object.hasOwn(record.comments[0], "resolved"), false);
    assert.equal(JSON.stringify(result).includes("private PR description"), false);
    assert.equal(JSON.stringify(result).includes("must not persist"), false);
    assert.ok(f.calls.every((endpoint) => !endpoint.includes("graphql") && !endpoint.includes("/issues/")));
    assert.ok(f.calls.filter((endpoint) => endpoint.startsWith("/search")).every((endpoint) => !decodeURIComponent(endpoint).includes("org:")));
});

test("REST merger attribution survives cache normalization and unchanged closed records are not downloaded again", async () => {
    const f = fixture({ pr: (number) => detail(number, { merged_by: actor("release-manager") }) });
    const source = createGitHubSource(f);
    const first = await source.fetchActivity();
    assert.equal(first.records[0].mergedBy, "release-manager");
    assert.equal(first.records[0].mergedByType, "User");
    assert.equal(first.records[0].mergerComplete, true);
    assert.equal(first.records[0].mergerChecked, true);
    assert.equal(first.discoveryVersion, 3);
    f.calls.length = 0;
    const next = await source.fetchActivity({ identity, records: first.records, lastSync: { at: first.watermark, discoveryVersion: first.discoveryVersion } });
    assert.equal(next.complete, true);
    assert.equal(next.records[0].mergedBy, "release-manager");
    assert.equal(f.calls.some((endpoint) => endpoint.startsWith("/repos/")), false);
    assert.ok(f.calls.filter((endpoint) => endpoint.startsWith("/search/")).every((endpoint) => queryOf(endpoint).get("q").includes("updated:>=")));
});

test("explicit refresh backfills completed cached merges even outside search overlap, then stops retrying unknown actors", async () => {
    const seed = await createGitHubSource(fixture()).fetchActivity();
    for (const raw of [{ merged_by: actor() }, { merged_by: null }, {}]) {
        const { mergedBy, mergedByType, mergerComplete, mergerChecked, ...legacy } = seed.records[0];
        const f = fixture({ search: () => searchResult(), pr: (number) => detail(number, raw) });
        const source = createGitHubSource(f);
        const first = await source.fetchActivity({ identity, records: [legacy], lastSync: { at, discoveryVersion: 3 } });
        assert.equal(first.complete, true);
        assert.equal(first.processed, 1);
        assert.equal(first.records[0].mergerChecked, true);
        assert.equal(first.records[0].mergedBy, raw.merged_by?.login || null);
        assert.equal(first.records[0].mergerComplete, Object.hasOwn(raw, "merged_by"));
        assert.equal(first.records[0].qualityComplete, true);
        f.calls.length = 0;
        const next = await source.fetchActivity({ identity, records: first.records, lastSync: { at: first.watermark, discoveryVersion: 3 } });
        assert.equal(next.processed, 0);
        assert.equal(f.calls.some((endpoint) => endpoint.startsWith("/repos/")), false);
        assert.deepEqual(next.records, first.records);
    }
});

test("legacy durable cursors restart full scoped history under explicit union semantics", async () => {
    const cursor = JSON.stringify({ version: 2, identityId: identity.id, host: identity.host, login: identity.login,
        repositories: [repo], at: "2026-02-03T00:00:00Z", since: "2026-02-02T00:00:00Z", search: [], details: [] });
    const f = fixture({ search: (params) => {
        const query = params.get("q");
        assert.match(query, /repo:accessible\/team/);
        assert.doesNotMatch(query, /updated:/);
        return searchResult([pull(1)]);
    }, pr: (number) => detail(number, { user: actor("colleague"), merged_by: actor() }) });
    const result = await createGitHubSource(f).fetchActivity({ identity, repositories: [repo], cursor });
    assert.equal(result.complete, true);
    assert.equal(result.discoveryVersion, 3);
    assert.ok(result.warnings.some((warning) => warning.includes("changed scope")));
    assert.equal(result.records[0].author, "colleague");
    assert.equal(result.records[0].mergedBy, identity.login);
    assert.equal(f.calls.filter((endpoint) => endpoint.startsWith("/search")).length, 3);
});

test("legacy completed imports backfill only the new discovery role historically, then all roles use incremental overlap", async () => {
    const f = fixture({ search: () => searchResult() });
    const source = createGitHubSource(f);
    const first = await source.fetchActivity({ identity, lastSync: { at: "2026-02-03T00:00:00Z" }, repositories: [repo] });
    const queries = f.calls.filter((endpoint) => endpoint.startsWith("/search")).map((endpoint) => queryOf(endpoint).get("q"));
    assert.equal(queries.length, 3);
    assert.doesNotMatch(queries.find((query) => query.includes("merged-by:")), /updated:/);
    assert.ok(queries.filter((query) => !query.includes("merged-by:")).every((query) => query.includes("updated:>=")));
    f.calls.length = 0;
    await source.fetchActivity({ identity, lastSync: { at: first.watermark, discoveryVersion: first.discoveryVersion }, repositories: [repo] });
    assert.ok(f.calls.filter((endpoint) => endpoint.startsWith("/search")).every((endpoint) => queryOf(endpoint).get("q").includes("updated:>=")));
});

test("historical pagination discovers all records before bounded detail work, then resumes", async () => {
    const all = Array.from({ length: 101 }, (_, i) => pull(i + 1));
    const f = fixture({
        search: (params) => searchResult(all.slice((Number(params.get("page")) - 1) * 100, Number(params.get("page")) * 100), { total_count: 101 }),
        // More than forty open PRs must still finish a resumable batch.
        pr: (number) => detail(number, { state: "open", merged_at: null, closed_at: null }),
    });
    const source = createGitHubSource(f);
    let result = await source.fetchActivity();
    assert.equal(result.records.length, 101);
    assert.equal(result.complete, false);
    assert.equal(result.records.filter((record) => record.qualityComplete).length, 40);
    const searchCalls = f.calls.filter((endpoint) => endpoint.startsWith("/search")).length;
    assert.equal(searchCalls, 6);
    assert.ok(f.calls.indexOf(f.calls.find((endpoint) => endpoint.includes("/pulls/1"))) > 6);
    for (let i = 0; i < 2; i++) {
        result = await source.fetchActivity({ identity, records: result.records, lastSync: { at, cursor: result.cursor } });
    }
    assert.equal(result.complete, true);
    assert.equal(result.cursor, undefined);
    assert.equal(result.records.filter((record) => record.qualityComplete).length, 101);
    assert.equal(f.calls.filter((endpoint) => endpoint.startsWith("/search")).length, searchCalls);
});

test("partitions >1000 results into disjoint creation-time ranges", async () => {
    let rootEnd;
    const ranges = [];
    const f = fixture({
        search: (params) => {
            const q = params.get("q");
            if (q.includes("reviewed-by:") || q.includes("merged-by:")) return searchResult([pull(1), pull(2)]);
            const match = /created:(\S+)\.\.(\S+)/.exec(q);
            const start = Date.parse(match[1]) / 1000;
            const end = Date.parse(match[2]) / 1000;
            rootEnd ??= end;
            if (start === 0 && end === rootEnd) return searchResult([], { total_count: 1001 });
            ranges.push([start, end]);
            return searchResult([pull(start === 0 ? 1 : 2)]);
        },
    });
    const result = await createGitHubSource(f).fetchActivity();
    assert.equal(result.complete, true);
    assert.equal(result.records.length, 2);
    assert.equal(ranges.length, 2);
    assert.equal(ranges[0][0], 0);
    assert.equal(ranges[0][1] + 1, ranges[1][0]);
    assert.equal(ranges[1][1], rootEnd);
});

test("paginates review and comment evidence without persisting false resolution claims", async () => {
    const f = fixture({
        reviews: (_, page) => page === 1 ? Array.from({ length: 100 }, (_, i) => review(i + 1)) : [review(101, { state: "CHANGES_REQUESTED" })],
        comments: (_, page) => page === 1 ? Array.from({ length: 100 }, (_, i) => comment(i + 1)) : [
            comment(101, { user: actor("colleague"), body: "Resolved by author", in_reply_to_id: 1, original_line: 4, line: null }),
        ],
    });
    const { records: [record], complete } = await createGitHubSource(f).fetchActivity();
    assert.equal(complete, true);
    assert.equal(record.reviews.length, 101);
    assert.equal(record.comments.length, 101);
    assert.equal(record.reviews[100].state, "CHANGES_REQUESTED");
    assert.equal(record.comments[100].inReplyToId, "1");
    assert.equal(Object.hasOwn(record.comments[100], "resolved"), false);
});

test("retains reviewed-by candidates without fabricating submitted reviews or human authorship", async () => {
    const f = fixture({
        search: (params) => searchResult(params.get("q").includes("author:") ? [] : [pull(1, { user: actor("someone-else") })]),
        pr: () => detail(1, { user: actor("someone-else"), body: null, merged_at: null }),
        reviews: () => [], comments: () => [],
    });
    const result = await createGitHubSource(f).fetchActivity();
    assert.equal(result.complete, true);
    assert.equal(result.records[0].state, "closed");
    assert.equal(result.records[0].bodyPresent, false);
    assert.deepEqual(result.records[0].reviews, []);
    assert.equal(result.records[0].qualityComplete, true); // Complete evidence is NOT proof of approval.
});

test("incremental overlap reuses unchanged closed detail and refreshes cached open PRs", async () => {
    const initial = await createGitHubSource(fixture()).fetchActivity();
    const closed = initial.records[0];
    const open = { ...closed, id: `${repo}#2`, number: 2, state: "open", mergedAt: null, closedAt: null };
    const f = fixture();
    const result = await createGitHubSource(f).fetchActivity({
        identity, records: { [closed.id]: closed, [open.id]: open }, lastSync: { at: "2026-02-03T00:00:00Z", discoveryVersion: 3 },
    });
    assert.equal(result.complete, true);
    assert.equal(f.calls.some((endpoint) => endpoint === `/repos/${repo}/pulls/1`), false);
    assert.equal(f.calls.some((endpoint) => endpoint === `/repos/${repo}/pulls/2`), true);
    assert.ok(f.calls.filter((endpoint) => endpoint.startsWith("/search")).every((endpoint) =>
        queryOf(endpoint).get("q").includes("updated:>=2026-02-02T00:00:00.000Z")));
});

test("changed PR with failed detail keeps prior review evidence but disables stale quality", async () => {
    const initial = await createGitHubSource(fixture()).fetchActivity();
    const f = fixture({
        search: () => searchResult([pull(1, { updated_at: "2026-02-03T00:00:00Z" })]),
        pr: () => { throw { status: 404, message: "secret_token=do-not-print" }; },
    });
    const result = await createGitHubSource(f).fetchActivity({ identity, records: initial.records, lastSync: at });
    assert.equal(result.complete, true);
    assert.equal(result.records[0].detailFailure.terminal, true);
    assert.deepEqual(result.records[0].reviews, initial.records[0].reviews);
    assert.deepEqual(result.records[0].files, initial.records[0].files);
    assert.equal(result.records[0].qualityComplete, false);
    assert.equal(result.records[0].filesComplete, false);
    assert.equal(JSON.stringify(result).includes("secret_token"), false);
});

test("failed review permissions never grant a quality bonus; file refresh remains independent", async () => {
    const f = fixture({ comments: () => { throw { status: 404 }; } });
    const result = await createGitHubSource(f).fetchActivity();
    assert.equal(result.complete, true);
    assert.equal(result.records[0].qualityComplete, false);
    assert.equal(result.records[0].filesComplete, true);
    assert.equal(result.records[0].detailFailure.terminal, true);
    assert.equal(result.cursor, undefined);
});

test("missing reviewer identity and incomplete file counts are explicitly partial", async () => {
    const f = fixture({ reviews: () => [review(1, { user: null })], pr: () => detail(1, { changed_files: 2 }) });
    const result = await createGitHubSource(f).fetchActivity();
    assert.equal(result.complete, false);
    assert.equal(result.records[0].qualityComplete, false);
    assert.equal(result.records[0].filesComplete, false);
    assert.equal(result.records[0].reviews[0].author, null);
});

test("incomplete search is resumable and never advances or starts expensive details", async () => {
    let incomplete = true;
    const f = fixture({ search: () => searchResult([pull(1)], { incomplete_results: incomplete }) });
    const source = createGitHubSource(f);
    const partial = await source.fetchActivity();
    assert.equal(partial.complete, false);
    assert.equal(f.calls.some((endpoint) => endpoint.startsWith("/repos/")), false);
    assert.equal(JSON.parse(partial.cursor).search[0].page, 1);
    incomplete = false;
    const result = await source.fetchActivity({ identity, records: partial.records, lastSync: { cursor: partial.cursor } });
    assert.equal(result.complete, true);
});

test("short search pages do not become complete on repeated resumptions", async () => {
    const f = fixture({ search: () => searchResult([pull(1)], { total_count: 2 }) });
    const source = createGitHubSource(f);
    let result = await source.fetchActivity();
    for (let i = 0; i < 3; i++) {
        assert.equal(result.complete, false);
        assert.equal(JSON.parse(result.cursor).search[0].page, 1);
        result = await source.fetchActivity({ identity, records: result.records, lastSync: { cursor: result.cursor } });
    }
    assert.equal(result.complete, false);
});

test("repeated search and detail pages are detected instead of silently truncating", async () => {
    const repeated = Array.from({ length: 100 }, (_, i) => pull(i + 1));
    const searchFixture = fixture({ search: () => searchResult(repeated, { total_count: 200 }) });
    const discovery = await createGitHubSource(searchFixture).fetchActivity();
    assert.equal(discovery.complete, false);
    assert.ok(discovery.warnings.some((warning) => warning.includes("repeated")));
    const detailFixture = fixture({ reviews: () => Array.from({ length: 100 }, (_, i) => review(i + 1)) });
    const evidence = await createGitHubSource(detailFixture).fetchActivity();
    assert.equal(evidence.complete, false);
    assert.equal(evidence.records[0].qualityComplete, false);
});

test("rate limits stop requests without hammering and preserve discovered records", async () => {
    const f = fixture({
        intercept: (endpoint) => endpoint.endsWith("/reviews?per_page=100&page=1")
            ? { data: {}, status: 429, headers: { "retry-after": "120" } } : undefined,
    });
    const source = createGitHubSource(f);
    const result = await source.fetchActivity();
    assert.equal(result.complete, false);
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].qualityComplete, false);
    assert.ok(result.retryAt >= Date.now() + 119_000);
    assert.equal(f.calls.filter((endpoint) => endpoint.includes("/files?")).length, 0);
    const calls = f.calls.length;
    await assert.rejects(source.fetchActivity(), (error) => error instanceof GitHubSourceError && error.code === "github_rate_limited");
    assert.equal(f.calls.length, calls);
});

test("rate-limit headers prevent the next request even after successful responses", async () => {
    const f = fixture({ intercept: (endpoint) => endpoint === "/user"
        ? { data: user, status: 200, headers: { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + 120) } } : undefined });
    const result = await createGitHubSource(f).fetchActivity();
    assert.equal(result.complete, false);
    assert.deepEqual(f.calls, ["/user"]);
});

test("identity mismatch, bot identity, and authentication failures cannot mix caches", async () => {
    await assert.rejects(createGitHubSource(fixture()).fetchActivity({ identity: { ...identity, id: 7 } }), { code: "github_identity_mismatch" });
    await assert.rejects(createGitHubSource({ request: async () => ({ ...user, type: "Bot" }) }).fetchActivity(), GitHubSourceError);
    await assert.rejects(createGitHubSource({ request: async () => { throw { status: 401, message: "credential-secret" }; } }).fetchActivity(),
        (error) => error.status === 401 && !error.message.includes("credential-secret"));
});

test("malformed cursor restarts historical discovery rather than trusting a partial watermark", async () => {
    const f = fixture();
    const result = await createGitHubSource(f).fetchActivity({ lastSync: { at, cursor: '{"version":999}' } });
    assert.equal(result.complete, true);
    assert.ok(result.warnings.some((warning) => warning.includes("Invalid")));
    assert.ok(f.calls.filter((endpoint) => endpoint.startsWith("/search")).every((endpoint) => !queryOf(endpoint).get("q").includes("updated:")));
});

test("wrongly attributed search results and missing numeric PR data cannot be complete", async () => {
    const wrong = await createGitHubSource(fixture({ search: () => searchResult([pull(1, { user: actor("other-user") })]) })).fetchActivity();
    assert.equal(wrong.complete, false);
    assert.equal(wrong.records.length, 0);
    const missing = await createGitHubSource(fixture({ pr: () => detail(1, { additions: undefined }) })).fetchActivity();
    assert.equal(missing.complete, false);
    assert.equal(missing.records[0].additions, null);
    assert.equal(missing.records[0].qualityComplete, false);
});

test("production transport is execFile with explicit host, read-only query transport, timeout, and bounded output", async () => {
    const source = await readFile(new URL("./github-source.mjs", import.meta.url), "utf8");
    assert.match(source, /execFileAsync\("gh"/);
    assert.match(source, /"--hostname", "github\.com", "--method", query \? "POST" : "GET"/);
    assert.match(source, /ghRequest\('graphql', query\)/);
    assert.match(source, /timeout: 30_000/);
    assert.match(source, /maxBuffer: 16 \* 1024 \* 1024/);
    assert.doesNotMatch(source, /shell:\s*true|execSync|spawnSync|writeFile/);
});

test("repository scopes are canonicalized, deduplicated, and queried individually", async () => {
    const f = fixture({ search: () => searchResult() });
    const result = await createGitHubSource(f).fetchActivity({
        identity: { id: identity.id, host: identity.host },
        repositories: ["Accessible/TEAM", "other/project", "accessible/team"],
    });
    assert.equal(result.complete, true);
    const queries = f.calls.filter((endpoint) => endpoint.startsWith("/search")).map((endpoint) => queryOf(endpoint).get("q"));
    assert.equal(queries.length, 6);
    for (const scope of ["accessible/team", "other/project"]) {
        assert.equal(queries.filter((q) => q.includes(` repo:${scope} `)).length, 3);
    }
    const all = fixture({ search: () => searchResult() });
    await createGitHubSource(all).fetchActivity({ repositories: [] });
    assert.equal(all.calls.length, 0);
});

test("organization discovery imports evidence once for overlapping organization and repository selections", async () => {
    const f = fixture();
    const result = await createGitHubSource(f).fetchActivity({ organizations: ["ACCESSIBLE"], repositories: [repo] });
    assert.equal(result.complete, true);
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].qualityComplete, true);
    assert.equal(result.records[0].filesComplete, true);
    assert.equal(result.processed, 1);
    assert.equal(f.calls.filter((endpoint) => endpoint.startsWith("/search")).length, 3);
    assert.ok(f.calls.filter((endpoint) => endpoint.startsWith("/search")).every((endpoint) => queryOf(endpoint).get("q").includes("org:accessible")));
    assert.equal(f.calls.filter((endpoint) => endpoint === "/repos/accessible/team/pulls/1").length, 1);
});

test("top-level cursor resumes pending historical details and retains the original watermark", async () => {
    const all = Array.from({ length: 41 }, (_, i) => pull(i + 1));
    const f = fixture({ search: () => searchResult(all) });
    const source = createGitHubSource(f);
    const first = await source.fetchActivity({ repositories: [repo] });
    assert.equal(first.complete, false);
    const saved = JSON.parse(first.cursor);
    assert.equal(first.watermark, saved.at);
    assert.deepEqual(saved.repositories, [repo]);
    assert.equal(saved.details.length, 1);
    assert.equal(saved.search.length, 0);
    const count = f.calls.length;
    const next = await source.fetchActivity({
        identity: { id: identity.id, host: identity.host }, records: first.records,
        repositories: ["ACCESSIBLE/TEAM"], cursor: first.cursor, lastSync: "2099-01-01T00:00:00Z",
    });
    assert.equal(next.complete, true);
    assert.equal(next.watermark, saved.at);
    assert.equal(next.records.filter((record) => record.qualityComplete).length, 41);
    assert.equal(f.calls.slice(count).some((endpoint) => endpoint.startsWith("/search")), false);
});

test("scope reset performs historical discovery but retains out-of-scope earned records", async () => {
    const initial = await createGitHubSource(fixture()).fetchActivity();
    const retained = { ...initial.records[0], repo: "old/project", id: "old/project#1",
        state: "open", qualityComplete: false, filesComplete: false };
    const f = fixture();
    const result = await createGitHubSource(f).fetchActivity({
        records: [retained], repositories: [repo], identity, lastSync: null, cursor: null,
    });
    assert.equal(result.complete, true);
    assert.equal(result.records.length, 2);
    assert.deepEqual(result.records.find((record) => record.id === retained.id).reviews, retained.reviews);
    assert.ok(f.calls.every((endpoint) => !endpoint.startsWith("/repos/old/project")));
    assert.ok(f.calls.filter((endpoint) => endpoint.startsWith("/search")).every((endpoint) => !queryOf(endpoint).get("q").includes("updated:")));
});

test("a scope-mismatched cursor restarts discovery, and explicit null overrides embedded cursors", async () => {
    const first = await createGitHubSource(fixture({ search: () => searchResult([], { incomplete_results: true }) })).fetchActivity();
    const f = fixture();
    const result = await createGitHubSource(f).fetchActivity({
        identity, organizations: ["accessible"], repositories: [], cursor: first.cursor, lastSync: { at },
    });
    assert.equal(result.complete, true);
    assert.ok(result.warnings.some((warning) => warning.includes("changed scope")));
    assert.ok(f.calls.filter((endpoint) => endpoint.startsWith("/search")).every((endpoint) => !queryOf(endpoint).get("q").includes("updated:")));
    const explicit = fixture();
    const reset = await createGitHubSource(explicit).fetchActivity({ lastSync: { cursor: first.cursor }, cursor: null });
    assert.equal(reset.complete, true);
    assert.equal(reset.warnings.length, 0);
});

test("invalid scope fails before requesting, out-of-scope responses are partial, numeric identity survives login rename", async () => {
    for (const repositories of [["repo"], ["owner/repo is:issue"], ["../repo"], "owner/repo", [null]]) {
        const f = fixture();
        await assert.rejects(createGitHubSource(f).fetchActivity({ repositories }), { code: "github_invalid_scope" });
        assert.equal(f.calls.length, 0);
    }
    const scoped = await createGitHubSource(fixture()).fetchActivity({ repositories: ["different/repo"] });
    assert.equal(scoped.complete, false);
    assert.equal(scoped.records.length, 0);
    const renamed = await createGitHubSource(fixture()).fetchActivity({ identity: { ...identity, login: "old-login" } });
    assert.equal(renamed.identity.login, identity.login);
    await assert.rejects(createGitHubSource(fixture()).fetchActivity({ identity: { id: identity.id, host: "example.com" } }), { code: "github_identity_mismatch" });
});

test("headCommitId snapshots pull.head.sha without substituting the merge commit", async () => {
    const merged = await createGitHubSource(fixture({
        pr: () => detail(1, { head: { sha: "reviewed-head" }, merge_commit_sha: "different-merge-commit" }),
    })).fetchActivity();
    assert.equal(merged.records[0].headCommitId, "reviewed-head");
    const cached = await createGitHubSource(fixture()).fetchActivity({ identity, records: merged.records, lastSync: at });
    assert.equal(cached.records[0].headCommitId, "reviewed-head");
    for (const head of [undefined, null, {}, { sha: null }]) {
        const missing = await createGitHubSource(fixture({ pr: () => detail(1, { head, merge_commit_sha: "not-the-head" }) })).fetchActivity();
        assert.equal(missing.records[0].headCommitId, null);
    }
});

test("head changes invalidate stale detail and retain review timestamps for engine filtering", async () => {
    const initial = await createGitHubSource(fixture()).fetchActivity();
    const refreshed = await createGitHubSource(fixture({
        search: () => searchResult([pull(1, { updated_at: "2026-01-02T00:00:00Z" })]),
        pr: () => detail(1, { head: { sha: "new-head" }, updated_at: "2026-01-02T00:00:00Z" }),
        reviews: () => [review(11, { commit_id: "abc123" }), review(12, { commit_id: "new-head", submitted_at: "2026-01-02T00:00:00Z" })],
    })).fetchActivity({ identity, records: initial.records, lastSync: at });
    assert.equal(refreshed.records[0].headCommitId, "new-head");
    assert.equal(refreshed.records[0].reviews[0].commitId, "abc123");
    assert.ok(Date.parse(refreshed.records[0].reviews[1].submittedAt) > Date.parse(refreshed.records[0].mergedAt));
    const failed = await createGitHubSource(fixture({
        search: () => searchResult([pull(1, { updated_at: "2026-01-02T00:00:00Z" })]),
        pr: () => { throw { status: 404 }; },
    })).fetchActivity({ identity, records: initial.records, lastSync: at });
    assert.equal(failed.records[0].headCommitId, null);
    assert.equal(failed.records[0].qualityComplete, false);
});

test("final resumed batch returns original discovery watermark after clearing its cursor", async () => {
    const all = Array.from({ length: 41 }, (_, i) => pull(i + 1));
    const source = createGitHubSource(fixture({ search: () => searchResult(all) }));
    const first = await source.fetchActivity();
    const cursor = JSON.parse(first.cursor);
    cursor.at = "2026-01-03T00:00:00.000Z";
    const result = await source.fetchActivity({
        identity, records: first.records, cursor: JSON.stringify(cursor),
        lastSync: { at: "2026-10-26T00:00:00Z", complete: false, warnings: [] },
    });
    assert.equal(result.complete, true);
    assert.equal(result.cursor, undefined);
    assert.equal(result.watermark, cursor.at);
});

test("updated search results refresh merged PR review and comment backfill", async () => {
    const initial = await createGitHubSource(fixture()).fetchActivity();
    const updatedAt = "2026-01-03T00:00:00Z";
    const f = fixture({
        search: () => searchResult([pull(1, { updated_at: updatedAt })]),
        pr: () => detail(1, { updated_at: updatedAt }),
        reviews: () => [review(), review(12, { user: actor(), submitted_at: updatedAt, state: "COMMENTED", body: "Follow-up" })],
        comments: () => [comment(), comment(22, { created_at: updatedAt, body: "Acknowledged", in_reply_to_id: 21 })],
    });
    const result = await createGitHubSource(f).fetchActivity({
        identity, records: initial.records, lastSync: { at, complete: true, warnings: [] }, cursor: null,
    });
    assert.equal(result.complete, true);
    assert.equal(result.records[0].state, "merged");
    assert.equal(result.records[0].reviews.length, 2);
    assert.equal(result.records[0].comments.length, 2);
    assert.equal(result.records[0].updatedAt, updatedAt);
    assert.ok(f.calls.includes(`/repos/${repo}/pulls/1`));
    assert.ok(f.calls.some((endpoint) => endpoint.includes("/reviews?")));
    assert.ok(f.calls.some((endpoint) => endpoint.includes("/comments?")));
});

test("permanent permission failures drain healthy work and are not requeued after restart", async () => {
    const f = fixture({
        search: () => searchResult(Array.from({ length: 45 }, (_, i) => pull(i + 1))),
        pr: (number) => number === 1 ? { data: { message: "Resource not accessible by integration" }, status: 403, headers: {} } : detail(number),
    });
    const first = await createGitHubSource(f).fetchActivity();
    assert.equal(first.canContinue, true);
    assert.equal(first.records[0].detailFailure.terminal, true);
    assert.equal(first.retryAt, undefined);
    const last = await createGitHubSource(f).fetchActivity({ identity, records: first.records, cursor: first.cursor });
    assert.equal(last.complete, true);
    assert.equal(last.records.filter((record) => record.qualityComplete).length, 44);
    const count = f.calls.filter((endpoint) => endpoint === `/repos/${repo}/pulls/1`).length;
    const next = await createGitHubSource(f).fetchActivity({ identity, records: last.records, lastSync: { at: last.watermark }, cursor: null });
    assert.equal(next.complete, true);
    assert.equal(f.calls.filter((endpoint) => endpoint === `/repos/${repo}/pulls/1`).length, count);
    assert.ok(next.warnings.some((warning) => warning.includes("unavailable evidence")));
});

test("transient PR failures defer only that PR, have bounded retries and recover on updated evidence", async () => {
    const f = fixture({ search: () => searchResult([pull(1), pull(2)]), pr: (number) => {
        if (number === 1) throw { status: 503 };
        return detail(number);
    } });
    let result = await createGitHubSource(f).fetchActivity();
    assert.equal(result.records[1].qualityComplete, true);
    assert.equal(result.records[0].detailFailure.attempts, 1);
    assert.equal(result.pauseReason, "error");
    assert.ok(result.retryAt > Date.now());
    const calls = f.calls.filter((endpoint) => endpoint === `/repos/${repo}/pulls/1`).length;
    result = await createGitHubSource(f).fetchActivity({ identity, records: result.records, cursor: result.cursor });
    assert.equal(f.calls.filter((endpoint) => endpoint === `/repos/${repo}/pulls/1`).length, calls);
    for (let attempt = 2; attempt <= 3; attempt++) {
        result.records[0].detailFailure.retryAt = Date.now() - 1;
        result = await createGitHubSource(f).fetchActivity({ identity, records: result.records, cursor: result.cursor });
        assert.equal(result.records[0].detailFailure.attempts, attempt);
    }
    assert.equal(result.complete, true);
    assert.equal(result.records[0].detailFailure.terminal, true);
    const updated = "2026-02-03T00:00:00Z";
    const recovered = await createGitHubSource(fixture({ search: () => searchResult([pull(1, { updated_at: updated })]), pr: () => detail(1, { updated_at: updated }) })).fetchActivity({ identity, records: result.records, lastSync: { at }, cursor: null });
    assert.equal(recovered.complete, true);
    assert.equal(recovered.records[0].qualityComplete, true);
    assert.equal(recovered.records[0].detailFailure, undefined);
});

test("403 secondary limits differ from permission denial and honor absolute reset deadlines", async () => {
    for (const headers of [{ "Retry-After": "120" }, { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(Math.ceil(Date.now() / 1000) + 180) }]) {
        const f = fixture({ intercept: (endpoint) => endpoint === `/repos/${repo}/pulls/1` ? { data: { message: "API rate limit exceeded" }, status: 403, headers } : undefined });
        const result = await createGitHubSource(f).fetchActivity();
        assert.equal(result.complete, false);
        assert.equal(result.canContinue, false);
        assert.equal(result.pauseReason, "rate_limit");
        assert.ok(result.retryAt >= Date.now() + 119_000);
        assert.equal(result.records[0].detailFailure, undefined);
        assert.equal(f.calls.some((endpoint) => endpoint.includes("/reviews?")), false);
    }
});

test("a near primary reset is honored without adding an artificial minute", async () => {
    const reset = Math.ceil(Date.now() / 1000) + 5;
    const result = await createGitHubSource(fixture({ intercept: (endpoint) => endpoint === "/user"
        ? { data: user, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) } } : undefined })).fetchActivity();
    assert.equal(result.retryAt, reset * 1000);
    assert.equal(result.pauseReason, "rate_limit");
    assert.equal(result.complete, false);
    const denied = await createGitHubSource(fixture({ intercept: (endpoint) => endpoint === `/repos/${repo}/pulls/1`
        ? { data: { message: "API rate limit exceeded" }, status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) } } : undefined })).fetchActivity();
    assert.equal(denied.retryAt, reset * 1000);
    assert.equal(denied.pauseReason, "rate_limit");
});

test("authentication cooldown is an error pause rather than a rate-limit pause", async () => {
    let calls = 0;
    const source = createGitHubSource({ request: async () => { calls++; throw { status: 401 }; } });
    await assert.rejects(source.fetchActivity(), { status: 401 });
    await assert.rejects(source.fetchActivity(), { code: "github_source_unavailable" });
    assert.equal(calls, 1);
});

function bulkFixture({ total = 45, intercept, rest } = {}) {
    const graphCalls = [];
    const connection = (nodes = []) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
    const f = fixture({ search: () => searchResult(Array.from({ length: total }, (_, i) => pull(i + 1))), ...rest });
    const graphqlRequest = async (query) => {
        graphCalls.push(query);
        const rateLimit = { cost: 30, remaining: 5000, resetAt: "2099-01-01T00:00:00Z" };
        const custom = await intercept?.(query, rateLimit);
        if (custom !== undefined) return custom;
        const data = { rateLimit };
        for (const [, index, number] of query.matchAll(/p(\d+):repository.*?pullRequest\(number:(\d+)\)/g)) {
            data[`p${index}`] = { pullRequest: {
                id: `PR_${number}`, number: Number(number), title: `PR ${number}`,
                author: { login: identity.login, __typename: "User" }, createdAt: at, updatedAt: at, closedAt: at, mergedAt: at,
                state: "MERGED", isDraft: false, additions: 20, deletions: 4, changedFiles: 1, body: "private description", headRefOid: "abc123",
                labels: connection([{ name: "bug" }]),
                reviews: connection([{ fullDatabaseId: "11", author: { login: "colleague", __typename: "User" }, body: "Looks good",
                    state: "APPROVED", submittedAt: at, commit: { oid: "abc123" } }]),
                reviewThreads: connection(),
                files: { ...connection([{ path: "tests/app.test.js", additions: 20, deletions: 4 }]), totalCount: 1 },
            } };
        }
        return { data };
    };
    return { ...f, graphqlRequest, graphCalls };
}

test("failed merger-only backfill preserves unchanged verified quality and has bounded durable retries", async () => {
    for (const bulk of [false, true]) {
        let clock = Date.parse(at);
        const seed = await createGitHubSource(fixture()).fetchActivity();
        const { mergerChecked, mergerComplete, mergedBy, mergedByType, ...old } = seed.records[0];
        const f = bulk ? bulkFixture({ total: 1, intercept: (query, rateLimit) => query.includes("p0:")
            ? { data: { rateLimit, p0: null }, errors: [{ type: "NOT_FOUND", path: ["p0"] }] } : undefined })
            : fixture({ pr: () => { throw { status: 404 }; } });
        const source = createGitHubSource({ ...f, now: () => clock, sleep: async (ms) => { clock += ms; } });
        const result = await source.fetchActivity({ identity, records: [old], lastSync: { at, discoveryVersion: 3 } });
        assert.equal(result.records[0].qualityComplete, true);
        assert.equal(result.records[0].filesComplete, true);
        assert.deepEqual(result.records[0].reviews, old.reviews);
        assert.equal(result.records[0].mergedBy, null);
        assert.equal(result.records[0].mergerComplete, false);
        assert.equal(result.records[0].detailFailure.terminal, true);
        const count = bulk ? f.graphCalls.length : f.calls.filter((endpoint) => endpoint.startsWith("/repos/")).length;
        const again = await source.fetchActivity({ identity, records: result.records, lastSync: { at: result.watermark, discoveryVersion: result.discoveryVersion } });
        assert.equal(again.processed, 0);
        assert.equal(bulk ? f.graphCalls.length : f.calls.filter((endpoint) => endpoint.startsWith("/repos/")).length, count);
    }
});

test("bulk backend drains 45 deduplicated authored/reviewed PRs with six queries, progress and a stable cursor watermark", async () => {
    let clock = Date.parse(at);
    const f = bulkFixture();
    const progress = [];
    const source = createGitHubSource({ ...f, now: () => clock, sleep: async (ms) => { clock += ms; } });
    const first = await source.fetchActivity({ repositories: [repo], onProgress: (value) => progress.push(value) });
    assert.equal(first.processed, 40);
    assert.equal(first.complete, false);
    assert.equal(first.canContinue, true);
    assert.equal(f.graphCalls.length, 5);
    const saved = JSON.parse(first.cursor);
    assert.equal(saved.details.length, 5);
    assert.equal(saved.search.length, 0);
    assert.equal(first.watermark, saved.at);
    const searchCalls = f.calls.length;
    const last = await source.fetchActivity({ identity, records: first.records, cursor: first.cursor, repositories: [repo] });
    assert.equal(last.processed, 5);
    assert.equal(last.records.length, 45);
    assert.equal(last.complete, true);
    assert.equal(last.watermark, saved.at);
    assert.equal(last.cursor, undefined);
    assert.equal(f.graphCalls.length, 6);
    assert.ok(last.records.every((record) => record.qualityComplete && record.filesComplete && record.headCommitId === "abc123"));
    assert.equal(f.calls.length, searchCalls + 1); // Only identity, not repeated search or any per-PR REST.
    assert.ok(f.calls.every((endpoint) => !endpoint.startsWith("/repos/")));
    assert.ok(progress.some((value) => value.phase === "Discovering GitHub PRs"));
    assert.equal(progress.filter((value) => value.phase === "Reading bulk GitHub history").at(-1).fetched, 40);
    assert.equal(JSON.stringify(last).includes("private description"), false);
});

test("unchanged closed bulk records are cached idempotently without GraphQL or per-PR REST calls", async () => {
    const f = bulkFixture({ total: 2 });
    let clock = Date.parse(at);
    const source = createGitHubSource({ ...f, now: () => clock, sleep: async (ms) => { clock += ms; } });
    const first = await source.fetchActivity();
    const second = await source.fetchActivity({ identity, records: first.records, lastSync: { at: first.watermark } });
    assert.deepEqual(second.records, first.records);
    assert.equal(second.processed, 0);
    assert.equal(f.graphCalls.length, 2);
    assert.ok(f.calls.every((endpoint) => !endpoint.startsWith("/repos/")));
});

test("bulk permanent permission errors cannot block healthy records and survive cache reload", async () => {
    const f = bulkFixture({ total: 2 });
    const original = f.graphqlRequest;
    f.graphqlRequest = async (query) => {
        const response = await original(query);
        if (response.data.p0) {
            response.data.p0 = null;
            response.errors = [{ type: "FORBIDDEN", path: ["p0", "pullRequest"] }];
        }
        return response;
    };
    const first = await createGitHubSource({ ...f, sleep: async () => {} }).fetchActivity();
    assert.equal(first.complete, true);
    assert.equal(first.records[0].detailFailure.terminal, true);
    assert.equal(first.records[0].qualityComplete, false);
    assert.equal(first.records[1].qualityComplete, true);
    const fresh = bulkFixture({ total: 2 });
    const next = await createGitHubSource({ ...fresh, sleep: async () => {} }).fetchActivity({ identity, records: first.records, lastSync: { at } });
    assert.equal(next.complete, true);
    assert.equal(fresh.graphCalls.length, 0);
    assert.ok(next.warnings.some((warning) => warning.includes("unavailable evidence")));
});

test("transient bulk alias failures retry only failed PRs, defer with the injected clock and stop after three attempts", async () => {
    let clock = Date.parse(at);
    const f = bulkFixture({ total: 2 });
    const original = f.graphqlRequest;
    f.graphqlRequest = async (query) => {
        const response = await original(query);
        if (query.includes("number:1)")) {
            response.data.p0 = null;
            response.errors = [{ type: "INTERNAL", path: ["p0", "pullRequest", "reviews"] }];
        }
        return response;
    };
    const source = createGitHubSource({ ...f, now: () => clock, sleep: async (ms) => { clock += ms; } });
    let result = await source.fetchActivity();
    assert.equal(result.records[0].detailFailure.status, null);
    assert.equal(result.records[1].qualityComplete, true);
    assert.equal(result.complete, false);
    assert.equal(result.canContinue, false);
    assert.equal(result.retryAt, clock + 300_000);
    const calls = f.graphCalls.length;
    result = await source.fetchActivity({ identity, records: result.records, cursor: result.cursor });
    assert.equal(f.graphCalls.length, calls);
    for (let attempt = 2; attempt <= 3; attempt++) {
        clock = result.retryAt;
        result = await source.fetchActivity({ identity, records: result.records, cursor: result.cursor });
        assert.equal(result.records[0].detailFailure.attempts, attempt);
        assert.equal(f.graphCalls.at(-1).includes("number:2)"), false);
    }
    assert.equal(result.complete, true);
    assert.equal(result.records[0].detailFailure.terminal, true);
    assert.equal(result.records[0].qualityComplete, false);
});

test("unknown GraphQL author retains base XP inputs and verified files, not clean evidence, with bounded retries", async () => {
    let clock = Date.parse(at);
    const f = bulkFixture({ total: 1 });
    const original = f.graphqlRequest;
    f.graphqlRequest = async (query) => {
        const response = await original(query);
        if (response.data.p0) response.data.p0.pullRequest.reviews.nodes[0].author = null;
        return response;
    };
    const source = createGitHubSource({ ...f, now: () => clock, sleep: async (ms) => { clock += ms; } });
    let result = await source.fetchActivity();
    const [record] = result.records;
    assert.equal(record.qualityComplete, false);
    assert.equal(record.filesComplete, true);
    assert.equal(record.reviews[0].author, null);
    assert.equal(record.author, identity.login);
    assert.equal(record.state, "merged");
    assert.equal(record.additions, 20);
    assert.equal(record.changedFiles, 1);
    assert.equal(record.detailFailure.attempts, 1);
    for (let i = 0; i < 2; i++) {
        clock = result.retryAt;
        result = await source.fetchActivity({ identity, records: result.records, cursor: result.cursor });
    }
    assert.equal(result.complete, true);
    assert.equal(result.records[0].detailFailure.attempts, 3);
    assert.equal(result.records[0].qualityComplete, false);
});

test("bulk throttling preserves pending cursor without spending transient retries and resumes after reset", async () => {
    let clock = Date.parse(at), limited = true;
    const f = bulkFixture({ total: 2, intercept: (query) => query.includes("p0:") && limited
        ? { status: 403, headers: { "Retry-After": "120" }, data: { message: "secondary rate limit" } } : undefined });
    const source = createGitHubSource({ ...f, now: () => clock, sleep: async (ms) => { clock += ms; } });
    const first = await source.fetchActivity();
    assert.equal(first.complete, false);
    assert.equal(first.pauseReason, "rate_limit");
    assert.equal(first.retryAt, clock + 120_000);
    assert.equal(JSON.parse(first.cursor).details.length, 2);
    assert.ok(first.records.every((record) => !record.detailFailure && !record.qualityComplete));
    const calls = f.calls.length;
    await assert.rejects(source.fetchActivity({ identity, records: first.records, cursor: first.cursor }), { code: "github_rate_limited" });
    assert.equal(f.calls.length, calls);
    clock = first.retryAt;
    limited = false;
    const last = await source.fetchActivity({ identity, records: first.records, cursor: first.cursor });
    assert.equal(last.complete, true);
    assert.equal(last.records.filter((record) => record.qualityComplete).length, 2);
    assert.equal(last.watermark, first.watermark);
});

test("a failed bulk refresh invalidates stale complete evidence while retaining its previously observed rows", async () => {
    let clock = Date.parse(at);
    const f = bulkFixture({ total: 1 });
    let failed = false;
    const original = f.graphqlRequest;
    f.graphqlRequest = async (query) => {
        if (failed && query.includes("p0:")) return { data: { rateLimit: { cost: 1, remaining: 5000, resetAt: "2099-01-01T00:00:00Z" },
            p0: null }, errors: [{ type: "INTERNAL", path: ["p0", "pullRequest", "reviews"] }] };
        return original(query);
    };
    const source = createGitHubSource({ ...f, now: () => clock, sleep: async (ms) => { clock += ms; } });
    const first = await source.fetchActivity();
    const cached = { ...first.records[0], state: "open", mergedAt: null, closedAt: null };
    assert.equal(cached.qualityComplete, true);
    assert.equal(cached.filesComplete, true);
    failed = true;
    const next = await source.fetchActivity({ identity, records: [cached], lastSync: { at: first.watermark } });
    assert.equal(next.records[0].qualityComplete, false);
    assert.equal(next.records[0].filesComplete, false);
    assert.deepEqual(next.records[0].reviews, cached.reviews);
    assert.deepEqual(next.records[0].files, cached.files);
    assert.equal(next.records[0].detailFailure.terminal, false);
    assert.equal(next.records[0].detailFailure.attempts, 1);
    assert.equal(next.complete, false);
});

test("permanent discovery denial does not block other accessible searches", async () => {
    const f = fixture({ search: (params) => params.get("q").includes("author:") ? { data: {}, status: 403, headers: {} } : searchResult([pull(1)]) });
    const result = await createGitHubSource(f).fetchActivity();
    assert.equal(result.complete, true);
    assert.equal(result.processed, 1);
    assert.ok(result.warnings.some((warning) => warning.includes("Discovery unavailable")));
});

test("discovery request budgets checkpoint healthy pagination without an error cooldown", async () => {
    const f = fixture({ search: (params) => {
        const range = /created:(\S+)\.\.(\S+)/.exec(params.get("q"));
        const seconds = (Date.parse(range[2]) - Date.parse(range[1])) / 1000;
        return searchResult([], { total_count: seconds > 1_000_000 ? 1001 : 0 });
    } });
    const result = await createGitHubSource(f).fetchActivity();
    assert.equal(result.complete, false);
    assert.equal(result.canContinue, true);
    assert.equal(result.retryAt, undefined);
    assert.equal(f.calls.length, 600);
    assert.ok(JSON.parse(result.cursor).search.length);
});
