// In-place updater: compares version.json with the published gist and replaces only code/UI files.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const CACHE_MS = 6 * 60 * 60 * 1000;
const MAX_TOTAL = 5 * 1024 * 1024;
const MANIFEST = ".byte-buddy-files.json";
const GIST_ID = /^[0-9a-f]{20,40}$/;
// Gist file names cannot contain "/", so the installer and publisher encode it as "\".
const SAFE_PATH = /^(?!\.)[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
// User data and VCS metadata are never touched, even if a gist tried to ship them.
const PROTECTED = new Set(["artifacts", ".git", "node_modules", MANIFEST]);

export class UpdateError extends Error {
    constructor(code, message) { super(message); this.code = code; }
}

export function compareVersions(a, b) {
    const x = VERSION.exec(String(a)), y = VERSION.exec(String(b));
    if (!x || !y) throw new UpdateError("invalid_version", `Unsupported version: ${!x ? a : b}`);
    for (let i = 1; i <= 3; i++) if (x[i] !== y[i]) return Number(x[i]) - Number(y[i]);
    return 0;
}

export function createUpdater({ dir, fetchImpl = fetch, now = Date.now } = {}) {
    let cache = null;
    let installing = null;

    const local = () => JSON.parse(readFileSync(join(dir, "version.json"), "utf8"));
    const headers = { Accept: "application/vnd.github+json", "User-Agent": "byte-buddy-updater" };

    async function fetchGist(gist) {
        if (!GIST_ID.test(gist || "")) throw new UpdateError("invalid_source", "version.json has no valid gist id.");
        const res = await fetchImpl(`https://api.github.com/gists/${gist}`, { headers, signal: AbortSignal.timeout(10_000) });
        if (res.status === 404) throw new UpdateError("check_failed", "The update source was not found.");
        if (!res.ok) throw new UpdateError("check_failed", `GitHub returned ${res.status}.`);
        return res.json();
    }

    async function content(file) {
        if (typeof file.content === "string" && !file.truncated) return file.content;
        if (!/^https:\/\/gist\.githubusercontent\.com\//.test(file.raw_url || "")) throw new UpdateError("unsafe_archive", "Unexpected file location.");
        const res = await fetchImpl(file.raw_url, { headers: { "User-Agent": "byte-buddy-updater" }, signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new UpdateError("download_failed", `Download failed (${res.status}).`);
        return res.text();
    }

    async function remote(gist) {
        const body = await fetchGist(gist);
        const file = body.files?.["version.json"];
        if (!file) throw new UpdateError("invalid_source", "The update source has no version.json.");
        const published = JSON.parse(await content(file));
        if (!VERSION.test(published.version || "")) throw new UpdateError("invalid_version", `Unsupported published version: ${published.version}`);
        return { body, version: published.version };
    }

    async function check({ force = false } = {}) {
        const { version, gist } = local();
        if (!force && cache && now() - cache.at < CACHE_MS && cache.current === version) return cache.result;
        const result = { current: version, latest: null, available: false, checkedAt: new Date(now()).toISOString() };
        try {
            const { version: latest } = await remote(gist);
            result.latest = latest;
            result.available = compareVersions(latest, version) > 0;
        } catch (error) {
            result.error = error.message || String(error);
        }
        if (!result.error) cache = { at: now(), current: version, result };
        return result;
    }

    async function performInstall() {
        const { version, gist } = local();
        const { body, version: latest } = await remote(gist);
        if (compareVersions(latest, version) <= 0) return { updated: false, current: version, latest };

        // Download and validate everything before touching the installation.
        const staged = new Map();
        let total = 0;
        for (const [name, file] of Object.entries(body.files)) {
            const rel = name.replaceAll("\\", "/");
            if (rel === "copilot-extension.json") continue;
            if (!SAFE_PATH.test(rel) || rel.split("/").some((part) => part === "..")) throw new UpdateError("unsafe_archive", `Unsafe file name: ${name}`);
            if (PROTECTED.has(rel.split("/")[0])) throw new UpdateError("unsafe_archive", `Update may not replace protected path: ${rel}`);
            const text = await content(file);
            total += Buffer.byteLength(text);
            if (total > MAX_TOTAL) throw new UpdateError("download_failed", "Update is too large.");
            staged.set(rel, text);
        }
        if (!staged.has("extension.mjs") || !staged.has("version.json")) throw new UpdateError("unsafe_archive", "Update is missing required files.");

        const base = resolve(dir);
        const target = (rel) => {
            const path = resolve(base, rel);
            if (!path.startsWith(base + sep)) throw new UpdateError("unsafe_archive", `Path escapes the extension: ${rel}`);
            return path;
        };
        // Write beside the target and rename so each file swaps atomically; version.json goes last.
        const ordered = [...staged.keys()].filter((rel) => rel !== "version.json").concat("version.json");
        for (const rel of ordered) {
            const path = target(rel);
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(`${path}.update-tmp`, staged.get(rel), "utf8");
            renameSync(`${path}.update-tmp`, path);
        }
        // Remove only files a previous update installed that this release no longer ships.
        const manifestPath = join(base, MANIFEST);
        if (existsSync(manifestPath)) {
            try {
                for (const rel of JSON.parse(readFileSync(manifestPath, "utf8"))) if (!staged.has(rel) && SAFE_PATH.test(rel)) rmSync(target(rel), { force: true });
            } catch { /* A damaged manifest only skips stale-file cleanup. */ }
        }
        writeFileSync(manifestPath, JSON.stringify([...staged.keys()]), "utf8");
        cache = null;
        return { updated: true, current: version, latest, restartRequired: true };
    }

    return {
        current: () => local().version,
        check,
        install: () => (installing ??= performInstall().finally(() => { installing = null; })),
    };
}
