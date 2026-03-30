const { contextBridge, ipcRenderer } = require("electron");

const api = {
  onMenuAction: (callback) => {
    const handler = (_event, action) => callback(action);
    ipcRenderer.on("menu:action", handler);
    return () => ipcRenderer.removeListener("menu:action", handler);
  },
  openProject: async () => ipcRenderer.invoke("dialog:openProject"),
  saveProject: async (bytes, filePath) => ipcRenderer.invoke("dialog:saveProject", { bytes, filePath }),
  importTileset: async () => ipcRenderer.invoke("dialog:importTileset"),
  exportData: async (kind, bytes, suggestedName) =>
    ipcRenderer.invoke("dialog:export", { kind, bytes, suggestedName })
};

contextBridge.exposeInMainWorld("threeTileApi", api);
