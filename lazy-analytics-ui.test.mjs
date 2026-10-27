import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
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
        this.style = { setProperty(key, value) { this[key] = value; } };
    }
    set innerHTML(value) {
        this.html = value;
        this.writes = (this.writes || 0) + 1;
        this.details = [...value.matchAll(/<details[^>]*data-detail-key="([^"]+)"[^>]*>/g)].map(([tag, key]) => {
            const detail = new Element();
            detail.dataset.detailKey = key;
            const tableKey = /data-table-key="([^"]+)"/.exec(tag)?.[1];
            if (tableKey) detail.dataset.tableKey = tableKey;
            detail.open = /\sopen(?:\s|>)/.test(tag);
            detail.body = new Element();
            return detail;
        });
    }
    get innerHTML() { return this.html || ""; }
    querySelectorAll(selector) { return selector === "button" ? this.buttons : this.details; }
    querySelector(selector) { return selector === ".daily-table-body" ? this.body : null; }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(type, handler) { this.listeners[type] = handler; }
    matches(selector) { return selector === "details[data-table-key]" && Boolean(this.dataset.tableKey); }
    showModal() { this.open = true; }
}

function fixture(respond = () => { throw new Error("Unexpected network request"); }) {
    const nodes = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, new Element()]));
    for (const id of ["chartCursor", "chartInspector", "chartPlot", "chartReadout"]) nodes.set(id, new Element());
    for (const source of ["ticket", "github"]) nodes.get(`${source}Ranges`).buttons =
        ["7", "30", "90", "all"].map((range) => Object.assign(new Element(), { dataset: { range } }));
    const requests = [];
    const context = vm.createContext({
        window: {}, URL, URLSearchParams, console, createPetMotion,
        document: { getElementById: (id) => {
            assert.ok(nodes.has(id), `Existing UI element ${id}`);
            return nodes.get(id);
        } },
        fetch: async (path, options) => {
            requests.push({ path, options });
            const result = await respond(path);
            return { ok: (result.status || 200) < 400, status: result.status || 200, json: async () => result.body };
        },
    });
    vm.runInContext(script, context);
    const run = (code) => vm.runInContext(code, context);
    run('render = () => { if (ui.tab === "progress") renderProgress(); }; processCelebrations = () => {};');
    return {
        nodes, requests, run, globals: context,
        setState: (value) => { context.fixtureState = value; run("state = fixtureState"); },
        json: (code) => JSON.parse(run(`JSON.stringify(${code})`)),
    };
}

const summaryState = (revision = "r1", mode = "live") => ({
    analyticsRevision: revision, mode, progress: { xp: 10000, ticketTotalXp: 8000, githubXp: 2000, total: 20, hd: 4 },
    recent: [], achievements: [], challenges: [], github: { summary: { xp: 2000, merged: 3 } },
});
const day = (index, extra = {}) => ({
    date: new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10),
    xp: 5, cumulativeXp: 9000 + (index + 1) * 5, total: 1, normal: 1, hd: 0, critical: 0, ...extra,
});
function page(path, timeline, metrics = { ticketTotalXp: 12345, total: 777, hd: 45 }, revision = "r1") {
    const query = new URL(path, "http://buddy").searchParams;
    const offset = Number(query.get("offset"));
    const limit = Number(query.get("limit"));
    return { body: {
        revision, source: query.get("source"), range: query.get("range"), metrics,
        offset, limit, timeline: timeline.slice(offset, offset + limit), total: timeline.length,
        hasMore: offset + limit < timeline.length,
    } };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
};

test("summary-only Home renders from scalar summaries without loading analytics or syncing", () => {
    const ui = fixture();
    ui.setState(summaryState());
    ui.run("renderTicketHome(); renderGitHubHome()");
    assert.equal(ui.requests.length, 0);
    assert.match(ui.nodes.get("ticketHomeStats").innerHTML, /8,000/);
    assert.match(ui.nodes.get("githubHomeStats").innerHTML, /2,000/);
    assert.match(ui.nodes.get("githubSyncStatus").textContent, /Manual sync only/);
    assert.doesNotMatch(script, /state\.ticketAnalytics|g\?\.analytics|progress\.githubMetrics/);
});

