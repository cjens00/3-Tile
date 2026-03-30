import {
  LayerPaint,
  ProjectFile,
  Quad,
  TextureLayer,
  TilesetRef,
  createEmptyProject,
  deserializeProject,
  serializeProject
} from "../shared/project";
import {
  CreationPlane,
  DEFAULT_PREFERENCES,
  EditorMode,
  EditorPreferences,
  HotkeyBinding,
  SelectionMode,
  WorkspaceBounds
} from "../shared/preferences";
import { MeshModel } from "./modeling/mesh";
import { normalizeTilesetScale, parseTileset, validateTileset } from "./texturing/tileset";
import { WebGpuViewport } from "./webgpu";

export type ExportKind = "geometry" | "texture" | "both";

type ViewState = {
  backgroundColor: string;
  gridXYScale: number;
  gridXYOpacity: number;
  gridYZScale: number;
  gridYZOpacity: number;
  gridXZScale: number;
  gridXZOpacity: number;
};

type HotkeyAction =
  | "viewportRotate"
  | "viewportPan"
  | "viewportZoomIn"
  | "viewportZoomOut"
  | "lockXYPlane"
  | "lockYZPlane"
  | "lockXZPlane"
  | "cancelPlaneLock"
  | "flythroughHold"
  | "flyForward"
  | "flyLeft"
  | "flyBackward"
  | "flyRight"
  | "selectVertexMode"
  | "selectEdgeMode"
  | "selectFaceMode"
  | "boxSelectMode"
  | "creationLevelUp"
  | "creationLevelDown"
  | "undo"
  | "redo";

interface AppState {
  project: ProjectFile;
  projectPath?: string;
  mesh: MeshModel;
  mode: EditorMode;
  selectionMode: SelectionMode;
  creationTool: "single" | "box";
  creationPlane: CreationPlane;
  hoverCell?: { x: number; y: number; z: number };
  hoverVertexId?: string;
  hoverEdgeId?: string;
  hoverFaceId?: string;
  boxSelectArmed: boolean;
  boxSelectDragging: boolean;
  boxSelectOp: "replace" | "add" | "subtract";
  marquee: {
    active: boolean;
    startX: number;
    startY: number;
    endX: number;
    endY: number;
  };
  createPreviewCells: Array<{ x: number; y: number; z: number }>;
  gizmo: {
    hoverAxis?: "x" | "y" | "z";
    dragAxis?: "x" | "y" | "z";
    dragStartPx: { x: number; y: number };
    dragAccumUnits: number;
  };
  selectedVertexIds: string[];
  selectedEdgeIds: string[];
  selectedFaceIds: string[];
  selectedTilesetId?: string;
  selectedTileIndex: number;
  activeLayerId?: string;
  creationLevels: Record<"xy" | "yz" | "xz", number>;
  view: ViewState;
  preferences: EditorPreferences;
}

type EditorSnapshot = {
  project: ProjectFile;
  selectedVertexIds: string[];
  selectedEdgeIds: string[];
  selectedFaceIds: string[];
  creationPlane: CreationPlane;
  creationLevels: Record<"xy" | "yz" | "xz", number>;
};

const HOTKEY_LABELS: Record<HotkeyAction, string> = {
  viewportRotate: "Viewport Camera Rotate",
  viewportPan: "Viewport Camera Pan",
  viewportZoomIn: "Viewport Camera Zoom In",
  viewportZoomOut: "Viewport Camera Zoom Out",
  lockXYPlane: "Lock Creation to XY Plane",
  lockYZPlane: "Lock Creation to YZ Plane",
  lockXZPlane: "Lock Creation to XZ Plane",
  cancelPlaneLock: "Cancel Lock Creation Mode",
  flythroughHold: "Flythrough Mode (Hold)",
  flyForward: "Flythrough Forward",
  flyLeft: "Flythrough Left",
  flyBackward: "Flythrough Backward",
  flyRight: "Flythrough Right",
  selectVertexMode: "Vertex Selection Mode",
  selectEdgeMode: "Edge Selection Mode",
  selectFaceMode: "Face Selection Mode",
  boxSelectMode: "Box Select Mode",
  creationLevelUp: "Creation Level Up",
  creationLevelDown: "Creation Level Down",
  undo: "Undo",
  redo: "Redo"
};

