// The Lounge: shared org room UI. Pure helpers are exported for tests; createLoungeView owns the panel DOM.
const SVG_NS = "http://www.w3.org/2000/svg";
export const ROOM = { width: 160, height: 120, minX: 8, maxX: 152, minY: 64, maxY: 112 };
export const STEP = 6;
const BUDDY_WIDTH = 36;
const KEY_STEPS = {
    arrowleft: [-STEP, 0], a: [-STEP, 0], arrowright: [STEP, 0], d: [STEP, 0],
    arrowup: [0, -STEP], w: [0, -STEP], arrowdown: [0, STEP], s: [0, STEP],
};
const ACTIVE = new Set(["connecting", "connected", "reconnecting"]);

export function clampPoint(x, y) {
    const clamp = (value, min, max) => Math.round(Math.min(max, Math.max(min, Number(value) || 0)) * 10) / 10;
    return { x: clamp(x, ROOM.minX, ROOM.maxX), y: clamp(y, ROOM.minY, ROOM.maxY) };
}

export function clientToRoom(clientX, clientY, rect) {
    if (!rect?.width || !rect?.height) return null;
    return clampPoint((clientX - rect.left) / rect.width * ROOM.width, (clientY - rect.top) / rect.height * ROOM.height);
}

export function stepForKey(key) {
    return KEY_STEPS[String(key || "").toLowerCase()] || null;
}

export function statusText(lounge) {
    if (!lounge) return "Lounge unavailable in this session.";
    switch (lounge.status) {
        case "connecting": return "Connecting…";
        case "connected": {
            const count = lounge.members?.length || 0;
            return `Connected to ${lounge.org || "your org"} · ${count} here`;
        }
        case "reconnecting": return "Reconnecting…";
        case "error": return lounge.error?.message || lounge.error?.code || "Lounge error.";
        default: return "Not in the lounge.";
    }
}

/** Keyed reconciliation plan: which member ids to add, update, or remove. Later duplicates win. */
export function diffMembers(existingIds, members) {
    const next = new Map();
    for (const member of members || []) if (member && member.id !== undefined && member.id !== null) next.set(String(member.id), member);
    const existing = new Set([...existingIds].map(String));
    return {
        next,
        add: [...next.keys()].filter((id) => !existing.has(id)),
        update: [...next.keys()].filter((id) => existing.has(id)),
        remove: [...existing].filter((id) => !next.has(id)),
    };
}

export function memberTransform(member) {
    const { x, y } = clampPoint(member.x, member.y);
    return `translate(${x}px, ${y}px)`;
}

function asLoungeState(data) {
    const value = data?.lounge ?? data?.result ?? data;
    return value && typeof value === "object" && typeof value.status === "string" ? value : null;
}