test("only a visited range is fetched, all pages preserve server baselines and range metrics, care changes reuse cache", async () => {
    const rows = Array.from({ length: 241 }, (_, index) => day(index));
    const ui = fixture((path) => page(path, rows));
    ui.setState(summaryState());
    ui.run('ui.tab = "progress"; ui.ticketRange = "7"; renderProgress()');
    assert.match(ui.nodes.get("ticketCharts").innerHTML, /Loading selected analytics/);
    assert.equal(ui.nodes.get("ticketRanges").buttons.find((b) => b.dataset.range === "7").attributes["aria-pressed"], "true");
    await settle();
    assert.equal(ui.requests.length, 2);
    const queries = ui.requests.map(({ path }) => new URL(path, "http://buddy").searchParams);
    assert.deepEqual(queries.map((q) => q.get("offset")), ["0", "180"]);
    assert.ok(queries.every((q) => q.get("source") === "ticket" && q.get("range") === "7" && q.get("revision") === "r1"));
    assert.match(ui.nodes.get("progressStats").innerHTML, /12,345/);
    assert.match(ui.nodes.get("progressStats").innerHTML, /777/);
    assert.equal(ui.run('chartModels.get("local time:chart:Ticket XP over time (cumulative)").timeline[0].cumulativeXp'), 9005);
    assert.doesNotMatch(ui.nodes.get("ticketCharts").innerHTML, /<tbody>|<td>/);
    const writes = ui.nodes.get("ticketCharts").writes;
    ui.setState({ ...summaryState(), care: { affection: 95 } });
    ui.run("renderProgress()");
    assert.equal(ui.requests.length, 2);
    assert.equal(ui.nodes.get("ticketCharts").writes, writes);
    ui.run('ui.ticketRange = "30"; renderProgress()');
    await settle();
    assert.equal(ui.requests.length, 4);
    ui.run('ui.ticketRange = "7"; renderProgress()');
    assert.equal(ui.requests.length, 4);
    assert.ok(ui.requests.every(({ path }) => path.startsWith("/api/analytics?")));
});

test("source/range switches stay operable during loading and late responses never replace the selected source", async () => {
    const pending = [];
    const ui = fixture((path) => {
        const job = deferred();
        pending.push({ path, ...job });
        return job.promise;
    });
    ui.setState(summaryState());
    ui.run('ui.tab = "progress"; ui.ticketRange = "7"; renderProgress(); ui.progress = "github"; ui.range = "30"; renderProgress(); ui.range = "90"; renderProgress()');
    assert.equal(pending.length, 3);
    assert.equal(ui.nodes.get("githubRanges").buttons.find((b) => b.dataset.range === "90").attributes["aria-pressed"], "true");
    pending[2].resolve(page(pending[2].path, [day(1)], { xp: 333 }));
    await settle();
    assert.match(ui.nodes.get("githubStats").innerHTML, /333/);
    const writes = ui.nodes.get("githubCharts").writes;
    pending[0].resolve(page(pending[0].path, [day(2)]));
    pending[1].resolve(page(pending[1].path, [day(3)], { xp: 222 }));
    await settle();
    assert.match(ui.nodes.get("githubStats").innerHTML, /333/);
    assert.equal(ui.nodes.get("githubCharts").writes, writes);
    ui.run('ui.range = "30"; renderProgress()');
    assert.match(ui.nodes.get("githubStats").innerHTML, /222/);
    assert.equal(ui.requests.length, 3);
    assert.equal(ui.run('chartModels.get("UTC:chart:GitHub XP over time (cumulative)").series[0].value(selectedAnalytics("github").timeline[0])'), 9020);
});

