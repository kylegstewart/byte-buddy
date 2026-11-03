const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("byteBuddyDesktop", Object.freeze({
    status: () => ipcRenderer.invoke("desktop:status"),
    githubCheck: () => ipcRenderer.invoke("desktop:github-check"),
    githubLogin: () => ipcRenderer.invoke("desktop:github-login"),
    githubCancel: () => ipcRenderer.invoke("desktop:github-cancel"),
    githubDevice: () => ipcRenderer.invoke("desktop:github-device"),
    installGitHub: () => ipcRenderer.invoke("desktop:install-github"),
    configureMcp: (settings) => ipcRenderer.invoke("desktop:configure-mcp", settings),
    disconnectMcp: () => ipcRenderer.invoke("desktop:disconnect-mcp"),
    openData: () => ipcRenderer.invoke("desktop:open-data"),
    checkUpdates: () => ipcRenderer.invoke("desktop:check-updates"),
    downloadUpdate: () => ipcRenderer.invoke("desktop:download-update"),
}));
