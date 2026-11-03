# Byte Buddy Lounge on Cloudflare Containers

Prepared against official documentation on **November 2, 2026**. This optionally
deploys the **existing** `lounge-server/server.mjs` with its existing Node 22
`Dockerfile`; it does not rewrite the player protocol. Nothing has been deployed,
purchased, or authenticated by adding these files.

## Architecture and boundaries

`Desktop -> HTTPS Worker -> LOUNGE Durable Object -> Node container:8787`

- Every accepted request uses `idFromName("byte-buddy-lounge")` in the same `LOUNGE`
  namespace, irrespective of user, organization, token, client address, or URL host.
  This includes health, sessions, streams, moves, heartbeats, and leaves. Never
  substitute `getRandom()`, per-user/per-org IDs, or round-robin routing: rooms and
  sessions live together in one Node process. `max_instances: 1` is an extra
  production cap, not the mechanism that selects the singleton.
- This uses the `default` scheduling policy and `@cloudflare/containers`, not the
  separate `durable_object` scheduling policy. Its SQLite-backed DO manages
  lifecycle; it does **not** persist the Node process's maps.
- `containerFetch(request, 8787)` fixes the port even if a client supplies
  `cf-container-target-port`. HTTP/SSE are passed through as streams, without
  reading/accumulating response bodies, caching, or replaying failed POSTs.
- The Docker build context is `lounge-server/`, not the repository root. Its
  existing Dockerfile copies only `server.mjs` into the image. An allowlist
  `.dockerignore` excludes all other project files from the build context. Keep
  secrets out of the Dockerfile/server and preserve that allowlist. Desktop code,
  ticket MCP connections/credentials, ticket data, progression,
  XP, and desktop databases remain outside the cloud. The existing protocol still
  transmits public buddy appearance and presence, not progression state syncing.

## Prerequisites and account setup

1. Create/select a Cloudflare account. Containers requires **Workers Paid**,
   currently starting at **US $5/month**, not Workers Free; a paid DNS/zone plan
   is not a substitute. Enable the subscription/billing yourself and confirm
   Containers access and limits in the dashboard. Review current prices before
   authorizing any purchase. Workers, DOs, container resources, egress, and logs
   can incur usage charges beyond included allowances.
2. Install Node.js **22 or newer**, npm, and a running Docker engine capable of
   Linux `amd64` builds. On Windows, Docker Desktop must use Linux containers.
   Verify `docker info`. Docker is required for real local container runs and
   deployment, not for the Node tests or Worker-only dry-run below.
3. Select the correct account. With multiple accounts, set
   `CLOUDFLARE_ACCOUNT_ID` in the terminal (PowerShell:
   `$env:CLOUDFLARE_ACCOUNT_ID = "your-account-id"`) or add your non-secret
   `account_id` to `cloudflare/wrangler.json`. None is preconfigured here.
4. Replace the empty `vars.LOUNGE_ALLOWED_ORGS` in `cloudflare/wrangler.json` with
   your actual comma-separated GitHub organization list, such as
   `"your-org,another-org"`. This is non-secret deployment configuration. Blank,
   malformed, wildcard, and empty-entry lists are rejected by `npm run deploy`
   and fail closed with HTTP 503 at runtime. Unlike the bare server's empty-list
   behavior, an unconfigured cloud deployment never allows every organization.

The isolated package/lockfile pins the official Containers library and Wrangler.
No root package changes are required. Run these commands yourself:

```sh
cd lounge-server/cloudflare
npm ci
npm run check
npm run check-config
npx wrangler login
npx wrangler whoami
npm run deploy
```

`login` opens your browser for authorization. `deploy` runs the local allowlist
preflight, uploads the Worker, builds/pushes the existing Docker image to
Cloudflare, and provisions the DO/container application. Do not generate a new
template or deploy from the repository root. Preserve the Worker name, DO class,
binding, singleton name, and migration history on updates. Do not reuse this new
migration unchanged for an unrelated existing Worker.

Configure the desktop Lounge server **base URL** to the HTTPS `workers.dev` URL
printed by Wrangler, without `/v1`. All players must use the same deployment.
Desktop settings belong to the desktop implementation, not this adapter. Never
configure a ticket MCP endpoint as the Lounge URL. The initial deployment can
need several minutes of container provisioning even after the Worker responds;
check the dashboard or `npx wrangler containers list` before diagnosing startup.

## Validation without deployment

From `lounge-server/cloudflare/`:

```sh
node --test relay.test.mjs
npm run check
```