export function bootUi(): void {
  if (!window.threeTileApi) throw new Error("Preload bridge unavailable: window.threeTileApi is undefined.");
  const canvas = document.getElementById("viewport") as HTMLCanvasElement | null;
  const overlay = document.getElementById("viewportOverlay") as HTMLCanvasElement | null;
  if (!canvas || !overlay) throw new Error("Viewport canvases not found.");
  const viewport = new WebGpuViewport(canvas, overlay);

  const project = createEmptyProject();
  const state: AppState = {
    project,
    mesh: MeshModel.fromProject(project),
    mode: "creation",
    selectionMode: "face",
    creationTool: "single",
    creationPlane: "xy",
    hoverVertexId: undefined,
    hoverEdgeId: undefined,
    hoverFaceId: undefined,
    boxSelectArmed: false,
    boxSelectDragging: false,
    boxSelectOp: "replace",
    marquee: {
      active: false,
      startX: 0,
      startY: 0,
      endX: 0,
      endY: 0
    },
    createPreviewCells: [],
    gizmo: {
      hoverAxis: undefined,
      dragAxis: undefined,
      dragStartPx: { x: 0, y: 0 },
      dragAccumUnits: 0
    },
    selectedVertexIds: [],
    selectedEdgeIds: [],
    selectedFaceIds: [],
    selectedTileIndex: 0,
    activeLayerId: project.textureLayers[0]?.id,
    creationLevels: { xy: 0, yz: 0, xz: 0 },
    view: {
      backgroundColor: "#444444",
      gridXYScale: 10,
      gridXYOpacity: 70,
      gridYZScale: 10,
      gridYZOpacity: 25,
      gridXZScale: 10,
      gridXZOpacity: 25
    },
    preferences: loadPreferences()
  };
  state.view.gridXYOpacity = Math.round(clamp(state.preferences.camera.groundGridOpacity * 100, 10, 100));

  const statusEl = getEl("status");
  const creationPlaneLabelEl = getEl("creationPlaneLabel");
  const vertexCountEl = getEl("vertexCount");
  const edgeCountEl = getEl("edgeCount");
  const quadCountEl = getEl("quadCount");
  const tilesetCountEl = getEl("tilesetCount");
  const tilesetSelectEl = getInput("tilesetSelect", "select");
  const tilesetScaleEl = getInput("tilesetScale", "number");
  const tileIndexEl = getInput("tileIndex", "number");
  const tilemapPickerCanvas = document.getElementById("tilemapPickerCanvas") as HTMLCanvasElement | null;
  const tilemapPreviewFrame = getEl("tilemapPreviewFrame");
  const tilemapZoomValueEl = getEl("tilemapZoomValue");
  const tilemapUndockBtn = getInput("tilemapUndockBtn", "button");
  const tilemapDockBtn = getInput("tilemapDockBtn", "button");
  const tilemapPickerHost = getEl("tilemapPickerHost");
  const tileWidthPxEl = getInput("tileWidthPx", "number");
  const tileHeightPxEl = getInput("tileHeightPx", "number");
  const tilePaddingXEl = getInput("tilePaddingX", "number");
  const tilePaddingYEl = getInput("tilePaddingY", "number");
  const tileWidthDownBtn = getInput("tileWidthDownBtn", "button");
  const tileWidthUpBtn = getInput("tileWidthUpBtn", "button");
  const tileHeightDownBtn = getInput("tileHeightDownBtn", "button");
  const tileHeightUpBtn = getInput("tileHeightUpBtn", "button");
  const tilePaddingXDownBtn = getInput("tilePaddingXDownBtn", "button");
  const tilePaddingXUpBtn = getInput("tilePaddingXUpBtn", "button");
  const tilePaddingYDownBtn = getInput("tilePaddingYDownBtn", "button");
  const tilePaddingYUpBtn = getInput("tilePaddingYUpBtn", "button");
  const layerSelectEl = getInput("layerSelect", "select");
  const layerAddBtn = getInput("layerAddBtn", "button");
  const layerRemoveBtn = getInput("layerRemoveBtn", "button");
  const layerUpBtn = getInput("layerUpBtn", "button");
  const layerDownBtn = getInput("layerDownBtn", "button");
  const layerOpacityEl = getInput("layerOpacity", "range");
  const layerOpacityValueEl = getEl("layerOpacityValue");
  const layerVisibleEl = document.getElementById("layerVisible") as HTMLInputElement | null;
  const applyTilesetScaleEl = getInput("applyTilesetScale", "button");
  const tilesetMetaEl = getEl("tilesetMeta");
  const selectionModeBtn = getInput("selectionModeBtn", "button");
  const creationModeBtn = getInput("creationModeBtn", "button");
  const tilePaintModeBtn = getInput("tilePaintModeBtn", "button");
  const vertexSelectBtn = getInput("vertexSelectBtn", "button");
  const edgeSelectBtn = getInput("edgeSelectBtn", "button");
  const faceSelectBtn = getInput("faceSelectBtn", "button");
  const boxSelectBtn = getInput("boxSelectBtn", "button");
  const singleCreateBtn = getInput("singleCreateBtn", "button");
  const boxCreateBtn = getInput("boxCreateBtn", "button");
  const creationDockGroup = getEl("creationDockGroup");
  const selectionDockGroup = getEl("selectionDockGroup");
  const paintDockGroup = getEl("paintDockGroup");
  const paintFaceBtn = getInput("paintFaceBtn", "button");
  const clearSelectionBtn = getInput("clearSelectionBtn", "button");
  const viewBgEl = getInput("viewportBackground", "color");
  const gridXYScaleEl = getInput("gridXYScale", "number");
  const gridXYOpacityEl = getInput("gridXYOpacity", "range");
  const gridYZScaleEl = getInput("gridYZScale", "number");
  const gridYZOpacityEl = getInput("gridYZOpacity", "range");
  const gridXZScaleEl = getInput("gridXZScale", "number");
  const gridXZOpacityEl = getInput("gridXZOpacity", "range");
  const gridXYOpacityValEl = getEl("gridXYOpacityValue");
  const gridYZOpacityValEl = getEl("gridYZOpacityValue");
  const gridXZOpacityValEl = getEl("gridXZOpacityValue");
  const createLevelEl = getInput("createLevel", "number");
  const createLevelUpEl = getInput("createLevelUp", "button");
  const createLevelDownEl = getInput("createLevelDown", "button");
  const planeXYBtn = getInput("planeXYBtn", "button");
  const planeYZBtn = getInput("planeYZBtn", "button");
  const planeXZBtn = getInput("planeXZBtn", "button");
  const prefModal = getEl("preferencesModal");
  const prefHotkeysBtn = getInput("prefHotkeys", "button");
  const prefViewportBtn = getInput("prefViewport", "button");
  const prefGeometryBtn = getInput("prefGeometry", "button");
  const prefTilemapsBtn = getInput("prefTilemaps", "button");
  const prefTitleEl = getEl("prefTitle");
  const prefContentEl = getEl("prefContent");
  const prefCloseEl = getInput("prefClose", "button");
  let createDragActive = false;
  let createHistoryStart: EditorSnapshot | undefined;
  let transformHistoryStart: EditorSnapshot | undefined;
  let transformHistoryDirty = false;
  const undoStack: EditorSnapshot[] = [];
  const redoStack: EditorSnapshot[] = [];
  let createDragCreatedCount = 0;
  let createRectStartCell: { x: number; y: number; z: number } | undefined;
  let createRectEndCell: { x: number; y: number; z: number } | undefined;
  let flythroughHeld = false;
  let tilemapZoomPercent = 100;
  let tilemapPanActive = false;
  let tilemapPanStart = { x: 0, y: 0, left: 0, top: 0 };
  const tilemapImageCache = new Map<string, HTMLImageElement>();
  const tilemapPreviewMetricsByCanvas = new WeakMap<
    HTMLCanvasElement,
    {
      zoom: number;
      tileStrideX: number;
      tileStrideY: number;
      tileDrawW: number;
      tileDrawH: number;
      cols: number;
      rows: number;
    }
  >();
  let undockedTilemapWindow: Window | null = null;

  const setStatus = (message: string) => {
    if (statusEl) {
      statusEl.textContent = `${message} (Undo ${undoStack.length}/${getHistoryDepth()}, Redo ${redoStack.length})`;
    }
  };

  const getBounds = (): WorkspaceBounds => {
    const { minX, maxX, minY, maxY, minZ, maxZ } = state.preferences.bounds;
    return {
      minX: Math.min(minX, maxX),
      maxX: Math.max(minX, maxX),
      minY: Math.min(minY, maxY),
      maxY: Math.max(minY, maxY),
      minZ: Math.min(minZ, maxZ),
      maxZ: Math.max(minZ, maxZ)
    };
  };

  const getHistoryDepth = (): number => clamp(Math.trunc(state.preferences.historyDepth || 10), 1, 500);
  const ensureActiveLayer = (): TextureLayer => {
    if (!state.project.textureLayers.length) {
      state.project.textureLayers.push({
        id: crypto.randomUUID(),
        name: "Layer 1",
        visible: true,
        opacity: 1
      });
    }
    if (!state.activeLayerId || !state.project.textureLayers.some((layer) => layer.id === state.activeLayerId)) {
      state.activeLayerId = state.project.textureLayers[state.project.textureLayers.length - 1]?.id;
    }
    return state.project.textureLayers.find((layer) => layer.id === state.activeLayerId) ?? state.project.textureLayers[0];
  };

  const snapshot = (): EditorSnapshot => ({
    project: structuredClone(state.mesh.toProject(state.project)),
    selectedVertexIds: [...state.selectedVertexIds],
    selectedEdgeIds: [...state.selectedEdgeIds],
    selectedFaceIds: [...state.selectedFaceIds],
    creationPlane: state.creationPlane,
    creationLevels: { ...state.creationLevels }
  });

  const restoreSnapshot = (snap: EditorSnapshot): void => {
    state.project = structuredClone(snap.project);
    state.mesh = MeshModel.fromProject(state.project);
    state.selectedVertexIds = [...snap.selectedVertexIds];
    state.selectedEdgeIds = [...snap.selectedEdgeIds];
    state.selectedFaceIds = [...snap.selectedFaceIds];
    state.creationPlane = snap.creationPlane;
    state.creationLevels = { ...snap.creationLevels };
    clearBoxSelect();
    clearGizmo();
    state.hoverCell = undefined;
    state.hoverVertexId = undefined;
    state.hoverEdgeId = undefined;
    state.hoverFaceId = undefined;
    syncHud();
  };

  const snapshotSignature = (snap: EditorSnapshot): string =>
    JSON.stringify({
      project: snap.project,
      sv: [...snap.selectedVertexIds].sort(),
      se: [...snap.selectedEdgeIds].sort(),
      sf: [...snap.selectedFaceIds].sort(),
      plane: snap.creationPlane,
      levels: snap.creationLevels
    });

  const pushHistory = (before: EditorSnapshot): void => {
    const current = snapshot();
    if (snapshotSignature(before) === snapshotSignature(current)) {
      return;
    }
    const last = undoStack[undoStack.length - 1];
    if (last && snapshotSignature(last) === snapshotSignature(before)) {
      return;
    }
    undoStack.push(before);
    const maxDepth = getHistoryDepth();
    while (undoStack.length > maxDepth) undoStack.shift();
    redoStack.length = 0;
  };

  const pushViewportHistory = (before: EditorSnapshot): void => {
    pushHistory(before);
  };

  const undoAction = (): void => {
    const previous = undoStack.pop();
    if (!previous) {
      setStatus("Nothing to undo.");
      return;
    }
    redoStack.push(snapshot());
    restoreSnapshot(previous);
    setStatus("Undo.");
  };

  const redoAction = (): void => {
    const next = redoStack.pop();
    if (!next) {
      setStatus("Nothing to redo.");
      return;
    }
    undoStack.push(snapshot());
    restoreSnapshot(next);
    setStatus("Redo.");
  };

  const applyView = () => {
    viewport.setBackgroundColor(state.view.backgroundColor);
    viewport.setGridSettings("xy", {
      scale: state.view.gridXYScale,
      opacity: clamp(state.preferences.camera.groundGridOpacity, 0.1, 1)
    });
    // YZ slot stores active-plane overlay opacity (renderer applies it to the current creation plane).
    viewport.setGridSettings("yz", { scale: state.view.gridXYScale, opacity: clamp(state.preferences.camera.activePlaneOpacity, 0.1, 1) });
    viewport.setGridSettings("xz", { scale: state.view.gridXYScale, opacity: clamp(state.preferences.camera.activePlaneOpacity, 0.1, 1) });
    viewport.setFlythroughPreferences(
      state.preferences.camera.flythroughEnabled,
      state.preferences.camera.flythroughSensitivity
    );
    viewport.setViewportVisualPreferences({
      depthFadeEnabled: state.preferences.camera.depthFadeEnabled,
      depthFadeStrength: state.preferences.camera.depthFadeStrength,
      depthFadeExponent: state.preferences.camera.depthFadeExponent,
      gizmoScale: state.preferences.camera.gizmoScale,
      invertRotationX: state.preferences.camera.invertRotationX,
      invertRotationY: state.preferences.camera.invertRotationY
    });
  };

  const ensureTilemapImage = (tileset: TilesetRef): HTMLImageElement | undefined => {
    const cached = tilemapImageCache.get(tileset.id);
    if (cached) return cached.complete ? cached : undefined;
    if (!tileset.dataBase64) return undefined;
    const image = new Image();
    image.src = `data:${tileset.format === "png" ? "image/png" : tileset.format === "bmp" ? "image/bmp" : "image/x-tga"};base64,${tileset.dataBase64}`;
    image.onload = () => {
      renderTilemapPicker();
      if (undockedTilemapWindow && !undockedTilemapWindow.closed) {
        renderUndockedTilemapPicker();
      }
    };
    tilemapImageCache.set(tileset.id, image);
    return image.complete ? image : undefined;
  };

  const renderTilemapPickerToCanvas = (canvasEl: HTMLCanvasElement | null, frameEl?: HTMLElement | null): void => {
    if (!canvasEl) return;
    const ctx = canvasEl.getContext("2d");
    if (!ctx) return;
    const active = getActiveTileset(state.project, state.selectedTilesetId);
    const frameW = Math.max(1, frameEl?.clientWidth || canvasEl.clientWidth || canvasEl.width);
    const frameH = Math.max(1, frameEl?.clientHeight || canvasEl.clientHeight || canvasEl.height);
    const width = frameW;
    const height = frameH;
    canvasEl.width = width;
    canvasEl.height = height;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#0e0e0e";
    ctx.fillRect(0, 0, width, height);
    tilemapPreviewMetricsByCanvas.delete(canvasEl);
    if (!active) {
      ctx.fillStyle = "#9f9f9f";
      ctx.font = "12px sans-serif";
      ctx.fillText("Select a tilemap.", 10, 20);
      return;
    }
    const image = ensureTilemapImage(active);
    if (!image) {
      ctx.fillStyle = "#9f9f9f";
      ctx.font = "12px sans-serif";
      ctx.fillText("Tilemap image unavailable.", 10, 20);
      return;
    }
    const zoom = clamp(tilemapZoomPercent / 100, 0.25, 25);
    const drawW = Math.max(1, Math.floor(image.width * zoom));
    const drawH = Math.max(1, Math.floor(image.height * zoom));
    canvasEl.width = Math.max(frameW, drawW);
    canvasEl.height = Math.max(frameH, drawH);
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
    ctx.fillStyle = "#0e0e0e";
    ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);
    const drawX = 0;
    const drawY = 0;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(image, drawX, drawY, drawW, drawH);
    const tileW = Math.max(1, active.tileWidth || 8);
    const tileH = Math.max(1, active.tileHeight || 8);
    const paddingX = Math.max(0, active.paddingX || 0);
    const paddingY = Math.max(0, active.paddingY || 0);
    const stepX = tileW + paddingX;
    const stepY = tileH + paddingY;
    const cols = Math.max(1, Math.floor((image.width + paddingX) / Math.max(1, stepX)));
    const rows = Math.max(1, Math.floor((image.height + paddingY) / Math.max(1, stepY)));
    const displayTileW = tileW * zoom;
    const displayTileH = tileH * zoom;
    const displayStepX = stepX * zoom;
    const displayStepY = stepY * zoom;
    ctx.strokeStyle = "rgba(255,255,255,0.20)";
    ctx.lineWidth = 1;
    for (let c = 0; c <= cols; c += 1) {
      const x = drawX + c * displayStepX;
      ctx.beginPath();
      ctx.moveTo(x, drawY);
      ctx.lineTo(x, drawY + rows * displayStepY - paddingY * zoom);
      ctx.stroke();
    }
    for (let r = 0; r <= rows; r += 1) {
      const y = drawY + r * displayStepY;
      ctx.beginPath();
      ctx.moveTo(drawX, y);
      ctx.lineTo(drawX + cols * displayStepX - paddingX * zoom, y);
      ctx.stroke();
    }
    const selected = clamp(state.selectedTileIndex, 0, Math.max(0, cols * rows - 1));
    const selectedCol = selected % cols;
    const selectedRow = Math.floor(selected / cols);
    ctx.strokeStyle = "rgba(255,214,102,0.95)";
    ctx.lineWidth = 2;
    ctx.strokeRect(
      Math.round(drawX + selectedCol * displayStepX) + 0.5,
      Math.round(drawY + selectedRow * displayStepY) + 0.5,
      Math.max(1, Math.round(displayTileW) - 1),
      Math.max(1, Math.round(displayTileH) - 1)
    );
    tilemapPreviewMetricsByCanvas.set(canvasEl, {
      zoom,
      tileStrideX: stepX,
      tileStrideY: stepY,
      tileDrawW: tileW,
      tileDrawH: tileH,
      cols,
      rows
    });
  };

  const renderTilemapPicker = (): void => renderTilemapPickerToCanvas(tilemapPickerCanvas, tilemapPreviewFrame);

  const renderUndockedTilemapPicker = (): void => {
    if (!undockedTilemapWindow || undockedTilemapWindow.closed) return;
    const canvasEl = undockedTilemapWindow.document.getElementById("tilemapPickerCanvasUndocked") as HTMLCanvasElement | null;
    const frameEl = undockedTilemapWindow.document.getElementById("tilemapPreviewFrameUndocked") as HTMLElement | null;
    const zoomEl = undockedTilemapWindow.document.getElementById("tilemapZoomValueUndocked");
    if (zoomEl) zoomEl.textContent = `${Math.round(tilemapZoomPercent)}%`;
    renderTilemapPickerToCanvas(canvasEl, frameEl);
  };

  const buildQuadPaintLayers = (quadId: string): Array<{
    image: CanvasImageSource;
    sx: number;
    sy: number;
    sw: number;
    sh: number;
    opacity: number;
  }> => {
    const paints = state.project.layerPaints.filter((paint) => paint.quadId === quadId);
    if (paints.length === 0) return [];
    const paintByLayer = new Map(paints.map((paint) => [paint.layerId, paint] as const));
    const out: Array<{ image: CanvasImageSource; sx: number; sy: number; sw: number; sh: number; opacity: number }> = [];
    for (const layer of state.project.textureLayers) {
      if (!layer.visible || layer.opacity <= 0) continue;
      const paint = paintByLayer.get(layer.id);
      if (!paint) continue;
      const tileset = state.project.tilesets.find((item) => item.id === paint.tilesetId);
      if (!tileset) continue;
      const image = ensureTilemapImage(tileset);
      if (!image) continue;
      const src = resolveTileSourceRect(tileset, paint.tileIndex, image.naturalWidth || image.width, image.naturalHeight || image.height);
      if (!src) continue;
      out.push({
        image,
        sx: src.sx,
        sy: src.sy,
        sw: src.sw,
        sh: src.sh,
        opacity: clamp(layer.opacity, 0, 1)
      });
    }
    return out;
  };

  const syncHud = () => {
    state.mesh.setAllowNonManifold(state.preferences.geometry.allowNonManifoldGeometry);
    state.project = state.mesh.toProject(state.project);
    const activeLayer = ensureActiveLayer();
    const paintLookup = new Map<string, LayerPaint[]>();
    for (const paint of state.project.layerPaints) {
      const paints = paintLookup.get(paint.quadId) ?? [];
      paints.push(paint);
      paintLookup.set(paint.quadId, paints);
    }
    viewport.setScene({
      vertices: state.project.vertices,
      edges: state.project.edges.map((e) => ({ id: e.id, v0: e.v0, v1: e.v1 })),
      quads: state.project.quads.map((q) => {
        const paints = paintLookup.get(q.id) ?? [];
        const tinted = paintsToTint(state.project.textureLayers, paints);
        const paintLayers = buildQuadPaintLayers(q.id);
        return {
          id: q.id,
          axis: q.axis,
          vertexIds: q.vertexIds,
          paintTint: tinted,
          paintLayers
        };
      }),
      selectedVertexIds: state.selectedVertexIds,
      selectedEdgeIds: state.selectedEdgeIds,
      selectedFaceIds: state.selectedFaceIds,
      hoverCell: state.mode === "creation" ? state.hoverCell : undefined,
      hoverVertexId: state.mode === "selection" && state.selectionMode === "vertex" ? state.hoverVertexId : undefined,
      hoverEdgeId: state.mode === "selection" && state.selectionMode === "edge" ? state.hoverEdgeId : undefined,
      hoverFaceId:
        (state.mode === "selection" && state.selectionMode === "face") || state.mode === "tilePaint"
          ? state.hoverFaceId
          : undefined,
      marquee: state.marquee.active ? state.marquee : undefined,
      createPreviewCells: state.mode === "creation" ? state.createPreviewCells : undefined,
      gizmo: state.mode === "selection" ? buildGizmoState(state) : undefined,
      creationPlane: activeCreationPlane(state),
      activePlaneLevel: state.creationLevels[activeCreationPlane(state)]
    });
    if (vertexCountEl) vertexCountEl.textContent = String(state.project.vertices.length);
    if (edgeCountEl) edgeCountEl.textContent = String(state.project.edges.length);
    if (quadCountEl) quadCountEl.textContent = String(state.project.quads.length);
    if (tilesetCountEl) tilesetCountEl.textContent = String(state.project.tilesets.length);
    if (creationPlaneLabelEl) {
      const plane = activeCreationPlane(state).toUpperCase();
      const level = state.creationLevels[activeCreationPlane(state)];
      creationPlaneLabelEl.textContent = `${plane} @ ${plane === "XY" ? "Z" : plane === "YZ" ? "X" : "Y"}=${level}`;
    }

    if (tilesetSelectEl) {
      tilesetSelectEl.innerHTML = "";
      const noneOption = document.createElement("option");
      noneOption.value = "";
      noneOption.textContent = "None";
      tilesetSelectEl.append(noneOption);
      for (const tileset of state.project.tilesets) {
        const option = document.createElement("option");
        option.value = tileset.id;
        option.textContent = tileset.name;
        tilesetSelectEl.append(option);
      }
      tilesetSelectEl.value = state.selectedTilesetId ?? "";
    }
    if (tileIndexEl) tileIndexEl.value = String(state.selectedTileIndex);
    const activeTileset = getActiveTileset(state.project, state.selectedTilesetId);
    if (tilesetScaleEl) tilesetScaleEl.value = String(activeTileset?.scale ?? 1);
    const maxTileW = clamp(Math.trunc(state.preferences.tilemaps.maxTileWidth || 512), 1, 9999);
    const maxTileH = clamp(Math.trunc(state.preferences.tilemaps.maxTileHeight || 512), 1, 9999);
    const maxPadX = clamp(Math.trunc(state.preferences.tilemaps.maxPaddingX || 32), 0, 9999);
    const maxPadY = clamp(Math.trunc(state.preferences.tilemaps.maxPaddingY || 32), 0, 9999);
    if (tileWidthPxEl) {
      tileWidthPxEl.min = "1";
      tileWidthPxEl.max = String(maxTileW);
      tileWidthPxEl.value = String(activeTileset?.tileWidth ?? 8);
    }
    if (tileHeightPxEl) {
      tileHeightPxEl.min = "1";
      tileHeightPxEl.max = String(maxTileH);
      tileHeightPxEl.value = String(activeTileset?.tileHeight ?? 8);
    }
    if (tilePaddingXEl) {
      tilePaddingXEl.min = "0";
      tilePaddingXEl.max = String(maxPadX);
      tilePaddingXEl.value = String(activeTileset?.paddingX ?? 0);
    }
    if (tilePaddingYEl) {
      tilePaddingYEl.min = "0";
      tilePaddingYEl.max = String(maxPadY);
      tilePaddingYEl.value = String(activeTileset?.paddingY ?? 0);
    }
    if (tilemapZoomValueEl) tilemapZoomValueEl.textContent = `${Math.round(tilemapZoomPercent)}%`;
    if (tilesetMetaEl) {
      tilesetMetaEl.textContent = activeTileset
        ? `${activeTileset.format.toUpperCase()} ${activeTileset.width}x${activeTileset.height}`
        : "Import a tilemap from File menu.";
    }
    if (layerSelectEl) {
      layerSelectEl.innerHTML = "";
      for (let i = state.project.textureLayers.length - 1; i >= 0; i -= 1) {
        const layer = state.project.textureLayers[i];
        const option = document.createElement("option");
        option.value = layer.id;
        option.textContent = layer.visible ? layer.name : `${layer.name} (hidden)`;
        layerSelectEl.append(option);
      }
      layerSelectEl.value = activeLayer.id;
    }
    if (layerOpacityEl) layerOpacityEl.value = String(Math.round(activeLayer.opacity * 100));
    if (layerOpacityValueEl) layerOpacityValueEl.textContent = `${Math.round(activeLayer.opacity * 100)}%`;
    if (layerVisibleEl) layerVisibleEl.checked = activeLayer.visible;

    if (viewBgEl) viewBgEl.value = state.view.backgroundColor;
    if (gridXYScaleEl) gridXYScaleEl.value = String(state.view.gridXYScale);
    if (gridXYOpacityEl) gridXYOpacityEl.value = String(state.view.gridXYOpacity);
    if (createLevelEl) {
      const plane = activeCreationPlane(state);
      const bounds = getBounds();
      const min = plane === "xy" ? bounds.minZ : plane === "yz" ? bounds.minX : bounds.minY;
      const max = plane === "xy" ? bounds.maxZ : plane === "yz" ? bounds.maxX : bounds.maxY;
      createLevelEl.min = String(min);
      createLevelEl.max = String(max);
      createLevelEl.value = String(state.creationLevels[plane]);
    }
    if (gridYZScaleEl) gridYZScaleEl.value = String(state.view.gridYZScale);
    if (gridYZOpacityEl) gridYZOpacityEl.value = String(state.view.gridYZOpacity);
    if (gridXZScaleEl) gridXZScaleEl.value = String(state.view.gridXZScale);
    if (gridXZOpacityEl) gridXZOpacityEl.value = String(state.view.gridXZOpacity);
    if (gridXYOpacityValEl) gridXYOpacityValEl.textContent = `${Math.round(state.preferences.camera.groundGridOpacity * 100)}%`;
    if (gridYZOpacityValEl) gridYZOpacityValEl.textContent = `${state.view.gridYZOpacity}%`;
    if (gridXZOpacityValEl) gridXZOpacityValEl.textContent = `${state.view.gridXZOpacity}%`;

    selectionModeBtn?.classList.toggle("active", state.mode === "selection");
    creationModeBtn?.classList.toggle("active", state.mode === "creation");
    tilePaintModeBtn?.classList.toggle("active", state.mode === "tilePaint");
    singleCreateBtn?.classList.toggle("active", state.creationTool === "single");
    boxCreateBtn?.classList.toggle("active", state.creationTool === "box");
    if (creationDockGroup) creationDockGroup.style.display = state.mode === "creation" ? "flex" : "none";
    if (selectionDockGroup) selectionDockGroup.style.display = state.mode === "selection" ? "flex" : "none";
    if (paintDockGroup) paintDockGroup.style.display = state.mode === "tilePaint" ? "flex" : "none";
    paintFaceBtn?.classList.toggle("active", state.mode === "tilePaint");
    planeXYBtn?.classList.toggle("active", activeCreationPlane(state) === "xy");
    planeYZBtn?.classList.toggle("active", activeCreationPlane(state) === "yz");
    planeXZBtn?.classList.toggle("active", activeCreationPlane(state) === "xz");
    vertexSelectBtn?.classList.toggle("active", state.selectionMode === "vertex");
    edgeSelectBtn?.classList.toggle("active", state.selectionMode === "edge");
    faceSelectBtn?.classList.toggle("active", state.selectionMode === "face");
    boxSelectBtn?.classList.toggle("active", state.boxSelectArmed);
    renderTilemapPicker();
    renderUndockedTilemapPicker();
    applyView();
  };

  const clampLevelForPlane = (plane: "xy" | "yz" | "xz", raw: number): number => {
    const b = getBounds();
    if (plane === "xy") return clamp(raw, b.minZ, b.maxZ);
    if (plane === "yz") return clamp(raw, b.minX, b.maxX);
    return clamp(raw, b.minY, b.maxY);
  };

  const buildQuadInput = (
    plane: "xy" | "yz" | "xz",
    cell: { x: number; y: number; z: number }
  ): { axis: "x" | "y" | "z"; gridX: number; gridY: number; gridZ: number } => {
    const b = getBounds();
    if (plane === "xy") {
      return {
        axis: "z",
        gridX: clamp(cell.x, b.minX, b.maxX - 1),
        gridY: clamp(cell.y, b.minY, b.maxY - 1),
        gridZ: clamp(cell.z, b.minZ, b.maxZ)
      };
    }
    if (plane === "yz") {
      return {
        axis: "x",
        gridX: clamp(cell.x, b.minX, b.maxX),
        gridY: clamp(cell.y, b.minY, b.maxY - 1),
        gridZ: clamp(cell.z, b.minZ, b.maxZ - 1)
      };
    }
    return {
      axis: "y",
      gridX: clamp(cell.x, b.minX, b.maxX - 1),
      gridY: clamp(cell.y, b.minY, b.maxY),
      gridZ: clamp(cell.z, b.minZ, b.maxZ - 1)
    };
  };

  const resolveLockedCell = (event: Pick<MouseEvent, "clientX" | "clientY">): { x: number; y: number; z: number } | undefined => {
    const plane = activeCreationPlane(state);
    const fixed = clampLevelForPlane(plane, state.creationLevels[plane]);
    state.creationLevels[plane] = fixed;
    const picked = viewport.pickCell(event.clientX, event.clientY, plane, fixed) ?? undefined;
    if (picked) {
      // Keep hover authoritative to the exact action moment.
      state.hoverCell = picked;
    }
    return picked;
  };

  const startFlythroughInteraction = (): void => {
    flythroughHeld = true;
    canvas.style.cursor = "none";
    state.hoverCell = undefined;
    state.hoverVertexId = undefined;
    state.hoverEdgeId = undefined;
    state.hoverFaceId = undefined;
    state.gizmo.hoverAxis = undefined;
    state.createPreviewCells = [];
    clearBoxSelect();
    syncHud();
  };

  const stopFlythroughInteraction = (): void => {
    flythroughHeld = false;
    canvas.style.cursor = "";
    viewport.stopFlythrough();
    state.hoverCell = undefined;
    state.hoverVertexId = undefined;
    state.hoverEdgeId = undefined;
    state.hoverFaceId = undefined;
    state.gizmo.hoverAxis = undefined;
    state.createPreviewCells = [];
    syncHud();
  };

  const fillCreationRect = (
    start: { x: number; y: number; z: number },
    end: { x: number; y: number; z: number }
  ): number => {
    const plane = activeCreationPlane(state);
    let created = 0;
    const x0 = Math.min(start.x, end.x);
    const x1 = Math.max(start.x, end.x);
    const y0 = Math.min(start.y, end.y);
    const y1 = Math.max(start.y, end.y);
    const z0 = Math.min(start.z, end.z);
    const z1 = Math.max(start.z, end.z);
    const doCreate = (cell: { x: number; y: number; z: number }) => {
      const input = buildQuadInput(plane, cell);
      const result = state.mesh.addFillQuad(input, getBounds());
      if (!result.ok) return;
      assignTextureToQuad(state, result.quad);
      created += 1;
    };

    if (plane === "xy") {
      const z = state.creationLevels.xy;
      for (let x = x0; x <= x1; x += 1) {
        for (let y = y0; y <= y1; y += 1) doCreate({ x, y, z });
      }
      return created;
    }
    if (plane === "yz") {
      const x = state.creationLevels.yz;
      for (let y = y0; y <= y1; y += 1) {
        for (let z = z0; z <= z1; z += 1) doCreate({ x, y, z });
      }
      return created;
    }
    const y = state.creationLevels.xz;
    for (let x = x0; x <= x1; x += 1) {
      for (let z = z0; z <= z1; z += 1) doCreate({ x, y, z });
    }
    return created;
  };

  const buildCreationRectCells = (
    start: { x: number; y: number; z: number },
    end: { x: number; y: number; z: number }
  ): Array<{ x: number; y: number; z: number }> => {
    const plane = activeCreationPlane(state);
    const out: Array<{ x: number; y: number; z: number }> = [];
    const x0 = Math.min(start.x, end.x);
    const x1 = Math.max(start.x, end.x);
    const y0 = Math.min(start.y, end.y);
    const y1 = Math.max(start.y, end.y);
    const z0 = Math.min(start.z, end.z);
    const z1 = Math.max(start.z, end.z);
    if (plane === "xy") {
      const z = state.creationLevels.xy;
      for (let x = x0; x <= x1; x += 1) for (let y = y0; y <= y1; y += 1) out.push({ x, y, z });
      return out;
    }
    if (plane === "yz") {
      const x = state.creationLevels.yz;
      for (let y = y0; y <= y1; y += 1) for (let z = z0; z <= z1; z += 1) out.push({ x, y, z });
      return out;
    }
    const y = state.creationLevels.xz;
    for (let x = x0; x <= x1; x += 1) for (let z = z0; z <= z1; z += 1) out.push({ x, y, z });
    return out;
  };

  const clearSelection = () => {
    state.selectedVertexIds = [];
    state.selectedEdgeIds = [];
    state.selectedFaceIds = [];
  };

  const clearBoxSelect = () => {
    state.boxSelectArmed = false;
    state.boxSelectDragging = false;
    state.boxSelectOp = "replace";
    state.marquee.active = false;
  };

  const clearGizmo = () => {
    state.gizmo.hoverAxis = undefined;
    state.gizmo.dragAxis = undefined;
    state.gizmo.dragAccumUnits = 0;
  };

  const pickVertexIdAtPointer = (event: MouseEvent): string | undefined => {
    const p = toCanvasPixels(event, canvas);
    let best: { id: string; dist: number } | undefined;
    for (const vertex of state.project.vertices) {
      const s = viewport.projectWorldToScreen(vertex);
      if (!s) continue;
      const dist = Math.hypot(s.x - p.x, s.y - p.y);
      if (dist > 11) continue;
      if (!best || dist < best.dist) best = { id: vertex.id, dist };
    }
    return best?.id;
  };

  const pickEdgeIdAtPointer = (event: MouseEvent): string | undefined => {
    const p = toCanvasPixels(event, canvas);
    const verticesById = new Map(state.project.vertices.map((v) => [v.id, v] as const));
    let best: { id: string; dist: number } | undefined;
    for (const edge of state.project.edges) {
      const a = verticesById.get(edge.v0);
      const b = verticesById.get(edge.v1);
      if (!a || !b) continue;
      const pa = viewport.projectWorldToScreen(a);
      const pb = viewport.projectWorldToScreen(b);
      if (!pa || !pb) continue;
      const dist = distancePointToSegment(p.x, p.y, pa.x, pa.y, pb.x, pb.y);
      if (dist > 9) continue;
      if (!best || dist < best.dist) best = { id: edge.id, dist };
    }
    return best?.id;
  };

  const pickFaceIdAtPointer = (event: MouseEvent): string | undefined => {
    const p = toCanvasPixels(event, canvas);
    const verticesById = new Map(state.project.vertices.map((v) => [v.id, v] as const));
    let best: { id: string; score: number } | undefined;
    for (const quad of state.project.quads) {
      const verts = quad.vertexIds
        .map((id) => verticesById.get(id))
        .filter((value): value is NonNullable<typeof value> => Boolean(value));
      if (verts.length !== 4) continue;
      const pts = verts.map((v) => viewport.projectWorldToScreen(v)).filter((value): value is NonNullable<typeof value> => Boolean(value));
      if (pts.length !== 4) continue;
      if (!pointInQuad(p.x, p.y, pts[0], pts[1], pts[2], pts[3])) continue;
      const cx = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) * 0.25;
      const cy = (pts[0].y + pts[1].y + pts[2].y + pts[3].y) * 0.25;
      const score = Math.hypot(p.x - cx, p.y - cy);
      if (!best || score < best.score) best = { id: quad.id, score };
    }
    return best?.id;
  };

  const handleSelectionClick = (event: MouseEvent, additive: boolean) => {
    const before = snapshot();
    const id =
      state.selectionMode === "vertex"
        ? pickVertexIdAtPointer(event)
        : state.selectionMode === "edge"
          ? pickEdgeIdAtPointer(event)
          : pickFaceIdAtPointer(event);
    if (!id) {
      if (!additive) {
        clearSelection();
        pushViewportHistory(before);
        syncHud();
      }
      return;
    }
    if (state.selectionMode === "vertex") {
      state.selectedVertexIds = additive ? toggleId(state.selectedVertexIds, id) : [id];
      state.selectedEdgeIds = [];
      state.selectedFaceIds = [];
      pushViewportHistory(before);
      syncHud();
      return;
    }
    if (state.selectionMode === "edge") {
      state.selectedEdgeIds = additive ? toggleId(state.selectedEdgeIds, id) : [id];
      state.selectedVertexIds = [];
      state.selectedFaceIds = [];
      pushViewportHistory(before);
      syncHud();
      return;
    }
    state.selectedFaceIds = additive ? toggleId(state.selectedFaceIds, id) : [id];
    state.selectedVertexIds = [];
    state.selectedEdgeIds = [];
    pushViewportHistory(before);
    syncHud();
  };

  const applyBoxSelection = () => {
    const before = snapshot();
    const rect = normalizedRect(state.marquee.startX, state.marquee.startY, state.marquee.endX, state.marquee.endY);
    const verticesById = new Map(state.project.vertices.map((v) => [v.id, v] as const));

    if (state.selectionMode === "vertex") {
      const ids = state.project.vertices
        .filter((vertex) => {
          const p = viewport.projectWorldToScreen(vertex);
          return p ? pointInRect(p.x, p.y, rect) : false;
        })
        .map((vertex) => vertex.id);
      state.selectedVertexIds = applySelectionOperation(state.selectedVertexIds, ids, state.boxSelectOp);
      state.selectedEdgeIds = [];
      state.selectedFaceIds = [];
      if (
        !sameIds(before.selectedVertexIds, state.selectedVertexIds) ||
        !sameIds(before.selectedEdgeIds, state.selectedEdgeIds) ||
        !sameIds(before.selectedFaceIds, state.selectedFaceIds)
      ) {
        pushViewportHistory(before);
      }
      return;
    }

    if (state.selectionMode === "edge") {
      const ids = state.project.edges
        .filter((edge) => {
          const a = verticesById.get(edge.v0);
          const b = verticesById.get(edge.v1);
          if (!a || !b) return false;
          const p = viewport.projectWorldToScreen({
            x: (a.x + b.x) * 0.5,
            y: (a.y + b.y) * 0.5,
            z: (a.z + b.z) * 0.5
          });
          return p ? pointInRect(p.x, p.y, rect) : false;
        })
        .map((edge) => edge.id);
      state.selectedEdgeIds = applySelectionOperation(state.selectedEdgeIds, ids, state.boxSelectOp);
      state.selectedVertexIds = [];
      state.selectedFaceIds = [];
      if (
        !sameIds(before.selectedVertexIds, state.selectedVertexIds) ||
        !sameIds(before.selectedEdgeIds, state.selectedEdgeIds) ||
        !sameIds(before.selectedFaceIds, state.selectedFaceIds)
      ) {
        pushViewportHistory(before);
      }
      return;
    }

    const ids = state.project.quads
      .filter((quad) => {
        const verts = quad.vertexIds
          .map((id) => verticesById.get(id))
          .filter((value): value is NonNullable<typeof value> => Boolean(value));
        if (verts.length !== 4) return false;
        const p = viewport.projectWorldToScreen({
          x: (verts[0].x + verts[1].x + verts[2].x + verts[3].x) * 0.25,
          y: (verts[0].y + verts[1].y + verts[2].y + verts[3].y) * 0.25,
          z: (verts[0].z + verts[1].z + verts[2].z + verts[3].z) * 0.25
        });
        return p ? pointInRect(p.x, p.y, rect) : false;
      })
      .map((quad) => quad.id);
    state.selectedFaceIds = applySelectionOperation(state.selectedFaceIds, ids, state.boxSelectOp);
    state.selectedVertexIds = [];
    state.selectedEdgeIds = [];
    if (
      !sameIds(before.selectedVertexIds, state.selectedVertexIds) ||
      !sameIds(before.selectedEdgeIds, state.selectedEdgeIds) ||
      !sameIds(before.selectedFaceIds, state.selectedFaceIds)
    ) {
      pushViewportHistory(before);
    }
  };

  const collectSelectedVertexIdsForTransform = (): string[] => {
    if (state.selectionMode === "vertex") {
      return [...state.selectedVertexIds];
    }
    if (state.selectionMode === "edge") {
      const out = new Set<string>();
      for (const edgeId of state.selectedEdgeIds) {
        const edge = state.mesh.getEdge(edgeId);
        if (!edge) continue;
        out.add(edge.v0);
        out.add(edge.v1);
      }
      return [...out];
    }
    const out = new Set<string>();
    for (const faceId of state.selectedFaceIds) {
      const quad = state.mesh.getQuad(faceId);
      if (!quad) continue;
      for (const id of quad.vertexIds) out.add(id);
    }
    return [...out];
  };

  const pickGizmoAxis = (event: MouseEvent): "x" | "y" | "z" | undefined => {
    const pivot = computeSelectionPivot(state);
    if (!pivot) return undefined;
    const pivotScreen = viewport.projectWorldToScreen(pivot);
    if (!pivotScreen) return undefined;
    const axisLen = 2;
    const axes: Array<"x" | "y" | "z"> = ["x", "y", "z"];
    let best: { axis: "x" | "y" | "z"; dist: number } | undefined;
    for (const axis of axes) {
      const endWorld =
        axis === "x"
          ? { x: pivot.x + axisLen, y: pivot.y, z: pivot.z }
          : axis === "y"
            ? { x: pivot.x, y: pivot.y + axisLen, z: pivot.z }
            : { x: pivot.x, y: pivot.y, z: pivot.z + axisLen };
      const endScreen = viewport.projectWorldToScreen(endWorld);
      if (!endScreen) continue;
      const p = toCanvasPixels(event, canvas);
      const dist = distancePointToSegment(p.x, p.y, pivotScreen.x, pivotScreen.y, endScreen.x, endScreen.y);
      if (dist < 10 && (!best || dist < best.dist)) {
        best = { axis, dist };
      }
    }
    return best?.axis;
  };

  const applyGizmoDrag = (event: MouseEvent) => {
    const axis = state.gizmo.dragAxis;
    if (!axis) return;
    const pivot = computeSelectionPivot(state);
    if (!pivot) return;
    const pivotScreen = viewport.projectWorldToScreen(pivot);
    if (!pivotScreen) return;
    const axisEndWorld =
      axis === "x"
        ? { x: pivot.x + 2, y: pivot.y, z: pivot.z }
        : axis === "y"
          ? { x: pivot.x, y: pivot.y + 2, z: pivot.z }
          : { x: pivot.x, y: pivot.y, z: pivot.z + 2 };
    const axisEndScreen = viewport.projectWorldToScreen(axisEndWorld);
    if (!axisEndScreen) return;

    const axisVec = { x: axisEndScreen.x - pivotScreen.x, y: axisEndScreen.y - pivotScreen.y };
    const axisLen = Math.hypot(axisVec.x, axisVec.y) || 1;
    const axisDir = { x: axisVec.x / axisLen, y: axisVec.y / axisLen };
    const current = toCanvasPixels(event, canvas);
    const deltaPx = {
      x: current.x - state.gizmo.dragStartPx.x,
      y: current.y - state.gizmo.dragStartPx.y
    };
    const projected = deltaPx.x * axisDir.x + deltaPx.y * axisDir.y;
    const units = Math.round(projected / 24);
    const step = units - state.gizmo.dragAccumUnits;
    if (step === 0) return;

    const selectedVertices = collectSelectedVertexIdsForTransform();
    const result = state.mesh.translateVertices(
      selectedVertices,
      axis === "x" ? step : 0,
      axis === "y" ? step : 0,
      axis === "z" ? step : 0,
      getBounds()
    );
    if (!result.ok) {
      setStatus(`Transform blocked: ${result.detail}`);
      return;
    }
    if (!transformHistoryDirty && transformHistoryStart) {
      pushHistory(transformHistoryStart);
      transformHistoryDirty = true;
    }
    state.gizmo.dragAccumUnits = units;
    syncHud();
  };

  const updateHover = (event: MouseEvent) => {
    if (flythroughHeld) {
      state.hoverCell = undefined;
      state.hoverVertexId = undefined;
      state.hoverEdgeId = undefined;
      state.hoverFaceId = undefined;
      state.gizmo.hoverAxis = undefined;
      syncHud();
      return;
    }
    const plane = activeCreationPlane(state);
    const fixed = clampLevelForPlane(plane, state.creationLevels[plane]);
    state.creationLevels[plane] = fixed;
    state.hoverCell = state.mode === "creation" ? viewport.pickCell(event.clientX, event.clientY, plane, fixed) ?? undefined : undefined;
    state.hoverVertexId = undefined;
    state.hoverEdgeId = undefined;
    state.hoverFaceId = undefined;
    if (state.mode === "selection") {
      if (state.selectionMode === "vertex") {
        state.hoverVertexId = pickVertexIdAtPointer(event);
      } else if (state.selectionMode === "edge") {
        state.hoverEdgeId = pickEdgeIdAtPointer(event);
      } else {
        state.hoverFaceId = pickFaceIdAtPointer(event);
      }
    } else if (state.mode === "tilePaint") {
      state.hoverFaceId = pickFaceIdAtPointer(event);
    }
    syncHud();
  };

  const paintFaceAtPointer = (event: MouseEvent): void => {
    const quadId = pickFaceIdAtPointer(event);
    if (!quadId) return;
    const quad = state.mesh.getQuad(quadId);
    if (!quad) return;
    const before = snapshot();
    assignTextureToQuad(state, quad);
    pushHistory(before);
    setStatus("Tile painted.");
    syncHud();
  };

  const openPreferences = () => {
    prefModal?.classList.remove("hidden");
    renderPreferences("hotkeys");
  };

  const closePreferences = () => {
    prefModal?.classList.add("hidden");
  };

  const renderPreferences = (tab: "hotkeys" | "viewport" | "geometry" | "tilemaps") => {
    if (!prefContentEl || !prefTitleEl || !prefHotkeysBtn || !prefViewportBtn || !prefGeometryBtn || !prefTilemapsBtn) return;
    prefHotkeysBtn.classList.toggle("active", tab === "hotkeys");
    prefViewportBtn.classList.toggle("active", tab === "viewport");
    prefGeometryBtn.classList.toggle("active", tab === "geometry");
    prefTilemapsBtn.classList.toggle("active", tab === "tilemaps");
    prefTitleEl.textContent =
      tab === "hotkeys" ? "Hotkeys" : tab === "viewport" ? "Viewport" : tab === "geometry" ? "Geometry" : "Tilemaps";
    prefContentEl.innerHTML = "";

    if (tab === "viewport") {
      const flyEnabled = document.createElement("label");
      flyEnabled.className = "field";
      flyEnabled.innerHTML = `<span>Enable Flythrough</span><input id="prefFlyEnabled" type="checkbox" ${state.preferences.camera.flythroughEnabled ? "checked" : ""} />`;
      prefContentEl.append(flyEnabled);
      const sens = document.createElement("label");
      sens.className = "field";
      sens.innerHTML = `<span>Flythrough Sensitivity</span><input id="prefFlySens" type="number" min="0.01" max="10" step="0.01" value="${state.preferences.camera.flythroughSensitivity.toFixed(3)}" />`;
      prefContentEl.append(sens);
      const invertY = document.createElement("label");
      invertY.className = "field";
      invertY.innerHTML = `<span>Invert Rotation Y Axis</span><input id="prefInvertRotationY" type="checkbox" ${state.preferences.camera.invertRotationY ? "checked" : ""} />`;
      prefContentEl.append(invertY);
      const invertX = document.createElement("label");
      invertX.className = "field";
      invertX.innerHTML = `<span>Invert Rotation X Axis</span><input id="prefInvertRotationX" type="checkbox" ${state.preferences.camera.invertRotationX ? "checked" : ""} />`;
      prefContentEl.append(invertX);
      const gridOpacity = document.createElement("label");
      gridOpacity.className = "field";
      gridOpacity.innerHTML = `<span>Ground Grid Opacity (0.10-1.00)</span><input id="prefGridOpacity" type="number" min="0.10" max="1.00" step="0.01" value="${state.preferences.camera.groundGridOpacity.toFixed(2)}" />`;
      prefContentEl.append(gridOpacity);
      const activeOpacity = document.createElement("label");
      activeOpacity.className = "field";
      activeOpacity.innerHTML = `<span>Active Plane Opacity (0.10-1.00)</span><input id="prefActivePlaneOpacity" type="number" min="0.10" max="1.00" step="0.01" value="${state.preferences.camera.activePlaneOpacity.toFixed(2)}" />`;
      prefContentEl.append(activeOpacity);
      const historyDepth = document.createElement("label");
      historyDepth.className = "field";
      historyDepth.innerHTML = `<span>Undo/Redo History Depth</span><input id="prefHistoryDepth" type="number" min="1" max="500" step="1" value="${state.preferences.historyDepth}" />`;
      prefContentEl.append(historyDepth);
      const depthFadeEnabled = document.createElement("label");
      depthFadeEnabled.className = "field";
      depthFadeEnabled.innerHTML = `<span>Depth Fade Grid Lines</span><input id="prefDepthFadeEnabled" type="checkbox" ${state.preferences.camera.depthFadeEnabled ? "checked" : ""} />`;
      prefContentEl.append(depthFadeEnabled);
      const depthFadeStrength = document.createElement("label");
      depthFadeStrength.className = "field";
      depthFadeStrength.innerHTML = `<span>Depth Fade Strength (0.100-100.000)</span><input id="prefDepthFadeStrength" type="number" min="0.100" max="100.000" step="0.100" value="${state.preferences.camera.depthFadeStrength.toFixed(3)}" />`;
      prefContentEl.append(depthFadeStrength);
      const depthFadeExponent = document.createElement("label");
      depthFadeExponent.className = "field";
      depthFadeExponent.innerHTML = `<span>Depth Fade Exponent (1.000-8.000)</span><input id="prefDepthFadeExponent" type="number" min="1.000" max="8.000" step="0.100" value="${state.preferences.camera.depthFadeExponent.toFixed(3)}" />`;
      prefContentEl.append(depthFadeExponent);
      const gizmoScale = document.createElement("label");
      gizmoScale.className = "field";
      gizmoScale.innerHTML = `<span>Gizmo Scale (0.50-3.00)</span><input id="prefGizmoScale" type="number" min="0.50" max="3.00" step="0.05" value="${state.preferences.camera.gizmoScale.toFixed(2)}" />`;
      prefContentEl.append(gizmoScale);
      const hysteresisEnabled = document.createElement("label");
      hysteresisEnabled.className = "field";
      hysteresisEnabled.innerHTML = `<span>Enable Drag Create Hysteresis</span><input id="prefCreateHysteresisEnabled" type="checkbox" ${state.preferences.camera.dragCreateHysteresisEnabled ? "checked" : ""} />`;
      prefContentEl.append(hysteresisEnabled);
      const hysteresisFrames = document.createElement("label");
      hysteresisFrames.className = "field";
      hysteresisFrames.innerHTML = `<span>Drag Create Hysteresis Frames (1-4)</span><input id="prefCreateHysteresisFrames" type="number" min="1" max="4" step="1" value="${state.preferences.camera.dragCreateHysteresisFrames}" />`;
      prefContentEl.append(hysteresisFrames);
      const bounds = state.preferences.bounds;
      const boundsGroup = document.createElement("div");
      boundsGroup.className = "field";
      boundsGroup.innerHTML = `
        <span>Workspace Bounds</span>
        <div class="hotkey-row">
          <div>X Min / Max</div>
          <input id="prefMinX" type="number" step="1" value="${bounds.minX}" />
          <input id="prefMaxX" type="number" step="1" value="${bounds.maxX}" />
        </div>
        <div class="hotkey-row">
          <div>Y Min / Max</div>
          <input id="prefMinY" type="number" step="1" value="${bounds.minY}" />
          <input id="prefMaxY" type="number" step="1" value="${bounds.maxY}" />
        </div>
        <div class="hotkey-row">
          <div>Z Min / Max</div>
          <input id="prefMinZ" type="number" step="1" value="${bounds.minZ}" />
          <input id="prefMaxZ" type="number" step="1" value="${bounds.maxZ}" />
        </div>
      `;
      prefContentEl.append(boundsGroup);
      (prefContentEl.querySelector("#prefFlyEnabled") as HTMLInputElement).addEventListener("change", (e) => {
        state.preferences.camera.flythroughEnabled = (e.target as HTMLInputElement).checked;
        savePreferences(state.preferences);
        applyView();
        syncHud();
      });
      (prefContentEl.querySelector("#prefFlySens") as HTMLInputElement).addEventListener("change", (e) => {
        state.preferences.camera.flythroughSensitivity = clamp(
          Number((e.target as HTMLInputElement).value),
          0.01,
          10
        );
        savePreferences(state.preferences);
        applyView();
        syncHud();
      });
      (prefContentEl.querySelector("#prefInvertRotationY") as HTMLInputElement).addEventListener("change", (e) => {
        state.preferences.camera.invertRotationY = (e.target as HTMLInputElement).checked;
        savePreferences(state.preferences);
        applyView();
        syncHud();
      });
      (prefContentEl.querySelector("#prefInvertRotationX") as HTMLInputElement).addEventListener("change", (e) => {
        state.preferences.camera.invertRotationX = (e.target as HTMLInputElement).checked;
        savePreferences(state.preferences);
        applyView();
        syncHud();
      });
      (prefContentEl.querySelector("#prefGridOpacity") as HTMLInputElement).addEventListener("change", (e) => {
        state.preferences.camera.groundGridOpacity = clamp(Number((e.target as HTMLInputElement).value), 0.1, 1);
        state.view.gridXYOpacity = Math.round(state.preferences.camera.groundGridOpacity * 100);
        savePreferences(state.preferences);
        applyView();
        syncHud();
      });
      (prefContentEl.querySelector("#prefActivePlaneOpacity") as HTMLInputElement).addEventListener("change", (e) => {
        state.preferences.camera.activePlaneOpacity = clamp(Number((e.target as HTMLInputElement).value), 0.1, 1);
        savePreferences(state.preferences);
        applyView();
        syncHud();
      });
      (prefContentEl.querySelector("#prefHistoryDepth") as HTMLInputElement).addEventListener("change", (e) => {
        state.preferences.historyDepth = clamp(Math.trunc(Number((e.target as HTMLInputElement).value) || 10), 1, 500);
        savePreferences(state.preferences);
        syncHud();
      });
      (prefContentEl.querySelector("#prefDepthFadeEnabled") as HTMLInputElement).addEventListener("change", (e) => {
        state.preferences.camera.depthFadeEnabled = (e.target as HTMLInputElement).checked;
        savePreferences(state.preferences);
        applyView();
        syncHud();
      });
      (prefContentEl.querySelector("#prefDepthFadeStrength") as HTMLInputElement).addEventListener("change", (e) => {
        state.preferences.camera.depthFadeStrength = clamp(Number((e.target as HTMLInputElement).value), 0.1, 100);
        savePreferences(state.preferences);
        applyView();
        syncHud();
      });
      (prefContentEl.querySelector("#prefDepthFadeExponent") as HTMLInputElement).addEventListener("change", (e) => {
        state.preferences.camera.depthFadeExponent = clamp(Number((e.target as HTMLInputElement).value), 1, 8);
        savePreferences(state.preferences);
        applyView();
        syncHud();
      });
      (prefContentEl.querySelector("#prefGizmoScale") as HTMLInputElement).addEventListener("change", (e) => {
        state.preferences.camera.gizmoScale = clamp(Number((e.target as HTMLInputElement).value), 0.5, 3);
        savePreferences(state.preferences);
        applyView();
        syncHud();
      });
      (prefContentEl.querySelector("#prefCreateHysteresisEnabled") as HTMLInputElement).addEventListener("change", (e) => {
        state.preferences.camera.dragCreateHysteresisEnabled = (e.target as HTMLInputElement).checked;
        savePreferences(state.preferences);
      });
      (prefContentEl.querySelector("#prefCreateHysteresisFrames") as HTMLInputElement).addEventListener("change", (e) => {
        state.preferences.camera.dragCreateHysteresisFrames = clamp(Math.trunc(Number((e.target as HTMLInputElement).value) || 1), 1, 4);
        savePreferences(state.preferences);
      });
      const bindBound = (id: string, key: keyof WorkspaceBounds) => {
        (prefContentEl.querySelector(`#${id}`) as HTMLInputElement).addEventListener("change", (e) => {
          state.preferences.bounds[key] = Math.trunc(Number((e.target as HTMLInputElement).value) || 0);
          savePreferences(state.preferences);
          const plane = activeCreationPlane(state);
          state.creationLevels[plane] = clampLevelForPlane(plane, state.creationLevels[plane]);
          syncHud();
        });
      };
      bindBound("prefMinX", "minX");
      bindBound("prefMaxX", "maxX");
      bindBound("prefMinY", "minY");
      bindBound("prefMaxY", "maxY");
      bindBound("prefMinZ", "minZ");
      bindBound("prefMaxZ", "maxZ");
      return;
    }

    if (tab === "geometry") {
      const nonManifold = document.createElement("label");
      nonManifold.className = "field";
      nonManifold.innerHTML = `<span>Allow Non-Manifold Geometry</span><input id="prefAllowNonManifold" type="checkbox" ${state.preferences.geometry.allowNonManifoldGeometry ? "checked" : ""} />`;
      prefContentEl.append(nonManifold);
      const exportManifold = document.createElement("label");
      exportManifold.className = "field";
      exportManifold.style.marginLeft = "12px";
      exportManifold.innerHTML = `<span>Force Manifold Geometry On Export</span><input id="prefForceManifoldExport" type="checkbox" ${state.preferences.geometry.forceManifoldOnExport ? "checked" : ""} />`;
      prefContentEl.append(exportManifold);
      (prefContentEl.querySelector("#prefAllowNonManifold") as HTMLInputElement).addEventListener("change", (e) => {
        state.preferences.geometry.allowNonManifoldGeometry = (e.target as HTMLInputElement).checked;
        savePreferences(state.preferences);
        state.mesh.setAllowNonManifold(state.preferences.geometry.allowNonManifoldGeometry);
        syncHud();
      });
      (prefContentEl.querySelector("#prefForceManifoldExport") as HTMLInputElement).addEventListener("change", (e) => {
        state.preferences.geometry.forceManifoldOnExport = (e.target as HTMLInputElement).checked;
        savePreferences(state.preferences);
      });
      return;
    }

    if (tab === "tilemaps") {
      const t = state.preferences.tilemaps;
      const mkField = (id: string, label: string, value: number) => {
        const row = document.createElement("label");
        row.className = "field";
        row.innerHTML = `<span>${label}</span><input id="${id}" type="number" min="1" max="9999" step="1" value="${value}" />`;
        prefContentEl.append(row);
      };
      mkField("prefMaxTileW", "Max Tile Width", t.maxTileWidth);
      mkField("prefMaxTileH", "Max Tile Height", t.maxTileHeight);
      mkField("prefMaxPadX", "Max Padding X", t.maxPaddingX);
      mkField("prefMaxPadY", "Max Padding Y", t.maxPaddingY);
      const bind = (id: string, key: keyof typeof t) => {
        (prefContentEl.querySelector(`#${id}`) as HTMLInputElement).addEventListener("change", (e) => {
          const value = clamp(Math.trunc(Number((e.target as HTMLInputElement).value) || 1), 1, 9999);
          state.preferences.tilemaps[key] = value;
          savePreferences(state.preferences);
          syncHud();
        });
      };
      bind("prefMaxTileW", "maxTileWidth");
      bind("prefMaxTileH", "maxTileHeight");
      bind("prefMaxPadX", "maxPaddingX");
      bind("prefMaxPadY", "maxPaddingY");
      return;
    }

    (Object.keys(HOTKEY_LABELS) as HotkeyAction[]).forEach((action) => {
      const binding = state.preferences.hotkeys[action];
      const row = document.createElement("div");
      row.className = "hotkey-row";
      const modifier = binding.alt ? "Alt" : binding.shift ? "Shift" : binding.ctrl ? "Ctrl" : "None";
      const trigger = binding.mouseButton !== undefined ? `Mouse${binding.mouseButton}` : binding.wheel ? `Wheel${binding.wheel}` : binding.key ?? "";
      row.innerHTML = `
        <div>${HOTKEY_LABELS[action]}</div>
        <select data-field="modifier">
          <option ${modifier === "None" ? "selected" : ""}>None</option>
          <option ${modifier === "Alt" ? "selected" : ""}>Alt</option>
          <option ${modifier === "Shift" ? "selected" : ""}>Shift</option>
          <option ${modifier === "Ctrl" ? "selected" : ""}>Ctrl</option>
        </select>
        <input data-field="trigger" value="${trigger}" placeholder="w, Mouse2, Wheelup" />
      `;
      const modEl = row.querySelector("select") as HTMLSelectElement;
      const triggerEl = row.querySelector("input") as HTMLInputElement;
      const updateBinding = () => {
        const modifierValue = modEl.value.toLowerCase();
        const next: HotkeyBinding = {};
        if (modifierValue === "alt") next.alt = true;
        if (modifierValue === "shift") next.shift = true;
        if (modifierValue === "ctrl") next.ctrl = true;
        const triggerText = triggerEl.value.trim().toLowerCase();
        if (triggerText.startsWith("mouse")) {
          const button = Number(triggerText.replace("mouse", ""));
          if (button === 0 || button === 1 || button === 2) next.mouseButton = button;
        } else if (triggerText === "wheelup") {
          next.wheel = "up";
        } else if (triggerText === "wheeldown") {
          next.wheel = "down";
        } else {
          next.key = triggerText;
        }
        state.preferences.hotkeys[action] = next;
        savePreferences(state.preferences);
      };
      modEl.addEventListener("change", updateBinding);
      triggerEl.addEventListener("change", updateBinding);
      prefContentEl.append(row);
    });
  };

  window.addEventListener("keydown", (event) => {
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")) return;
    const flyForward = matchesKey(event, state.preferences.hotkeys.flyForward);
    const flyBackward = matchesKey(event, state.preferences.hotkeys.flyBackward);
    const flyLeft = matchesKey(event, state.preferences.hotkeys.flyLeft);
    const flyRight = matchesKey(event, state.preferences.hotkeys.flyRight);
    if (flythroughHeld) {
      if (flyForward) viewport.setFlyMove("forward", true);
      if (flyBackward) viewport.setFlyMove("backward", true);
      if (flyLeft) viewport.setFlyMove("left", true);
      if (flyRight) viewport.setFlyMove("right", true);
      return;
    }

    if ((event.key === "Delete" || event.key === "Backspace") && state.selectionMode === "face" && state.selectedFaceIds.length > 0) {
      const before = snapshot();
      const removed = state.mesh.deleteQuads(state.selectedFaceIds);
      if (removed > 0) {
        state.selectedFaceIds = [];
        state.selectedEdgeIds = [];
        state.selectedVertexIds = [];
        pushHistory(before);
        setStatus(removed === 1 ? "1 face deleted." : `${removed} faces deleted.`);
        syncHud();
      }
      event.preventDefault();
      return;
    }

    if ((state.boxSelectDragging || state.boxSelectArmed) && event.key.toLowerCase() === "escape") {
      clearBoxSelect();
      setStatus("Box select cancelled.");
      syncHud();
      return;
    }

    if (state.gizmo.dragAxis && event.key.toLowerCase() === "escape") {
      clearGizmo();
      setStatus("Transform cancelled.");
      syncHud();
      return;
    }

    if (matchesKey(event, state.preferences.hotkeys.lockXYPlane)) {
      const before = snapshot();
      state.creationPlane = "xy";
      pushViewportHistory(before);
      setStatus("Creation plane: XY");
      syncHud();
    } else if (matchesKey(event, state.preferences.hotkeys.lockYZPlane)) {
      const before = snapshot();
      state.creationPlane = "yz";
      pushViewportHistory(before);
      setStatus("Creation plane: YZ");
      syncHud();
    } else if (matchesKey(event, state.preferences.hotkeys.lockXZPlane)) {
      const before = snapshot();
      state.creationPlane = "xz";
      pushViewportHistory(before);
      setStatus("Creation plane: XZ");
      syncHud();
    } else if (matchesKey(event, state.preferences.hotkeys.cancelPlaneLock)) {
      if (state.selectedVertexIds.length || state.selectedEdgeIds.length || state.selectedFaceIds.length) {
        const before = snapshot();
        clearSelection();
        pushViewportHistory(before);
        setStatus("Selection cleared.");
      } else {
        state.creationPlane = "none";
        setStatus("Creation plane reset to XY.");
      }
      syncHud();
    } else if (matchesKey(event, state.preferences.hotkeys.selectVertexMode)) {
      const before = snapshot();
      state.mode = "selection";
      state.selectionMode = "vertex";
      pushViewportHistory(before);
      syncHud();
    } else if (matchesKey(event, state.preferences.hotkeys.selectEdgeMode)) {
      const before = snapshot();
      state.mode = "selection";
      state.selectionMode = "edge";
      pushViewportHistory(before);
      syncHud();
    } else if (matchesKey(event, state.preferences.hotkeys.selectFaceMode)) {
      const before = snapshot();
      state.mode = "selection";
      state.selectionMode = "face";
      pushViewportHistory(before);
      syncHud();
    } else if (matchesKey(event, state.preferences.hotkeys.boxSelectMode)) {
      if (state.mode === "selection") {
        state.boxSelectArmed = true;
        setStatus("Box select armed. Drag with LMB (Shift add, Ctrl subtract).");
        syncHud();
      }
    } else if (matchesKey(event, state.preferences.hotkeys.creationLevelUp)) {
      const plane = activeCreationPlane(state);
      const next = clampLevelForPlane(plane, state.creationLevels[plane] + 1);
      if (next !== state.creationLevels[plane]) {
        const before = snapshot();
        state.creationLevels[plane] = next;
        pushViewportHistory(before);
      }
      setStatus(`Creation level: ${state.creationLevels[plane]}`);
      syncHud();
    } else if (matchesKey(event, state.preferences.hotkeys.creationLevelDown)) {
      const plane = activeCreationPlane(state);
      const next = clampLevelForPlane(plane, state.creationLevels[plane] - 1);
      if (next !== state.creationLevels[plane]) {
        const before = snapshot();
        state.creationLevels[plane] = next;
        pushViewportHistory(before);
      }
      setStatus(`Creation level: ${state.creationLevels[plane]}`);
      syncHud();
    } else if (matchesKey(event, state.preferences.hotkeys.undo)) {
      undoAction();
      syncHud();
    } else if (matchesKey(event, state.preferences.hotkeys.redo)) {
      redoAction();
      syncHud();
    } else if (event.key.toLowerCase() === "a" && !event.altKey && !event.ctrlKey) {
      if (state.selectionMode === "vertex") {
        state.selectedVertexIds =
          state.selectedVertexIds.length === state.mesh.getAllVertexIds().length ? [] : state.mesh.getAllVertexIds();
        state.selectedEdgeIds = [];
        state.selectedFaceIds = [];
      } else if (state.selectionMode === "edge") {
        state.selectedEdgeIds =
          state.selectedEdgeIds.length === state.mesh.getAllEdgeIds().length ? [] : state.mesh.getAllEdgeIds();
        state.selectedVertexIds = [];
        state.selectedFaceIds = [];
      } else {
        state.selectedFaceIds =
          state.selectedFaceIds.length === state.mesh.getAllQuadIds().length ? [] : state.mesh.getAllQuadIds();
        state.selectedVertexIds = [];
        state.selectedEdgeIds = [];
      }
      syncHud();
    }

    if (flyForward) viewport.setFlyMove("forward", true);
    if (flyBackward) viewport.setFlyMove("backward", true);
    if (flyLeft) viewport.setFlyMove("left", true);
    if (flyRight) viewport.setFlyMove("right", true);
  });

  window.addEventListener("keyup", (event) => {
    if (matchesKey(event, state.preferences.hotkeys.flyForward)) viewport.setFlyMove("forward", false);
    if (matchesKey(event, state.preferences.hotkeys.flyBackward)) viewport.setFlyMove("backward", false);
    if (matchesKey(event, state.preferences.hotkeys.flyLeft)) viewport.setFlyMove("left", false);
    if (matchesKey(event, state.preferences.hotkeys.flyRight)) viewport.setFlyMove("right", false);
  });

  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  canvas.addEventListener("mousedown", (event) => {
    if (flythroughHeld && event.button !== 2) {
      return;
    }
    if (matchesMouse(event, state.preferences.hotkeys.viewportRotate)) {
      viewport.startOrbit(event.clientX, event.clientY);
      return;
    }
    if (matchesMouse(event, state.preferences.hotkeys.viewportPan)) {
      viewport.startPan(event.clientX, event.clientY);
      return;
    }
    if (matchesMouse(event, state.preferences.hotkeys.flythroughHold) && state.preferences.camera.flythroughEnabled) {
      viewport.startFlythrough(event.clientX, event.clientY);
      startFlythroughInteraction();
      return;
    }
    if (event.button === 0) {
      if (state.mode === "selection" && !state.boxSelectArmed && !event.shiftKey) {
        const axis = pickGizmoAxis(event);
        if (axis) {
          state.gizmo.dragAxis = axis;
          state.gizmo.dragStartPx = toCanvasPixels(event, canvas);
          state.gizmo.dragAccumUnits = 0;
          transformHistoryStart = snapshot();
          transformHistoryDirty = false;
          syncHud();
          return;
        }
      }
      if (state.mode === "selection" && state.boxSelectArmed) {
        state.boxSelectDragging = true;
        state.boxSelectOp = event.ctrlKey ? "subtract" : event.shiftKey ? "add" : "replace";
        state.marquee.active = true;
        state.marquee.startX = event.offsetX * (canvas.width / canvas.clientWidth);
        state.marquee.startY = event.offsetY * (canvas.height / canvas.clientHeight);
        state.marquee.endX = state.marquee.startX;
        state.marquee.endY = state.marquee.startY;
        syncHud();
        return;
      }
      updateHover(event);
      if (state.mode === "creation") {
        createDragActive = true;
        createDragCreatedCount = 0;
        createRectStartCell = resolveLockedCell(event);
        createRectEndCell = createRectStartCell;
        state.createPreviewCells =
          state.creationTool === "box" && createRectStartCell && createRectEndCell
            ? buildCreationRectCells(createRectStartCell, createRectEndCell)
            : [];
        createHistoryStart = snapshot();
        syncHud();
      } else if (state.mode === "tilePaint") {
        paintFaceAtPointer(event);
      } else {
        handleSelectionClick(event, event.shiftKey);
      }
    }
  });

  canvas.addEventListener("mousemove", (event) => {
    if (flythroughHeld) {
      viewport.dragTo(event.clientX, event.clientY);
      state.hoverCell = undefined;
      state.hoverVertexId = undefined;
      state.hoverEdgeId = undefined;
      state.hoverFaceId = undefined;
      state.gizmo.hoverAxis = undefined;
      syncHud();
      return;
    }
    viewport.dragTo(event.clientX, event.clientY);
    if (state.mode === "selection" && state.gizmo.dragAxis) {
      applyGizmoDrag(event);
      return;
    }
    if (state.mode === "selection" && !state.boxSelectDragging) {
      state.gizmo.hoverAxis = event.shiftKey ? undefined : pickGizmoAxis(event);
    }
    if (state.boxSelectDragging) {
      state.marquee.endX = event.offsetX * (canvas.width / canvas.clientWidth);
      state.marquee.endY = event.offsetY * (canvas.height / canvas.clientHeight);
      syncHud();
      return;
    }
    updateHover(event);
    if (state.mode === "creation" && createDragActive && (event.buttons & 1) === 1) {
      if (state.creationTool === "single") {
        return;
      }
      const cell = resolveLockedCell(event);
      if (cell) createRectEndCell = cell;
      if (createRectStartCell && createRectEndCell) {
        state.createPreviewCells = buildCreationRectCells(createRectStartCell, createRectEndCell);
      }
      syncHud();
    }
  });
  canvas.addEventListener("mouseleave", () => {
    state.hoverCell = undefined;
    state.hoverVertexId = undefined;
    state.hoverEdgeId = undefined;
    state.hoverFaceId = undefined;
    if (state.boxSelectDragging) {
      clearBoxSelect();
    }
    state.createPreviewCells = [];
    clearGizmo();
    syncHud();
  });

  window.addEventListener("mouseup", (event) => {
    if (event.button === 2 && flythroughHeld) {
      stopFlythroughInteraction();
      return;
    }
    viewport.endDrag();
    if (state.gizmo.dragAxis) {
      state.gizmo.dragAxis = undefined;
      state.gizmo.dragAccumUnits = 0;
      transformHistoryStart = undefined;
      transformHistoryDirty = false;
    }
    if (state.boxSelectDragging) {
      applyBoxSelection();
      clearBoxSelect();
    }
    createDragActive = false;
    if (createRectStartCell && createRectEndCell) {
      const rectAdded =
        state.creationTool === "single"
          ? fillCreationRect(createRectStartCell, createRectStartCell)
          : fillCreationRect(createRectStartCell, createRectEndCell);
      createDragCreatedCount += rectAdded;
      if (rectAdded > 0 && createHistoryStart) {
        pushHistory(createHistoryStart);
        syncHud();
      }
    }
    createRectStartCell = undefined;
    createRectEndCell = undefined;
    state.createPreviewCells = [];
    if (createDragCreatedCount > 0) {
      setStatus(
        createDragCreatedCount === 1 ? "1 quad created." : `${createDragCreatedCount} quads created.`
      );
    }
    createDragCreatedCount = 0;
    createHistoryStart = undefined;
    syncHud();
  });

  canvas.addEventListener("wheel", (event) => {
    const zoomIn = matchesWheel(event, state.preferences.hotkeys.viewportZoomIn);
    const zoomOut = matchesWheel(event, state.preferences.hotkeys.viewportZoomOut);
    if (zoomIn || zoomOut) {
      viewport.zoom(event.deltaY);
      event.preventDefault();
    }
  });

  selectionModeBtn?.addEventListener("click", () => {
    const before = snapshot();
    state.mode = "selection";
    clearBoxSelect();
    clearGizmo();
    pushViewportHistory(before);
    syncHud();
  });
  creationModeBtn?.addEventListener("click", () => {
    const before = snapshot();
    state.mode = "creation";
    clearBoxSelect();
    clearGizmo();
    pushViewportHistory(before);
    syncHud();
  });
  tilePaintModeBtn?.addEventListener("click", () => {
    const before = snapshot();
    state.mode = "tilePaint";
    clearBoxSelect();
    clearGizmo();
    pushViewportHistory(before);
    syncHud();
  });
  singleCreateBtn?.addEventListener("click", () => {
    state.creationTool = "single";
    state.createPreviewCells = [];
    syncHud();
  });
  boxCreateBtn?.addEventListener("click", () => {
    state.creationTool = "box";
    syncHud();
  });
  vertexSelectBtn?.addEventListener("click", () => {
    const before = snapshot();
    state.mode = "selection";
    state.selectionMode = "vertex";
    pushViewportHistory(before);
    syncHud();
  });
  edgeSelectBtn?.addEventListener("click", () => {
    const before = snapshot();
    state.mode = "selection";
    state.selectionMode = "edge";
    pushViewportHistory(before);
    syncHud();
  });
  faceSelectBtn?.addEventListener("click", () => {
    const before = snapshot();
    state.mode = "selection";
    state.selectionMode = "face";
    pushViewportHistory(before);
    syncHud();
  });
  clearSelectionBtn?.addEventListener("click", () => {
    const before = snapshot();
    clearSelection();
    clearBoxSelect();
    clearGizmo();
    pushViewportHistory(before);
    syncHud();
    setStatus("Selection cleared.");
  });
  boxSelectBtn?.addEventListener("click", () => {
    if (state.mode !== "selection") return;
    state.boxSelectArmed = true;
    setStatus("Box select armed. Drag with LMB (Shift add, Ctrl subtract).");
    syncHud();
  });

  viewBgEl?.addEventListener("input", () => {
    state.view.backgroundColor = viewBgEl.value;
    applyView();
  });
  bindGridSettings(gridXYScaleEl, gridXYOpacityEl, "gridXYScale", "gridXYOpacity", state, applyView, syncHud);
  bindGridSettings(gridYZScaleEl, gridYZOpacityEl, "gridYZScale", "gridYZOpacity", state, applyView, syncHud);
  bindGridSettings(gridXZScaleEl, gridXZOpacityEl, "gridXZScale", "gridXZOpacity", state, applyView, syncHud);
  gridXYOpacityEl?.addEventListener("change", () => {
    state.view.gridXYOpacity = clamp(Math.trunc(Number(gridXYOpacityEl.value) || 70), 10, 100);
    state.preferences.camera.groundGridOpacity = state.view.gridXYOpacity / 100;
    savePreferences(state.preferences);
    applyView();
    syncHud();
  });
  planeXYBtn?.addEventListener("click", () => {
    const before = snapshot();
    state.creationPlane = "xy";
    pushViewportHistory(before);
    syncHud();
  });
  planeYZBtn?.addEventListener("click", () => {
    const before = snapshot();
    state.creationPlane = "yz";
    pushViewportHistory(before);
    syncHud();
  });
  planeXZBtn?.addEventListener("click", () => {
    const before = snapshot();
    state.creationPlane = "xz";
    pushViewportHistory(before);
    syncHud();
  });
  createLevelEl?.addEventListener("change", () => {
    const plane = activeCreationPlane(state);
    const next = clampLevelForPlane(plane, Math.trunc(Number(createLevelEl.value) || 0));
    if (next !== state.creationLevels[plane]) {
      const before = snapshot();
      state.creationLevels[plane] = next;
      pushViewportHistory(before);
    }
    syncHud();
  });
  createLevelUpEl?.addEventListener("click", () => {
    const plane = activeCreationPlane(state);
    const next = clampLevelForPlane(plane, state.creationLevels[plane] + 1);
    if (next !== state.creationLevels[plane]) {
      const before = snapshot();
      state.creationLevels[plane] = next;
      pushViewportHistory(before);
    }
    syncHud();
  });
  createLevelDownEl?.addEventListener("click", () => {
    const plane = activeCreationPlane(state);
    const next = clampLevelForPlane(plane, state.creationLevels[plane] - 1);
    if (next !== state.creationLevels[plane]) {
      const before = snapshot();
      state.creationLevels[plane] = next;
      pushViewportHistory(before);
    }
    syncHud();
  });

  tilesetSelectEl?.addEventListener("change", () => {
    state.selectedTilesetId = tilesetSelectEl.value || undefined;
    syncHud();
  });
  const updateActiveTilemapField = (
    key: "tileWidth" | "tileHeight" | "paddingX" | "paddingY",
    rawValue: number
  ): void => {
    const active = getActiveTileset(state.project, state.selectedTilesetId);
    if (!active) {
      setStatus("Select a tilemap first.");
      return;
    }
    const maxTileW = clamp(Math.trunc(state.preferences.tilemaps.maxTileWidth || 512), 1, 9999);
    const maxTileH = clamp(Math.trunc(state.preferences.tilemaps.maxTileHeight || 512), 1, 9999);
    const maxPadX = clamp(Math.trunc(state.preferences.tilemaps.maxPaddingX || 32), 0, 9999);
    const maxPadY = clamp(Math.trunc(state.preferences.tilemaps.maxPaddingY || 32), 0, 9999);
    if (key === "tileWidth") active.tileWidth = clamp(Math.trunc(rawValue || 1), 1, maxTileW);
    if (key === "tileHeight") active.tileHeight = clamp(Math.trunc(rawValue || 1), 1, maxTileH);
    if (key === "paddingX") active.paddingX = clamp(Math.trunc(rawValue || 0), 0, maxPadX);
    if (key === "paddingY") active.paddingY = clamp(Math.trunc(rawValue || 0), 0, maxPadY);
    syncHud();
  };
  tileWidthPxEl?.addEventListener("change", () => updateActiveTilemapField("tileWidth", Number(tileWidthPxEl.value)));
  tileHeightPxEl?.addEventListener("change", () => updateActiveTilemapField("tileHeight", Number(tileHeightPxEl.value)));
  tilePaddingXEl?.addEventListener("change", () => updateActiveTilemapField("paddingX", Number(tilePaddingXEl.value)));
  tilePaddingYEl?.addEventListener("change", () => updateActiveTilemapField("paddingY", Number(tilePaddingYEl.value)));
  tileWidthDownBtn?.addEventListener("click", () => updateActiveTilemapField("tileWidth", Number(tileWidthPxEl?.value || 8) - 1));
  tileWidthUpBtn?.addEventListener("click", () => updateActiveTilemapField("tileWidth", Number(tileWidthPxEl?.value || 8) + 1));
  tileHeightDownBtn?.addEventListener("click", () => updateActiveTilemapField("tileHeight", Number(tileHeightPxEl?.value || 8) - 1));
  tileHeightUpBtn?.addEventListener("click", () => updateActiveTilemapField("tileHeight", Number(tileHeightPxEl?.value || 8) + 1));
  tilePaddingXDownBtn?.addEventListener("click", () => updateActiveTilemapField("paddingX", Number(tilePaddingXEl?.value || 0) - 1));
  tilePaddingXUpBtn?.addEventListener("click", () => updateActiveTilemapField("paddingX", Number(tilePaddingXEl?.value || 0) + 1));
  tilePaddingYDownBtn?.addEventListener("click", () => updateActiveTilemapField("paddingY", Number(tilePaddingYEl?.value || 0) - 1));
  tilePaddingYUpBtn?.addEventListener("click", () => updateActiveTilemapField("paddingY", Number(tilePaddingYEl?.value || 0) + 1));
  const handleTilemapPickerClick = (event: MouseEvent, canvasEl: HTMLCanvasElement) => {
    const metrics = tilemapPreviewMetricsByCanvas.get(canvasEl);
    const active = getActiveTileset(state.project, state.selectedTilesetId);
    if (!metrics || !active) return;
    const rect = canvasEl.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * canvasEl.width;
    const y = ((event.clientY - rect.top) / rect.height) * canvasEl.height;
    const stepX = Math.max(1e-6, metrics.tileStrideX * metrics.zoom);
    const stepY = Math.max(1e-6, metrics.tileStrideY * metrics.zoom);
    const col = clamp(Math.floor(x / stepX), 0, metrics.cols - 1);
    const row = clamp(Math.floor(y / stepY), 0, metrics.rows - 1);
    const localX = x - col * stepX;
    const localY = y - row * stepY;
    if (localX > metrics.tileDrawW * metrics.zoom || localY > metrics.tileDrawH * metrics.zoom) return;
    state.selectedTileIndex = row * metrics.cols + col;
    setStatus(`Tile selected: ${state.selectedTileIndex}`);
    syncHud();
  };
  tilemapPickerCanvas?.addEventListener("mousedown", (event) => handleTilemapPickerClick(event, tilemapPickerCanvas));
  tilemapPreviewFrame?.addEventListener("wheel", (event) => {
    tilemapZoomPercent = clamp(tilemapZoomPercent * (event.deltaY < 0 ? 1.1 : 0.9), 25, 2500);
    event.preventDefault();
    syncHud();
  });
  tilemapPreviewFrame?.addEventListener("contextmenu", (event) => event.preventDefault());
  tilemapPreviewFrame?.addEventListener("mousedown", (event) => {
    if (event.button !== 2) return;
    tilemapPanActive = true;
    tilemapPanStart = {
      x: event.clientX,
      y: event.clientY,
      left: tilemapPreviewFrame.scrollLeft,
      top: tilemapPreviewFrame.scrollTop
    };
    event.preventDefault();
  });
  window.addEventListener("mousemove", (event) => {
    if (!tilemapPanActive || !tilemapPreviewFrame) return;
    tilemapPreviewFrame.scrollLeft = tilemapPanStart.left - (event.clientX - tilemapPanStart.x);
    tilemapPreviewFrame.scrollTop = tilemapPanStart.top - (event.clientY - tilemapPanStart.y);
  });
  window.addEventListener("mouseup", () => {
    tilemapPanActive = false;
  });
  tilemapUndockBtn?.addEventListener("click", () => {
    if (undockedTilemapWindow && !undockedTilemapWindow.closed) {
      undockedTilemapWindow.focus();
      return;
    }
    undockedTilemapWindow = window.open("", "3tile-tilemap-picker", "width=420,height=520");
    if (!undockedTilemapWindow) {
      setStatus("Popup blocked: unable to undock tilemap picker.");
      return;
    }
    undockedTilemapWindow.document.title = "3Tile Tilemap Picker";
    undockedTilemapWindow.document.body.innerHTML = `
      <style>
        body { margin: 0; background: #111; color: #ddd; font: 12px sans-serif; }
        #wrap { padding: 8px; }
        #tilemapPreviewFrameUndocked { height: calc(100vh - 52px); overflow: scroll; scrollbar-gutter: stable both-edges; border: 1px solid #333; background: #0e0e0e; }
        canvas { background: #0e0e0e; display: block; }
      </style>
      <div id="wrap">
        <div>Tilemap Picker (<span id="tilemapZoomValueUndocked">${Math.round(tilemapZoomPercent)}%</span>)</div>
        <div id="tilemapPreviewFrameUndocked"><canvas id="tilemapPickerCanvasUndocked" width="380" height="460"></canvas></div>
      </div>
    `;
    const undockedCanvas = undockedTilemapWindow.document.getElementById("tilemapPickerCanvasUndocked") as HTMLCanvasElement | null;
    const undockedFrame = undockedTilemapWindow.document.getElementById("tilemapPreviewFrameUndocked") as HTMLElement | null;
    undockedCanvas?.addEventListener("mousedown", (event) => {
      if (!undockedCanvas) return;
      handleTilemapPickerClick(event as unknown as MouseEvent, undockedCanvas);
      renderUndockedTilemapPicker();
    });
    undockedFrame?.addEventListener("wheel", (event) => {
      tilemapZoomPercent = clamp(tilemapZoomPercent * (event.deltaY < 0 ? 1.1 : 0.9), 25, 2500);
      event.preventDefault();
      syncHud();
    });
    undockedFrame?.addEventListener("contextmenu", (event) => event.preventDefault());
    undockedFrame?.addEventListener("mousedown", (event) => {
      if (event.button !== 2 || !undockedFrame) return;
      tilemapPanActive = true;
      tilemapPanStart = {
        x: event.clientX,
        y: event.clientY,
        left: undockedFrame.scrollLeft,
        top: undockedFrame.scrollTop
      };
      event.preventDefault();
    });
    undockedTilemapWindow.addEventListener("mousemove", (event) => {
      if (!tilemapPanActive || !undockedFrame) return;
      undockedFrame.scrollLeft = tilemapPanStart.left - (event.clientX - tilemapPanStart.x);
      undockedFrame.scrollTop = tilemapPanStart.top - (event.clientY - tilemapPanStart.y);
    });
    undockedTilemapWindow.addEventListener("mouseup", () => {
      tilemapPanActive = false;
    });
    undockedTilemapWindow.addEventListener("beforeunload", () => {
      undockedTilemapWindow = null;
    });
    renderUndockedTilemapPicker();
  });
  tilemapDockBtn?.addEventListener("click", () => {
    if (undockedTilemapWindow && !undockedTilemapWindow.closed) {
      undockedTilemapWindow.close();
      undockedTilemapWindow = null;
    }
    tilemapPickerHost?.scrollIntoView({ behavior: "smooth", block: "center" });
  });
  layerSelectEl?.addEventListener("change", () => {
    const next = layerSelectEl.value;
    if (next) state.activeLayerId = next;
    syncHud();
  });
  layerAddBtn?.addEventListener("click", () => {
    const before = snapshot();
    const nextIndex = state.project.textureLayers.length + 1;
    const layer: TextureLayer = {
      id: crypto.randomUUID(),
      name: `Layer ${nextIndex}`,
      visible: true,
      opacity: 1
    };
    state.project.textureLayers.push(layer);
    state.activeLayerId = layer.id;
    pushHistory(before);
    setStatus("Layer added.");
    syncHud();
  });
  layerRemoveBtn?.addEventListener("click", () => {
    const activeLayer = state.project.textureLayers.find((layer) => layer.id === state.activeLayerId);
    if (!activeLayer || state.project.textureLayers.length <= 1) {
      setStatus("At least one layer is required.");
      return;
    }
    const before = snapshot();
    state.project.textureLayers = state.project.textureLayers.filter((layer) => layer.id !== activeLayer.id);
    state.project.layerPaints = state.project.layerPaints.filter((paint) => paint.layerId !== activeLayer.id);
    state.activeLayerId = state.project.textureLayers[state.project.textureLayers.length - 1]?.id;
    pushHistory(before);
    setStatus("Layer removed.");
    syncHud();
  });
  layerUpBtn?.addEventListener("click", () => {
    const idx = state.project.textureLayers.findIndex((layer) => layer.id === state.activeLayerId);
    if (idx < 0 || idx >= state.project.textureLayers.length - 1) return;
    const before = snapshot();
    const tmp = state.project.textureLayers[idx];
    state.project.textureLayers[idx] = state.project.textureLayers[idx + 1];
    state.project.textureLayers[idx + 1] = tmp;
    pushHistory(before);
    setStatus("Layer moved up.");
    syncHud();
  });
  layerDownBtn?.addEventListener("click", () => {
    const idx = state.project.textureLayers.findIndex((layer) => layer.id === state.activeLayerId);
    if (idx <= 0) return;
    const before = snapshot();
    const tmp = state.project.textureLayers[idx];
    state.project.textureLayers[idx] = state.project.textureLayers[idx - 1];
    state.project.textureLayers[idx - 1] = tmp;
    pushHistory(before);
    setStatus("Layer moved down.");
    syncHud();
  });
  layerOpacityEl?.addEventListener("input", () => {
    const activeLayer = state.project.textureLayers.find((layer) => layer.id === state.activeLayerId);
    if (!activeLayer) return;
    activeLayer.opacity = clamp((Number(layerOpacityEl.value) || 0) / 100, 0, 1);
    syncHud();
  });
  layerOpacityEl?.addEventListener("change", () => {
    const before = snapshot();
    const activeLayer = state.project.textureLayers.find((layer) => layer.id === state.activeLayerId);
    if (!activeLayer) return;
    activeLayer.opacity = clamp((Number(layerOpacityEl.value) || 0) / 100, 0, 1);
    pushHistory(before);
    setStatus("Layer opacity changed.");
    syncHud();
  });
  layerVisibleEl?.addEventListener("change", () => {
    const activeLayer = state.project.textureLayers.find((layer) => layer.id === state.activeLayerId);
    if (!activeLayer) return;
    const before = snapshot();
    activeLayer.visible = layerVisibleEl.checked;
    pushHistory(before);
    setStatus("Layer visibility changed.");
    syncHud();
  });
  applyTilesetScaleEl?.addEventListener("click", () => {
    const active = getActiveTileset(state.project, state.selectedTilesetId);
    if (!active || !tilesetScaleEl) {
      setStatus("Select a tilemap first.");
      return;
    }
    active.scale = normalizeTilesetScale(Number(tilesetScaleEl.value) || 1);
    syncHud();
  });
  tileIndexEl?.addEventListener("change", () => {
    state.selectedTileIndex = Math.max(0, Math.trunc(Number(tileIndexEl.value) || 0));
  });

  prefHotkeysBtn?.addEventListener("click", () => renderPreferences("hotkeys"));
  prefViewportBtn?.addEventListener("click", () => renderPreferences("viewport"));
  prefGeometryBtn?.addEventListener("click", () => renderPreferences("geometry"));
  prefTilemapsBtn?.addEventListener("click", () => renderPreferences("tilemaps"));
  prefCloseEl?.addEventListener("click", closePreferences);
  prefModal?.addEventListener("click", (event) => {
    if (event.target === prefModal) closePreferences();
  });

  window.threeTileApi.onMenuAction(async (action) => {
    if (action === "file:new") {
      state.project = createEmptyProject();
      state.mesh = MeshModel.fromProject(state.project);
      state.activeLayerId = state.project.textureLayers[0]?.id;
      state.selectedVertexIds = [];
      state.selectedEdgeIds = [];
      state.selectedFaceIds = [];
      state.creationLevels = { xy: 0, yz: 0, xz: 0 };
      state.hoverCell = undefined;
      state.hoverVertexId = undefined;
      state.hoverEdgeId = undefined;
      state.hoverFaceId = undefined;
      clearBoxSelect();
      clearGizmo();
      undoStack.length = 0;
      redoStack.length = 0;
      syncHud();
      return;
    }
    if (action === "file:load") {
      const loaded = await window.threeTileApi.openProject();
      if (!loaded) return;
      state.project = deserializeProject(loaded.bytes);
      state.mesh = MeshModel.fromProject(state.project);
      state.activeLayerId = state.project.textureLayers[0]?.id;
      state.projectPath = loaded.filePath;
      state.creationLevels = { xy: 0, yz: 0, xz: 0 };
      state.hoverCell = undefined;
      state.hoverVertexId = undefined;
      state.hoverEdgeId = undefined;
      state.hoverFaceId = undefined;
      clearBoxSelect();
      clearGizmo();
      undoStack.length = 0;
      redoStack.length = 0;
      syncHud();
      return;
    }
    if (action === "file:save" || action === "file:saveAs") {
      const bytes = serializeProject(state.mesh.toProject(state.project));
      const result = await window.threeTileApi.saveProject(bytes, action === "file:saveAs" ? undefined : state.projectPath);
      if (result) state.projectPath = result.filePath;
      return;
    }
    if (action === "file:importTileset") {
      const imported = await window.threeTileApi.importTileset();
      if (!imported) return;
      try {
        const parsed = parseTileset(imported.filePath, imported.bytes);
        validateTileset(parsed);
        const name = imported.filePath.split(/[\\/]/).pop() ?? "tilemap";
        const next = state.mesh.toProject(state.project);
        const tileset: TilesetRef = {
          id: crypto.randomUUID(),
          name,
          path: imported.filePath,
          format: parsed.format,
          width: parsed.width,
          height: parsed.height,
          bitDepth: parsed.bitDepth,
          scale: 1,
          tileWidth: 8,
          tileHeight: 8,
          paddingX: 0,
          paddingY: 0,
          dataBase64: bytesToBase64(imported.bytes)
        };
        next.tilesets.push(tileset);
        state.project = next;
        state.selectedTilesetId = tileset.id;
        if (!state.activeLayerId) state.activeLayerId = state.project.textureLayers[0]?.id;
        syncHud();
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "Tilemap import failed");
      }
      return;
    }
    if (action === "file:exportGeometry") {
      if (state.preferences.geometry.forceManifoldOnExport && !state.mesh.isManifold()) {
        setStatus("Export blocked: geometry is non-manifold.");
        return;
      }
      const bytes = new TextEncoder().encode(buildObj(state.mesh.toProject(state.project)));
      await window.threeTileApi.exportData("geometry", bytes, "scene.obj");
      return;
    }
    if (action === "file:exportTexture") {
      try {
        const baked = await bakeProjectTexture(state.mesh.toProject(state.project));
        await window.threeTileApi.exportData("texture", baked.pngBytes, "albedo.png");
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "Texture export failed.");
      }
      return;
    }
    if (action === "file:exportBoth") {
      if (state.preferences.geometry.forceManifoldOnExport && !state.mesh.isManifold()) {
        setStatus("Export blocked: geometry is non-manifold.");
        return;
      }
      try {
        const glb = await buildTexturedGlb(state.mesh.toProject(state.project));
        await window.threeTileApi.exportData("both", glb, "scene.glb");
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "GLB export failed.");
      }
      return;
    }
    if (action === "edit:preferences") {
      openPreferences();
      return;
    }
    if (action === "edit:undo") {
      undoAction();
      return;
    }
    if (action === "edit:redo") {
      redoAction();
    }
  });

  void viewport
    .init()
    .then(() => {
      applyView();
      syncHud();
      setStatus(viewport.isUsingWebGpu() ? "Viewport ready." : "WebGPU unavailable; using 2D fallback.");
    })
    .catch((error) => setStatus(error instanceof Error ? error.message : "Viewport init failed."));
}

