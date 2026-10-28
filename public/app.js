import { W, FLOOR_Y, buddy as robot, room, furnitureLayer, FURNITURE, buddyMetrics as artMetrics, sprites, rect } from "./art.js";
import { createPetMotion } from "./pet-motion.js";
import { createLoungeView } from "./lounge.js";

const CFG = window.BUDDY_CONFIG || {};
const $ = (id) => document.getElementById(id);
function metrics(stage, variant = state?.appearance?.variant, type = state?.evolution?.active || "robot") {
    return artMetrics(stage, variant, type);
}
const CATEGORIES = [
    { slot: "bodyColor", label: "Color" },
    { slot: "eyeColor", label: "Eyes" },
    { slot: "variant", label: "Style" },
    { slot: "hat", label: "Hats" },
    { slot: "glasses", label: "Glasses" },
    { slot: "headphones", label: "Headphones" },
    { slot: "neck", label: "Neckwear" },
    { slot: "room", label: "Room" },
    { slot: "wall", label: "Walls" },
    { slot: "furniture", label: "Furniture" },
];
const ACCESSORY_SLOTS = ["hat", "glasses", "headphones", "neck"];
const MOOD_EXPR = { Happy: "smile", Excited: "excited", Curious: "curious", Sleepy: "sleepy", Relaxed: "normal" };

let state = null;
let ui = { tab: "home", customize: "evolution", category: "bodyColor", progress: "ticket", range: "all", ticketRange: "all",
    challenges: { source: "all", status: "all", type: "all", sort: "default" },
    achievements: { source: "all", status: "all", type: "all", sort: "default" } };
const chartModels = new Map();
let githubRefreshing = false;
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const numberFormatters = new Map();
function numberFormatter(digits) {
    if (!numberFormatters.has(digits)) numberFormatters.set(digits, new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }));
    return numberFormatters.get(digits);
}
const fmt = (n) => numberFormatter(3).format(Number(n || 0));
const sectionKeys = new Map();
function cachedSection(id, data, draw) {
    const key = JSON.stringify(data);
    if (sectionKeys.get(id) === key) return;
    draw();
    sectionKeys.set(id, key);
}
function setHtml(host, html) {
    if (host.innerHTML !== html) host.innerHTML = html;
}

// ---------- API ----------
async function api(path, body) {
    const res = await fetch(path, {
        method: body === undefined ? "GET" : "POST",
        headers: { "x-buddy-token": CFG.token, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { code: data.code, status: res.status });
    return data;
}

const analyticsCache = new Map();
function analyticsKey(source, range) {
    return JSON.stringify([state?.mode, state?.analyticsRevision, source, range]);
}

function selectedAnalytics(source) {
    return analyticsCache.get(analyticsKey(source, source === "ticket" ? ui.ticketRange : ui.range));
}

function ensureAnalytics(source) {
    const range = source === "ticket" ? ui.ticketRange : ui.range;
    const key = analyticsKey(source, range);
    if (analyticsCache.has(key)) return analyticsCache.get(key);
    const revision = state.analyticsRevision;
    const mode = state.mode;
    // Keep only the current snapshot; an open modal owns its own immutable rows.
    for (const [cachedKey, value] of analyticsCache) {
        if (value.revision !== revision || value.mode !== mode) analyticsCache.delete(cachedKey);
    }
    const entry = { status: "loading", revision, mode, timeline: [], metrics: null };
    analyticsCache.set(key, entry);
    (async () => {
        try {
            let offset = 0;
            for (;;) {
                const query = new URLSearchParams({ source, range, offset: String(offset), limit: "180", revision });
                const page = await api(`/api/analytics?${query}`);
                if (analyticsKey(source, range) !== key || analyticsCache.get(key) !== entry) return;
                if (page.revision !== revision || page.source !== source || String(page.range) !== range
                    || page.offset !== offset || !Array.isArray(page.timeline) || !page.metrics || typeof page.metrics !== "object") throw new Error("Analytics snapshot changed. Please retry.");
                entry.timeline.push(...page.timeline);
                entry.metrics = page.metrics;
                if (!page.hasMore) break;
                if (!page.timeline.length) throw new Error("Analytics returned an empty page. Please retry.");
                offset += page.timeline.length;
            }
            entry.status = "ready";
        } catch (error) {
            if (analyticsKey(source, range) !== key || analyticsCache.get(key) !== entry) return;
            entry.status = "error";
            entry.error = error.status === 409 ? "Activity changed while loading. Retry to load a fresh snapshot." : error.message;
            if (error.status === 409) await loadState();
        }
        if (ui.tab === "progress" && ui.progress === source && analyticsKey(source, source === "ticket" ? ui.ticketRange : ui.range) === key) renderProgress();
    })();
    return entry;
}

function analyticsStatus(entry, source) {
    return entry.status === "error"
        ? `<div class="analytics-status" role="alert"><p>Couldn't load daily analytics: ${esc(entry.error)}</p><button type="button" class="btn" data-analytics-retry="${source}">Retry analytics</button></div>`
        : '<div class="analytics-status" role="status" aria-live="polite">Loading selected analytics…</div>';
}

function updateRangeButtons(source) {
    const range = source === "ticket" ? ui.ticketRange : ui.range;
    for (const btn of $(`${source}Ranges`).querySelectorAll("button")) btn.setAttribute("aria-pressed", String(btn.dataset.range === range));
}

function clearSourceCharts(source) {
    const chartPrefix = `${source === "ticket" ? "local time" : "UTC"}:chart:`;
    for (const key of chartModels.keys()) {
        if (key.startsWith(`${source}:`) || key.startsWith(chartPrefix)) chartModels.delete(key);
    }
}

let fetching = false;
let refetch = false;
async function loadState() {
    if (fetching) { refetch = true; return; }
    fetching = true;
    try {
        const next = await api("/api/state");
        const pendingEvolutionIds = new Set((next.celebrations || []).filter((event) => event.type === "evolution").map((event) => event.id));
        for (let i = modalQueue.length - 1; i >= 0; i--) {
            if (modalQueue[i].type === "evolution" && !pendingEvolutionIds.has(modalQueue[i].id)) modalQueue.splice(i, 1);
        }
        if (state && `${state.mode}:${state.evolution?.active}:${state.progress.stage}` !== `${next.mode}:${next.evolution?.active}:${next.progress.stage}`) {
            petMotion.reset();
            if (petPointerId !== null && $("scene").hasPointerCapture(petPointerId)) $("scene").releasePointerCapture(petPointerId);
            petPointerId = null;
            $("scene").classList.remove("pet-grabbed");
            actor.x = actor.target = 80;
            action = null;
            if (evolution) {
                if (pendingEvolutionIds.has(evolution.event.id)) modalQueue.unshift(evolution.event);
                modalOpen = false;
                evolutionModalOpen = false;
                evolution = null;
            }
        }
        state = next;
        render();
        processCelebrations();
    } catch (error) {
        toast(`Couldn't load Byte Buddy: ${error.message}`, "err");
    } finally {
        fetching = false;
        if (refetch) { refetch = false; loadState(); }
    }
}

function connectEvents() {
    const source = new EventSource(`/api/events?t=${encodeURIComponent(CFG.token)}`);
    source.addEventListener("change", () => loadState());
    source.addEventListener("fx", (event) => {
        try { handleFx(JSON.parse(event.data)); } catch { /* ignore malformed */ }
    });
    mountLounge(source);
}

// ---------- The Lounge ----------
let loungeView = null;
let loungeVersion = 0;

function mountLounge(source) {
    try {
        loungeView = createLoungeView({
            api, esc, toast, renderBuddy: robot, buddyViewBox: robotViewBox,
            getOrgs: () => state?.github?.settings?.organizations || [],
            getBuddy: () => ({ ...robotOpts(), name: state?.name }),
        });
    } catch { return; }
    source.addEventListener("lounge", (event) => {
        loungeVersion++;
        try { loungeView.update(JSON.parse(event.data)); } catch { /* ignore malformed */ }
    });
    source.addEventListener("open", () => {
        const version = loungeVersion;
        api("/api/lounge").then((data) => { if (version === loungeVersion) loungeView.update(data); }, () => loungeView.unavailable());
    });
}

// ---------- GitHub connection (draft DOM is deliberately independent of state/SSE renders) ----------
let githubEditorReady = false;
let connectionBusy = false;
function githubSyncBlocked() {
    const settings = state?.github?.settings;
    return !settings?.enabled || Boolean(settings.needsScope);
}
function mountConnectionEditor() {
    if ($("connectionEditor")) return;
    $("savedConnections").innerHTML = `<div id="connectionEditor" class="connection-stack">
      <p id="connectionStatus" role="status" aria-live="polite"></p>
      <section class="card connection-stack" aria-labelledby="githubConnectionTitle">
        <h2 id="githubConnectionTitle" class="section-title">GitHub · manual sync only</h2>
        <p id="githubConnectionIdentity" class="hint"></p>
        <p id="githubConnectionScope" class="hint"></p>
        <form id="githubConnectionForm" class="connection-stack">
          <label class="connection-check"><input id="githubConnectionEnabled" type="checkbox">Enable scoped GitHub activity</label>
          <label for="githubOrganizations">Organizations (one per line)<textarea id="githubOrganizations" rows="3" placeholder="my-organization" spellcheck="false"></textarea></label>
          <label for="githubRepositories">Repositories (owner/name, one per line)<textarea id="githubRepositories" rows="3" placeholder="owner/repository" spellcheck="false"></textarea></label>
          <p class="hint">The union of these organizations and repositories is included. Choose at least one when enabled. There is no all-contributions option. Identity is pinned to the authenticated gh account; change accounts in gh, not here. Saving never starts a sync.</p>
          <div class="connection-actions"><button id="saveGithubConnection" type="submit" class="btn">Save GitHub settings</button><button id="connectionGithubSync" type="button" class="btn">Sync GitHub now</button></div>
        </form>
      </section>
    </div>`;
    $("githubConnectionForm").onsubmit = (event) => { event.preventDefault(); saveGithubConnection(); };
    $("connectionGithubSync").onclick = () => connectionAction(async () => {
        await api("/api/github/sync", {}); await loadState();
        connectionMessage("Manual GitHub sync finished. Review Home for import coverage.");
    });
}
function connectionMessage(text) { $("connectionStatus").textContent = text; }
function renderConnections() {
    mountConnectionEditor();
    const g = state.github || {};
    const settings = g.settings || {};
    if (!githubEditorReady && g.settings) {
        $("githubConnectionEnabled").checked = Boolean(settings.enabled);
        $("githubOrganizations").value = (settings.organizations || []).join("\n");
        $("githubRepositories").value = (settings.repositories || []).join("\n");
        githubEditorReady = true;
    }
    $("githubConnectionIdentity").textContent = g.identity ? `Pinned gh identity: ${g.identity.login || g.identity.userId || "verified account"}${g.identity.host ? ` · ${g.identity.host}` : ""}. Last sync ${relTime(g.lastSync?.fetchedAt || g.lastSync?.at)}.` : "No verified gh identity yet. Sign in using gh; the backend verifies the authenticated account on manual sync.";
    $("githubConnectionScope").textContent = `${settings.needsScope ? "Scope required: select organizations or repositories before syncing. " : ""}Disabled integrations keep earned history.`;
    if (!connectionBusy) $("connectionGithubSync").disabled = githubSyncBlocked();
    $("connectionsNotice").hidden = !settings.needsScope || state.mode === "demo";
}
async function connectionAction(action) {
    if (connectionBusy) return;
    connectionBusy = true;
    const controls = [...$("connectionEditor").querySelectorAll("button, input, textarea")];
    const disabled = controls.map((control) => control.disabled);
    controls.forEach((control) => { control.disabled = true; });
    connectionMessage("Working…");
    try { await action(); }
    catch (error) { connectionMessage(error.message); }
    finally {
        controls.forEach((control, index) => { control.disabled = disabled[index]; });
        connectionBusy = false;
        $("connectionGithubSync").disabled = githubSyncBlocked();
    }
}
function githubScopeValues(id) { return [...new Set($(id).value.split(/[\n,]+/).map((value) => value.trim()).filter(Boolean))]; }
async function saveGithubConnection() {
    const enabled = $("githubConnectionEnabled").checked;
    const organizations = githubScopeValues("githubOrganizations");
    const repositories = githubScopeValues("githubRepositories");
    if (enabled && !organizations.length && !repositories.length) { connectionMessage("Choose at least one GitHub organization or repository, or disable GitHub to skip it."); return; }
    if (organizations.some((value) => !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(value)) || repositories.some((value) => !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value))) { connectionMessage("Enter organization names and owner/repository names, not URLs or wildcards."); return; }
    await connectionAction(async () => {
        await api("/api/github/settings", { enabled, organizations, repositories });
        await loadState();
        connectionMessage("GitHub settings saved. Nothing was synced; use Sync GitHub now when ready.");
    });
}

// ---------- Helpers ----------
let catalogSource;
let catalogMap = new Map();
function catalogById() {
    if (catalogSource !== state?.catalog) {
        catalogSource = state?.catalog;
        catalogMap = new Map((catalogSource || []).map((item) => [item.id, item]));
    }
    return catalogMap;
}
function colorOf(itemId, fallback) {
    return catalogById().get(itemId)?.color || fallback;
}
function reducedMotion() {
    const pref = state?.prefs?.motion || "system";
    if (pref === "reduced") return true;
    if (pref === "full") return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
function isNight() {
    const pref = state?.prefs?.timeOfDay || "auto";
    if (pref !== "auto") return pref === "night";
    const hour = new Date().getHours();
    return hour < 7 || hour >= 19;
}
function relTime(iso) {
    const t = Date.parse(iso || "");
    if (!Number.isFinite(t)) return "never";
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 45) return "just now";
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} hr ago`;
    return `${Math.round(s / 86400)} days ago`;
}
function shortDate(iso) {
    const t = Date.parse(iso || "");
    return Number.isFinite(t) ? new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : "numeric" }) : "";
}
function robotOpts(overrides = {}) {
    const a = state.appearance;
    return {
        stage: state.progress.stage,
        type: state.evolution?.active || "robot",
        variant: a.variant,
        body: colorOf(a.bodyColor, "#3fb8af"),
        eye: colorOf(a.eyeColor, "#7cf8ff"),
        hat: a.hat, glasses: a.glasses, headphones: a.headphones, neck: a.neck,
        ...overrides,
    };
}
function robotViewBox(stage, variant, type = state?.evolution?.active || "robot") {
    const m = metrics(stage, variant, type);
    const top = m.headTop - 18;
    return m.viewBox || `-26 ${top} 52 ${-top + 4}`;
}

// ---------- Toasts ----------
function toast(text, kind = "") {
    const host = $("toasts");
    const el = document.createElement("div");
    el.className = `toast ${kind}`;
    el.textContent = text;
    host.appendChild(el);
    while (host.children.length > 3) host.firstChild.remove();
    setTimeout(() => el.remove(), kind === "err" ? 5000 : 3400);
}

// ---------- Rendering ----------
function render() {
    if (!state) return;
    $("app").removeAttribute("aria-busy");
    document.body.classList.toggle("reduced", reducedMotion());
    renderConnections();
    const p = state.progress;
    const demo = state.mode === "demo";

    $("demoPill").hidden = !demo;
    $("demoBanner").hidden = !demo;
    $("demoToggle").checked = demo;
    for (const seg of document.querySelectorAll(".seg")) {
        const value = state.prefs[seg.dataset.pref];
        for (const btn of seg.querySelectorAll("button")) btn.setAttribute("aria-checked", String(btn.dataset.value === value));
    }

    $("buddyName").textContent = state.name;
    $("levelChip").textContent = `Lv ${p.level}`;
    $("stageChip").textContent = p.stageName;
    $("moodChip").textContent = state.care.sleeping ? "Sleeping" : state.mood;

    const span = p.nextLevelXp - p.levelFloorXp;
    const into = p.xp - p.levelFloorXp;
    $("xpLeft").textContent = `Level ${p.level} → ${p.level + 1}`;
    $("xpRight").textContent = `${fmt(into)} / ${fmt(span)} XP · ${fmt(p.xp)} total`;
    const pct = Math.max(0, Math.min(100, Math.round(p.levelProgress * 100)));
    $("xpFill").style.width = `${pct}%`;
    $("xpBar").setAttribute("aria-valuenow", String(pct));
    setHtml($("xpSources"), `<span>Tickets <strong>${fmt(p.ticketTotalXp ?? (p.xp - (p.githubXp || 0) - (p.migrationXp || 0)))} XP</strong></span><span class="github-source">GitHub <strong>${fmt(p.githubXp)} XP</strong></span>${p.migrationXp > 0 ? `<span title="One-time curve conversion credit preserving previous level progress">Progress preserved <strong>${fmt(p.migrationXp)} XP</strong></span>` : ""}`);

    if (ui.tab === "home") { renderHome(); renderGitHubHome(); renderTicketHome(); }
    renderSync();
    if (ui.tab === "customize") renderCustomizePanel();
    if (ui.tab === "progress") renderProgress();
    if (ui.tab === "challenges") renderChallenges();
    if (ui.tab === "achievements") renderAchievements();
    if (ui.tab === "lounge") loungeView?.render();
    renderRoom();
    $("scene").setAttribute("aria-label", `${state.name}, a level ${p.level} ${p.stageName}, is ${state.care.sleeping ? "sleeping" : state.mood.toLowerCase()}. Click the buddy to pet; hold for one second to pick up, then drag and release. Enter or Space pets; Escape cancels.`);
}

function renderHome() {
    $("statMood").textContent = state.care.sleeping ? "Sleeping" : state.mood;
    $("statTreats").textContent = fmt(state.treats);
    $("feedCount").textContent = String(state.treats);
    $("restLabel").textContent = state.care.sleeping ? "Wake" : "Rest";
    $("restBtn").dataset.care = state.care.sleeping ? "wake" : "rest";
    $("restBtn").querySelector(".care-ico").textContent = state.care.sleeping ? "☀" : "☾";
    $("mAffection").style.width = `${state.care.affection}%`;
    $("mEnergy").style.width = `${state.care.energy}%`;
    $("mFullness").style.width = `${state.care.fullness}%`;
}

function ticketItems(list, emptyText) {
    if (!list.length) return `<li class="empty">${esc(emptyText)}</li>`;
    return list.map((t) => {
        const kind = t.demo ? `<span class="kind kind-demo">DEMO</span>` : "";
        const label = { normal: "Ticket", hd: "Help Desk", critical: "Critical" }[t.kind] || t.kind;
        const status = t.status === "revoked" ? "Reopened · XP held until closed again" : `Closed ${shortDate(t.closedOn)}`;
        const number = t.ticketNumber ?? t.id;
        const link = `https://mymeyer.meyerdistributing.com/it/ticket-list?ticketNum=${encodeURIComponent(number)}`;
        const id = t.demo ? `#${esc(number)}` : `<a href="${esc(link)}" target="_blank" rel="noopener noreferrer">#${esc(number)}</a>`;
        return `<li class="${t.status === "revoked" ? "revoked" : ""}"><span class="tid">${id}</span><span class="ttitle" title="${esc(t.title)}">${kind}<span class="kind kind-${esc(t.kind)}">${label}</span>${esc(t.title)}</span><span class="txp">+${fmt(t.xp)} XP</span><span class="tmeta">${esc(status)}</span></li>`;
    }).join("");
}

