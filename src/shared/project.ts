export type Axis = "x" | "y" | "z";
export type Tool = "fill" | "vertex" | "edge";

export interface TilesetRef {
  id: string;
  name: string;
  path: string;
  format: "png" | "tga" | "bmp";
  width: number;
  height: number;
  bitDepth?: number;
  scale: number;
  tileWidth: number;
  tileHeight: number;
  paddingX: number;
  paddingY: number;
  dataBase64?: string;
}

export interface Vertex {
  id: string;
  x: number;
  y: number;
  z: number;
}

export interface Edge {
  id: string;
  v0: string;
  v1: string;
  faceCount: number;
}

export interface Quad {
  id: string;
  axis: Axis;
  gridX: number;
  gridY: number;
  gridZ: number;
  vertexIds: [string, string, string, string];
  tilesetId?: string;
  tileIndex?: number;
}

export interface TextureLayer {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
}

export interface LayerPaint {
  layerId: string;
  quadId: string;
  tilesetId: string;
  tileIndex: number;
}

export interface ProjectFile {
  version: number;
  name: string;
  lightIntensity: number;
  activeAxis: Axis;
  activeTool: Tool;
  vertices: Vertex[];
  edges: Edge[];
  quads: Quad[];
  tilesets: TilesetRef[];
  textureLayers: TextureLayer[];
  layerPaints: LayerPaint[];
}

export const PROJECT_MAGIC = "3TIL";
export const PROJECT_VERSION = 1;

export function createEmptyProject(): ProjectFile {
  return {
    version: PROJECT_VERSION,
    name: "untitled",
    lightIntensity: 1,
    activeAxis: "z",
    activeTool: "fill",
    vertices: [],
    edges: [],
    quads: [],
    tilesets: [],
    textureLayers: [
      {
        id: globalThis.crypto.randomUUID(),
        name: "Layer 1",
        visible: true,
        opacity: 1
      }
    ],
    layerPaints: []
  };
}

export function serializeProject(project: ProjectFile): Uint8Array {
  const encoder = new TextEncoder();
  const payload = encoder.encode(JSON.stringify(project));
  const bytes = new Uint8Array(10 + payload.length);
  bytes.set(encoder.encode(PROJECT_MAGIC), 0);
  const view = new DataView(bytes.buffer);
  view.setUint16(4, PROJECT_VERSION, true);
  view.setUint32(6, payload.length, true);
  bytes.set(payload, 10);
  return bytes;
}

export function deserializeProject(bytes: Uint8Array): ProjectFile {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const magic = decoder.decode(bytes.slice(0, 4));
  if (magic !== PROJECT_MAGIC) {
    throw new Error("Invalid project file magic.");
  }

  const version = view.getUint16(4, true);
  if (version !== PROJECT_VERSION) {
    throw new Error(`Unsupported project file version: ${version}`);
  }

  const payloadLength = view.getUint32(6, true);
  const payloadBytes = bytes.slice(10, 10 + payloadLength);
  const data = JSON.parse(decoder.decode(payloadBytes)) as Partial<ProjectFile> & {
    quads?: Array<
      Partial<Quad> & {
        vertexIds?: unknown;
      }
    >;
  };
  return normalizeProject(data);
}

function normalizeProject(data: Partial<ProjectFile> & { quads?: Array<Partial<Quad>> }): ProjectFile {
  const geometry = rebuildGeometry(data.quads ?? [], data.vertices ?? []);
  return {
    version: data.version ?? PROJECT_VERSION,
    name: data.name ?? "untitled",
    lightIntensity: data.lightIntensity ?? 1,
    activeAxis: data.activeAxis ?? "z",
    activeTool: data.activeTool ?? "fill",
    vertices: geometry.vertices,
    edges: geometry.edges,
    quads: geometry.quads,
    tilesets: normalizeTilesets(data.tilesets ?? []),
    textureLayers: normalizeTextureLayers((data as any).textureLayers ?? []),
    layerPaints: normalizeLayerPaints((data as any).layerPaints ?? [])
  };
}

function normalizeTextureLayers(rawLayers: Array<Partial<TextureLayer>>): TextureLayer[] {
  const layers = rawLayers
    .map((layer, index) => ({
      id: layer.id ?? globalThis.crypto.randomUUID(),
      name: layer.name?.trim() || `Layer ${index + 1}`,
      visible: layer.visible ?? true,
      opacity: Math.max(0, Math.min(1, Number.isFinite(layer.opacity) ? Number(layer.opacity) : 1))
    }))
    .filter((layer) => layer.id.length > 0);
  if (layers.length > 0) return layers;
  return [
    {
      id: globalThis.crypto.randomUUID(),
      name: "Layer 1",
      visible: true,
      opacity: 1
    }
  ];
}

function normalizeLayerPaints(rawPaints: Array<Partial<LayerPaint>>): LayerPaint[] {
  return rawPaints
    .filter((paint) => Boolean(paint.layerId && paint.quadId && paint.tilesetId))
    .map((paint) => ({
      layerId: paint.layerId as string,
      quadId: paint.quadId as string,
      tilesetId: paint.tilesetId as string,
      tileIndex: Math.max(0, Math.trunc(Number(paint.tileIndex) || 0))
    }));
}