function bindGridSettings(
  scaleEl: HTMLInputElement | null,
  opacityEl: HTMLInputElement | null,
  scaleKey: keyof ViewState,
  opacityKey: keyof ViewState,
  state: AppState,
  applyView: () => void,
  syncHud: () => void
): void {
  scaleEl?.addEventListener("change", () => {
    (state.view[scaleKey] as number) = clamp(Math.trunc(Number(scaleEl.value) || 1), 1, 100);
    applyView();
    syncHud();
  });
  opacityEl?.addEventListener("input", () => {
    (state.view[opacityKey] as number) = clamp(Math.trunc(Number(opacityEl.value) || 0), 0, 100);
    applyView();
    syncHud();
  });
}

function assignTextureToQuad(state: AppState, quad: Quad): void {
  quad.tilesetId = state.selectedTilesetId;
  quad.tileIndex = state.selectedTileIndex;
  const layerId = state.activeLayerId ?? state.project.textureLayers[0]?.id;
  if (!layerId) return;
  const existing = state.project.layerPaints.find((paint) => paint.layerId === layerId && paint.quadId === quad.id);
  if (!state.selectedTilesetId) {
    if (existing) {
      state.project.layerPaints = state.project.layerPaints.filter((paint) => paint !== existing);
    }
    return;
  }
  if (existing) {
    existing.tilesetId = state.selectedTilesetId;
    existing.tileIndex = state.selectedTileIndex;
    return;
  }
  state.project.layerPaints.push({
    layerId,
    quadId: quad.id,
    tilesetId: state.selectedTilesetId,
    tileIndex: state.selectedTileIndex
  });
}