function renderSync() {
    const sync = state.sync;
    const demo = state.mode === "demo";
    const btn = $("refreshBtn");
    btn.disabled = sync.syncing || demo;
    btn.title = demo ? "Exit demo mode to sync your real tickets" : "Check the IT ticket system for newly closed tickets";
    $("refreshLabel").textContent = sync.syncing ? "Syncing…" : "Sync Tickets";
    let status;
    if (demo) status = "Demo mode uses simulated tickets. Your real tickets keep syncing separately.";
    else if (sync.syncing) {
        const pr = sync.progress;
        status = pr ? `${pr.phase}${pr.totalPages ? ` (${pr.page}/${pr.totalPages})` : pr.page ? ` (page ${pr.page})` : ""}…` : "Syncing…";
    } else if (sync.handoffPending) status = "Asked Copilot to fetch your tickets — waiting for results…";
    else if (sync.last) status = `Last synced ${relTime(sync.last.at)} · ${fmt(sync.last.received)} assigned tickets checked`;
    else status = "Not synced yet. Click Sync Tickets to import your closed tickets.";
    $("syncStatus").textContent = status;

    const attempt = sync.lastAttempt;
    const failed = !demo && attempt && !attempt.ok && (!sync.last || Date.parse(attempt.at) > Date.parse(sync.last.at));
    $("syncError").hidden = !failed || sync.syncing;
    if (failed) $("syncError").textContent = `Couldn't reach the IT ticket system (${attempt.error}). ${sync.last ? "Showing your last synced progress." : "Try again, or ask Copilot to sync your tickets."}`;

    $("syncOverlay").hidden = !(sync.syncing && !demo);
    $("syncOverlayText").textContent = status;
    $("syncDetails").textContent = sync.last
        ? `Signed in as ${state.userId}. Last sync ${relTime(sync.last.at)} via ${sync.last.method === "direct" ? "IT server" : "Copilot"}; ${fmt(state.progress.total)} closed tickets rewarded.`
        : `Signed in as ${state.userId}. No successful sync yet.`;
}

function renderCustomize() {
    const items = state.catalog;
    $("catTabs").innerHTML = CATEGORIES.map((c) => {
        const inSlot = items.filter((i) => i.slot === c.slot);
        const unlocked = inSlot.filter((i) => i.unlocked).length;
        return `<button type="button" role="tab" data-cat="${c.slot}" aria-selected="${c.slot === ui.category}">${c.label}<span class="count">${unlocked}/${inSlot.length}</span></button>`;
    }).join("");
    const hints = {
        wall: "Wall colors show in the Cozy Room and Server Room.",
        furniture: "Toggle any unlocked furniture on or off.",
        variant: "Body style changes your buddy's silhouette.",
    };
    $("catHint").textContent = hints[ui.category] || "Unlocked items can be equipped anytime. Unlocks are permanent.";
    const slot = ui.category;
    const tiles = [];
    if (ACCESSORY_SLOTS.includes(slot)) {
        const none = !state.appearance[slot];
        tiles.push(`<button type="button" class="item ${none ? "equipped" : ""}" data-unequip="${slot}" aria-pressed="${none}"><div class="thumb">${thumbFor({ slot, id: null })}</div><span class="item-name">None</span>${none ? '<span class="badge">ON</span>' : ""}</button>`);
    }
    for (const item of items.filter((i) => i.slot === slot)) {
        tiles.push(`<button type="button" class="item ${item.equipped ? "equipped" : ""} ${item.unlocked ? "" : "locked"}" data-item="${esc(item.id)}" aria-pressed="${item.equipped}" ${item.unlocked ? "" : 'aria-disabled="true"'} title="${esc(item.unlocked ? item.name : `Locked — ${item.requirement}`)}">
            <div class="thumb">${thumbFor(item)}</div>
            <span class="item-name">${esc(item.name)}</span>
            ${item.unlocked ? "" : `<span class="item-req">${esc(item.requirement)}</span><span class="lock" aria-label="Locked">🔒</span>`}
            ${item.equipped ? '<span class="badge">ON</span>' : ""}
        </button>`);
    }
    $("itemGrid").innerHTML = tiles.join("");
}

function thumbFor(item) {
    const slot = item.slot;
    if (["bodyColor", "eyeColor", "wall"].includes(slot)) return `<span class="swatch" style="background:${esc(item.color)}"></span>`;
    if (slot === "room") return `<svg viewBox="0 0 160 120" shape-rendering="crispEdges" aria-hidden="true">${room({ room: item.id, wall: colorOf(state.appearance.wall, "#f3e9d2"), night: isNight() })}</svg>`;
    if (slot === "furniture") {
        const f = FURNITURE[item.id];
        const view = f.view ? f.view.join(" ") : `-3 -3 ${f.w + 6} ${f.h + 6}`;
        return `<svg viewBox="${view}" shape-rendering="crispEdges" aria-hidden="true">${f.draw({ night: false })}</svg>`;
    }
    const overrides = { expr: "smile", still: true };
    if (slot === "variant") overrides.variant = item.id;
    else overrides[slot] = item.id;
    const opts = robotOpts(overrides);
    return `<svg viewBox="${robotViewBox(opts.stage, opts.variant)}" shape-rendering="crispEdges" aria-hidden="true">${robot(opts)}</svg>`;
}

function renderCustomizePanel() {
    for (const btn of $("customizeNav").querySelectorAll("button")) {
        const selected = btn.dataset.customize === ui.customize;
        btn.setAttribute("aria-selected", String(selected));
        btn.tabIndex = selected ? 0 : -1;
    }
    $("evolutionCustomize").hidden = ui.customize !== "evolution";
    $("accessoriesCustomize").hidden = ui.customize !== "accessories";
    if (ui.customize === "accessories") renderCustomize();
    else renderEvolution();
}

function renderProgress() {
    for (const btn of $("progressNav").querySelectorAll("button")) {
        const selected = btn.dataset.progress === ui.progress;
        btn.setAttribute("aria-selected", String(selected));
        btn.tabIndex = selected ? 0 : -1;
    }
    $("ticketProgress").hidden = ui.progress !== "ticket";
    $("githubProgress").hidden = ui.progress !== "github";
    if (ui.progress === "github") renderGitHubProgress();
    else {
        updateRangeButtons("ticket");
        const entry = ensureAnalytics("ticket");
        if (entry.status !== "ready") {
            clearSourceCharts("ticket");
            $("ticketRangeNote").textContent = "Choose a range to load daily ticket analytics. Overall XP and shared unlocks are never filtered.";
            setHtml($("progressStats"), "");
            replaceDetails($("ticketCharts"), analyticsStatus(entry, "ticket"));
            sectionKeys.delete("ticketCharts");
            setHtml($("recentList"), ticketItems(state.recent || [], "No recorded tickets."));
            return;
        }
        renderTicketCharts();
        const timeline = entry.timeline;
        const p = entry.metrics;
        setHtml($("progressStats"), statCards([
            ["Ticket XP", metric(p.ticketTotalXp), "xp"], ["Ticket base XP", metric(p.ticketXp), "baseXp"],
            ["Tickets closed", metric(p.total), "total"], ["Help Desk incl. critical", metric(p.hd), (day) => day.hd + day.critical],
            ["Critical", metric(p.critical), "critical"], ["Today", metric(p.today)], ["This week", metric(p.week)], ["This month", metric(p.month)],
            ["Best streak", `${metric(p.longestStreak)}d`], ["Current streak", `${metric(p.currentStreak)}d`], ["Reopened", metric(p.reopened), "reopened"],
        ], "ticket", timeline));
        const recent = ui.ticketRange === "all" ? state.recent : rangeTimeline((state.recent || []).filter((ticket) => Number.isFinite(Date.parse(ticket.closedOn))).map((ticket) => ({ ...ticket, date: localDay(ticket.closedOn) })), ui.ticketRange);
        setHtml($("recentList"), ticketItems(recent, "No recorded tickets in this range."));
    }
}