function normalizeTilesets(rawTilesets: Array<Partial<TilesetRef>>): TilesetRef[] {
  const validFormats = new Set(["png", "tga", "bmp"]);
  return rawTilesets.map((tileset) => {
    const format = String(tileset.format ?? "png").toLowerCase();
    const normalizedFormat: "png" | "tga" | "bmp" = validFormats.has(format)
      ? (format as "png" | "tga" | "bmp")
      : "png";
    const scale = Number.isFinite(tileset.scale) ? Math.trunc(Number(tileset.scale)) : 1;
    return {
      id: tileset.id ?? globalThis.crypto.randomUUID(),
      name: tileset.name ?? "tileset",
      path: tileset.path ?? "",
      format: normalizedFormat,
      width: Number.isFinite(tileset.width) ? Number(tileset.width) : 8,
      height: Number.isFinite(tileset.height) ? Number(tileset.height) : 8,
      bitDepth: Number.isFinite(tileset.bitDepth) ? Number(tileset.bitDepth) : undefined,
      scale: Math.max(1, Math.min(100, scale)),
      tileWidth: Math.max(1, Math.trunc(Number(tileset.tileWidth) || 8)),
      tileHeight: Math.max(1, Math.trunc(Number(tileset.tileHeight) || 8)),
      paddingX: Math.max(0, Math.trunc(Number(tileset.paddingX) || 0)),
      paddingY: Math.max(0, Math.trunc(Number(tileset.paddingY) || 0)),
      dataBase64: typeof tileset.dataBase64 === "string" ? tileset.dataBase64 : undefined
    };
  });
}

function rebuildGeometry(rawQuads: Array<Partial<Quad>>, rawVertices: Array<Partial<Vertex>>): {
  vertices: Vertex[];
  edges: Edge[];
  quads: Quad[];
} {
  const verticesById = new Map<string, Vertex>();
  const positionToVertexId = new Map<string, string>();
  const edgesByKey = new Map<string, Edge>();
  const quads: Quad[] = [];

  for (const raw of rawVertices) {
    const x = Number.isFinite(raw.x) ? Number(raw.x) : 0;
    const y = Number.isFinite(raw.y) ? Number(raw.y) : 0;
    const z = Number.isFinite(raw.z) ? Number(raw.z) : 0;
    const id = raw.id ?? globalThis.crypto.randomUUID();
    const vertex: Vertex = { id, x, y, z };
    verticesById.set(id, vertex);
    const key = `${x},${y},${z}`;
    if (!positionToVertexId.has(key)) {
      positionToVertexId.set(key, id);
    }
  }

  const getOrCreateVertex = (x: number, y: number, z: number): string => {
    const key = `${x},${y},${z}`;
    const foundId = positionToVertexId.get(key);
    if (foundId) {
      return foundId;
    }
    const id = globalThis.crypto.randomUUID();
    const vertex: Vertex = { id, x, y, z };
    verticesById.set(id, vertex);
    positionToVertexId.set(key, id);
    return id;
  };

  const addEdgeFace = (a: string, b: string) => {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    const [v0, v1] = key.split(":");
    const edge = edgesByKey.get(key);
    if (!edge) {
      edgesByKey.set(key, { id: globalThis.crypto.randomUUID(), v0, v1, faceCount: 1 });
      return;
    }
    edge.faceCount += 1;
  };

  for (const quad of rawQuads) {
    const axis = quad.axis === "x" || quad.axis === "y" || quad.axis === "z" ? quad.axis : "z";
    const gridX = Number.isFinite(quad.gridX) ? Number(quad.gridX) : 0;
    const gridY = Number.isFinite(quad.gridY) ? Number(quad.gridY) : 0;
    const gridZ = Number.isFinite(quad.gridZ) ? Number(quad.gridZ) : 0;

    let vertexIds: [string, string, string, string];
    if (
      Array.isArray(quad.vertexIds) &&
      quad.vertexIds.length === 4 &&
      quad.vertexIds.every((id) => typeof id === "string" && verticesById.has(id))
    ) {
      vertexIds = quad.vertexIds as [string, string, string, string];
    } else {
      const positions = quadVerticesForAxis(axis, gridX, gridY, gridZ);
      vertexIds = [
        getOrCreateVertex(positions[0][0], positions[0][1], positions[0][2]),
        getOrCreateVertex(positions[1][0], positions[1][1], positions[1][2]),
        getOrCreateVertex(positions[2][0], positions[2][1], positions[2][2]),
        getOrCreateVertex(positions[3][0], positions[3][1], positions[3][2])
      ];
    }

    const normalized: Quad = {
      id: quad.id ?? globalThis.crypto.randomUUID(),
      axis,
      gridX,
      gridY,
      gridZ,
      vertexIds,
      tilesetId: quad.tilesetId,
      tileIndex: quad.tileIndex
    };

    quads.push(normalized);
    addEdgeFace(vertexIds[0], vertexIds[1]);
    addEdgeFace(vertexIds[1], vertexIds[2]);
    addEdgeFace(vertexIds[2], vertexIds[3]);
    addEdgeFace(vertexIds[3], vertexIds[0]);
  }

  return {
    vertices: [...verticesById.values()],
    edges: [...edgesByKey.values()],
    quads
  };
}

function quadVerticesForAxis(
  axis: Axis,
  gridX: number,
  gridY: number,
  gridZ: number
): [[number, number, number], [number, number, number], [number, number, number], [number, number, number]] {
  if (axis === "z") {
    return [
      [gridX, gridY, gridZ],
      [gridX + 1, gridY, gridZ],
      [gridX + 1, gridY + 1, gridZ],
      [gridX, gridY + 1, gridZ]
    ];
  }
  if (axis === "x") {
    return [
      [gridX, gridY, gridZ],
      [gridX, gridY + 1, gridZ],
      [gridX, gridY + 1, gridZ + 1],
      [gridX, gridY, gridZ + 1]
    ];
  }
  return [
    [gridX, gridY, gridZ],
    [gridX + 1, gridY, gridZ],
    [gridX + 1, gridY, gridZ + 1],
    [gridX, gridY, gridZ + 1]
  ];
}
