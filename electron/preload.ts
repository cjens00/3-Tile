import { contextBridge, ipcRenderer } from "electron";

type ExportKind = "geometry" | "texture" | "both";

const api = {
  onMenuAction: (callback: (action: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, action: string) => callback(action);
    ipcRenderer.on("menu:action", handler);
    return () => ipcRenderer.removeListener("menu:action", handler);
  },
  openProject: async () => ipcRenderer.invoke("dialog:openProject"),
  saveProject: async (bytes: Uint8Array, filePath?: string) =>
    ipcRenderer.invoke("dialog:saveProject", { bytes, filePath }),
  importTileset: async () => ipcRenderer.invoke("dialog:importTileset"),
  exportData: async (kind: ExportKind, bytes: Uint8Array, suggestedName: string) =>
    ipcRenderer.invoke("dialog:export", { kind, bytes, suggestedName })
};

contextBridge.exposeInMainWorld("threeTileApi", api);
