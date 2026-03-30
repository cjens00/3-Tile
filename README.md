# 3Tile (Scaffold)

Electron + WebGPU starter for the `3Tile` desktop app.

## Current scaffold features

- Native Electron menu with:
  - `File -> New, Load, Save, Save As, Import Tileset, Export -> Geometry/Texture/Both, Quit`
  - `Edit -> Preferences`
  - `About -> About The App`
- Renderer UI with:
  - Blender-style camera controls:
    - `Alt + LMB drag` rotate
    - `Alt + RMB drag` pan
    - wheel zoom
    - hold `RMB` + `W/A/S/D` flythrough
  - Selection vs Creation mode dock
  - Selection mode hotkeys `1/2/3` for vertex/edge/face
  - Plane lock hotkeys `Shift+Z` (`XY`), `Shift+X` (`YZ`), `Shift+Y` (`XZ`), `Esc` to clear lock
- Viewport visuals:
  - Blender-like ground-oriented view with plane grids (`XY`,`YZ`,`XZ`)
  - Per-plane integer scale controls (`1..100`)
  - Per-plane opacity controls (`0..100%`)
  - Selectable background color (default `#444444`)
- Realtime mesh/selection drawing in viewport (2D overlay over WebGPU clear pass)
- `.3tile` project save/load binary wrapper with versioned header
- Topology-backed mesh core:
  - Vertex deduplication by grid position
  - Edge table with per-edge face counts
  - Manifold safety check (rejects faces that would exceed 2 faces per edge)
  - Nearest vertex/edge/face selection queries for viewport selection mode
- Tileset import and validation (`png/tga/bmp`):
  - Reads source dimensions from file headers
  - Enforces width/height multiples of `8`
  - Enforces PNG bit depth of `8` or `16`
  - Per-tileset integer scale controls (`1..100`)
  - Active tile index control used when creating new quads
- Geometry export to `.obj` (triangulated quads); texture/both exports still scaffolded

## Run

```bash
npm install
npm run dev
```

## Notes

This is the initial architecture scaffold. Modeling topology, manifold enforcement, real UV generation, and full exporters are intentionally left as next implementation milestones.