function activeCreationPlane(state: AppState): "xy" | "yz" | "xz" {
  return state.creationPlane === "none" ? "xy" : state.creationPlane;
}

function toggleId(items: string[], id: string): string[] {
  return items.includes(id) ? items.filter((item) => item !== id) : [...items, id];
}

function applySelectionOperation(
  current: string[],
  incoming: string[],
  mode: "replace" | "add" | "subtract"
): string[] {
  if (mode === "replace") {
    return [...new Set(incoming)];
  }
  if (mode === "add") {
    return [...new Set([...current, ...incoming])];
  }
  const remove = new Set(incoming);
  return current.filter((id) => !remove.has(id));
}

function computeSelectionPivot(state: AppState): { x: number; y: number; z: number } | undefined {
  const project = state.mesh.toProject(state.project);
  const verticesById = new Map(project.vertices.map((v) => [v.id, v] as const));
  let ids: string[] = [];
  if (state.selectionMode === "vertex") {
    ids = state.selectedVertexIds;
  } else if (state.selectionMode === "edge") {
    const out = new Set<string>();
    for (const edgeId of state.selectedEdgeIds) {
      const edge = project.edges.find((e) => e.id === edgeId);
      if (!edge) continue;
      out.add(edge.v0);
      out.add(edge.v1);
    }
    ids = [...out];
  } else {
    const out = new Set<string>();
    for (const faceId of state.selectedFaceIds) {
      const quad = project.quads.find((q) => q.id === faceId);
      if (!quad) continue;
      for (const id of quad.vertexIds) out.add(id);
    }
    ids = [...out];
  }
  if (ids.length === 0) return undefined;
  let sx = 0;
  let sy = 0;
  let sz = 0;
  let n = 0;
  for (const id of ids) {
    const vertex = verticesById.get(id);
    if (!vertex) continue;
    sx += vertex.x;
    sy += vertex.y;
    sz += vertex.z;
    n += 1;
  }
  if (n === 0) return undefined;
  return { x: sx / n, y: sy / n, z: sz / n };
}

