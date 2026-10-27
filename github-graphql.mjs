// Bulk read-only PR evidence. Connections are paginated explicitly; missing evidence stays unknown.
import { GitHubSourceError } from './github-source.mjs';

const actor = 'login __typename';
const pageInfo = 'pageInfo { hasNextPage endCursor }';
const reviewFields = `fullDatabaseId author { ${actor} } state submittedAt body commit { oid }`;
const commentFields = `fullDatabaseId author { ${actor} } body createdAt path replyTo { fullDatabaseId } pullRequestReview { fullDatabaseId }`;
const threadFields = `id comments(first:50) { nodes { ${commentFields} } ${pageInfo} }`;
const connections = `reviews(first:100) { nodes { ${reviewFields} } ${pageInfo} }
    reviewThreads(first:50) { nodes { ${threadFields} } ${pageInfo} }
    files(first:100) { totalCount nodes { path additions deletions } ${pageInfo} }`;
const fields = `id number title author { ${actor} } mergedBy { ${actor} } createdAt updatedAt closedAt mergedAt state isDraft
    additions deletions changedFiles body headRefOid labels(first:100) { nodes { name } ${pageInfo} }
    ${connections}`;
const relevantPath = (path) => /(^|\/)(tests?|__tests__)(\/|\.)|[.](test|spec)[.]|Tests?\.(cs|java)$|(^|\/)(docs?|readme)(\/|\.)|\.(md|rst)$/i.test(path.replaceAll('\\', '/'));
export const compactFiles = (files) => files.filter((file) => relevantPath(file.path || file.filename || ''));
const user = (value) => value?.login ? { login: value.login, type: value.__typename === 'Bot' ? 'Bot' : value.__typename === 'User' ? 'User' : null } : null;
const validCount = (value) => Number.isSafeInteger(value) && value >= 0;
const validDate = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const databaseId = (value) => typeof value === 'string' && /^[1-9]\d*$/.test(value)
    || Number.isSafeInteger(value) && value > 0;
const errorType = (error) => error.type || error.extensions?.code;
const hasFields = (value, names) => names.every((name) => Object.hasOwn(value, name));
const localFailure = (errors) => new GitHubSourceError('GitHub PR evidence is unavailable; cached progress is preserved.', {
    status: errors.some((error) => errorType(error) === 'UNAUTHORIZED') ? 401
        : errors.some((error) => errorType(error) === 'FORBIDDEN') ? 403
            : errors.some((error) => errorType(error) === 'NOT_FOUND') ? 404 : null,
});

