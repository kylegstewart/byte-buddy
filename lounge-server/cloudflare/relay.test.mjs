import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createLoungeServer } from "../server.mjs";
import { allowedOrganizations, CONTAINER_PORT, containerEnvironment, fetchLounge, SINGLETON_NAME } from "./relay.mjs";

function namespaceFor(fetchImpl) {
    const names = [];
    const identifiers = [];
    const stub = { fetch: fetchImpl };
    const namespace = {
        idFromName(name) {
            names.push(name);
            return `id:${name}`;
        },
        get(identifier) {
            identifiers.push(identifier);
            return stub;
        },
    };
    return { env: { LOUNGE_ALLOWED_ORGS: "org-a,org-b", LOUNGE: namespace }, names, identifiers };
}

test("deployment allowlist is mandatory, strict, normalized, and deduplicated", () => {
    for (const value of [undefined, null, [], "", " ", "*", "org-a,", ",org-a", "org-a,,org-b", "org_a", "https://github.com/org-a", "-org", "a".repeat(40)]) {
        assert.throws(() => allowedOrganizations(value), /LOUNGE_ALLOWED_ORGS/);
    }
    assert.equal(allowedOrganizations(" Org-A, org-b,ORG-A "), "org-a,org-b");
    assert.equal(allowedOrganizations("a"), "a");
});

test("only approved environment values reach the relay; GitHub and the port cannot be overridden", () => {
    assert.equal(CONTAINER_PORT, 8787);
    assert.deepEqual(containerEnvironment({
        LOUNGE_ALLOWED_ORGS: "ORG-A",
        LOUNGE_GITHUB_API: "https://attacker.invalid",
        PORT: "9000",
        HOST: "127.0.0.1",
        GITHUB_TOKEN: "never-forward-this",
        TICKET_MCP_TOKEN: "never-forward-this-either",
    }), {
        NODE_ENV: "production", HOST: "0.0.0.0", PORT: "8787",
        LOUNGE_ALLOWED_ORGS: "org-a", LOUNGE_GITHUB_API: "https://api.github.com",
    });
    assert.throws(() => containerEnvironment({}), /LOUNGE_ALLOWED_ORGS/);
});

test("all routes, users, organizations, hosts, and credentials address the same named object", async () => {
    const forwarded = [];
    const fixture = namespaceFor(async (request) => {
        forwarded.push(request);
        return Response.json({ ok: true });
    });
    const routes = [
        ["GET", "/healthz"], ["GET", "/v1/stream?s=opaque-session"],
        ["POST", "/v1/session"], ["POST", "/v1/move"],
        ["POST", "/v1/heartbeat"], ["POST", "/v1/leave"],
        ["POST", "/v1/voice"],
    ];
    for (const organization of ["org-a", "org-b"]) {
        for (const [method, path] of routes) {
            const request = new Request(`https://${organization}.example${path}`, {
                method,
                headers: { Authorization: `Session ${organization}`, "cf-container-target-port": "9000" },
                ...(method === "POST" ? { body: JSON.stringify({ org: organization }) } : {}),
            });
            assert.equal((await fetchLounge(request, fixture.env)).status, 200);
            assert.equal(forwarded.at(-1), request);
            assert.equal(request.bodyUsed, false);
        }
    }
    assert.equal(fixture.names.length, 14);
    assert.deepEqual([...new Set(fixture.names)], [SINGLETON_NAME]);
    assert.deepEqual([...new Set(fixture.identifiers)], [`id:${SINGLETON_NAME}`]);
});

test("voice configuration forwards exactly four optional named values and never arbitrary secrets", () => {
    const secrets = { CF_REALTIME_APP_ID: "app", CF_REALTIME_APP_SECRET: "secret",
        CF_TURN_KEY_ID: "key", CF_TURN_API_TOKEN: "token" };
    const baseline = containerEnvironment({ LOUNGE_ALLOWED_ORGS: "org-a" });
    assert.deepEqual(containerEnvironment({ LOUNGE_ALLOWED_ORGS: "org-a", ...secrets,
        CF_ACCOUNT_TOKEN: "never", CF_REALTIME_HOST: "https://attacker.invalid", GITHUB_TOKEN: "never" }),
    { ...baseline, ...secrets });
    assert.deepEqual(containerEnvironment({ LOUNGE_ALLOWED_ORGS: "org-a", CF_REALTIME_APP_SECRET: " ",
        CF_TURN_KEY_ID: null, CF_TURN_API_TOKEN: 1 }), baseline);
});

