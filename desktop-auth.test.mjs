import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createGitHubAuth } from "./desktop/github-auth.mjs";
import { resolveGitHubCli } from "./desktop/github-cli.mjs";

function notSignedIn() {
    return Object.assign(new Error("not signed in"), { code: 1, stderr: "To get started with GitHub CLI, please run: gh auth login" });
}

function fakeProcess() {
    const proc = new EventEmitter();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.stdin = new PassThrough();
    proc.killed = false;
    proc.kill = () => { proc.killed = true; };
    return proc;
}

test("GitHub sign-in reuses an authenticated CLI account without starting another device login", async (context) => {
    let launches = 0;
    const auth = createGitHubAuth({ executeImpl: async () => ({ stdout: "fixture-user\n" }), spawnImpl: () => { launches++; return fakeProcess(); } });
    context.after(() => auth.close());
    const result = await auth.login();
    assert.equal(result.status, "signed-in");
    assert.equal(result.login, "fixture-user");
    assert.equal(result.code, null);
    assert.equal(launches, 0);
});

test("existing sign-in is checked even while a device flow is pending and cancels that flow on success", async (context) => {
    const proc = fakeProcess();
    let authenticated = false;
    const auth = createGitHubAuth({ executeImpl: async () => { if (!authenticated) throw notSignedIn(); return { stdout: "fixture-user\n" }; }, spawnImpl: () => proc });
    context.after(() => auth.close());
    assert.equal((await auth.login()).status, "signing-in");
    authenticated = true;
    assert.equal((await auth.check()).status, "signed-in");
    assert.equal(proc.killed, true);
    proc.emit("close", 1);
    assert.equal(auth.status().status, "signed-in");
});

for (const output of ["First copy your one-time code: ABCD-1234", "One-time code (ABCD-1234) copied to clipboard", "! First copy your one-time code: \u001b[1mABCD-1234\u001b[0m"]) {
    test(`device sign-in recognizes code output: ${output.replace(/\x1b/g, "ESC")}`, async (context) => {
        const proc = fakeProcess();
        const auth = createGitHubAuth({ executeImpl: async () => { throw notSignedIn(); }, spawnImpl: () => proc });
        context.after(() => auth.close());
        await auth.login();
        proc.stderr.write(output.slice(0, 20));
        proc.stderr.write(output.slice(20));
        proc.stderr.write("\nprivate ghp_example_not_for_ui\n");
        assert.equal(auth.status().code, "ABCD-1234");
        assert.doesNotMatch(JSON.stringify(auth.status()), /ghp_example/);
    });
}

test("concurrent sign-in clicks share a preflight and one CLI process", async (context) => {
    const proc = fakeProcess();
    let launches = 0;
    let probes = 0;
    const auth = createGitHubAuth({ resolveCommand: () => "resolved-gh", executeImpl: async (command, args) => { probes++; assert.equal(command, "resolved-gh"); assert.ok(args.includes("user")); throw notSignedIn(); }, spawnImpl: (command, args, options) => { launches++; assert.equal(command, "resolved-gh"); assert.ok(args.includes("--web")); assert.equal(options.shell, undefined); return proc; } });
    context.after(() => auth.close());
    const first = auth.login();
    assert.equal(auth.login(), first);
    await first;
    await auth.login();
    assert.equal(probes, 1);
    assert.equal(launches, 1);
});

test("checking a pending flow reports that authentication is still needed instead of becoming a no-op", async (context) => {
    const proc = fakeProcess();
    let probes = 0;
    const auth = createGitHubAuth({ executeImpl: async () => { probes++; throw notSignedIn(); }, spawnImpl: () => proc });
    context.after(() => auth.close());
    await auth.login();
    proc.stderr.write("First copy your one-time code: ABCD-1234");
    const result = await auth.check();
    assert.equal(probes, 2);
    assert.equal(result.status, "signing-in");
    assert.equal(result.code, "ABCD-1234");
    assert.match(result.message, /No existing sign-in detected yet/);
});

