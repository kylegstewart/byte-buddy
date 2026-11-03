import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { createStore } from "../store.mjs";
import { createItSource, readServerConfig, TicketSourceError } from "../itsource.mjs";
import { createSyncService } from "../sync.mjs";
import { createGitHubSource, ghRequest } from "../github-source.mjs";
import { createGitHubSyncService } from "../github-sync.mjs";
import { createLoungeClient } from "../lounge.mjs";
import { createBuddyServer } from "../server.mjs";
import { resolveGitHubCli } from "./github-cli.mjs";

const execute = promisify(execFile);

export function createDesktopRuntime({ root, config, ticketSource, githubSource, authorizeLounge, getGitHubToken = async () => (await execute(resolveGitHubCli(), ["auth", "token", "--hostname", "github.com"], { windowsHide: true, timeout: 10_000 })).stdout.trim() }) {
    const store = createStore({ root, userId: config.userId });
    const source = ticketSource || createItSource({ getConfig: () => {
        if (!config.mcpConfigPath) throw new TicketSourceError("Connect your local ticket MCP in Connections. No Copilot installation is required.");
        return readServerConfig({ configPath: config.mcpConfigPath, serverName: config.serverName });
    } });
    const sync = createSyncService({ store, source, userId: config.userId, allowHandoff: false });
    const request = (endpoint, query) => ghRequest(endpoint, query, resolveGitHubCli());
    const github = createGitHubSyncService({ store, source: githubSource || createGitHubSource({ request, graphqlRequest: (query) => request("graphql", query), pace: true }) });
    const lounge = createLoungeClient({ configPath: join(root, "lounge.json"), getGitHubToken, authorizeSession: authorizeLounge });
    const server = createBuddyServer({ store, sync, github, lounge, desktop: true });
    return {
        store, sync, github, lounge, server,
        async start() {
            const url = await server.urlFor("desktop");
            if (config.mcpConfigPath) sync.syncIfStale();
            return url;
        },
        async close() {
            github.stop();
            source.stop?.();
            await server.close();
        },
    };
}