function buildGizmoState(state: AppState):
  | {
      pivot: { x: number; y: number; z: number };
      hoverAxis?: "x" | "y" | "z";
      activeAxis?: "x" | "y" | "z";
    }
  | undefined {
  const pivot = computeSelectionPivot(state);
  if (!pivot) return undefined;
  return {
    pivot,
    hoverAxis: state.gizmo.hoverAxis,
    activeAxis: state.gizmo.dragAxis
  };
}

function normalizedRect(x0: number, y0: number, x1: number, y1: number): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const x = Math.min(x0, x1);
  const y = Math.min(y0, y1);
  return {
    x,
    y,
    width: Math.abs(x1 - x0),
    height: Math.abs(y1 - y0)
  };
}

function pointInRect(x: number, y: number, rect: { x: number; y: number; width: number; height: number }): boolean {
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}

function sameIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  for (let i = 0; i < sa.length; i += 1) {
    if (sa[i] !== sb[i]) return false;
  }
  return true;
}

function pointInQuad(
  px: number,
  py: number,
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
  d: { x: number; y: number }
): boolean {
  return pointInTriangle(px, py, a, b, c) || pointInTriangle(px, py, a, c, d);
}

function pointInTriangle(
  px: number,
  py: number,
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number }
): boolean {
  const s1 = sign2d(px, py, a.x, a.y, b.x, b.y);
  const s2 = sign2d(px, py, b.x, b.y, c.x, c.y);
  const s3 = sign2d(px, py, c.x, c.y, a.x, a.y);
  const hasNeg = s1 < 0 || s2 < 0 || s3 < 0;
  const hasPos = s1 > 0 || s2 > 0 || s3 > 0;
  return !(hasNeg && hasPos);
}