test("cancelling a device sign-in clears its code and ignores late child output", async (context) => {
    const proc = fakeProcess();
    const auth = createGitHubAuth({ executeImpl: async () => { throw notSignedIn(); }, spawnImpl: () => proc });
    context.after(() => auth.close());
    await auth.login();
    proc.stderr.write("First copy your one-time code: ABCD-1234");
    assert.equal(auth.cancel().code, null);
    assert.equal(proc.killed, true);
    proc.stderr.write("First copy your one-time code: WXYZ-5678");
    proc.emit("close", 0);
    assert.equal(auth.status().status, "signed-out");
    assert.equal(auth.status().code, null);
});

test("cancelling during preflight prevents a late result from starting a login", async (context) => {
    let rejectProbe;
    let launches = 0;
    const auth = createGitHubAuth({ executeImpl: () => new Promise((_resolve, reject) => { rejectProbe = reject; }), spawnImpl: () => { launches++; return fakeProcess(); } });
    context.after(() => auth.close());
    const pending = auth.login();
    assert.equal(auth.status().status, "checking");
    auth.cancel();
    rejectProbe(notSignedIn());
    await pending;
    assert.equal(launches, 0);
    assert.equal(auth.status().status, "signed-out");
});

test("a login which never supplies a code times out with recovery instructions", async (context) => {
    const proc = fakeProcess();
    const auth = createGitHubAuth({ executeImpl: async () => { throw notSignedIn(); }, spawnImpl: () => proc, codeTimeoutMs: 15 });
    context.after(() => auth.close());
    await auth.login();
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(proc.killed, true);
    assert.equal(auth.status().status, "error");
    assert.equal(auth.status().code, null);
    assert.match(auth.status().message, /did not provide a device code/);
});

test("CLI completion verifies the active account instead of assuming success from its exit code", async (context) => {
    const proc = fakeProcess();
    let authenticated = false;
    const auth = createGitHubAuth({ executeImpl: async () => { if (!authenticated) throw notSignedIn(); return { stdout: "fixture-user\n" }; }, spawnImpl: () => proc });
    context.after(() => auth.close());
    await auth.login();
    proc.stderr.write("First copy your one-time code: ABCD-1234");
    authenticated = true;
    proc.emit("close", 0);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(auth.status().status, "signed-in");
    assert.equal(auth.status().login, "fixture-user");
    assert.equal(auth.status().code, null);
});

test("missing CLI and network failures do not launch a blind login or expose process errors", async (context) => {
    for (const [error, expected] of [[Object.assign(new Error("missing"), { code: "ENOENT" }), "missing"], [Object.assign(new Error("secret ghp_do_not_display"), { code: "ETIMEDOUT" }), "error"]]) {
        let launches = 0;
        const auth = createGitHubAuth({ executeImpl: async () => { throw error; }, spawnImpl: () => { launches++; return fakeProcess(); } });
        context.after(() => auth.close());
        assert.equal((await auth.login()).status, expected);
        assert.equal(launches, 0);
        assert.doesNotMatch(JSON.stringify(auth.status()), /ghp_do_not_display/);
    }
});

test("Windows finds a standard GitHub CLI installation when the app inherited a stale PATH", () => {
    const env = { Path: 'relative;"C:\\Tools"', ProgramFiles: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\fixture\\AppData\\Local" };
    const standard = "C:\\Program Files\\GitHub CLI\\gh.exe";
    assert.equal(resolveGitHubCli({ platform: "win32", env, fileExists: (file) => file === standard }), standard);
    const onPath = "C:\\Tools\\gh.exe";
    assert.equal(resolveGitHubCli({ platform: "win32", env, fileExists: (file) => [standard, onPath].includes(file) }), onPath);
    assert.equal(resolveGitHubCli({ platform: "win32", env: {}, fileExists: () => false }), "gh");
});
