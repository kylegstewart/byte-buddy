// The Lounge: shared org room UI. Pure helpers are exported for tests; createLoungeView owns the panel DOM.
import { WORLD, SPAWN, DEAD_ZONE, isSolid, moveWithCollision, nearestWalkable, viewSize, clampCamera, cameraFollow, centerCamera, smoothCamera, parallaxOffset, mapMarkup, sceneryMarkup, labelsMarkup } from "./lounge-map.js";

const SVG_NS = "http://www.w3.org/2000/svg";
export const ROOM = { width: WORLD.width, height: WORLD.height, minX: 0, maxX: WORLD.width, minY: 0, maxY: WORLD.height };
export const SPEED = 140;
const BUDDY_WIDTH = 32;
const SEND_INTERVAL_MS = 100;
const REMOTE_SPEED = SPEED * 1.25;
const SNAP_DISTANCE = 120;
const PARALLAX = [["loungeSceneryFar", 0.15], ["loungeSceneryMid", 0.4], ["loungeSceneryNear", 0.7]];
const WALK_FRAME_MS = 120;
const WALK_LINGER_MS = 150;
const KEY_DIRECTIONS = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] };
const ACTIVE = new Set(["connecting", "connected", "reconnecting"]);

export function clampPoint(x, y) {
    const clamp = (value, min, max) => Math.round(Math.min(max, Math.max(min, Number(value) || 0)) * 10) / 10;
    return { x: clamp(x, ROOM.minX, ROOM.maxX), y: clamp(y, ROOM.minY, ROOM.maxY) };
}

export function directionForKey(key) {
    return KEY_DIRECTIONS[String(key || "").toLowerCase()] || null;
}

/** Unit velocity for the held arrow keys; opposite keys cancel and diagonals are normalized. */
export function heldVelocity(held) {
    let dx = 0, dy = 0;
    for (const key of held) { const dir = KEY_DIRECTIONS[key]; if (dir) { dx += dir[0]; dy += dir[1]; } }
    const length = Math.hypot(dx, dy);
    return length ? [dx / length, dy / length] : [0, 0];
}

/** Moves a displayed point toward its target at a capped speed; far jumps (spawns, rejoins) snap. */
export function approach(from, to, maxStep) {
    const dx = to.x - from.x, dy = to.y - from.y;
    const distance = Math.hypot(dx, dy);
    if (distance <= maxStep || distance > SNAP_DISTANCE) return { x: to.x, y: to.y };
    return { x: from.x + dx / distance * maxStep, y: from.y + dy / distance * maxStep };
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
    const x = Math.round(member.x * 10) / 10, y = Math.round(member.y * 10) / 10;
    return `translate(${x}px, ${y}px)`;
}

function asLoungeState(data) {
    const value = data?.lounge ?? data?.result ?? data;
    return value && typeof value === "object" && typeof value.status === "string" ? value : null;
}