function sign2d(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  return (px - bx) * (ay - by) - (ax - bx) * (py - by);
}

function toCanvasPixels(event: MouseEvent, canvas: HTMLCanvasElement): { x: number; y: number } {
  return {
    x: event.offsetX * (canvas.width / canvas.clientWidth),
    y: event.offsetY * (canvas.height / canvas.clientHeight)
  };
}

function distancePointToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const vv = vx * vx + vy * vy;
  if (vv <= 1e-6) return Math.hypot(px - ax, py - ay);
  const t = clamp((wx * vx + wy * vy) / vv, 0, 1);
  const cx = ax + vx * t;
  const cy = ay + vy * t;
  return Math.hypot(px - cx, py - cy);
}

function getActiveTileset(project: ProjectFile, selectedTilesetId?: string): TilesetRef | undefined {
  if (!selectedTilesetId) return undefined;
  return project.tilesets.find((tileset) => tileset.id === selectedTilesetId);
}

function buildObj(project: ProjectFile): string {
  const lines: string[] = ["# 3Tile OBJ export"];
  const indexByVertexId = new Map<string, number>();
  for (const vertex of project.vertices) {
    indexByVertexId.set(vertex.id, indexByVertexId.size + 1);
    lines.push(`v ${vertex.x} ${vertex.y} ${vertex.z}`);
  }
  for (const quad of project.quads) {
    const [a, b, c, d] = quad.vertexIds.map((id) => indexByVertexId.get(id) ?? 0);
    if (!a || !b || !c || !d) continue;
    lines.push(`f ${a} ${b} ${c}`);
    lines.push(`f ${a} ${c} ${d}`);
  }
  return `${lines.join("\n")}\n`;
}

