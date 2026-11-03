import { spawn, execFile } from "node:child_process";
import { promisify, stripVTControlCharacters } from "node:util";
import { resolveGitHubCli } from "./github-cli.mjs";

const execute = promisify(execFile);

export function createGitHubAuth({ spawnImpl = spawn, executeImpl = execute, resolveCommand = resolveGitHubCli, timeoutMs = 10 * 60_000, codeTimeoutMs = 45_000 } = {}) {
    let child = null;
    let pendingLogin = null;
    let generation = 0;
    let state = { status: "unchecked", code: null, message: "Check your existing GitHub CLI sign-in, or sign in with your browser. Already signed in with gh? No new device code is needed." };
    const status = () => ({ ...state });
    const environment = () => ({ ...process.env, NO_COLOR: "1", CLICOLOR: "0", GH_NO_UPDATE_NOTIFIER: "1", GH_PROMPT_DISABLED: "1" });

    async function probe() {
        try {
            const result = await executeImpl(resolveCommand(), ["api", "--hostname", "github.com", "--method", "GET", "user", "--jq", ".login"], { windowsHide: true, timeout: 20_000, maxBuffer: 128 * 1024, encoding: "utf8", env: environment() });
            const login = String(result.stdout || "").trim();
            if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i.test(login)) throw new Error("Invalid active GitHub account");
            return { status: "signed-in", login, code: null, message: `Signed in to GitHub as ${login}. Choose organizations/repositories, then manually sync GitHub. No new device sign-in is needed.` };
        } catch (error) {
            if (error.code === "ENOENT") return { status: "missing", code: null, message: "GitHub CLI was not found. Install it and try Check existing sign-in again; restart Byte Buddy if it was installed in a custom location." };
            const details = String(error.stderr || error.message || "");
            if (/HTTP 401|not (?:logged|signed) in|(?:run|execute)[^\n]*gh auth login|authentication required|bad credentials/i.test(details)) return { status: "signed-out", code: null, message: "No valid github.com sign-in was found for this Windows user. Sign in here, or run gh auth login --hostname github.com in your terminal and then Check existing sign-in." };
            return { status: "error", code: null, message: "Could not verify your active GitHub account. Check network/proxy/SSO access and gh api --hostname github.com user in your terminal, then try again. No credentials were changed." };
        }
    }

    function stopFlow(kill = true) {
        const flow = child;
        child = null;
        if (!flow) return;
        clearTimeout(flow.codeTimer);
        clearTimeout(flow.expiryTimer);
        if (kill) { try { flow.proc.kill(); } catch {} }
    }

    async function check() {
        const revision = generation;
        const result = await probe();
        if (revision !== generation) return status();
        if (result.status === "signed-in") {
            generation++;
            pendingLogin = null;
            stopFlow();
            state = result;
        } else if (child) {
            state = { ...state, message: result.status !== "signed-out" ? result.message : state.code ? "No existing sign-in detected yet. Complete the displayed device code on GitHub, or cancel this attempt." : "No existing sign-in detected yet. Waiting for GitHub to issue a code; you can cancel and sign in from your terminal instead." };
        } else if (!pendingLogin) state = result;
        return status();
    }

    function startFlow(revision) {
        state = { status: "signing-in", code: null, message: "Requesting a one-time code from GitHub. The device sign-in button appears once a code is ready." };
        try {
            const proc = spawnImpl(resolveCommand(), ["auth", "login", "--hostname", "github.com", "--web", "--git-protocol", "https", "--skip-ssh-key"], { windowsHide: true, env: environment(), stdio: ["pipe", "pipe", "pipe"] });
            const flow = { proc, revision, stdout: "", stderr: "", codeTimer: null, expiryTimer: null };
            child = flow;
            const finish = (next, kill = true) => {
                if (child !== flow || generation !== revision) return;
                stopFlow(kill);
                generation++;
                state = next;
            };
            const read = (stream, chunk) => {
                if (child !== flow || generation !== revision) return;
                flow[stream] = (flow[stream] + chunk.toString()).slice(-8192);
                const output = stripVTControlCharacters(flow[stream]);
                const code = /one[ -]time code\s*(?::\s*|\(\s*)([A-Z0-9]{4}-[A-Z0-9]{4})\b/i.exec(output)?.[1];
                if (code) {
                    clearTimeout(flow.codeTimer);
                    state = { status: "signing-in", code, message: "Enter this one-time code on GitHub's device sign-in page. Never enter it on another site." };
                }
            };
            flow.codeTimer = setTimeout(() => finish({ status: "error", code: null, message: "GitHub CLI did not provide a device code in time. Run gh auth login --hostname github.com in your terminal, then use Check existing sign-in. You can also retry here." }), codeTimeoutMs);
            flow.expiryTimer = setTimeout(() => finish({ status: "signed-out", code: null, message: "GitHub device sign-in expired. Retry, or sign in with gh in your terminal and check again." }), timeoutMs);
            flow.codeTimer.unref?.();
            flow.expiryTimer.unref?.();
            proc.stdout.on("data", (chunk) => read("stdout", chunk));
            proc.stderr.on("data", (chunk) => read("stderr", chunk));
            proc.on("error", (error) => finish({ status: error.code === "ENOENT" ? "missing" : "error", code: null, message: error.code === "ENOENT" ? "GitHub CLI was not found. Install it, then check your sign-in again." : "GitHub CLI could not start. Check your installation and try signing in from your terminal." }));
            proc.on("close", (code) => {
                if (child !== flow || generation !== revision) return;
                if (code !== 0) return finish({ status: "error", code: null, message: /GH_TOKEN|GITHUB_TOKEN/.test(flow.stderr) ? "An environment token is overriding GitHub CLI authentication. Update that environment setting in your terminal, then check the existing sign-in again." : "Sign-in did not complete. Run gh auth login --hostname github.com in your terminal for details, then Check existing sign-in. Your existing credentials were not removed." }, false);
                stopFlow(false);
                const verification = ++generation;
                state = { status: "checking", code: null, message: "Verifying the signed-in GitHub account…" };
                void probe().then((result) => { if (generation === verification) state = result; });
            });
            proc.stdin.on("error", () => {});
            proc.stdin.end();
        } catch {
            stopFlow();
            state = { status: "error", code: null, message: "Could not start GitHub CLI. Check its installation and retry." };
        }
    }

    function login() {
        if (pendingLogin) return pendingLogin.promise;
        if (child) return Promise.resolve(status());
        const pending = { revision: ++generation, promise: null };
        pendingLogin = pending;
        state = { status: "checking", code: null, message: "Checking for an existing GitHub sign-in before starting a device login…" };
        pending.promise = (async () => {
            const existing = await probe();
            if (generation !== pending.revision) return status();
            if (existing.status === "signed-out") startFlow(pending.revision);
            else state = existing;
            return status();
        })().finally(() => { if (pendingLogin === pending) pendingLogin = null; });
        return pending.promise;
    }

    function cancel() {
        generation++;
        pendingLogin = null;
        stopFlow();
        state = { status: "signed-out", code: null, message: "Sign-in cancelled. Your stored GitHub credentials were not removed. You can check an existing sign-in or try again." };
        return status();
    }
    function close() {
        generation++;
        pendingLogin = null;
        stopFlow();
    }
    return { status, check, login, cancel, close };
}
