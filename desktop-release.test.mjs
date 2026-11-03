import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReleaseApi, planDesktopRelease, publishDesktopRelease, readReleaseVersion, releaseAssets, runReleaseCommand } from "./scripts/desktop-release.mjs";
import { syncVersion } from "./scripts/sync-version.mjs";

const version = "1.3.1";
const commit = "a".repeat(40);
const repository = "fixture/byte-buddy";

function fixture(context) {
    const root = mkdtempSync(join(tmpdir(), "byte-buddy-release-"));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, "package.json"), JSON.stringify({ version }));
    writeFileSync(join(root, "package-lock.json"), JSON.stringify({ version, packages: { "": { version } } }));
    writeFileSync(join(root, "version.json"), JSON.stringify({ version, gist: "preserved-gist" }));
    mkdirSync(join(root, "release"));
    for (const name of ["Byte Buddy Setup " + version + ".exe", "Byte Buddy " + version + ".exe", "Byte Buddy Setup " + version + ".exe.blockmap"]) {
        writeFileSync(join(root, "release", name), "fixture asset");
    }
    return root;
}

function apiFixture(overrides = {}) {
    const calls = [];
    const responses = { ["releases/tags/v" + version]: null, "releases?per_page=100&page=1": [], "releases/latest": { tag_name: "v1.3.0" }, ["git/ref/tags/v" + version]: null, ...overrides };
    const api = async (path) => {
        calls.push(path);
        assert.ok(Object.hasOwn(responses, path), "Unexpected API request: " + path);
        return responses[path];
    };
    return { api, calls };
}

test("release metadata requires all three manifests and the lockfile root to agree", (context) => {
    const root = fixture(context);
    assert.equal(readReleaseVersion(root), version);
    for (const lock of [{ version: "1.2.0", packages: { "": { version } } }, { version, packages: { "": { version: "1.2.0" } } }, { version }]) {
        writeFileSync(join(root, "package-lock.json"), JSON.stringify(lock));
        assert.throws(() => readReleaseVersion(root), /aligned/);
    }
    writeFileSync(join(root, "package-lock.json"), JSON.stringify({ version, packages: { "": { version } } }));
    writeFileSync(join(root, "version.json"), JSON.stringify({ version: "1.2.0" }));
    assert.throws(() => readReleaseVersion(root), /aligned/);
});

test("npm version synchronization preserves the gist and unrelated metadata", (context) => {
    const root = fixture(context);
    writeFileSync(join(root, "version.json"), JSON.stringify({ version: "1.3.0", gist: "preserved-gist", other: true }));
    assert.equal(syncVersion(root), version);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "version.json"), "utf8")), { version, gist: "preserved-gist", other: true });
    assert.equal(readReleaseVersion(root), version);
});

test("release metadata and npm version hook reject versions unsupported by the updater", (context) => {
    const root = fixture(context);
    for (const invalid of ["1.3.1-beta.1", "v1.3.1", "01.3.1", "1.3", "1.3.1\npublish=true"]) {
        writeFileSync(join(root, "package.json"), JSON.stringify({ version: invalid }));
        assert.throws(() => readReleaseVersion(root), /stable/);
        assert.throws(() => syncVersion(root), /stable/);
    }
});

test("release lookups authenticate only to GitHub, reject redirects, and distinguish failures from missing releases", async () => {
    const calls = [];
    let response = { status: 404 };
    const api = createReleaseApi({ repository, token: "fixture-token", fetchImpl: async (...args) => { calls.push(args); return response; } });
    assert.equal(await api("releases/latest"), null);
    const [url, options] = calls[0];
    assert.equal(url, "https://api.github.com/repos/fixture/byte-buddy/releases/latest");
    assert.equal(options.headers.Authorization, "Bearer fixture-token");
    assert.equal(options.redirect, "error");
    response = { status: 403, ok: false };
    await assert.rejects(api("releases/latest"), /403/);
    response = { status: 200, ok: true, json: async () => ({ tag_name: "v1.3.0" }) };
    assert.deepEqual(await api("releases/latest"), { tag_name: "v1.3.0" });
    assert.throws(() => createReleaseApi({ repository, token: "" }), /GH_TOKEN/);
    assert.throws(() => createReleaseApi({ repository: "../outside", token: "fixture" }), /GITHUB_REPOSITORY/);
});