let evolutionPending = false;
let evolutionModalOpen = false;
const evolutionLocked = () => evolutionPending || Boolean(evolution) || evolutionModalOpen || modalQueue.some((c) => c.type === "evolution");
let evolutionReset = null;
function renderEvolution() {
    const e = state.evolution;
    if (!e) return;
    $("evoWallet").textContent = `${fmt(e.available)} evolution credits${e.deficit ? ` · ${fmt(e.deficit)} XP deficit to cover` : ""}`;
    $("evoCreditNote").textContent = `Credits are shared by every buddy. Spending never lowers your level.${e.legacyCredit ? ` Includes ${fmt(e.legacyCredit)} credits for your previous robot evolution.` : ""}`;
    setHtml($("buddyTypes"), e.types.map((type) => `<button type="button" class="btn btn-sm" data-evo-action="switch" data-buddy="${type.id}" aria-pressed="${type.id === e.active}" ${evolutionLocked() ? "disabled" : ""}>${esc(type.name)}</button>`).join(""));
    const line = e.buddies[e.active];
    const type = e.types.find((type) => type.id === e.active);
    setHtml($("evoTrack"), type.stages.map(({ name, stage, cost }) => {
        const owned = stage <= line.owned;
        const isNext = stage === line.owned + 1;
        const affordable = isNext && e.balance >= cost;
        const cls = stage === line.selected ? "current" : owned ? "past" : `future${isNext ? " next" : ""}${affordable ? " affordable" : ""}`;
        const label = owned ? "Owned" : affordable ? `Buy · ${fmt(cost)} credits` : isNext ? `Next · ${fmt(cost)} credits` : `${fmt(cost)} credits`;
        const buy = isNext ? ` data-evo-action="upgrade" role="button" tabindex="0" aria-disabled="${!affordable || evolutionLocked()}" aria-label="${affordable ? `Buy ${esc(name)} for ${fmt(cost)} credits` : `${esc(name)}: next evolution, ${fmt(Math.max(0, cost - e.balance))} more credits needed`}"` : "";
        const opts = robotOpts({ stage, expr: "smile", still: true, hat: null, glasses: null, headphones: null, neck: null });
        const display = owned ? `<button type="button" class="btn btn-sm" data-evo-action="select" data-stage="${stage}" ${evolutionLocked() || stage === line.selected ? "disabled" : ""} aria-label="Display ${esc(name)}">${stage === line.selected ? "Active" : "Display"}</button>` : "";
        return `<li class="evo ${cls}" aria-current="${stage === line.selected ? "step" : "false"}"${buy}><svg viewBox="${robotViewBox(5, opts.variant)}" shape-rendering="crispEdges" aria-hidden="true">${robot(opts)}</svg><strong>${esc(name)}</strong><span class="muted">${label}</span>${display}</li>`;
    }).join(""));
    $("evoNext").textContent = e.nextCost === null ? "This buddy's evolution line is fully owned. Switch freely or display an earlier stage." : `Next: ${type.stages[line.owned].name} · ${fmt(e.nextCost)} credits. ${e.balance >= e.nextCost ? "Click its card to buy it." : `Need ${fmt(e.nextCost - e.balance)} more credits.`}`;
    $("evoReset").disabled = evolutionLocked() || !e.spent;
    $("evoReset").textContent = `Reset all evolutions · refund ${fmt(e.spent)} credits`;
}

async function changeEvolution(action, type = state.evolution.active, stage) {
    if (evolutionLocked()) return;
    const snapshot = { revision: state.evolution.revision, mode: state.mode };
    evolutionPending = true;
    renderEvolution();
    try {
        const result = await api("/api/evolution", { action, type, stage, ...snapshot });
        $("evoStatus").textContent = action === "reset" ? `Refunded ${fmt(result.result.refunded)} credits. All buddies are stage 1.` : action === "upgrade" ? "Evolution purchased!" : "Buddy updated.";
    } catch (error) { $("evoStatus").textContent = error.message; }
    finally { evolutionPending = false; await loadState(); }
}

const TIER_COLORS = {
    Bronze: { fill: "#cd7f32", shade: "#804719", shine: "#f5c58e" },
    Silver: { fill: "#c0c0c0", shade: "#737e8b", shine: "#f1f5fa" },
    Gold: { fill: "#ffd23f", shade: "#c98b18", shine: "#fff1ad" },
    Platinum: { fill: "#b6d9dc", shade: "#567f8a", shine: "#edffff" },
    Diamond: { fill: "#89d8ff", shade: "#4273b8", shine: "#effaff" },
};
const tierName = (tier) => Object.hasOwn(TIER_COLORS, tier) ? tier : "Bronze";
const tierPill = (tier) => `<span class="tier tier-${tierName(tier).toLowerCase()}">${esc(tierName(tier))}</span>`;

function filteredCatalog(items, kind) {
    const filter = ui[kind];
    const rows = items.filter((item) => {
        const earned = kind === "achievements" ? Boolean(item.unlockedAt) : Boolean(item.count);
        const type = kind === "achievements" ? tierName(item.tier) : item.repeat;
        return (filter.source === "all" || (item.category || "ticket") === filter.source)
            && (filter.status === "all" || earned === (filter.status === "earned"))
            && (filter.type === "all" || (filter.type === "secret" ? item.secret : type === filter.type));
    });
    const grades = Object.keys(TIER_COLORS);
    const compare = {
        name: (a, b) => a.name.localeCompare(b.name),
        xp: (a, b) => b.xp - a.xp,
        completed: (a, b) => (b.count || 0) - (a.count || 0),
        recent: (a, b) => (Date.parse(b.unlockedAt) || 0) - (Date.parse(a.unlockedAt) || 0),
        grade: (a, b) => grades.indexOf(tierName(b.tier)) - grades.indexOf(tierName(a.tier)),
    }[filter.sort];
    return compare ? rows.sort(compare) : rows;
}

function renderAchievements() {
    const all = state.achievements || [];
    const rows = filteredCatalog(all, "achievements");
    $("achCount").textContent = `${all.filter((a) => a.unlockedAt).length}/${all.length} unlocked · showing ${rows.length}`;
    setHtml($("achList"), rows.length ? rows.map((a) => `<li class="ach ${a.unlockedAt ? "" : "locked"}">
        <svg class="medal" viewBox="0 0 12 12" shape-rendering="crispEdges" aria-hidden="true">${medal(Boolean(a.unlockedAt), a.tier)}</svg>
        <div><div class="ach-name">${esc(a.name)} ${categoryBadge(a.category)}${tierPill(a.tier)}</div><div class="ach-desc">${esc(a.description)} · ${a.unlockedAt ? `Earned ${shortDate(a.unlockedAt)}` : "Locked"}</div>${a.rewards?.length ? `<div class="ach-desc">Unlocks: ${esc(a.rewards.join(", "))}</div>` : ""}</div>
    </li>`).join("") : '<li class="empty">No achievements match these filters.</li>');
}

const REPEAT_LABEL = { day: "per day", week: "per week", month: "per month", ticket: "per ticket", once: "once" };
const DAILY_GOALS = [[3, "Hat Trick"], [5, "High Five"], [10, "Perfect Ten"]];

function renderChallenges() {
    const list = state.challenges || [];
    const p = state.progress;
    $("chalCount").textContent = `${list.filter((c) => c.count).length}/${list.length} · +${fmt(list.reduce((sum, c) => sum + (c.xpEarned || 0), 0))} XP`;
    const goal = DAILY_GOALS.find(([n]) => p.today < n);
    $("chalToday").textContent = goal
        ? `Today: ${p.today} closed — ${goal[0] - p.today} more for ${goal[1]}!`
        : `Today: ${p.today} closed — Perfect Ten earned. Legendary day!`;
    const rows = filteredCatalog(list, "challenges");
    $("chalCount").textContent += ` · showing ${rows.length}`;
    setHtml($("chalList"), rows.length ? rows.map((c) => {
        const hidden = c.secret && !c.count;
        const times = c.count > 1 ? ` ×${fmt(c.count)}` : "";
        return `<li class="chal ${c.count ? "done" : ""} ${hidden ? "secret" : ""}">
        <div class="chal-head"><span class="chal-name">${hidden ? "🔒 " : c.secret ? "★ " : ""}${esc(c.name)}${times}</span><span class="chal-xp">+${fmt(c.xp)} XP</span></div>
        <div class="ach-desc">${esc(c.description)}</div>
        <div>${categoryBadge(c.category)}${c.treats ? `<span class="ach-desc">${fmt(c.treats)} treats</span>` : ""}</div>
        ${challengeMeter(c)}
        <div class="ach-desc">${esc(REPEAT_LABEL[c.repeat] || c.repeat)}${c.count ? ` · earned ${fmt(c.xpEarned)} XP` : ""}</div>
    </li>`;
    }).join("") : '<li class="empty">No challenges match these filters.</li>');
}

