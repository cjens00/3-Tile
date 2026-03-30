export type TilesetFormat = "png" | "tga" | "bmp";

export interface ParsedTileset {
  format: TilesetFormat;
  width: number;
  height: number;
  bitDepth?: number;
}

export function parseTileset(filePath: string, bytes: Uint8Array): ParsedTileset {
  const extension = filePath.split(".").pop()?.toLowerCase();
  if (extension === "png") {
    return parsePng(bytes);
  }
  if (extension === "bmp") {
    return parseBmp(bytes);
  }
  if (extension === "tga") {
    return parseTga(bytes);
  }
  throw new Error("Unsupported tileset extension. Use PNG, BMP, or TGA.");
}

export function validateTileset(parsed: ParsedTileset): void {
  if (parsed.width <= 0 || parsed.height <= 0) {
    throw new Error("Tileset dimensions must be positive.");
  }
  if (parsed.format === "png" && parsed.bitDepth !== 8 && parsed.bitDepth !== 16) {
    throw new Error("PNG tilesets must use 8-bit or 16-bit depth.");
  }
}

export function normalizeTilesetScale(scale: number): number {
  const integer = Math.trunc(scale);
  return Math.max(1, Math.min(100, integer));
}

function parsePng(bytes: Uint8Array): ParsedTileset {
  if (bytes.length < 33) {
    throw new Error("PNG file is too small.");
  }
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[i] !== signature[i]) {
      throw new Error("Invalid PNG signature.");
    }
  }
  const chunkType = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  if (chunkType !== "IHDR") {
    throw new Error("PNG missing IHDR chunk.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  const bitDepth = bytes[24];
  return { format: "png", width, height, bitDepth };
}

function parseBmp(bytes: Uint8Array): ParsedTileset {
  if (bytes.length < 30) {
    throw new Error("BMP file is too small.");
  }
  if (bytes[0] !== 0x42 || bytes[1] !== 0x4d) {
    throw new Error("Invalid BMP signature.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = Math.abs(view.getInt32(18, true));
  const height = Math.abs(view.getInt32(22, true));
  const bitDepth = view.getUint16(28, true);
  return { format: "bmp", width, height, bitDepth };
}

function parseTga(bytes: Uint8Array): ParsedTileset {
  if (bytes.length < 18) {
    throw new Error("TGA file is too small.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint16(12, true);
  const height = view.getUint16(14, true);
  const bitDepth = view.getUint8(16);
  return { format: "tga", width, height, bitDepth };
}
