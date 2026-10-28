// The Lounge: hosted, org-scoped presence server for Byte Buddy. JSON POST upstream, SSE downstream.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

const MAX_BODY = 16 * 1024;
const ORG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
const SLUG_PATTERN = /^[a-z0-9-]{1,40}$/;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const MOVES_PER_SEC = 15;

class LoungeError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

export function sanitizeBuddy(input) {
    const src = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    const pick = (value, pattern, fallback = null) =>
        typeof value === "string" && pattern.test(value) ? value : fallback;
    return {
        stage: Number.isInteger(src.stage) && src.stage >= 0 && src.stage <= 10 ? src.stage : 0,
        type: pick(src.type, /^[a-z]{1,20}$/, "robot"),
        variant: pick(src.variant, /^[a-z0-9-]{0,24}$/),
        body: pick(src.body, COLOR_PATTERN, "#3fb8af"),
        eye: pick(src.eye, COLOR_PATTERN, "#7cf8ff"),
        hat: pick(src.hat, SLUG_PATTERN),
        glasses: pick(src.glasses, SLUG_PATTERN),
        headphones: pick(src.headphones, SLUG_PATTERN),
        neck: pick(src.neck, SLUG_PATTERN),
        name: typeof src.name === "string" ? src.name.trim().slice(0, 24) : null,
    };
}