export function createGraphQLDetails({ request, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
    let quota = null, nextRequest = 0, cooldownUntil = 0;
    let pending = Promise.resolve();
    function pause(resetAt, message = 'GitHub quota safety reserve reached; click Sync after the reset to resume.') {
        return new GitHubSourceError(message, { code: 'github_rate_limited', retryAt: Math.max(now() + 1000, Date.parse(resetAt) || now() + 60_000) });
    }
    async function execute(selection, estimate) {
        if (cooldownUntil > now()) throw pause(new Date(cooldownUntil).toISOString());
        if (quota && Date.parse(quota.resetAt) <= now()) quota = null;
        if (quota && quota.remaining < Math.max(200, estimate * 2)) throw pause(quota.resetAt);
        if (nextRequest > now()) await sleep(nextRequest - now());
        nextRequest = now() + 1000; // Serial requests stay below secondary point/concurrency limits.
        const envelope = await request(`query { rateLimit { cost remaining resetAt } ${selection} }`);
        nextRequest = now() + 1000;
        const wrapped = envelope && (Object.hasOwn(envelope, 'status') || Object.hasOwn(envelope, 'headers'));
        const response = wrapped ? envelope.data : envelope;
        const headers = Object.fromEntries(Object.entries(envelope?.headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
        if (validCount(response?.data?.rateLimit?.remaining) && validDate(response.data.rateLimit.resetAt)) quota = response.data.rateLimit;
        const errors = response?.errors || [];
        const retry = headers['retry-after'];
        if (envelope?.status === 429 || errors.some((error) => errorType(error) === 'RATE_LIMITED')
            || (envelope?.status === 403 && (retry || headers['x-ratelimit-remaining'] === '0' || /rate limit|secondary|abuse/i.test(response?.message || '')))) {
            const deadline = /^\d+(\.\d+)?$/.test(String(retry)) ? now() + Number(retry) * 1000 : Date.parse(retry);
            const reset = Number(headers['x-ratelimit-reset']) * 1000 || Date.parse(quota?.resetAt);
            cooldownUntil = Math.max(now() + 1000, Number.isFinite(deadline) ? deadline : reset > now() ? reset : now() + 60_000,
                headers['x-ratelimit-remaining'] === '0' && reset > now() ? reset : 0);
            throw pause(new Date(cooldownUntil).toISOString());
        }
        if (errors.some((error) => errorType(error) === 'MAX_NODE_LIMIT_EXCEEDED' || errorType(error) === 'RESOURCE_LIMITS_EXCEEDED')) {
            throw new GitHubSourceError('GitHub bulk query exceeded a resource limit; reducing the batch.', { code: 'github_graphql_overflow' });
        }
        if (errors.some((error) => errorType(error) === 'UNAUTHORIZED')) {
            throw new GitHubSourceError('GitHub authentication is unavailable; sign in with gh and retry.', { status: 401 });
        }
        if (envelope?.status >= 400 || !response?.data) throw new GitHubSourceError('GitHub bulk history request failed; cached progress is preserved.', { status: envelope?.status || null });
        // Field-local permission errors can be isolated to a PR. Global/schema/auth errors cannot.
        if (errors.some((error) => !error.path || !/^p\d+$/.test(String(error.path[0])))) {
            throw new GitHubSourceError('GitHub bulk history query returned incomplete data; cached progress is preserved.');
        }
        if (!validCount(response.data.rateLimit?.remaining) || !validDate(response.data.rateLimit?.resetAt)) {
            quota = null;
            throw new GitHubSourceError('GitHub did not return quota evidence; bulk requests are paused.');
        }
        return { data: response.data, errors };
    }
    function query(selection, estimate = 1) {
        const result = pending.then(() => execute(selection, estimate));
        pending = result.catch(() => {});
        return result;
    }
    async function nodes(connection, id, type, name, selection) {
        const result = [], ids = new Set();
        const append = (page) => {
            if (!page || !Array.isArray(page.nodes) || typeof page.pageInfo?.hasNextPage !== 'boolean') throw new GitHubSourceError('GitHub evidence connection is unavailable.');
            for (const node of page.nodes) {
                const key = node?.fullDatabaseId ?? node?.id ?? node?.path ?? node?.name;
                if (key == null || ids.has(String(key))) throw new GitHubSourceError('GitHub evidence pagination repeated or omitted identifiers.');
                ids.add(String(key));
                result.push(node);
            }
            return page.pageInfo;
        };
        let info = append(connection);
        const cursors = new Set();
        while (info.hasNextPage) {
            if (typeof info.endCursor !== 'string' || !info.endCursor || cursors.has(info.endCursor)) throw new GitHubSourceError('GitHub evidence pagination did not advance.');
            cursors.add(info.endCursor);
            const { data } = await query(`node(id:${JSON.stringify(id)}) { ... on ${type} { ${name}(first:100,after:${JSON.stringify(info.endCursor)}) { nodes { ${selection} } ${pageInfo} } } }`);
            const next = data.node?.[name];
            info = append(next);
        }
        return result;
    }
    async function fetchBatch(records) {
        if (!records.length) return new Map();
        if (!quota || Date.parse(quota.resetAt) <= now()) await query('');
        if (!quota) throw new GitHubSourceError('GitHub did not return quota evidence; bulk requests are paused.');
        const selection = records.map((record, index) => {
            const [owner, name] = record.repo.split('/');
            return `p${index}:repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}) { pullRequest(number:${record.number}) { ${fields} } }`;
        }).join('\n');
        let response;
        try { response = await query(selection, records.length * 60); }
        catch (error) {
            if (error.code !== 'github_graphql_overflow' || records.length === 1) throw error;
            const middle = Math.ceil(records.length / 2);
            const results = new Map();
            for (const group of [records.slice(0, middle), records.slice(middle)]) {
                try { for (const [id, result] of await fetchBatch(group)) results.set(id, result); }
                catch (error) { for (const record of group) results.set(record.id, { error }); }
                const paused = [...results.values()].find((result) => result.error?.code === 'github_rate_limited' || result.error?.status === 401);
                if (paused) {
                    for (const record of records) if (!results.has(record.id)) results.set(record.id, paused);
                    break;
                }
            }
            return results;
        }
        const { data, errors } = response;
        const results = new Map();
        for (const [index, old] of records.entries()) {
            try {
                const raw = data[`p${index}`]?.pullRequest;
                const localErrors = errors.filter((error) => error.path?.[0] === `p${index}`);
                if (localErrors.length) throw localFailure(localErrors);
                if (!raw) {
                    if (!Object.hasOwn(data, `p${index}`) || (data[`p${index}`] !== null && data[`p${index}`]?.pullRequest !== null)) throw new GitHubSourceError('GitHub omitted PR evidence.');
                    throw new GitHubSourceError('GitHub PR is no longer accessible.', { status: 404 });
                }
                if (raw.number !== old.number || !raw.id || !validDate(raw.createdAt) || !validDate(raw.updatedAt) || !['OPEN', 'CLOSED', 'MERGED'].includes(raw.state)
                    || !validCount(raw.additions) || !validCount(raw.deletions) || !validCount(raw.changedFiles) || typeof raw.body !== 'string' || typeof raw.isDraft !== 'boolean'
                    || !hasFields(raw, ['author', 'closedAt', 'mergedAt', 'headRefOid']) || typeof raw.headRefOid !== 'string' || !raw.headRefOid
                    || (raw.state === 'MERGED' && !validDate(raw.mergedAt))) {
                    throw new GitHubSourceError('GitHub returned incomplete bulk PR details.');
                }
                const reviews = await nodes(raw.reviews, raw.id, 'PullRequest', 'reviews', reviewFields);
                const threads = await nodes(raw.reviewThreads, raw.id, 'PullRequest', 'reviewThreads', threadFields);
                const comments = [];
                for (const thread of threads) comments.push(...await nodes(thread.comments, thread.id, 'PullRequestReviewThread', 'comments', commentFields));
                const files = await nodes(raw.files, raw.id, 'PullRequest', 'files', 'path additions deletions');
                const labels = await nodes(raw.labels, raw.id, 'PullRequest', 'labels', 'name');
                if (files.length !== raw.changedFiles || raw.files.totalCount !== raw.changedFiles
                    || files.some((file) => !file?.path || !validCount(file.additions) || !validCount(file.deletions))
                    || labels.some((label) => typeof label.name !== 'string')
                    || reviews.some((review) => !databaseId(review?.fullDatabaseId) || typeof review.body !== 'string' || review.body.length > 65_536
                        || !hasFields(review, ['author', 'commit']) || (review.commit !== null && !review.commit?.oid)
                        || !['APPROVED','CHANGES_REQUESTED','COMMENTED','DISMISSED','PENDING'].includes(review.state) || (review.state !== 'PENDING' && !validDate(review.submittedAt)))
                    || new Set(comments.map((comment) => String(comment.fullDatabaseId))).size !== comments.length
                    || comments.some((comment) => !databaseId(comment?.fullDatabaseId) || !hasFields(comment, ['author', 'replyTo', 'pullRequestReview', 'path'])
                        || (comment.replyTo !== null && !databaseId(comment.replyTo?.fullDatabaseId))
                        || (comment.pullRequestReview !== null && !databaseId(comment.pullRequestReview?.fullDatabaseId))
                        || typeof comment.body !== 'string' || comment.body.length > 65_536 || !validDate(comment.createdAt))) throw new GitHubSourceError('GitHub returned incomplete bulk review or file evidence.');
                results.set(old.id, { raw: { repo: old.repo, number: raw.number, title: raw.title, user: user(raw.author), created_at: raw.createdAt, updated_at: raw.updatedAt, closed_at: raw.closedAt, merged_at: raw.mergedAt,
                    ...(Object.hasOwn(raw, 'mergedBy') ? { merged_by: user(raw.mergedBy) } : {}),
                    state: raw.state === 'OPEN' ? 'open' : 'closed', draft: raw.isDraft, additions: raw.additions, deletions: raw.deletions, changed_files: raw.changedFiles, body: raw.body, head: { sha: raw.headRefOid }, labels },
                    reviews: reviews.map((review) => ({ id: review.fullDatabaseId, user: user(review.author), state: review.state, submitted_at: review.submittedAt, body: review.body, commit_id: review.commit?.oid })),
                    comments: comments.map((comment) => ({ id: comment.fullDatabaseId, user: user(comment.author), body: comment.body, created_at: comment.createdAt, path: comment.path, in_reply_to_id: comment.replyTo?.fullDatabaseId, pull_request_review_id: comment.pullRequestReview?.fullDatabaseId })),
                    files: compactFiles(files), filesComplete: true,
                    qualityComplete: Boolean(user(raw.author)?.type) && reviews.every((review) => user(review.author)?.type) && comments.every((comment) => user(comment.author)?.type) });
            } catch (error) {
                results.set(old.id, { error });
                if (error.code === 'github_rate_limited' || error.status === 401) {
                    for (const record of records.slice(index + 1)) results.set(record.id, { error });
                    break;
                }
            }
        }
        return results;
    }
    return { fetchBatch };
}
