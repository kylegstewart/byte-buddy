import electron from "electron";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const data = mkdtempSync(join(tmpdir(), "byte-buddy-desktop-smoke-"));
const environment = { ...process.env, BYTE_BUDDY_DATA_DIR: data };
delete environment.ELECTRON_RUN_AS_NODE;
const packaged = process.argv.includes("--packaged");
const outputIndex = process.argv.indexOf("--output");
const output = outputIndex < 0 ? join(project, "release") : resolve(process.argv[outputIndex + 1]);
const executable = packaged ? join(output, "win-unpacked", "Byte Buddy.exe") : electron;
const args = packaged ? ["--smoke-test"] : [project, "--smoke-test"];
try {
    const result = await promisify(execFile)(executable, args, { cwd: project, env: environment, windowsHide: true, timeout: 45_000, maxBuffer: 1024 * 1024 });
    const report = JSON.parse(readFileSync(join(data, "smoke.json"), "utf8"));
    if (!report.desktopBridge || !report.nodeUnavailable || !report.desktop || !report.freshStart || !report.deviceHidden) throw new Error("Desktop isolation or onboarding checks failed.");
    process.stdout.write(`${result.stdout}\nDesktop smoke test passed using isolated temporary data.\n`);
} finally {
    if (resolve(data).startsWith(`${resolve(tmpdir())}${sep}`)) rmSync(data, { recursive: true, force: true });
}