const clamp = (value, min, max) => {
    const n = typeof value === "number" ? value : NaN;
    if (!Number.isFinite(n)) return null;
    return Math.round(Math.min(max, Math.max(min, n)) * 10) / 10;
};
const randomIn = (min, max) => Math.round((min + Math.random() * (max - min)) * 10) / 10;
const publicMember = ({ id, login, buddy, x, y }) => ({ id, login, buddy, x, y });
const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export function createLoungeServer(options = {}) {
    const env = options.env ?? process.env;
    const port = options.port ?? Number(env.PORT ?? 8787);
    const host = options.host ?? env.HOST ?? "0.0.0.0";
    const githubApi = String(options.githubApi ?? env.LOUNGE_GITHUB_API ?? "https://api.github.com").replace(/\/+$/, "");
    const allowedOrgs = new Set((options.allowedOrgs ?? String(env.LOUNGE_ALLOWED_ORGS ?? "").split(","))
        .map((org) => String(org).trim().toLowerCase()).filter(Boolean));
    const staleMs = options.staleMs ?? Number(env.LOUNGE_STALE_MS ?? 45_000);
    const sessionTtlMs = options.sessionTtlMs ?? 10 * 60_000;
    const maxRoom = options.maxRoom ?? 50;
    const sweepMs = options.sweepMs ?? 5_000;
    const pingMs = options.pingMs ?? 15_000;
    const fetchImpl = options.fetch ?? globalThis.fetch;

    const sessions = new Map(); // session token -> { sessionId, userId, login, org, buddy, lastSeen }
    const rooms = new Map(); // org -> Map(userId -> member)
    const lastPositions = new Map(); // userId -> { org, x, y, at } so quick reconnects keep their spot
    let server;

    const broadcast = (org, event, data, exceptId) => {
        const payload = sse(event, data);
        for (const member of rooms.get(org)?.values() ?? []) {
            if (member.id !== exceptId) member.res.write(payload);
        }
    };

    function removeMember(org, id) {
        const room = rooms.get(org);
        const member = room?.get(id);
        if (!member) return;
        room.delete(id);
        if (!room.size) rooms.delete(org);
        lastPositions.set(id, { org, x: member.x, y: member.y, at: member.lastSeen });
        member.res.end();
        broadcast(org, "leave", { id });
    }

    function sweep() {
        const now = Date.now();
        for (const [org, room] of rooms) {
            for (const member of [...room.values()]) {
                if (now - member.lastSeen > staleMs) removeMember(org, member.id);
            }
        }
        for (const [id, pos] of lastPositions) if (now - pos.at > staleMs) lastPositions.delete(id);
        for (const [token, session] of sessions) {
            const live = rooms.get(session.org)?.get(session.userId)?.sessionId === token;
            if (!live && now - session.lastSeen > sessionTtlMs) sessions.delete(token);
        }
    }

    async function github(path, token) {
        try {
            return await fetchImpl(`${githubApi}${path}`, {
                headers: {
                    Accept: "application/vnd.github+json",
                    Authorization: `Bearer ${token}`,
                    "X-GitHub-Api-Version": "2022-11-28",
                    "User-Agent": "byte-buddy-lounge",
                },
            });
        } catch {
            throw new LoungeError(502, "github_unavailable", "Could not reach GitHub.");
        }
    }

    async function createSession(req, body) {
        const auth = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "");
        const org = typeof body.org === "string" ? body.org.trim().toLowerCase() : "";
        if (!ORG_PATTERN.test(org)) throw new LoungeError(400, "bad_org", "Invalid organization name.");
        if (allowedOrgs.size && !allowedOrgs.has(org)) {
            throw new LoungeError(403, "org_not_allowed", "This organization is not allowed on this lounge.");
        }
        if (!auth) throw new LoungeError(401, "bad_token", "Missing GitHub token.");
        const userRes = await github("/user", auth[1]);
        if (userRes.status !== 200) throw new LoungeError(401, "bad_token", "GitHub rejected the token.");
        const user = await userRes.json().catch(() => null);
        if (!Number.isInteger(user?.id) || typeof user.login !== "string") {
            throw new LoungeError(401, "bad_token", "GitHub returned an unexpected user.");
        }
        const memberRes = await github(`/user/memberships/orgs/${encodeURIComponent(org)}`, auth[1]);
        const membership = memberRes.status === 200 ? await memberRes.json().catch(() => null) : null;
        if (membership?.state !== "active") {
            throw new LoungeError(403, "not_member", "You are not an active member of this organization.");
        }
        const sessionId = randomBytes(32).toString("hex");
        sessions.set(sessionId, {
            sessionId, userId: user.id, login: user.login, org, buddy: sanitizeBuddy(body.buddy), lastSeen: Date.now(),
        });
        return { session: sessionId, self: { id: user.id, login: user.login }, org, staleMs };
    }

    function authSession(req, url, allowQuery = false) {
        const match = /^Session\s+(\S+)$/i.exec(req.headers.authorization ?? "");
        const token = match?.[1] ?? (allowQuery ? url.searchParams.get("s") : null);
        const session = token && sessions.get(token);
        if (!session) throw new LoungeError(401, "bad_session", "Unknown or expired session.");
        session.lastSeen = Date.now();
        return session;
    }

    function openStream(req, res, session) {
        const previous = rooms.get(session.org)?.get(session.userId);
        if (!previous && (rooms.get(session.org)?.size ?? 0) >= maxRoom) {
            throw new LoungeError(403, "room_full", "The lounge is full.");
        }
        if (!rooms.has(session.org)) rooms.set(session.org, new Map());
        const room = rooms.get(session.org);
        const now = Date.now();
        const recent = lastPositions.get(session.userId);
        const keep = previous ?? (recent?.org === session.org && now - recent.at <= staleMs ? recent : null);
        const member = {
            id: session.userId, login: session.login, buddy: session.buddy,
            x: keep ? keep.x : randomIn(20, 140), y: keep ? keep.y : randomIn(70, 108),
            lastSeen: now, sessionId: session.sessionId, res, moves: [],
        };
        lastPositions.delete(session.userId);
        room.set(member.id, member);

        res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
        });
        res.write(sse("snapshot", {
            self: { id: member.id, login: member.login }, org: session.org, members: [...room.values()].map(publicMember),
        }));
        if (previous) {
            // Replaced in place: the old stream's close handler sees a different res and broadcasts nothing.
            previous.res.end(sse("replaced", {}));
            broadcast(session.org, "update", publicMember(member), member.id);
        } else {
            broadcast(session.org, "join", publicMember(member), member.id);
        }
        const ping = setInterval(() => res.write(": ping\n\n"), pingMs);
        res.on("close", () => {
            clearInterval(ping);
            if (rooms.get(session.org)?.get(member.id)?.res === res) removeMember(session.org, member.id);
        });
    }

    function move(session, body) {
        const member = rooms.get(session.org)?.get(session.userId);
        if (!member) throw new LoungeError(409, "not_in_room", "Open the stream before moving.");
        const now = Date.now();
        member.moves = member.moves.filter((at) => now - at < 1000);
        if (member.moves.length >= MOVES_PER_SEC) throw new LoungeError(429, "rate_limited", "Too many moves.");
        const x = clamp(body.x, 8, 152);
        const y = clamp(body.y, 64, 112);
        if (x === null || y === null) throw new LoungeError(400, "bad_position", "x and y must be numbers.");
        member.moves.push(now);
        Object.assign(member, { x, y, lastSeen: now });
        broadcast(session.org, "move", { id: member.id, x, y });
        return { x, y };
    }

    function readBody(req) {
        return new Promise((resolve, reject) => {
            let size = 0;
            const chunks = [];
            req.on("data", (chunk) => {
                size += chunk.length;
                if (size <= MAX_BODY) return chunks.push(chunk);
                // Reply 413 and drop the connection afterwards instead of buffering the rest.
                req.removeAllListeners("data");
                req.resume();
                reject(new LoungeError(413, "too_large", "Request body too large."));
            });
            req.on("end", () => {
                const text = Buffer.concat(chunks).toString("utf8").trim();
                if (!text) return resolve({});
                try {
                    const parsed = JSON.parse(text);
                    resolve(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {});
                } catch {
                    reject(new LoungeError(400, "bad_json", "Request body must be JSON."));
                }
            });
            req.on("error", reject);
        });
    }

    function send(res, status, body) {
        if (res.headersSent) return res.end();
        res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify(body));
    }

    async function handle(req, res) {
        const url = new URL(req.url, "http://lounge.local");
        const route = `${req.method} ${url.pathname}`;
        if (route === "GET /healthz") {
            let members = 0;
            for (const room of rooms.values()) members += room.size;
            return send(res, 200, { ok: true, rooms: rooms.size, members });
        }
        if (route === "GET /v1/stream") return openStream(req, res, authSession(req, url, true));
        if (req.method !== "POST" || !url.pathname.startsWith("/v1/")) {
            throw new LoungeError(404, "not_found", "Not found.");
        }
        const body = await readBody(req);
        if (route === "POST /v1/session") return send(res, 200, { ok: true, ...(await createSession(req, body)) });
        const session = authSession(req, url);
        switch (url.pathname) {
            case "/v1/move":
                return send(res, 200, { ok: true, ...move(session, body) });
            case "/v1/heartbeat": {
                const member = rooms.get(session.org)?.get(session.userId);
                if (member) member.lastSeen = Date.now();
                return send(res, 200, { ok: true });
            }
            case "/v1/leave":
                removeMember(session.org, session.userId);
                lastPositions.delete(session.userId);
                sessions.delete(session.sessionId);
                return send(res, 200, { ok: true });
            default:
                throw new LoungeError(404, "not_found", "Not found.");
        }
    }

    const sweeper = setInterval(sweep, sweepMs);
    sweeper.unref();

    return {
        rooms,
        sessions,
        listen() {
            server = createServer((req, res) => {
                handle(req, res).catch((error) => {
                    const known = error instanceof LoungeError;
                    if (!known) console.error("lounge: unexpected error", error);
                    if (error.code === "too_large") res.setHeader("Connection", "close");
                    send(res, known ? error.status : 500, {
                        ok: false, code: known ? error.code : "internal", error: known ? error.message : "Internal error.",
                    });
                });
            });
            return new Promise((resolve, reject) => {
                server.once("error", reject);
                server.listen(port, host, () => resolve({ port: server.address().port }));
            });
        },
        close() {
            clearInterval(sweeper);
            for (const room of rooms.values()) for (const member of room.values()) member.res.end();
            rooms.clear();
            sessions.clear();
            lastPositions.clear();
            if (!server) return Promise.resolve();
            return new Promise((resolve) => {
                server.close(() => resolve());
                server.closeAllConnections?.();
            });
        },
    };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const lounge = createLoungeServer();
    const { port } = await lounge.listen();
    console.log(`lounge: listening on port ${port}`);
    const shutdown = (signal) => {
        console.log(`lounge: ${signal} received, shutting down`);
        lounge.close().then(() => process.exit(0));
    };
    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));
}