test("unconfigured deployments and unknown routes never contact a container", async () => {
    const fixture = namespaceFor(() => assert.fail("must not forward"));
    for (const value of [undefined, "", "*", "org-a,"]) {
        const response = await fetchLounge(new Request("https://lounge.example/healthz"), {
            ...fixture.env, LOUNGE_ALLOWED_ORGS: value,
        });
        assert.equal(response.status, 503);
        assert.equal((await response.json()).code, "not_configured");
    }
    for (const [method, path] of [["GET", "/"], ["GET", "/proxy?url=https://attacker.invalid"], ["POST", "/v1/admin"], ["GET", "/v1/session"], ["OPTIONS", "/v1/session"]]) {
        assert.equal((await fetchLounge(new Request(`https://lounge.example${path}`, { method }), fixture.env)).status, 404);
    }
    assert.equal(fixture.names.length, 0);
});

test("SSE responses pass through immediately without reading, buffering, or replacing their body", async () => {
    let producer;
    let cancelled = false;
    const body = new ReadableStream({
        start(controller) { producer = controller; },
        cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const upstream = new Response(body, { headers: {
        "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform",
    } });
    const fixture = namespaceFor(async () => upstream);
    const downstream = await fetchLounge(new Request("https://lounge.example/v1/stream?s=session"), fixture.env);
    assert.equal(downstream, upstream);
    assert.equal(downstream.bodyUsed, false);
    assert.equal(body.locked, false);
    const reader = downstream.body.getReader();
    const firstChunk = reader.read();
    producer.enqueue(new TextEncoder().encode("event: snapshot\ndata: {}\n\n"));
    assert.match(new TextDecoder().decode((await firstChunk).value), /event: snapshot/);
    await reader.cancel();
    assert.equal(cancelled, true);
});

test("container failures return a sanitized error and do not replay POST requests", async (context) => {
    const logger = context.mock.method(console, "error", () => {});
    let attempts = 0;
    const fixture = namespaceFor(async () => {
        attempts++;
        throw new Error("secret-session https://private.invalid");
    });
    const response = await fetchLounge(new Request("https://lounge.example/v1/session", { method: "POST", body: "{}" }), fixture.env);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.doesNotMatch(await response.text(), /secret-session|private.invalid/);
    assert.deepEqual(logger.mock.calls[0].arguments, ["lounge: container unavailable"]);
    assert.equal(attempts, 1);
});

test("deployment keeps the existing Docker context, fixed port, singleton cap, and private request logs", async () => {
    const config = JSON.parse(await readFile(new URL("./wrangler.json", import.meta.url), "utf8"));
    assert.equal(config.containers.length, 1);
    assert.deepEqual(config.containers[0], {
        class_name: "LoungeContainer", scheduling_policy: "default", image: "../Dockerfile",
        image_build_context: "..", instance_type: "lite", max_instances: 1,
    });
    assert.deepEqual(config.durable_objects.bindings, [{ name: "LOUNGE", class_name: "LoungeContainer" }]);
    assert.deepEqual(config.migrations, [{ tag: "v1", new_sqlite_classes: ["LoungeContainer"] }]);
    assert.equal(typeof config.vars.LOUNGE_ALLOWED_ORGS, "string");
    assert.equal(config.observability.logs.invocation_logs, false);
    assert.equal(config.preview_urls, false);
    const dockerIgnore = await readFile(new URL("../.dockerignore", import.meta.url), "utf8");
    assert.deepEqual(dockerIgnore.trim().split(/\r?\n/), ["**", "!Dockerfile", "!server.mjs", "!voice.mjs"]);
    const source = await readFile(new URL("./worker.mjs", import.meta.url), "utf8");
    assert.match(source, /this\.containerFetch\(request, CONTAINER_PORT\)/);
    assert.match(source, /this\.envVars = containerEnvironment\(env\)/);
    assert.match(source, /sleepAfter = "10m"/);
});

test("the unchanged Node relay retains authentication, shared presence, org isolation, and SSE through the adapter", { timeout: 15_000 }, async (context) => {
    const githubCalls = [];
    const lounge = createLoungeServer({
        host: "127.0.0.1", port: 0, allowedOrgs: ["org-a", "org-b"],
        fetch: async (url, options) => {
            githubCalls.push({ url, authorization: options.headers.Authorization });
            const token = options.headers.Authorization;
            const user = token === "Bearer fake-alice" ? { id: 1, login: "alice" }
                : token === "Bearer fake-bob" ? { id: 2, login: "bob" } : null;
            if (!user) return Response.json({}, { status: 401 });
            if (url.endsWith("/user")) return Response.json(user);
            const member = url.endsWith("/org-a") || (user.id === 2 && url.endsWith("/org-b"));
            return Response.json(member ? { state: "active" } : {}, { status: member ? 200 : 404 });
        },
    });
    context.after(() => lounge.close());
    const { port } = await lounge.listen();
    const fixture = namespaceFor((request) => fetch(`http://127.0.0.1:${port}${new URL(request.url).pathname}${new URL(request.url).search}`, {
        method: request.method, headers: request.headers, body: request.body, duplex: "half", signal: request.signal,
    }));
    const dispatch = (path, options = {}) => fetchLounge(new Request(`https://lounge.example${path}`, options), fixture.env);
    const post = (path, authorization, body = {}) => dispatch(path, {
        method: "POST", headers: { Authorization: authorization, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    assert.equal((await dispatch("/v1/session", { method: "POST", body: JSON.stringify({ org: "org-a" }) })).status, 401);
    assert.equal((await post("/v1/session", "Bearer fake-alice", { org: "outside-org" })).status, 403);
    assert.equal((await post("/v1/session", "Bearer fake-invalid", { org: "org-a" })).status, 401);
    assert.equal((await post("/v1/session", "Bearer fake-alice", { org: "org-b" })).status, 403);
    assert.equal((await post("/v1/heartbeat", "Session unknown")).status, 401);
    const alice = await (await post("/v1/session", "Bearer fake-alice", { org: "org-a" })).json();
    const bob = await (await post("/v1/session", "Bearer fake-bob", { org: "org-a" })).json();
    const otherOrg = await (await post("/v1/session", "Bearer fake-bob", { org: "org-b" })).json();
    for (const [session, expectedMembers, query] of [[alice.session, 1, true], [bob.session, 2, false], [otherOrg.session, 1, false]]) {
        const controller = new AbortController();
        context.after(() => controller.abort());
        const response = await dispatch(`/v1/stream${query ? `?s=${session}` : ""}`, {
            headers: query ? {} : { Authorization: `Session ${session}` }, signal: controller.signal,
        });
        assert.equal(response.status, 200);
        assert.match(response.headers.get("Content-Type"), /^text\/event-stream/);
        const reader = response.body.getReader();
        context.after(() => reader.cancel().catch(() => {}));
        const snapshot = new TextDecoder().decode((await reader.read()).value);
        assert.match(snapshot, /^event: snapshot\n/);
        assert.equal(JSON.parse(snapshot.split("data: ")[1].split("\n")[0]).members.length, expectedMembers);
    }
    assert.deepEqual(await (await dispatch("/healthz")).json(), { ok: true, rooms: 2, members: 3 });
    assert.equal((await post("/v1/move", `Session ${alice.session}`, { x: 100, y: 200 })).status, 200);
    assert.equal((await post("/v1/heartbeat", `Session ${alice.session}`)).status, 200);
    assert.equal((await post("/v1/leave", `Session ${alice.session}`)).status, 200);
    assert.equal((await post("/v1/heartbeat", `Session ${alice.session}`)).status, 401);
    assert.ok(githubCalls.every((call) => call.url.startsWith("https://api.github.com/")));
    assert.ok(githubCalls.some((call) => call.authorization === "Bearer fake-alice"));
    assert.deepEqual([...new Set(fixture.names)], [SINGLETON_NAME]);
});
