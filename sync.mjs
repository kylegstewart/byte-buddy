// Ticket synchronization: direct read-only MCP fetch, with an agent hand-off when the server can't be reached directly.
import { TicketSourceError } from "./itsource.mjs";

// Exact close times feed time-of-day and same-day challenges; each ticket is looked up at most once.
const MAX_ENRICH = 400;
const ENRICH_CONCURRENCY = 6;
const STALE_AFTER_MS = 30 * 60_000;

export function createSyncService({ store, source, userId, sessionRef }) {
    let running = null;

    function needsExactClosure(ticket) {
        if (ticket.isOpen || ticket.closedOn) return false;
        const entry = store.ledgerEntry(ticket.id);
        return !entry || entry.status !== "rewarded" || (!entry.closedExact && !entry.closureChecked);
    }

    function syncDirect() {
        if (running) return running;
        running = (async () => {
            store.setRuntime({ syncing: true, syncProgress: { phase: "Fetching tickets", page: 0, totalPages: null }, handoffPending: false });
            try {
                const { tickets, complete } = await source.fetchAssignedTickets(userId, ({ page, totalPages }) => {
                    store.setRuntime({ syncProgress: { phase: "Fetching tickets", page, totalPages } });
                });
                const toEnrich = tickets.filter(needsExactClosure).slice(0, MAX_ENRICH);
                let next = 0;
                let done = 0;
                const worker = async () => {
                    while (next < toEnrich.length) {
                        const ticket = toEnrich[next++];
                        try {
                            const closure = await source.fetchClosure(ticket.id);
                            if (closure.closedOn) ticket.closedOn = closure.closedOn;
                            ticket.closureChecked = true;
                        } catch { /* fall back to updatedOn; retried next sync */ }
                        store.setRuntime({ syncProgress: { phase: "Checking close dates", page: ++done, totalPages: toEnrich.length } });
                    }
                };
                await Promise.all(Array.from({ length: Math.min(ENRICH_CONCURRENCY, toEnrich.length) }, worker));
                return store.applySync({ tickets, complete, method: "direct" });
            } catch (error) {
                store.recordSyncFailure(error.message, "direct");
                throw error;
            } finally {
                running = null;
                store.setRuntime({ syncing: false, syncProgress: null });
            }
        })();
        return running;
    }

    /** Asks the Copilot agent to pull tickets with its own MCP tools and push them back via sync_closed_tickets. */
    async function handoff(instanceId, reason) {
        const session = sessionRef.current;
        if (!session) throw new TicketSourceError("No Copilot session is available for a sync hand-off.");
        store.setRuntime({ handoffPending: true });
        const target = instanceId ? `the open Byte Buddy canvas instance "${instanceId}"` : "an open Byte Buddy canvas (open one with open_canvas canvasId \"dev-buddy\" if needed)";
        await session.send({
            prompt: [
                `Byte Buddy ticket sync hand-off${reason ? ` (direct sync failed: ${reason})` : ""}.`,
                `Read-only: never create, modify, close, or reopen any ticket.`,
                `1. Call information-technology-search_tickets with assignees ["${userId}"], resultsPerPage 100, and page through every page.`,
                `2. For every ticket build a compact record: { id: taskId, title: taskTitle, isOpen, isIssue, severity: ticketSeverity, assignedTo: assignedTo.userId, requester: createdBy.userId, createdOn, updatedOn, difficulty: difficultyLevel, timesReopened }. Do not include descriptions.`,
                `3. Call invoke_canvas_action on ${target} with actionName "sync_closed_tickets" and input { "complete": true, "tickets": [ ...records ] }.`,
                `4. Reply with a one-line summary of the XP and level change.`,
            ].join("\n"),
        });
        return { handoff: true };
    }

    /** Refresh button: try the direct path, fall back to the agent when the IT server is unreachable. */
    async function refresh(instanceId) {
        try {
            return { method: "direct", result: await syncDirect() };
        } catch (error) {
            if (!(error instanceof TicketSourceError)) throw error;
            try {
                await handoff(instanceId, error.message);
                return { method: "handoff", error: error.message };
            } catch (handoffError) {
                store.setRuntime({ handoffPending: false });
                throw handoffError;
            }
        }
    }

    function syncIfStale() {
        const profile = store.load().profiles.live;
        const last = Date.parse(profile.lastSync?.at || "");
        const lastAttempt = Date.parse(profile.lastSyncAttempt?.at || "");
        const recentFailure = profile.lastSyncAttempt && !profile.lastSyncAttempt.ok && Date.now() - lastAttempt < 5 * 60_000;
        if (!running && !recentFailure && (profile.rebalancePending || !Number.isFinite(last) || Date.now() - last > STALE_AFTER_MS)) {
            syncDirect().catch(() => { /* recorded in state */ });
        }
    }

    return { syncDirect, refresh, handoff, syncIfStale, isRunning: () => Boolean(running) };
}
