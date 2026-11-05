# Byte Buddy Lounge on Cloudflare Containers

Prepared against official documentation on **November 2, 2026**. This optionally
deploys the **existing** `lounge-server/server.mjs` with its existing Node 22
`Dockerfile`; it does not rewrite the player protocol. Nothing has been deployed,
purchased, or authenticated by adding these files.

## Architecture and boundaries

`Desktop -> HTTPS Worker -> LOUNGE Durable Object -> Node container:8787`

- Every accepted request uses `idFromName("byte-buddy-lounge")` in the same `LOUNGE`
  namespace, irrespective of user, organization, token, client address, or URL host.
  This includes health, sessions, streams, moves, chat, heartbeats, leaves, and voice. Never
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
  Dockerfile copies only `server.mjs` and `voice.mjs` into the image. An allowlist
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
- Presence requires no shared GitHub token or application secret. Optional voice
  requires the four explicitly mapped Realtime/TURN values described below.
  Never put secret values in Wrangler `vars`, Docker build arguments, source, or
  image layers; use Worker secret bindings, never `envVars = { ...env }` or
  request-controlled settings.
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

## Optional proximity voice: Realtime SFU and TURN

Implemented against the official Connection API/OpenAPI and TURN documentation
reviewed on **November 2, 2026**. Voice is explicit opt-in, audio-only, and has no
recording, transcription, video, DataChannels, or talk-event endpoint. Existing
sessions, presence, movement, and heartbeats continue working without voice
configuration. A voice join with an active stream then returns HTTP 503 with
`code: "voice_not_configured"` and a meaningful configuration message.

### Dashboard credentials and deployment

1. Select the same Cloudflare account used for the Lounge. In **Realtime >
   Serverless SFU**, create a dedicated SFU app for this Lounge/environment.
   Copy its **App ID** into `CF_REALTIME_APP_ID` and its **App Secret** into
   `CF_REALTIME_APP_SECRET`. These are the Connection API credentials, not a
   GitHub token, account-wide Cloudflare API token, or RealtimeKit key.
2. Open **Realtime > TURN** (the TURN keys page linked from Cloudflare's Generate
   Credentials guide). Create a TURN key. Save the returned **TURN key ID** as
   `CF_TURN_KEY_ID` and that key's credential-generation **API token** as
   `CF_TURN_API_TOKEN`. Keep the token server-side. This is distinct from the
   short-lived username/password generated for each voice join. Save the token
   when shown; rotate the key if it is lost or exposed. Do not create an
   account-wide administrator token for the Lounge runtime.
3. From `lounge-server/cloudflare`, use the correct authenticated account and
   existing Worker name. If this Worker does not exist yet, deploy it first using
   the prerequisites above; it will run presence with voice disabled. Enter the
   four values through Wrangler's private prompts, never command-line literals:

   ```sh
   npx wrangler secret put CF_REALTIME_APP_ID
   npx wrangler secret put CF_REALTIME_APP_SECRET
   npx wrangler secret put CF_TURN_KEY_ID
   npx wrangler secret put CF_TURN_API_TOKEN
   npm run check-config
   npm run deploy
   ```

   The code forwards only these four named optional values, in addition to the
   existing explicit presence configuration. The checked-in JSON contains no
   credential values; no secret bindings are required for a presence-only
   deployment. The App ID is not itself a password, but using the same secret
   binding procedure avoids accidentally mixing accounts/environments.
4. Ensure a newly started container receives the updated runtime environment.
   Container environment values are read at process start: do not assume changing
   a Worker secret hot-reloads a running Node process. Use the Containers
   dashboard's restart/rollout controls if necessary, coordinating the presence
   reconnect interruption with users. For a bare Node deployment, supply the
   same four environment variables securely before starting `server.mjs`.
5. Verify with two consenting desktop participants and headphones: opt into
   voice, publish an audio track, listen and answer, then move either participant
   farther than 480 units. Verify receiving tracks are closed, not merely muted.
   Repeat for leaving voice, disconnecting SSE, replacing the desktop session,
   and heartbeat expiry. Confirm another allowed organization cannot hear the
   first. Test TURN/TLS443 from a restrictive network. These are operator checks;
   no live account, credential, purchase, deployment, or microphone was used to
   implement the backend.

### Signaling contract

Every call is `POST /v1/voice` with `Authorization: Session <lounge-session>`
and a JSON object containing `action`. Query-string authentication is not
accepted here. The exact session must own the current SSE member; a previously
replaced session cannot signal, move, heartbeat, or remove its replacement.
Success uses the existing `ok: true` envelope:

