// In-place updater: compares version.json with the latest GitHub release and replaces only code/UI files.
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const TAG = /^v?(\d+)\.(\d+)\.(\d+)$/;
const CACHE_MS = 6 * 60 * 60 * 1000;
const MAX_ARCHIVE = 50 * 1024 * 1024;
const MANIFEST = ".byte-buddy-files.json";
// User data and VCS metadata are never touched.
const PROTECTED = new Set(["artifacts", ".git", "node_modules", MANIFEST]);

export class UpdateError extends Error {
    constructor(code, message) { super(message); this.code = code; }
}

export function compareVersions(a, b) {
    const x = TAG.exec(String(a)), y = TAG.exec(String(b));
    if (!x || !y) throw new UpdateError("invalid_version", `Unsupported version: ${!x ? a : b}`);
    for (let i = 1; i <= 3; i++) if (x[i] !== y[i]) return Number(x[i]) - Number(y[i]);
    return 0;
}

function listFiles(root, dir = root, out = []) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        const rel = relative(root, path);
        if (PROTECTED.has(rel.split(sep)[0])) continue;
        if (entry.isSymbolicLink()) throw new UpdateError("unsafe_archive", `Archive contains a link: ${rel}`);
        if (entry.isDirectory()) listFiles(root, path, out);
        else if (entry.isFile()) out.push(rel);
    }
    return out;
}

export function createUpdater({ dir, fetchImpl = fetch, extract = defaultExtract, now = Date.now } = {}) {
    let cache = null;
    let installing = null;

    const local = () => JSON.parse(readFileSync(join(dir, "version.json"), "utf8"));

    async function check({ force = false } = {}) {
        const { version, repo } = local();
        if (!force && cache && now() - cache.at < CACHE_MS && cache.current === version) return cache.result;
        const result = { current: version, repo, latest: null, available: false, checkedAt: new Date(now()).toISOString() };
        try {
            const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
                headers: { Accept: "application/vnd.github+json", "User-Agent": "byte-buddy-updater" },
                signal: AbortSignal.timeout(10_000),
            });
            if (res.status === 404) result.error = "No release has been published yet.";
            else if (!res.ok) result.error = `GitHub returned ${res.status}.`;
            else {
                const release = await res.json();
                if (!TAG.test(release.tag_name || "")) throw new UpdateError("invalid_version", `Unsupported release tag: ${release.tag_name}`);
                result.latest = release.tag_name.replace(/^v/, "");
                result.available = compareVersions(result.latest, version) > 0;
                result.url = release.html_url;
                result.notes = String(release.body || "").slice(0, 2000);
                result.tarball = release.tarball_url;
            }
        } catch (error) {
            result.error = error.message || String(error);
        }
        if (!result.error) cache = { at: now(), current: version, result };
        return result;
    }

    async function performInstall() {
        const info = await check({ force: true });
        if (info.error) throw new UpdateError("check_failed", info.error);
        if (!info.available) return { updated: false, current: info.current, latest: info.latest };
        if (!info.tarball?.startsWith(`https://api.github.com/repos/${info.repo}/tarball/`)) throw new UpdateError("unsafe_archive", "Unexpected archive location.");

        const work = mkdtempSync(join(tmpdir(), "byte-buddy-update-"));
        try {
            const res = await fetchImpl(info.tarball, { headers: { "User-Agent": "byte-buddy-updater" }, signal: AbortSignal.timeout(60_000) });
            if (!res.ok) throw new UpdateError("download_failed", `Download failed (${res.status}).`);
            const archive = Buffer.from(await res.arrayBuffer());
            if (archive.length > MAX_ARCHIVE) throw new UpdateError("download_failed", "Archive is too large.");
            writeFileSync(join(work, "release.tgz"), archive);
            mkdirSync(join(work, "stage"));
            await extract(work, "release.tgz", "stage");

            const tops = readdirSync(join(work, "stage"), { withFileTypes: true }).filter((entry) => entry.isDirectory());
            if (tops.length !== 1) throw new UpdateError("unsafe_archive", "Unexpected archive layout.");
            const root = join(work, "stage", tops[0].name);
            for (const required of ["extension.mjs", "version.json"]) {
                if (!existsSync(join(root, required)) || lstatSync(join(root, required)).isSymbolicLink()) throw new UpdateError("unsafe_archive", `Release is missing ${required}.`);
            }
            const staged = JSON.parse(readFileSync(join(root, "version.json"), "utf8"));
            if (staged.version !== info.latest) throw new UpdateError("version_mismatch", `Release contains version ${staged.version}, expected ${info.latest}.`);

            const files = listFiles(root);
            const base = resolve(dir);
            const target = (rel) => {
                const path = resolve(base, rel);
                if (!path.startsWith(base + sep)) throw new UpdateError("unsafe_archive", `Path escapes the extension: ${rel}`);
                return path;
            };
            // Copy beside the target and rename so each file swaps atomically; version.json goes last.
            const ordered = [...files.filter((rel) => rel !== "version.json"), "version.json"];
            for (const rel of ordered) {
                const path = target(rel);
                mkdirSync(dirname(path), { recursive: true });
                copyFileSync(join(root, rel), `${path}.update-tmp`);
                renameSync(`${path}.update-tmp`, path);
            }
            // Remove only files a previous update installed that this release no longer ships.
            const manifestPath = join(base, MANIFEST);
            if (existsSync(manifestPath)) {
                try {
                    for (const rel of JSON.parse(readFileSync(manifestPath, "utf8"))) if (!files.includes(rel)) rmSync(target(rel), { force: true });
                } catch { /* A damaged manifest only skips stale-file cleanup. */ }
            }
            writeFileSync(manifestPath, JSON.stringify(files), "utf8");
        } finally {
            rmSync(work, { recursive: true, force: true });
        }
        cache = null;
        return { updated: true, current: info.current, latest: info.latest, restartRequired: true };
    }

    return {
        current: () => local().version,
        check,
        install: () => (installing ??= performInstall().finally(() => { installing = null; })),
    };
}

async function defaultExtract(cwd, archive, stage) {
    await run("tar", ["-xzf", archive, "-C", stage], { cwd, windowsHide: true });
}
