// Read-only discovery with bulk GraphQL evidence; REST remains an injectable compatibility transport.
import { createGraphQLDetails, compactFiles } from './github-graphql.mjs';
import { githubScope, githubRecordInScope } from './github.mjs';
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PAGE_SIZE = 100;
const DETAIL_LIMIT = 40;
const REQUEST_LIMIT = 600;
const OVERLAP_MS = 24 * 60 * 60_000;
const FIRST_SECOND = 0;

export class GitHubSourceError extends Error {
    constructor(message, { code = "github_source_unavailable", status = null, retryAt = null } = {}) {
        super(message);
        this.name = "GitHubSourceError";
        this.code = code;
        this.status = status;
        this.retryAt = retryAt;
    }
}

function failure(error) {
    if (error instanceof GitHubSourceError) return error;
    const text = String(error?.message || "");
    const status = Number(error?.status) || Number(/\bHTTP (\d{3})\b/i.exec(text)?.[1]) || null;
    const rateLimited = status === 429 || /rate limit|abuse detection|secondary rate/i.test(text);
    return new GitHubSourceError(rateLimited ? "GitHub rate limit reached; retry on a later sync."
        : status === 401 ? "GitHub authentication failed; check gh auth status."
            : status === 403 ? "GitHub denied access (permissions, SSO, or throttling)."
                : status === 404 ? "GitHub resource is no longer accessible."
                    : "GitHub request failed or timed out; retry on a later sync.", {
        code: rateLimited ? "github_rate_limited" : "github_source_unavailable",
        status,
        retryAt: error?.retryAt || null,
    });
}

async function ghRequest(endpoint, query = null) {
    let stdout;
    try {
        ({ stdout } = await execFileAsync("gh", [
            "api", "--hostname", "github.com", "--method", query ? "POST" : "GET",
            "-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2022-11-28",
            "--include", endpoint, ...(query ? ["-f", `query=${query}`] : []),
        ], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: "utf8" }));
    } catch (error) {
        // gh exits nonzero for HTTP errors; keep response headers for reset/Retry-After.
        if (!/^HTTP\/\S+ \d{3}/.test(error.stdout || "")) throw failure({ message: error.stderr || error.message });
        stdout = error.stdout;
    }
    const boundary = /\r?\n\r?\n/.exec(stdout);
    if (!boundary) throw new GitHubSourceError("GitHub returned an invalid HTTP response.");
    const headerText = stdout.slice(0, boundary.index);
    const headers = Object.fromEntries(headerText.split(/\r?\n/).slice(1).map((line) => {
        const colon = line.indexOf(":");
        return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
    }));
    try {
        return { data: JSON.parse(stdout.slice(boundary.index + boundary[0].length)), headers, status: Number(/^HTTP\/\S+ (\d{3})/.exec(headerText)?.[1]) };
    } catch {
        throw new GitHubSourceError("GitHub returned invalid JSON.");
    }
}

const text = (value, limit = 240) => typeof value === "string" ? value.slice(0, limit) : "";
const date = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const isoSecond = (second) => new Date(second * 1000).toISOString().replace(".000Z", "Z");
const loginOf = (user) => text(user?.login, 100) || null;
const typeOf = (user) => text(user?.type, 40) || null;
const sameLogin = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function keyOf(raw) {
    const repo = raw?.repo || raw?.repository?.full_name
        || /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)(?:\/|$)/.exec(raw?.repository_url || raw?.url || "")?.[1];
    const number = Number(raw?.number);
    return repoPattern.test(repo || "") && Number.isSafeInteger(number) && number > 0
        ? { repo, number, id: `${repo.toLowerCase()}#${number}` } : null;
}

