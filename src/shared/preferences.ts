export type SelectionMode = "vertex" | "edge" | "face";
export type EditorMode = "selection" | "creation" | "tilePaint";
export type CreationPlane = "none" | "xy" | "yz" | "xz";

export interface HotkeyBinding {
  key?: string;
  mouseButton?: 0 | 1 | 2;
  wheel?: "up" | "down";
  alt?: boolean;
  shift?: boolean;
  ctrl?: boolean;
}

export interface CameraPreferences {
  flythroughEnabled: boolean;
  flythroughSensitivity: number;
  invertRotationX: boolean;
  invertRotationY: boolean;
  groundGridOpacity: number;
  activePlaneOpacity: number;
  depthFadeEnabled: boolean;
  depthFadeStrength: number;
  depthFadeExponent: number;
  gizmoScale: number;
  dragCreateHysteresisEnabled: boolean;
  dragCreateHysteresisFrames: number;
}

export interface GeometryPreferences {
  allowNonManifoldGeometry: boolean;
  forceManifoldOnExport: boolean;
}

export interface TilemapPreferences {
  maxTileWidth: number;
  maxTileHeight: number;
  maxPaddingX: number;
  maxPaddingY: number;
}

export interface WorkspaceBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

export interface EditorPreferences {
  camera: CameraPreferences;
  geometry: GeometryPreferences;
  tilemaps: TilemapPreferences;
  bounds: WorkspaceBounds;
  historyDepth: number;
  hotkeys: Record<string, HotkeyBinding>;
}

export const DEFAULT_PREFERENCES: EditorPreferences = {
  camera: {
    flythroughEnabled: true,
    flythroughSensitivity: 1,
    invertRotationX: false,
    invertRotationY: false,
    groundGridOpacity: 0.7,
    activePlaneOpacity: 0.45,
    depthFadeEnabled: true,
    depthFadeStrength: 1,
    depthFadeExponent: 2,
    gizmoScale: 1,
    dragCreateHysteresisEnabled: false,
    dragCreateHysteresisFrames: 1
  },
  geometry: {
    allowNonManifoldGeometry: false,
    forceManifoldOnExport: true
  },
  tilemaps: {
    maxTileWidth: 512,
    maxTileHeight: 512,
    maxPaddingX: 32,
    maxPaddingY: 32
  },
  bounds: {
    minX: -100,
    maxX: 100,
    minY: -100,
    maxY: 100,
    minZ: -100,
    maxZ: 100
  },
  historyDepth: 10,
  hotkeys: {
    viewportRotate: { alt: true, mouseButton: 0 },
    viewportPan: { alt: true, mouseButton: 2 },
    viewportZoomIn: { wheel: "up" },
    viewportZoomOut: { wheel: "down" },
    lockXYPlane: { shift: true, key: "z" },
    lockYZPlane: { shift: true, key: "x" },
    lockXZPlane: { shift: true, key: "y" },
    cancelPlaneLock: { key: "escape" },
    flythroughHold: { mouseButton: 2 },
    flyForward: { key: "w" },
    flyLeft: { key: "a" },
    flyBackward: { key: "s" },
    flyRight: { key: "d" },
    selectVertexMode: { key: "1" },
    selectEdgeMode: { key: "2" },
    selectFaceMode: { key: "3" },
    boxSelectMode: { key: "b" },
    creationLevelUp: { key: "pageup" },
    creationLevelDown: { key: "pagedown" },
    undo: { ctrl: true, key: "z" },
    redo: { ctrl: true, key: "y" }
  }
};
