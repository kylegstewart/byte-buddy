import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkVoiceWindow } from "./voice-smoke.mjs";

export async function checkDesktopWindow(window, screenshots) {
    window.webContents.setBackgroundThrottling(false);
    const evaluate = (callback) => window.webContents.executeJavaScript(`(${callback.toString()})()`);
    const result = await evaluate(() => new Promise((resolve, reject) => {
        const deadline = Date.now() + 15_000;
        const check = () => {
            const element = (id) => document.getElementById(id);
            if (!element("app")?.hasAttribute("aria-busy") && element("desktopStatus")?.textContent.startsWith("Desktop ") && !element("desktopConnections")?.hidden) {
                resolve({ name: element("buddyName").textContent, desktopBridge: typeof window.byteBuddyDesktop?.status === "function",
                    nodeUnavailable: typeof require === "undefined" && typeof process === "undefined", desktop: window.BUDDY_CONFIG.desktop,
                    title: document.title, freshStart: !element("desktopImportFolder") && typeof window.byteBuddyDesktop.importSave === "undefined",
                    deviceHidden: element("desktopGithubDevice").hidden && element("desktopGithubCode").hidden });
            } else if (Date.now() > deadline) reject(new Error("Desktop UI did not initialize"));
            else setTimeout(check, 100);
        };
        check();
    }));
    assert.ok(result.desktopBridge && result.nodeUnavailable && result.desktop && result.freshStart && result.deviceHidden, "Desktop isolation and onboarding");
    result.navigation = await evaluate(() => {
        const element = (id) => document.getElementById(id);
        const visible = (id) => element(id).getClientRects().length > 0;
        element("tab-customize").click();
        element("customize-accessories-tab").click();
        element("settingsBtn").click();
        const exportInSettings = visible("exportCurrentSave") && element("exportCurrentSave").closest("#settings") !== null;
        element("openLounge").click();
        const loungeOnly = visible("loungeView") && !visible("buddyView") && !visible("scene") && !visible("tab-home")
            && document.activeElement === element("loungeTitle") && element("settings").hidden
            && document.querySelectorAll("main:not([hidden])").length === 1;
        element("loungeBack").click();
        const restoredBuddy = visible("buddyView") && !visible("loungeView") && visible("panel-customize")
            && visible("accessoriesCustomize") && document.activeElement === element("tab-customize");
        element("openLounge").click();
        element("loungeConnections").click();
        const connectionsShortcut = visible("panel-connections") && !visible("loungeView") && document.activeElement === element("tab-connections");
        const tabs = document.querySelector(".tabs");
        tabs.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
        const keyboardHome = element("tab-home").getAttribute("aria-selected") === "true" && document.activeElement === element("tab-home");
        tabs.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
        const keyboardEnd = element("tab-connections").getAttribute("aria-selected") === "true";
        tabs.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
        const keyboardWrap = element("tab-home").getAttribute("aria-selected") === "true";
        const noRemovedTabs = !element("tab-how") && !element("panel-how") && !element("tab-lounge") && !element("panel-lounge");
        return { exportInSettings, loungeOnly, restoredBuddy, connectionsShortcut, keyboardHome, keyboardEnd, keyboardWrap, noRemovedTabs };
    });
    for (const [name, passed] of Object.entries(result.navigation)) assert.equal(passed, true, `Desktop navigation: ${name}`);
    if (screenshots) mkdirSync(screenshots, { recursive: true });
    const capture = async (name) => {
        if (!screenshots) return;
        const image = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
        writeFileSync(join(screenshots, name), image.toPNG());
    };
    window.webContents.debugger.attach("1.3");
    result.layouts = [];
    try {
        for (const width of [480, 960, 1200, 1800]) {
            await window.webContents.debugger.sendCommand("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
            const buddy = await evaluate(() => {
                const app = document.getElementById("app");
                const overview = document.querySelector(".buddy-overview").getBoundingClientRect();
                const details = document.querySelector(".buddy-details").getBoundingClientRect();
                return { viewport: innerWidth, available: document.documentElement.clientWidth, width: app.getBoundingClientRect().width, overflow: document.documentElement.scrollWidth > innerWidth + 1,
                    sideBySide: details.left >= overview.right, sceneWidth: document.getElementById("scene").getBoundingClientRect().width };
            });
            assert.equal(buddy.viewport, width);
            assert.ok(Math.abs(buddy.width - Math.min(buddy.available, 1440)) <= 1, `Fluid content width at ${width}px`);
            assert.equal(buddy.overflow, false, `Buddy horizontal overflow at ${width}px`);
            assert.equal(buddy.sideBySide, width >= 1100, `Buddy columns at ${width}px`);
            assert.ok(buddy.sceneWidth > 0);
            if (width === 1200 || width === 480) await capture(`buddy-${width}.png`);
            const lounge = await evaluate(() => {
                document.getElementById("openLounge").click();
                const sidebar = document.querySelector(".lounge-sidebar").getBoundingClientRect();
                const world = document.querySelector(".lounge-world").getBoundingClientRect();
                const room = document.getElementById("loungeRoom").getBoundingClientRect();
                const chat = document.getElementById("loungeChatForm");
                const chatHidden = chat.hidden;
                chat.hidden = false;
                const composer = chat.getBoundingClientRect();
                const send = document.getElementById("loungeChatSend").getBoundingClientRect();
                const chatInsideRoom = composer.left >= room.left && composer.right <= room.right
                    && composer.top >= room.top && composer.bottom <= room.bottom;
                const chatFits = send.right <= composer.right && composer.height > 0
                    && document.documentElement.scrollWidth <= innerWidth + 1;
                const stableRoomHeight = document.getElementById("loungeRoom").getBoundingClientRect().height === room.height;
                chat.hidden = chatHidden;
                return { overflow: document.documentElement.scrollWidth > innerWidth + 1, sideBySide: world.left >= sidebar.right,
                    roomWidth: room.width, roomHeight: room.height, buddyHidden: document.getElementById("buddyView").hidden,
                    chatInsideRoom, chatFits, stableRoomHeight };
            });
            assert.equal(lounge.overflow, false, `Lounge horizontal overflow at ${width}px`);
            assert.equal(lounge.sideBySide, width >= 960, `Lounge columns at ${width}px`);
            assert.ok(lounge.roomWidth > 0 && lounge.roomHeight > 0 && lounge.buddyHidden);
            assert.ok(lounge.chatInsideRoom && lounge.chatFits && lounge.stableRoomHeight, `In-room chat layout at ${width}px`);
            if (width === 1200 || width === 480) await capture(`lounge-${width}.png`);
            await evaluate(() => document.getElementById("loungeBack").click());
            result.layouts.push({ viewport: width, buddy, lounge });
        }
        const compact = await evaluate(() => {
            delete document.documentElement.dataset.desktop;
            const width = document.getElementById("app").getBoundingClientRect().width;
            document.documentElement.dataset.desktop = "true";
            return width;
        });
        assert.equal(compact, 760, "Copilot canvas retains its compact content width");
    } finally {
        await window.webContents.debugger.sendCommand("Emulation.clearDeviceMetricsOverride");
        window.webContents.debugger.detach();
    }
    result.voice = await checkVoiceWindow(window);
    for (const [name, passed] of Object.entries(result.voice)) assert.equal(passed, true, `Desktop voice: ${name}`);
    return result;
}
