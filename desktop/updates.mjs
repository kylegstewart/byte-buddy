import { compareVersions } from "../update.mjs";

const repository = "https://github.com/kylegstewart/byte-buddy";

export function createDesktopUpdater({ current, fetchImpl = fetch }) {
    let release = null;
    async function check() {
        release = null;
        const response = await fetchImpl("https://api.github.com/repos/kylegstewart/byte-buddy/releases/latest", { headers: { Accept: "application/vnd.github+json", "User-Agent": "byte-buddy-desktop" }, signal: AbortSignal.timeout(15_000) });
        if (response.status === 404) return { current, available: false, message: "No desktop release is published yet. Desktop updates use installers, never the Copilot gist updater." };
        if (!response.ok) throw new Error(`Desktop release check failed (${response.status}). Your installed application is unchanged.`);
        const data = await response.json();
        const latest = String(data.tag_name || "").replace(/^v/, "");
        const available = compareVersions(latest, current) > 0;
        const assets = (data.assets || []).filter((asset) => /\.exe$/i.test(asset.name || "") && typeof asset.browser_download_url === "string" && asset.browser_download_url.startsWith(`${repository}/releases/download/`));
        const installer = assets.find((asset) => /setup/i.test(asset.name)) || assets[0];
        if (available && installer) release = installer.browser_download_url;
        return { current, latest, available: Boolean(release), message: available && !installer ? "A newer release has no Windows installer yet." : release ? `Desktop ${latest} is available. Download and run its installer; local saves stay separate.` : `Desktop ${current} is up to date.` };
    }
    return { check, downloadUrl: () => release };
}
