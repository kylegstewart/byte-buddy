import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { rect, W, FLOOR_Y, buddy as robot, buddyMetrics as artMetrics } from "./public/art.js";
import { newEvolution, evolutionView } from "./evolution.mjs";
import { createPetMotion } from "./public/pet-motion.js";

const html = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
const script = readFileSync(new URL("./public/app.js", import.meta.url), "utf8")
    .replace(/^import .*;\r?\n/gm, "")
    .replace(/wire\(\);\r?\nconnectEvents\(\);\r?\nloadState\(\);\r?\n(?:initUpdates\(\);\r?\n)?setInterval\(tick, 1000 \/ 12\);\s*$/, "");

class Element {
    constructor() {
        this.dataset = {};
        this.attributes = {};
        this.details = [];
        this.buttons = [];
        this.listeners = {};
        this.classList = { add() {}, remove() {} };
        this.style = { setProperty(key, value) { this[key] = value; } };
    }
    appendChild(child) { child.parentElement = this; }
    set innerHTML(value) {
        this.writes = (this.writes || 0) + 1;
        this.html = value;
        this.details = [...value.matchAll(/<details[^>]*data-detail-key="([^"]+)"[^>]*>/g)]
            .map((match) => {
                const detail = new Element();
                detail.dataset.detailKey = match[1];
                const tableKey = /data-table-key="([^"]+)"/.exec(match[0])?.[1];
                if (tableKey) detail.dataset.tableKey = tableKey;
                detail.open = /\sopen(?:\s|>)/.test(match[0]);
                detail.body = new Element();
                return detail;
            });
    }
    get innerHTML() { return this.html || ""; }
    querySelectorAll(selector) { return selector === "button" ? this.buttons : this.details; }
    querySelector(selector) { return selector === ".daily-table-body" ? this.body : null; }
    setAttribute(key, value) { this.attributes[key] = value; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    addEventListener(type, handler) { this.listeners[type] = handler; }
    focus() { this.focused = true; }
    getScreenCTM() { return { inverse: () => ({}) }; }
    getBBox() { return { x: -12, y: -40, width: 24, height: 40 }; }
    setPointerCapture(id) { this.captured = id; }
    hasPointerCapture(id) { return this.captured === id; }
    releasePointerCapture() { this.captured = null; }
}

function fixture() {
    const nodes = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => [match[1], new Element()]));
    for (const [, id] of script.matchAll(/\bid="([A-Za-z][A-Za-z0-9-]*)"/g)) nodes.set(id, new Element());
    for (const id of ["chartCursor", "chartInspector", "chartPlot", "chartReadout", "buddyPose", "buddySprite"]) nodes.set(id, new Element());
    for (const id of ["githubRanges", "ticketRanges"]) {
        nodes.get(id).buttons = ["7", "30", "90", "all"].map((range) => Object.assign(new Element(), { dataset: { range } }));
    }
    const context = vm.createContext({
        window: { addEventListener() {}, matchMedia: () => ({ matches: false }) },
        requestAnimationFrame: () => 1,
        setInterval: () => 1,
        DOMPoint: class { constructor(x, y) { this.x = x; this.y = y; } matrixTransform() { return this; } },
        document: { addEventListener() {}, querySelectorAll: () => [], querySelector: () => new Element(), getElementById: (id) => {
            assert.ok(nodes.has(id), `UI references an existing element: ${id}`);
            return nodes.get(id);
        } }, URL, URLSearchParams, console, rect, W, FLOOR_Y, createPetMotion, robot, artMetrics,
        fetch: async () => { throw new Error("Unexpected network request in seeded UI fixture"); },
    });
    vm.runInContext(script, context);
    return {
        nodes,
        run: (code) => vm.runInContext(code, context),
        state: (value) => {
            context.fixtureState = { mode: "live", analyticsRevision: "fixture-1", ...value };
            vm.runInContext("state = fixtureState", context);
        },
        analytics: (source, range, { timeline, ...metrics }) => {
            context.fixtureAnalytics = { timeline, metrics };
            context.fixtureSource = source;
            context.fixtureRange = range;
            vm.runInContext(`analyticsCache.set(analyticsKey(fixtureSource, fixtureRange), {
                ...fixtureAnalytics, revision: state.analyticsRevision, mode: state.mode, status: "ready",
            })`, context);
        },
        table: (id, index = 0) => {
            context.fixtureDetail = nodes.get(id).details[index];
            assert.ok(context.fixtureDetail, `Daily disclosure ${index} exists in ${id}`);
            context.fixtureDetail.open = true;
            vm.runInContext("hydrateDailyTable(fixtureDetail)", context);
            return context.fixtureDetail.body.innerHTML;
        },
    };
}

test("Home sections, standalone tabs, evolution location and settings removal", () => {
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(new Set(ids).size, ids.length, "no duplicate element IDs");
    const home = html.slice(html.indexOf('<section id="panel-home"'), html.indexOf('<section id="panel-customize"'));
    assert.ok(home.indexOf('id="petHomeTitle"') < home.indexOf('id="githubHomeTitle"'));
    assert.ok(home.indexOf('id="githubHomeTitle"') < home.indexOf('id="ticketHomeTitle"'));
    assert.match(home.slice(home.indexOf('id="githubHomeTitle"'), home.indexOf('id="ticketHomeTitle"')), /id="githubRefresh"/);
    assert.match(home.slice(home.indexOf('id="ticketHomeTitle"')), /id="refreshBtn"/);
    const customize = html.slice(html.indexOf('<section id="panel-customize"'), html.indexOf('<section id="panel-progress"'));
    assert.ok(customize.indexOf('id="evoTrack"') < customize.indexOf('id="catTabs"'));
    for (const tab of ["home", "customize", "progress", "challenges", "achievements", "how"]) {
        assert.match(html, new RegExp(`id="tab-${tab}"[^>]*aria-controls="panel-${tab}"`));
        assert.match(html, new RegExp(`id="panel-${tab}"[^>]*role="tabpanel"`));
    }
    assert.doesNotMatch(html, /id="githubSettings"/);
    assert.match(script, /\/api\/github\/settings/, "GitHub scope is managed in Connections");
    const ui = fixture();
    assert.equal(ui.run("ui.range"), "all");
    assert.equal(ui.run("ui.ticketRange"), "all");
});