test("the first stable release and an increased version are eligible", async () => {
    for (const latest of [null, { tag_name: "v1.3.0" }, { tag_name: "1.2.9" }]) {
        const { api } = apiFixture({ "releases/latest": latest });
        assert.deepEqual(await planDesktopRelease({ version, commit, api }), { publish: true, tag: "v" + version, draft: false, reason: "Ready to publish v" + version + " from " + commit + "." });
    }
});

test("already published versions are skipped rather than overwritten or rebuilt", async () => {
    const { api, calls } = apiFixture({ ["releases/tags/v" + version]: { draft: false } });
    assert.equal((await planDesktopRelease({ version, commit, api })).publish, false);
    assert.deepEqual(calls, ["releases/tags/v" + version]);
});

test("a missing tag cannot publish a downgrade or replace the latest version", async () => {
    for (const tag_name of ["v1.3.1", "v1.4.0", "v2.0.0"]) {
        const { api } = apiFixture({ "releases/latest": { tag_name } });
        await assert.rejects(planDesktopRelease({ version, commit, api }), /newer/);
    }
});

test("lightweight and annotated tags must identify the exact tested commit", async () => {
    for (const type of ["commit", "tag"]) {
        const ref = { object: { type, sha: commit } };
        const { api } = apiFixture({ ["git/ref/tags/v" + version]: ref, ["git/tags/" + commit]: { object: { type: "commit", sha: commit } } });
        assert.equal((await planDesktopRelease({ version, commit, api })).publish, true);
        const { api: conflictApi } = apiFixture({ ["git/ref/tags/v" + version]: { object: { type: "commit", sha: "b".repeat(40) } } });
        await assert.rejects(planDesktopRelease({ version, commit, api: conflictApi }), /never moved/);
    }
    const { api } = apiFixture();
    await assert.rejects(planDesktopRelease({ version, commit: "main", api }), /exact build commit/);
});

test("only a stable draft bound to this commit can be resumed", async () => {
    const draftPath = "releases?per_page=100&page=1";
    const { api } = apiFixture({ [draftPath]: [{ tag_name: "v" + version, draft: true, target_commitish: commit }] });
    assert.equal((await planDesktopRelease({ version, commit, api })).draft, true);
    const { api: taggedApi } = apiFixture({ [draftPath]: [{ tag_name: "v" + version, draft: true, target_commitish: "main" }], ["git/ref/tags/v" + version]: { object: { type: "commit", sha: commit } } });
    assert.equal((await planDesktopRelease({ version, commit, api: taggedApi })).draft, true);
    for (const draft of [{ draft: true, target_commitish: "main" }, { draft: true, target_commitish: commit, prerelease: true }]) {
        const { api: conflictApi } = apiFixture({ [draftPath]: [{ tag_name: "v" + version, ...draft }] });
        await assert.rejects(planDesktopRelease({ version, commit, api: conflictApi }), /draft does not match/);
    }
});

test("draft discovery paginates releases when the tag endpoint cannot find an unpublished release", async () => {
    const { api, calls } = apiFixture({
        "releases?per_page=100&page=1": Array.from({ length: 100 }, (_, index) => ({ tag_name: "other-" + index })),
        "releases?per_page=100&page=2": [{ tag_name: "v" + version, draft: true, target_commitish: commit }]
    });
    assert.equal((await planDesktopRelease({ version, commit, api })).draft, true);
    assert.ok(calls.includes("releases?per_page=100&page=2"));
    const { api: missingApi } = apiFixture({ "releases?per_page=100&page=1": null });
    await assert.rejects(planDesktopRelease({ version, commit, api: missingApi }), /repository access/);
});

