import type { ExportKind } from "./ui";

declare global {
  interface Window {
    threeTileApi: {
      onMenuAction(callback: (action: string) => void): () => void;
      openProject(): Promise<{ filePath: string; bytes: Uint8Array } | null>;
      saveProject(bytes: Uint8Array, filePath?: string): Promise<{ filePath: string } | null>;
      importTileset(): Promise<{ filePath: string; bytes: Uint8Array } | null>;
      exportData(
        kind: ExportKind,
        bytes: Uint8Array,
        suggestedName: string
      ): Promise<{ filePath: string } | null>;
    };
  }
}

export {};
