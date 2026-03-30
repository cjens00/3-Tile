import { Axis, Edge, ProjectFile, Quad, Vertex } from "../../shared/project";
import { WorkspaceBounds } from "../../shared/preferences";

type QuadInput = {
  axis: Axis;
  gridX: number;
  gridY: number;
  gridZ: number;
};

type AddFaceResult =
  | { ok: true; quad: Quad }
  | {
      ok: false;
      reason: "duplicate-face" | "non-manifold-edge" | "out-of-bounds";
      detail: string;
    };

export class MeshModel {
  private readonly vertices = new Map<string, Vertex>();
  private readonly positionToVertexId = new Map<string, string>();
  private readonly edges = new Map<string, Edge>();
  private readonly edgeFaceCounts = new Map<string, number>();
  private readonly quads = new Map<string, Quad>();
  private readonly faceSignatures = new Set<string>();
  private allowNonManifold = false;

  static fromProject(project: ProjectFile): MeshModel {
    const mesh = new MeshModel();

    for (const vertex of project.vertices) {
      mesh.vertices.set(vertex.id, { ...vertex });
      mesh.positionToVertexId.set(positionKey(vertex.x, vertex.y, vertex.z), vertex.id);
    }
    for (const quad of project.quads) {
      mesh.quads.set(quad.id, quad);
      mesh.faceSignatures.add(faceSignature(quad.vertexIds));
      for (const [a, b] of quadEdges(quad.vertexIds)) {
        mesh.incrementEdge(a, b);
      }
    }

    return mesh;
  }

  toProject(project: ProjectFile): ProjectFile {
    return {
      ...project,
      vertices: [...this.vertices.values()],
      edges: [...this.edges.values()].map((edge) => ({
        ...edge,
        faceCount: this.edgeFaceCounts.get(edgeKey(edge.v0, edge.v1)) ?? 0
      })),
      quads: [...this.quads.values()]
    };
  }

  setAllowNonManifold(allow: boolean): void {
    this.allowNonManifold = allow;
  }

  isManifold(): boolean {
    for (const count of this.edgeFaceCounts.values()) {
      if (count > 2) return false;
    }
    return true;
  }

  addFillQuad(input: QuadInput, bounds?: WorkspaceBounds): AddFaceResult {
    let positions = quadVerticesForAxis(input.axis, input.gridX, input.gridY, input.gridZ);
    if (bounds) {
      positions = positions.map(([x, y, z]) => [
        clamp(x, bounds.minX, bounds.maxX),
        clamp(y, bounds.minY, bounds.maxY),
        clamp(z, bounds.minZ, bounds.maxZ)
      ]) as typeof positions;
      if (new Set(positions.map((p) => positionKey(p[0], p[1], p[2]))).size < 4) {
        return {
          ok: false,
          reason: "out-of-bounds",
          detail: "Clamped face collapsed at bounds; move inward or change bounds."
        };
      }
    }
    const vertexIds = positions.map((p) => this.getOrCreateVertex(p[0], p[1], p[2])) as [
      string,
      string,
      string,
      string
    ];
    return this.addQuadFromVertexIds(vertexIds);
  }

  addQuadFromVertexIds(vertexIds: [string, string, string, string]): AddFaceResult {
    const validation = this.validateNewFace(vertexIds);
    if (!validation.ok) {
      return validation;
    }

    const axis = inferAxisFromVertices(vertexIds.map((id) => this.vertices.get(id)!));
    const [gridX, gridY, gridZ] = inferGridCoordinates(vertexIds.map((id) => this.vertices.get(id)!));
    const quad: Quad = {
      id: crypto.randomUUID(),
      axis,
      gridX,
      gridY,
      gridZ,
      vertexIds
    };

    this.commitFace(quad);
    return { ok: true, quad };
  }

  addQuadFromEdges(edgeAId: string, edgeBId: string): AddFaceResult {
    const edgeA = [...this.edges.values()].find((edge) => edge.id === edgeAId);
    const edgeB = [...this.edges.values()].find((edge) => edge.id === edgeBId);
    if (!edgeA || !edgeB) {
      return {
        ok: false,
        reason: "duplicate-face",
        detail: "Selected edges could not be found."
      };
    }

    const unique = [...new Set([edgeA.v0, edgeA.v1, edgeB.v0, edgeB.v1])];
    if (unique.length !== 4) {
      return {
        ok: false,
        reason: "duplicate-face",
        detail: "Edge selection must result in exactly 4 unique vertices."
      };
    }

    return this.addQuadFromVertexIds(unique as [string, string, string, string]);
  }

