export const SINGLETON_NAME = "byte-buddy-lounge";
export const CONTAINER_PORT = 8787;

const ORG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
const ROUTES = new Set([
    "GET /healthz",
    "GET /v1/stream",
    "POST /v1/session",
    "POST /v1/move",
    "POST /v1/chat",
    "POST /v1/heartbeat",
    "POST /v1/leave",
    "POST /v1/voice",
]);

export function allowedOrganizations(value) {
    if (typeof value !== "string" || !value.trim()) {
        throw new Error("Set LOUNGE_ALLOWED_ORGS to an explicit comma-separated GitHub organization allowlist.");
    }
    const organizations = value.split(",").map((organization) => organization.trim().toLowerCase());
    if (organizations.some((organization) => !ORG_PATTERN.test(organization))) {
        throw new Error("LOUNGE_ALLOWED_ORGS must contain only GitHub organization names, without empty entries or wildcards.");
    }
    return [...new Set(organizations)].join(",");
}

export function containerEnvironment(env) {
    return {
        NODE_ENV: "production",
        HOST: "0.0.0.0",
        PORT: String(CONTAINER_PORT),
        LOUNGE_ALLOWED_ORGS: allowedOrganizations(env.LOUNGE_ALLOWED_ORGS),
        LOUNGE_GITHUB_API: "https://api.github.com",
        ...Object.fromEntries(["CF_REALTIME_APP_ID", "CF_REALTIME_APP_SECRET", "CF_TURN_KEY_ID", "CF_TURN_API_TOKEN"]
            .filter((key) => typeof env[key] === "string" && env[key].trim()).map((key) => [key, env[key]])),
    };
}

function failure(status, code, error) {
    return Response.json({ ok: false, code, error }, {
        status,
        headers: { "Cache-Control": "no-store" },
    });
}

export async function fetchLounge(request, env) {
    try {
        allowedOrganizations(env.LOUNGE_ALLOWED_ORGS);
    } catch {
        return failure(503, "not_configured", "The lounge organization allowlist is not configured.");
    }
    const route = `${request.method} ${new URL(request.url).pathname}`;
    if (!ROUTES.has(route)) return failure(404, "not_found", "Not found.");
    try {
        const identifier = env.LOUNGE.idFromName(SINGLETON_NAME);
        return await env.LOUNGE.get(identifier).fetch(request);
    } catch {
        console.error("lounge: container unavailable");
        return failure(503, "unavailable", "The lounge is temporarily unavailable. Reconnect shortly.");
    }
}
