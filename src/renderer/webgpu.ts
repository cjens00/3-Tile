type Axis = "x" | "y" | "z";
type PlaneMode = "xy" | "yz" | "xz";
type CameraDragMode = "orbit" | "pan" | null;

type GridRenderSettings = { scale: number; opacity: number };

type SceneRenderState = {
  vertices: Array<{ id: string; x: number; y: number; z: number }>;
  edges: Array<{ id: string; v0: string; v1: string }>;
  quads: Array<{
    id: string;
    axis: Axis;
    vertexIds: [string, string, string, string];
    paintTint?: { r: number; g: number; b: number; a: number };
    paintLayers?: Array<{
      image: CanvasImageSource;
      sx: number;
      sy: number;
      sw: number;
      sh: number;
      opacity: number;
    }>;
  }>;
  selectedVertexIds: string[];
  selectedEdgeIds: string[];
  selectedFaceIds: string[];
  hoverCell?: { x: number; y: number; z: number };
  hoverVertexId?: string;
  hoverEdgeId?: string;
  hoverFaceId?: string;
  marquee?: {
    active: boolean;
    startX: number;
    startY: number;
    endX: number;
    endY: number;
  };
  createPreviewCells?: Array<{ x: number; y: number; z: number }>;
  gizmo?: {
    pivot: { x: number; y: number; z: number };
    hoverAxis?: "x" | "y" | "z";
    activeAxis?: "x" | "y" | "z";
  };
  creationPlane: PlaneMode;
  activePlaneLevel: number;
};

type FlyMove = { forward: boolean; backward: boolean; left: boolean; right: boolean };