The first command needs only Node. It tests mandatory configuration, singleton
routing across routes/identities, streaming/cancellation, sanitized errors,
fixed configuration, and an actual local Node relay with mocked GitHub responses.
It uses fake tokens and verifies membership failures, shared presence, org
isolation, and existing session/header/query behavior without external accounts.
The root `cloudflare-lounge.test.mjs` entry also includes these tests in the
repository's root `*.test.mjs` test runs without installing Cloudflare packages.

`npm run check` also bundles with
`wrangler deploy --dry-run --containers-rollout=none` into the ignored
`.wrangler/dry-run/` directory. The explicit `none` flag skips container image
building; current Wrangler otherwise needs Docker even for a dry-run. This check
does not deploy, upload an image, provision resources, or validate account
entitlements. It establishes Worker bundling/configuration, not real container
startup or deployed SSE behavior. With Docker running, additionally run:

```sh
npx wrangler deploy --dry-run --outdir .wrangler/container-dry-run
```

That full dry-run also builds the image locally without deploying. Do **not**
add `--containers-rollout=none` to a real first deployment: that would omit the
required container deployment.

With Docker running and the allowlist set, `npm run dev` runs locally on
`127.0.0.1`; the first request starts Docker. Real session creation still contacts
**real GitHub**. Local HTTP is only for loopback testing: never expose this dev
server or place real tokens in public scripts.

## Post-deployment verification

1. Run `curl.exe -i https://YOUR-DEPLOYMENT/healthz` (or `curl -i` outside
   PowerShell). An empty lounge returns HTTP 200 with
   `{ "ok": true, "rooms": 0, "members": 0 }`. This checks the Node singleton,
   not an edge-only fake health response.
2. POST `/v1/session` with `{ "org": "your-org" }` and no Authorization: expect
   401. A syntactically valid organization outside the allowlist must return 403.
   Invalid tokens and inactive/nonmember memberships must never create sessions.
   GitHub token/SSO policies and rate limits can also prevent joining; do not
   bypass membership checks to work around those restrictions.
3. Join with two approved desktop users in the same org, ideally on different
   networks. Both must see each other's join/move/leave promptly. A second
   permitted org gets an isolated room in the same process. Compare aggregate
   `/healthz` counts and verify **one** running instance, not one per player.
4. Inspect `/v1/stream`: expect `text/event-stream`, an immediate `snapshot`, then
   incremental `join`, `move`, and `leave` events. The server emits `: ping` every
   15 seconds. If needed, use `curl -N` and a session header in a controlled local
   environment; never wait for the entire stream before displaying events. Do
   not put actual credentials into shell history, issue reports, or screenshots.
5. Stop clients and uptime probes for over ten minutes; check idle shutdown, then
   reconnect and verify fresh sessions restore presence after cold start. During
   an intentional later rollout/restart, verify desktop reconnection: an old
   session may return `401 bad_session` and must be exchanged for a new session.

## Idle, restarts, and availability

`sleepAfter = "10m"` allows scaling to zero after inactivity. Incoming requests
reset activity; regular client heartbeat POSTs keep the lounge active. Do not
depend on downstream SSE ping bytes alone. Frequent `/healthz` uptime probes can
also keep it warm and billable. The Containers helper tracks in-flight streams;
no extra keepalive cron is installed.

All rooms, sessions, and remembered positions disappear on idle shutdown, crash,
image rollout, host maintenance, or process restart. There is no durable room
storage or failover replica, and the container filesystem is ephemeral by
default. Cloudflare does not guarantee uninterrupted instance lifetime. The
existing Node server handles SIGTERM by closing streams. A stable DO name
restores routing identity, **not** Node memory: clients must reconnect,
re-authenticate when needed, and rejoin. The singleton is an intentional scale
and availability limit, not HA. The existing 50-member cap is **per org**, not
a global deployment cap.

Runtime variables apply when the container starts. An allowlist change requires
a container restart/rollout and verification: changing Worker variables alone
does not reconfigure the running Node process or revoke its existing sessions.
Removing an org requires terminating those sessions via restart as well. The
Worker rejects all requests when its current list is invalid, but does not
independently authenticate/revoke Node sessions.

## Access and security limitations

- This is an Internet-reachable authenticated application, **not** a private
  network. `/healthz` reveals aggregate room/member counts without auth. The
  relay still verifies GitHub identity and active org membership at
  `/v1/session`; other actions retain `Authorization: Session ...`. SSE also
  retains the existing `?s=...` option. No guest mode, auth bypass, permissive
  CORS, or alternate identity-header authentication is added.
