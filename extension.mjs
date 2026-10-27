import { CanvasError, createCanvas, joinSession } from "@github/copilot-sdk/extension";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createUpdater } from "./update.mjs";
import { ACCESSORY_SLOTS, ITEM_BY_ID } from "./catalog.mjs";
import { TicketSourceError, copilotHome, createItSource, normalizeTicket, resolveUserId } from "./itsource.mjs";
import { BuddyError, createStore } from "./store.mjs";
import { createSyncService } from "./sync.mjs";
import { createBuddyServer } from "./server.mjs";
import { createGitHubSource } from "./github-source.mjs";
import { createGitHubSyncService } from "./github-sync.mjs";
const userId = resolveUserId();
const sessionRef = { current: null };
const store = createStore({ root: join(copilotHome(), "extensions", "dev-buddy"), userId });
const source = createItSource();
const sync = createSyncService({ store, source, userId, sessionRef });
const github = createGitHubSyncService({ store, source: createGitHubSource() });
const updater = createUpdater({ dir: dirname(fileURLToPath(import.meta.url)) });
const server = createBuddyServer({ store, sync, github, updater });

function toCanvasError(error) {
    if (error instanceof CanvasError) return error;
    if (error instanceof BuddyError) return new CanvasError(error.code, error.message);
    if (error instanceof TicketSourceError) return new CanvasError("ticket_source_unavailable", error.message);
    return new CanvasError("ticket_sync_failed", error?.message || String(error));
}

const guard = (fn) => async (ctx) => {
    try {
        return await fn(ctx.input || {}, ctx);
    } catch (error) {
        throw toCanvasError(error);
    }
};

function buddyState() {
    const { catalog, ...view } = store.view();
    return { ...view, unlockedItems: catalog.filter((item) => item.unlocked).length, totalItems: catalog.length };
}

const ticketRecordSchema = {
    type: "object",
    required: ["id", "isOpen"],
    properties: {
        id: { type: ["string", "number"], description: "IT ticket number (taskId)." },
        title: { type: "string" },
        isOpen: { type: "boolean" },
        isIssue: { type: "boolean", description: "True for Help Desk tickets." },
        severity: { type: ["number", "null"], description: "ticketSeverity from the IT system." },
        assignedTo: { type: ["string", "null"], description: "Assignee user id." },
        requester: { type: ["string", "null"], description: "Reporter user id (createdBy.userId)." },
        createdOn: { type: ["string", "null"], description: "When the ticket was reported." },
        updatedOn: { type: ["string", "null"] },
        difficulty: { type: ["number", "null"], description: "difficultyLevel from the IT system." },
        timesReopened: { type: ["number", "null"] },
        closedOn: { type: ["string", "null"], description: "Close date (closedByDate) when known." },
    },
};