| Action and additional request fields | Successful JSON response |
| --- | --- |
| `join` | `{ok:true,voiceId,iceServers,radius:480}` |
| `publish`: `voiceId,mid,sessionDescription:{type:"offer",sdp}` | `{ok:true,sessionDescription:{type:"answer",sdp}}` |
| `status`: `voiceId` | `{ok:true,peers:[{id,revision}],subscriptionId}` |
| `listen`: `voiceId` | `{ok:true,subscriptionId,sessionDescription:{type:"offer",sdp},tracks:[{mid,id}]}` |
| `answer`: `voiceId,subscriptionId,sessionDescription:{type:"answer",sdp}` | `{ok:true}` |
| `leave`: `voiceId` | `{ok:true}`, including repeat leaves while the Lounge session/stream remains active |

An empty listen returns exactly
`{ok:true,subscriptionId:null,sessionDescription:null,tracks:[]}`. Status returns
`subscriptionId:null` after revocation. IDs in `peers` and `tracks` are Lounge
member IDs; `revision` is an opaque publisher generation, unrelated to SFU IDs.
No client-supplied peer list, SFU session ID, track name, upstream URL, or
credential selects what is published or subscribed. Long-lived SFU/TURN secrets
and other users' SFU locators are never returned. Receiver SDP carries only the
receiver's required WebRTC negotiation details; publisher MSID labels are scrubbed.

Use separate sender and receiver RTCPeerConnections. A publish offer must have
one audio media section with the supplied mid and sendonly/sendrecv direction;
the server creates a fresh SFU publishing session and one random audio track.
Listen creates a fresh receive-only SFU session, returns its offer, and the
client answers with recvonly/inactive audio sections and the same mids. An answer
for an old/revoked/already-answered subscription is rejected. Never reuse the old
receiver after a roster or publisher revision change. No new SSE event is needed;
the desktop can poll status approximately every 1.5 seconds.

SDP is capped at 96 KiB and the voice-only request body at 128 KiB. Other Lounge
bodies retain their 16 KiB cap. Signaling is non-concurrent per voice, returning
`409 voice_busy` instead of creating overlapping SFU mutations. Per authenticated
organization/member, each 60-second window permits at most four joins, thirty
combined publish/listen/answer operations, and 120 total non-leave voice requests.
Changing voice IDs or replacing streams does not reset these limits. Leave is
always available. Ordinary errors use `{ok:false,code,error}`: authentication
`401 bad_session`, no matching active stream `409 voice_not_in_room`, stale
voice/subscription `409 voice_stale`, invalid audio SDP `400 bad_voice_sdp`,
rate limiting `429 voice_rate_limited`, and generic upstream failure
`502 voice_upstream`.

### Authorization, cleanup, and operational limits

- Discovery and subscription both select the same twelve closest published,
  live, other members in the same organization whose Euclidean distance is at
  most 480 world units, breaking distance ties by member ID. The selected roster
  stays sorted by member ID to avoid rebuilding receivers when only its order
  of distances changes. Unpublished opted-in
  members are not audio sources. Roster changes invalidate the entire old
  receiver, including an offer not yet answered, rather than trusting client
  gain or a later status poll to enforce privacy.
- Movement, SSE disconnect/replacement, member removal/expiry, voice replacement,
  and server shutdown immediately invalidate affected state and request
  `PUT tracks/close` with `force:true` for SFU tracks. Late allocations are
  retained and force-closed too. A pending request cannot resurrect a retired
  receiver/publisher; its response is discarded after resource cleanup.
- Cleanup checks every requested mid's result, including HTTP-200 item failures.
  A per-track `close_track_error` (already absent) counts as closed, and so does
  HTTP 410 `session_error` for the whole SFU session: the SFU returns it once the
  session's PeerConnection has closed, which is the normal outcome when a client
  drops its connection before the server's close request arrives. It makes at
  most three attempts per cleanup pass with bounded delays; each Cloudflare
  request has an eight-second timeout. On a close failure, the listener and its
  source publishers' voice states are invalidated and their tracks also retired,
  so every affected client receives `409 voice_stale` on its next request and
  drops its PeerConnections: that is the media cutoff. The server then retries
  the close in the background after 2, 10, 30, and 60 seconds and logs
  `lounge: voice cleanup unconfirmed; retrying` (or `; giving up` after the last
  attempt) with the resource role, attempt, allocation uncertainty, and remaining
  track count. A failed cleanup does **not** disable voice for anyone else.
  Sanitized failure diagnostics include only the operation, failure category,
  HTTP status when available, and allowlisted public error codes. Unknown codes
  are replaced with `unknown`; tokens, resource IDs, SDP, response bodies, and
  upstream error descriptions are never logged. A normal shutdown makes one final
  bounded cleanup pass.
