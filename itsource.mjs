// Read-only client for the information-technology MCP server. Only search_tickets and get_ticket are ever called.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

const SERVER_NAME = "information-technology";
const PROTOCOL_VERSION = "2025-06-18";
const START_TIMEOUT_MS = 120_000;
const CALL_TIMEOUT_MS = 90_000;
const IDLE_SHUTDOWN_MS = 2 * 60_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 60;

export const copilotHome = () => process.env.COPILOT_HOME || join(homedir(), ".copilot");

export class TicketSourceError extends Error {
    constructor(message) {
        super(message);
        this.code = "ticket_source_unavailable";
    }
}

function readServerConfig() {
    const file = join(copilotHome(), "mcp-config.json");
    let config;
    try {
        config = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
        throw new TicketSourceError(`Could not read ${file}: ${error.message}`);
    }
    const entry = config?.mcpServers?.[SERVER_NAME];
    if (!entry) throw new TicketSourceError(`MCP server '${SERVER_NAME}' is not configured.`);
    if (entry.type && !["local", "stdio"].includes(entry.type)) throw new TicketSourceError(`MCP server '${SERVER_NAME}' is not a local (stdio) server.`);
    if (!entry.command) throw new TicketSourceError(`MCP server '${SERVER_NAME}' has no command.`);
    return { command: entry.command, args: Array.isArray(entry.args) ? entry.args.map(String) : [], env: entry.env || {}, cwd: entry.cwd };
}

/** The developer identity the IT server is configured for, falling back to the OS account name. */
export function resolveUserId() {
    try {
        const config = readServerConfig();
        const fromArgs = config.args.map((arg) => /^MCP_USERNAME=(.+)$/.exec(arg)?.[1]).find(Boolean);
        return (fromArgs || config.env.MCP_USERNAME || userInfo().username).toUpperCase();
    } catch {
        return userInfo().username.toUpperCase();
    }
}

function createMcpClient() {
    let child = null;
    let ready = null;
    let nextId = 1;
    let idleTimer = null;
    let stderrTail = "";
    const pending = new Map();

    function stop() {
        clearTimeout(idleTimer);
        const proc = child;
        child = null;
        ready = null;
        if (!proc) return;
        try { proc.stdin.end(); } catch { /* ignore */ }
        setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } }, 5000).unref();
    }

    function failAll(error) {
        for (const { reject, timer } of pending.values()) {
            clearTimeout(timer);
            reject(error);
        }
        pending.clear();
    }

    function request(method, params, timeoutMs = CALL_TIMEOUT_MS) {
        return new Promise((resolve, reject) => {
            if (!child) return reject(new TicketSourceError("IT ticket MCP server is not running."));
            const id = nextId++;
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new TicketSourceError(`IT ticket MCP server timed out on ${method}.`));
            }, timeoutMs);
            pending.set(id, { resolve, reject, timer });
            child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        });
    }

    function start() {
        if (ready) return ready;
        const config = readServerConfig();
        const proc = spawn(config.command, config.args, {
            cwd: config.cwd,
            env: { ...process.env, ...config.env },
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
        });
        child = proc;
        stderrTail = "";
        let buffer = "";
        proc.stdout.setEncoding("utf8");
        proc.stdout.on("data", (chunk) => {
            buffer += chunk;
            let newline;
            while ((newline = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, newline).trim();
                buffer = buffer.slice(newline + 1);
                if (!line) continue;
                let message;
                try { message = JSON.parse(line); } catch { continue; }
                const entry = message.id !== undefined ? pending.get(message.id) : undefined;
                if (!entry) continue;
                pending.delete(message.id);
                clearTimeout(entry.timer);
                if (message.error) entry.reject(new TicketSourceError(message.error.message || "MCP request failed."));
                else entry.resolve(message.result);
            }
        });
        proc.stderr.setEncoding("utf8");
        proc.stderr.on("data", (chunk) => { stderrTail = (stderrTail + chunk).slice(-1000); });
        const onExit = (reason) => {
            if (child !== proc) return;
            child = null;
            ready = null;
            const detail = stderrTail.trim().split("\n").pop();
            failAll(new TicketSourceError(`IT ticket MCP server ${reason}${detail ? `: ${detail}` : "."}`));
        };
        proc.on("error", (error) => onExit(`failed to start (${error.message})`));
        proc.on("exit", (code) => onExit(`exited with code ${code}`));
        proc.stdin.on("error", () => { /* surfaced through exit */ });

        ready = (async () => {
            await request("initialize", {
                protocolVersion: PROTOCOL_VERSION,
                capabilities: {},
                clientInfo: { name: "byte-buddy", version: "1.0.0" },
            }, START_TIMEOUT_MS);
            proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
        })();
        ready.catch(() => stop());
        return ready;
    }

    async function callTool(name, args) {
        clearTimeout(idleTimer);
        try {
            await start();
            const result = await request("tools/call", { name, arguments: args });
            const text = (result?.content || []).filter((part) => part.type === "text").map((part) => part.text).join("");
            if (result?.isError) throw new TicketSourceError(text || `${name} failed.`);
            try {
                return JSON.parse(text);
            } catch {
                throw new TicketSourceError(`${name} returned an unexpected response.`);
            }
        } finally {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(stop, IDLE_SHUTDOWN_MS);
            idleTimer.unref();
        }
    }

    process.once("exit", stop);
    return { callTool, stop };
}

/** Keeps only the fields Byte Buddy needs; descriptions and contact details are never stored. */
export function normalizeTicket(raw) {
    return {
        id: String(raw.taskId ?? raw.id ?? ""),
        title: String(raw.taskTitle ?? raw.title ?? "").trim().slice(0, 120),
        isOpen: raw.isOpen !== false,
        isIssue: Boolean(raw.isIssue),
        priority: raw.priority ?? null,
        severity: raw.ticketSeverity ?? raw.severity ?? null,
        assignedTo: String(raw.assignedTo?.userId ?? raw.assignedTo ?? "").toUpperCase() || null,
        closedOn: raw.closedByDate ?? raw.closedOn ?? null,
        updatedOn: raw.updatedOn ?? null,
        createdOn: raw.createdOn ?? null,
        requester: String(raw.createdBy?.userId ?? raw.requester ?? "").toUpperCase() || null,
        difficulty: Number(raw.difficultyLevel ?? raw.difficulty) || null,
        timesReopened: Number(raw.timesReopened) || 0,
    };
}

export function createItSource() {
    const client = createMcpClient();

    /** Pages through every ticket assigned to the user (open and closed) so reopened tickets can be reconciled. */
    async function fetchAssignedTickets(userId, onProgress) {
        const tickets = [];
        let totalPages = 1;
        for (let page = 1; page <= Math.min(totalPages, MAX_PAGES); page++) {
            const result = await client.callTool("search_tickets", { assignees: [userId], resultsPerPage: PAGE_SIZE, page, sortOn: "updatedOn", sortDirection: "desc" });
            for (const raw of result?.tickets || []) tickets.push(normalizeTicket(raw));
            totalPages = result?.totalPages || 1;
            onProgress?.({ page, totalPages, fetched: tickets.length });
        }
        return { tickets, complete: totalPages <= MAX_PAGES };
    }

    /** Exact close date and closer for one ticket. */
    async function fetchClosure(ticketId) {
        const detail = await client.callTool("get_ticket", { ticketId: Number(ticketId) });
        return {
            closedOn: detail?.closedByDate ?? null,
            closedBy: String(detail?.closedByUser?.userId ?? "").toUpperCase() || null,
        };
    }

    return { fetchAssignedTickets, fetchClosure, stop: client.stop };
}
