import {
  app,
  BrowserWindow,
  Menu,
  MenuItemConstructorOptions,
  dialog,
  ipcMain
} from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;

type ExportKind = "geometry" | "texture" | "both";

function emitMenuAction(action: string): void {
  mainWindow?.webContents.send("menu:action", action);
}

function createMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: "File",
      submenu: [
        { label: "New", accelerator: "CmdOrCtrl+N", click: () => emitMenuAction("file:new") },
        { label: "Load", accelerator: "CmdOrCtrl+O", click: () => emitMenuAction("file:load") },
        { label: "Save", accelerator: "CmdOrCtrl+S", click: () => emitMenuAction("file:save") },
        {
          label: "Save As",
          accelerator: "CmdOrCtrl+Shift+S",
          click: () => emitMenuAction("file:saveAs")
        },
        { type: "separator" },
        { label: "Import Tilemap", click: () => emitMenuAction("file:importTileset") },
        {
          label: "Export",
          submenu: [
            { label: "Geometry", click: () => emitMenuAction("file:exportGeometry") },
            { label: "Texture", click: () => emitMenuAction("file:exportTexture") },
            { label: "Both", click: () => emitMenuAction("file:exportBoth") }
          ]
        },
        { type: "separator" },
        { role: "quit", label: "Quit" }
      ]
    },
    {
      label: "Edit",
      submenu: [
        { label: "Undo", accelerator: "CmdOrCtrl+Z", click: () => emitMenuAction("edit:undo") },
        { label: "Redo", accelerator: "CmdOrCtrl+Y", click: () => emitMenuAction("edit:redo") },
        { type: "separator" },
        { label: "Preferences", accelerator: "CmdOrCtrl+,", click: () => emitMenuAction("edit:preferences") }
      ]
    },
    {
      label: "About",
      submenu: [
        {
          label: "About The App",
          click: async () => {
            await dialog.showMessageBox({
              type: "info",
              title: "About 3Tile",
              message: "3Tile",
              detail: `Version: ${app.getVersion()}\nGitHub: https://www.github.com/cjens00`
            });
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

async function createMainWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1920,
    height: 1080,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(app.getAppPath(), "electron", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
    console.error(`Renderer failed to load: [${errorCode}] ${errorDescription}`);
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error(`Renderer process gone: ${details.reason}`);
  });

  if (isDev) {
    await loadDevUrlWithRetry(mainWindow, "http://localhost:5173");
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    await mainWindow.loadFile(path.join(__dirname, "../../dist/index.html"));
  }
}

async function loadDevUrlWithRetry(window: BrowserWindow, url: string): Promise<void> {
  const maxAttempts = 20;
  const retryDelayMs = 300;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await window.loadURL(url);
      return;
    } catch (error) {
      if (attempt === maxAttempts) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
}

ipcMain.handle("dialog:openProject", async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: "Load 3Tile Project",
    filters: [{ name: "3Tile Project", extensions: ["3tile"] }],
    properties: ["openFile"]
  });

  if (canceled || filePaths.length === 0) {
    return null;
  }

  const filePath = filePaths[0];
  const data = await fs.readFile(filePath);
  return {
    filePath,
    bytes: Uint8Array.from(data)
  };
});

ipcMain.handle("dialog:saveProject", async (_event, payload: { bytes: Uint8Array; filePath?: string }) => {
  let filePath = payload.filePath;
  if (!filePath) {
    const result = await dialog.showSaveDialog({
      title: "Save 3Tile Project",
      defaultPath: "untitled.3tile",
      filters: [{ name: "3Tile Project", extensions: ["3tile"] }]
    });
    if (result.canceled || !result.filePath) {
      return null;
    }
    filePath = result.filePath;
  }

  await fs.writeFile(filePath, Buffer.from(payload.bytes));
  return { filePath };
});

ipcMain.handle("dialog:importTileset", async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: "Import Tilemap",
    filters: [{ name: "Image", extensions: ["png", "tga", "bmp"] }],
    properties: ["openFile"]
  });

  if (canceled || filePaths.length === 0) {
    return null;
  }

  const filePath = filePaths[0];
  const bytes = await fs.readFile(filePath);
  return {
    filePath,
    bytes: Uint8Array.from(bytes)
  };
});

ipcMain.handle(
  "dialog:export",
  async (_event, payload: { kind: ExportKind; bytes: Uint8Array; suggestedName: string }) => {
    const extensionMap: Record<ExportKind, string[]> = {
      geometry: ["obj", "gltf"],
      texture: ["png", "bmp", "tga"],
      both: ["glb"]
    };

    const result = await dialog.showSaveDialog({
      title: `Export ${payload.kind}`,
      defaultPath: payload.suggestedName,
      filters: [{ name: "Supported", extensions: extensionMap[payload.kind] }]
    });

    if (result.canceled || !result.filePath) {
      return null;
    }

    await fs.writeFile(result.filePath, Buffer.from(payload.bytes));
    return { filePath: result.filePath };
  }
);

app.whenReady().then(async () => {
  createMenu();
  await createMainWindow();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
