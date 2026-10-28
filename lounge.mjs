// The Lounge client: joins a shared org room on a hosted lounge server (JSON POST up, SSE down).
// The GitHub token is only sent once to create a session; it is never logged or stored.
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { BuddyError } from "./store.mjs";

const ORG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MOVE_INTERVAL_MS = 100;
const REQUEST_TIMEOUT_MS = 10_000;

const clamp = (value, min, max) => Math.round(Math.min(max, Math.max(min, value)) * 10) / 10;
const pick = (value, pattern) => (typeof value === "string" && pattern.test(value) ? value : null);

export function sanitizeBuddy(raw) {
    const buddy = raw && typeof raw === "object" ? raw : {};
    return {
        stage: Number.isInteger(buddy.stage) && buddy.stage >= 0 && buddy.stage <= 10 ? buddy.stage : 0,
        type: pick(buddy.type, /^[a-z]{1,20}$/) ?? "robot",
        variant: pick(buddy.variant, /^[a-z0-9-]{0,24}$/),
        body: pick(buddy.body, /^#[0-9a-fA-F]{6}$/) ?? "#3fb8af",
        eye: pick(buddy.eye, /^#[0-9a-fA-F]{6}$/) ?? "#7cf8ff",
        hat: pick(buddy.hat, /^[a-z0-9-]{1,40}$/),
        glasses: pick(buddy.glasses, /^[a-z0-9-]{1,40}$/),
        headphones: pick(buddy.headphones, /^[a-z0-9-]{1,40}$/),
        neck: pick(buddy.neck, /^[a-z0-9-]{1,40}$/),
        name: typeof buddy.name === "string" ? buddy.name.trim().slice(0, 24) : null,
    };
}

export function validateLoungeUrl(value) {
    let url;
    try {
        url = new URL(String(value).trim());
    } catch {
        throw new BuddyError("invalid_url", "Lounge server URL is not a valid URL.");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new BuddyError("invalid_url", "Lounge server URL must use https.");
    if (url.protocol === "http:" && !LOCAL_HOSTS.has(url.hostname)) throw new BuddyError("insecure_url", "Lounge server URL must use https (http is only allowed for localhost).");
    if (url.username || url.password) throw new BuddyError("invalid_url", "Lounge server URL must not contain credentials.");
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

class LoungeHttpError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

export function createLoungeClient({ configPath, getGitHubToken, fetch = globalThis.fetch, env = process.env,
    heartbeatMs = 15000, backoff = [1000, 2000, 5000, 10000, 20000], idleTimeoutMs = 45000 }) {
    const events = new EventEmitter();
    let config = readConfig();
    let status = "idle";
    let org = null;
    let buddy = null;
    let self = null;
    let error = null;
    let session = null;
    let baseUrl = null;
    let members = new Map();
    let gen = 0;
    let stream = null;
    let heartbeat = null;
    let retryTimer = null;
    let move = { pending: null, timer: null, last: 0 };
    let ready = null;
    let closed = false;

    function readConfig() {
        try {
            const parsed = JSON.parse(readFileSync(configPath, "utf8"));
            return { url: typeof parsed?.url === "string" ? parsed.url : "" };
        } catch {
            return { url: "" };
        }
    }

    function source() {
        const fromEnv = typeof env.BYTE_BUDDY_LOUNGE_URL === "string" ? env.BYTE_BUDDY_LOUNGE_URL.trim() : "";
        if (fromEnv) return { url: fromEnv, source: "env" };
        return config.url ? { url: config.url, source: "config" } : { url: null, source: null };
    }

    const changed = () => events.emit("change");
    const unref = (timer) => (timer?.unref?.(), timer);

    function state() {
        const { url, source: urlSource } = source();
        return {
            status, serverUrl: url, serverUrlSource: urlSource, org, self: self ? { ...self } : null,
            members: [...members.values()].map((member) => ({ ...member })).sort((a, b) => a.login.localeCompare(b.login)),
            error: error ? { ...error } : null,
        };
    }

    async function request(method, path, { body, auth, signal } = {}) {
        let res;
        try {
            res = await fetch(`${baseUrl}${path}`, {
                method, signal: signal || AbortSignal.timeout(REQUEST_TIMEOUT_MS),
                headers: { Authorization: auth, "Content-Type": "application/json", Accept: "application/json" },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
        } catch (cause) {
            throw new LoungeHttpError(0, "unreachable", `Lounge server is unreachable${cause?.name === "TimeoutError" ? " (timed out)" : ""}.`);
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.ok === false) throw new LoungeHttpError(res.status, data.code || `http_${res.status}`, data.error || `Lounge server returned ${res.status}.`);
        return data;
    }

    function stopTimers() {
        clearInterval(heartbeat);
        clearTimeout(retryTimer);
        clearTimeout(move.timer);
        heartbeat = retryTimer = null;
        move = { pending: null, timer: null, last: move.last };
    }

    function abortStream() {
        stream?.abort();
        stream = null;
    }

    function settleReady() {
        ready?.();
        ready = null;
    }

    function fail(err, { keepSession = false } = {}) {
        gen++;
        stopTimers();
        abortStream();
        if (!keepSession) session = null;
        status = "error";
        error = { code: err.code || "error", message: err.message || String(err) };
        members = new Map();
        settleReady();
        changed();
    }

    async function createSession(g) {
        let token;
        try {
            token = String((await getGitHubToken()) || "").trim();
        } catch {
            token = "";
        }
        if (g !== gen) return;
        if (!token) throw new LoungeHttpError(401, "no_token", "GitHub CLI is not signed in; run `gh auth login`.");
        const data = await request("POST", "/v1/session", { auth: `Bearer ${token}`, body: { org, buddy } });
        token = null;
        if (g !== gen) return;
        session = data.session;
        self = data.self ? { id: data.self.id, login: data.self.login } : self;
    }

    function applyEvent(name, data) {
        if (name === "snapshot") {
            members = new Map();
            for (const member of Array.isArray(data.members) ? data.members : []) members.set(member.id, member);
            if (data.self) self = { id: data.self.id, login: data.self.login };
            status = "connected";
            error = null;
            if (!heartbeat) heartbeat = unref(setInterval(sendHeartbeat, heartbeatMs));
            settleReady();
        } else if (name === "join" || name === "update") {
            if (data?.id === undefined) return;
            members.set(data.id, data);
        } else if (name === "move") {
            const member = members.get(data?.id);
            if (!member) return;
            members.set(data.id, { ...member, x: data.x, y: data.y });
        } else if (name === "leave") {
            if (!members.delete(data?.id)) return;
        } else if (name === "replaced") {
            return fail({ code: "replaced", message: "Joined from another window" });
        } else return;
        changed();
    }

    async function streamOnce(g) {
        const controller = new AbortController();
        stream = controller;
        let watchdog;
        const kick = () => {
            clearTimeout(watchdog);
            watchdog = unref(setTimeout(() => controller.abort(), idleTimeoutMs));
        };
        try {
            kick();
            let res;
            try {
                res = await fetch(`${baseUrl}/v1/stream`, { headers: { Authorization: `Session ${session}`, Accept: "text/event-stream" }, signal: controller.signal });
            } catch {
                throw new LoungeHttpError(0, "unreachable", "Lounge server is unreachable.");
            }
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new LoungeHttpError(res.status, data.code || `http_${res.status}`, data.error || `Lounge stream returned ${res.status}.`);
            }
            const decoder = new TextDecoder();
            let buffer = "";
            try {
                for await (const chunk of res.body) {
                    if (g !== gen) return;
                    kick();
                    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n?/g, "\n");
                    let split;
                    while ((split = buffer.indexOf("\n\n")) !== -1) {
                        const block = buffer.slice(0, split);
                        buffer = buffer.slice(split + 2);
                        let name = "message";
                        const lines = [];
                        for (const line of block.split("\n")) {
                            if (!line || line.startsWith(":")) continue;
                            const colon = line.indexOf(":");
                            const field = colon === -1 ? line : line.slice(0, colon);
                            const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
                            if (field === "event") name = value;
                            else if (field === "data") lines.push(value);
                        }
                        if (!lines.length) continue;
                        let data;
                        try {
                            data = JSON.parse(lines.join("\n"));
                        } catch {
                            continue;
                        }
                        applyEvent(name, data);
                        if (g !== gen) return;
                    }
                }
            } catch {
                // Aborted or dropped connection: the reconnect loop decides what happens next.
            }
        } finally {
            clearTimeout(watchdog);
            if (stream === controller) stream = null;
        }
    }

    async function connectLoop(g) {
        let attempt = 0;
        while (g === gen) {
            let streaming = false;
            try {
                if (!session) await createSession(g);
                if (g !== gen) return;
                streaming = true;
                await streamOnce(g);
                if (status === "connected") attempt = 0;
            } catch (err) {
                if (g !== gen) return;
                if (err.status === 401 && streaming) session = null;
                else if (err.status === 401 || err.status === 403) return fail(err);
            }
            if (g !== gen) return;
            clearInterval(heartbeat);
            heartbeat = null;
            status = "reconnecting";
            members = new Map();
            settleReady();
            changed();
            const delay = backoff[Math.min(attempt++, backoff.length - 1)] ?? 1000;
            await new Promise((resolve) => (retryTimer = unref(setTimeout(resolve, delay))));
            retryTimer = null;
        }
    }

    function sessionLost() {
        session = null;
        abortStream();
    }

    async function sendHeartbeat() {
        if (status !== "connected" || !session) return;
        try {
            await request("POST", "/v1/heartbeat", { auth: `Session ${session}` });
        } catch (err) {
            if (err.status === 401) sessionLost();
        }
    }

    async function flushMove() {
        move.timer = null;
        const next = move.pending;
        move.pending = null;
        if (!next || status !== "connected" || !session) return;
        move.last = Date.now();
        try {
            await request("POST", "/v1/move", { auth: `Session ${session}`, body: next });
        } catch (err) {
            if (err.status === 401) sessionLost();
        }
    }

    async function leave() {
        gen++;
        stopTimers();
        abortStream();
        settleReady();
        const old = session;
        session = null;
        if (old && baseUrl) await request("POST", "/v1/leave", { auth: `Session ${old}`, signal: AbortSignal.timeout(3000) }).catch(() => {});
        const wasIdle = status === "idle" && !org && !error;
        status = "idle";
        org = self = error = buddy = null;
        members = new Map();
        if (!wasIdle) changed();
        return state();
    }

    async function join({ org: rawOrg, buddy: rawBuddy } = {}) {
        if (closed) throw new BuddyError("closed", "The lounge client is closed.");
        const nextOrg = typeof rawOrg === "string" ? rawOrg.trim().toLowerCase() : "";
        if (!nextOrg) throw new BuddyError("no_org", "Choose an organization to join.");
        if (!ORG_PATTERN.test(nextOrg)) throw new BuddyError("invalid_org", "Organization name is not valid.");
        const { url } = source();
        if (!url) throw new BuddyError("no_server", "Set a Lounge server URL first.");
        const nextUrl = validateLoungeUrl(url);
        const active = ["connecting", "connected", "reconnecting"].includes(status);
        if (active && org === nextOrg && baseUrl === nextUrl) return state();
        if (active || session) await leave();

        const g = ++gen;
        baseUrl = nextUrl;
        org = nextOrg;
        buddy = sanitizeBuddy(rawBuddy);
        status = "connecting";
        error = null;
        self = null;
        members = new Map();
        changed();
        try {
            await createSession(g);
        } catch (err) {
            if (g === gen) fail(err);
            throw new BuddyError(err.code || "lounge_error", err.message);
        }
        if (g !== gen) return state();
        const first = new Promise((resolve) => (ready = resolve));
        connectLoop(g);
        await Promise.race([first, new Promise((resolve) => unref(setTimeout(resolve, REQUEST_TIMEOUT_MS)))]);
        return state();
    }

    function moveTo({ x, y } = {}) {
        if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) throw new BuddyError("invalid_move", "Move needs numeric x and y.");
        if (status !== "connected") return state();
        move.pending = { x: clamp(Number(x), 0, 3160), y: clamp(Number(y), 0, 1280) };
        if (!move.timer) move.timer = unref(setTimeout(flushMove, Math.max(0, move.last + MOVE_INTERVAL_MS - Date.now())));
        return state();
    }

    async function setServerUrl(url) {
        if (source().source === "env") throw new BuddyError("env_override", "The Lounge server URL is set by BYTE_BUDDY_LOUNGE_URL.");
        const raw = typeof url === "string" ? url.trim() : "";
        const next = raw ? validateLoungeUrl(raw) : "";
        if (next === config.url) return state();
        if (status !== "idle" || session) await leave();
        mkdirSync(dirname(configPath), { recursive: true });
        writeFileSync(configPath, `${JSON.stringify({ url: next }, null, 2)}\n`);
        config = { url: next };
        changed();
        return state();
    }

    return {
        events, state, join, leave, setServerUrl, move: moveTo,
        async close() {
            closed = true;
            await leave();
            events.removeAllListeners();
        },
    };
}
