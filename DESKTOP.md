# Byte Buddy desktop

Byte Buddy now has a standalone Electron host. It runs the existing game UI,
store, reward engines, analytics, ticket reader, GitHub importer, and Lounge
client locally, without the Copilot app or a particular editor. The original
Copilot canvas extension remains supported and uses its existing installation
and update path.

## Run the Windows application

The Windows x64 build produces:

- `release/Byte Buddy Setup 1.3.0.exe`: an installer with a selectable destination.
- `release/Byte Buddy 1.3.0.exe`: a portable executable (its saves still live in
  your Windows user profile, not beside the executable).

Neither requires a separate Node.js installation or Copilot. GitHub integration
requires GitHub CLI (`gh`); the ticket integration requires the same trusted
local MCP command and network access as before, for example Docker. Missing
integrations do not remove your existing progress or prevent offline play/demo.

These are **unsigned development builds**, not published GitHub releases.
Windows reputation checks and company installation policies may warn or prevent
running them. Do not bypass company controls. Signing and a reviewed release
process remain distribution tasks; the app does not claim an approved publisher.

Open **Connections** for data-folder access, GitHub sign-in,
and ticket MCP configuration. Standard gameplay and analytics remain in their
existing tabs.

Use **Enter Lounge** in the header to open the separate multiplayer view and
**Back to Byte Buddy** to return to the previous gameplay tab. Returning stops
movement but keeps the Lounge session connected; use **Leave** to disconnect.
**Manage connections** returns directly to Connections. Save export is available
under **Settings -> Save backup**, replacing the removed How it works tab.
Desktop content fills the available window width up to 1,440 pixels. Wider
windows place the buddy beside the gameplay panels and Lounge controls beside
the world; narrower windows stack these areas. The Copilot canvas keeps its
compact width.

## Fresh desktop start

Every new desktop installation starts a new buddy and progression profile.
There is no save-import UI, import IPC endpoint, migration module, or automatic
copying of Copilot saves. Previously queued preview imports are ignored.

The standalone data root is `%APPDATA%\Byte Buddy Desktop`, separate from both
Copilot and the earlier desktop preview at `%APPDATA%\Byte Buddy`. Moving to
this build therefore starts fresh even if the preview had existing progress.
Old folders are not read, overwritten, or deleted. GitHub CLI credentials are
account authentication, not game progress, and can still be reused.

The fresh start is not a reset on every launch: new desktop progress is saved
normally between sessions. Reinstalling/updating this desktop build also keeps
that new progress. Configuring another IT username selects its separate local
profile. GitHub identity pinning still prevents mixing accounts within a profile.

## GitHub account connection

Install GitHub CLI if needed. The desktop checks PATH and standard Windows CLI
installation directories, including when its inherited PATH predates the CLI
installation. Custom locations may still require a full Byte Buddy restart.
Under **Connections**, click **Check existing sign-in** if you already logged
in with `gh`. This verifies the active `github.com` account, rather than failing
because another stored account is stale. **Sign in with GitHub** makes the same
check first and reuses a valid account without starting another device flow.

If sign-in is needed, a one-time code appears in the app before **Open GitHub
device sign-in** becomes available. Both normal and clipboard-style CLI code
messages are recognized. Only the code and sanitized account/status information
are displayed, never raw process output or tokens. Enter the code only on
GitHub's own device-login page. **Cancel sign-in** stops a pending flow without
deleting stored credentials. **Check existing sign-in** remains functional
during the flow and completes it when a valid existing account is detected.

A flow that produces no code fails after 45 seconds with recovery instructions
instead of leaving an unusable device button. You can always sign in with
`gh auth login --hostname github.com` in a Windows terminal under the same user,
then click **Check existing sign-in**. Network/proxy failures are reported
separately from a missing login. Authentication never starts an activity import.

GitHub CLI manages credential storage; secure-storage availability depends on
its installation/environment. Byte Buddy stores neither a GitHub password nor
a GitHub token in `connections.json` or progression records. Organization SSO,
OAuth/token restrictions, repository permissions, and rate limits still apply.
This first desktop host retains the existing public `github.com` integration;
it does not add GitHub Enterprise Server support.