export function createLoungeView({ api, esc, toast = () => {}, renderBuddy, buddyViewBox, getOrgs = () => [], getBuddy, reduced = () => false,
    doc = globalThis.document, raf = globalThis.requestAnimationFrame?.bind(globalThis), now = () => globalThis.performance?.now?.() ?? Date.now(),
    ResizeObserver: Observer = globalThis.ResizeObserver, deadZone = DEAD_ZONE }) {
    const $ = (id) => doc.getElementById(id);
    const nodes = new Map();
    let lounge = { status: "idle", serverUrl: "", serverUrlSource: null, org: null, self: null, members: [], error: null };
    let available = true;
    let busy = false;
    let urlDirty = false;
    let orgKey = null;
    let moveInFlight = false;
    let pendingMove = null;
    const held = new Set();
    let selfPos = null;
    let selfId = null;
    let lastSent = -Infinity;
    let lastFrame = null;
    let frameQueued = false;
    let order = [];
    let view = viewSize(0, 0);
    let cam = centerCamera(SPAWN, view);
    let camGoal = cam;
    let appliedCam = null;

    function mountScene() {
        const map = $("loungeMap");
        if (!map || map.dataset?.mounted) return;
        const scenery = sceneryMarkup();
        map.innerHTML = mapMarkup();
        if (map.dataset) map.dataset.mounted = "1";
        const layers = { loungeSceneryFar: scenery.far, loungeSceneryMid: scenery.mid, loungeSceneryNear: scenery.near, loungeLabels: labelsMarkup() };
        for (const [id, html] of Object.entries(layers)) { const node = $(id); if (node) node.innerHTML = html; }
    }

    function applyCamera() {
        const room = $("loungeRoom");
        if (!room) return;
        const x = Math.round(cam.x * 4) / 4, y = Math.round(cam.y * 4) / 4;
        const key = `${x} ${y} ${view.width} ${view.height}`;
        if (appliedCam === key) return;
        appliedCam = key;
        room.setAttribute("viewBox", key);
        for (const [id, factor] of PARALLAX) {
            const offset = parallaxOffset({ x, y }, factor);
            $(id)?.setAttribute("transform", `translate(${Math.round(offset.x * 4) / 4} ${Math.round(offset.y * 4) / 4})`);
        }
    }

    /** Recomputes the visible world size from the panel and keeps the camera's buddy framing. */
    function measure() {
        const rect = $("loungeRoom")?.getBoundingClientRect?.();
        if (!rect || !(rect.width > 0) || !(rect.height > 0)) return;
        const next = viewSize(rect.width, rect.height);
        if (next.width === view.width && next.height === view.height) return;
        const focus = selfPos || { x: cam.x + view.width / 2, y: cam.y + view.height / 2 };
        view = next;
        cam = clampCamera(cam, view);
        camGoal = cameraFollow(clampCamera(camGoal, view), focus, view, deadZone);
        cam = camGoal;
        applyCamera();
    }

    function followCamera(dt) {
        if (selfPos) camGoal = cameraFollow(camGoal, selfPos, view, deadZone);
        cam = smoothCamera(cam, camGoal, dt);
        applyCamera();
        return cam.x !== camGoal.x || cam.y !== camGoal.y;
    }

    function selfMember() {
        const selfId = lounge.self?.id;
        return selfId === undefined || selfId === null ? null : (lounge.members || []).find((member) => String(member.id) === String(selfId)) || null;
    }

    function chromeMarkup(member, self) {
        const marker = self ? '<rect class="lounge-self-marker" x="-14" y="-1" width="28" height="3"/>' : "";
        return `${marker}<text class="lounge-label" x="0" y="14" font-size="10" text-anchor="middle">${esc(member.login)}</text>`;
    }

    function spriteMarkup(buddy, pose, frame, look, still) {
        const [left, top, width, height] = String(buddyViewBox(buddy.stage, buddy.variant, buddy.type)).split(/\s+/).map(Number);
        const scale = BUDDY_WIDTH / width;
        const art = renderBuddy({ ...buddy, pose, frame, look, still });
        const lift = pose === "walk" && !still && frame % 2 ? scale : 0;
        return `<svg x="${left * scale}" y="${top * scale - lift}" width="${BUDDY_WIDTH}" height="${height * scale}" viewBox="${left} ${top} ${width} ${height}" overflow="visible" aria-hidden="true">${art}</svg>`;
    }

    function drawSprite(entry, time) {
        const walking = time - entry.movedAt < WALK_LINGER_MS;
        const still = Boolean(reduced());
        const pose = walking ? "walk" : "stand";
        const frame = walking && !still ? Math.floor(time / WALK_FRAME_MS) : 0;
        const look = walking ? entry.look : 0;
        const key = `${entry.buddyKey}|${pose}|${frame}|${look}|${still}`;
        if (entry.spriteKey === key) return;
        entry.sprite.innerHTML = spriteMarkup(entry.buddy, pose, frame, look, still);
        entry.spriteKey = key;
    }

    function place(entry, pos, time) {
        const dx = pos.x - entry.pos.x, dy = pos.y - entry.pos.y;
        if (Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001) {
            entry.movedAt = time;
            if (Math.abs(dx) > 0.001) entry.look = Math.sign(dx);
        }
        entry.pos = pos;
        entry.el.style.transform = memberTransform(pos);
    }

    function sortByDepth() {
        const ordered = [...nodes.values()].sort((a, b) => a.pos.y - b.pos.y || a.id.localeCompare(b.id));
        if (ordered.length === order.length && ordered.every((entry, i) => entry === order[i])) return;
        const layer = $("loungeMembersLayer");
        ordered.forEach((entry) => layer.appendChild(entry.el));
        order = ordered;
    }

    function queueFrame() {
        if (frameQueued || !raf) return;
        frameQueued = true;
        raf(tick);
    }

    // One loop drives local prediction for your buddy and smoothing for everyone else.
    function tick() {
        frameQueued = false;
        const time = now();
        const dt = lastFrame === null ? 1 / 60 : Math.min(0.1, Math.max(0, (time - lastFrame) / 1000));
        lastFrame = time;
        let active = held.size > 0;
        const [vx, vy] = heldVelocity(held);
        if (selfPos && (vx || vy)) {
            selfPos = moveWithCollision(selfPos, vx * SPEED * dt, vy * SPEED * dt);
            if (time - lastSent >= SEND_INTERVAL_MS) { lastSent = time; sendMove(clampPoint(selfPos.x, selfPos.y)); }
        }
        for (const entry of nodes.values()) {
            const next = entry.self && selfPos ? selfPos : approach(entry.pos, entry.target, REMOTE_SPEED * dt);
            place(entry, next, time);
            drawSprite(entry, time);
            if (next.x !== entry.target.x || next.y !== entry.target.y || time - entry.movedAt < WALK_LINGER_MS) active = true;
        }
        sortByDepth();
        if (followCamera(dt)) active = true;
        if (active) queueFrame();
        else lastFrame = null;
    }

    function stopMoving() {
        if (!held.size) return;
        held.clear();
        if (selfPos) { lastSent = now(); sendMove(clampPoint(selfPos.x, selfPos.y)); }
        queueFrame();
    }

    function renderRoom() {
        const layer = $("loungeMembersLayer");
        if (!layer) return;
        const self = selfMember();
        const plan = diffMembers(nodes.keys(), lounge.members);
        for (const id of plan.remove) { nodes.get(id).el.remove(); nodes.delete(id); }
        if (plan.remove.length) order = order.filter((entry) => nodes.has(entry.id));
        const time = now();
        for (const [id, member] of plan.next) {
            const isSelf = member === self;
            const target = clampPoint(member.x, member.y);
            if (isSelf && !selfPos) {
                selfPos = target;
                // Old clients or stale saves can place you inside furniture; step out and tell the room.
                if (isSolid(selfPos.x, selfPos.y)) { selfPos = nearestWalkable(selfPos); sendMove(clampPoint(selfPos.x, selfPos.y)); }
                camGoal = centerCamera(selfPos, view);
                cam = camGoal;
            }
            let entry = nodes.get(id);
            if (!entry) {
                const el = doc.createElementNS(SVG_NS, "g");
                el.setAttribute("class", "lounge-member");
                el.setAttribute("data-id", id);
                const sprite = doc.createElementNS(SVG_NS, "g");
                sprite.setAttribute("class", "lounge-sprite");
                const chrome = doc.createElementNS(SVG_NS, "g");
                el.appendChild(sprite);
                el.appendChild(chrome);
                const start = isSelf ? selfPos : target;
                entry = { id, el, sprite, chrome, key: null, buddy: {}, buddyKey: "", spriteKey: null, pos: start, target: start, look: 0, movedAt: -Infinity, self: false };
                nodes.set(id, entry);
                el.style.transform = memberTransform(start);
                layer.appendChild(el);
            }
            entry.target = isSelf ? selfPos : target;
            entry.self = isSelf;
            if (!raf) place(entry, entry.target, time);
            const key = JSON.stringify([member.login, isSelf]);
            if (entry.key !== key) {
                entry.chrome.innerHTML = chromeMarkup(member, isSelf);
                entry.el.setAttribute("class", isSelf ? "lounge-member lounge-self" : "lounge-member");
                entry.key = key;
            }
            const buddyKey = JSON.stringify(member.buddy || {});
            if (entry.buddyKey !== buddyKey) { entry.buddy = member.buddy || {}; entry.buddyKey = buddyKey; }
            drawSprite(entry, time);
        }
        sortByDepth();
        applyCamera();
        queueFrame();
        const room = $("loungeRoom");
        room.setAttribute("aria-label", lounge.status === "connected"
            ? `Lounge room with ${plan.next.size} buddies. Hold the arrow keys to walk your buddy.`
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
        measure();
    }

    function update(next) {
        const value = asLoungeState(next);
        if (!value) return;
        available = true;
        lounge = { ...value, members: Array.isArray(value.members) ? value.members : [] };
        const nextSelfId = lounge.self?.id ?? null;
        if (lounge.status !== "connected" || String(nextSelfId) !== String(selfId)) { held.clear(); selfPos = null; pendingMove = null; }
        selfId = nextSelfId;
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
        room.addEventListener("keydown", (event) => {
            if (!directionForKey(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
            event.preventDefault();
            if (lounge.status !== "connected" || !selfPos) return;
            held.add(event.key.toLowerCase());
            queueFrame();
        });
        room.addEventListener("keyup", (event) => {
            const key = String(event.key || "").toLowerCase();
            if (!held.has(key)) return;
            if (held.size === 1) stopMoving();
            else { held.delete(key); queueFrame(); }
        });
        room.addEventListener("blur", stopMoving);
        doc.addEventListener?.("visibilitychange", () => { if (doc.hidden) stopMoving(); });
        if (Observer) new Observer(measure).observe(room);
    }

    mountScene();
    wire();
    renderControls();
    measure();
    applyCamera();
    return { update, render, unavailable, sendMove, get state() { return lounge; }, get available() { return available; },
        get camera() { return { ...cam }; }, get view() { return { ...view }; }, get position() { return selfPos && { ...selfPos }; } };
}