test("cumulative XP preserves sorted server observations and the all-time baseline in filtered charts", () => {
    const ui = fixture();
    const timeline = [
        { date: "2026-01-01", xp: 120, cumulativeXp: 120, opened: 1, merged: 0, reviewed: 0 },
        { date: "2026-10-26", xp: 30, cumulativeXp: 150, opened: 0, merged: 1, reviewed: 0 },
    ];
    ui.state({ github: {} });
    ui.analytics("github", "7", { timeline: timeline.slice(1) });
    ui.run('ui.range = "7"; renderGitHubProgress()');
    const charts = ui.nodes.get("githubCharts").innerHTML;
    assert.match(charts, /Lifetime GitHub XP/);
    assert.doesNotMatch(charts, /<tbody>/, "collapsed daily tables do not build rows");
    assert.match(ui.table("githubCharts"), /<td>150<\/td>/);
    assert.match(charts, /PR activity per day/);
    assert.match(charts, /Separate bars show daily observations, not stacked totals/);
    assert.match(charts, /<rect /);
    ui.analytics("github", "all", { timeline });
    ui.run('ui.range = "all"; renderGitHubProgress()');
    assert.deepEqual(JSON.parse(ui.run('JSON.stringify(chartModels.get("UTC:chart:GitHub XP over time (cumulative)").timeline.map(d => d.cumulativeXp))')), [120, 150]);
    const allTable = ui.table("githubCharts");
    assert.ok(allTable.indexOf("<td>120</td>") < allTable.indexOf("<td>150</td>"), "daily observations retain server date ordering");
});

test("chart disclosures and evidence disclosures retain both open and closed states across rerenders", () => {
    const ui = fixture();
    ui.state({ github: { limitations: ["Fixture evidence limitation"] } });
    ui.analytics("github", "all", { timeline: [{ date: "2026-01-01", xp: 100, cumulativeXp: 100, opened: 1, merged: 0, reviewed: 0 }] });
    ui.run('sectionKeys.delete("githubProgress"); renderGitHubProgress()');
    ui.nodes.get("githubCharts").details[0].open = true;
    ui.nodes.get("githubEvidence").details[0].open = true;
    ui.run('sectionKeys.delete("githubProgress"); renderGitHubProgress()');
    assert.equal(ui.nodes.get("githubCharts").details[0].open, true);
    assert.equal(ui.nodes.get("githubCharts").details[1].open, false);
    assert.equal(ui.nodes.get("githubEvidence").details[0].open, true);
    ui.nodes.get("githubCharts").details[0].open = false;
    ui.run('sectionKeys.delete("githubProgress"); renderGitHubProgress()');
    assert.equal(ui.nodes.get("githubCharts").details[0].open, false);
});