function paintsToTint(
  layers: TextureLayer[],
  paints: LayerPaint[]
): { r: number; g: number; b: number; a: number } | undefined {
  if (paints.length === 0) return undefined;
  const paintByLayer = new Map(paints.map((paint) => [paint.layerId, paint] as const));
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  for (const layer of layers) {
    if (!layer.visible || layer.opacity <= 0) continue;
    const paint = paintByLayer.get(layer.id);
    if (!paint) continue;
    const c = colorForPaint(paint.tilesetId, paint.tileIndex);
    const srcA = clamp(layer.opacity, 0, 1);
    const outA = srcA + a * (1 - srcA);
    if (outA <= 1e-6) continue;
    r = (c.r * srcA + r * a * (1 - srcA)) / outA;
    g = (c.g * srcA + g * a * (1 - srcA)) / outA;
    b = (c.b * srcA + b * a * (1 - srcA)) / outA;
    a = outA;
  }
  if (a <= 0) return undefined;
  return { r, g, b, a };
}

type BakedTexture = {
  pngBytes: Uint8Array;
  width: number;
  height: number;
  uvRectsByQuadId: Map<string, [number, number, number, number]>;
};

async function bakeProjectTexture(project: ProjectFile): Promise<BakedTexture> {
  const quadCount = Math.max(1, project.quads.length);
  const cols = Math.ceil(Math.sqrt(quadCount));
  const rows = Math.ceil(quadCount / cols);
  const maxTileW = Math.max(
    1,
    ...project.layerPaints.map((paint) => {
      const tileset = project.tilesets.find((item) => item.id === paint.tilesetId);
      const tileW = tileset?.tileWidth ?? 8;
      const scale = tileset?.scale ?? 1;
      return Math.max(1, Math.trunc(tileW) * clamp(Math.trunc(scale), 1, 100));
    })
  );
  const maxTileH = Math.max(
    1,
    ...project.layerPaints.map((paint) => {
      const tileset = project.tilesets.find((item) => item.id === paint.tilesetId);
      const tileH = tileset?.tileHeight ?? 8;
      const scale = tileset?.scale ?? 1;
      return Math.max(1, Math.trunc(tileH) * clamp(Math.trunc(scale), 1, 100));
    })
  );
  const width = cols * maxTileW;
  const height = rows * maxTileH;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Unable to create texture bake canvas.");
  }
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, width, height);
  const tilesetsById = new Map(project.tilesets.map((tileset) => [tileset.id, tileset] as const));
  const imageByTilesetId = await decodeTilesetImages(project.tilesets);

  const paintLookup = new Map<string, LayerPaint[]>();
  for (const paint of project.layerPaints) {
    const list = paintLookup.get(paint.quadId) ?? [];
    list.push(paint);
    paintLookup.set(paint.quadId, list);
  }

  const uvRectsByQuadId = new Map<string, [number, number, number, number]>();
  for (let i = 0; i < project.quads.length; i += 1) {
    const quad = project.quads[i];
    const col = i % cols;
    const row = Math.trunc(i / cols);
    const x = col * maxTileW;
    const y = row * maxTileH;
    ctx.clearRect(x, y, maxTileW, maxTileH);
    const paints = paintLookup.get(quad.id) ?? [];
    const paintByLayerId = new Map(paints.map((paint) => [paint.layerId, paint] as const));
    let drewFromTileset = false;
    for (const layer of project.textureLayers) {
      if (!layer.visible || layer.opacity <= 0) continue;
      const paint = paintByLayerId.get(layer.id);
      if (!paint) continue;
      const tileset = tilesetsById.get(paint.tilesetId);
      const bitmap = imageByTilesetId.get(paint.tilesetId);
      if (!tileset || !bitmap) continue;
      const src = resolveTileSourceRect(tileset, paint.tileIndex, bitmap.width, bitmap.height);
      if (!src) continue;
      const dstW = Math.max(1, src.sw * clamp(Math.trunc(tileset.scale || 1), 1, 100));
      const dstH = Math.max(1, src.sh * clamp(Math.trunc(tileset.scale || 1), 1, 100));
      ctx.save();
      ctx.globalAlpha = clamp(layer.opacity, 0, 1);
      ctx.drawImage(bitmap, src.sx, src.sy, src.sw, src.sh, x, y, dstW, dstH);
      ctx.restore();
      drewFromTileset = true;
    }
    if (!drewFromTileset) {
      const tint = paintsToTint(project.textureLayers, paints) ?? fallbackColorForAxis(quad.axis);
      ctx.fillStyle = `rgba(${Math.round(tint.r * 255)},${Math.round(tint.g * 255)},${Math.round(tint.b * 255)},${clamp(tint.a, 0, 1)})`;
      ctx.fillRect(x, y, maxTileW, maxTileH);
    }
    const u0 = col / cols;
    const u1 = (col + 1) / cols;
    const vTop = row / rows;
    const vBottom = (row + 1) / rows;
    const v0 = 1 - vBottom;
    const v1 = 1 - vTop;
    uvRectsByQuadId.set(quad.id, [u0, v0, u1, v1]);
  }

  const pngBytes = await canvasToPngBytes(canvas);
  return { pngBytes, width, height, uvRectsByQuadId };
}

