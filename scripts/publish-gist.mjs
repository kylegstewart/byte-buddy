// Publishes the runtime files to the install gist when version.json has been bumped. Needs GIST_TOKEN (gist scope).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const { version, gist } = JSON.parse(readFileSync(join(root, "version.json"), "utf8"));
const token = process.env.GIST_TOKEN;
if (!token) throw new Error("GIST_TOKEN is not set.");
const api = `https://api.github.com/gists/${gist}`;
const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "byte-buddy-publisher" };

function runtimeFiles() {
    const out = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.isFile() && /\.mjs$/.test(entry.name) && !/\.test\.mjs$/.test(entry.name)) out.push(entry.name);
    }
    out.push("README.md", "version.json");
    for (const entry of readdirSync(join(root, "public"), { withFileTypes: true })) if (entry.isFile()) out.push(`public/${entry.name}`);
    return out;
}

const current = await (await fetch(api, { headers })).json();
if (!current.files) throw new Error(`Cannot read gist ${gist}: ${current.message}`);
const published = current.files["version.json"] ? JSON.parse(current.files["version.json"].content) : null;
if (published?.version === version) {
    process.stdout.write(`Gist already at ${version}; bump version.json to publish an update.\n`);
    process.exit(0);
}

// Gist names cannot contain "/", so nested paths use "\" exactly like the extension installer.
const files = { "copilot-extension.json": { content: JSON.stringify({ name: "dev-buddy", version: 1 }, null, 2) + "\n" } };
for (const rel of runtimeFiles()) files[rel.split("/").join("\\")] = { content: readFileSync(join(root, ...rel.split("/")), "utf8") };
// Remove files that no longer exist so old code does not linger in the gist.
for (const name of Object.keys(current.files)) if (!files[name]) files[name] = null;

const res = await fetch(api, { method: "PATCH", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ files }) });
if (!res.ok) throw new Error(`Gist update failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
process.stdout.write(`Published ${version} to gist ${gist}.\n`);
