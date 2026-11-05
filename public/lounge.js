// The Lounge: shared org room UI. Pure helpers are exported for tests; createLoungeView owns the panel DOM.
import { WORLD, SPAWN, DEAD_ZONE, PARALLAX, isSolid, moveWithCollision, nearestWalkable, viewSize, clampCamera, cameraFollow, centerCamera, smoothCamera, parallaxOffset, labelsMarkup } from "./lounge-map.js";
import { paintMap, paintScenery } from "./lounge-art.js";
import { createLoungeVoiceView } from "./lounge-voice.js";

const SVG_NS = "http://www.w3.org/2000/svg";
export const ROOM = { width: WORLD.width, height: WORLD.height, minX: 0, maxX: WORLD.width, minY: 0, maxY: WORLD.height };
export const SPEED = 140;
const BUDDY_WIDTH = 80;
const SEND_INTERVAL_MS = 100;
const REMOTE_SPEED = SPEED * 1.25;
const SNAP_DISTANCE = 120;
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

export function chatLines(text, columns = 28) {
    const lines = [];
    let line = "";
    for (const word of String(text || "").trim().split(/\s+/)) {
        const characters = Array.from(word);
        if (line && Array.from(line).length + characters.length + 1 > columns) { lines.push(line); line = ""; }
        while (characters.length > columns) lines.push(characters.splice(0, columns).join(""));
        const remainder = characters.join("");
        if (remainder) line += `${line ? " " : ""}${remainder}`;
    }
    if (line) lines.push(line);
    return lines;
}

const hex = (color) => `#${color.toString(16).padStart(6, "0")}`;

/** Uploads a painted RGBA buffer into a blob (or data) URL the SVG can show as one pixelated image. */
async function imageUrl(doc, art) {
    const canvas = doc.createElement("canvas");
    canvas.width = art.width;
    canvas.height = art.height;
    canvas.getContext("2d").putImageData(new ImageData(art.data, art.width, art.height), 0, 0);
    const blob = canvas.toBlob && globalThis.URL?.createObjectURL ? await new Promise((resolve) => canvas.toBlob(resolve, "image/png")) : null;
    const url = blob ? URL.createObjectURL(blob) : canvas.toDataURL("image/png");
    // Decode up front so every layer appears in the same frame instead of popping in one by one.
    const Picture = doc.defaultView?.Image || globalThis.Image;
    const picture = Picture ? new Picture() : null;
    if (picture) {
        picture.src = url;
        try { await picture.decode?.(); } catch { /* the SVG still loads it, just a frame later */ }
    }
    return { url, picture };
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 0));
let sceneArt = null;

/** Paints the skyline and the office once per page, yielding between the heavy steps so the UI stays responsive. */
export function loadSceneArt(doc) {
    sceneArt ||= (async () => {
        await pause();
        const layers = {};
        // Keep only the encoded images; the raw RGBA buffers (tens of MB) can be collected.
        for (const [key, { canvas, x, y, fill }] of Object.entries(paintScenery())) {
            layers[key] = { x, y, fill, width: canvas.width, height: canvas.height, ...(await imageUrl(doc, canvas)) };
        }
        await pause();
        const map = paintMap();
        return { layers, map: { ...(await imageUrl(doc, map)), width: map.width, height: map.height } };
    })();
    sceneArt.catch(() => { sceneArt = null; });
    return sceneArt;
}

export function imageMarkup(url, x, y, width, height) {
    return `<image href="${url}" x="${x}" y="${y}" width="${width}" height="${height}" preserveAspectRatio="none" style="image-rendering: pixelated" aria-hidden="true"/>`;
}

function asLoungeState(data) {
    const value = data?.lounge ?? data?.result ?? data;
    return value && typeof value === "object" && typeof value.status === "string" ? value : null;
}