async function buildTexturedGlb(project: ProjectFile): Promise<Uint8Array> {
  if (project.quads.length === 0) {
    throw new Error("Export blocked: scene has no quads.");
  }
  const baked = await bakeProjectTexture(project);
  const verticesById = new Map(project.vertices.map((v) => [v.id, v] as const));
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (const quad of project.quads) {
    const verts = quad.vertexIds.map((id) => verticesById.get(id));
    if (verts.some((v) => !v)) continue;
    const uvRect = baked.uvRectsByQuadId.get(quad.id) ?? [0, 0, 1, 1];
    const [u0, v0, u1, v1] = uvRect;
    const base = positions.length / 3;
    const corners = verts as NonNullable<(typeof verts)[number]>[];
    for (const corner of corners) {
      positions.push(corner.x, corner.y, corner.z);
    }
    // Match quad winding order to exported triangles.
    uvs.push(u0, v0, u1, v0, u1, v1, u0, v1);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  const positionBytes = new Uint8Array(new Float32Array(positions).buffer);
  const uvBytes = new Uint8Array(new Float32Array(uvs).buffer);
  const indexBytes = new Uint8Array(new Uint32Array(indices).buffer);

  const binParts: Uint8Array[] = [];
  let offset = 0;
  const addPart = (bytes: Uint8Array): { byteOffset: number; byteLength: number } => {
    const pad = (4 - (offset % 4)) % 4;
    if (pad > 0) {
      const padding = new Uint8Array(pad);
      binParts.push(padding);
      offset += pad;
    }
    const out = { byteOffset: offset, byteLength: bytes.byteLength };
    binParts.push(bytes);
    offset += bytes.byteLength;
    return out;
  };

  const positionView = addPart(positionBytes);
  const uvView = addPart(uvBytes);
  const indexView = addPart(indexBytes);
  const imageView = addPart(baked.pngBytes);
  const binByteLength = offset;

  const bounds = computePositionBounds(positions);
  const gltf = {
    asset: { version: "2.0", generator: "3Tile" },
    scenes: [{ nodes: [0] }],
    scene: 0,
    nodes: [{ mesh: 0, name: "3TileMesh" }],
    meshes: [
      {
        primitives: [
          {
            attributes: { POSITION: 0, TEXCOORD_0: 1 },
            indices: 2,
            material: 0
          }
        ]
      }
    ],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 } }],
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
    textures: [{ sampler: 0, source: 0 }],
    images: [{ bufferView: 3, mimeType: "image/png" }],
    buffers: [{ byteLength: binByteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: positionView.byteOffset, byteLength: positionView.byteLength, target: 34962 },
      { buffer: 0, byteOffset: uvView.byteOffset, byteLength: uvView.byteLength, target: 34962 },
      { buffer: 0, byteOffset: indexView.byteOffset, byteLength: indexView.byteLength, target: 34963 },
      { buffer: 0, byteOffset: imageView.byteOffset, byteLength: imageView.byteLength }
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: positions.length / 3,
        type: "VEC3",
        min: bounds.min,
        max: bounds.max
      },
      { bufferView: 1, componentType: 5126, count: uvs.length / 2, type: "VEC2" },
      { bufferView: 2, componentType: 5125, count: indices.length, type: "SCALAR" }
    ]
  };

  const encoder = new TextEncoder();
  const jsonBytesRaw = encoder.encode(JSON.stringify(gltf));
  const jsonPadding = (4 - (jsonBytesRaw.byteLength % 4)) % 4;
  const jsonBytes = new Uint8Array(jsonBytesRaw.byteLength + jsonPadding);
  jsonBytes.set(jsonBytesRaw, 0);
  jsonBytes.fill(0x20, jsonBytesRaw.byteLength);

  const binBytesRaw = concatBytes(binParts);
  const binPadding = (4 - (binBytesRaw.byteLength % 4)) % 4;
  const binBytes = new Uint8Array(binBytesRaw.byteLength + binPadding);
  binBytes.set(binBytesRaw, 0);

  const totalLength = 12 + 8 + jsonBytes.byteLength + 8 + binBytes.byteLength;
  const glb = new Uint8Array(totalLength);
  const view = new DataView(glb.buffer);
  view.setUint32(0, 0x46546c67, true); // glTF
  view.setUint32(4, 2, true);
  view.setUint32(8, totalLength, true);
  view.setUint32(12, jsonBytes.byteLength, true);
  view.setUint32(16, 0x4e4f534a, true); // JSON
  glb.set(jsonBytes, 20);
  const binHeader = 20 + jsonBytes.byteLength;
  view.setUint32(binHeader, binBytes.byteLength, true);
  view.setUint32(binHeader + 4, 0x004e4942, true); // BIN
  glb.set(binBytes, binHeader + 8);
  return glb;
}

function computePositionBounds(positions: number[]): { min: [number, number, number]; max: [number, number, number] } {
  if (positions.length < 3) return { min: [0, 0, 0], max: [0, 0, 0] };
  let minX = positions[0];
  let minY = positions[1];
  let minZ = positions[2];
  let maxX = positions[0];
  let maxY = positions[1];
  let maxZ = positions[2];
  for (let i = 3; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

async function decodeTilesetImages(tilesets: TilesetRef[]): Promise<Map<string, ImageBitmap>> {
  const out = new Map<string, ImageBitmap>();
  for (const tileset of tilesets) {
    const encoded = tileset.dataBase64;
    if (!encoded) continue;
    try {
      const bytes = base64ToBytes(encoded);
      const mime =
        tileset.format === "png" ? "image/png" : tileset.format === "bmp" ? "image/bmp" : "image/x-tga";
      const payload = Uint8Array.from(bytes);
      const blob = new Blob([payload as unknown as BlobPart], { type: mime });
      const bitmap = await createImageBitmap(blob);
      out.set(tileset.id, bitmap);
    } catch {
      // Unsupported or corrupt source image; bake will fallback for this tileset.
    }
  }
  return out;
}

function resolveTileSourceRect(
  tileset: TilesetRef,
  tileIndex: number,
  imageWidth: number,
  imageHeight: number
): { sx: number; sy: number; sw: number; sh: number } | undefined {
  const tileW = Math.max(1, Math.trunc(tileset.tileWidth || 8));
  const tileH = Math.max(1, Math.trunc(tileset.tileHeight || 8));
  const padX = Math.max(0, Math.trunc(tileset.paddingX || 0));
  const padY = Math.max(0, Math.trunc(tileset.paddingY || 0));
  const stepX = tileW + padX;
  const stepY = tileH + padY;
  const cols = Math.floor((imageWidth + padX) / stepX);
  const rows = Math.floor((imageHeight + padY) / stepY);
  if (cols <= 0 || rows <= 0) return undefined;
  const maxTiles = cols * rows;
  const index = clamp(Math.trunc(tileIndex || 0), 0, maxTiles - 1);
  const col = index % cols;
  const row = Math.trunc(index / cols);
  return {
    sx: col * stepX,
    sy: row * stepY,
    sw: tileW,
    sh: tileH
  };
}

function fallbackColorForAxis(axis: "x" | "y" | "z"): { r: number; g: number; b: number; a: number } {
  if (axis === "x") return { r: 0.88, g: 0.42, b: 0.42, a: 1 };
  if (axis === "y") return { r: 0.42, g: 0.86, b: 0.42, a: 1 };
  return { r: 0.45, g: 0.6, b: 0.9, a: 1 };
}

function colorForPaint(tilesetId: string, tileIndex: number): { r: number; g: number; b: number } {
  const hash = hashString(`${tilesetId}:${tileIndex}`);
  const r = ((hash >>> 16) & 0xff) / 255;
  const g = ((hash >>> 8) & 0xff) / 255;
  const b = (hash & 0xff) / 255;
  return { r: 0.2 + r * 0.75, g: 0.2 + g * 0.75, b: 0.2 + b * 0.75 };
}

function hashString(value: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

async function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((out) => {
      if (!out) {
        reject(new Error("Texture bake failed."));
        return;
      }
      resolve(out);
    }, "image/png");
  });
  return new Uint8Array(await blob.arrayBuffer());
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function matchesMouse(event: MouseEvent, binding: HotkeyBinding): boolean {
  if (binding.mouseButton === undefined) return false;
  if (event.button !== binding.mouseButton) return false;
  return modifierMatch(event.altKey, event.shiftKey, event.ctrlKey, binding);
}

function matchesWheel(event: WheelEvent, binding: HotkeyBinding): boolean {
  if (!binding.wheel) return false;
  const direction = event.deltaY < 0 ? "up" : "down";
  if (direction !== binding.wheel) return false;
  return modifierMatch(event.altKey, event.shiftKey, event.ctrlKey, binding);
}

function matchesKey(event: KeyboardEvent, binding: HotkeyBinding): boolean {
  if (!binding.key) return false;
  if (event.key.toLowerCase() !== binding.key.toLowerCase()) return false;
  return modifierMatch(event.altKey, event.shiftKey, event.ctrlKey, binding);
}

function modifierMatch(alt: boolean, shift: boolean, ctrl: boolean, binding: HotkeyBinding): boolean {
  return alt === Boolean(binding.alt) && shift === Boolean(binding.shift) && ctrl === Boolean(binding.ctrl);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function loadPreferences(): EditorPreferences {
  try {
    const raw = localStorage.getItem("3tile.preferences");
    if (!raw) return structuredClone(DEFAULT_PREFERENCES);
    return deepMergePrefs(JSON.parse(raw) as Partial<EditorPreferences>);
  } catch {
    return structuredClone(DEFAULT_PREFERENCES);
  }
}

function savePreferences(preferences: EditorPreferences): void {
  localStorage.setItem("3tile.preferences", JSON.stringify(preferences));
}

function deepMergePrefs(partial: Partial<EditorPreferences>): EditorPreferences {
  const baseBounds = DEFAULT_PREFERENCES.bounds;
  const inBounds: Partial<WorkspaceBounds> = partial.bounds ?? {};
  return {
    camera: {
      flythroughEnabled: partial.camera?.flythroughEnabled ?? DEFAULT_PREFERENCES.camera.flythroughEnabled,
      flythroughSensitivity: partial.camera?.flythroughSensitivity ?? DEFAULT_PREFERENCES.camera.flythroughSensitivity,
      invertRotationX: partial.camera?.invertRotationX ?? DEFAULT_PREFERENCES.camera.invertRotationX,
      invertRotationY: partial.camera?.invertRotationY ?? DEFAULT_PREFERENCES.camera.invertRotationY,
      groundGridOpacity: partial.camera?.groundGridOpacity ?? DEFAULT_PREFERENCES.camera.groundGridOpacity,
      activePlaneOpacity: partial.camera?.activePlaneOpacity ?? DEFAULT_PREFERENCES.camera.activePlaneOpacity,
      depthFadeEnabled: partial.camera?.depthFadeEnabled ?? DEFAULT_PREFERENCES.camera.depthFadeEnabled,
      depthFadeStrength: partial.camera?.depthFadeStrength ?? DEFAULT_PREFERENCES.camera.depthFadeStrength,
      depthFadeExponent: partial.camera?.depthFadeExponent ?? DEFAULT_PREFERENCES.camera.depthFadeExponent,
      gizmoScale: partial.camera?.gizmoScale ?? DEFAULT_PREFERENCES.camera.gizmoScale,
      dragCreateHysteresisEnabled:
        partial.camera?.dragCreateHysteresisEnabled ?? DEFAULT_PREFERENCES.camera.dragCreateHysteresisEnabled,
      dragCreateHysteresisFrames:
        partial.camera?.dragCreateHysteresisFrames ?? DEFAULT_PREFERENCES.camera.dragCreateHysteresisFrames
    },
    geometry: {
      allowNonManifoldGeometry:
        partial.geometry?.allowNonManifoldGeometry ?? DEFAULT_PREFERENCES.geometry.allowNonManifoldGeometry,
      forceManifoldOnExport:
        partial.geometry?.forceManifoldOnExport ?? DEFAULT_PREFERENCES.geometry.forceManifoldOnExport
    },
    tilemaps: {
      maxTileWidth: partial.tilemaps?.maxTileWidth ?? DEFAULT_PREFERENCES.tilemaps.maxTileWidth,
      maxTileHeight: partial.tilemaps?.maxTileHeight ?? DEFAULT_PREFERENCES.tilemaps.maxTileHeight,
      maxPaddingX: partial.tilemaps?.maxPaddingX ?? DEFAULT_PREFERENCES.tilemaps.maxPaddingX,
      maxPaddingY: partial.tilemaps?.maxPaddingY ?? DEFAULT_PREFERENCES.tilemaps.maxPaddingY
    },
    bounds: {
      minX: inBounds.minX ?? baseBounds.minX,
      maxX: inBounds.maxX ?? baseBounds.maxX,
      minY: inBounds.minY ?? baseBounds.minY,
      maxY: inBounds.maxY ?? baseBounds.maxY,
      minZ: inBounds.minZ ?? baseBounds.minZ,
      maxZ: inBounds.maxZ ?? baseBounds.maxZ
    },
    historyDepth: partial.historyDepth ?? DEFAULT_PREFERENCES.historyDepth,
    hotkeys: {
      ...DEFAULT_PREFERENCES.hotkeys,
      ...(partial.hotkeys ?? {})
    }
  };
}

function getEl(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function getInput(id: string, type: "button"): HTMLButtonElement | null;
function getInput(id: string, type: "select"): HTMLSelectElement | null;
function getInput(id: string, type: "number" | "range" | "color"): HTMLInputElement | null;
function getInput(
  id: string,
  type: "button" | "select" | "number" | "range" | "color"
): HTMLInputElement | HTMLButtonElement | HTMLSelectElement | null {
  const element = document.getElementById(id);
  if (!element) {
    return null;
  }
  if (type === "button") {
    return element as HTMLButtonElement;
  }
  if (type === "select") {
    return element as HTMLSelectElement;
  }
  return element as HTMLInputElement;
}
