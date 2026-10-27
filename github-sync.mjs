// Manually started, single-flight synchronization. Failures leave the durable contribution cache intact.
import { githubScope } from './github.mjs';

export function createGitHubSyncService({ store, source, now = () => Date.now() }) {
    let flight = null;
    let retryAfter = 0;
    let stopped = false;
    function pauseState() {
        const gh = store.load().profiles.live.github;
        const attempt = gh.lastAttempt?.ok === false ? gh.lastAttempt : null;
        retryAfter = Math.max(retryAfter, Number(gh.lastSync?.retryAt) || 0, Number(attempt?.retryAt) || 0);
        if (gh.settings.enabled === false) return { paused: true, reason: "disabled", retryAt: retryAfter || null };
        if (!githubScope(gh.settings).selected) return { paused: true, reason: "empty_scope", retryAt: retryAfter || null };
        return now() < retryAfter ? { paused: true, retryAt: retryAfter, reason: attempt?.pauseReason || gh.lastSync?.pauseReason || "error" } : null;
    }
    async function refresh() {
        if (flight) return flight;
        const paused = pauseState();
        if (paused) return paused;
        stopped = false;
        flight = (async () => {
            store.setRuntime({ githubSyncing: true, githubProgress: "Discovering GitHub activity…" });
            try {
                let summary;
                do {
                    const gh = store.load().profiles.live.github;
                    const scope = githubScope(gh.settings);
                    if (!scope.selected) return { paused: true, reason: "empty_scope" };
                    const oldCursor = gh.cursor;
                    const result = await source.fetchActivity({ identity: gh.identity, records: gh.records, lastSync: gh.scopeChanged ? null : gh.lastSync, cursor: gh.scopeChanged ? null : gh.cursor,
                        organizations: scope.organizations, repositories: scope.repositories, onProgress: (progress) => store.setRuntime({ githubProgress: progress }) });
                    const liveScope = githubScope(store.load().profiles.live.github.settings);
                    if (liveScope.fingerprint !== scope.fingerprint) {
                        retryAfter = Math.max(retryAfter, Number(result.retryAt) || 0);
                        if (retryAfter > now()) store.recordGitHubFailure("GitHub import paused; retry after the saved cooldown.",
                            { retryAt: retryAfter, pauseReason: result.pauseReason || "error" });
                        return { paused: true, reason: "scope_changed", retryAt: retryAfter || null };
                    }
                    if (result.paused) return result;
                    const advanced = result.canContinue ?? (result.processed === undefined ? Boolean(result.cursor && result.cursor !== oldCursor) : result.processed > 0);
                    const deadline = Number(result.retryAt) || 0;
                    retryAfter = deadline > now() ? deadline : result.complete || advanced ? 0 : now() + 5 * 60_000;
                    const checkpoint = { ...result, retryAt: retryAfter || null, pauseReason: retryAfter ? result.pauseReason || "error" : null };
                    summary = store.applyGitHubSync(checkpoint);
                    if (result.complete || stopped) return summary;
                    if (retryAfter > now()) {
                        return { ...summary, paused: true, retryAt: retryAfter, reason: checkpoint.pauseReason };
                    }
                    // Yield without a timer gap; keep one flight and one visible import across checkpoints.
                    await new Promise((resolve) => setImmediate(resolve));
                } while (!stopped);
                return summary;
            } catch (error) {
                retryAfter = Number(error.retryAt) > now() ? Number(error.retryAt) : now() + 5 * 60_000;
                const reason = error.code === "github_rate_limited" ? "rate_limit" : "error";
                store.recordGitHubFailure(error.message || String(error), { retryAt: retryAfter, pauseReason: reason });
                throw error;
            } finally {
                store.setRuntime({ githubSyncing: false, githubProgress: null });
                flight = null;
            }
        })();
        return flight;
    }
    function requestRefresh() {
        if (flight) return { syncing: true, joined: true };
        const paused = pauseState();
        if (paused) return paused;
        void refresh().catch(() => {}); // Failure and retry deadline are persisted and pushed through SSE.
        return { syncing: true, joined: false };
    }
    return {
        refresh,
        requestRefresh,
        // Compatibility hooks deliberately never fetch: GitHub synchronization is manual-only.
        syncIfStale() {},
        start() {},
        stop() { stopped = true; },
    };
}