export function createLoungeView({ api, esc, toast = () => {}, renderBuddy, buddyViewBox, getOrgs = () => [], getBuddy, reduced = () => false,
    doc = globalThis.document, raf = globalThis.requestAnimationFrame?.bind(globalThis), now = () => globalThis.performance?.now?.() ?? Date.now(),
    ResizeObserver: Observer = globalThis.ResizeObserver, deadZone = DEAD_ZONE, desktop = false, wallNow = Date.now }) {
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
    let voice = null;
    let chatSending = false;
    let chatOpen = false;

    function mountScene() {
        const labels = $("loungeLabels");
        if (labels && !labels.innerHTML) labels.innerHTML = labelsMarkup();
    }

    let artRequested = false;
    /** The pixel art needs a real canvas, so it is painted the first time the room is actually on screen. */
    function mountArt() {
        if (artRequested || typeof doc.createElement !== "function" || typeof globalThis.ImageData !== "function") return;
        artRequested = true;
        loadSceneArt(doc).then(({ layers, map }) => {
            const ids = { far: "loungeSceneryFar", mid: "loungeSceneryMid", near: "loungeSceneryNear" };
            for (const [key, layer] of Object.entries(layers)) {
                const node = $(ids[key]);
                if (!node) continue;
                const { width, height } = layer;
                const below = layer.fill === null ? "" : `<rect x="${layer.x}" y="${layer.y + height}" width="${width}" height="${WORLD.height * 2}" fill="${hex(layer.fill)}"/>`;
                node.innerHTML = imageMarkup(layer.url, layer.x, layer.y, width, height) + below;
            }
            const mapNode = $("loungeMap");
            if (mapNode) mapNode.innerHTML = imageMarkup(map.url, 0, 0, map.width, map.height);
        }, () => { artRequested = false; });
    }

    function applyCamera() {
        const room = $("loungeRoom");
        if (!room) return;
        const x = Math.round(cam.x * 4) / 4, y = Math.round(cam.y * 4) / 4;
        const key = `${x} ${y} ${view.width} ${view.height}`;
        if (appliedCam === key) return;
        appliedCam = key;
        room.setAttribute("viewBox", key);
        for (const layer of PARALLAX) {
            const offset = parallaxOffset({ x, y }, layer);
            $(layer.id)?.setAttribute("transform", `translate(${Math.round(offset.x * 4) / 4} ${Math.round(offset.y * 4) / 4})`);
        }
    }

    /** Recomputes the visible world size from the panel and keeps the camera's buddy framing. */
    function measure() {
        const rect = $("loungeRoom")?.getBoundingClientRect?.();
        if (!rect || !(rect.width > 0) || !(rect.height > 0)) return;
        mountArt();
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

    function chromeMarkup(member) {
        const name = member.buddy?.name?.trim() || "Byte Buddy";
        return `<circle class="lounge-voice-ring" cx="46" cy="-50" r="5" aria-hidden="true"/><text class="lounge-label" x="0" y="18" font-size="12" text-anchor="middle">${esc(name)}</text><text class="lounge-username" x="0" y="30" font-size="8" text-anchor="middle">${esc(member.login)}</text>`;
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

    function drawChat(entry) {
        const chat = available && lounge.status === "connected" && entry.chat?.expiresAt > wallNow() ? entry.chat : null;
        const key = chat ? JSON.stringify([chat.text, chat.expiresAt, entry.buddyKey, entry.login]) : "";
        if (entry.chatKey === key) return Boolean(chat);
        entry.chatKey = key;
        entry.bubble.style.display = chat ? "" : "none";
        entry.bubble.setAttribute("aria-label", chat ? `${entry.login}: ${chat.text}` : "");
        if (!chat) { entry.bubble.innerHTML = ""; return false; }
        const lines = chatLines(chat.text);
        const width = Math.max(44, ...lines.map((line) => Array.from(line).length * 6.25 + 16));
        const height = lines.length * 13 + 12;
        const [, top, spriteWidth] = String(buddyViewBox(entry.buddy.stage, entry.buddy.variant, entry.buddy.type)).split(/\s+/).map(Number);
        const bottom = top * BUDDY_WIDTH / spriteWidth - 10;
        const y = bottom - height;
        entry.bubble.innerHTML = `<rect x="${-width / 2}" y="${y}" width="${width}" height="${height}" rx="6"/><path d="M -5 ${bottom} L 0 ${bottom + 6} L 5 ${bottom}"/><text text-anchor="middle">${lines.map((line, index) => `<tspan x="0" y="${y + 15 + index * 13}">${esc(line)}</tspan>`).join("")}</text>`;
        return true;
    }

    function place(entry, pos, time) {
        const dx = pos.x - entry.pos.x, dy = pos.y - entry.pos.y;
        if (Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001) {
            entry.movedAt = time;
            if (Math.abs(dx) > 0.001) entry.look = Math.sign(dx);
        }
        entry.pos = pos;
        entry.el.style.transform = memberTransform(pos);
        entry.bubble.style.transform = memberTransform(pos);
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
            if (drawChat(entry)) active = true;
            if (next.x !== entry.target.x || next.y !== entry.target.y || time - entry.movedAt < WALK_LINGER_MS) active = true;
        }
        voice?.position(selfPos);
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
        for (const id of plan.remove) { nodes.get(id).el.remove(); nodes.get(id).bubble.remove(); nodes.delete(id); }
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
                const bubble = doc.createElementNS(SVG_NS, "g");
                bubble.setAttribute("class", "lounge-chat-bubble");
                bubble.setAttribute("data-id", id);
                bubble.setAttribute("role", "img");
                el.appendChild(sprite);
                el.appendChild(chrome);
                const start = isSelf ? selfPos : target;
                entry = { id, el, sprite, chrome, bubble, key: null, buddy: {}, buddyKey: "", spriteKey: null, pos: start, target: start, look: 0, movedAt: -Infinity, self: false };
                nodes.set(id, entry);
                el.style.transform = memberTransform(start);
                bubble.style.transform = memberTransform(start);
                layer.appendChild(el);
                $("loungeChatLayer").appendChild(bubble);
            }
            entry.target = isSelf ? selfPos : target;
            entry.self = isSelf;
            entry.chat = member.chat;
            entry.login = member.login;
            if (!raf) place(entry, entry.target, time);
            const key = JSON.stringify([member.login, member.buddy?.name, isSelf]);
            if (entry.key !== key) {
                entry.chrome.innerHTML = chromeMarkup(member);
                entry.el.setAttribute("class", isSelf ? "lounge-member lounge-self" : "lounge-member");
                entry.key = key;
            }
            const buddyKey = JSON.stringify(member.buddy || {});
            if (entry.buddyKey !== buddyKey) { entry.buddy = member.buddy || {}; entry.buddyKey = buddyKey; }
            drawSprite(entry, time);
            drawChat(entry);
        }
        sortByDepth();
        applyCamera();
        queueFrame();
        const room = $("loungeRoom");
        room.setAttribute("aria-label", lounge.status === "connected"
            ? `Lounge room with ${plan.next.size} buddies. Hold the arrow keys to walk your buddy. Press Enter to chat.`
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
        renderChatControls();
    }

    function renderChatControls() {
        const input = $("loungeChatInput");
        input.disabled = !available || lounge.status !== "connected";
        if (input.disabled) chatOpen = false;
        $("loungeChatForm").hidden = !chatOpen;
        $("loungeChatOpen").hidden = input.disabled || chatOpen;
        $("loungeChatOpen").setAttribute("aria-expanded", String(chatOpen));
        $("loungeChatSend").disabled = input.disabled || chatSending || !input.value.trim();
    }

    function openChat() {
        if (!available || lounge.status !== "connected") return;
        stopMoving();
        chatOpen = true;
        renderChatControls();
        $("loungeChatInput").focus({ preventScroll: true });
    }

    function closeChat(returnFocus = false) {
        const wasOpen = chatOpen;
        chatOpen = false;
        renderChatControls();
        if (wasOpen && returnFocus && !doc.hidden && !$("loungeView")?.hidden) $("loungeRoom").focus({ preventScroll: true });
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
        voice?.update(lounge);
        renderControls();
        renderMembers();
        renderRoom();
    }

    function unavailable() {
        available = false;
        voice?.deactivate();
        for (const entry of nodes.values()) drawChat(entry);
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

    async function sendChat() {
        const input = $("loungeChatInput");
        const draft = input.value;
        const text = draft.trim();
        if (!available || lounge.status !== "connected" || chatSending || !text) return;
        chatSending = true;
        renderChatControls();
        try {
            await api("/api/lounge/chat", { text });
            if (input.value === draft) {
                input.value = "";
                closeChat(doc.activeElement === input || doc.activeElement === $("loungeChatSend"));
            }
        } catch (error) {
            toast(`Lounge: ${error.message}`, "err");
        } finally {
            chatSending = false;
            renderChatControls();
        }
    }

    function wire() {
        $("loungeChatOpen").addEventListener("click", openChat);
        $("loungeChatForm").addEventListener("submit", (event) => { event.preventDefault(); void sendChat(); });
        $("loungeChatInput").addEventListener("input", renderChatControls);
        $("loungeChatInput").addEventListener("keydown", (event) => {
            if (event.isComposing || event.keyCode === 229) return;
            if (event.key === "Escape") { event.preventDefault(); closeChat(true); }
            else if (event.key === "Enter") {
                event.preventDefault();
                if (!event.repeat) void sendChat();
            }
        });
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
        $("loungeLeave").addEventListener("click", () => { voice?.deactivate(); void action("/api/lounge/leave", {}); });
        const room = $("loungeRoom");
        room.addEventListener("pointerdown", (event) => {
            if (event.button !== 0) return;
            closeChat();
            room.focus({ preventScroll: true });
        });
        room.addEventListener("keydown", (event) => {
            if (event.key === "Enter" && !event.altKey && !event.ctrlKey && !event.metaKey && lounge.status === "connected") {
                event.preventDefault();
                if (!event.repeat && !event.isComposing) openChat();
                return;
            }
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
    voice = createLoungeVoiceView({ api, doc, desktop, onSpeaking: (speaking) => {
        for (const [id, entry] of nodes) entry.el.setAttribute("data-speaking", String(speaking.has(id)));
    } });
    renderControls();
    measure();
    applyCamera();
    return { update, render, unavailable, sendMove, deactivate() { stopMoving(); closeChat(); voice.deactivate(); }, get state() { return lounge; }, get available() { return available; },
        get camera() { return { ...cam }; }, get view() { return { ...view }; }, get position() { return selfPos && { ...selfPos }; } };
}
