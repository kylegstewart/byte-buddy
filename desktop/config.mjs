import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, isAbsolute } from "node:path";

export function validateUserId(value) {
    const userId = String(value || "").trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9._-]{0,79}$/.test(userId) || userId.endsWith(".") || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/.test(userId)) throw new Error("Use your IT username: letters, numbers, dots, underscores or hyphens (1–80 characters).");
    return userId;
}

export function createDesktopConfig(root) {
    const file = join(root, "connections.json");
    function read() {
        const saved = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
        if (saved.version !== undefined && saved.version !== 1) throw new Error("This desktop configuration requires a newer Byte Buddy version.");
        const value = { version: 1, mcpConfigPath: saved.mcpConfigPath ?? "", serverName: saved.serverName ?? "information-technology", userId: validateUserId(saved.userId || userInfo().username) };
        validate(value);
        return value;
    }
    function validate(value) {
        if (typeof value.mcpConfigPath !== "string" || (value.mcpConfigPath && !isAbsolute(value.mcpConfigPath))) throw new Error("Choose an absolute MCP configuration path.");
        if (typeof value.serverName !== "string" || !value.serverName.trim() || value.serverName.length > 100) throw new Error("Enter the MCP server name.");
    }
    function write(next) {
        const value = { version: 1, mcpConfigPath: next.mcpConfigPath ?? "", serverName: next.serverName ?? "information-technology", userId: validateUserId(next.userId) };
        validate(value);
        mkdirSync(dirname(file), { recursive: true });
        const temp = `${file}.${process.pid}.tmp`;
        writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
        renameSync(temp, file);
        return value;
    }
    return { file, read, write };
}
