// Single loopback HTTP server shared by every open Byte Buddy panel: static UI, JSON API, and SSE push.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BuddyError } from "./store.mjs";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "public");
const STATIC = {
    "/static/app.css": "text/css; charset=utf-8",
    "/static/app.js": "text/javascript; charset=utf-8",
    "/static/art.js": "text/javascript; charset=utf-8",
    "/static/pet-motion.js": "text/javascript; charset=utf-8",
};
const INSTANCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_BODY = 64 * 1024;

export function createBuddyServer({ store, sync, github, updater }) {
    const token = randomBytes(24).toString("hex");
    const clients = new Set();
    let server;
    let port;
    let pendingChange = null;

    const broadcast = (event, data) => {
        const payload = `event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`;
        for (const res of clients) res.write(payload);
    };
    // Same-turn mutations need one state refetch; animation events remain independent.
    const onChange = () => {
        if (pendingChange) return;
        pendingChange = setImmediate(() => {
            pendingChange = null;
            broadcast("change");
        });
    };
    const onFx = (fx) => broadcast("fx", fx);
    store.events.on("change", onChange);
    store.events.on("fx", onFx);

    const keepAlive = setInterval(() => {
        for (const res of clients) res.write(": ping\n\n");
    }, 25_000);
    keepAlive.unref();

    function send(res, status, body) {
        res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify(body));
    }

    function readBody(req) {
        return new Promise((resolve, reject) => {
            let size = 0;
            const chunks = [];
            req.on("data", (chunk) => {
                size += chunk.length;
                if (size > MAX_BODY) {
                    reject(new BuddyError("too_large", "Request body too large."));
                    req.destroy();
                    return;
                }
                chunks.push(chunk);
            });
            req.on("end", () => {
                try {
                    resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
                } catch {
                    reject(new BuddyError("invalid_json", "Invalid JSON body."));
                }
            });
            req.on("error", reject);
        });
    }

    function renderIndex(instanceId) {
        const config = JSON.stringify({ token, instanceId }).replace(/</g, "\\u003c");
        return readFileSync(join(PUBLIC_DIR, "index.html"), "utf8").replace("/*__BUDDY_CONFIG__*/null", config);
    }

    const POST_ROUTES = {
        "/api/update/install": () => updater.install(),
        "/api/github/sync": () => github.requestRefresh(),
        "/api/github/settings": (body) => store.setGitHubSettings(body),
        "/api/interact": (body) => store.interact(String(body.action), "ui"),
        "/api/rename": (body) => store.rename(body.name),
        "/api/evolution": (body) => store.evolve(body),
        "/api/equip": (body) => store.equip(String(body.itemId), { enabled: typeof body.enabled === "boolean" ? body.enabled : undefined }),
        "/api/unequip": (body) => store.unequip(String(body.slot)),
        "/api/prefs": (body) => store.setPrefs(body || {}),
        "/api/mode": (body) => store.setMode(String(body.mode)),
        "/api/demo/ticket": (body) => store.simulateDemoTicket(String(body.kind || "normal"), Number(body.count) || 1),
        "/api/demo/reset": () => store.resetDemo(),
        "/api/ack": (body) => store.ackCelebrations(Array.isArray(body.ids) ? body.ids.map(String) : []),
        "/api/sync": async (body) => {
            const instance = INSTANCE_PATTERN.test(String(body.instance || "")) ? body.instance : null;
            const outcome = await sync.refresh(instance);
            return outcome.method === "direct" ? { method: "direct", summary: outcome.result } : outcome;
        },
    };

    async function handle(req, res) {
        if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(req.headers.host || "")) return send(res, 403, { error: "Forbidden host." });
        const url = new URL(req.url, `http://127.0.0.1:${port}`);
        const path = url.pathname;

        if (req.method === "GET" && path.startsWith("/i/")) {
            const instanceId = decodeURIComponent(path.slice(3));
            if (!INSTANCE_PATTERN.test(instanceId)) return send(res, 400, { error: "Invalid instance." });
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
            return res.end(renderIndex(instanceId));
        }
        if (req.method === "GET" && STATIC[path]) {
            res.writeHead(200, { "Content-Type": STATIC[path], "Cache-Control": "no-store" });
            return res.end(readFileSync(join(PUBLIC_DIR, path.slice("/static/".length)), "utf8"));
        }
        if (!path.startsWith("/api/")) return send(res, 404, { error: "Not found." });
        if ((req.headers["x-buddy-token"] || url.searchParams.get("t")) !== token) return send(res, 401, { error: "Unauthorized." });

        if (req.method === "GET" && path === "/api/state") return send(res, 200, store.view({ summary: true }));
        if (req.method === "GET" && path === "/api/analytics") {
            try {
                const integer = (name, fallback) => {
                    const value = url.searchParams.get(name);
                    if (value === null) return fallback;
                    return /^\d+$/.test(value) ? Number(value) : NaN;
                };
                return send(res, 200, store.analytics({ source: url.searchParams.get("source"), range: url.searchParams.get("range") || "all",
                    offset: integer("offset", 0), limit: integer("limit", 180), revision: url.searchParams.get("revision") }));
            } catch (error) { return send(res, error.code === "analytics_changed" ? 409 : 400, { code: error.code, error: error.message }); }
        }
        if (req.method === "GET" && path === "/api/update" && updater) {
            const { tarball, ...info } = await updater.check({ force: url.searchParams.get("force") === "1" });
            return send(res, 200, info);
        }
        if (req.method === "GET" && path === "/api/export") return send(res, 200, store.exportState());
        if (req.method === "GET" && path === "/api/events") {
            res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
            res.write("retry: 2000\n\n");
            clients.add(res);
            req.on("close", () => clients.delete(res));
            return;
        }
        const route = req.method === "POST" ? POST_ROUTES[path] : null;
        if (!route) return send(res, 404, { error: "Not found." });
        try {
            const result = await route(await readBody(req));
            return send(res, 200, { ok: true, result: result ?? null });
        } catch (error) {
            const known = error instanceof BuddyError || error.code === "ticket_source_unavailable";
            return send(res, known ? 400 : 500, { ok: false, code: error.code || "error", error: error.message });
        }
    }

    return {
        async urlFor(instanceId) {
            if (!server) {
                server = createServer((req, res) => {
                    handle(req, res).catch((error) => {
                        if (!res.headersSent) send(res, 500, { error: error.message });
                        else res.end();
                    });
                });
                await new Promise((resolve, reject) => {
                    server.once("error", reject);
                    server.listen(0, "127.0.0.1", resolve);
                });
                port = server.address().port;
            }
            return `http://127.0.0.1:${port}/i/${encodeURIComponent(instanceId)}`;
        },
        broadcast,
        async close() {
            clearInterval(keepAlive);
            if (pendingChange) clearImmediate(pendingChange);
            pendingChange = null;
            store.events.off("change", onChange);
            store.events.off("fx", onFx);
            for (const client of clients) client.end();
            clients.clear();
            if (server) await new Promise((resolve) => server.close(resolve));
        },
    };
}
