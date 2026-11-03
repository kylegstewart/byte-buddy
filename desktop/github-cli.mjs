import { statSync } from "node:fs";
import { win32 } from "node:path";

export function resolveGitHubCli({ env = process.env, platform = process.platform, fileExists = (file) => { try { return statSync(file).isFile(); } catch { return false; } } } = {}) {
    if (platform !== "win32") return "gh";
    const variable = (name) => Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] || "";
    const directories = variable("PATH").split(";").map((directory) => directory.trim().replace(/^"(.*)"$/, "$1")).filter((directory) => win32.isAbsolute(directory));
    const candidates = directories.map((directory) => win32.join(directory, "gh.exe"));
    for (const name of ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"]) {
        const directory = variable(name);
        if (directory) candidates.push(win32.join(directory, "GitHub CLI", "gh.exe"));
    }
    const local = variable("LOCALAPPDATA");
    if (local) candidates.push(win32.join(local, "Programs", "GitHub CLI", "gh.exe"), win32.join(local, "Microsoft", "WinGet", "Links", "gh.exe"));
    return candidates.find(fileExists) || "gh";
}