// ---------- GitHub progress ----------
const knownNumber = (n) => typeof n === "number" && Number.isFinite(n);
const metric = (n, digits = 0) => knownNumber(n) ? numberFormatter(digits).format(n) : "—";
const rate = (n) => knownNumber(n) ? `${metric(n * 100, 1)}%` : "—";
const activityLabel = (name) => ({
    opened: "PRs opened", merged: "Own PRs merged", mergedBy: "PRs merged by you", reviewed: "PRs reviewed", helpful: "Helpful feedback",
    clean: "Clean merges", focused: "Focused PRs", improvements: "Quality improvement", bonus: "Challenge bonuses", challenge: "Challenge bonuses",
    constructive: "Constructive feedback", readiness: "Review readiness",
})[name] || String(name).replace(/[_-]/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
const dateFormatters = new Map();
const chartDate = (date, timeZone = "UTC") => {
    const local = timeZone === "local time";
    const time = Date.parse(local && /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T12:00:00` : date);
    if (!Number.isFinite(time)) return "";
    if (!dateFormatters.has(timeZone)) dateFormatters.set(timeZone, new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", ...(local ? {} : { timeZone }) }));
    return dateFormatters.get(timeZone).format(time);
};

function categoryBadge(category) {
    const names = { github: "GitHub", ticket: "Ticket", combined: "Combined", care: "Buddy care", overall: "Overall" };
    return `<span class="kind ${category === "github" ? "kind-github" : category === "combined" || category === "care" || category === "overall" ? "kind-bonus" : "kind-normal"}">${names[category] || "Ticket"}</span>`;
}

function challengeMeter(c) {
    if (!knownNumber(c.target) || c.target <= 0 || !knownNumber(c.progress)) return "";
    const value = Math.max(0, c.progress);
    return `<div class="challenge-progress"><progress max="${c.target}" value="${Math.min(value, c.target)}" aria-label="${esc(c.name)} progress"></progress><span>${metric(value, 1)} / ${metric(c.target, 1)}</span></div>`;
}

function statCards(stats, source, timeline = []) {
    return stats.map(([label, value, field, seriesLabel]) => {
        if (!source) return `<div class="stat"><span class="stat-label" title="${esc(label)}">${esc(label)}</span><span class="stat-value">${esc(value)}</span></div>`;
        const key = `${source}:stat:${label}`;
        const related = !field;
        const dailyLabel = seriesLabel || (related ? source === "ticket" ? "Tickets closed" : "Own PRs merged" : label);
        const read = typeof field === "function" ? field : (day) => day[field || (source === "ticket" ? "total" : "merged")];
        chartModels.set(key, { title: `${label} · ${value}`, timeline, series: [{ label: dailyLabel, value: read }], style: "lines", timeZone: source === "ticket" ? "local time" : "UTC",
            note: related ? `The selected summary is ${value}. A daily series for this summary is not available; the chart shows related ${dailyLabel.toLowerCase()} activity, not daily ${label.toLowerCase()}.` : `Daily ${label.toLowerCase()} for the selected range. Only recorded days are shown; — means unavailable, not zero.` });
        return `<button type="button" class="stat" data-chart-key="${esc(key)}" aria-label="Expand ${esc(label)} chart: ${esc(value)}"><span class="stat-label" title="${esc(label)}">${esc(label)}</span><span class="stat-value">${esc(value)}</span></button>`;
    }).join("");
}

function mergerNote(a) {
    return a?.unknownMerger > 0 ? `${fmt(a.unknownMerger)} merged PRs have unknown merger identity; verified merge-action counts may be incomplete. Click Sync GitHub to backfill available evidence.` : "";
}

function qualityNote(a) {
    if (!a || !knownNumber(a.qualitySample) || !a.qualitySample) return "Clean merge rate unavailable: no merged PRs with sufficient review evidence. No review activity does not mean approval.";
    return `${fmt(a.clean)} clean / ${fmt(a.qualitySample)} assessed merged PRs · ${metric(a.unknownQuality)} with unknown quality. Clean requires complete observed reviews, human approval on the observed head and no actionable or ambiguous findings; not a defect-free guarantee.`;
}

function renderProgressHome(source, { stats, summary, goals }) {
    const prefix = source === "github" ? "github" : "ticket";
    const label = source === "github" ? "GitHub" : "ticket";
    setHtml($(`${prefix}HomeStats`), statCards(stats));
    $(source === "github" ? "githubQualityNote" : "ticketSummary").textContent = summary;
    setHtml($(`${prefix}HomeGoals`), `<strong class="mini-title">Challenge progress</strong>${goals.length ? goals.map((c) => `<div><span>${esc(c.name)}</span>${challengeMeter(c)}</div>`).join("") : '<p class="hint">No current challenges to display.</p>'}`);
    const earned = (state.achievements || []).filter((a) => a.category === source && a.unlockedAt).sort((a, b) => Date.parse(b.unlockedAt) - Date.parse(a.unlockedAt)).slice(0, 3);
    setHtml($(`${prefix}HomeAchievements`), `<strong class="mini-title">Recent ${label} achievements</strong>${earned.length ? earned.map((a) => `<span class="achievement-chip" title="${esc(a.description)}">★ ${esc(a.name)}${a.tier ? ` · ${esc(a.tier)}` : ""}</span>`).join("") : `<p class="hint">No ${label} achievements earned yet.</p>`}`);
}

function renderTicketHome() {
    const p = state.progress;
    const pending = DAILY_GOALS.filter(([target]) => (p.today || 0) < target);
    const goals = (pending.length ? pending.slice(0, 2) : DAILY_GOALS.slice(-1)).map(([target, name]) => ({ name: `${name} · today`, target, progress: p.today || 0 }));
    renderProgressHome("ticket", {
        stats: [
            ["Ticket XP", fmt(p.ticketTotalXp ?? (p.xp - (p.githubXp || 0) - (p.migrationXp || 0)))],
            ["Closed this week", fmt(p.week)], ["Tickets closed", fmt(p.total)],
            ["Help Desk incl. critical", fmt(p.hd)], ["Critical resolved", fmt(p.critical)],
            ["Closure streak", `${fmt(p.currentStreak)} d`],
        ],
        summary: `${fmt(p.today)} closed today · ${fmt(p.month)} this month · best streak ${fmt(p.longestStreak)} days. Ticket XP includes earned ticket challenge bonuses. Reopened tickets do not earn duplicate XP.`,
        goals,
    });
}

function githubScopeNote() {
    const settings = state.github?.settings;
    const scopes = [...(settings?.organizations || []).map((name) => `org:${name}`), ...(settings?.repositories || []).map((name) => `repo:${name}`)];
    const scope = scopes.length ? `Selected scope: ${scopes.slice(0, 3).join(", ")}${scopes.length > 3 ? ` (+${scopes.length - 3} more)` : ""}` : "Retained history only; choose organizations or repositories in Connections to import more";
    return `${settings?.enabled === false ? "Imports disabled · " : ""}${scope}`;
}

function renderGitHubHome() {
    const g = state.github;
    const a = g?.summary;
    const demo = state.mode === "demo";
    const syncing = githubRefreshing || g?.syncing;
    const btn = $("githubRefresh");
    btn.disabled = Boolean(syncing || demo || !g || githubSyncBlocked());
    btn.textContent = syncing ? "Importing…" : "Sync GitHub";
    btn.title = demo ? "Exit demo mode to sync real GitHub activity" : "Sync the signed-in GitHub developer's contributions";
    const identity = g?.identity ? `${g.identity.login} · ${g.identity.host}` : "No verified GitHub identity yet";
    const coverage = g?.coverage;
    const importing = coverage && g?.lastSync && (!g.lastSync.complete || syncing)
        ? ` · Imported history: ${fmt(coverage.processed)} / ${fmt(coverage.discovered)} PRs processed · ${fmt(coverage.pending)} pending${coverage.discovering ? " · more history to discover" : ""} · click Sync GitHub to continue` : "";
    const unavailable = coverage?.unavailable ? ` · ${fmt(coverage.unavailable)} PRs with unavailable evidence (not counted as clean)` : "";
    const pause = g?.lastAttempt?.ok === false ? g.lastAttempt : g?.lastSync;
    const paused = pause?.retryAt > Date.now() ? ` · ${pause.pauseReason === "rate_limit" ? "Rate-limit pause until" : "Error retry pause until"} ${new Date(pause.retryAt).toLocaleTimeString()}` : "";
    $("githubSyncStatus").textContent = demo ? "Demo mode · real GitHub sync is disabled."
        : `${identity} · ${syncing ? "Syncing…" : g?.lastSync ? `Last synced ${relTime(g.lastSync.fetchedAt || g.lastSync.at)}` : "Not synced yet"}${importing}${unavailable}${paused} · ${githubScopeNote()} · Manual sync only`;
    const failed = g?.lastAttempt && !g.lastAttempt.ok;
    $("githubSyncError").hidden = !failed || Boolean(syncing);
    if (failed) $("githubSyncError").textContent = `GitHub sync failed: ${g.lastAttempt.error || "Unknown error"}. ${g.lastSync ? "Last synced progress is preserved." : "Check GitHub sign-in and permissions, then retry."}`;
    renderProgressHome("github", {
        stats: [
            ["GitHub XP", g ? fmt(state.progress.githubXp ?? a?.xp) : "—"],
            ["XP this week", metric(a?.comparisons?.week?.current?.xp ?? a?.comparisons?.week?.current)],
            ["Own PRs merged", metric(a?.authoredMerged ?? a?.merged)], ["PRs merged by you", metric(a?.mergedBy)],
            ["PRs reviewed", metric(a?.reviewed)], ["Merge streak", knownNumber(a?.streakWeeks) ? `${fmt(a.streakWeeks)} wk` : "—"],
        ],
        summary: `Own PRs merged counts your authored work merged by anyone. Merged by you counts verified merge actions, including your own PRs; overlap earns no duplicate XP. ${mergerNote(a)} ${qualityNote(a)}`,
        goals: (state.challenges || []).filter((c) => c.category === "github" && c.target > 0).slice(0, 2),
    });
}

const disclosureStates = new WeakMap();
function replaceDetails(host, html) {
    if (host.innerHTML === html) return;
    const open = disclosureStates.get(host) || new Map();
    for (const detail of host.querySelectorAll("details[data-detail-key]")) open.set(detail.dataset.detailKey, detail.open);
    disclosureStates.set(host, open);
    host.innerHTML = html;
    for (const detail of host.querySelectorAll("details[data-detail-key]")) {
        if (open.has(detail.dataset.detailKey)) detail.open = open.get(detail.dataset.detailKey);
        if (detail.dataset.tableKey) hydrateDailyTable(detail);
    }
}

function rangeTimeline(timeline, range) {
    const cutoff = new Date();
    if (range === "all") return timeline;
    cutoff.setDate(cutoff.getDate() - Number(range) + 1);
    const dayKey = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}-${String(cutoff.getDate()).padStart(2, "0")}`;
    return timeline.filter((day) => day.date >= dayKey);
}

function renderTicketCharts() {
    const entry = selectedAnalytics("ticket");
    if (entry?.status === "ready") cachedSection("ticketCharts", [analyticsKey("ticket", ui.ticketRange)], drawTicketCharts);
}

function localDay(value = new Date()) {
    const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function drawTicketCharts() {
    const { metrics: selected, timeline } = selectedAnalytics("ticket");
    $("ticketRangeNote").textContent = `${ui.ticketRange === "all" ? "All time" : `Last ${ui.ticketRange} days`} · Stats and recent tickets follow this range. Cumulative XP includes history before the selected range.`;
    if (selected.undatedXp > 0 || selected.undatedTickets > 0) {
        $("ticketRangeNote").textContent += ` Legacy records without dates (${fmt(selected.undatedTickets)} tickets, ${fmt(selected.undatedXp)} XP) are included in lifetime totals but excluded from dated charts.`;
    }
    replaceDetails($("ticketCharts"),
        timelineChart("Ticket XP over time (cumulative)", timeline, [{ label: "Cumulative XP", value: (d) => d.cumulativeXp }], "lines", "local time")
        + timelineChart("Tickets closed per day", timeline, [{ label: "All tickets", value: (d) => d.total }], "bars", "local time")
        + timelineChart("Ticket types per day", timeline, [{ label: "Development", value: (d) => d.normal ?? Math.max(0, d.total - (d.hd || 0) - (d.critical || 0)) }, { label: "Help Desk (non-critical)", value: (d) => d.hd }, { label: "Critical", value: (d) => d.critical }], "bars", "local time"));
}

function timelineChart(title, timeline, series, style = "lines", timeZone = "UTC", expanded = false) {
    const key = `${timeZone}:chart:${title}`;
    if (!expanded) chartModels.set(key, { title, timeline: timeline || [], series, style, timeZone });
    const heading = expanded ? `<h3 class="card-title">${esc(title)}</h3>` : `<h3 class="card-title"><button type="button" class="chart-open" data-chart-key="${esc(key)}" aria-label="Expand ${esc(title)}">${esc(title)} <span aria-hidden="true">↗</span></button></h3>`;
    const card = `<section class="card chart-card"${expanded ? "" : ` data-chart-key="${esc(key)}"`}>${heading}`;
    if (!timeline?.length) return `${card}<p class="hint">No activity data for this range.</p></section>`;
    const width = expanded ? 900 : 420, height = expanded ? 260 : 120, pad = 12;
    const values = timeline.flatMap((d) => series.map((s) => s.value(d))).filter(knownNumber);
    if (!values.length) return `${card}<p class="hint">No assessed observations for this range. Missing evidence is unknown, not zero.</p>${expanded ? dailyTable(title, timeline, series, timeZone, true) : ""}</section>`;
    const max = Math.max(1, ...values);
    const firstDate = Date.parse(timeline[0].date);
    const lastDate = Date.parse(timeline.at(-1).date);
    const x = (i) => firstDate === lastDate ? width / 2 : pad + (Date.parse(timeline[i].date) - firstDate) * (width - pad * 2) / (lastDate - firstDate);
    const y = (v) => height - pad - Math.max(0, v) / max * (height - pad * 2);
    const paths = series.map((s, index) => {
        if (style === "bars") {
            const barWidth = Math.min(12, (width - pad * 2) / Math.max(1, timeline.length) / (series.length + 1));
            return `<g class="chart-series series-${index}">${timeline.map((d, i) => {
                const v = s.value(d);
                if (!knownNumber(v)) return "";
                return `<rect x="${x(i) + (index - series.length / 2) * barWidth}" y="${y(v)}" width="${barWidth}" height="${height - pad - y(v)}"><title>${esc(chartDate(d.date, timeZone))}: ${esc(s.label)} ${metric(v)}</title></rect>`;
            }).join("")}</g>`;
        }
        let started = false;
        const path = timeline.map((d, i) => {
            const v = s.value(d);
            if (!knownNumber(v)) { started = false; return ""; }
            const point = `${started ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
            started = true;
            return point;
        }).join(" ");
        const points = timeline.map((d, i) => knownNumber(s.value(d)) ? `<circle cx="${x(i)}" cy="${y(s.value(d))}" r="2.2"/>` : "").join("");
        return `<g class="chart-series series-${index}"><path d="${path}" fill="none" stroke-width="2" ${index === 1 ? 'stroke-dasharray="5 3"' : ""}/>${points}</g>`;
    }).join("");
    return `${card}<div class="chart-scale hint">Recorded days (${esc(timeZone)}) · scale 0–${metric(max, 1)}<br>${style === "bars" ? "Separate bars show daily observations, not stacked totals." : "Lines connect observations, not continuous activity."}</div>
        ${expanded ? '<div class="chart-plot" id="chartPlot">' : ""}<svg viewBox="0 0 ${width} ${height}"${expanded ? ` preserveAspectRatio="none" id="chartInspector" tabindex="0" role="slider" aria-orientation="horizontal" aria-valuemin="0" aria-valuemax="${timeline.length - 1}" aria-valuenow="0" aria-describedby="chartModalNote"` : ' role="img"'} aria-label="${esc(`${title}. ${timeline.length} recorded days; exact values in the table below.`)}"><path d="M${pad},${pad}V${height - pad}H${width - pad}" class="chart-axis"/>${paths}${expanded ? `<line id="chartCursor" class="chart-cursor" x1="${pad}" x2="${pad}" y1="${pad}" y2="${height - pad}"/>` : ""}</svg>${expanded ? '<output id="chartReadout" class="chart-tooltip" aria-live="polite" aria-atomic="true"></output></div>' : ""}
        <div class="chart-dates hint"><span>${esc(chartDate(timeline[0].date, timeZone))}</span><span>${esc(chartDate(timeline.at(-1).date, timeZone))}</span></div>
        <div class="chart-legend">${series.map((s, i) => `<span class="legend-${i}">${esc(s.label)}</span>`).join("")}</div>
        ${dailyTable(title, timeline, series, timeZone, expanded)}</section>`;
}

const TABLE_PAGE_SIZE = 50;
const dailyTables = new Map();
function dailyTable(title, timeline, series, timeZone, expanded = false) {
    const key = `${expanded ? "modal" : "inline"}:${timeZone}:${title}`;
    const previous = dailyTables.get(key);
    const model = { title, timeline, series, timeZone, open: previous?.open ?? expanded, page: previous?.page || 0 };
    dailyTables.set(key, model);
    return `<details class="chart-data" data-detail-key="${esc(title)}" data-table-key="${esc(key)}"${model.open ? " open" : ""}><summary>Daily data · ${timeline.length} recorded days (${esc(timeZone)})</summary><div class="daily-table-body">${expanded && model.open ? dailyTablePage(model) : ""}</div></details>`;
}

function dailyTablePage(model) {
    const { title, timeline, series, timeZone } = model;
    const pages = Math.max(1, Math.ceil(timeline.length / TABLE_PAGE_SIZE));
    model.page = Math.max(0, Math.min(model.page, pages - 1));
    const start = model.page * TABLE_PAGE_SIZE;
    const rows = timeline.slice(start, start + TABLE_PAGE_SIZE);
    return `<div class="table-scroll" tabindex="0" role="region" aria-label="${esc(title)} data"><table><caption>${esc(title)} · daily data (${esc(timeZone)}). Only recorded days are shown.</caption><thead><tr><th scope="col">Date</th>${series.map((s) => `<th scope="col">${esc(s.label)}</th>`).join("")}</tr></thead><tbody>${rows.map((d) => `<tr><th scope="row">${esc(chartDate(d.date, timeZone))}</th>${series.map((s) => `<td>${metric(s.value(d), 2)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
        <nav class="table-pages" aria-label="${esc(title)} daily data pages"><button type="button" class="btn" data-table-page="-1" aria-label="Previous daily data page"${model.page === 0 ? " disabled" : ""}>Previous</button><span role="status" aria-live="polite">Page ${model.page + 1} of ${pages} · ${timeline.length ? start + 1 : 0}–${start + rows.length} of ${timeline.length}</span><button type="button" class="btn" data-table-page="1" aria-label="Next daily data page"${model.page === pages - 1 ? " disabled" : ""}>Next</button></nav>`;
}

function hydrateDailyTable(detail) {
    const model = dailyTables.get(detail.dataset.tableKey);
    if (!model) return;
    model.open = detail.open;
    const body = detail.querySelector(".daily-table-body");
    if (body) setHtml(body, detail.open ? dailyTablePage(model) : "");
}

function wireDailyTables(host) {
    host.addEventListener("toggle", (event) => {
        if (event.target.matches("details[data-table-key]")) hydrateDailyTable(event.target);
    }, true);
    host.addEventListener("click", (event) => {
        const button = event.target.closest("[data-table-page]");
        if (!button || button.disabled) return;
        const detail = button.closest("details[data-table-key]");
        const model = dailyTables.get(detail.dataset.tableKey);
        if (!model) return;
        model.page += Number(button.dataset.tablePage);
        hydrateDailyTable(detail);
        const next = detail.querySelector(`[data-table-page="${button.dataset.tablePage}"]`);
        (next?.disabled ? detail.querySelector(`[data-table-page="${-Number(button.dataset.tablePage)}"]`) : next)?.focus();
    });
}

let activeChart = null;
function openChart(key) {
    const model = chartModels.get(key);
    if (!model) return;
    activeChart = { ...model, timeline: [...model.timeline] };
    for (const tableKey of dailyTables.keys()) if (tableKey.startsWith("modal:")) dailyTables.delete(tableKey);
    $("chartModalTitle").textContent = model.title;
    $("chartModalNote").textContent = `${model.note ? `${model.note} ` : ""}Hover or touch the chart to inspect the nearest recorded date. Focus the chart and use arrow keys, Home or End to select a day. Missing evidence is shown as —, not zero.`;
    $("chartStyle").value = model.style;
    drawExpandedChart();
    if (!$("chartModal").open) $("chartModal").showModal();
}

function drawExpandedChart() {
    const model = activeChart;
    if (!model) return;
    $("chartModalBody").innerHTML = (model.summaryHtml ? `<section class="card">${model.summaryHtml}</section>` : "") + timelineChart(model.title, model.timeline, model.series, $("chartStyle").value, model.timeZone, true);
    inspectChartDay(model.selectedDay ?? model.timeline.length - 1);
}

function chartDayText(model, index) {
    const day = model.timeline[index];
    return day ? `${chartDate(day.date, model.timeZone)} · ${model.series.map((series) => `${series.label}: ${metric(series.value(day), 2)}`).join(" · ")}` : "No recorded daily observations in this range.";
}

function inspectChartDay(index) {
    if (!activeChart?.timeline.length) return;
    const timeline = activeChart.timeline;
    index = Math.max(0, Math.min(timeline.length - 1, index));
    activeChart.selectedDay = index;
    const inspector = $("chartInspector");
    if (!inspector) return;
    const text = chartDayText(activeChart, index);
    const readout = $("chartReadout");
    if (readout.textContent !== text) readout.textContent = text;
    inspector.setAttribute("aria-valuenow", String(index));
    inspector.setAttribute("aria-valuetext", text);
    const cursor = $("chartCursor");
    if (cursor) {
        const first = Date.parse(timeline[0].date), last = Date.parse(timeline.at(-1).date);
        const x = first === last ? 450 : 12 + (Date.parse(timeline[index].date) - first) / (last - first) * 876;
        cursor.setAttribute("x1", x);
        cursor.setAttribute("x2", x);
        $("chartPlot").style.setProperty("--chart-x", `${x / 900 * 100}%`);
    }
}

function inspectChartKey(event) {
    if (!event.target.closest("#chartInspector") || !activeChart?.timeline.length) return;
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = activeChart.selectedDay ?? activeChart.timeline.length - 1;
    inspectChartDay(event.key === "Home" ? 0 : event.key === "End" ? activeChart.timeline.length - 1
        : index + (["ArrowRight", "ArrowUp"].includes(event.key) ? 1 : -1));
}

function inspectChartPointer(event) {
    const svg = event.target.closest("svg");
    if (!activeChart?.timeline.length || !svg) return;
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    if (event.type === "pointerdown") {
        svg.focus();
        svg.setPointerCapture?.(event.pointerId);
    }
    const timeline = activeChart.timeline;
    const first = Date.parse(timeline[0].date), last = Date.parse(timeline.at(-1).date);
    const target = first + Math.max(0, Math.min(1, ((event.clientX - rect.left) / rect.width * 900 - 12) / 876)) * (last - first);
    let low = 0, high = timeline.length - 1;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (Date.parse(timeline[middle].date) < target) low = middle + 1;
        else high = middle;
    }
    inspectChartDay(low > 0 && target - Date.parse(timeline[low - 1].date) < Date.parse(timeline[low].date) - target ? low - 1 : low);
}

function summaryChart(key, title, summaryHtml, timeline, note) {
    chartModels.set(key, { title, summaryHtml, timeline, series: [{ label: "Daily GitHub XP", value: (day) => day.xp }], style: "lines", timeZone: "UTC", note });
    return `<h3 class="card-title"><button type="button" class="chart-open" data-chart-key="${esc(key)}">${esc(title)} <span aria-hidden="true">↗</span></button></h3>${summaryHtml}`;
}

function comparison(label, data) {
    const current = data?.current?.xp ?? data?.current;
    const previous = data?.previous?.xp ?? data?.previous;
    if (!knownNumber(current) || !knownNumber(previous)) return `<li><strong>${label}</strong><span class="hint">Comparison unavailable</span></li>`;
    const delta = current - previous;
    const relative = previous > 0 ? `${metric(Math.abs(delta) / previous * 100, 1)}% ${delta < 0 ? "lower" : "higher"}` : "no percentage baseline";
    return `<li><strong>${label}</strong><span>${fmt(current)} vs ${fmt(previous)} XP</span><span class="hint">${delta > 0 ? "+" : ""}${fmt(delta)} XP · ${delta === 0 ? "unchanged" : relative}</span></li>`;
}

function githubItems(items) {
    if (!items?.length) return `<li class="empty">No rewarded GitHub activity yet.</li>`;
    return items.map((item) => {
        let url = "";
        try { const parsed = new URL(item.url); if (parsed.protocol === "https:") url = parsed.href; } catch { /* invalid source link */ }
        return `<li><span class="tid">#${esc(item.number)}</span><span class="ttitle">${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(item.title)}</a>` : esc(item.title)}</span><span class="txp">+${fmt(item.xp)} XP</span><span class="tmeta">${esc(item.repo)} · ${esc(activityLabel(item.kind))} · ${esc(shortDate(item.at))}</span></li>`;
    }).join("");
}

function renderGitHubProgress() {
    updateRangeButtons("github");
    const entry = ensureAnalytics("github");
    if (entry.status !== "ready") {
        clearSourceCharts("github");
        $("githubRangeNote").textContent = "Choose a range to load daily GitHub analytics. Viewing analytics never syncs GitHub.";
        for (const id of ["githubStats", "githubBreakdown", "githubComparisons"]) setHtml($(id), "");
        replaceDetails($("githubEvidence"), "");
        replaceDetails($("githubCharts"), analyticsStatus(entry, "github"));
        setHtml($("githubRecent"), githubItems(state.github?.recent));
        sectionKeys.delete("githubProgress");
        return;
    }
    cachedSection("githubProgress", [analyticsKey("github", ui.range), state.github?.lastSync, state.github?.limitations, state.github?.recent, Math.floor(Date.now() / 60000)], drawGitHubProgress);
}

function drawGitHubProgress() {
    const g = state.github;
    const { metrics: a, timeline } = selectedAnalytics("github");
    $("githubRangeNote").textContent = `${githubScopeNote()} · ${ui.range === "all" ? "All recorded history" : `Last ${ui.range} days`} · ${g?.lastSync ? `data synced ${relTime(g.lastSync.fetchedAt || g.lastSync.at)}` : "awaiting first sync"}. XP is lifetime cumulative, including history before this range. Own PRs merged includes merges by anyone; merged by you requires verified merger identity and can overlap without duplicate XP. PR charts count daily events, not necessarily the same PRs. ${mergerNote(a)} Overall XP and shared unlocks are never filtered.`;
    setHtml($("githubStats"), statCards([
        ["GitHub XP", metric(a?.xp), "xp"], ["Base XP", metric(a?.baseXp), "baseXp"], ["Bonus XP", metric(a?.bonusXp), "bonusXp"],
        ["PRs opened", metric(a?.opened), "opened"], ["Own PRs merged", metric(a?.authoredMerged ?? a?.merged), (d) => d.authoredMerged ?? d.merged],
        ["PRs merged by you", metric(a?.mergedBy), "mergedBy"], ["PRs reviewed", metric(a?.reviewed), "reviewed"],
        ["Helpful feedback", metric(a?.helpful), "helpful"], ["Merge success rate", rate(a?.mergeRate)],
        ["Average PR lines", metric(a?.averageSize, 1)], ["Repositories", metric(a?.repositories)],
        ["Merge streak (weeks)", metric(a?.streakWeeks)], ["Best merge streak (weeks)", metric(a?.bestStreakWeeks)],
        ["Clean merge rate", a?.qualitySample > 0 ? rate(a.cleanRate) : "—", (d) => d.qualitySample > 0 ? d.clean / d.qualitySample * 100 : null, "Clean merge rate (%)"],
        ["Findings / PR", metric(a?.findingsPerPr, 2), (d) => d.qualitySample > 0 ? d.findings / d.qualitySample : null],
        ["Auto findings / 100 lines", metric(a?.automatedFindingsPer100Lines, 2)],
        ["Review iterations", metric(a?.reviewIterations, 1)], ["Changes requested", rate(a?.changesRequestedRate)],
        ["Focused PRs", metric(a?.focused), "focused"], ["Improvements", metric(a?.improvements), "improvements"],
    ], "github", timeline));
    const warnings = [...new Set([...(g?.limitations || []), ...(g?.lastSync?.warnings || [])])];
    replaceDetails($("githubEvidence"), `<div class="card-title">Review evidence & coverage</div><p class="hint">${esc(qualityNote(a))}</p><p class="hint">— means unavailable, not zero. Rates reflect recorded activity and assessed samples, not a guarantee of defect-free code. Merge success rate uses closed PRs, excluding those still open. Helpful feedback is only counted when supported by source evidence.</p>${g?.lastSync && !g.lastSync.complete ? '<p class="sync-error">Partial sync: counts and comparisons may understate activity.</p>' : ""}${warnings.length ? `<details data-detail-key="github-limitations"><summary>Data limitations (${warnings.length})</summary><ul class="evidence-list">${warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></details>` : ""}`);
    replaceDetails($("githubCharts"), timelineChart("GitHub XP over time (cumulative)", timeline, [{ label: "Lifetime GitHub XP", value: (d) => d.cumulativeXp }])
        + timelineChart("PR activity per day", timeline, [{ label: "PRs opened that day", value: (d) => d.opened }, { label: "Own PRs merged that day", value: (d) => d.authoredMerged ?? d.merged }, { label: "PRs merged by you that day", value: (d) => d.mergedBy }], "bars")
        + timelineChart("Review participation per day", timeline, [{ label: "PRs reviewed that day", value: (d) => d.reviewed }], "bars")
        + timelineChart("Observed findings / 100 changed lines", timeline, [{ label: "Findings / 100 changed lines", value: (d) => d.qualitySample > 0 && d.lines > 0 && knownNumber(d.findings) ? d.findings / d.lines * 100 : null }]));
    const breakdown = Object.entries(a?.breakdown || {}).filter(([, xp]) => knownNumber(xp));
    const max = Math.max(1, ...breakdown.map(([, xp]) => xp));
    $("githubBreakdown").innerHTML = summaryChart("github:breakdown", "XP by activity type", breakdown.length ? `<ul class="breakdown">${breakdown.map(([key, xp]) => `<li><span>${esc(activityLabel(key))}</span><span class="breakdown-track" aria-hidden="true"><span style="width:${Math.max(0, xp) / max * 100}%"></span></span><strong>${fmt(xp)} XP</strong></li>`).join("")}</ul>` : '<p class="hint">No activity breakdown available for this range.</p>', timeline, "Category totals apply to the selected range. Daily per-category XP is not retained in the view; the interactive chart and daily table show combined daily GitHub XP, not an invented category history.");
    const trend = a?.qualityTrend;
    const trendText = knownNumber(trend?.current) && knownNumber(trend?.previous)
        ? `${metric(trend.current, 2)} now vs ${metric(trend.previous, 2)} previously, observed findings per 100 changed lines in successive five-merge groups · ${metric(trend.sample)} assessed PRs in this range. These are review observations, not actual bug counts. Lower observed findings rates can indicate improvement; coverage and PR scope also affect this comparison.`
        : "Not enough comparable review evidence to establish a quality trend.";
    $("githubComparisons").innerHTML = summaryChart("github:comparisons", "Comparisons & personal records", `<ul class="comparison-list">${comparison("Week vs previous week", a?.comparisons?.week)}${comparison("Month vs previous month", a?.comparisons?.month)}</ul><p class="hint">UTC calendar-period XP comparisons use all recorded history, independent of the chart range. Current periods may still be in progress. Records below apply to the selected range.</p><div class="record-row"><span>Best day: <strong>${metric(a?.records?.bestDayXp)} XP</strong></span><span>Best week: <strong>${metric(a?.records?.bestWeekMerges)} authored merges</strong></span></div><div class="mini-title">Quality trend</div><p class="hint">${esc(trendText)}</p>`, timeline, "The summary retains its UTC calendar-period comparisons. The interactive chart and daily table show daily GitHub XP for the selected range as comparison context, not daily records or quality estimates.");
    $("githubRecent").innerHTML = githubItems(g?.recent);
}

function medal(on, tier = "Gold") {
    const { fill, shade, shine } = TIER_COLORS[tierName(tier)];
    return rect(2, 0, 3, 3, on ? "#e63946" : "#6b7585") + rect(7, 0, 3, 3, on ? "#457b9d" : "#6b7585") + rect(3, 3, 6, 1, shade) + rect(2, 4, 8, 7, shade) + rect(3, 4, 6, 7, fill) + rect(2, 5, 8, 5, fill)
        + rect(5, 5, 2, 5, shine) + rect(4, 6, 4, 2, shine) + rect(3, 11, 6, 1, shade);
}

let roomSignature = "";
function renderRoom() {
    const a = state.appearance;
    const night = isNight();
    const signature = JSON.stringify([a.room, a.wall, a.furniture, night]);
    if (signature !== roomSignature) {
        roomSignature = signature;
        const ctx = { night };
        const wall = colorOf(a.wall, "#f3e9d2");
        $("roomLayer").innerHTML = room({ room: a.room, wall, night }) + furnitureLayer(a.furniture, "wall", ctx) + furnitureLayer(a.furniture, "back", ctx) + furnitureLayer(a.furniture, "floor", ctx);
    }
    const lamp = a.furniture.includes("furn-lamp");
    $("nightShade").setAttribute("opacity", night ? (lamp ? "0.14" : "0.26") : "0");
    $("sleepShade").setAttribute("opacity", state.care.sleeping ? "0.38" : "0");
}

// ---------- Animation ----------
const actor = { x: 80, target: 80, blinkAt: 30, blink: 0, look: 0, lookAt: 20, wanderAt: 90, idlePose: null, idlePoseUntil: 0 };
let frame = 0;
let action = null;
let particles = [];
let evolution = null;
// Each stage gets a longer, bigger sequence: flicker, charge, flash, then shockwaves.
const EVO_FX = {
    2: { dur: 44, flashAt: 30, flash: 0.85, burst: 14, rise: 0, color: "#ffd23f", rings: [0] },
    3: { dur: 62, flashAt: 44, flash: 0.9, burst: 20, rise: 0, color: "#7dd3fc", rings: [0, 5] },
    4: { dur: 78, flashAt: 56, flash: 0.95, burst: 28, rise: 10, color: "#c4a1ff", rings: [0, 5, 10] },
    5: { dur: 100, flashAt: 72, flash: 1, burst: 40, rise: 16, color: "#ff9ff3", rings: [0, 4, 8, 12] },
};
const petMotion = createPetMotion({
    reduced: reducedMotion,
    onPet: () => post("/api/interact", { action: state?.care.sleeping ? "wake" : "pet" }),
    onAbuse: () => post("/api/interact", { action: "fling" }),
});
let petPointerId = null;
let petAnimation = null;

function petTransform() {
    const b = petMotion.body;
    const squash = b.splat > 0 ? " scale(0.65 1.12)" : "";
    const scale = b.phase === "held" ? " scale(1.03 1.03)" : "";
    const sway = !b.splat && (b.angle || scale)
        ? ` translate(${b.gripX} ${b.gripY}) rotate(${b.angle})${scale} translate(${-b.gripX} ${-b.gripY})` : "";
    return `translate(${b.x} ${b.y})${sway}${squash}`;
}

function animatePet(at) {
    petAnimation = null;
    const wasMoving = petMotion.body.phase !== "idle";
    petMotion.step(animatePet.lastAt ? (at - animatePet.lastAt) / 1000 : 0);
    animatePet.lastAt = at;
    const b = petMotion.body;
    if (wasMoving) actor.x = b.x;
    const pose = $("buddyPose");
    if (pose && b.phase !== "idle") pose.setAttribute("transform", petTransform());
    $("scene").dataset.petPhase = b.phase;
    if (b.phase !== "idle") petAnimation = requestAnimationFrame(animatePet);
    else { actor.target = 80; actor.wanderAt = frame + 90; animatePet.lastAt = 0; }
}

function wirePet(scene) {
    const point = (event) => {
        const matrix = scene.getScreenCTM();
        if (!matrix) return null;
        const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
        return { id: event.pointerId, x: p.x, y: p.y };
    };
    const finish = (event, cancelled = false) => {
        if (event.pointerId !== petPointerId) return;
        petMotion.up({ id: event.pointerId }, cancelled);
        petPointerId = null;
        if (scene.hasPointerCapture(event.pointerId)) scene.releasePointerCapture(event.pointerId);
        scene.classList.remove("pet-grabbed");
    };
    scene.tabIndex = 0;
    scene.setAttribute("role", "button");
    scene.addEventListener("pointerdown", (event) => {
        if (!state || !event.isPrimary || event.button !== 0 || petPointerId !== null || evolution || !event.target.closest("#buddySprite")) return;
        const p = point(event);
        if (!p) return;
        const sprite = $("buddySprite");
        const spriteMatrix = sprite.getScreenCTM();
        if (!spriteMatrix) return;
        const grip = new DOMPoint(event.clientX, event.clientY).matrixTransform(spriteMatrix.inverse());
        const box = sprite.getBBox();
        const limits = { left: -box.x * 1.03 + 1, right: W - (box.x + box.width) * 1.03 - 1,
            top: -box.y * 1.12 + 1, bottom: FLOOR_Y - Math.max(0, box.y + box.height) * 1.12,
            shape: { x: box.x, y: box.y, width: box.width, height: box.height }, width: W, floor: FLOOR_Y };
        if (!petMotion.down(p, { x: p.x - grip.x, y: p.y - grip.y }, limits)) return;
        event.preventDefault();
        action = null;
        petPointerId = event.pointerId;
        scene.setPointerCapture(event.pointerId);
        scene.focus({ preventScroll: true });
        scene.classList.add("pet-grabbed");
        if (petAnimation === null) { animatePet.lastAt = 0; petAnimation = requestAnimationFrame(animatePet); }
    });
    scene.addEventListener("pointermove", (event) => {
        if (event.pointerId !== petPointerId) return;
        event.preventDefault();
        const p = point(event);
        if (p) petMotion.move(p);
    });
    scene.addEventListener("pointerup", (event) => finish(event));
    scene.addEventListener("pointercancel", (event) => finish(event, true));
    scene.addEventListener("lostpointercapture", (event) => finish(event, true));
    const cancel = () => {
        if (petPointerId !== null) finish({ pointerId: petPointerId }, true);
        petMotion.reset();
    };
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", () => { if (document.hidden) cancel(); });
    scene.addEventListener("keydown", (event) => {
        if (event.key === "Escape") cancel();
        if (!event.repeat && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            if (state && petMotion.body.phase === "idle") post("/api/interact", { action: state.care.sleeping ? "wake" : "pet" });
        }
    });
}

function startAction(type, data = {}) {
    const durations = { pet: 30, feed: 42, play: 76, wake: 24, yawn: 14, reward: 30, equip: 16, wave: 24 };
    action = { type, t: 0, dur: durations[type] || 20, data };
    if (type === "play") action.ball = { x: actor.x < 80 ? 150 : 8, y: FLOOR_Y - 20, vx: actor.x < 80 ? -1.6 : 1.6, vy: 0 };
    if (type === "reward") burst(actor.x, FLOOR_Y + metrics(stageNow()).headTop / 2, 10, data.xp ? `+${fmt(data.xp)} XP` : null);
    if (type === "wake") particles.push({ kind: "bang", x: actor.x + 10, y: FLOOR_Y + metrics(stageNow()).headTop - 10, life: 14, max: 14, vx: 0, vy: 0 });
    if (type === "equip") burst(actor.x, FLOOR_Y + metrics(stageNow()).headTop, 6);
}

function burst(x, y, n, label) {
    const reduced = reducedMotion();
    for (let i = 0; i < n; i++) {
        const angle = (i / n) * Math.PI * 2;
        const speed = reduced ? 0 : 1.4;
        particles.push({ kind: "spark", x: x + (reduced ? Math.cos(angle) * 14 : 0), y: y + (reduced ? Math.sin(angle) * 10 : 0), vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, life: 18, max: 18, color: i % 2 ? "#ffd23f" : "#ffffff" });
    }
    if (label) particles.push({ kind: "text", label, x, y: y - 6, vx: 0, vy: reduced ? 0 : -0.5, life: 30, max: 30 });
}

function stageNow() {
    if (evolution) return evolution.stage;
    return state?.progress.stage || 1;
}

function handleFx(fx) {
    if (!state || !fx) return;
    switch (fx.fx) {
        case "pet": case "feed": case "play": case "wake":
            startAction(fx.fx);
            break;
        case "rest":
            startAction("yawn");
            break;
        case "reward":
            startAction("reward", { xp: fx.xp });
            break;
        case "equip":
            startAction("equip");
            break;
        case "rename":
            startAction("wave");
            break;
        default:
            break;
    }
}

function tick() {
    if (!state || document.hidden) return;
    frame++;
    const reduced = reducedMotion();
    const stage = stageNow();
    const m = metrics(stage, state.appearance.variant);
    const headY = FLOOR_Y + m.headTop;
    const sleeping = state.care.sleeping;
    let expr = MOOD_EXPR[state.mood] || "normal";
    let pose = "stand";
    let jump = 0;
    let wiggle = 0;
    let walking = false;
    const fxSvg = [];
    const motion = petMotion.body;
    const physical = motion.phase !== "idle";
    if (physical) actor.x = motion.x;

    const moveToward = (target, speed = 1) => {
        if (reduced) return;
        const dx = target - actor.x;
        if (Math.abs(dx) >= 1) {
            actor.x += Math.sign(dx) * Math.min(speed, Math.abs(dx));
            walking = true;
            actor.look = Math.sign(dx);
        }
    };

    if (physical) {
        expr = motion.phase === "flying" ? "excited" : "curious";
        actor.look = 0;
    } else if (evolution) {
        const fx = EVO_FX[evolution.to] || EVO_FX[2];
        const t = ++evolution.t;
        const cx = Math.round(actor.x), cy = FLOOR_Y + Math.round(m.headTop / 2);
        const period = t < fx.flashAt / 2 ? 6 : 4;
        evolution.stage = t < fx.flashAt && t % period < period / 2 ? evolution.from : evolution.to;
        expr = "excited";
        if (evolution.to >= 4) jump = -Math.round(fx.rise * (t < fx.flashAt ? Math.min(1, t / fx.flashAt) : Math.max(0, 1 - (t - fx.flashAt) / 12)));
        if (t < fx.flashAt) {
            if (t % 5 === 0) burst(actor.x, headY + 10, 4);
            if (evolution.to >= 3 && t % 2 === 0) {
                for (let i = 0; i < evolution.to - 1; i++) {
                    const angle = Math.random() * Math.PI * 2;
                    particles.push({ kind: "spark", x: actor.x + Math.cos(angle) * 44, y: cy + Math.sin(angle) * 30, vx: -Math.cos(angle) * 3.1, vy: -Math.sin(angle) * 2.1, life: 14, max: 14, color: i % 2 ? fx.color : "#ffffff" });
                }
                const r = 34 * (1 - (t % 18) / 18);
                fxSvg.push(`<circle cx="${cx}" cy="${cy}" r="${r.toFixed(1)}" fill="none" stroke="${fx.color}" stroke-width="2" opacity="${(0.9 - r / 50).toFixed(2)}"/>`);
            }
            if (evolution.to >= 4) {
                const w = 4 + 12 * Math.min(1, t / fx.flashAt);
                fxSvg.push(`<rect x="${cx - w / 2}" y="0" width="${w}" height="${FLOOR_Y}" fill="${fx.color}" opacity="0.28"/><rect x="${cx - w / 4}" y="0" width="${w / 2}" height="${FLOOR_Y}" fill="#ffffff" opacity="0.5"/>`);
            }
        }
        if (t === fx.flashAt) { $("flash").setAttribute("opacity", String(fx.flash)); burst(actor.x, headY + 8, fx.burst); }
        if (t > fx.flashAt) {
            const since = t - fx.flashAt;
            $("flash").setAttribute("opacity", String(Math.max(0, fx.flash - since * 0.1).toFixed(2)));
            for (const delay of fx.rings) {
                const r = (since - delay) * 4;
                if (r > 0 && r < 56) fxSvg.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${fx.color}" stroke-width="3" opacity="${(1 - r / 56).toFixed(2)}"/>`);
            }
            if (evolution.to === 5 && since < 14 && since % 3 === 0) burst(actor.x, headY + 8, 12);
            if (evolution.to >= 4 && since < 10) fxSvg.push(`<rect x="${cx - 8 + since}" y="0" width="${16 - since * 2}" height="${FLOOR_Y}" fill="#ffffff" opacity="${(0.5 - since * 0.05).toFixed(2)}"/>`);
        }
        if (t >= fx.dur) { $("flash").setAttribute("opacity", "0"); const done = evolution.done; evolution = null; done(); }
    } else if (action) {
        const t = action.t++;
        switch (action.type) {
            case "pet":
                expr = "happy";
                if (!reduced && t < 14) wiggle = Math.floor(t / 3) % 2 ? 1 : -1;
                if (t % 6 === 0) particles.push({ kind: "heart", x: actor.x - 3 + Math.round((Math.random() - 0.5) * 12), y: headY - 4, vx: 0, vy: reduced ? 0 : -0.6, life: 20, max: 20 });
                break;
            case "feed": {
                const mouthY = FLOOR_Y + m.mouthY;
                if (t < 14) {
                    expr = "curious";
                    actor.look = 0;
                    const y = reduced ? mouthY - 8 : 6 + ((mouthY - 9) * t) / 14;
                    fxSvg.push(sprites.treat(Math.round(actor.x) - 3, Math.round(y)));
                } else if (t < 32) {
                    expr = "chomp";
                    if (t % 3 === 0) particles.push({ kind: "crumb", x: actor.x + Math.round((Math.random() - 0.5) * 8), y: mouthY, vx: reduced ? 0 : (Math.random() - 0.5) * 1.2, vy: reduced ? 0 : -0.6, g: 0.12, life: 16, max: 16 });
                } else {
                    expr = "happy";
                    if (t === 33) particles.push({ kind: "heart", x: actor.x - 2, y: headY - 6, vx: 0, vy: reduced ? 0 : -0.5, life: 20, max: 20 });
                }
                break;
            }
            case "play": {
                expr = "excited";
                const ball = action.ball;
                if (reduced) {
                    pose = t > 50 ? "cheer" : "stand";
                    fxSvg.push(sprites.ball(Math.round(actor.x + 16), FLOOR_Y - 6));
                } else {
                    ball.vy += 0.35;
                    ball.x += ball.vx;
                    ball.y += ball.vy;
                    if (ball.y > FLOOR_Y - 6) { ball.y = FLOOR_Y - 6; ball.vy = -Math.max(1.2, Math.abs(ball.vy) * 0.72); }
                    if (ball.x < 10 || ball.x > W - 16) ball.vx *= -1;
                    if (t < 60) moveToward(Math.max(36, Math.min(124, ball.x)), 1.2);
                    else pose = "cheer";
                    if (t > 58) ball.vx *= 0.9;
                    if (t > 60 && t < 70) jump = -[0, 2, 4, 5, 5, 4, 2, 1, 0, 0][t - 60];
                    fxSvg.push(sprites.ball(Math.round(ball.x), Math.round(ball.y)));
                }
                break;
            }
            case "wake":
                expr = "curious";
                actor.look = Math.floor(t / 6) % 2 ? 1 : -1;
                break;
            case "yawn":
                expr = t % 8 < 5 ? "excited" : "sleepy";
                break;
            case "reward":
                expr = "excited";
                pose = "cheer";
                if (!reduced && t < 10) jump = -[0, 2, 4, 5, 6, 6, 5, 4, 2, 0][t];
                break;
            case "equip":
            case "wave":
                expr = "smile";
                pose = stage >= 2 ? "wave" : "stand";
                break;
            default:
                break;
        }
        if (action.t >= action.dur) action = null;
        if (!walking && pose === "stand" && !reduced && actor.idlePose === "walk") actor.idlePose = null;
    } else if (sleeping) {
        expr = "sleep";
        pose = stage >= 2 ? "sit" : "stand";
        const zEvery = reduced ? 40 : 16;
        if (frame % zEvery === 0) particles.push({ kind: "z", x: actor.x + 8, y: headY - 2, vx: reduced ? 0 : 0.25, vy: reduced ? 0 : -0.35, life: 34, max: 34, big: frame % (zEvery * 2) === 0 });
    } else {
        if (frame >= actor.blinkAt) { actor.blink = 2; actor.blinkAt = frame + 30 + Math.floor(Math.random() * 60); }
        if (frame >= actor.lookAt) { actor.look = [-1, 0, 0, 1][Math.floor(Math.random() * 4)]; actor.lookAt = frame + 24 + Math.floor(Math.random() * 48); }
        if (!reduced && frame >= actor.wanderAt) {
            const roll = Math.random();
            if (roll < 0.18 && stage >= 2) { actor.idlePose = "wave"; actor.idlePoseUntil = frame + 22; }
            else if (roll < 0.34 && stage >= 2 && state.mood === "Relaxed") { actor.idlePose = "sit"; actor.idlePoseUntil = frame + 60; }
            else actor.target = 50 + Math.floor(Math.random() * 60);
            actor.wanderAt = frame + 70 + Math.floor(Math.random() * 120);
        }
        if (actor.idlePose && frame < actor.idlePoseUntil) pose = actor.idlePose;
        else {
            actor.idlePose = null;
            if (frame % 2 === 0) moveToward(actor.target);
        }
        if (actor.blink > 0) { expr = "blink"; actor.blink--; }
    }
    if (walking) pose = pose === "stand" ? "walk" : pose;

    const bob = reduced || walking || jump ? 0 : Math.floor(frame / (sleeping ? 14 : 8)) % 2;
    const x = Math.round(actor.x) + wiggle;
    const opts = robotOpts({ stage, expr, look: actor.look, bob, pose, frame, still: reduced });
    const shadowW = 10 + stage * 2;
    const holdCue = motion.phase === "press" ? `<circle cx="0" cy="${m.headTop / 2}" r="${m.headW / 2 + 8}" fill="none" stroke="#ffd23f" stroke-width="1.5" stroke-dasharray="${Math.round(motion.hold * 100)} 100" pathLength="100" pointer-events="none"/>` : "";
    $("actorLayer").innerHTML = rect(x - shadowW / 2, FLOOR_Y - 1, shadowW, 2, "#000000", ' opacity="0.18" pointer-events="none"')
        + `<g id="buddyPose" transform="${physical ? petTransform() : `translate(${x} ${FLOOR_Y + jump})`}"><g id="buddySprite">${robot(opts)}</g>${holdCue}</g>`;

    particles = particles.filter((pt) => --pt.life > 0);
    for (const pt of particles) {
        pt.x += pt.vx; pt.y += pt.vy;
        if (pt.g) pt.vy += pt.g;
        const o = Math.min(1, (pt.life / pt.max) * 1.6);
        const px = Math.round(pt.x), py = Math.round(pt.y);
        if (pt.kind === "heart") fxSvg.push(sprites.heart(px, py, o));
        else if (pt.kind === "crumb") fxSvg.push(sprites.crumb(px, py, o));
        else if (pt.kind === "z") fxSvg.push(sprites.z(px, py, o, pt.big));
        else if (pt.kind === "spark") fxSvg.push(sprites.spark(px, py, pt.color, o));
        else if (pt.kind === "bang") fxSvg.push(sprites.bang(px, py));
        else if (pt.kind === "text") fxSvg.push(sprites.text(px, py, esc(pt.label), "#ffd23f", o));
    }
    $("fxLayer").innerHTML = fxSvg.join("");
}

// ---------- Celebrations ----------
const handled = new Set();
const modalQueue = [];
let modalOpen = false;

function processCelebrations() {
    const quickAck = [];
    for (const c of state.celebrations) {
        if (handled.has(c.id)) continue;
        handled.add(c.id);
        if (c.type === "tickets") {
            const n = c.count;
            toast(`${c.demo ? "[DEMO] " : ""}${n} ticket${n === 1 ? "" : "s"} closed · +${fmt(c.xp)} XP`, "gold");
            quickAck.push(c.id);
        } else if (c.type === "github") {
            toast(`${fmt(c.count)} GitHub contribution${c.count === 1 ? "" : "s"} · +${fmt(c.xp)} XP`, "gold");
            startAction("reward", { xp: c.xp });
            quickAck.push(c.id);
        } else if (c.type === "challenges" && !c.items.some((i) => i.secret)) {
            const names = c.items.map((i) => (i.count > 1 ? `${i.name} ×${i.count}` : i.name)).join(", ");
            toast(`Challenge: ${names} · +${fmt(c.xp)} XP`, "gold");
            quickAck.push(c.id);
        } else if (c.type === "unlock") {
            toast(`Unlocked: ${c.items.map((i) => i.name).join(", ")}`, "gold");
            quickAck.push(c.id);
        } else {
            modalQueue.push(c);
        }
    }
    if (quickAck.length) api("/api/ack", { ids: quickAck }).catch(() => {});
    if (!modalOpen) showNextModal();
    if (state.evolution) renderEvolution();
}

function showNextModal() {
    if ($("chartModal").open) return;
    const c = modalQueue.shift();
    if (!c) return;
    modalOpen = true;
    const open = () => openModal(c);
    if (c.type === "evolution") evolutionModalOpen = true;
    if (c.type === "evolution" && c.buddyType === state.evolution?.active && c.stageTo === state.progress.stage && !reducedMotion()) {
        petMotion.reset();
        evolution = { event: c, from: c.stageFrom, to: c.stageTo, t: 0, stage: c.stageFrom, done: open };
    } else open();
}

function openModal(c) {
    const p = state.progress;
    const artStage = c.type === "evolution" ? c.stageTo : p.stage;
    const artType = c.type === "evolution" ? c.buddyType : state.evolution?.active || "robot";
    let title = "";
    let body = "";
    let art = robot(robotOpts({ type: artType, stage: artStage, expr: "excited", pose: artStage >= 2 ? "cheer" : "stand", still: true }));
    let viewBox = robotViewBox(artStage, state.appearance.variant, artType);
    if (c.type === "welcome") {
        title = `Hi, I'm ${state.name}!`;
        body = `I found ${fmt(c.tickets)} closed tickets worth ${fmt(c.xp)} XP. That makes me level ${c.level}! Close more tickets to help me grow.`;
    } else if (c.type === "levelup") {
        title = `Level ${c.to}!`;
        body = `${state.name} grew from level ${c.from} to level ${c.to}. Keep it up!`;
    } else if (c.type === "evolution") {
        const name = state.evolution.types.find((type) => type.id === artType)?.stages[artStage - 1]?.name;
        title = `Evolved into ${name}!`;
        body = `You purchased stage ${artStage}. Your other buddies share the remaining credits. Display any owned stage in Customize.`;
    } else if (c.type === "achievement") {
        const a = state.achievements.find((x) => x.id === c.achievementId);
        title = `Achievement: ${c.name}`;
        body = `${a?.description || ""} Unlocked: ${(a?.rewards || []).join(", ")}.`;
        art = medal(true, a?.tier);
        viewBox = "-1 -1 14 14";
    } else if (c.type === "challenges") {
        const secrets = c.items.filter((i) => i.secret);
        title = secrets.length === 1 ? `Secret found: ${secrets[0].name}!` : "Secret challenges found!";
        body = `${c.items.map((i) => `${i.name}${i.count > 1 ? ` ×${i.count}` : ""}`).join(", ")} · +${fmt(c.xp)} bonus XP.`;
        art = medal(true);
        viewBox = "-1 -1 14 14";
    } else if (c.type === "rebalance") {
        title = "Byte Buddy got an update!";
        body = `Levels are now a longer journey and challenges pay bonus XP. Your tickets were re-counted: ${state.name} is level ${c.level} with ${fmt(c.bonusXp)} bonus XP from ${c.challenges} challenges. ${c.unlocked}/${c.lockable} rewards are unlocked — the rarest now take around 1,000 tickets.`;
    } else if (c.type === "newcontent") {
        const lockable = state.catalog.filter((i) => i.requirement !== "Available from the start");
        title = "New rewards added!";
        body = `Byte Buddy now has ${state.achievements.length} achievements and ${lockable.length} unlockable items.`
            + (c.achievements.length ? ` You've already earned ${c.achievements.join(", ")}.` : "")
            + (c.items.length ? ` ${c.items.length} new items are ready in Customize: ${c.items.join(", ")}.` : "");
    }
    $("celArt").setAttribute("viewBox", viewBox);
    $("celArt").innerHTML = art;
    $("celTitle").textContent = title;
    $("celBody").textContent = body;
    $("celebration").hidden = false;
    $("celOk").focus();
    $("celOk").onclick = () => {
        $("celebration").hidden = true;
        modalOpen = false;
        if (c.type === "evolution") evolutionModalOpen = false;
        api("/api/ack", { ids: [c.id] }).catch(() => {});
        showNextModal();
        if (state?.evolution) renderEvolution();
    };
}

// ---------- Interactions ----------
async function post(path, body, { quiet = false } = {}) {
    try {
        return await api(path, body);
    } catch (error) {
        if (!quiet) toast(error.message, "err");
        return null;
    }
}

function selectTab(tab) {
    ui.tab = tab;
    for (const btn of document.querySelectorAll(".tabs button")) {
        const on = btn.dataset.tab === tab;
        btn.setAttribute("aria-selected", String(on));
        btn.tabIndex = on ? 0 : -1;
        $(`panel-${btn.dataset.tab}`).hidden = !on;
    }
    render();
}

async function exportCurrentSave() {
    const button = $("exportCurrentSave");
    if (button.disabled) return;
    button.disabled = true;
    $("exportStatus").textContent = "Preparing current save export…";
    let objectUrl;
    let link;
    try {
        const save = await api("/api/export");
        objectUrl = URL.createObjectURL(new Blob([JSON.stringify(save, null, 2)], { type: "application/json" }));
        link = document.createElement("a");
        link.href = objectUrl;
        link.download = "buddy.rollback.json";
        document.body.appendChild(link);
        link.click();
        $("exportStatus").textContent = "Current save download started.";
    } catch (error) {
        $("exportStatus").textContent = `Couldn't export current save: ${error.message}`;
    } finally {
        link?.remove();
        if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
        button.disabled = false;
    }
}

function wire() {
    mountConnectionEditor();
    $("reviewConnections").onclick = () => { selectTab("connections"); $("tab-connections").focus(); };
    $("buddyTypes").addEventListener("click", (event) => {
        const button = event.target.closest("[data-evo-action]");
        if (button && !button.disabled) changeEvolution(button.dataset.evoAction, button.dataset.buddy);
    });
    $("evoTrack").addEventListener("click", (event) => {
        const button = event.target.closest("[data-evo-action]");
        if (!button || button.disabled || button.getAttribute("aria-disabled") === "true") return;
        if (button.dataset.evoAction === "upgrade") changeEvolution("upgrade");
        else changeEvolution("select", state.evolution.active, Number(button.dataset.stage));
    });
    $("evoTrack").addEventListener("keydown", (event) => {
        const card = event.target.closest('[data-evo-action="upgrade"]');
        if (card && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); card.click(); }
    });
    $("evoReset").addEventListener("click", () => {
        evolutionReset = { revision: state.evolution.revision, mode: state.mode };
        $("evoConfirmText").textContent = `Return every buddy to stage 1 and refund ${fmt(state.evolution.spent)} credits to the shared wallet? Your level, XP, cosmetics and legacy credit are kept.`;
        $("evoConfirm").returnValue = "cancel";
        $("evoConfirm").showModal();
    });
    $("evoConfirm").addEventListener("close", () => {
        if ($("evoConfirm").returnValue === "reset" && evolutionReset) {
            if (evolutionReset.mode === state.mode && evolutionReset.revision === state.evolution.revision) changeEvolution("reset");
            else $("evoStatus").textContent = "Evolution changed; review the refund and try again.";
        }
        evolutionReset = null;
        $("evoReset").focus();
    });
    $("exportCurrentSave").addEventListener("click", exportCurrentSave);
    $("githubRefresh").addEventListener("click", async () => {
        githubRefreshing = true;
        renderGitHubHome();
        const result = await post("/api/github/sync", {});
        githubRefreshing = false;
        if (result) await loadState();
        renderGitHubHome();
    });
    $("githubExplore").addEventListener("click", () => {
        ui.progress = "github";
        selectTab("progress");
        $("progress-github-tab").focus();
    });
    $("ticketExplore").addEventListener("click", () => {
        ui.progress = "ticket";
        selectTab("progress");
        $("progress-ticket-tab").focus();
    });
    $("customizeNav").addEventListener("click", (event) => {
        const btn = event.target.closest("[data-customize]");
        if (!btn) return;
        ui.customize = btn.dataset.customize;
        renderCustomizePanel();
    });
    $("customizeNav").addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        ui.customize = event.key === "Home" ? "evolution" : event.key === "End" ? "accessories" : ui.customize === "evolution" ? "accessories" : "evolution";
        renderCustomizePanel();
        $(`customize-${ui.customize}-tab`).focus();
    });
    $("progressNav").addEventListener("click", (event) => {
        const btn = event.target.closest("[data-progress]");
        if (!btn) return;
        ui.progress = btn.dataset.progress;
        renderProgress();
    });
    $("progressNav").addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        ui.progress = event.key === "Home" ? "ticket" : event.key === "End" ? "github" : ui.progress === "ticket" ? "github" : "ticket";
        renderProgress();
        $(`progress-${ui.progress}-tab`).focus();
    });
    $("githubRanges").addEventListener("click", (event) => {
        const btn = event.target.closest("[data-range]");
        if (!btn) return;
        ui.range = btn.dataset.range;
        renderGitHubProgress();
    });
    $("ticketRanges").addEventListener("click", (event) => {
        const btn = event.target.closest("[data-range]");
        if (!btn) return;
        ui.ticketRange = btn.dataset.range;
        renderProgress();
    });
    for (const [id, kind, draw] of [["challengeFilters", "challenges", renderChallenges], ["achievementFilters", "achievements", renderAchievements]]) {
        $(id).addEventListener("change", (event) => {
            const key = event.target.dataset.filter;
            if (!Object.hasOwn(ui[kind], key)) return;
            ui[kind][key] = event.target.value;
            draw();
        });
    }
    for (const id of ["ticketProgress", "githubProgress", "chartModalBody"]) wireDailyTables($(id));
    for (const id of ["ticketProgress", "githubProgress"]) $(id).addEventListener("click", (event) => {
        const retry = event.target.closest("[data-analytics-retry]");
        if (retry) {
            const source = retry.dataset.analyticsRetry;
            analyticsCache.delete(analyticsKey(source, source === "ticket" ? ui.ticketRange : ui.range));
            renderProgress();
            return;
        }
        const card = event.target.closest("[data-chart-key]");
        if (!card || event.target.closest("summary, details, a, select, input") || (event.target.closest("button") && !event.target.closest("button[data-chart-key]"))) return;
        openChart(card.dataset.chartKey);
    });
    $("chartModalClose").addEventListener("click", () => $("chartModal").close());
    $("chartModal").addEventListener("close", () => { activeChart = null; if (!modalOpen) showNextModal(); });
    $("chartModal").addEventListener("click", (event) => {
        if (event.target !== $("chartModal")) return;
        const bounds = $("chartModal").getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) $("chartModal").close();
    });
    $("chartStyle").addEventListener("change", drawExpandedChart);
    $("chartModalBody").addEventListener("keydown", inspectChartKey);
    $("chartModalBody").addEventListener("pointermove", inspectChartPointer);
    $("chartModalBody").addEventListener("pointerdown", inspectChartPointer);
    for (const btn of document.querySelectorAll(".tabs button")) btn.addEventListener("click", () => selectTab(btn.dataset.tab));
    document.querySelector(".tabs").addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const tabs = [...document.querySelectorAll(".tabs button")];
        const i = tabs.findIndex((b) => b.dataset.tab === ui.tab);
        const next = event.key === "Home" ? tabs[0] : event.key === "End" ? tabs.at(-1) : tabs[(i + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
        selectTab(next.dataset.tab);
        next.focus();
    });

    document.querySelector(".care").addEventListener("click", async (event) => {
        const btn = event.target.closest("[data-care]");
        if (!btn) return;
        btn.disabled = true;
        await post("/api/interact", { action: btn.dataset.care });
        setTimeout(() => { btn.disabled = false; }, 400);
    });
    wirePet($("scene"));

    $("refreshBtn").addEventListener("click", async () => {
        $("refreshBtn").disabled = true;
        const res = await post("/api/sync", { instance: CFG.instanceId });
        if (res?.result?.method === "handoff") toast("Couldn't reach the IT server directly — asked Copilot to sync your tickets.");
        else if (res?.result?.summary) {
            const s = res.result.summary;
            if (!s.newlyRewarded && !s.reclosed && !s.reopened) toast("You're all caught up — no new closed tickets.");
            else if (s.reopened && !s.newlyRewarded) toast(`${s.reopened} ticket${s.reopened === 1 ? " was" : "s were"} reopened · XP held until closed again`);
        }
        render();
    });

    $("renameBtn").addEventListener("click", () => {
        $("renameForm").hidden = false;
        $("buddyName").hidden = true;
        $("renameBtn").hidden = true;
        $("renameInput").value = state?.name || "";
        $("renameInput").focus();
        $("renameInput").select();
    });
    const closeRename = () => { $("renameForm").hidden = true; $("buddyName").hidden = false; $("renameBtn").hidden = false; };
    $("renameCancel").addEventListener("click", closeRename);
    $("renameInput").addEventListener("keydown", (event) => { if (event.key === "Escape") closeRename(); });
    $("renameForm").addEventListener("submit", async (event) => {
        event.preventDefault();
        const name = $("renameInput").value.trim();
        if (!name) { toast("Name can't be empty.", "err"); return; }
        if (await post("/api/rename", { name })) closeRename();
    });

    const settings = $("settings");
    const toggleSettings = (open) => {
        settings.hidden = !open;
        $("settingsBtn").setAttribute("aria-expanded", String(open));
    };
    $("settingsBtn").addEventListener("click", (event) => { event.stopPropagation(); toggleSettings(settings.hidden); });
    document.addEventListener("click", (event) => { if (!settings.hidden && !settings.contains(event.target)) toggleSettings(false); });
    document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !settings.hidden) { toggleSettings(false); $("settingsBtn").focus(); } });
    $("demoToggle").addEventListener("change", (event) => post("/api/mode", { mode: event.target.checked ? "demo" : "live" }));
    for (const seg of document.querySelectorAll(".seg")) {
        seg.addEventListener("click", (event) => {
            const btn = event.target.closest("button[data-value]");
            if (btn) post("/api/prefs", { [seg.dataset.pref]: btn.dataset.value });
        });
    }

    $("demoBanner").addEventListener("click", (event) => {
        const btn = event.target.closest("[data-demo]");
        if (btn) post("/api/demo/ticket", { kind: btn.dataset.demo, count: Number(btn.dataset.count) || 1 });
    });
    let resetArmed = null;
    $("demoReset").addEventListener("click", async () => {
        if (!resetArmed) {
            $("demoReset").textContent = "Confirm reset?";
            resetArmed = setTimeout(() => { resetArmed = null; $("demoReset").textContent = "Reset"; }, 3000);
            return;
        }
        clearTimeout(resetArmed);
        resetArmed = null;
        $("demoReset").textContent = "Reset";
        await post("/api/demo/reset", {});
    });
    $("demoExit").addEventListener("click", () => post("/api/mode", { mode: "live" }));

    $("catTabs").addEventListener("click", (event) => {
        const btn = event.target.closest("[data-cat]");
        if (!btn) return;
        ui.category = btn.dataset.cat;
        renderCustomize();
        $("catTabs").querySelector(`[data-cat="${ui.category}"]`)?.focus();
    });
    $("itemGrid").addEventListener("click", (event) => {
        const tile = event.target.closest(".item");
        if (!tile) return;
        if (tile.dataset.unequip) { post("/api/unequip", { slot: tile.dataset.unequip }); return; }
        const item = catalogById().get(tile.dataset.item);
        if (!item) return;
        if (!item.unlocked) { toast(`Locked — ${item.requirement}`); return; }
        const enabled = ACCESSORY_SLOTS.includes(item.slot) && item.equipped ? false : undefined;
        post("/api/equip", { itemId: item.id, enabled });
    });

    window.matchMedia("(prefers-reduced-motion: reduce)").addEventListener?.("change", () => render());
    setInterval(() => {
        if (!state || document.hidden) return;
        renderRoom();
        renderSync();
        if (ui.tab === "home") renderGitHubHome();
    }, 60_000);
}

