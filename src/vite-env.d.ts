/// <reference types="vite/client" />

/**
 * Replaced at build time by Vite's `define` (see vite.config.ts). A different
 * value on two runs means the bundle was rebuilt between them.
 */
declare const __BUILD_ID__: string;

/**
 * libheif ships emscripten's generated bindings but no types for the friendly
 * wrapper, which is the only part we use. This is that wrapper, narrowed to
 * what a preview needs.
 */
declare module "libheif-js/wasm-bundle" {
  interface HeifImage {
    get_width(): number;
    get_height(): number;
    /**
     * Fills `data` with RGBA pixels and hands it back, or null on failure.
     * Callback-style rather than a promise because the decode happens in
     * chunks on the main thread.
     */
    display(data: ImageData, cb: (out: ImageData | null) => void): void;
    free?(): void;
  }
  interface HeifDecoder {
    decode(buffer: Uint8Array): HeifImage[];
  }
  interface LibHeif {
    HeifDecoder: new () => HeifDecoder;
  }
  const libheif: LibHeif;
  export default libheif;
}