export class WebGpuViewport {
  private device: any = null;
  private context: any = null;
  private format: any = null;
  private overlayCtx: CanvasRenderingContext2D | null = null;
  private animationHandle: number | null = null;
  private lastFrame = performance.now();
  private usingWebGpu = false;
  private lightIntensity = 1;
  private backgroundRgb = { r: 0.2667, g: 0.2667, b: 0.2667 };
  private scene: SceneRenderState = {
    vertices: [],
    edges: [],
    quads: [],
    selectedVertexIds: [],
    selectedEdgeIds: [],
    selectedFaceIds: [],
    hoverVertexId: undefined,
    hoverEdgeId: undefined,
    hoverFaceId: undefined,
    marquee: undefined,
    createPreviewCells: undefined,
    creationPlane: "xy",
    activePlaneLevel: 0
  };
  private grid: Record<PlaneMode, GridRenderSettings> = {
    xy: { scale: 10, opacity: 0.7 },
    yz: { scale: 10, opacity: 0.25 },
    xz: { scale: 10, opacity: 0.25 }
  };
  private camera = {
    target: { x: 0, y: 0, z: 0 },
    distance: 24,
    yaw: Math.PI * 0.25,
    pitch: Math.PI * 0.6,
    fov: 50 * (Math.PI / 180)
  };
  private dragMode: CameraDragMode = null;
  private lastPointer = { x: 0, y: 0 };
  private flythroughEnabled = true;
  private flythroughActive = false;
  private flySensitivity = 1;
  private flyMove: FlyMove = { forward: false, backward: false, left: false, right: false };
  private depthFadeEnabled = true;
  private depthFadeStrength = 1;
  private depthFadeExponent = 2;
  private gizmoScale = 1;
  private invertRotationX = false;
  private invertRotationY = false;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly overlayCanvas: HTMLCanvasElement) {}

  async init(): Promise<void> {
    this.overlayCtx = this.overlayCanvas.getContext("2d");
    if (!this.overlayCtx) throw new Error("Unable to create overlay context.");

    const nav = navigator as any;
    if ("gpu" in nav) {
      try {
        const adapter = await nav.gpu.requestAdapter();
        if (adapter) {
          this.device = await adapter.requestDevice();
          this.context = this.canvas.getContext("webgpu");
          if (this.context) {
            this.format = nav.gpu.getPreferredCanvasFormat();
            this.usingWebGpu = true;
          }
        }
      } catch {
        this.usingWebGpu = false;
      }
    }

    this.resize();
    window.addEventListener("resize", () => this.resize());
    this.animationHandle = requestAnimationFrame(this.render);
  }

  setScene(scene: SceneRenderState): void {
    this.scene = scene;
  }

  setLightIntensity(value: number): void {
    this.lightIntensity = clamp(value, 0, 5);
  }

  setBackgroundColor(hex: string): void {
    this.backgroundRgb = hexToRgb(hex);
  }

  setGridSettings(plane: PlaneMode, settings: GridRenderSettings): void {
    this.grid[plane] = { scale: clamp(Math.trunc(settings.scale), 1, 100), opacity: clamp(settings.opacity, 0, 1) };
  }

  setFlythroughPreferences(enabled: boolean, sensitivity: number): void {
    this.flythroughEnabled = enabled;
    this.flySensitivity = clamp(sensitivity, 0.01, 10);
  }

  setViewportVisualPreferences(options: {
    depthFadeEnabled: boolean;
    depthFadeStrength: number;
    depthFadeExponent: number;
    gizmoScale: number;
    invertRotationX: boolean;
    invertRotationY: boolean;
  }): void {
    this.depthFadeEnabled = options.depthFadeEnabled;
    this.depthFadeStrength = clamp(options.depthFadeStrength, 0.1, 100);
    this.depthFadeExponent = clamp(options.depthFadeExponent, 1, 8);
    this.gizmoScale = clamp(options.gizmoScale, 0.5, 3);
    this.invertRotationX = options.invertRotationX;
    this.invertRotationY = options.invertRotationY;
  }

  startOrbit(clientX: number, clientY: number): void {
    this.dragMode = "orbit";
    this.lastPointer = { x: clientX, y: clientY };
  }

  startPan(clientX: number, clientY: number): void {
    this.dragMode = "pan";
    this.lastPointer = { x: clientX, y: clientY };
  }

  dragTo(clientX: number, clientY: number): void {
    const dx = clientX - this.lastPointer.x;
    const dy = clientY - this.lastPointer.y;
    this.lastPointer = { x: clientX, y: clientY };
    const xSign = this.invertRotationX ? -1 : 1;
    const ySign = this.invertRotationY ? -1 : 1;

    if (!this.dragMode) {
      if (this.flythroughActive) {
        this.camera.yaw -= dx * 0.0045 * xSign;
        this.camera.pitch = clamp(this.camera.pitch - dy * 0.0045 * ySign, 0.1, Math.PI - 0.1);
      }
      return;
    }

    if (this.dragMode === "orbit") {
      this.camera.yaw -= dx * 0.008 * xSign;
      this.camera.pitch = clamp(this.camera.pitch - dy * 0.008 * ySign, 0.1, Math.PI - 0.1);
      return;
    }

    const basis = this.getCameraBasis();
    const scale = this.camera.distance * 0.004;
    this.camera.target.x += (-basis.right.x * dx + basis.up.x * dy) * scale;
    this.camera.target.y += (-basis.right.y * dx + basis.up.y * dy) * scale;
    this.camera.target.z += (-basis.right.z * dx + basis.up.z * dy) * scale;
  }

  endDrag(): void {
    this.dragMode = null;
  }

  zoom(deltaY: number): void {
    const factor = deltaY > 0 ? 1.1 : 0.9;
    this.camera.distance = clamp(this.camera.distance * factor, 2, 250);
  }

  startFlythrough(clientX: number, clientY: number): void {
    if (!this.flythroughEnabled) return;
    this.flythroughActive = true;
    this.lastPointer = { x: clientX, y: clientY };
  }

  stopFlythrough(): void {
    this.flythroughActive = false;
    this.flyMove = { forward: false, backward: false, left: false, right: false };
  }

  setFlyMove(direction: keyof FlyMove, active: boolean): void {
    this.flyMove[direction] = active;
  }

  isUsingWebGpu(): boolean {
    return this.usingWebGpu;
  }

  pickCell(clientX: number, clientY: number, plane: PlaneMode, lockedAxisValue = 0): { x: number; y: number; z: number } | null {
    const ray = this.getScreenRay(clientX, clientY);
    if (!ray) return null;

    const t =
      plane === "xy"
        ? intersectAxisPlane(ray, "z", lockedAxisValue)
        : plane === "yz"
          ? intersectAxisPlane(ray, "x", lockedAxisValue)
          : intersectAxisPlane(ray, "y", lockedAxisValue);
    if (t === null || t > 5000) return null;

    const p = {
      x: ray.origin.x + ray.dir.x * t,
      y: ray.origin.y + ray.dir.y * t,
      z: ray.origin.z + ray.dir.z * t
    };
    return {
      x: stableCellIndex(p.x),
      y: stableCellIndex(p.y),
      z: stableCellIndex(p.z)
    };
  }

  dispose(): void {
    if (this.animationHandle) cancelAnimationFrame(this.animationHandle);
  }

  private render = (now: number): void => {
    const dt = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    this.updateFlythrough(dt);

    if (this.device && this.context) {
      const intensity = clamp(this.lightIntensity, 0, 2);
      const encoder = this.device.createCommandEncoder();
      const view = this.context.getCurrentTexture().createView();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view,
            loadOp: "clear",
            storeOp: "store",
            clearValue: {
              r: clamp(this.backgroundRgb.r * intensity, 0, 1),
              g: clamp(this.backgroundRgb.g * intensity, 0, 1),
              b: clamp(this.backgroundRgb.b * intensity, 0, 1),
              a: 1
            }
          }
        ]
      });
      pass.end();
      this.device.queue.submit([encoder.finish()]);
    }

    this.drawOverlay(!this.usingWebGpu);
    this.animationHandle = requestAnimationFrame(this.render);
  };

  private updateFlythrough(dt: number): void {
    if (!this.flythroughActive || !this.flythroughEnabled) return;
    const basis = this.getCameraBasis();
    const speed = 12 * this.flySensitivity;
    let vx = 0;
    let vy = 0;
    let vz = 0;
    if (this.flyMove.forward) {
      vx += basis.forward.x;
      vy += basis.forward.y;
      vz += basis.forward.z;
    }
    if (this.flyMove.backward) {
      vx -= basis.forward.x;
      vy -= basis.forward.y;
      vz -= basis.forward.z;
    }
    if (this.flyMove.left) {
      vx -= basis.right.x;
      vy -= basis.right.y;
      vz -= basis.right.z;
    }
    if (this.flyMove.right) {
      vx += basis.right.x;
      vy += basis.right.y;
      vz += basis.right.z;
    }
    const len = Math.hypot(vx, vy, vz);
    if (len < 1e-4) return;
    const nx = vx / len;
    const ny = vy / len;
    const nz = vz / len;
    this.camera.target.x += nx * speed * dt;
    this.camera.target.y += ny * speed * dt;
    this.camera.target.z += nz * speed * dt;
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const height = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    this.canvas.width = width;
    this.canvas.height = height;
    this.overlayCanvas.width = width;
    this.overlayCanvas.height = height;
    if (this.context && this.device && this.format) {
      this.context.configure({ device: this.device, format: this.format, alphaMode: "opaque" });
    }
  }

  private drawOverlay(drawBackground: boolean): void {
    if (!this.overlayCtx) return;
    const ctx = this.overlayCtx;
    ctx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
    if (drawBackground) {
      const lit = clamp(this.lightIntensity, 0, 2);
      ctx.fillStyle = `rgb(${Math.floor(this.backgroundRgb.r * lit * 255)},${Math.floor(this.backgroundRgb.g * lit * 255)},${Math.floor(this.backgroundRgb.b * lit * 255)})`;
      ctx.fillRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
    }

    // Always-on Blender-like ground grid.
    this.drawGridPlane(ctx, "xy", { r: 150, g: 150, b: 150 }, 0, this.grid.xy.opacity, false);
    // Active creation plane overlay at indexed level.
    this.drawGridPlane(
      ctx,
      this.scene.creationPlane,
      this.scene.creationPlane === "xy" ? { r: 185, g: 185, b: 185 } : { r: 220, g: 220, b: 220 },
      this.scene.activePlaneLevel,
      this.grid.yz.opacity,
      true
    );
    this.drawOriginIndicators(ctx);
    this.drawMesh(ctx);
    this.drawGizmo(ctx);
    this.drawHoverSelection(ctx);
    this.drawHoverCell(ctx);
    this.drawCreatePreview(ctx);
    this.drawMarquee(ctx);
  }

  private drawGridPlane(
    ctx: CanvasRenderingContext2D,
    plane: PlaneMode,
    rgb: { r: number; g: number; b: number },
    axisValue: number,
    opacity: number,
    emphasizeAxis: boolean
  ): void {
    if (opacity <= 0) return;
    const spacing = this.grid.xy.scale / 10;
    const extent = 72;
    for (let i = -extent; i <= extent; i += 1) {
      const a0 =
        plane === "xy"
          ? { x: -extent * spacing, y: i * spacing, z: axisValue }
          : plane === "yz"
            ? { x: axisValue, y: -extent * spacing, z: i * spacing }
            : { x: -extent * spacing, y: axisValue, z: i * spacing };
      const a1 =
        plane === "xy"
          ? { x: extent * spacing, y: i * spacing, z: axisValue }
          : plane === "yz"
            ? { x: axisValue, y: extent * spacing, z: i * spacing }
            : { x: extent * spacing, y: axisValue, z: i * spacing };
      const b0 =
        plane === "xy"
          ? { x: i * spacing, y: -extent * spacing, z: axisValue }
          : plane === "yz"
            ? { x: axisValue, y: i * spacing, z: -extent * spacing }
            : { x: i * spacing, y: axisValue, z: -extent * spacing };
      const b1 =
        plane === "xy"
          ? { x: i * spacing, y: extent * spacing, z: axisValue }
          : plane === "yz"
            ? { x: axisValue, y: i * spacing, z: extent * spacing }
            : { x: i * spacing, y: axisValue, z: extent * spacing };
      const axisLine = i === 0;
      const samplePoint =
        plane === "xy"
          ? { x: 0, y: i * spacing, z: axisValue }
          : plane === "yz"
            ? { x: axisValue, y: 0, z: i * spacing }
            : { x: i * spacing, y: axisValue, z: 0 };
      const fadedOpacity = this.applyDepthFade(opacity, samplePoint);
      ctx.strokeStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},${axisLine && emphasizeAxis ? Math.min(1, fadedOpacity + 0.35) : fadedOpacity})`;
      ctx.lineWidth = axisLine ? (emphasizeAxis ? 2 : 1.8) : 1;
      this.drawLine3dClipped(ctx, a0, a1);
      this.drawLine3dClipped(ctx, b0, b1);
    }
  }

  private drawOriginIndicators(ctx: CanvasRenderingContext2D): void {
    const extent = this.grid.xy.scale * 7.2;
    ctx.strokeStyle = "rgba(235,235,235,0.72)";
    ctx.lineWidth = 2.2;
    this.drawLine3dClipped(ctx, { x: -extent, y: 0, z: 0 }, { x: extent, y: 0, z: 0 });
    this.drawLine3dClipped(ctx, { x: 0, y: -extent, z: 0 }, { x: 0, y: extent, z: 0 });

    const origin = this.projectPoint({ x: 0, y: 0, z: 0 });
    if (!origin) return;
    ctx.beginPath();
    ctx.arc(origin.x, origin.y, 4.2, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.fill();
    ctx.strokeStyle = "rgba(15,15,15,0.9)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  private drawMesh(ctx: CanvasRenderingContext2D): void {
    const vMap = new Map(this.scene.vertices.map((v) => [v.id, v] as const));
    const quads = this.scene.quads
      .map((quad) => {
        const points = quad.vertexIds.map((id) => vMap.get(id)).filter(Boolean) as Array<{ x: number; y: number; z: number }>;
        if (points.length !== 4) return null;
        const projected = points.map((p) => this.projectPoint(p));
        if (projected.some((p) => !p)) return null;
        const projectedPts = projected as ScreenPoint[];
        const depth = projectedPts.reduce((sum, p) => sum + p.depth, 0) / 4;
        return { quad, projected: projectedPts, depth, minDepth: Math.min(...projectedPts.map((p) => p.depth)) };
      })
      .filter(Boolean)
      .sort((a, b) => (a as any).depth - (b as any).depth) as Array<{
      quad: SceneRenderState["quads"][number];
      projected: ScreenPoint[];
      depth: number;
      minDepth: number;
    }>;

    const visibleIds = this.computeVisibleQuadIds(quads);
    const drawList = quads
      .filter((entry) => visibleIds.has(entry.quad.id))
      .sort((a, b) => b.depth - a.depth);

    for (const entry of drawList) {
      const fill = entry.quad.paintTint
        ? `rgba(${Math.round(clamp(entry.quad.paintTint.r, 0, 1) * 255)},${Math.round(clamp(entry.quad.paintTint.g, 0, 1) * 255)},${Math.round(clamp(entry.quad.paintTint.b, 0, 1) * 255)},${clamp(entry.quad.paintTint.a, 0, 1)})`
        : entry.quad.axis === "x"
          ? "rgba(226,108,108,0.30)"
          : entry.quad.axis === "y"
            ? "rgba(120,220,120,0.30)"
            : "rgba(120,160,240,0.30)";
      ctx.beginPath();
      ctx.moveTo(entry.projected[0].x, entry.projected[0].y);
      for (let i = 1; i < entry.projected.length; i += 1) ctx.lineTo(entry.projected[i].x, entry.projected[i].y);
      ctx.closePath();
      if (entry.quad.paintLayers && entry.quad.paintLayers.length > 0 && !this.scene.selectedFaceIds.includes(entry.quad.id)) {
        this.drawTexturedQuad(ctx, entry.projected, entry.quad.paintLayers);
      } else if (this.scene.selectedFaceIds.includes(entry.quad.id)) {
        ctx.fillStyle = "rgba(255,220,120,0.45)";
        ctx.fill();
      } else {
        ctx.fillStyle = fill;
        ctx.fill();
      }
      ctx.strokeStyle = "rgba(230,230,230,0.70)";
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }

    for (const edge of this.scene.edges) {
      if (!this.scene.selectedEdgeIds.includes(edge.id)) continue;
      const a = vMap.get(edge.v0);
      const b = vMap.get(edge.v1);
      if (!a || !b) continue;
      const pa = this.projectPoint(a);
      const pb = this.projectPoint(b);
      if (!pa || !pb) continue;
      ctx.strokeStyle = "rgba(255,220,120,0.95)";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    }

    for (const vertexId of this.scene.selectedVertexIds) {
      const v = vMap.get(vertexId);
      if (!v) continue;
      const p = this.projectPoint(v);
      if (!p) continue;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,220,120,0.95)";
      ctx.fill();
      ctx.strokeStyle = "rgba(30,30,30,0.9)";
      ctx.stroke();
    }
  }

  private computeVisibleQuadIds(
    quads: Array<{ quad: SceneRenderState["quads"][number]; projected: ScreenPoint[]; depth: number; minDepth: number }>
  ): Set<string> {
    const width = Math.max(16, Math.floor(this.overlayCanvas.width / 8));
    const height = Math.max(16, Math.floor(this.overlayCanvas.height / 8));
    const depthBuffer = new Float32Array(width * height);
    depthBuffer.fill(Number.POSITIVE_INFINITY);
    const visible = new Set<string>();
    const sx = width / Math.max(1, this.overlayCanvas.width);
    const sy = height / Math.max(1, this.overlayCanvas.height);

    for (const entry of quads) {
      const pts = entry.projected;
      const minX = clamp(Math.floor(Math.min(pts[0].x, pts[1].x, pts[2].x, pts[3].x) * sx), 0, width - 1);
      const maxX = clamp(Math.ceil(Math.max(pts[0].x, pts[1].x, pts[2].x, pts[3].x) * sx), 0, width - 1);
      const minY = clamp(Math.floor(Math.min(pts[0].y, pts[1].y, pts[2].y, pts[3].y) * sy), 0, height - 1);
      const maxY = clamp(Math.ceil(Math.max(pts[0].y, pts[1].y, pts[2].y, pts[3].y) * sy), 0, height - 1);
      if (minX > maxX || minY > maxY) continue;

      let quadVisible = false;
      for (let y = minY; y <= maxY; y += 1) {
        for (let x = minX; x <= maxX; x += 1) {
          const px = (x + 0.5) / sx;
          const py = (y + 0.5) / sy;
          if (!pointInQuad2d(px, py, pts[0], pts[1], pts[2], pts[3])) continue;
          const idx = y * width + x;
          if (entry.minDepth <= depthBuffer[idx] - 1e-4) {
            quadVisible = true;
            depthBuffer[idx] = entry.minDepth;
          }
        }
      }
      if (quadVisible) visible.add(entry.quad.id);
    }
    return visible;
  }

  private drawTexturedQuad(
    ctx: CanvasRenderingContext2D,
    projected: ScreenPoint[],
    layers: Array<{ image: CanvasImageSource; sx: number; sy: number; sw: number; sh: number; opacity: number }>
  ): void {
    const p0 = projected[0];
    const p1 = projected[1];
    const p2 = projected[2];
    const p3 = projected[3];
    for (const layer of layers) {
      const alpha = clamp(layer.opacity, 0, 1);
      if (alpha <= 0) continue;
      this.drawImageTriangle(
        ctx,
        layer.image,
        [
          { x: layer.sx, y: layer.sy + layer.sh },
          { x: layer.sx + layer.sw, y: layer.sy + layer.sh },
          { x: layer.sx + layer.sw, y: layer.sy }
        ],
        [p0, p1, p2],
        alpha
      );
      this.drawImageTriangle(
        ctx,
        layer.image,
        [
          { x: layer.sx, y: layer.sy + layer.sh },
          { x: layer.sx + layer.sw, y: layer.sy },
          { x: layer.sx, y: layer.sy }
        ],
        [p0, p2, p3],
        alpha
      );
    }
  }

  private drawImageTriangle(
    ctx: CanvasRenderingContext2D,
    image: CanvasImageSource,
    src: [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }],
    dest: [ScreenPoint, ScreenPoint, ScreenPoint],
    alpha: number
  ): void {
    const [s0, s1, s2] = src;
    const [d0, d1, d2] = dest;
    const den = s0.x * (s1.y - s2.y) + s1.x * (s2.y - s0.y) + s2.x * (s0.y - s1.y);
    if (Math.abs(den) < 1e-6) return;
    const a = (d0.x * (s1.y - s2.y) + d1.x * (s2.y - s0.y) + d2.x * (s0.y - s1.y)) / den;
    const b = (d0.y * (s1.y - s2.y) + d1.y * (s2.y - s0.y) + d2.y * (s0.y - s1.y)) / den;
    const c = (d0.x * (s2.x - s1.x) + d1.x * (s0.x - s2.x) + d2.x * (s1.x - s0.x)) / den;
    const d = (d0.y * (s2.x - s1.x) + d1.y * (s0.x - s2.x) + d2.y * (s1.x - s0.x)) / den;
    const e =
      (d0.x * (s1.x * s2.y - s2.x * s1.y) + d1.x * (s2.x * s0.y - s0.x * s2.y) + d2.x * (s0.x * s1.y - s1.x * s0.y)) /
      den;
    const f =
      (d0.y * (s1.x * s2.y - s2.x * s1.y) + d1.y * (s2.x * s0.y - s0.x * s2.y) + d2.y * (s0.x * s1.y - s1.x * s0.y)) /
      den;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(d0.x, d0.y);
    ctx.lineTo(d1.x, d1.y);
    ctx.lineTo(d2.x, d2.y);
    ctx.closePath();
    ctx.clip();
    ctx.globalAlpha = alpha;
    ctx.setTransform(a, b, c, d, e, f);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(image, 0, 0);
    ctx.restore();
  }

  private drawHoverCell(ctx: CanvasRenderingContext2D): void {
    if (!this.scene.hoverCell) return;
    const c = this.scene.hoverCell;
    const corners =
      this.scene.creationPlane === "xy"
        ? [
            { x: c.x, y: c.y, z: c.z },
            { x: c.x + 1, y: c.y, z: c.z },
            { x: c.x + 1, y: c.y + 1, z: c.z },
            { x: c.x, y: c.y + 1, z: c.z }
          ]
        : this.scene.creationPlane === "yz"
          ? [
              { x: c.x, y: c.y, z: c.z },
              { x: c.x, y: c.y + 1, z: c.z },
              { x: c.x, y: c.y + 1, z: c.z + 1 },
              { x: c.x, y: c.y, z: c.z + 1 }
            ]
          : [
              { x: c.x, y: c.y, z: c.z },
              { x: c.x + 1, y: c.y, z: c.z },
              { x: c.x + 1, y: c.y, z: c.z + 1 },
              { x: c.x, y: c.y, z: c.z + 1 }
            ];
    const projected = corners.map((p) => this.projectPoint(p));
    if (projected.some((p) => !p)) return;
    const pts = projected as ScreenPoint[];
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fillStyle = "rgba(255,255,255,0.16)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.88)";
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  private drawCreatePreview(ctx: CanvasRenderingContext2D): void {
    const cells = this.scene.createPreviewCells;
    if (!cells || cells.length === 0) return;
    for (const c of cells) {
      const corners =
        this.scene.creationPlane === "xy"
          ? [
              { x: c.x, y: c.y, z: c.z },
              { x: c.x + 1, y: c.y, z: c.z },
              { x: c.x + 1, y: c.y + 1, z: c.z },
              { x: c.x, y: c.y + 1, z: c.z }
            ]
          : this.scene.creationPlane === "yz"
            ? [
                { x: c.x, y: c.y, z: c.z },
                { x: c.x, y: c.y + 1, z: c.z },
                { x: c.x, y: c.y + 1, z: c.z + 1 },
                { x: c.x, y: c.y, z: c.z + 1 }
              ]
            : [
                { x: c.x, y: c.y, z: c.z },
                { x: c.x + 1, y: c.y, z: c.z },
                { x: c.x + 1, y: c.y, z: c.z + 1 },
                { x: c.x, y: c.y, z: c.z + 1 }
              ];
      const projected = corners.map((p) => this.projectPoint(p));
      if (projected.some((p) => !p)) continue;
      const pts = projected as ScreenPoint[];
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath();
      ctx.fillStyle = "rgba(255,255,255,0.14)";
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.78)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  private drawHoverSelection(ctx: CanvasRenderingContext2D): void {
    const vMap = new Map(this.scene.vertices.map((v) => [v.id, v] as const));
    if (this.scene.hoverFaceId) {
      const quad = this.scene.quads.find((q) => q.id === this.scene.hoverFaceId);
      if (quad) {
        const projected = quad.vertexIds
          .map((id) => vMap.get(id))
          .filter((value): value is NonNullable<typeof value> => Boolean(value))
          .map((v) => this.projectPoint(v))
          .filter((value): value is NonNullable<typeof value> => Boolean(value));
        if (projected.length === 4) {
          ctx.beginPath();
          ctx.moveTo(projected[0].x, projected[0].y);
          for (let i = 1; i < projected.length; i += 1) ctx.lineTo(projected[i].x, projected[i].y);
          ctx.closePath();
          ctx.fillStyle = "rgba(255,255,255,0.12)";
          ctx.fill();
          ctx.strokeStyle = "rgba(255,255,255,0.92)";
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }
    }

    if (this.scene.hoverEdgeId) {
      const edge = this.scene.edges.find((e) => e.id === this.scene.hoverEdgeId);
      if (edge) {
        const a = vMap.get(edge.v0);
        const b = vMap.get(edge.v1);
        if (a && b) {
          const pa = this.projectPoint(a);
          const pb = this.projectPoint(b);
          if (pa && pb) {
            ctx.beginPath();
            ctx.moveTo(pa.x, pa.y);
            ctx.lineTo(pb.x, pb.y);
            ctx.strokeStyle = "rgba(255,255,255,0.95)";
            ctx.lineWidth = 3;
            ctx.stroke();
          }
        }
      }
    }

    if (this.scene.hoverVertexId) {
      const vertex = vMap.get(this.scene.hoverVertexId);
      if (vertex) {
        const p = this.projectPoint(vertex);
        if (p) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(255,255,255,0.9)";
          ctx.fill();
          ctx.strokeStyle = "rgba(0,0,0,0.8)";
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
    }
  }

  private drawMarquee(ctx: CanvasRenderingContext2D): void {
    const marquee = this.scene.marquee;
    if (!marquee || !marquee.active) {
      return;
    }
    const x = Math.min(marquee.startX, marquee.endX);
    const y = Math.min(marquee.startY, marquee.endY);
    const width = Math.abs(marquee.endX - marquee.startX);
    const height = Math.abs(marquee.endY - marquee.startY);
    ctx.fillStyle = "rgba(128, 180, 255, 0.14)";
    ctx.strokeStyle = "rgba(160, 210, 255, 0.95)";
    ctx.lineWidth = 1.4;
    ctx.fillRect(x, y, width, height);
    ctx.strokeRect(x, y, width, height);
  }

  private drawGizmo(ctx: CanvasRenderingContext2D): void {
    const gizmo = this.scene.gizmo;
    if (!gizmo) {
      return;
    }
    const pivot = this.projectPoint(gizmo.pivot);
    if (!pivot) {
      return;
    }
    const axisLen = 2 * (1 + (this.gizmoScale - 1) * 0.2);
    const axes: Array<{ axis: "x" | "y" | "z"; color: string; end: Vec3 }> = [
      { axis: "x", color: "rgba(255,100,100,0.95)", end: { x: gizmo.pivot.x + axisLen, y: gizmo.pivot.y, z: gizmo.pivot.z } },
      { axis: "y", color: "rgba(120,255,120,0.95)", end: { x: gizmo.pivot.x, y: gizmo.pivot.y + axisLen, z: gizmo.pivot.z } },
      { axis: "z", color: "rgba(120,170,255,0.95)", end: { x: gizmo.pivot.x, y: gizmo.pivot.y, z: gizmo.pivot.z + axisLen } }
    ];
    for (const axis of axes) {
      const projected = this.projectPoint(axis.end);
      if (!projected) continue;
      ctx.beginPath();
      ctx.moveTo(pivot.x, pivot.y);
      ctx.lineTo(projected.x, projected.y);
      const isActive = gizmo.activeAxis === axis.axis;
      const isHover = !isActive && gizmo.hoverAxis === axis.axis;
      ctx.strokeStyle = isActive ? "rgba(255,255,200,1)" : axis.color;
      ctx.lineWidth = (isActive ? 6 : isHover ? 4 : 2.2) * (0.75 + this.gizmoScale * 0.5);
      ctx.stroke();
      ctx.beginPath();
      const radius = (isActive ? 7 : 5.5) * (0.65 + this.gizmoScale * 0.55);
      ctx.arc(projected.x, projected.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = isActive ? "rgba(255,255,180,0.98)" : axis.color;
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(pivot.x, pivot.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.fill();
  }

  private getScreenRay(clientX: number, clientY: number): { origin: Vec3; dir: Vec3 } | null {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const x = ((clientX - rect.left) / rect.width) * 2 - 1;
    const y = 1 - ((clientY - rect.top) / rect.height) * 2;
    const basis = this.getCameraBasis();
    const aspect = rect.width / rect.height;
    const tanHalf = Math.tan(this.camera.fov * 0.5);
    const dir = normalize({
      x: basis.forward.x + basis.right.x * x * tanHalf * aspect + basis.up.x * y * tanHalf,
      y: basis.forward.y + basis.right.y * x * tanHalf * aspect + basis.up.y * y * tanHalf,
      z: basis.forward.z + basis.right.z * x * tanHalf * aspect + basis.up.z * y * tanHalf
    });
    return { origin: this.getCameraPosition(), dir };
  }

  private getCameraPosition(): Vec3 {
    const sinPitch = Math.sin(this.camera.pitch);
    const dir = {
      x: Math.sin(this.camera.yaw) * sinPitch,
      y: Math.cos(this.camera.yaw) * sinPitch,
      z: Math.cos(this.camera.pitch)
    };
    return {
      x: this.camera.target.x - dir.x * this.camera.distance,
      y: this.camera.target.y - dir.y * this.camera.distance,
      z: this.camera.target.z - dir.z * this.camera.distance
    };
  }

  private getCameraBasis(): { forward: Vec3; right: Vec3; up: Vec3 } {
    const position = this.getCameraPosition();
    const forward = normalize({
      x: this.camera.target.x - position.x,
      y: this.camera.target.y - position.y,
      z: this.camera.target.z - position.z
    });
    const worldUp = { x: 0, y: 0, z: 1 };
    const right = normalize(cross(forward, worldUp));
    const up = normalize(cross(right, forward));
    return { forward, right, up };
  }

  private projectPoint(point: Vec3): ScreenPoint | null {
    const camera = this.toCameraSpace(point);
    if (camera.z <= this.getNearPlane()) return null;
    return this.projectCameraPoint(camera.x, camera.y, camera.z);
  }

  private drawLine3dClipped(ctx: CanvasRenderingContext2D, aWorld: Vec3, bWorld: Vec3): void {
    const a = this.toCameraSpace(aWorld);
    const b = this.toCameraSpace(bWorld);
    const near = this.getNearPlane();
    if (a.z <= near && b.z <= near) return;

    let ax = a.x;
    let ay = a.y;
    let az = a.z;
    let bx = b.x;
    let by = b.y;
    let bz = b.z;

    if (az <= near || bz <= near) {
      const t = (near - az) / (bz - az);
      const ix = ax + (bx - ax) * t;
      const iy = ay + (by - ay) * t;
      const iz = near;
      if (az <= near) {
        ax = ix;
        ay = iy;
        az = iz;
      } else {
        bx = ix;
        by = iy;
        bz = iz;
      }
    }

    const pa = this.projectCameraPoint(ax, ay, az);
    const pb = this.projectCameraPoint(bx, by, bz);
    if (!pa || !pb) return;
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
  }

  private toCameraSpace(point: Vec3): { x: number; y: number; z: number } {
    const basis = this.getCameraBasis();
    const camPos = this.getCameraPosition();
    const relative = { x: point.x - camPos.x, y: point.y - camPos.y, z: point.z - camPos.z };
    return {
      x: dot(relative, basis.right),
      y: dot(relative, basis.up),
      z: dot(relative, basis.forward)
    };
  }

  private projectCameraPoint(xCam: number, yCam: number, zCam: number): ScreenPoint | null {
    if (zCam <= 0) return null;
    const width = this.overlayCanvas.width || this.canvas.width;
    const height = this.overlayCanvas.height || this.canvas.height;
    const aspect = width / height;
    const f = 1 / Math.tan(this.camera.fov * 0.5);
    const xNdc = (xCam * f) / (zCam * aspect);
    const yNdc = (yCam * f) / zCam;
    return { x: (xNdc * 0.5 + 0.5) * width, y: (1 - (yNdc * 0.5 + 0.5)) * height, depth: zCam };
  }

  private getNearPlane(): number {
    return clamp(this.camera.distance * 0.001, 0.0005, 0.02);
  }

  private applyDepthFade(opacity: number, samplePoint: Vec3): number {
    if (!this.depthFadeEnabled) return opacity;
    const cam = this.getCameraPosition();
    const dist = Math.hypot(samplePoint.x - cam.x, samplePoint.y - cam.y, samplePoint.z - cam.z);
    const t = Math.max(0, (dist - 8) / 28);
    const falloff = Math.exp(-this.depthFadeStrength * 0.04 * Math.pow(t, this.depthFadeExponent));
    return opacity * clamp(falloff, 0, 1);
  }

  projectWorldToScreen(point: Vec3): { x: number; y: number } | null {
    const projected = this.projectPoint(point);
    if (!projected) {
      return null;
    }
    return { x: projected.x, y: projected.y };
  }
}

type Vec3 = { x: number; y: number; z: number };
type ScreenPoint = { x: number; y: number; depth: number };

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function pointInQuad2d(
  px: number,
  py: number,
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
  d: { x: number; y: number }
): boolean {
  return pointInTriangle2d(px, py, a, b, c) || pointInTriangle2d(px, py, a, c, d);
}

function pointInTriangle2d(
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

function intersectAxisPlane(ray: { origin: Vec3; dir: Vec3 }, axis: "x" | "y" | "z", value: number): number | null {
  const denom = axis === "x" ? ray.dir.x : axis === "y" ? ray.dir.y : ray.dir.z;
  if (Math.abs(denom) < 1e-4) return null;
  const originComp = axis === "x" ? ray.origin.x : axis === "y" ? ray.origin.y : ray.origin.z;
  const t = (value - originComp) / denom;
  return t >= 0 ? t : null;
}

function stableCellIndex(value: number): number {
  const nearest = Math.round(value);
  // Prevent jitter near integer boundaries from flipping cell choice.
  if (Math.abs(value - nearest) < 1e-5) return nearest;
  return Math.floor(value);
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const value = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!value) return { r: 0.2667, g: 0.2667, b: 0.2667 };
  return {
    r: Number.parseInt(value[1], 16) / 255,
    g: Number.parseInt(value[2], 16) / 255,
    b: Number.parseInt(value[3], 16) / 255
  };
}