- **The current relay receives the user's GitHub bearer token.** It forwards
  that token to GitHub's `/user` and `/user/memberships/orgs/{org}` APIs. HTTPS
  protects transit, but the operator, deployed code, and platform must be
  trusted with the token's **entire authority**, not only those two calls. The
  relay stores generated Lounge sessions rather than persisting raw GitHub
  tokens; this does not remove exposure during authentication. Use a suitable
  least-privileged token and your org's SSO/approval policies; rotate/revoke on
  suspected exposure. This adapter is not an OAuth broker or safer token
  exchange: changing that requires coordinated relay/client work. Never send
  ticket MCP credentials here.
- Production clients must use HTTPS and a trusted Lounge URL, not plain HTTP,
  lookalikes, or redirects. Review the desktop's configurable-server trust and
  consent behavior before onboarding users. The desktop now requires a native,
  cancel-by-default trust prompt per server URL per app run before obtaining or
  sending a token, and the shared client rejects redirects. This does not reduce
  the permissions of the credential the relay receives.
- The cloud container pins `LOUNGE_GITHUB_API` to `https://api.github.com` and
  passes only explicit settings to Node. Headers, query strings, JSON, and
  Worker variables cannot select arbitrary proxy destinations/container ports.
  GitHub Enterprise custom origins are deliberately unsupported here.
- No shared GitHub token or application secret is required. Never put secrets
  in Wrangler `vars`, Docker build arguments, source, or image layers. Future
  secrets need Cloudflare secret bindings and reviewed explicit runtime
  mapping, never `envVars = { ...env }` or request-controlled settings.
- Query sessions can leak through URL/access logs. Automatic Worker invocation
  logs are disabled because they include request URLs; the adapter never logs
  request headers, bodies, raw errors, or sessions. This cannot guarantee that
  platform, zone, proxy, live-tail, or client logs contain no URLs. Review all
  logs/exports/retention and prefer the existing session-header form wherever
  supported. Restrict operator access to logs and billing.
- No deployment-wide rate limit, session-revocation service, or edge abuse
  policy is installed. The relay's move limiter is not a general DoS defense.
  Unauthenticated health traffic can wake the container and generate cost.
  Review Cloudflare abuse/rate-limit controls and account alerts for the chosen
  hostname. `max_instances: 1` is not a request, memory, or spending limit.
- Cloudflare Access is not configured. Browser login challenges do not
  automatically work with desktop HTTP/SSE; a validated client integration is
  needed. If adding an Access/custom-domain gate, protect **every** reachable
  hostname (including `workers.dev`) or disable the unprotected hostname.
  Never replace membership checks with an unvalidated client identity header.

## Monitoring and optional custom domain

Use Workers & Pages / Observability for application logs and Containers for
instance status, startup failures, restarts, and resource usage. Observability
includes container logs but disables automatic Worker invocation logs. Inspect
the existing Node startup/shutdown messages and the adapter's generic failure
message; do not enable raw request logging to debug auth. `npx wrangler tail`
is useful for controlled tests, but live-tail metadata can contain URLs: do not
capture/share production query-session credentials.

Monitor GitHub auth/rate-limit failures, HTTP 5xx, memory pressure, reconnects,
and the single instance's usage. Review account usage/billing and configure
notifications; alerts are not hard spend caps. Active streams/probes can keep
paid resources running. Recheck log pricing/retention before exporting logs.

A custom domain is optional. Add a hostname in an active Cloudflare-managed zone
as a Worker Custom Domain in the dashboard or add this to `wrangler.json`, then
deploy:

```json
"routes": [{ "pattern": "lounge.example.com", "custom_domain": true }]
```

Use your own hostname and the same Worker/DO namespace. Verify TLS/security
rules and update all desktops to the same HTTPS base URL. After verification,
set `workers_dev: false` and redeploy to remove the alternate public endpoint
if desired. Preview URLs are already disabled. Deploying independent Workers
for different hostnames creates distinct namespaces and splits rooms.

## Official references

Recheck before deployment: prices, plan requirements, and APIs can change.

- [Getting started](https://developers.cloudflare.com/containers/get-started/)
- [Scheduling policies](https://developers.cloudflare.com/containers/configuration/scheduling-policy/)
- [Container class API](https://developers.cloudflare.com/containers/api/container-class/)
- [Scaling and routing](https://developers.cloudflare.com/containers/configuration/scaling-and-routing/)
- [Lifecycle](https://developers.cloudflare.com/containers/platform-details/)
- [Environment variables](https://developers.cloudflare.com/containers/configuration/environment-variables/)
- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Local development](https://developers.cloudflare.com/containers/local-dev/)
- [Container pricing](https://developers.cloudflare.com/containers/pricing/)
- [Container FAQ](https://developers.cloudflare.com/containers/faq/)
- [Invocation-log controls](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
- [Worker Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