export function createLoungeView({ api, esc, toast = () => {}, renderBuddy, buddyViewBox, getOrgs = () => [], getBuddy,
    doc = globalThis.document, setTimer = globalThis.setTimeout?.bind(globalThis), now = Date.now }) {
    const $ = (id) => doc.getElementById(id);
    const nodes = new Map();
    let lounge = { status: "idle", serverUrl: "", serverUrlSource: null, org: null, self: null, members: [], error: null };
    let available = true;
    let busy = false;
    let urlDirty = false;
    let orgKey = null;
    let target = null;
    let moveInFlight = false;
    let pendingMove = null;
    let sortTimer = null;

    function selfMember() {
        const selfId = lounge.self?.id;
        return selfId === undefined || selfId === null ? null : (lounge.members || []).find((member) => String(member.id) === String(selfId)) || null;
    }

    function buddyMarkup(member, self) {
        const buddy = member.buddy || {};
        const [left, top, width, height] = String(buddyViewBox(buddy.stage, buddy.variant, buddy.type)).split(/\s+/).map(Number);
        const scale = BUDDY_WIDTH / width;
        const marker = self ? '<rect class="lounge-self-marker" x="-9" y="-1" width="18" height="2"/>' : "";
        return `${marker}<svg x="${left * scale}" y="${top * scale}" width="${BUDDY_WIDTH}" height="${height * scale}" viewBox="${left} ${top} ${width} ${height}" overflow="visible" aria-hidden="true">${renderBuddy(buddy)}</svg>`
            + `<text class="lounge-label" x="0" y="7" font-size="5" text-anchor="middle">${esc(member.login)}</text>`;
    }

    function sortByDepth() {
        sortTimer = null;
        const layer = $("loungeMembersLayer");
        const ordered = [...nodes.values()].sort((a, b) => a.y - b.y || a.id.localeCompare(b.id));
        ordered.forEach((entry) => layer.appendChild(entry.el));
    }

    function renderRoom() {
        const layer = $("loungeMembersLayer");
        if (!layer) return;
        const self = selfMember();
        const plan = diffMembers(nodes.keys(), lounge.members);
        for (const id of plan.remove) { nodes.get(id).el.remove(); nodes.delete(id); }
        let reorder = plan.add.length > 0;
        for (const [id, member] of plan.next) {
            let entry = nodes.get(id);
            if (!entry) {
                const el = doc.createElementNS(SVG_NS, "g");
                el.setAttribute("class", "lounge-member");
                el.setAttribute("data-id", id);
                entry = { id, el, key: null, y: null };
                nodes.set(id, entry);
                el.style.transform = memberTransform(member);
                layer.appendChild(el);
            } else entry.el.style.transform = memberTransform(member);
            const isSelf = member === self;
            const key = JSON.stringify([member.login, member.buddy, isSelf]);
            if (entry.key !== key) {
                entry.el.innerHTML = buddyMarkup(member, isSelf);
                entry.el.setAttribute("class", isSelf ? "lounge-member lounge-self" : "lounge-member");
                entry.key = key;
            }
            if (entry.y !== null && entry.y !== member.y) reorder = true;
            entry.y = Number(member.y) || 0;
        }
        // Reordering re-inserts nodes, which cancels CSS transitions; wait until moves have settled.
        if (reorder && !sortTimer && setTimer) sortTimer = setTimer(sortByDepth, 450);
        const room = $("loungeRoom");
        room.setAttribute("aria-label", lounge.status === "connected"
            ? `Lounge room with ${plan.next.size} buddies. Click or tap the floor to move your buddy; arrow keys or W A S D step.`
            : "Lounge room. Join an organization to see who's here.");
    }

    function renderMembers() {
        const self = selfMember();
        const list = $("loungeMemberList");
        const html = (lounge.members || []).map((member) => `<li><strong>${esc(member.login)}</strong>${member.buddy?.name ? ` · ${esc(member.buddy.name)}` : ""}${member === self ? ' <span class="muted">(you)</span>' : ""}</li>`).join("");
        const next = html || '<li class="hint">Nobody here yet.</li>';
        if (list.innerHTML !== next) list.innerHTML = next;
    }

    function renderOrgs() {
        const orgs = getOrgs() || [];
        const select = $("loungeOrg");
        const key = JSON.stringify(orgs);
        if (orgKey !== key) {
            const previous = select.value || lounge.org;
            select.innerHTML = orgs.map((org) => `<option value="${esc(org)}">${esc(org)}</option>`).join("");
            const keep = orgs.find((org) => org.toLowerCase() === String(previous || "").toLowerCase());
            if (keep) select.value = keep;
            orgKey = key;
        }
        $("loungeOrgHint").hidden = orgs.length > 0;
        return orgs;
    }

    function renderControls() {
        const orgs = renderOrgs();
        const active = ACTIVE.has(lounge.status);
        const envUrl = lounge.serverUrlSource === "env";
        const url = $("loungeUrl");
        if (!urlDirty || envUrl) { url.value = lounge.serverUrl || ""; urlDirty = false; }
        url.disabled = !available || envUrl || busy;
        $("loungeUrlSave").disabled = !available || envUrl || busy;
        $("loungeUrlNote").textContent = envUrl ? "Set by BYTE_BUDDY_LOUNGE_URL" : lounge.serverUrl ? "" : "Set a lounge server URL to join.";
        $("loungeOrg").disabled = !available || active || busy || !orgs.length;
        $("loungeJoin").hidden = active;
        $("loungeJoin").disabled = !available || busy || !orgs.length || !lounge.serverUrl;
        $("loungeLeave").hidden = !active;
        $("loungeLeave").disabled = !available || busy;
        const status = available ? statusText(lounge) : statusText(null);
        const host = $("loungeStatus");
        if (host.textContent !== status) host.textContent = status;
        host.dataset.status = available ? lounge.status : "unavailable";
    }

    function render() {
        renderControls();
    }

    function update(next) {
        const value = asLoungeState(next);
        if (!value) return;
        available = true;
        lounge = { ...value, members: Array.isArray(value.members) ? value.members : [] };
        if (lounge.status !== "connected") { target = null; pendingMove = null; }
        renderControls();
        renderMembers();
        renderRoom();
    }

    function unavailable() {
        available = false;
        renderControls();
    }

    async function action(path, body) {
        if (busy) return;
        busy = true;
        renderControls();
        try {
            const result = await api(path, body);
            if (path === "/api/lounge/config") urlDirty = false;
            update(result);
            return result;
        } catch (error) {
            toast(`Lounge: ${error.message}`, "err");
        } finally {
            busy = false;
            renderControls();
        }
    }

    async function sendMove(point) {
        if (lounge.status !== "connected") return;
        target = { ...point, at: now() };
        if (moveInFlight) { pendingMove = point; return; }
        moveInFlight = true;
        try { await api("/api/lounge/move", point); }
        catch (error) { if (error.status !== 429) toast(`Lounge: ${error.message}`, "err"); }
        finally {
            moveInFlight = false;
            const next = pendingMove;
            pendingMove = null;
            if (next) sendMove(next);
        }
    }

    function currentPosition() {
        if (target && now() - target.at < 1000) return target;
        const self = selfMember();
        return self ? clampPoint(self.x, self.y) : null;
    }

    function wire() {
        $("loungeUrl").addEventListener("input", () => { urlDirty = true; });
        $("loungeUrlForm").addEventListener("submit", (event) => {
            event.preventDefault();
            action("/api/lounge/config", { url: $("loungeUrl").value.trim() });
        });
        $("loungeJoin").addEventListener("click", () => {
            const org = $("loungeOrg").value;
            if (!org) return;
            action("/api/lounge/join", { org, buddy: getBuddy() });
        });
        $("loungeLeave").addEventListener("click", () => action("/api/lounge/leave", {}));
        const room = $("loungeRoom");
        room.addEventListener("click", (event) => {
            const point = clientToRoom(event.clientX, event.clientY, room.getBoundingClientRect());
            if (point) sendMove(point);
        });
        room.addEventListener("keydown", (event) => {
            const step = stepForKey(event.key);
            if (!step || event.altKey || event.ctrlKey || event.metaKey) return;
            event.preventDefault();
            const from = currentPosition();
            if (from) sendMove(clampPoint(from.x + step[0], from.y + step[1]));
        });
    }

    wire();
    renderControls();
    return { update, render, unavailable, sendMove, get state() { return lounge; }, get available() { return available; } };
}