test("release assets require a nonempty installer and portable app, with an optional blockmap", (context) => {
    const root = fixture(context);
    assert.equal(releaseAssets(root, version).length, 3);
    rmSync(join(root, "release", "Byte Buddy Setup " + version + ".exe.blockmap"));
    assert.equal(releaseAssets(root, version).length, 2);
    writeFileSync(join(root, "release", "Byte Buddy " + version + ".exe"), "");
    assert.throws(() => releaseAssets(root, version), /empty/);
});

test("publishing creates a commit-pinned draft, uploads both apps, then exposes the completed release", async (context) => {
    const root = fixture(context);
    const { api } = apiFixture();
    const commands = [];
    await publishDesktopRelease({ root, version, repository, commit, api, run: async (args) => commands.push(args) });
    assert.deepEqual(commands.map((args) => args.slice(0, 2)), [["release", "create"], ["release", "upload"], ["release", "edit"]]);
    assert.equal(commands[0][commands[0].indexOf("--target") + 1], commit);
    assert.ok(commands[0].includes("--draft"));
    assert.ok(commands[0].includes("--generate-notes"));
    assert.ok(commands[0].some((value) => value.includes("unsigned")));
    assert.ok(commands[1].includes(join(root, "release", "Byte Buddy Setup " + version + ".exe")));
    assert.ok(commands[1].includes(join(root, "release", "Byte Buddy " + version + ".exe")));
    assert.ok(commands[2].includes("--draft=false"));
    assert.ok(commands[2].includes("--prerelease=false"));
    assert.ok(commands[2].includes("--latest"));
    for (const args of commands) assert.equal(args[args.indexOf("--repo") + 1], repository);
});

test("a failed upload leaves only a draft and a retry resumes without creating another release", async (context) => {
    const root = fixture(context);
    const { api } = apiFixture();
    const commands = [];
    await assert.rejects(publishDesktopRelease({ root, version, repository, commit, api, run: async (args) => {
        commands.push(args);
        if (args[1] === "upload") throw new Error("fixture upload failure");
    } }), /upload failure/);
    assert.deepEqual(commands.map((args) => args[1]), ["create", "upload"]);
    const { api: resumeApi } = apiFixture({ "releases?per_page=100&page=1": [{ tag_name: "v" + version, draft: true, target_commitish: commit }] });
    commands.length = 0;
    await publishDesktopRelease({ root, version, repository, commit, api: resumeApi, run: async (args) => commands.push(args) });
    assert.deepEqual(commands.map((args) => args[1]), ["upload", "edit"]);
    assert.ok(commands[0].includes("--clobber"));
});

test("missing assets cannot create a draft and a release published during the build is left untouched", async (context) => {
    const root = fixture(context);
    rmSync(join(root, "release", "Byte Buddy Setup " + version + ".exe"));
    const commands = [];
    const run = async (args) => commands.push(args);
    const { api } = apiFixture();
    await assert.rejects(publishDesktopRelease({ root, version, repository, commit, api, run }), /Missing/);
    const { api: publishedApi } = apiFixture({ ["releases/tags/v" + version]: { draft: false } });
    assert.equal((await publishDesktopRelease({ root, version, repository, commit, api: publishedApi, run })).publish, false);
    assert.deepEqual(commands, []);
});

test("manual workflow runs build only without any token or network access", async (context) => {
    const root = fixture(context);
    const result = await runReleaseCommand({ root, command: "plan", environment: { GITHUB_EVENT_NAME: "workflow_dispatch" }, fetchImpl: () => assert.fail("unexpected request") });
    assert.equal(result.version, version);
    assert.equal(result.build, true);
    assert.equal(result.publish, false);
});

test("publishing is restricted to main pushes and planning skips already released versions", async (context) => {
    const root = fixture(context);
    for (const environment of [{ GITHUB_EVENT_NAME: "workflow_dispatch" }, { GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/heads/main" }, { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/feature" }]) {
        await assert.rejects(runReleaseCommand({ root, command: "publish", environment }), /pushes to main/);
    }
    const environment = { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main", GITHUB_REPOSITORY: repository, GITHUB_SHA: commit, GH_TOKEN: "fixture-token" };
    const result = await runReleaseCommand({ root, command: "plan", environment, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ draft: false }) }) });
    assert.equal(result.build, false);
    assert.equal(result.publish, false);
});