test("old revisions and mode-switch responses are discarded, including when returning to the original selection", async () => {
    const pending = [];
    const ui = fixture((path) => {
        const job = deferred();
        pending.push({ path, ...job });
        return job.promise;
    });
    ui.setState(summaryState());
    ui.run('ui.tab = "progress"; renderProgress()');
    ui.setState(summaryState("r2"));
    ui.run("renderProgress()");
    pending[0].resolve(page(pending[0].path, [day(1)], {}, "r1"));
    pending[1].resolve(page(pending[1].path, [day(2)], { total: 12 }, "r2"));
    await settle();
    assert.equal(ui.run('selectedAnalytics("ticket").metrics.total'), 12);
    ui.setState(summaryState("r2", "demo"));
    ui.run("renderProgress()");
    ui.setState(summaryState("r2", "live"));
    ui.run("renderProgress()");
    pending[2].resolve(page(pending[2].path, [day(3)], { total: 666 }, "r2"));
    pending[3].resolve(page(pending[3].path, [day(4)], { total: 15 }, "r2"));
    await settle();
    assert.equal(ui.run('selectedAnalytics("ticket").metrics.total'), 15);
    assert.equal(ui.run("analyticsCache.size"), 1);
});

test("errors expose retry, empty-page loops are rejected and 409 refreshes the revision without syncing", async () => {
    let attempt = 0;
    const ui = fixture((path) => {
        if (path === "/api/state") return { body: summaryState("r2") };
        if (++attempt === 1) return { status: 409, body: { error: "stale revision" } };
        return page(path, [day(1)], { total: 9 }, "r2");
    });
    ui.setState(summaryState());
    ui.run('ui.tab = "progress"; renderProgress()');
    await settle();
    assert.equal(ui.run('selectedAnalytics("ticket").status'), "ready");
    assert.equal(ui.run("state.analyticsRevision"), "r2");
    assert.equal(ui.requests.length, 3);
    assert.ok(ui.requests.every(({ path }) => !path.includes("/sync")));

    const bad = fixture((path) => ({ ...page(path, []), body: { ...page(path, []).body, hasMore: true } }));
    bad.setState(summaryState());
    bad.run('ui.tab = "progress"; renderProgress()');
    await settle();
    assert.match(bad.nodes.get("ticketCharts").innerHTML, /empty page/);
    assert.match(bad.nodes.get("ticketCharts").innerHTML, /data-analytics-retry="ticket"/);
    assert.equal(bad.requests.length, 1);
    bad.run('analyticsCache.delete(analyticsKey("ticket", ui.ticketRange)); renderProgress()');
    await settle();
    assert.equal(bad.requests.length, 2);
});

test("daily data creates no collapsed rows, paginates at 50, preserves disclosures/pages, and makes no requests", () => {
    const ui = fixture();
    ui.run('var rows = Array.from({length:123}, (_, i) => ({ date: new Date(Date.UTC(2025,0,i+1)).toISOString().slice(0,10), xp:i })); var reads = 0; var series = [{label:"XP", value: d => { reads++; return d.xp; }}]');
    const closed = ui.run('dailyTable("Fixture", rows, series, "UTC")');
    assert.doesNotMatch(closed, /<tr>|<tbody>/);
    assert.equal(ui.run("reads"), 0);
    const host = new Element();
    host.innerHTML = closed;
    ui.nodes.set("testTableHost", host);
    ui.run('wireDailyTables($("testTableHost"))');
    const detail = host.details[0];
    detail.open = true;
    host.listeners.toggle({ target: detail });
    assert.equal((detail.body.innerHTML.match(/<th scope="row">/g) || []).length, 50);
    assert.match(detail.body.innerHTML, /Page 1 of 3/);
    const next = { dataset: { tablePage: "1" }, closest: () => detail };
    host.listeners.click({ target: { closest: () => next } });
    assert.match(detail.body.innerHTML, /Page 2 of 3/);
    assert.equal(ui.run("dailyTables.get('inline:UTC:Fixture').page"), 1);
    ui.run('replaceDetails($("testTableHost"), dailyTable("Fixture", rows, series, "UTC"))');
    assert.equal(host.details[0].open, true);
    assert.match(host.details[0].body.innerHTML, /Page 2 of 3/);
    host.details[0].open = false;
    host.listeners.toggle({ target: host.details[0] });
    assert.equal(host.details[0].body.innerHTML, "");
    ui.run('dailyTables.get("inline:UTC:Fixture").page = 2');
    assert.equal((ui.run('dailyTablePage(dailyTables.get("inline:UTC:Fixture"))').match(/<th scope="row">/g) || []).length, 23);
    assert.equal(ui.requests.length, 0);
});

