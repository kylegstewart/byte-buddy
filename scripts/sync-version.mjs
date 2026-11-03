import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function syncVersion(root) {
    const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error("Desktop releases require a stable major.minor.patch version.");
    const path = join(root, "version.json");
    const current = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...current, version }, null, 2) + "\n");
    return version;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    process.stdout.write("Synced version.json to " + syncVersion(root) + "\n");
}