function normalize(raw, previous = null) {
    const key = keyOf(raw);
    if (!key) return null;
    const isCache = raw.id === key.id && typeof raw.qualityComplete === "boolean";
    const mergedAt = date(Object.hasOwn(raw, "merged_at") ? raw.merged_at
        : raw.pull_request?.merged_at ?? raw.mergedAt ?? previous?.mergedAt);
    return {
        ...key,
        url: `https://github.com/${key.repo}/pull/${key.number}`,
        title: text(raw.title),
        author: isCache ? text(raw.author, 100) || null : loginOf(raw.user),
        authorType: isCache ? text(raw.authorType, 40) || null : typeOf(raw.user),
        createdAt: date(raw.created_at ?? raw.createdAt),
        updatedAt: date(raw.updated_at ?? raw.updatedAt),
        closedAt: date(raw.closed_at ?? raw.closedAt),
        mergedAt,
        mergedBy: isCache ? text(raw.mergedBy, 100) || null : Object.hasOwn(raw, "merged_by") ? loginOf(raw.merged_by) : previous?.mergedBy || null,
        mergedByType: isCache ? text(raw.mergedByType, 40) || null : Object.hasOwn(raw, "merged_by") ? typeOf(raw.merged_by) : previous?.mergedByType || null,
        mergerComplete: isCache ? raw.mergerComplete === true : Object.hasOwn(raw, "merged_by")
            ? raw.merged_by === null || Boolean(loginOf(raw.merged_by) && typeOf(raw.merged_by)) : previous?.mergerComplete === true,
        mergerChecked: isCache ? raw.mergerChecked === true : Object.hasOwn(raw, "merged_by") || previous?.mergerChecked === true,
        headCommitId: text(isCache ? raw.headCommitId : raw.head?.sha, 100) || null,
        state: mergedAt || raw.state === "merged" ? "merged" : raw.state === "open" ? "open" : "closed",
        draft: typeof raw.draft === "boolean" ? raw.draft : previous?.draft ?? null,
        additions: count(Object.hasOwn(raw, "additions") ? raw.additions : previous?.additions),
        deletions: count(Object.hasOwn(raw, "deletions") ? raw.deletions : previous?.deletions),
        changedFiles: count(raw.changed_files ?? raw.changedFiles ?? previous?.changedFiles),
        bodyPresent: isCache ? raw.bodyPresent === true : Object.hasOwn(raw, "body")
            ? typeof raw.body === "string" && Boolean(raw.body.trim()) : previous?.bodyPresent === true,
        labels: (Array.isArray(raw.labels) ? raw.labels : []).map((label) => text(typeof label === "string" ? label : label?.name, 100)).filter(Boolean),
        files: isCache ? (Array.isArray(raw.files) ? raw.files : []).map(fileRecord) : previous?.files || [],
        reviews: isCache ? (Array.isArray(raw.reviews) ? raw.reviews : []).map(reviewRecord) : previous?.reviews || [],
        comments: isCache ? (Array.isArray(raw.comments) ? raw.comments : []).map(commentRecord) : previous?.comments || [],
        qualityComplete: isCache && raw.qualityComplete,
        filesComplete: isCache && raw.filesComplete === true,
        ...(isCache && raw.detailFailure && raw.detailFailure.updatedAt === date(raw.updatedAt) ? { detailFailure: {
            updatedAt: date(raw.detailFailure.updatedAt), attempts: Math.max(1, Math.min(3, Number(raw.detailFailure.attempts) || 1)),
            terminal: raw.detailFailure.terminal === true, retryAt: Number(raw.detailFailure.retryAt) || null,
            message: text(raw.detailFailure.message), status: Number(raw.detailFailure.status) || null,
        } } : {}),
    };
}

function fileRecord(raw) {
    return { path: text(raw.filename ?? raw.path, 1024), additions: count(raw.additions), deletions: count(raw.deletions) };
}

function reviewRecord(raw) {
    return {
        id: raw.id == null ? null : String(raw.id),
        author: raw.user ? loginOf(raw.user) : text(raw.author, 100) || null,
        authorType: raw.user ? typeOf(raw.user) : text(raw.authorType, 40) || null,
        state: text(raw.state, 40).toUpperCase(),
        submittedAt: date(raw.submitted_at ?? raw.submittedAt),
        body: text(raw.body, 65_536),
        commitId: text(raw.commit_id ?? raw.commitId, 100) || null,
    };
}