// ---------- Updates ----------
function initUpdates() {
    checkForUpdates(false);
    setInterval(() => checkForUpdates(false), 6 * 60 * 60 * 1000);
    $("checkUpdates").onclick = () => checkForUpdates(true);
    $("installUpdate").onclick = installUpdate;
}
let updateInfo = null;
function renderUpdate() {
    if (!updateInfo) return;
    const { current, latest, available, error } = updateInfo;
    $("updateNotice").hidden = !available;
    $("updateNoticeText").textContent = available ? `Byte Buddy ${latest} is available (you have ${current}). Your progress is kept.` : "";
    $("updateDetails").textContent = error ? `Version ${current}. Couldn't check: ${error}` : available ? `Version ${current}; ${latest} is available.` : `Version ${current} is up to date.`;
}
async function checkForUpdates(manual) {
    const button = $("checkUpdates");
    button.disabled = true;
    try {
        updateInfo = await api(`/api/update${manual ? "?force=1" : ""}`);
        renderUpdate();
        if (manual) toast(updateInfo.error ? `Couldn't check for updates: ${updateInfo.error}` : updateInfo.available ? `Version ${updateInfo.latest} is available.` : "Byte Buddy is up to date.", updateInfo.error ? "err" : "");
    } catch (error) {
        if (manual) toast(`Couldn't check for updates: ${error.message}`, "err");
    } finally { button.disabled = false; }
}
async function installUpdate() {
    const button = $("installUpdate");
    button.disabled = true;
    try {
        const { result } = await api("/api/update/install", {});
        $("updateNoticeText").textContent = result.updated ? `Updated to ${result.latest}. Restart Copilot to finish; your progress is untouched.` : "Already up to date.";
        button.hidden = true;
    } catch (error) {
        toast(`Update failed: ${error.message}`, "err");
        button.disabled = false;
    }
}

wire();
connectEvents();
loadState();
initUpdates();
setInterval(tick, 1000 / 12);