Enable GitHub, select explicit organizations/repositories in the normal
Connections editor, then click **Sync GitHub**. Discovery remains manual-only,
read-only, resumable, identity-pinned, and subject to the existing quota and
evidence rules. Signing in, opening the app, and editing scope do not import
activity automatically. A sign-in status alone is not verification of the
identity pinned in the save; the importer checks it on manual sync.

**Lounge exception:** joining the existing Lounge sends the `gh` token once to
the configured relay to verify identity and org membership. See the trust
warning below; do not interpret local credential management as a promise that
no GitHub credential ever reaches the Lounge server.

## Connect the local IT MCP

Do this on a computer that can reach the company network and is permitted to
run the existing MCP. Nothing here requires exposing the MCP over the internet.
The personal computer used for development has no access to that company MCP;
only a synthetic local stdio MCP was tested here.

1. Use a separate local JSON configuration with the `mcpServers` shape in
   `desktop/mcp.example.json`, or explicitly select an existing compatible
   Copilot MCP configuration. There is no automatic reading/launching of
   Copilot's MCP configuration.
2. Replace the example image with the exact trusted Docker command, arguments,
   environment, and optional absolute `cwd` from the working configuration.
   The placeholder image is not a real IT service. For stdio Docker MCP, use
   `-i`, not `-t`. If the command requires Node/Python instead, install that
   runtime independently; Electron's private runtime is not a global `node`.
3. In desktop Connections, enter your IT username and MCP server name (default
   `information-technology`), then choose the JSON file. Read the native command
   trust prompt and confirm only a configuration you trust. It runs a local
   process with your user permissions; configuration files are executable trust
   decisions, not harmless ticket documents.
4. Restart as prompted and use the normal ticket sync. The adapter uses the
   existing read-only `search_tickets`/`get_ticket` tools and reward rules.
   Configured startup retains the existing stale-ticket refresh behavior.
   Outside the company network, new sync can fail while cached history remains.

The desktop records the configuration **path**, server name, and IT username;
it does not copy embedded MCP credentials into its connections file. Keep the
referenced configuration private and outside the repository, restrict its OS
permissions, and use your existing approved credential mechanism. Changes to
that trusted file affect the next process start. Disconnecting MCP preserves
all history and rewards. There is no standalone Copilot/AI fallback: direct MCP
failures are reported directly rather than asking for a nonexistent Copilot
session.

## Multiplayer Lounge and Cloudflare

The cloud hosts **only the existing Lounge relay**:

`Desktop -> HTTPS Worker -> one Durable Object/container -> Node Lounge`

Ticket reading, ticket credentials/content, PR evidence, progression saves,
XP/rewards, and analytics remain local and are not uploaded to that relay.
It receives the existing sanitized buddy appearance/name/evolution stage,
GitHub identity/org, positions, and presence; stage is public appearance, not
full career synchronization. There is no work-laptop tunnel or inbound laptop
port. Players need only outbound HTTPS/SSE to the chosen cloud hostname.

Follow `lounge-server/CLOUDFLARE.md` for account selection, Docker, billing,
allowlist, login, validation, deployment, monitoring, and optional custom domain.
The adapter is prepared, but **no Cloudflare login, purchase, or deployment has
been performed**. A real container build and deployed two-player test still
need Docker, an account, and the intended GitHub org allowlist.

Set **Lounge -> Lounge server URL** to the deployed HTTPS **base URL without
`/v1`**, save it, and join an allowed organization with your signed-in GitHub
account. All players must use the same deployment. Membership is verified on
the server; clients cannot establish membership by claiming an org name.

The native desktop asks you to trust each distinct server URL before obtaining
or sending a token, with Cancel as the default. Trust is remembered only until
the app closes. **The relay operator can access the GitHub token and could
misuse all of its granted permissions.** Only join a relay/operator you trust;
an organization allowlist is not an OAuth token broker or a limited-scope Lounge
credential. Redirects are refused. The relay does not persist/log tokens, but
this is still a real trust boundary. Reauthentication can occur after cloud
restarts; process-local sessions and positions are not durable game saves.

