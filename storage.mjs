// Immutable cold generations plus a small atomic hot manifest. Never rewrites the legacy save.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

const digest = (text) => createHash("sha256").update(text).digest("hex");
const referenceName = /^(evidence|projection)-(live|demo)-(tickets|github|derived)-[a-f0-9-]+\.json$/;

export function createSplitStorage(dir) {
    const file = join(dir, "buddy.hot.json");
    const backup = join(dir, "buddy.hot.backup.json");
    let active = null;
    const loaded = new Map();
    const dirty = new Set();
    const bytes = (ref) => {
        if (!ref || !referenceName.test(ref.name)) throw new Error("Invalid storage reference; original save has not been changed.");
        const text = readFileSync(join(dir, ref.name), "utf8");
        if (digest(text) !== ref.sha256) throw new Error(`Storage checksum mismatch: ${ref.name}`);
        return JSON.parse(text);
    };
    const exists = (ref) => !!ref && referenceName.test(ref.name) && existsSync(join(dir, ref.name));
    const manifest = (path) => existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
    // Another Copilot session's process may have committed (and cleaned up) since this one loaded.
    const concurrent = () => {
        try {
            const current = manifest(file);
            return current?.storage?.format === 1 && current.storage.generation !== active?.storage.generation ? current : null;
        } catch { return null; }
    };
    const evidence = (mode, kind) => {
        const key = `${mode}:${kind}`;
        if (!loaded.has(key)) {
            const ref = active.storage.evidence[key];
            loaded.set(key, bytes(exists(ref) ? ref : concurrent()?.storage.evidence[key] ?? ref));
        }
        return loaded.get(key);
    };
    function read() {
        if (!existsSync(file) && !existsSync(backup)) return null;
        // A split store is authoritative once created: never silently resurrect stale buddy.json.
        let failure;
        for (const candidate of [file, backup]) {
            if (!existsSync(candidate)) continue;
            try {
                const raw = JSON.parse(readFileSync(candidate, "utf8"));
                if (raw.storage?.format !== 1 || !raw.profiles?.live || !raw.profiles?.demo) throw new Error("Invalid split-storage manifest");
                for (const ref of Object.values(raw.storage.evidence)) {
                    if (!referenceName.test(ref.name) || !existsSync(join(dir, ref.name))) throw new Error("Missing evidence generation");
                }
                active = raw;
                previousNames = new Set(names(raw));
                if (existsSync(backup)) {
                    try { for (const name of names(JSON.parse(readFileSync(backup, "utf8")))) previousNames.add(name); } catch { /* A corrupt backup is not a cleanup source. */ }
                }
                const projections = {};
                for (const mode of ["live", "demo"]) {
                    try { projections[mode] = bytes(raw.storage.projections[mode]); } catch { /* Derived data can be rebuilt from evidence. */ }
                    Object.defineProperty(raw.profiles[mode], "ledger", { enumerable: true, configurable: true, get: () => evidence(mode, "tickets"), set: (value) => { loaded.set(`${mode}:tickets`, value); dirty.add(`${mode}:tickets`); } });
                    Object.defineProperty(raw.profiles[mode].github, "records", { enumerable: true, configurable: true, get: () => evidence(mode, "github"), set: (value) => { loaded.set(`${mode}:github`, value); dirty.add(`${mode}:github`); } });
                }
                return { state: raw, projections };
            } catch (error) { failure = error; }
        }
        throw new Error(`Cannot read split storage; refusing stale legacy fallback: ${failure?.message}`);
    }
    function mark(mode, kind) { dirty.add(`${mode}:${kind}`); }
    function write(state, projections) {
        mkdirSync(dir, { recursive: true });
        const created = [];
        const publish = (prefix, value) => {
            const text = JSON.stringify(value);
            const name = `${prefix}-${randomUUID()}.json`;
            const path = join(dir, name);
            writeFileSync(path, text, { encoding: "utf8", flag: "wx" });
            created.push(path);
            const ref = { name, sha256: digest(text) };
            // Read-back parity before a manifest can reference new content.
            if (JSON.stringify(bytes(ref)) !== text) throw new Error("Storage read-back parity failed");
            return ref;
        };
        const next = { ...state, profiles: {}, storage: { format: 1, generation: randomUUID(), evidence: {}, projections: {} } };
        const temp = `${file}.${process.pid}.tmp`;
        const migrating = !active || active.version !== state.version;
        // If another process removed this process's unchanged evidence, follow its newer committed generation instead.
        const newer = migrating ? null : concurrent();
        try {
            for (const mode of ["live", "demo"]) {
                const profile = state.profiles[mode];
                const hot = {};
                for (const key of Object.keys(profile)) if (key !== "ledger" && key !== "github") hot[key] = profile[key];
                hot.github = {};
                for (const key of Object.keys(profile.github)) if (key !== "records") hot.github[key] = profile.github[key];
                next.profiles[mode] = hot;
                for (const [kind, get] of [["tickets", () => profile.ledger], ["github", () => profile.github.records]]) {
                    const key = `${mode}:${kind}`;
                    const reuse = dirty.has(key) ? null : [active?.storage.evidence[key], newer?.storage.evidence[key]].find(exists);
                    if (reuse && reuse !== active?.storage.evidence[key]) loaded.delete(key);
                    next.storage.evidence[key] = reuse || publish(`evidence-${mode}-${kind}`, get());
                }
                const projection = projections[mode];
                const old = active?.storage.projections[mode];
                next.storage.projections[mode] = old && old.key === projection.key && exists(old) ? old : { ...publish(`projection-${mode}-derived`, projection), key: projection.key };
            }
            // Verify that hot metadata, reward IDs and referenced evidence reconstruct the exact source.
            if (migrating) {
                for (const mode of ["live", "demo"]) {
                    const rebuilt = { ...next.profiles[mode], ledger: bytes(next.storage.evidence[`${mode}:tickets`]), github: { ...next.profiles[mode].github, records: bytes(next.storage.evidence[`${mode}:github`]) } };
                    if (digest(JSON.stringify(canonical(rebuilt))) !== digest(JSON.stringify(canonical(state.profiles[mode])))) throw new Error("Migration parity failed; legacy save remains authoritative");
                }
            }
            writeFileSync(temp, JSON.stringify(next), "utf8");
            // Do not back up corrupt or dangling content over a known-good recovery manifest.
            if (active && existsSync(file)) {
                let prior;
                try { prior = JSON.parse(readFileSync(file, "utf8")); } catch { /* Keep the valid recovery backup. */ }
                if (prior?.storage?.format === 1 && Object.values(prior.storage.evidence || {}).every(exists)) copyFileSync(file, backup);
            }
            renameSync(temp, file);
            active = next;
            dirty.clear();
        } catch (error) {
            for (const path of created) rmSync(path, { force: true });
            rmSync(temp, { force: true });
            throw error;
        }
        // Retain current + previous generations only. Cleanup is best-effort, never part of commit success.
        try { cleanup(); } catch { /* Interrupted cleanup leaves harmless unreferenced files. */ }
    }
    function cleanup() {
        const keep = new Set();
        // Re-read both manifests: another process may have committed after this process's rename.
        for (const current of [active, manifest(file), manifest(backup)]) {
            for (const name of names(current)) keep.add(name);
        }
        // Only known committed generations are candidates; interrupted orphans can be inspected manually.
        for (const name of previousNames) if (!keep.has(name)) rmSync(join(dir, name), { force: true });
        previousNames = keep;
    }
    function names(manifest) {
        return [...Object.values(manifest?.storage?.evidence || {}), ...Object.values(manifest?.storage?.projections || {})]
            .map((ref) => ref?.name).filter((name) => typeof name === "string" && referenceName.test(name));
    }
    let previousNames = new Set();
    function exportState(state, destination = join(dir, "buddy.rollback.json")) {
        if ([join(dir, "buddy.json"), file, backup].includes(destination)) throw new Error("Rollback export must not overwrite an active or immutable save");
        const { storage, ...legacy } = state;
        const temp = `${destination}.${process.pid}.tmp`;
        try {
            writeFileSync(temp, JSON.stringify(legacy, null, 2), "utf8");
            renameSync(temp, destination);
        } finally { rmSync(temp, { force: true }); }
        return destination;
    }
    return { file, read, write, mark, exportState };
}

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
    return value;
}