test("ticket charts wait for full analytics rather than fabricating recent-history stats and include bonus XP", async () => {
    const ui = fixture();
    const recent = [
        { id: "123", title: "Fixture", status: "rewarded", kind: "normal", xp: 100, closedOn: "2026-01-01" },
        { id: "124", title: "Reopened", status: "revoked", kind: "hd", xp: 200, closedOn: "2026-01-02" },
    ];
    ui.state({ recent });
    ui.run("renderProgress()");
    assert.match(ui.nodes.get("ticketCharts").innerHTML, /Loading selected analytics/);
    assert.equal(ui.nodes.get("progressStats").innerHTML, "");
    assert.doesNotMatch(ui.nodes.get("ticketCharts").innerHTML, /<td>100<\/td>|<td>300<\/td>/);
    await new Promise((resolve) => setImmediate(resolve));
    ui.run("renderProgress()");
    assert.match(ui.nodes.get("ticketCharts").innerHTML, /Couldn't load daily analytics/);
    assert.match(ui.nodes.get("ticketCharts").innerHTML, /Retry analytics/);
    ui.analytics("ticket", "all", { timeline: [
        { date: "2026-01-01", xp: 100, cumulativeXp: 100, total: 1, normal: 1, hd: 0, critical: 0 },
        { date: "2026-01-02", xp: 250, cumulativeXp: 350, total: 1, normal: 0, hd: 1, critical: 0 },
    ] });
    ui.run("renderTicketCharts()");
    assert.doesNotMatch(ui.nodes.get("ticketRangeNote").textContent, /preview/);
    assert.match(ui.table("ticketCharts"), /<td>350<\/td>/);
    ui.nodes.get("ticketCharts").details[0].open = true;
    ui.run("renderTicketCharts()");
    assert.equal(ui.nodes.get("ticketCharts").details[0].open, true);
    assert.doesNotMatch(ui.nodes.get("ticketRangeNote").textContent, /Legacy records/);
    for (const [xp, tickets] of [[50, 0], [0, 2], [50, 2]]) {
        ui.run(`selectedAnalytics("ticket").metrics.undatedXp = ${xp}; selectedAnalytics("ticket").metrics.undatedTickets = ${tickets}; sectionKeys.delete("ticketCharts"); renderTicketCharts()`);
        assert.match(ui.nodes.get("ticketRangeNote").textContent, new RegExp(`Legacy records without dates \\(${tickets} tickets, ${xp} XP\\)`));
        assert.match(ui.nodes.get("ticketRangeNote").textContent, /included in lifetime totals but excluded from dated charts/);
        assert.match(ui.table("ticketCharts"), /<td>350<\/td>/);
    }
    ui.run('selectedAnalytics("ticket").metrics.undatedXp = 0; selectedAnalytics("ticket").metrics.undatedTickets = 0; sectionKeys.delete("ticketCharts"); renderTicketCharts()');
    assert.doesNotMatch(ui.nodes.get("ticketRangeNote").textContent, /Legacy records/);
});

test("real ticket links use the IT ticket URL, escape content, and leave demo tickets unlinked", () => {
    const ui = fixture();
    ui.state({});
    const rendered = ui.run('ticketItems([{ id: "123&x", title: "<fixture>", kind: "hd", xp: 200, status: "rewarded", closedOn: "2026-01-01" }], "")');
    assert.match(rendered, /https:\/\/mymeyer\.meyerdistributing\.com\/it\/ticket-list\?ticketNum=123%26x/);
    assert.match(rendered, /rel="noopener noreferrer"/);
    assert.match(rendered, /&lt;fixture&gt;/);
    assert.doesNotMatch(ui.run('ticketItems([{ id: "demo-1", demo: true, kind: "normal", xp: 100 }], "")'), /href=/);
});

test("manual GitHub UI disables active syncs and disabled integrations", () => {
    const ui = fixture();
    ui.state({ mode: "live", progress: {}, github: { settings: { enabled: true, repositories: ["org/repo"] }, syncing: true } });
    ui.run("renderGitHubHome()");
    assert.equal(ui.nodes.get("githubRefresh").disabled, true);
    ui.run("state.github.syncing = false; renderGitHubHome()");
    assert.equal(ui.nodes.get("githubRefresh").disabled, false);
    assert.match(ui.nodes.get("githubSyncStatus").textContent, /Manual sync only/);
    ui.run("state.github.settings.enabled = false; renderGitHubHome()");
    assert.equal(ui.nodes.get("githubRefresh").disabled, true);
    assert.doesNotMatch(ui.nodes.get("githubSyncStatus").textContent, /settings|automatically/);
});

test("ticket charts label local calendar days without shifting dates; GitHub stays UTC and HD totals stay inclusive", () => {
    const ui = fixture();
    const timeline = [{ date: "2026-03-08", xp: 100, cumulativeXp: 100, total: 3, normal: 1, hd: 1, critical: 1, opened: 1, merged: 0, reviewed: 0 }];
    ui.state({ progress: { hd: 2, critical: 1 }, recent: [], github: {} });
    ui.analytics("ticket", "all", { timeline, hd: 2, critical: 1 });
    ui.analytics("github", "all", { timeline });
    ui.run("renderProgress(); renderGitHubProgress()");
    const tickets = ui.nodes.get("ticketCharts").innerHTML + ui.table("ticketCharts");
    const github = ui.nodes.get("githubCharts").innerHTML + ui.table("githubCharts");
    assert.match(tickets, /Recorded days \(local time\)/);
    assert.match(tickets, /daily data \(local time\)/);
    assert.doesNotMatch(tickets, /\(UTC\)/);
    assert.match(github, /Recorded days \(UTC\)/);
    assert.match(github, /daily data \(UTC\)/);
    for (const [year, month, day] of [[2026, 1, 1], [2026, 3, 8], [2026, 11, 1]]) {
        const key = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        const expected = new Date(year, month - 1, day, 12).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
        assert.equal(ui.run(`chartDate("${key}", "local time")`), expected);
        assert.equal(ui.run(`chartDate("${key}")`), expected);
    }
    assert.match(tickets, /Help Desk \(non-critical\)/);
    assert.match(ui.nodes.get("progressStats").innerHTML, /Help Desk incl\. critical[\s\S]*?stat-value">2<\/span>/);
});

test("Home uses shared progress cards, accurate daily ticket goals and source-specific achievements", () => {
    const ui = fixture();
    ui.state({ progress: { ticketTotalXp: 1250, week: 5, total: 12, hd: 4, critical: 1, currentStreak: 2, today: 4, month: 10, longestStreak: 3 }, achievements: [
        { category: "ticket", name: "Ticket star", description: "<safe>", unlockedAt: "2026-01-01" },
        { category: "github", name: "GitHub star", unlockedAt: "2026-01-01" },
    ], github: { summary: {} }, challenges: [] });
    ui.run("renderTicketHome(); renderGitHubHome()");
    for (const prefix of ["ticket", "github"]) {
        assert.equal((ui.nodes.get(`${prefix}HomeStats`).innerHTML.match(/class="stat"/g) || []).length, 6);
        assert.match(ui.nodes.get(`${prefix}HomeGoals`).innerHTML, /Challenge progress/);
        assert.match(ui.nodes.get(`${prefix}HomeAchievements`).innerHTML, /Recent .* achievements/);
    }
    assert.match(ui.nodes.get("ticketHomeStats").innerHTML, /1,250/);
    assert.match(ui.nodes.get("ticketHomeGoals").innerHTML, /High Five · today/);
    assert.match(ui.nodes.get("ticketHomeGoals").innerHTML, /max="5" value="4"/);
    assert.doesNotMatch(ui.nodes.get("ticketHomeGoals").innerHTML, /Hat Trick/);
    assert.match(ui.nodes.get("ticketHomeAchievements").innerHTML, /Ticket star/);
    assert.doesNotMatch(ui.nodes.get("ticketHomeAchievements").innerHTML, /GitHub star/);
    assert.match(ui.nodes.get("ticketHomeAchievements").innerHTML, /&lt;safe&gt;/);
    assert.match(html, /class="card home-section pet-home"/);
    assert.equal((html.match(/class="card progress-home /g) || []).length, 2);
    assert.doesNotMatch(html, /class="card sync-card"|id="latestList"/);
    ui.run("state.progress.today = 10; state.achievements = []; renderTicketHome()");
    assert.match(ui.nodes.get("ticketHomeGoals").innerHTML, /Perfect Ten · today/);
    assert.match(ui.nodes.get("ticketHomeGoals").innerHTML, /max="10" value="10"/);
    assert.match(ui.nodes.get("ticketHomeAchievements").innerHTML, /No ticket achievements/);
});

test("only the active progress source draws charts and unchanged chart data preserves DOM", () => {
    const ui = fixture();
    ui.state({ progress: {}, recent: [], github: {} });
    ui.analytics("ticket", "all", { timeline: [{ date: "2026-01-01", xp: 100, cumulativeXp: 100, total: 1 }] });
    ui.analytics("github", "all", { timeline: [{ date: "2026-01-01", xp: 10, cumulativeXp: 10, opened: 1 }] });
    ui.run("renderProgress()");
    assert.equal(ui.nodes.get("githubCharts").writes || 0, 0, "hidden GitHub charts are not built");
    const ticketWrites = ui.nodes.get("ticketCharts").writes;
    ui.run("renderProgress()");
    assert.equal(ui.nodes.get("ticketCharts").writes, ticketWrites);
    ui.run('ui.progress = "github"; renderProgress()');
    const githubWrites = ui.nodes.get("githubCharts").writes;
    assert.equal(ui.nodes.get("ticketCharts").writes, ticketWrites);
    ui.run("state.progress.today = 3; renderProgress()");
    assert.equal(ui.nodes.get("githubCharts").writes, githubWrites, "unrelated pet/ticket changes do not replace GitHub charts");
    ui.run('state.analyticsRevision = "fixture-2"');
    ui.analytics("github", "all", { timeline: [{ date: "2026-01-01", xp: 30, cumulativeXp: 30, opened: 1 }] });
    ui.run("renderProgress()");
    assert.equal(ui.nodes.get("githubCharts").writes, githubWrites + 1);
    assert.match(ui.table("githubCharts"), /<td>30<\/td>/);
    ui.analytics("ticket", "all", { timeline: [{ date: "2026-01-01", xp: 200, cumulativeXp: 200, total: 1 }] });
    ui.run('ui.progress = "ticket"; renderProgress()');
    assert.equal(ui.nodes.get("ticketCharts").writes, ticketWrites + 1);
    assert.match(ui.table("ticketCharts"), /<td>200<\/td>/);
});

test("ticket range updates summary cards, recent links and charts together", () => {
    const ui = fixture();
    const ago = (days) => { const date = new Date(); date.setDate(date.getDate() - days); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; };
    const days = [120, 60, 20, 5].map(ago);
    ui.state({ progress: { ticketTotalXp: 1050, ticketXp: 1000, total: 10, hd: 4 },
        recent: days.map((closedOn, index) => ({ id: String(index + 1), title: `Ticket ${index + 1}`, closedOn, status: "rewarded", xp: 100 })) });
    const timeline = days.map((date, index) => ({ date, xp: 250, cumulativeXp: (index + 1) * 250, baseXp: 250, total: 1, hd: 0, critical: 1 }));
    for (const [range, total] of [["7", 1], ["30", 2], ["90", 3], ["all", 10]]) {
        ui.analytics("ticket", range, { timeline: range === "all" ? timeline : timeline.slice(-total),
            total, ticketTotalXp: range === "all" ? 1050 : total * 250, ticketXp: range === "all" ? 1000 : total * 250,
            hd: range === "all" ? 4 : total, critical: range === "all" ? 4 : total, undatedXp: 50 });
        ui.run(`ui.ticketRange = "${range}"; renderProgress()`);
        assert.match(ui.nodes.get("progressStats").innerHTML, new RegExp(`Tickets closed[\\s\\S]*?stat-value">${total}<`));
        assert.match(ui.nodes.get("progressStats").innerHTML, new RegExp(`Ticket XP[\\s\\S]*?stat-value">${range === "all" ? "1,050" : String(total * 250)}<`));
        assert.equal((ui.nodes.get("recentList").innerHTML.match(/href=/g) || []).length, range === "all" ? 4 : total);
        if (range !== "all") assert.match(ui.nodes.get("progressStats").innerHTML, new RegExp(`Help Desk incl\\. critical[\\s\\S]*?stat-value">${total}<`));
        assert.match(ui.table("ticketCharts"), /<td>1,000<\/td>/, "cumulative baseline remains all-time");
    }
    ui.run('state.analyticsRevision = "fixture-2"');
    ui.analytics("ticket", "7", { timeline: timeline.slice(-1), total: 2, ticketTotalXp: 777, ticketXp: 600, hd: 2, critical: 1 });
    ui.run('ui.ticketRange = "7"; renderProgress()');
    assert.match(ui.nodes.get("progressStats").innerHTML, /Ticket XP[\s\S]*?stat-value">777</);
    assert.match(script, /ui\.ticketRange = btn\.dataset\.range;\s*renderProgress\(\)/, "range click rerenders the whole ticket section");
    assert.doesNotMatch(script, /One overall level/);
});

test("catalog filtering, deterministic sorting and grade-colored pixel medals", () => {
    const ui = fixture();
    ui.state({ progress: { today: 0 }, challenges: [
        { name: "Ticket weekly", category: "ticket", repeat: "week", xp: 500, count: 0 },
        { name: "GitHub daily", category: "github", repeat: "day", xp: 100, count: 3 },
        { name: "Secret", category: "care", repeat: "once", secret: true, xp: 200, count: 1 },
    ], achievements: [
        { name: "Gold", category: "github", tier: "Gold", unlockedAt: "2026-01-01" },
        { name: "Silver", category: "ticket", tier: "Silver" },
        { name: "Platinum", category: "care", tier: "Platinum", unlockedAt: "2026-01-02" },
    ] });
    assert.equal(ui.run('ui.challenges.source = "github"; filteredCatalog(state.challenges, "challenges").length'), 1);
    assert.equal(ui.run('ui.challenges.status = "pending"; filteredCatalog(state.challenges, "challenges").length'), 0);
    assert.equal(ui.run('ui.challenges.source = "all"; ui.challenges.status = "all"; ui.challenges.type = "secret"; filteredCatalog(state.challenges, "challenges")[0].name'), "Secret");
    assert.equal(ui.run('ui.challenges.type = "all"; ui.challenges.sort = "xp"; filteredCatalog(state.challenges, "challenges")[0].name'), "Ticket weekly");
    assert.equal(ui.run('ui.challenges.sort = "completed"; filteredCatalog(state.challenges, "challenges")[0].name'), "GitHub daily");
    assert.equal(ui.run('ui.achievements.sort = "grade"; filteredCatalog(state.achievements, "achievements")[0].name'), "Platinum");
    assert.equal(ui.run('ui.achievements.sort = "recent"; filteredCatalog(state.achievements, "achievements")[0].name'), "Platinum");
    assert.equal(ui.run('ui.achievements.status = "pending"; filteredCatalog(state.achievements, "achievements")[0].name'), "Silver");
    ui.run('ui.achievements.type = "Gold"; renderAchievements()');
    assert.match(ui.nodes.get("achList").innerHTML, /No achievements match/);
    ui.run('ui.achievements.status = "all"; ui.achievements.type = "all"; renderAchievements()');
    assert.match(ui.nodes.get("achList").innerHTML, /tier-gold/);
    assert.match(ui.nodes.get("achList").innerHTML, /tier-platinum/);
    assert.match(ui.nodes.get("achList").innerHTML, /Buddy care/);
    for (const [tier, color] of [["Bronze", "#cd7f32"], ["Silver", "#c0c0c0"], ["Gold", "#ffd23f"], ["Platinum", "#b6d9dc"], ["Diamond", "#89d8ff"]]) {
        assert.ok(ui.run(`medal(true, "${tier}")`).includes(color));
        assert.ok(ui.run(`medal(false, "${tier}")`).includes(color), "locked medal retains its grade");
    }
    assert.match(ui.run('tierPill("<unsafe>")'), /tier-bronze/);
});

test("merge role labels and drilldowns keep missing merger evidence unknown", () => {
    const ui = fixture();
    const timeline = [{ date: "2026-01-01", xp: 10, cumulativeXp: 10, merged: 5, authoredMerged: 5, mergedBy: 2 }];
    ui.state({ github: {} });
    ui.analytics("github", "all", { timeline, merged: 5, authoredMerged: 5, mergedBy: 2, unknownMerger: 3 });
    ui.run("renderGitHubProgress()");
    assert.match(ui.nodes.get("githubStats").innerHTML, /Own PRs merged[\s\S]*?stat-value">5</);
    assert.match(ui.nodes.get("githubStats").innerHTML, /PRs merged by you[\s\S]*?stat-value">2</);
    assert.match(ui.nodes.get("githubCharts").innerHTML, /Own PRs merged that day/);
    assert.match(ui.nodes.get("githubCharts").innerHTML, /PRs merged by you that day/);
    assert.match(ui.nodes.get("githubRangeNote").textContent, /3 merged PRs have unknown merger identity/);
    ui.run('openChart("github:stat:PRs merged by you")');
    assert.match(ui.nodes.get("chartReadout").textContent, /PRs merged by you: 2/);
    ui.run('state.analyticsRevision = "fixture-2"');
    ui.analytics("github", "all", { timeline: [{ date: "2026-01-01", xp: 10, cumulativeXp: 10, merged: 5, authoredMerged: 5 }], merged: 5, authoredMerged: 5, unknownMerger: 3 });
    ui.run('renderGitHubProgress(); openChart("github:stat:PRs merged by you")');
    assert.match(ui.nodes.get("chartReadout").textContent, /PRs merged by you: —/);
    assert.doesNotMatch(ui.nodes.get("chartModalBody").innerHTML, /<td>0<\/td>/);
});

test("expanded charts show daily data by default, inspect exact values and keep a stable snapshot", () => {
    const ui = fixture();
    ui.run('timelineChart("Fixture <safe>", [{date:"2026-01-01",xp:10}, {date:"2026-01-03",xp:25.5}, {date:"2026-01-04",xp:null}], [{label:"XP",value:d=>d.xp}]); openChart("UTC:chart:Fixture <safe>")');
    assert.equal(ui.nodes.get("chartModal").open, true);
    assert.equal(ui.nodes.get("chartModalBody").details[0].open, true);
    assert.match(ui.nodes.get("chartModalBody").innerHTML, /viewBox="0 0 900 260"/);
    assert.match(ui.nodes.get("chartModalBody").innerHTML, /Fixture &lt;safe&gt;/);
    ui.run("inspectChartDay(1)");
    assert.match(ui.nodes.get("chartReadout").textContent, /XP: 25\.5/);
    assert.equal(ui.nodes.get("chartInspector").attributes["aria-valuetext"], ui.nodes.get("chartReadout").textContent);
    const writes = ui.nodes.get("chartModalBody").writes;
    ui.run("inspectChartDay(2)");
    assert.match(ui.nodes.get("chartReadout").textContent, /XP: —/);
    assert.equal(ui.nodes.get("chartModalBody").writes, writes, "hover does not rebuild chart or table");
    ui.run('inspectChartPointer({clientX: 12, target:{closest:()=>({getBoundingClientRect:()=>({left:0,width:900})})}})');
    assert.match(ui.nodes.get("chartReadout").textContent, /XP: 10/);
    ui.run('timelineChart("Fixture <safe>", [{date:"2026-02-01",xp:999}], [{label:"XP",value:d=>d.xp}]); inspectChartDay(1)');
    assert.match(ui.nodes.get("chartReadout").textContent, /XP: 25\.5/, "background renders do not change an open chart");
    ui.run('$("chartStyle").value = "bars"; drawExpandedChart()');
    assert.match(ui.nodes.get("chartModalBody").innerHTML, /<rect /);
    assert.equal(ui.nodes.get("chartModalBody").details[0].open, true);
    assert.match(html, /<dialog id="chartModal"[^>]*aria-labelledby="chartModalTitle"/);
    assert.doesNotMatch(html + script, /chartObservation|chart-scrubber|daily observation slider/);
    assert.match(ui.nodes.get("chartModalBody").innerHTML, /id="chartInspector" tabindex="0" role="slider"/);
    assert.match(ui.nodes.get("chartModalBody").innerHTML, /class="chart-tooltip" aria-live="polite"/);
    assert.equal(ui.nodes.get("chartInspector").attributes["aria-valuenow"], "1", "style changes preserve the selected day");
    assert.match(script, /chartModalClose[\s\S]*?\.close\(\)/);
});

test("chart inspector snaps irregular dates, supports touch capture and accessible keyboard bounds", () => {
    const ui = fixture();
    ui.run('timelineChart("Snap", [{date:"2026-01-01",xp:10}, {date:"2026-01-03",xp:25}, {date:"2026-01-11",xp:null}], [{label:"XP",value:d=>d.xp}]); openChart("UTC:chart:Snap")');
    ui.run(`inspectChartPointer({clientX:250, target:{closest:()=>({getBoundingClientRect:()=>({left:100,width:450})})}})`);
    assert.equal(ui.nodes.get("chartCursor").attributes.x1, 187.20000000000002, "guide snaps to Jan 3, not the pointer's continuous position");
    assert.match(ui.nodes.get("chartReadout").textContent, /Jan 3.*XP: 25/);
    assert.equal(ui.run('activeChart.selectedDay'), 1);
    ui.run(`inspectChartPointer({type:"pointerdown",pointerId:7,clientX:-500,target:{closest:()=>({getBoundingClientRect:()=>({left:0,width:320}),focus:()=>{window.focused=true},setPointerCapture:id=>{window.captured=id}})}})`);
    assert.equal(ui.run('window.captured'), 7);
    assert.equal(ui.run('window.focused'), true);
    assert.equal(ui.run('activeChart.selectedDay'), 0);
    const key = (value) => ui.run(`inspectChartKey({key:${JSON.stringify(value)},preventDefault:()=>{window.prevented=true},target:{closest:()=>true}})`);
    key("ArrowLeft");
    assert.equal(ui.run('activeChart.selectedDay'), 0);
    key("ArrowRight");
    assert.equal(ui.nodes.get("chartInspector").attributes["aria-valuenow"], "1");
    key("End");
    key("ArrowUp");
    assert.equal(ui.run('activeChart.selectedDay'), 2);
    assert.match(ui.nodes.get("chartInspector").attributes["aria-valuetext"], /XP: —/);
    key("Home");
    assert.equal(ui.run('activeChart.selectedDay'), 0);
    assert.equal(ui.run('window.prevented'), true);
    assert.match(ui.nodes.get("chartPlot").style["--chart-x"], /%$/);
    ui.run(`inspectChartPointer({clientX:9000,target:{closest:()=>({getBoundingClientRect:()=>({left:0,width:320})})}})`);
    assert.equal(ui.run('activeChart.selectedDay'), 2);
    ui.run(`timelineChart("Single", [{date:"2026-01-01",xp:0}], [{label:"XP",value:d=>d.xp}]); openChart("UTC:chart:Single")`);
    assert.equal(ui.nodes.get("chartCursor").attributes.x1, 450);
    key("ArrowRight");
    assert.match(ui.nodes.get("chartReadout").textContent, /XP: 0/);
    ui.run('timelineChart("Empty", [], [{label:"XP",value:d=>d.xp}]); openChart("UTC:chart:Empty")');
    key("Home");
    assert.match(ui.nodes.get("chartModalBody").innerHTML, /No activity data/);
});

test("breakdown and comparison cards expand their summaries with honest daily XP context", () => {
    const ui = fixture();
    ui.state({ github: {} });
    ui.analytics("github", "all", { timeline: [{date: "2026-01-01", xp: 90, cumulativeXp: 90}], breakdown: { merged: 90 } });
    ui.run('renderGitHubProgress(); openChart("github:breakdown")');
    assert.match(ui.nodes.get("chartModalBody").innerHTML, /90 XP/);
    assert.match(ui.nodes.get("chartModalNote").textContent, /not an invented category history/);
    assert.equal(ui.nodes.get("chartModalBody").details[0].open, true);
    assert.match(ui.nodes.get("chartReadout").textContent, /Daily GitHub XP: 90/);
    ui.run('openChart("github:comparisons")');
    assert.match(ui.nodes.get("chartModalBody").innerHTML, /authored merges/);
    assert.match(ui.nodes.get("chartModalNote").textContent, /not daily records or quality estimates/);
    assert.match(html, /id="githubBreakdown"[^>]*data-chart-key=/);
});

test("only painted buddy starts pointer care; touch capture, cancellation and keyboard petting remain accessible", () => {
    const ui = fixture();
    ui.state({ care: { sleeping: false }, progress: { stage: 1 }, appearance: {} });
    ui.run('post = (path, body) => { window.calls.push(body.action); }; window.calls = []; wirePet($("scene"));');
    const scene = ui.nodes.get("scene");
    const event = (sprite = true, extra = {}) => ({ pointerId: 1, isPrimary: true, button: 0,
        clientX: 80, clientY: 80, pointerType: "touch", preventDefault() {},
        target: { closest: () => sprite ? ui.nodes.get("buddySprite") : null }, ...extra });
    assert.equal(scene.listeners.click, undefined, "empty room has no click-to-pet listener");
    scene.listeners.pointerdown(event(false));
    scene.listeners.pointerup(event(false));
    assert.equal(ui.run('window.calls.length'), 0);
    scene.listeners.pointerdown(event());
    assert.equal(scene.captured, 1);
    scene.listeners.pointerup(event());
    assert.equal(scene.captured, null);
    assert.equal(ui.run('window.calls.join()'), 'pet');
    scene.listeners.pointerdown(event());
    scene.listeners.pointercancel(event());
    assert.equal(ui.run('petMotion.body.phase'), 'idle');
    assert.equal(ui.run('window.calls.length'), 1);
    ui.run('state.care.sleeping = true');
    scene.listeners.keydown({ key: 'Enter', preventDefault() {} });
    assert.equal(ui.run('window.calls.join()'), 'pet,wake');
    scene.listeners.keydown({ key: 'Enter', repeat: true, preventDefault() {} });
    assert.equal(ui.run('window.calls.length'), 2);
    scene.listeners.pointerdown(event());
    ui.run('petMotion.body.phase = "held"; petMotion.body.vx = 200;');
    scene.listeners.pointerup(event());
    assert.equal(ui.run('window.calls.join()'), 'pet,wake,fling', 'a throw never also pets');
    scene.listeners.lostpointercapture(event());
    assert.equal(ui.run('petMotion.body.phase'), 'flying', 'releasing capture must not cancel the throw');
    scene.listeners.keydown({ key: 'Escape' });
    assert.equal(ui.run('petMotion.body.phase'), 'idle');
    ui.run('Object.assign(petMotion.body, { phase: "held", x: 80, y: 70, gripX: 5, gripY: -30, angle: 35 });');
    assert.equal(ui.run('petTransform()'), 'translate(80 70) translate(5 -30) rotate(35) scale(1.03 1.03) translate(-5 30)',
        'both rotation and pickup scaling are anchored at the exact local grip');
});

function evolutionFixture() {
    const ui = fixture();
    ui.state({ evolution: evolutionView(newEvolution(20000, 1), 20000),
        appearance: {}, progress: { xp: 20000, level: 13, stage: 1 },
        prefs: { motion: "full" }, care: { sleeping: false }, celebrations: [], name: "Fixture" });
    return ui;
}

test("Customize subtabs mirror Progress keyboard navigation and retain selection without rendering hidden controls", () => {
    const ui = evolutionFixture();
    const nav = ui.nodes.get("customizeNav");
    nav.buttons = ["evolution", "accessories"].map((section) => {
        const button = ui.nodes.get(`customize-${section}-tab`);
        button.dataset.customize = section;
        assert.match(html, new RegExp(`id="customize-${section}-tab"[^>]*aria-controls="${section}Customize"`));
        return button;
    });
    ui.run('window.draws = []; renderEvolution = () => window.draws.push("evolution"); renderCustomize = () => window.draws.push("accessories"); wire(); renderCustomizePanel()');
    const check = (section) => {
        assert.equal(ui.run("ui.customize"), section);
        for (const button of nav.buttons) {
            const selected = button.dataset.customize === section;
            assert.equal(button.attributes["aria-selected"], String(selected));
            assert.equal(button.tabIndex, selected ? 0 : -1);
            assert.equal(ui.nodes.get(`${button.dataset.customize}Customize`).hidden, !selected);
        }
        assert.equal(ui.run("window.draws.at(-1)"), section);
    };
    check("evolution");
    nav.listeners.click({ target: { closest: () => nav.buttons[1] } });
    check("accessories");
    ui.run('render = () => renderCustomizePanel(); selectTab("home"); selectTab("customize")');
    check("accessories");
    for (const [key, section] of [["Home", "evolution"], ["End", "accessories"], ["ArrowRight", "evolution"], ["ArrowLeft", "accessories"]]) {
        let prevented = false;
        nav.listeners.keydown({ key, preventDefault() { prevented = true; } });
        assert.equal(prevented, true);
        check(section);
        assert.equal(ui.nodes.get(`customize-${section}-tab`).focused, true);
    }
    const before = ui.run("window.draws.length");
    nav.listeners.keydown({ key: "Tab", preventDefault() { assert.fail("Tab must retain normal focus navigation"); } });
    assert.equal(ui.run("window.draws.length"), before);
    const css = readFileSync(new URL("./public/app.css", import.meta.url), "utf8");
    assert.match(css, /\.scene-wrap\s*\{[^}]*width: 100%;/);
    assert.match(css, /\.scene\s*\{[^}]*aspect-ratio: 4 \/ 3;/);
});

test("five species and stage previews share wallet controls without repeated DOM replacements", () => {
    const ui = evolutionFixture();
    ui.run("renderEvolution()");
    assert.equal((ui.nodes.get("buddyTypes").innerHTML.match(/data-buddy=/g) || []).length, 5);
    assert.equal((ui.nodes.get("evoTrack").innerHTML.match(/<svg /g) || []).length, 5);
    assert.match(ui.nodes.get("evoWallet").textContent, /20,000 evolution credits/);
    assert.match(ui.nodes.get("evoTrack").innerHTML, /evo future next affordable/);
    assert.match(ui.nodes.get("evoTrack").innerHTML, /data-evo-action="upgrade"[^>]*aria-disabled="false"/);
    const writes = ui.nodes.get("evoTrack").writes;
    ui.run("renderEvolution()");
    assert.equal(ui.nodes.get("evoTrack").writes, writes);
    ui.run('state.evolution.active = "cat"; state.evolution.buddies.cat = {owned:3,selected:1,spent:20000}; state.evolution.available = 0; state.evolution.balance = -100; state.evolution.deficit = 100; state.evolution.spent = 20000; state.evolution.nextCost = 30000; renderEvolution()');
    assert.match(ui.nodes.get("evoTrack").innerHTML, /Kitten/);
    assert.match(ui.nodes.get("evoTrack").innerHTML, /Moon Cat/);
    assert.equal((ui.nodes.get("evoTrack").innerHTML.match(/>Owned</g) || []).length, 3);
    assert.match(ui.nodes.get("evoWallet").textContent, /100 XP deficit/);
    assert.match(ui.nodes.get("evoTrack").innerHTML, /evo future next"/);
    assert.match(ui.nodes.get("evoTrack").innerHTML, /data-evo-action="upgrade"[^>]*aria-disabled="true"/);
    assert.match(ui.nodes.get("evoReset").textContent, /refund 20,000/);
});

test("room options, Style picker and all evolution previews use the selected creature style", () => {
    const ui = evolutionFixture();
    for (const type of ["cat", "dog", "dragon", "slime"]) {
        ui.run(`state.evolution.active = "${type}"; state.progress.stage = 5`);
        const previews = new Set(), galleries = new Set();
        for (const variant of ["variant-classic", "variant-boxy", "variant-bubble"]) {
            ui.run(`state.appearance.variant = "${variant}"; renderEvolution()`);
            const roomOptions = ui.run('robotOpts({still:true})');
            assert.equal(roomOptions.type, type);
            assert.equal(roomOptions.variant, variant);
            const thumb = ui.run(`thumbFor({slot:"variant",id:"${variant}"})`);
            previews.add(thumb);
            assert.ok(thumb.includes(robot({ ...roomOptions, expr: "smile", still: true })));
            const gallery = ui.nodes.get("evoTrack").innerHTML;
            galleries.add(gallery);
            for (let stage = 1; stage <= 5; stage++) {
                assert.ok(gallery.includes(robot({ ...roomOptions, stage, expr: "smile", still: true,
                    hat: null, glasses: null, headphones: null, neck: null })), `${type} ${stage} ${variant}`);
            }
            assert.match(thumb, new RegExp(`viewBox="${artMetrics(5, variant, type).viewBox}"`));
        }
        assert.equal(previews.size, 3, `${type}: three distinct Style thumbnails`);
        assert.equal(galleries.size, 3, `${type}: three distinct evolution galleries`);
    }
});

test("reset requires confirmation, supports cancellation and rejects stale modes or wallet revisions", () => {
    const ui = evolutionFixture();
    ui.run('window.calls = []; changeEvolution = (...args) => window.calls.push(args); state.evolution.spent = 20000; wire()');
    const reset = ui.nodes.get("evoReset");
    const dialog = ui.nodes.get("evoConfirm");
    reset.listeners.click();
    assert.equal(dialog.open, true);
    assert.match(ui.nodes.get("evoConfirmText").textContent, /20,000 credits/);
    dialog.returnValue = "cancel"; dialog.listeners.close();
    assert.equal(ui.run("window.calls.length"), 0);
    for (const mutate of ['state.evolution.revision++', 'state.mode = "demo"']) {
        reset.listeners.click();
        ui.run(mutate);
        dialog.returnValue = "reset"; dialog.listeners.close();
        assert.equal(ui.run("window.calls.length"), 0);
        assert.match(ui.nodes.get("evoStatus").textContent, /Evolution changed/);
    }
    reset.listeners.click();
    dialog.returnValue = "reset"; dialog.listeners.close();
    assert.equal(ui.run("window.calls[0][0]"), "reset");
    assert.match(html, /<dialog id="evoConfirm"[^>]*aria-labelledby="evoConfirmTitle"/);
});

test("evolving is blocked while an evolution animation or celebration is in progress", () => {
    const ui = evolutionFixture();
    ui.run('window.calls = 0; api = async () => { window.calls++; return {result:{}}; }; loadState = async () => {};');
    for (const lock of ['evolution = {event:{id:"e"},from:1,to:2,t:0,stage:1,done(){}}', 'evolutionModalOpen = true', 'modalQueue.push({type:"evolution",id:"q"})']) {
        ui.run(lock + "; renderEvolution()");
        assert.match(ui.nodes.get("evoTrack").innerHTML, /data-evo-action="upgrade"[^>]*aria-disabled="true"/);
        ui.run('changeEvolution("upgrade")');
        assert.equal(ui.run("window.calls"), 0);
        ui.run("evolution = null; evolutionModalOpen = false; modalQueue.length = 0");
    }
    ui.run("renderEvolution()");
    assert.match(ui.nodes.get("evoTrack").innerHTML, /data-evo-action="upgrade"[^>]*aria-disabled="false"/);
});

test("pending purchase coalesces clicks and sends only validated server-owned pricing inputs", async () => {
    const ui = evolutionFixture();
    ui.run('window.requests = []; api = async (path, body) => { window.requests.push({path,body}); await new Promise(resolve => {window.finish = resolve}); return {result:{}} }; loadState = async () => {};');
    const purchase = ui.run('changeEvolution("upgrade", "cat")');
    await ui.run('changeEvolution("upgrade", "dog")');
    assert.equal(ui.run("window.requests.length"), 1);
    assert.equal(ui.run("window.requests[0].path"), "/api/evolution");
    assert.equal(ui.run("window.requests[0].body.type"), "cat");
    assert.equal(ui.run("window.requests[0].body.revision"), 0);
    assert.equal(ui.run("window.requests[0].body.mode"), "live");
    assert.match(ui.nodes.get("evoTrack").innerHTML, /data-evo-action="upgrade"[^>]*aria-disabled="true"/);
    ui.run("window.finish()"); await purchase;
    assert.match(ui.nodes.get("evoStatus").textContent, /Evolution purchased/);
});

test("levelups never evolve; explicit purchases use the right species and safely cancel across resets", async () => {
    const ui = evolutionFixture();
    ui.run('modalQueue.push({id:"level",type:"levelup",from:12,to:13}); showNextModal()');
    assert.equal(ui.run("evolution"), null);
    assert.equal(ui.nodes.get("celTitle").textContent, "Level 13!");
    ui.run('modalOpen = false; modalQueue.push({id:"cat",type:"evolution",buddyType:"cat",stageFrom:1,stageTo:2}); showNextModal()');
    assert.match(ui.nodes.get("celTitle").textContent, /Evolved into Cat/);
    ui.run('state.evolution.active = "cat"; state.progress.stage = 2; modalOpen = false; const event = {id:"anim",type:"evolution",buddyType:"cat",stageFrom:1,stageTo:2}; state.celebrations = [event]; modalQueue.push(event); showNextModal()');
    assert.equal(ui.run("evolution.to"), 2);
    ui.run('petMotion.body.phase = "held"; petPointerId = 7; $("scene").setPointerCapture(7); render = () => {}; api = async () => ({...state,progress:{...state.progress,stage:1},celebrations:[]});');
    await ui.run("loadState()");
    assert.equal(ui.run("evolution"), null);
    assert.equal(ui.run("modalOpen"), false);
    assert.equal(ui.run("petMotion.body.phase"), "idle");
    assert.equal(ui.nodes.get("scene").captured, null);
    assert.equal(ui.run("modalQueue.length"), 0);
});