const canvas = createCanvas({
    id: "dev-buddy",
    displayName: "Byte Buddy",
    description: "Pixel-art companions that grow with your IT tickets and verified GitHub contributions.",
    open: async (ctx) => {
        const url = await server.urlFor(ctx.instanceId);
        sync.syncIfStale();
        const view = store.view({ summary: true });
        return { url, title: `Byte Buddy · ${view.name}`, status: `Lv ${view.progress.level}` };
    },
    actions: [
        {
            name: "check_for_updates",
            description: "Checks GitHub for a newer Byte Buddy release. Read-only; installs nothing.",
            handler: guard(async () => {
                const { tarball, ...info } = await updater.check({ force: true });
                return info;
            }),
        },
        {
            name: "install_update",
            description: "Installs the latest Byte Buddy release in place (user data is preserved) and requires Copilot to be restarted afterwards. Only call with confirm: true after the user explicitly asks to update.",
            inputSchema: { type: "object", required: ["confirm"], properties: { confirm: { type: "boolean", const: true } }, additionalProperties: false },
            handler: guard(() => updater.install()),
        },
        {
            name: "export_rollback",
            description: "Exports the current complete progression and evidence to buddy.rollback.json without changing the immutable original save.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            handler: guard(() => ({ path: store.exportRollback() })),
        },
        {
            name: "get_buddy_state",
            description: "Returns the buddy's name, level, XP, evolution stage, mood, care stats, appearance, achievements, challenges (secret ones masked until found), and sync status.",
            handler: guard(() => buddyState()),
        },
        {
            name: "sync_closed_tickets",
            description: "Syncs closed IT tickets assigned to the user. With no input, fetches directly from the IT server. Otherwise pass verified ticket records (from information-technology-search_tickets); set complete: true only when every page was included so missing tickets can be detected.",
            inputSchema: {
                type: "object",
                properties: {
                    tickets: { type: "array", maxItems: 5000, items: ticketRecordSchema },
                    complete: { type: "boolean", description: "True when tickets contains every ticket assigned to the user." },
                },
            },
            handler: guard(async (input) => {
                if (!input.tickets) return await sync.syncDirect();
                const tickets = input.tickets.map((raw) => normalizeTicket({ ...raw, id: String(raw.id) })).filter((ticket) => ticket.id);
                try {
                    return store.applySync({ tickets, complete: input.complete === true, method: "agent" });
                } finally {
                    store.setRuntime({ handoffPending: false });
                }
            }),
        },
        {
            name: "get_github_progress",
            description: "Returns GitHub contribution XP, historical coverage, quality evidence, time-range analytics, challenges, and verified identity.",
            handler: guard(() => ({ github: store.view().github, challenges: store.view().challenges.filter((c) => c.category === "github") })),
        },
        {
            name: "sync_github_activity",
            description: "Fetches verified authored/reviewed GitHub history using the authenticated gh identity, with pagination, caps and resumable caching. Does not accept unverified activity records.",
            handler: guard(() => github.requestRefresh()),
        },
        {
            name: "set_github_settings",
            description: "Select explicit GitHub organizations and repositories (union) for manual discovery. Empty scope pauses imports; earned history is retained.",
            inputSchema: { type: "object", properties: { enabled: { type: "boolean" }, repositories: { type: "array", maxItems: 100, items: { type: "string" } }, organizations: { type: "array", maxItems: 100, items: { type: "string" } } } },
            handler: guard((input) => store.setGitHubSettings(input)),
        },
        {
            name: "get_ticket_progress",
            description: "Returns ticket-based progress: ticket and challenge bonus XP, level, totals by type, today/weekly/monthly counts, streaks, challenges, and recent rewarded tickets.",
            handler: guard(() => {
                const view = store.view();
                return { mode: view.mode, progress: view.progress, challenges: view.challenges.filter((challenge) => challenge.count), recent: view.recent, lastSync: view.sync.last };
            }),
        },
        {
            name: "interact_with_buddy",
            description: "Pet, feed (uses a treat), play with, rest, or wake the buddy. Plays the animation in the open canvas.",
            inputSchema: {
                type: "object",
                required: ["action"],
                properties: { action: { type: "string", enum: ["pet", "feed", "play", "rest", "wake"] } },
            },
            handler: guard((input) => store.interact(input.action, "agent")),
        },
        {
            name: "customize_buddy_evolution",
            description: "Switch free buddy types, display owned stages, buy the next evolution using shared credits, or reset all lines for a full refund. Read current evolution.revision and mode first; reset requires the user's confirmation.",
            inputSchema: { type: "object", required: ["action", "revision", "mode"], properties: {
                action: { type: "string", enum: ["switch", "select", "upgrade", "reset"] },
                type: { type: "string", enum: ["robot", "cat", "dog", "dragon", "slime"] },
                stage: { type: "integer", minimum: 1, maximum: 5 }, revision: { type: "integer", minimum: 0 }, mode: { type: "string", enum: ["live", "demo"] },
            } },
            handler: guard((input) => store.evolve(input)),
        },
        {
            name: "rename_buddy",
            description: "Renames the buddy (1-24 characters).",
            inputSchema: {
                type: "object",
                required: ["name"],
                properties: { name: { type: "string", minLength: 1, maxLength: 24 } },
            },
            handler: guard((input) => store.rename(input.name)),
        },
        {
            name: "equip_accessory",
            description: "Equips an unlocked customization item (color, eyes, style, hat, glasses, headphones, neckwear, room, wall, furniture). Furniture toggles; pass enabled to set it explicitly.",
            inputSchema: {
                type: "object",
                required: ["itemId"],
                properties: {
                    itemId: { type: "string", enum: [...ITEM_BY_ID.keys()] },
                    enabled: { type: "boolean" },
                },
            },
            handler: guard((input) => store.equip(input.itemId, { enabled: input.enabled })),
        },
        {
            name: "unequip_accessory",
            description: "Removes the accessory in a slot.",
            inputSchema: {
                type: "object",
                required: ["slot"],
                properties: { slot: { type: "string", enum: ACCESSORY_SLOTS } },
            },
            handler: guard((input) => store.unequip(input.slot)),
        },
        {
            name: "get_available_customizations",
            description: "Lists every customization item with its slot, unlocked/equipped state, and unlock requirement.",
            handler: guard(() => store.catalog()),
        },
        {
            name: "set_demo_mode",
            description: "Turns Demo Mode on or off. Demo progress is kept separate from real ticket progress.",
            inputSchema: {
                type: "object",
                required: ["enabled"],
                properties: { enabled: { type: "boolean" } },
            },
            handler: guard((input) => store.setMode(input.enabled ? "demo" : "live")),
        },
        {
            name: "simulate_demo_ticket",
            description: "Demo Mode only: simulates closing one or more tickets today to preview rewards and challenges. kind \"mixed\" alternates HD and normal.",
            inputSchema: {
                type: "object",
                properties: {
                    kind: { type: "string", enum: ["normal", "hd", "critical", "mixed"], default: "normal" },
                    count: { type: "integer", minimum: 1, maximum: 100, default: 1 },
                },
            },
            handler: guard((input) => store.simulateDemoTicket(input.kind || "normal", input.count || 1)),
        },
    ],
});

sessionRef.current = await joinSession({ canvases: [canvas] });