function commentRecord(raw) {
    return {
        id: raw.id == null ? null : String(raw.id),
        author: raw.user ? loginOf(raw.user) : text(raw.author, 100) || null,
        authorType: raw.user ? typeOf(raw.user) : text(raw.authorType, 40) || null,
        body: text(raw.body, 65_536),
        createdAt: date(raw.created_at ?? raw.createdAt),
        path: text(raw.path, 1024) || null,
        reviewId: raw.pull_request_review_id == null && raw.reviewId == null ? null : String(raw.pull_request_review_id ?? raw.reviewId),
        inReplyToId: raw.in_reply_to_id == null && raw.inReplyToId == null ? null : String(raw.in_reply_to_id ?? raw.inReplyToId),
    };
}

function loadCursor(value, user, scope) {
    if (!value) return null;
    try {
        const cursor = JSON.parse(value);
        if (cursor.version !== 4 || cursor.identityId !== user.id || cursor.host !== "github.com"
            || !sameLogin(cursor.login, user.login) || cursor.scopeFingerprint !== scope.fingerprint
            || JSON.stringify(cursor.organizations) !== JSON.stringify(scope.organizations)
            || JSON.stringify(cursor.repositories) !== JSON.stringify(scope.repositories)
            || !date(cursor.at) || (cursor.since !== null && !date(cursor.since))
            || !Array.isArray(cursor.search) || !Array.isArray(cursor.details)
            || cursor.search.some((task) => !["author", "reviewed-by", "merged-by"].includes(task.role)
                || !Number.isSafeInteger(task.start) || !Number.isSafeInteger(task.end)
                || task.start < FIRST_SECOND || task.end < task.start
                || !Number.isInteger(task.page) || task.page < 1 || task.page > 10
                || !Number.isSafeInteger(task.seen) || task.seen < 0 || task.seen > 1000
                || !(task.organization && scope.organizations.includes(task.organization) && task.repo === null
                    || task.repo && scope.repositories.includes(task.repo) && task.organization === null)
                || (task.ids !== undefined && (!Array.isArray(task.ids) || task.ids.some((id) => typeof id !== "string"))))
            || cursor.details.some((id) => typeof id !== "string")) return null;
        return cursor;
    } catch { return null; }
}

/**
 * request(endpoint) is an optional async fixture/transport returning parsed REST JSON,
 * or {data, headers, status}. Discovery uses GET endpoints on github.com; production
 * evidence uses read-only GraphQL queries. Inject request alone for legacy REST fixtures,
 * or graphqlRequest(query) as well for bulk evidence. Both transports share an injected clock.
 *
 * Persist records AND cursor after partial syncs. Resume using cursor, or lastSync: {at, cursor}.
 * organizations and repositories form an explicit union; empty selections pause without requests.
 * Scope changes should pass lastSync: null, cursor: null. Out-of-scope cached records are
 * retained, not refreshed. Version 4 cursors bind numeric identity and the normalized union.
 * Explicit cursor (including null) takes precedence over lastSync.cursor.
 * Always use result.watermark for lastSync.at, including when a resumed batch completes
 * and cursor disappears. It is the original discovery start, not this call's end time.
 * A partial cursor carries that same timestamp internally as at.
 * Cached records must belong to identity; an account mismatch throws instead of mixing users.
 * No thread-resolution inference is made: REST review comments do not expose it.
 * headCommitId is the observed pull.head.sha, never merge_commit_sha. It is not proof
 * of the branch head at merge time; missing head evidence must not imply clean approval.
 * discoveryVersion tracks merged-by evidence; cursor version separately tracks scope semantics.
 * Persist scopeFingerprint with lastSync to detect changed selections on incremental imports.
 * Merger identity is observed in the existing detail request. A checked null/missing actor
 * remains unknown but does not cause an unchanged completed PR to download every click.
 */
