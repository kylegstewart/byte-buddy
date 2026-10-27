import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compareVersions, createUpdater } from "./update.mjs";

const REPO = "o/r";
const tmp = () => mkdtempSync(join(tmpdir(), "bb-upd-"));

function install(dir, version, files = {}) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "version.json"), JSON.stringify({ version, repo: REPO }));
    writeFileSync(join(dir, "extension.mjs"), "old");
    for (const [name, text] of Object.entries(files)) {
        mkdirSync(join(dir, name, ".."), { recursive: true });
        writeFileSync(join(dir, name), text);
    }
}

function release(version, files) {
    const work = tmp();
    const top = join(work, "o-r-abc");
    mkdirSync(top);
    writeFileSync(join(top, "version.json"), JSON.stringify({ version, repo: REPO }));
    writeFileSync(join(top, "extension.mjs"), `new ${version}`);
    for (const [name, text] of Object.entries(files)) {
        mkdirSync(join(top, name, ".."), { recursive: true });
        writeFileSync(join(top, name), text);
    }
    execFileSync("tar", ["-czf", "r.tgz", "o-r-abc"], { cwd: work });
    const bytes = readFileSync(join(work, "r.tgz"));
    rmSync(work, { recursive: true, force: true });
    return bytes;
}

const fakeFetch = (tag, archive, status = 200) => async (url) => {
    if (url.endsWith("/releases/latest")) {
        return status !== 200 ? { ok: false, status } : { ok: true, status, json: async () => ({ tag_name: tag, html_url: "u", body: "n", tarball_url: `https://api.github.com/repos/${REPO}/tarball/${tag}` }) };
    }
    return { ok: true, status: 200, arrayBuffer: async () => archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.length) };
};

test("compares semantic versions numerically", () => {
    assert.ok(compareVersions("1.10.0", "1.9.9") > 0);
    assert.equal(compareVersions("v2.0.0", "2.0.0"), 0);
    assert.throws(() => compareVersions("x", "1.0.0"));
});

test("check reports availability, missing releases and failures without throwing", async () => {
    const dir = tmp();
    install(dir, "1.0.0");
    assert.equal((await createUpdater({ dir, fetchImpl: fakeFetch("v1.1.0") }).check()).available, true);
    assert.equal((await createUpdater({ dir, fetchImpl: fakeFetch("v1.0.0") }).check()).available, false);
    assert.match((await createUpdater({ dir, fetchImpl: fakeFetch("v1", null, 404) }).check()).error, /No release/);
    assert.ok((await createUpdater({ dir, fetchImpl: async () => { throw new Error("offline"); } }).check()).error);
    rmSync(dir, { recursive: true, force: true });
});

test("install replaces code, preserves user data, and removes files dropped by a later release", async () => {
    const dir = tmp();
    install(dir, "1.0.0", { "artifacts/KYLSTE/buddy.json": "save", "keep.txt": "mine" });
    await createUpdater({ dir, fetchImpl: fakeFetch("v1.1.0", release("1.1.0", { "public/app.js": "a", "gone.mjs": "x", "artifacts/KYLSTE/buddy.json": "evil" })) }).install();
    assert.equal(readFileSync(join(dir, "extension.mjs"), "utf8"), "new 1.1.0");
    assert.equal(readFileSync(join(dir, "artifacts/KYLSTE/buddy.json"), "utf8"), "save");
    assert.equal(JSON.parse(readFileSync(join(dir, "version.json"), "utf8")).version, "1.1.0");
    assert.ok(existsSync(join(dir, "gone.mjs")));

    const result = await createUpdater({ dir, fetchImpl: fakeFetch("v1.2.0", release("1.2.0", { "public/app.js": "b" })) }).install();
    assert.equal(result.restartRequired, true);
    assert.equal(existsSync(join(dir, "gone.mjs")), false);
    assert.equal(readFileSync(join(dir, "keep.txt"), "utf8"), "mine");
    assert.equal(readFileSync(join(dir, "public/app.js"), "utf8"), "b");
    rmSync(dir, { recursive: true, force: true });
});

test("install refuses a release whose version.json disagrees with its tag and changes nothing", async () => {
    const dir = tmp();
    install(dir, "1.0.0");
    await assert.rejects(createUpdater({ dir, fetchImpl: fakeFetch("v1.1.0", release("9.9.9", {})) }).install(), /expected 1.1.0/);
    assert.equal(readFileSync(join(dir, "extension.mjs"), "utf8"), "old");
    rmSync(dir, { recursive: true, force: true });
});

test("install is a no-op when already current", async () => {
    const dir = tmp();
    install(dir, "1.0.0");
    assert.equal((await createUpdater({ dir, fetchImpl: fakeFetch("v1.0.0") }).install()).updated, false);
    rmSync(dir, { recursive: true, force: true });
});
