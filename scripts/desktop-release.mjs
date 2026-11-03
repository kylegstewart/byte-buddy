import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compareVersions } from "../update.mjs";

export function readReleaseVersion(root) {
    const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error("Desktop releases require a stable major.minor.patch version.");
    const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
    const game = JSON.parse(readFileSync(join(root, "version.json"), "utf8"));
    if (lock.version !== version || lock.packages?.[""]?.version !== version || game.version !== version) {
        throw new Error("Keep package.json, package-lock.json, and version.json aligned. Use npm version patch --no-git-tag-version.");
    }
    return version;
}

export function createReleaseApi({ repository, token, fetchImpl = fetch }) {
    if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository || "")) throw new Error("Missing or invalid GITHUB_REPOSITORY.");
    if (!token) throw new Error("GH_TOKEN is required for release automation.");
    return async (path) => {
        const response = await fetchImpl("https://api.github.com/repos/" + repository + "/" + path, {
            headers: { Accept: "application/vnd.github+json", Authorization: "Bearer " + token, "User-Agent": "byte-buddy-release", "X-GitHub-Api-Version": "2022-11-28" },
            redirect: "error", signal: AbortSignal.timeout(30_000)
        });
        if (response.status === 404) return null;
        if (!response.ok) throw new Error("GitHub release lookup failed (" + response.status + "). No release was changed.");
        return response.json();
    };
}

export async function planDesktopRelease({ version, commit, api }) {
    if (!/^[a-f0-9]{40}$/.test(commit || "")) throw new Error("GITHUB_SHA must identify the exact build commit.");
    const tag = "v" + version;
    let existing = await api("releases/tags/" + tag);
    if (!existing) {
        for (let page = 1; ; page++) {
            const releases = await api("releases?per_page=100&page=" + page);
            if (!Array.isArray(releases)) throw new Error("Could not list repository releases; check repository access before retrying.");
            existing = releases.find((release) => release.tag_name === tag);
            if (existing || releases.length < 100) break;
        }
    }
    if (existing && !existing.draft) return { publish: false, tag, reason: tag + " is already published; bump the app version for another release." };
    const latest = await api("releases/latest");
    if (latest && compareVersions(version, String(latest.tag_name).replace(/^v/, "")) <= 0) throw new Error("The app version must be newer than the latest published release (" + latest.tag_name + ").");
    const reference = await api("git/ref/tags/" + tag);
    let target = reference?.object;
    for (let depth = 0; target?.type === "tag" && depth < 5; depth++) {
        target = (await api("git/tags/" + target.sha))?.object;
    }
    if (reference && (target?.type !== "commit" || target.sha !== commit)) throw new Error(tag + " already points to another commit. Use a new version; release tags are never moved.");
    if (existing && (existing.prerelease || (!reference && existing.target_commitish !== commit))) throw new Error("The existing draft does not match this stable release commit. Review it before retrying.");
    return { publish: true, tag, draft: Boolean(existing), reason: "Ready to publish " + tag + " from " + commit + "." };
}

export function releaseAssets(root, version) {
    const directory = join(root, "release");
    const required = ["Byte Buddy Setup " + version + ".exe", "Byte Buddy " + version + ".exe"];
    const assets = required.map((name) => join(directory, name));
    const blockmap = join(directory, required[0] + ".blockmap");
    if (existsSync(blockmap)) assets.push(blockmap);
    for (const asset of assets) {
        if (!existsSync(asset) || !statSync(asset).isFile() || statSync(asset).size === 0) throw new Error("Missing or empty release asset: " + asset);
    }
    return assets;
}

export async function publishDesktopRelease({ root, version, repository, commit, api, run = (args) => execFileSync("gh", args, { stdio: "inherit" }) }) {
    const plan = await planDesktopRelease({ version, commit, api });
    if (!plan.publish) return plan;
    const assets = releaseAssets(root, version);
    if (!plan.draft) {
        await run(["release", "create", plan.tag, "--repo", repository, "--target", commit, "--draft", "--title", "Byte Buddy " + version, "--generate-notes", "--notes", "Windows x64 desktop builds. Download and run the Setup installer to update; local progress is retained. These builds are unsigned; follow your device and organization policies."]);
    }
    await run(["release", "upload", plan.tag, ...assets, "--repo", repository, "--clobber"]);
    await run(["release", "edit", plan.tag, "--repo", repository, "--draft=false", "--prerelease=false", "--latest"]);
    return { ...plan, reason: "Published " + plan.tag + " with tested Windows installers." };
}

export async function runReleaseCommand({ root, command, environment = process.env, fetchImpl, run }) {
    if (!["plan", "publish"].includes(command)) throw new Error("Usage: node scripts/desktop-release.mjs plan|publish");
    const version = readReleaseVersion(root);
    if (command === "plan" && environment.GITHUB_EVENT_NAME === "workflow_dispatch") {
        return { version, build: true, publish: false, reason: "Manual run: build artifacts only; no GitHub release will be published." };
    }
    if (environment.GITHUB_EVENT_NAME !== "push" || environment.GITHUB_REF !== "refs/heads/main") throw new Error("Automatic publishing is restricted to pushes to main.");
    const repository = environment.GITHUB_REPOSITORY;
    const commit = environment.GITHUB_SHA;
    const api = createReleaseApi({ repository, token: environment.GH_TOKEN, fetchImpl });
    const options = { root, version, repository, commit, api, run };
    const result = command === "plan" ? await planDesktopRelease(options) : await publishDesktopRelease(options);
    return { version, build: result.publish, ...result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    try {
        const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
        const result = await runReleaseCommand({ root, command: process.argv[2] });
        if (process.env.GITHUB_OUTPUT && process.argv[2] === "plan") {
            appendFileSync(process.env.GITHUB_OUTPUT, "version=" + result.version + "\nbuild=" + result.build + "\npublish=" + result.publish + "\n");
        }
        process.stdout.write(result.reason + "\n");
    } catch (error) {
        process.stderr.write(error.message + "\n");
        process.exitCode = 1;
    }
}