export function createGitHubSource({ request = ghRequest, graphqlRequest = request === ghRequest ? (query) => ghRequest('graphql', query) : null,
    pace = request === ghRequest, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
    let cooldownUntil = 0;
    let cooldownReason = "rate_limit";
    let searchAt = 0;
    const quotas = new Map();
    const bulk = graphqlRequest ? createGraphQLDetails({ request: graphqlRequest, now, sleep }) : null;

    async function fetchActivity({ identity = null, records = {}, lastSync = null, organizations = [], repositories = [], cursor = undefined, onProgress } = {}) {
        if (!Array.isArray(repositories) || repositories.some((repo) => typeof repo !== "string"
            || !repoPattern.test(repo) || repo.split("/").some((part) => part === "." || part === ".."))) {
            throw new GitHubSourceError("GitHub repositories must be an array of owner/name slugs.", { code: "github_invalid_scope" });
        }
        if (!Array.isArray(organizations) || organizations.some((org) => typeof org !== "string"
            || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(org))) {
            throw new GitHubSourceError("GitHub organizations must be an array of organization logins.", { code: "github_invalid_scope" });
        }
        const scope = githubScope({ organizations, repositories });
        ({ organizations, repositories } = scope);
        if (!scope.selected) return { identity, records: Array.isArray(records) ? records : Object.values(records || {}),
            paused: true, reason: "empty_scope", complete: false, canContinue: false, processed: 0, scopeFingerprint: scope.fingerprint };
        const inScope = (record) => githubRecordInScope(record, scope);
        const warnings = [];
        const warn = (message) => { if (!warnings.includes(message)) warnings.push(message); };
        let requests = 0;
        const progress = (value) => { try { onProgress?.(value); } catch { /* UI callbacks cannot interrupt synchronization. */ } };
        async function get(endpoint) {
            if (now() < cooldownUntil) throw new GitHubSourceError(cooldownReason === "rate_limit" ? "GitHub requests paused after throttling; retry later." : "GitHub requests paused after an error; retry later.", { code: cooldownReason === "rate_limit" ? "github_rate_limited" : "github_source_unavailable", retryAt: cooldownUntil });
            const resource = endpoint.startsWith('/search/') ? 'search' : 'core';
            const quota = quotas.get(resource);
            if (pace && quota && quota.remaining <= (resource === 'search' ? 2 : 100) && quota.reset > now()) {
                cooldownUntil = quota.reset;
                cooldownReason = 'rate_limit';
                throw new GitHubSourceError('GitHub quota safety reserve reached; click Sync after reset to resume.', { code: 'github_rate_limited', retryAt: cooldownUntil });
            }
            if (pace && resource === 'search') {
                if (searchAt > now()) await sleep(searchAt - now());
                searchAt = now() + 2100;
            }
            if (++requests > REQUEST_LIMIT) throw new GitHubSourceError("GitHub request budget reached; remaining work will resume next sync.", { code: "github_budget" });
            try {
                const response = await request(endpoint);
                const envelope = response && Object.hasOwn(response, "data") && (response.headers || response.status);
                const headers = envelope ? Object.fromEntries(Object.entries(response.headers || {}).map(([key, value]) => [key.toLowerCase(), value])) : {};
                if (headers['x-ratelimit-remaining'] !== undefined) quotas.set(resource, { remaining: Number(headers['x-ratelimit-remaining']), reset: Number(headers['x-ratelimit-reset']) * 1000 });
                if (endpoint === '/rate_limit' && response.data?.resources) for (const name of ['core', 'search']) {
                    const value = response.data.resources[name];
                    if (value) quotas.set(name, { remaining: value.remaining, reset: value.reset * 1000 });
                }
                if (Number(headers["x-ratelimit-remaining"]) === 0 && headers["x-ratelimit-remaining"] !== undefined) {
                    const reset = Number(headers["x-ratelimit-reset"]) * 1000;
                    cooldownUntil = Math.max(cooldownUntil, reset > now() ? reset : now() + 60_000);
                    cooldownReason = "rate_limit";
                }
                if (envelope && response.status >= 400) {
                    const status = Number(response.status);
                    const limited = status === 429 || (status === 403 && (headers["retry-after"] || String(headers["x-ratelimit-remaining"]) === "0" || /rate limit|secondary|abuse/i.test(response.data?.message || "")));
                    if (limited) {
                        const retry = String(headers["retry-after"] || "");
                        const deadline = /^\d+(\.\d+)?$/.test(retry) ? now() + Number(retry) * 1000 : Date.parse(retry);
                        const reset = Number(headers["x-ratelimit-reset"]) * 1000;
                        cooldownUntil = Math.max(cooldownUntil, Number.isFinite(deadline) ? deadline : reset > now() ? reset : now() + 60_000);
                    }
                    throw new GitHubSourceError(limited ? "GitHub rate limit reached; cached progress is preserved." : status === 401 ? "GitHub authentication is unavailable; sign in with gh and retry." : "GitHub could not return this activity; cached progress is preserved.", {
                        code: limited ? "github_rate_limited" : status === 401 ? "github_auth_required" : "github_source_unavailable", status,
                        retryAt: limited ? cooldownUntil : null,
                    });
                }
                return envelope ? response.data : response;
            } catch (error) {
                const safe = failure(error);
                if (safe.code === "github_rate_limited" || safe.status === 401) {
                    cooldownUntil = Math.max(cooldownUntil, Number(safe.retryAt) || now() + 60_000);
                    safe.retryAt = cooldownUntil;
                    cooldownReason = safe.status === 401 ? "error" : "rate_limit";
                }
                throw safe;
            }
        }
        if (pace) await get('/rate_limit');
        const user = await get("/user");
        if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(user?.login || "") || !Number.isSafeInteger(user?.id) || user.id <= 0 || user.type !== "User") {
            throw new GitHubSourceError("GitHub did not return an authenticated human account.");
        }
        const authenticated = { login: user.login, id: user.id, host: "github.com" };
        if (identity && (identity.id !== user.id || (identity.host && identity.host !== "github.com"))) {
            throw new GitHubSourceError("GitHub account changed; use a separate activity cache.", { code: "github_identity_mismatch" });
        }
        const cache = new Map();
        for (const raw of Array.isArray(records) ? records : Object.values(records || {})) {
            const record = normalize(raw);
            if (record) cache.set(record.id, record);
        }
        const cursorValue = cursor === undefined ? lastSync?.cursor : cursor;
        const resumed = loadCursor(cursorValue, user, scope);
        if (cursorValue && !resumed) warn("Invalid GitHub cursor or changed scope; restarting full historical discovery.");
        const at = resumed?.at || new Date(now()).toISOString();
        const previousAt = typeof lastSync === "string" ? lastSync : lastSync?.at;
        const since = resumed ? resumed.since : !cursorValue && (!lastSync?.scopeFingerprint || lastSync.scopeFingerprint === scope.fingerprint) && date(previousAt)
            ? new Date(Math.max(0, Date.parse(previousAt) - OVERLAP_MS)).toISOString() : null;
        const end = Math.floor(Date.parse(at) / 1000);
        const targets = [...organizations.map((organization) => ({ organization, repo: null })),
            ...repositories.filter((repo) => !organizations.includes(repo.split("/")[0])).map((repo) => ({ repo, organization: null }))];
        const search = resumed?.search || targets.flatMap((target) =>
            ["author", "reviewed-by", "merged-by"].map((role) => ({ role, ...target, start: FIRST_SECOND, end, page: 1, seen: 0,
                ...(role === "merged-by" && lastSync?.discoveryVersion !== 3 ? { fullHistory: true } : {}) })));
        const issues = Array.isArray(resumed?.issues) ? resumed.issues.filter((issue) => typeof issue === "string").slice(0, 100) : [];
        for (const issue of issues) warn(issue);
        const unavailable = (record) => record.detailFailure?.terminal === true;
        const ready = (record) => !unavailable(record) && !(record.detailFailure?.retryAt > now());
        const details = new Set((resumed?.details || []).filter((id) => cache.has(id) && inScope(cache.get(id)) && !unavailable(cache.get(id))));
        let discoveryFailed = false;
        let discoveryBudget = false;
        let pauseReason = null;
        while (search.length) {
            const task = search[0];
            const query = `is:pr ${task.role}:${user.login}${task.repo ? ` repo:${task.repo}` : ` org:${task.organization}`} created:${isoSecond(task.start)}..${isoSecond(task.end)}${since && !task.fullHistory ? ` updated:>=${since}` : ""}`;
            try {
                const response = await get(`/search/issues?q=${encodeURIComponent(query)}&sort=created&order=asc&per_page=${PAGE_SIZE}&page=${task.page}`);
                if (!Array.isArray(response?.items) || !Number.isSafeInteger(response.total_count) || response.total_count < 0 || response.incomplete_results !== false) {
                    throw new GitHubSourceError("GitHub search returned incomplete results; discovery will resume.");
                }
                if (response.total_count > 1000) {
                    if (task.start === task.end) throw new GitHubSourceError("Over 1,000 PRs share one creation second; GitHub search cannot completely enumerate this interval.");
                    const middle = Math.floor((task.start + task.end) / 2);
                    search.splice(0, 1, { ...task, end: middle, page: 1, seen: 0, ids: [] }, { ...task, start: middle + 1, page: 1, seen: 0, ids: [] });
                    continue;
                }
                const pageIds = response.items.map((item) => keyOf(item)?.id);
                if (new Set(pageIds).size !== pageIds.length || pageIds.some((id) => (task.ids || []).includes(id))) {
                    throw new GitHubSourceError("GitHub search pagination repeated PRs; discovery will resume.");
                }
                const seen = (task.seen || 0) + response.items.length;
                if (seen < response.total_count && (response.items.length !== PAGE_SIZE || task.page >= 10)) {
                    throw new GitHubSourceError("GitHub search pagination ended early; discovery will resume.");
                }
                for (const item of response.items) {
                    const key = keyOf(item);
                    if (!key || !item.pull_request || (task.repo ? key.repo.toLowerCase() !== task.repo : key.repo.split("/")[0].toLowerCase() !== task.organization)
                        || (task.role === "author" && !sameLogin(item.user?.login, user.login))) {
                        throw new GitHubSourceError("GitHub search returned an invalid or incorrectly attributed PR.");
                    }
                    const old = cache.get(key.id);
                    const fresh = normalize(item, old);
                    if (!old || old.updatedAt !== fresh.updatedAt) {
                        cache.set(key.id, fresh);
                        details.add(key.id);
                    } else if ((!old.qualityComplete || !old.filesComplete || (old.state === "merged" && !old.mergerChecked)) && !unavailable(old)) details.add(key.id);
                }
                task.seen = seen;
                task.ids = [...(task.ids || []), ...pageIds];
                progress({ phase: "Discovering GitHub PRs", fetched: cache.size, page: task.page, role: task.role });
                if (task.seen >= response.total_count) search.shift();
                else if (response.items.length === PAGE_SIZE && task.page < 10) task.page++;
            } catch (error) {
                const safe = failure(error);
                if ([403, 404, 410, 422].includes(safe.status) && safe.code !== "github_rate_limited") {
                    const issue = `Discovery unavailable for ${task.repo || task.organization} (${task.role}): ${safe.message}`;
                    issues.push(issue);
                    warn(issue);
                    search.shift();
                    continue;
                }
                warn(safe.message);
                discoveryBudget = safe.code === "github_budget";
                pauseReason = safe.code === "github_rate_limited" ? "rate_limit" : "error";
                discoveryFailed = true;
                break;
            }
        }
        for (const record of cache.values()) {
            if (inScope(record) && !unavailable(record) && ((!resumed && record.state === "open") || !record.qualityComplete || !record.filesComplete
                || (record.state === "merged" && !record.mergerChecked))) details.add(record.id);
        }

        async function pages(endpoint, maxPages = Infinity) {
            const result = [];
            const ids = new Set();
            for (let page = 1; ; page++) {
                const batch = await get(`${endpoint}?per_page=${PAGE_SIZE}&page=${page}`);
                if (!Array.isArray(batch)) throw new GitHubSourceError("GitHub returned invalid detail pagination.");
                for (const item of batch) {
                    const id = item.id ?? item.filename;
                    if (id == null || ids.has(String(id))) throw new GitHubSourceError("GitHub detail pagination repeated or omitted identifiers.");
                    ids.add(String(id));
                    result.push(item);
                }
                if (batch.length < PAGE_SIZE || page === maxPages) return result;
            }
        }
        let enriched = 0;
        let processed = 0;
        const batch = discoveryFailed ? [] : [...details].filter((id) => ready(cache.get(id))).slice(0, DETAIL_LIMIT);
        let nextDetail = 0;
        // Bound parallelism while allowing each PR's paginated evidence to stay sequential.
        async function enrich() {
            while (nextDetail < batch.length) {
                if (now() < cooldownUntil || requests >= REQUEST_LIMIT) return;
                const id = batch[nextDetail++];
                const old = cache.get(id);
                if (!old) { details.delete(id); continue; }
                const mergerBackfill = old.state === "merged" && !old.mergerChecked && old.qualityComplete && old.filesComplete;
                const knownEvidence = mergerBackfill ? { qualityComplete: old.qualityComplete, filesComplete: old.filesComplete,
                    reviews: old.reviews, comments: old.comments, files: old.files } : null;
                const endpoint = `/repos/${old.repo}/pulls/${old.number}`;
                let record = old;
                let failed = null;
                const noteFailure = (error) => {
                    const safe = failure(error);
                    if (!failed || [403, 404, 410, 422].includes(safe.status)) failed = safe;
                    warn(`${id}: ${safe.message}`);
                };
                try {
                    const raw = await get(endpoint);
                    if (keyOf({ ...raw, repo: old.repo })?.id !== id || !date(raw.updated_at) || !date(raw.created_at)
                        || !raw.user?.login || !["open", "closed"].includes(raw.state)) {
                        throw new GitHubSourceError("GitHub returned incomplete PR details.");
                    }
                    record = normalize({ ...raw, repo: old.repo }, old);
                    record.mergerChecked = true;
                    // Until both endpoints succeed, stale review evidence cannot earn quality bonuses.
                    record.qualityComplete = false;
                    record.filesComplete = false;
                    cache.set(id, record);
                    try {
                        const reviews = await pages(`${endpoint}/reviews`);
                        const comments = await pages(`${endpoint}/comments`);
                        record.reviews = reviews.map(reviewRecord);
                        record.comments = comments.map(commentRecord);
                        record.qualityComplete = reviews.every((review) => review.id != null && review.user?.login && review.user?.type && typeof review.body === "string"
                            && ["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"].includes(review.state)
                            && review.body.length <= 65_536 && (review.state === "PENDING" || date(review.submitted_at)))
                            && comments.every((comment) => comment.id != null && comment.user?.login && comment.user?.type
                                && typeof comment.body === "string" && comment.body.length <= 65_536 && date(comment.created_at))
                            && record.draft !== null && raw.user?.type != null && Object.hasOwn(raw, "body") && (raw.body === null || typeof raw.body === "string")
                            && record.additions !== null && record.deletions !== null && record.changedFiles !== null;
                        if (!record.qualityComplete) throw new GitHubSourceError("GitHub review evidence is incomplete; quality bonuses must be omitted.");
                    } catch (error) { noteFailure(error); }
                    try {
                        const files = await pages(`${endpoint}/files`, 30);
                        const normalized = files.map(fileRecord);
                        record.filesComplete = record.changedFiles !== null && files.length === record.changedFiles
                            && normalized.every((file) => file.path && file.additions !== null && file.deletions !== null);
                        if (record.filesComplete) record.files = normalized;
                        else throw new GitHubSourceError("GitHub file list is incomplete (including GitHub's 3,000-file cap).");
                    } catch (error) { noteFailure(error); }
                    record.qualityComplete = record.qualityComplete && record.filesComplete;
                } catch (error) {
                    record.qualityComplete = false;
                    record.filesComplete = false;
                    noteFailure(error);
                }
                details.delete(id);
                if (failed && knownEvidence && record.updatedAt === old.updatedAt) Object.assign(record, knownEvidence);
                if (failed) {
                    // Limits are global pauses, not failed evidence; never exhaust a PR's retries on throttling.
                    if (failed.code === "github_rate_limited" || failed.code === "github_budget" || failed.status === 401) {
                        pauseReason = failed.code === "github_rate_limited" ? "rate_limit" : "error";
                        details.add(id);
                    } else {
                        const attempts = (old.detailFailure?.attempts || 0) + 1;
                        const terminal = [403, 404, 410, 422].includes(failed.status) || attempts >= 3;
                        record.detailFailure = { updatedAt: record.updatedAt, attempts, terminal,
                            retryAt: terminal ? null : now() + 5 * 60_000 * attempts, message: failed.message, status: failed.status };
                        if (!terminal) details.add(id);
                    }
                } else {
                    delete record.detailFailure;
                    processed++;
                }
                progress({ phase: "Reading GitHub reviews and files", fetched: ++enriched, total: Math.min(details.size + enriched, DETAIL_LIMIT) });
            }
        }
        if (bulk) {
            for (let offset = 0; offset < batch.length; offset += 10) {
                const group = batch.slice(offset, offset + 10).map((id) => cache.get(id));
                let results;
                try { results = await bulk.fetchBatch(group); }
                catch (error) { results = new Map(group.map((record) => [record.id, { error }])); }
                for (const old of group) {
                    const result = results.get(old.id);
                    let record = old;
                    let error = result?.error;
                    if (!(old.state === 'merged' && !old.mergerChecked && old.qualityComplete && old.filesComplete)) {
                        record.qualityComplete = record.filesComplete = false;
                    }
                    if (!result?.error && result?.raw) {
                        record = normalize(result.raw, old);
                        record.mergerChecked = true;
                        record.reviews = result.reviews.map(reviewRecord);
                        record.comments = result.comments.map(commentRecord);
                        record.files = result.files.map(fileRecord);
                        record.qualityComplete = result.qualityComplete === true;
                        record.filesComplete = result.filesComplete === true;
                        delete record.detailFailure;
                        cache.set(old.id, record);
                        if (!record.qualityComplete || !record.filesComplete) error = new GitHubSourceError('GitHub evidence has unknown attribution; quality bonuses must be omitted.');
                    }
                    if (!error && result?.raw) {
                        details.delete(old.id);
                        processed++;
                    } else {
                        const safe = failure(error);
                        warn(`${old.id}: ${safe.message}`);
                        if (safe.code === 'github_rate_limited' || safe.status === 401) {
                            cooldownUntil = Math.max(cooldownUntil, Number(safe.retryAt) || now() + 60_000);
                            cooldownReason = safe.status === 401 ? 'error' : 'rate_limit';
                        } else {
                            const attempts = (old.detailFailure?.attempts || 0) + 1;
                            const terminal = [403, 404, 410, 422].includes(safe.status) || attempts >= 3;
                            record.detailFailure = { updatedAt: record.updatedAt, attempts, terminal, retryAt: terminal ? null : now() + 5 * 60_000 * attempts, message: safe.message, status: safe.status };
                            if (terminal) details.delete(old.id);
                        }
                    }
                }
                progress({ phase: 'Reading bulk GitHub history', fetched: processed, total: batch.length });
                if (cooldownUntil > now()) break;
            }
            // Only evidence-bearing paths are used by progression. Discard unrelated file rows without changing eligibility.
            for (const record of cache.values()) if (record.filesComplete) record.files = compactFiles(record.files);
        } else await Promise.all(Array.from({ length: Math.min(4, batch.length) }, enrich));
        const complete = search.length === 0 && details.size === 0;
        const canContinue = !complete && cooldownUntil <= now() && (discoveryBudget || (!discoveryFailed && [...details].some((id) => ready(cache.get(id)))));
        const deferred = [...details].map((id) => cache.get(id).detailFailure?.retryAt).filter((value) => value > now());
        const retryAt = cooldownUntil > now() ? cooldownUntil : !canContinue && !search.length && deferred.length ? Math.min(...deferred) : null;
        const unavailableCount = [...cache.values()].filter((record) => inScope(record) && unavailable(record)).length;
        if (unavailableCount) warn(`${unavailableCount} PRs have unavailable evidence; missing quality or merger attribution remains unknown. Unchanged failed evidence is not retried indefinitely.`);
        if (details.size) warn(`${details.size} GitHub PRs still need detail refresh; import resumes from the saved checkpoint.`);
        if (search.length) warn("Historical GitHub discovery is incomplete; do not advance the sync watermark.");
        return {
            identity: authenticated,
            records: [...cache.values()],
            processed,
            complete,
            canContinue,
            warnings,
            watermark: at,
            discoveryVersion: 3,
            scopeFingerprint: scope.fingerprint,
            ...(retryAt ? { retryAt, pauseReason: cooldownUntil > now() ? cooldownReason : pauseReason || "error" } : {}),
            ...(complete ? {} : { cursor: JSON.stringify({ version: 4, scopeFingerprint: scope.fingerprint, organizations, identityId: user.id, host: "github.com",
                login: user.login, repositories, at, since, search, details: [...details], issues: issues.slice(0, 100) }) }),
        };
    }
    return { fetchActivity };
}
