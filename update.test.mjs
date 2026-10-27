import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compareVersions, createUpdater } from "./update.mjs";

const GIST = "c75260fc43632b76b3a1d4d49fa73916";
const tmp = () => mkdtempSync(join(tmpdir(), "bb-upd-"));

function install(dir, version, files = {}) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "version.json"), JSON.stringify({ version, gist: GIST }));
    writeFileSync(join(dir, "extension.mjs"), "old");
    for (const [name, text] of Object.entries(files)) {
        mkdirSync(join(dir, name, ".."), { recursive: true });
        writeFileSync(join(dir, name), text);
    }
}

function gist(version, files = {}, { truncated = [] } = {}) {
    const all = { "extension.mjs": `new ${version}`, "version.json": JSON.stringify({ version, gist: GIST }), "copilot-extension.json": "{}", ...files };
    return Object.fromEntries(Object.entries(all).map(([name, text]) => [name, truncated.includes(name)
        ? { truncated: true, raw_url: `https://gist.githubusercontent.com/u/${GIST}/raw/${encodeURIComponent(name)}`, content: "" }
        : { content: text, truncated: false }]));
}

const fakeFetch = (files, status = 200) => async (url) => {
    if (url.startsWith("https://api.github.com/gists/")) return status !== 200 ? { ok: false, status } : { ok: true, status, json: async () => ({ files }) };
    const name = decodeURIComponent(url.split("/raw/")[1]);
    return { ok: true, status: 200, text: async () => `raw ${name}` };
};

test("compares semantic versions numerically", () => {
    assert.ok(compareVersions("1.10.0", "1.9.9") > 0);
    assert.equal(compareVersions("2.0.0", "2.0.0"), 0);
    assert.throws(() => compareVersions("x", "1.0.0"));
});

test("check reports availability, missing source and failures without throwing", async () => {
    const dir = tmp();
    install(dir, "1.0.0");
    assert.equal((await createUpdater({ dir, fetchImpl: fakeFetch(gist("1.1.0")) }).check()).available, true);
    assert.equal((await createUpdater({ dir, fetchImpl: fakeFetch(gist("1.0.0")) }).check()).available, false);
    assert.match((await createUpdater({ dir, fetchImpl: fakeFetch({}, 404) }).check()).error, /not found/);
    assert.ok((await createUpdater({ dir, fetchImpl: async () => { throw new Error("offline"); } }).check()).error);
    rmSync(dir, { recursive: true, force: true });
});

test("install replaces code, preserves user data, and removes files dropped by a later release", async () => {
    const dir = tmp();
    install(dir, "1.0.0", { "artifacts/KYLSTE/buddy.json": "save", "keep.txt": "mine" });
    await createUpdater({ dir, fetchImpl: fakeFetch(gist("1.1.0", { "public\\app.js": "a", "gone.mjs": "x" }, { truncated: ["gone.mjs"] })) }).install();
    assert.equal(readFileSync(join(dir, "extension.mjs"), "utf8"), "new 1.1.0");
    assert.equal(readFileSync(join(dir, "public/app.js"), "utf8"), "a");
    assert.equal(readFileSync(join(dir, "gone.mjs"), "utf8"), "raw gone.mjs");
    assert.equal(readFileSync(join(dir, "artifacts/KYLSTE/buddy.json"), "utf8"), "save");
    assert.equal(JSON.parse(readFileSync(join(dir, "version.json"), "utf8")).version, "1.1.0");

    const result = await createUpdater({ dir, fetchImpl: fakeFetch(gist("1.2.0", { "public\\app.js": "b" })) }).install();
    assert.equal(result.restartRequired, true);
    assert.equal(existsSync(join(dir, "gone.mjs")), false);
    assert.equal(readFileSync(join(dir, "keep.txt"), "utf8"), "mine");
    assert.equal(readFileSync(join(dir, "public/app.js"), "utf8"), "b");
    rmSync(dir, { recursive: true, force: true });
});

test("install rejects unsafe or protected paths and incomplete updates before changing anything", async () => {
    const dir = tmp();
    install(dir, "1.0.0", { "artifacts/KYLSTE/buddy.json": "save" });
    for (const bad of ["artifacts\\KYLSTE\\buddy.json", "..\\evil.mjs", "C:\\evil.mjs", ".git\\config"]) {
        await assert.rejects(createUpdater({ dir, fetchImpl: fakeFetch(gist("1.1.0", { [bad]: "x" })) }).install(), /Unsafe|protected/);
    }
    const files = gist("1.1.0");
    delete files["extension.mjs"];
    await assert.rejects(createUpdater({ dir, fetchImpl: fakeFetch(files) }).install(), /missing required/);
    assert.equal(readFileSync(join(dir, "extension.mjs"), "utf8"), "old");
    assert.equal(readFileSync(join(dir, "artifacts/KYLSTE/buddy.json"), "utf8"), "save");
    rmSync(dir, { recursive: true, force: true });
});

test("install is a no-op when already current", async () => {
    const dir = tmp();
    install(dir, "1.0.0");
    assert.equal((await createUpdater({ dir, fetchImpl: fakeFetch(gist("1.0.0")) }).install()).updated, false);
    rmSync(dir, { recursive: true, force: true });
});