Normal HTTPS hosting and an optional custom domain remove the Tailscale/laptop
dependency, **not company policy or filtering**. No cloud provider, domain,
desktop package, or code-signing certificate can guarantee network acceptance.
Test the actual hostname and SSE connection under applicable rules; do not use
tunnels, disguised traffic, or disabled controls to evade a block. If policies
forbid installing/running the app or accessing its host, hosting changes cannot
solve that restriction.

## Local data, updates, and retained functionality

- Default Windows data root: `%APPDATA%\Byte Buddy Desktop`. **Open local data folder**
  shows the exact location. Saves remain at `artifacts/IT_USERNAME/` using the
  existing split-storage/checksum/backup format. `BYTE_BUDDY_DATA_DIR` overrides
  the root for isolated testing or an explicitly managed installation.
- `connections.json` contains desktop connection choices; `lounge.json` contains
  the relay URL. No cloud account is needed for local play or history viewing.
- The existing XP economy, evolutions, care, wardrobe, challenges, achievements,
  demo isolation, separate ticket/GitHub accounting, analytics, export, and
  multiplayer UI share their original modules rather than being reimplemented.
  Fresh-start regressions verify isolation from old saves and normal desktop
  persistence across restarts.
- Copilot chat/canvas actions still exist in the original extension. The desktop
  exposes game operations through the same UI/local service; it does not embed
  Copilot, reuse its installed MCP sessions, or reproduce an AI chat agent.
- Desktop **Settings -> Check for updates** checks this repository's GitHub
  releases manually and opens a Windows installer download in the system
  browser. It never runs the Copilot gist/in-place updater, installs silently,
  or changes a save. A release must contain a Windows `.exe` asset before it is
  offered. No desktop release has been published as part of this migration.
- Uninstalling retains the app's data directory. Back up the full directory or
  export a complete current save before moving machines or replacing builds.

## Development, tests, and packaging

Development/building requires Node.js 24 and npm. From the repository root:

```powershell
npm ci
npm start
npm test
npm run test:desktop
npm run dist
npm run test:packaged
```

`test:desktop` launches a hidden real Electron window with disposable data and
checks initialized game UI, native bridge, disabled renderer Node access, no
legacy-import controls, and hidden device controls before a code exists.
It also checks separate Lounge navigation, return focus, keyboard tabs, Settings
save export, and overflow-free layouts at 480, 960, 1,200 and 1,800 pixels, with
the desktop width capped at 1,440 pixels. To capture disposable visual previews,
run `node scripts/desktop-smoke.mjs --screenshots .tools/desktop-layout-preview`.
`test:packaged` runs the same check against `release/win-unpacked/Byte Buddy.exe`
after building on Windows. Neither uses personal saves or signs into GitHub.
For an alternate build output directory, pass
`node scripts/desktop-smoke.mjs --packaged --output release/github-signin-fix`.
`npm run pack` builds an unpacked app; `npm run dist` builds Windows x64 NSIS
and portable executables. Packaging is configured for Windows; macOS/Linux
installers, signing/notarization, and cross-platform device testing are not
claimed by this migration. Do not commit generated `release/` or dependencies.

The manual **Build desktop installers** GitHub Actions workflow performs tests,
both smoke checks, and packaging, then uploads build artifacts. It does not
publish releases, deploy Cloudflare, or require application credentials. The
existing gist publishing workflow is unchanged. For a future desktop release,
keep `package.json`/lockfile and `version.json` versions aligned, run validation,
and publish reviewed/signed installer assets as a separate release decision.

Development-tooling audit note (November 2, 2026): `npm audit` reports 15 moderate
findings in transitive packaging dependencies, while `npm audit --omit=dev`
reports zero. These tooling packages are not runtime dependencies shipped with
the application. Review upstream fixes rather than applying the suggested
breaking `npm audit fix --force` downgrade automatically.