test("modal daily table is visible by default, bounded and remains a stable snapshot across revisions", async () => {
    const ui = fixture((path) => page(path, Array.from({ length: 201 }, (_, i) => day(i)), { xp: 123 }, "r2"));
    ui.setState(summaryState());
    ui.run('chartModels.set("fixture", { title:"Snapshot", timeline:Array.from({length:201}, (_,i)=>({date:"2026-01-01",xp:i})), series:[{label:"XP",value:d=>d.xp}], style:"lines", timeZone:"UTC" }); openChart("fixture")');
    assert.equal(ui.nodes.get("chartModal").open, true);
    assert.match(ui.nodes.get("chartModalBody").innerHTML, /data-table-key="modal:UTC:Snapshot" open/);
    assert.equal((ui.nodes.get("chartModalBody").innerHTML.match(/<th scope="row">/g) || []).length, 50);
    const snapshot = ui.nodes.get("chartModalBody").innerHTML;
    ui.setState(summaryState("r2"));
    ui.run('ui.tab = "progress"; ui.progress = "github"; renderProgress()');
    await settle();
    assert.equal(ui.nodes.get("chartModalBody").innerHTML, snapshot);
    assert.equal(ui.run("activeChart.timeline[0].xp"), 0);
    ui.run('dailyTables.get("modal:UTC:Snapshot").page = 2; $("chartStyle").value = "bars"; drawExpandedChart()');
    assert.match(ui.nodes.get("chartModalBody").innerHTML, /Page 3 of 5/);
    assert.match(ui.nodes.get("chartModalBody").innerHTML, /<rect /);
});

test("revision reloads clear stale drilldowns but retain daily and evidence disclosures through loading", async () => {
    const pending = [];
    const ui = fixture((path) => {
        const job = deferred();
        pending.push({ path, ...job });
        return job.promise;
    });
    const initial = summaryState();
    initial.github.limitations = ["Recorded evidence is incomplete"];
    ui.setState(initial);
    ui.run('ui.tab = "progress"; ui.progress = "github"; renderProgress()');
    pending[0].resolve(page(pending[0].path, [day(1, { opened: 1, merged: 1, reviewed: 1 })], { xp: 100 }));
    await settle();
    ui.nodes.get("githubCharts").details[0].open = true;
    ui.nodes.get("githubEvidence").details[0].open = true;
    ui.run('openChart("github:breakdown")');
    const snapshot = ui.nodes.get("chartModalBody").innerHTML;
    ui.setState({ ...initial, analyticsRevision: "r2" });
    ui.run("renderProgress()");
    assert.equal(ui.run('chartModels.has("github:breakdown")'), false, "blank loading cards cannot open an old revision");
    assert.equal(ui.nodes.get("githubStats").innerHTML, "");
    assert.match(ui.nodes.get("githubCharts").innerHTML, /Loading selected analytics/);
    pending[1].resolve(page(pending[1].path, [day(2, { opened: 1, merged: 1, reviewed: 1 })], { xp: 200 }, "r2"));
    await settle();
    assert.equal(ui.nodes.get("githubCharts").details[0].open, true);
    assert.equal(ui.nodes.get("githubCharts").details[1].open, false);
    assert.equal(ui.nodes.get("githubEvidence").details[0].open, true);
    assert.match(ui.nodes.get("githubStats").innerHTML, /200/);
    assert.equal(ui.nodes.get("chartModalBody").innerHTML, snapshot, "an explicitly opened modal retains its own snapshot");
    ui.nodes.get("githubEvidence").details[0].open = false;
    ui.setState({ ...initial, mode: "demo", analyticsRevision: "r3" });
    ui.run("renderProgress()");
    pending[2].resolve(page(pending[2].path, [day(3, { opened: 1, merged: 1, reviewed: 1 })], { xp: 300 }, "r3"));
    await settle();
    assert.equal(ui.nodes.get("githubEvidence").details[0].open, false);
    assert.match(ui.nodes.get("githubStats").innerHTML, /300/);
});