- A timeout/lost allocation response is not proof the allocation failed, so its
  cleanup first inspects the SFU session and force-closes any tracks found there.
  A late allocation that lands afterwards cannot carry media: the client never
  received the SDP it needs to connect that session. There is no session-delete
  API in the documented Connection API: empty/unconnected retired sessions are
  left to Cloudflare's lifecycle, while media tracks are explicitly closed.
- An SFU control-plane outage cannot guarantee immediate server-side close, nor
  can forced close retract packets already sent or buffered. The cutoff then
  relies on the revoked clients closing their connections; Cloudflare also
  garbage-collects tracks that receive no media for 30 seconds. No automatic mic
  recapture or recording is provided.
- Each join generates TURN credentials with a 3,600-second TTL and returns only
  Cloudflare STUN/TURN endpoints on ports 3478, 5349, and 443, requiring TURN over
  TLS on port 443. Browser-blocked port 53, alternate port 80, custom domains, and
  arbitrary upstream hosts are excluded. Credential renewal is not implemented;
  explicitly leave/rejoin before the credential lifetime for long sessions.
  Issued credentials can remain usable until TTL expiry; they are not SFU
  publication/room access credentials. GitHub tokens only authenticate against
  GitHub and never go to the SFU/TURN service.

### Diagnosing voice cleanup warnings

Inspect the **Lounge container application logs**, not just the Worker's request
status. In Cloudflare's **Observability > Logs**, select the **Containers**
dataset rather than HTTP requests or security events, then filter to the Lounge
and the time of the failure. Worker application logs are also available under
Workers & Pages / the Lounge Worker / Observability. Find the
`lounge: voice diagnostic` entry before `lounge: voice cleanup unconfirmed`.
For example:

```text
lounge: voice diagnostic {"operation":"tracks_close","reason":"request_error","status":503,"errorCodes":["retryable_transient_error"]}
lounge: voice cleanup unconfirmed; retrying {"role":"publisher","attempt":1,"uncertainAllocation":false,"remainingTracks":1}
```

`tracks_new` with `timeout` means an allocation outcome is unknown, even when the
remaining track count is zero. `tracks_close` diagnostics identify failed close
requests, including per-track errors inside HTTP 200 responses. Check the HTTP
status and public error code against Cloudflare's error reference; do not infer
that a client network restriction caused a server-to-SFU API failure. Repeated
`giving up` warnings point at the SFU app or its credentials: check the Realtime
dashboard and rotate or revoke the dedicated SFU app if closure must be forced.

Relays deployed before this change disabled voice for everyone after the first
unconfirmed cleanup (`503 voice_unavailable`, "Voice is disabled until the
service is restarted") and kept that state for the life of the container process.
Deploying the updated relay replaces that process.

### Durable Object resets

`Connection closed: this Durable Object instance is no longer active. Reconnect
or retry the request.` is a Cloudflare platform message. The `LOUNGE` Durable
Object instance was replaced while a request, usually the long-lived `/v1/stream`,
was passing through it. Cloudflare replaces instances on every Worker version
deployment (including each `wrangler secret put`), on Workers runtime updates,
and when it relocates objects. The desktop reconnects the stream automatically,
and the new member replaces the old one, which ends that player's voice session:
select **Enable voice** again. The Node container usually keeps running across
these resets, so its in-memory state (including any voice state) survives them,
and the activity timer keeps it awake while any player's stream is open.

Backend tests (mock Cloudflare transport; no live credentials):

```sh
node --test lounge-voice.test.mjs lounge-server.test.mjs cloudflare-lounge.test.mjs
```

Official voice references:

- [SFU dashboard setup](https://developers.cloudflare.com/realtime/sfu/get-started/)
- [Connection API](https://developers.cloudflare.com/realtime/sfu/api/)
- [Connection API OpenAPI](https://developers.cloudflare.com/realtime/static/realtime-api-2024-05-21.yaml)
- [Negotiation, races, retry, and teardown](https://developers.cloudflare.com/realtime/sfu/concepts/negotiation/)
- [TURN keys and short-lived credentials](https://developers.cloudflare.com/realtime/turn/generate-credentials/)
- [Container environment variables and secrets](https://developers.cloudflare.com/containers/examples/env-vars-and-secrets/)