  getNearestVertexId(point: { x: number; y: number; z: number }, maxDistance: number): string | null {
    let bestId: string | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const vertex of this.vertices.values()) {
      const dist = Math.abs(vertex.x - point.x) + Math.abs(vertex.y - point.y) + Math.abs(vertex.z - point.z);
      if (dist < bestDist) {
        bestDist = dist;
        bestId = vertex.id;
      }
    }
    return bestDist <= maxDistance ? bestId : null;
  }

  getNearestEdgeId(point: { x: number; y: number; z: number }, maxDistance: number): string | null {
    let bestId: string | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const edge of this.edges.values()) {
      const a = this.vertices.get(edge.v0);
      const b = this.vertices.get(edge.v1);
      if (!a || !b) {
        continue;
      }
      const mx = (a.x + b.x) * 0.5;
      const my = (a.y + b.y) * 0.5;
      const mz = (a.z + b.z) * 0.5;
      const dist = Math.abs(mx - point.x) + Math.abs(my - point.y) + Math.abs(mz - point.z);
      if (dist < bestDist) {
        bestDist = dist;
        bestId = edge.id;
      }
    }
    return bestDist <= maxDistance ? bestId : null;
  }

  getNearestQuadId(point: { x: number; y: number; z: number }, maxDistance: number): string | null {
    let bestId: string | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const quad of this.quads.values()) {
      const vertices = quad.vertexIds
        .map((id) => this.vertices.get(id))
        .filter((value): value is Vertex => Boolean(value));
      if (vertices.length !== 4) {
        continue;
      }
      const cx = (vertices[0].x + vertices[1].x + vertices[2].x + vertices[3].x) * 0.25;
      const cy = (vertices[0].y + vertices[1].y + vertices[2].y + vertices[3].y) * 0.25;
      const cz = (vertices[0].z + vertices[1].z + vertices[2].z + vertices[3].z) * 0.25;
      const dist = Math.abs(cx - point.x) + Math.abs(cy - point.y) + Math.abs(cz - point.z);
      if (dist < bestDist) {
        bestDist = dist;
        bestId = quad.id;
      }
    }
    return bestDist <= maxDistance ? bestId : null;
  }

  getEdges(): Edge[] {
    return [...this.edges.values()];
  }

  getAllVertexIds(): string[] {
    return [...this.vertices.keys()];
  }

  getAllEdgeIds(): string[] {
    return [...this.edges.values()].map((edge) => edge.id);
  }

  getAllQuadIds(): string[] {
    return [...this.quads.keys()];
  }

  getQuad(quadId: string): Quad | undefined {
    return this.quads.get(quadId);
  }

  getEdge(edgeId: string): Edge | undefined {
    return [...this.edges.values()].find((edge) => edge.id === edgeId);
  }

  deleteQuads(quadIds: string[]): number {
    const ids = new Set(quadIds);
    let removed = 0;
    for (const id of ids) {
      if (this.quads.delete(id)) {
        removed += 1;
      }
    }
    if (removed === 0) return 0;
    this.removeOrphanVertices();
    this.rebuildDerivedFromGeometry();
    return removed;
  }

  translateVertices(
    vertexIds: string[],
    dx: number,
    dy: number,
    dz: number,
    bounds?: WorkspaceBounds
  ): { ok: true } | { ok: false; detail: string } {
    if (dx === 0 && dy === 0 && dz === 0) {
      return { ok: true };
    }
    const ids = [...new Set(vertexIds)].filter((id) => this.vertices.has(id));
    if (ids.length === 0) {
      return { ok: true };
    }

    const vertexSnapshot = new Map<string, Vertex>();
    for (const [id, vertex] of this.vertices.entries()) {
      vertexSnapshot.set(id, { ...vertex });
    }
    const quadSnapshot = new Map<string, Quad>();
    for (const [id, quad] of this.quads.entries()) {
      quadSnapshot.set(id, { ...quad, vertexIds: [...quad.vertexIds] as [string, string, string, string] });
    }

    for (const id of ids) {
      const vertex = this.vertices.get(id);
      if (!vertex) {
        continue;
      }
      vertex.x += dx;
      vertex.y += dy;
      vertex.z += dz;
      if (bounds) {
        vertex.x = clamp(vertex.x, bounds.minX, bounds.maxX);
        vertex.y = clamp(vertex.y, bounds.minY, bounds.maxY);
        vertex.z = clamp(vertex.z, bounds.minZ, bounds.maxZ);
      }
    }

    this.normalizeVertexMerges();
    const validation = this.rebuildDerivedFromGeometry();
    if (!validation.ok) {
      this.restoreSnapshot(vertexSnapshot, quadSnapshot);
      return { ok: false, detail: validation.detail };
    }
    this.recomputeQuadPlacement();
    return { ok: true };
  }

  private getOrCreateVertex(x: number, y: number, z: number): string {
    const key = positionKey(x, y, z);
    const existing = this.positionToVertexId.get(key);
    if (existing) {
      return existing;
    }

    const id = crypto.randomUUID();
    this.vertices.set(id, { id, x, y, z });
    this.positionToVertexId.set(key, id);
    return id;
  }

  private incrementEdge(v0: string, v1: string): void {
    const key = edgeKey(v0, v1);
    const [a, b] = key.split(":");
    const current = this.edgeFaceCounts.get(key) ?? 0;
    const next = current + 1;
    this.edgeFaceCounts.set(key, next);

    const edge = this.edges.get(key);
    if (!edge) {
      this.edges.set(key, { id: crypto.randomUUID(), v0: a, v1: b, faceCount: next });
      return;
    }
    edge.faceCount = next;
  }

  private validateNewFace(vertexIds: [string, string, string, string]): AddFaceResult | { ok: true } {
    if (new Set(vertexIds).size < 4) {
      return {
        ok: false,
        reason: "out-of-bounds",
        detail: "Face became degenerate."
      };
    }
    const signature = faceSignature(vertexIds);
    if (this.faceSignatures.has(signature)) {
      return {
        ok: false,
        reason: "duplicate-face",
        detail: "A face already exists with the same 4 vertices."
      };
    }
    for (const [a, b] of quadEdges(vertexIds)) {
      const key = edgeKey(a, b);
      if (!this.allowNonManifold && (this.edgeFaceCounts.get(key) ?? 0) >= 2) {
        return {
          ok: false,
          reason: "non-manifold-edge",
          detail: "Adding this face would create an edge connected to more than 2 faces."
        };
      }
    }
    return { ok: true };
  }

  private commitFace(quad: Quad): void {
    this.quads.set(quad.id, quad);
    this.faceSignatures.add(faceSignature(quad.vertexIds));
    for (const [a, b] of quadEdges(quad.vertexIds)) {
      this.incrementEdge(a, b);
    }
  }

  private normalizeVertexMerges(): void {
    const canonicalByPosition = new Map<string, string>();
    const remap = new Map<string, string>();
    for (const [id, vertex] of this.vertices.entries()) {
      const key = positionKey(vertex.x, vertex.y, vertex.z);
      const existing = canonicalByPosition.get(key);
      if (!existing) {
        canonicalByPosition.set(key, id);
        remap.set(id, id);
      } else {
        remap.set(id, existing);
      }
    }

    for (const quad of this.quads.values()) {
      quad.vertexIds = quad.vertexIds.map((id) => remap.get(id) ?? id) as [string, string, string, string];
    }

    for (const [id] of this.vertices.entries()) {
      if ((remap.get(id) ?? id) !== id) {
        this.vertices.delete(id);
      }
    }

    this.positionToVertexId.clear();
    for (const [id, vertex] of this.vertices.entries()) {
      this.positionToVertexId.set(positionKey(vertex.x, vertex.y, vertex.z), id);
    }
  }

  private rebuildDerivedFromGeometry(): { ok: true } | { ok: false; detail: string } {
    const previousEdgeIds = new Map<string, string>();
    for (const [key, edge] of this.edges.entries()) {
      previousEdgeIds.set(key, edge.id);
    }
    this.edges.clear();
    this.edgeFaceCounts.clear();
    this.faceSignatures.clear();

    for (const quad of this.quads.values()) {
      const uniqueCount = new Set(quad.vertexIds).size;
      if (uniqueCount !== 4) {
        return { ok: false, detail: "Transform produced a degenerate face." };
      }
      for (const id of quad.vertexIds) {
        if (!this.vertices.has(id)) {
          return { ok: false, detail: "Transform produced invalid vertex references." };
        }
      }
      const signature = faceSignature(quad.vertexIds);
      if (this.faceSignatures.has(signature)) {
        return { ok: false, detail: "Transform produced duplicate faces." };
      }
      this.faceSignatures.add(signature);
      for (const [a, b] of quadEdges(quad.vertexIds)) {
        const key = edgeKey(a, b);
        const next = (this.edgeFaceCounts.get(key) ?? 0) + 1;
        if (!this.allowNonManifold && next > 2) {
          return { ok: false, detail: "Transform produced non-manifold edges." };
        }
        this.edgeFaceCounts.set(key, next);
        const [v0, v1] = key.split(":");
        const edge = this.edges.get(key);
        if (!edge) {
          this.edges.set(key, { id: previousEdgeIds.get(key) ?? crypto.randomUUID(), v0, v1, faceCount: next });
        } else {
          edge.faceCount = next;
        }
      }
    }
    return { ok: true };
  }

  private recomputeQuadPlacement(): void {
    for (const quad of this.quads.values()) {
      const vertices = quad.vertexIds.map((id) => this.vertices.get(id)).filter((v): v is Vertex => Boolean(v));
      if (vertices.length !== 4) {
        continue;
      }
      quad.axis = inferAxisFromVertices(vertices);
      const [gridX, gridY, gridZ] = inferGridCoordinates(vertices);
      quad.gridX = gridX;
      quad.gridY = gridY;
      quad.gridZ = gridZ;
    }
  }

  private restoreSnapshot(vertexSnapshot: Map<string, Vertex>, quadSnapshot: Map<string, Quad>): void {
    this.vertices.clear();
    this.quads.clear();
    this.positionToVertexId.clear();
    for (const [id, vertex] of vertexSnapshot.entries()) {
      this.vertices.set(id, { ...vertex });
      this.positionToVertexId.set(positionKey(vertex.x, vertex.y, vertex.z), id);
    }
    for (const [id, quad] of quadSnapshot.entries()) {
      this.quads.set(id, { ...quad, vertexIds: [...quad.vertexIds] as [string, string, string, string] });
    }
    this.rebuildDerivedFromGeometry();
  }

  private removeOrphanVertices(): void {
    const referenced = new Set<string>();
    for (const quad of this.quads.values()) {
      for (const id of quad.vertexIds) referenced.add(id);
    }
    for (const id of [...this.vertices.keys()]) {
      if (!referenced.has(id)) this.vertices.delete(id);
    }
    this.positionToVertexId.clear();
    for (const [id, vertex] of this.vertices.entries()) {
      this.positionToVertexId.set(positionKey(vertex.x, vertex.y, vertex.z), id);
    }
  }
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

function quadEdges(vertexIds: [string, string, string, string]): [string, string][] {
  return [
    [vertexIds[0], vertexIds[1]],
    [vertexIds[1], vertexIds[2]],
    [vertexIds[2], vertexIds[3]],
    [vertexIds[3], vertexIds[0]]
  ];
}

function edgeKey(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function faceSignature(vertexIds: [string, string, string, string]): string {
  return [...vertexIds].sort().join(":");
}

function positionKey(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

function inferAxisFromVertices(vertices: Vertex[]): Axis {
  const allX = vertices.every((vertex) => vertex.x === vertices[0].x);
  if (allX) {
    return "x";
  }
  const allY = vertices.every((vertex) => vertex.y === vertices[0].y);
  if (allY) {
    return "y";
  }
  return "z";
}

function inferGridCoordinates(vertices: Vertex[]): [number, number, number] {
  const xs = vertices.map((vertex) => vertex.x);
  const ys = vertices.map((vertex) => vertex.y);
  const zs = vertices.map((vertex) => vertex.z);
  return [Math.min(...xs), Math.min(...ys), Math.min(...zs)];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