test("current-save export is explicit, authenticated, complete and cleans up its download URL", async () => {
    const pending = deferred();
    const save = { version: 1, awards: { "original-award-id": { xp: 100 } }, tickets: { "123": { title: "Fixture" } } };
    const ui = fixture(() => pending.promise);
    const links = [];
    const revoked = [];
    const timers = [];
    let blob;
    ui.globals.Blob = Blob;
    ui.globals.URL = class extends URL {
        static createObjectURL(value) { blob = value; return "blob:fixture-save"; }
        static revokeObjectURL(url) { revoked.push(url); }
    };
    ui.globals.setTimeout = (callback, delay) => { timers.push({ callback, delay }); };
    ui.globals.document.createElement = (tag) => {
        assert.equal(tag, "a");
        const anchor = { click() { this.clicked = true; }, remove() { this.removed = true; } };
        links.push(anchor);
        return anchor;
    };
    ui.globals.document.body = { appendChild: (anchor) => { anchor.appended = true; } };
    ui.run('CFG.token = "fixture-token"');
    assert.equal(ui.requests.length, 0);
    assert.equal(links.length, 0);
    assert.match(html.slice(html.indexOf('<section id="panel-how"')), /id="exportCurrentSave"[^>]*>Export current save/);
    assert.match(script, /exportCurrentSave"\)\.addEventListener\("click", exportCurrentSave\)/);
    const exporting = ui.run("exportCurrentSave()");
    assert.equal(ui.nodes.get("exportCurrentSave").disabled, true);
    await ui.run("exportCurrentSave()");
    assert.equal(ui.requests.length, 1, "an active export cannot be duplicated");
    pending.resolve({ body: save });
    await exporting;
    assert.equal(ui.requests[0].path, "/api/export");
    assert.equal(ui.requests[0].options.method, "GET");
    assert.equal(ui.requests[0].options.headers["x-buddy-token"], "fixture-token");
    assert.equal(blob.type, "application/json");
    assert.deepEqual(JSON.parse(await blob.text()), save, "export uses the complete response, not summary state");
    assert.equal(links[0].download, "buddy.rollback.json");
    assert.equal(links[0].href, "blob:fixture-save");
    assert.equal(links[0].appended, true);
    assert.equal(links[0].clicked, true);
    assert.equal(links[0].removed, true);
    assert.equal(ui.nodes.get("exportCurrentSave").disabled, false);
    assert.match(ui.nodes.get("exportStatus").textContent, /download started/);
    assert.deepEqual(revoked, []);
    assert.equal(timers.length, 1);
    timers[0].callback();
    assert.deepEqual(revoked, ["blob:fixture-save"]);
});

test("current-save export reports backend errors and re-enables its button without creating a download", async () => {
    const ui = fixture(() => ({ status: 403, body: { error: "Export denied" } }));
    await ui.run("exportCurrentSave()");
    assert.match(ui.nodes.get("exportStatus").textContent, /Couldn't export current save: Export denied/);
    assert.equal(ui.nodes.get("exportCurrentSave").disabled, false);
    assert.equal(ui.requests.length, 1);
});
