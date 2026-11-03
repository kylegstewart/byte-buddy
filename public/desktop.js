const bridge = window.byteBuddyDesktop;
const element = (id) => document.getElementById(id);
let loginTimer = null;
let latestAuth = null;

function renderAuth(auth) {
    latestAuth = auth;
    const busy = ["checking", "signing-in"].includes(auth.status);
    element("desktopGithubStatus").textContent = auth.message;
    element("desktopGithubCode").hidden = !auth.code;
    element("desktopGithubCode").textContent = auth.code ? `One-time GitHub code: ${auth.code}` : "";
    element("desktopGithubDevice").hidden = auth.status !== "signing-in" || !auth.code;
    element("desktopGithubCancel").hidden = !busy;
    element("desktopGithubLogin").disabled = busy || auth.status === "signed-in";
    element("desktopGithubLogin").textContent = auth.status === "signed-in" ? "GitHub connected" : "Sign in with GitHub";
    clearTimeout(loginTimer);
    if (busy) loginTimer = setTimeout(() => bridge.status().then((status) => renderAuth(status.github)).catch(showError), 1000);
}

function showError(error) {
    element("desktopStatus").textContent = `Desktop action failed: ${error.message}`;
}

function bind(id, action) {
    element(id).addEventListener("click", async () => {
        const button = element(id);
        button.disabled = true;
        try {
            const result = await action();
            if (result?.restarting) element("desktopStatus").textContent = "Restarting Byte Buddy. Your local progress is retained.";
        } catch (error) { showError(error); }
        finally {
            button.disabled = false;
            if (latestAuth && id.startsWith("desktopGithub")) renderAuth(latestAuth);
        }
    });
}

async function initDesktop() {
    element("desktopConnections").hidden = false;
    document.documentElement.dataset.desktop = "true";
    const status = await bridge.status();
    element("desktopStatus").textContent = `Desktop ${status.version} · local profile ${status.userId}. Standalone progress is saved on this computer. Copilot saves are not imported.`;
    element("desktopDataPath").textContent = `Local data: ${status.root}`;
    element("desktopMcpStatus").textContent = status.mcpConfigPath ? `Connected configuration: ${status.mcpConfigPath} · ${status.serverName}` : "Not connected. Cached progress and the rest of Byte Buddy work without ticket access.";
    element("desktopTicketUser").value = status.userId;
    element("desktopMcpServer").value = status.serverName;
    element("desktopDisconnectMcp").disabled = !status.mcpConfigPath;
    renderAuth(status.github);
    bind("desktopOpenData", () => bridge.openData());
    bind("desktopChooseMcp", () => bridge.configureMcp({ userId: element("desktopTicketUser").value, serverName: element("desktopMcpServer").value.trim() }));
    bind("desktopDisconnectMcp", () => bridge.disconnectMcp());
    bind("desktopGithubCheck", async () => renderAuth(await bridge.githubCheck()));
    bind("desktopGithubLogin", async () => renderAuth(await bridge.githubLogin()));
    bind("desktopGithubCancel", async () => renderAuth(await bridge.githubCancel()));
    bind("desktopGithubDevice", () => bridge.githubDevice());
    bind("desktopInstallGithub", () => bridge.installGitHub());
    element("updateDetails").textContent = `Desktop ${status.version}. Check for Windows installer updates; Copilot gist updates are never installed into this app.`;
    element("installUpdate").textContent = "Download desktop update";
    bind("checkUpdates", async () => {
        const update = await bridge.checkUpdates();
        element("updateDetails").textContent = update.message;
        element("updateNoticeText").textContent = update.message;
        element("updateNotice").hidden = !update.available;
    });
    bind("installUpdate", () => bridge.downloadUpdate());
}

if (window.BUDDY_CONFIG?.desktop && bridge) void initDesktop().catch(showError);
