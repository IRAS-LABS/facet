/**
 * The sliver of Node that `vite.config.ts` touches.
 *
 * The config file runs in Node, but nothing else in this project does — the
 * app is a browser bundle and a Rust binary. Pulling in @types/node would put
 * `process`, `Buffer`, `__dirname` and a global `require` in scope for every
 * file under src/, and the first accidental use of one compiles cleanly and
 * then throws in the WebView. `here()` in the config already goes the long way
 * round with `import.meta.url` for the same reason.
 *
 * So the two things the fixtures plugin actually needs are declared here
 * instead. If this list ever grows past a handful, that is the signal to stop
 * and add the real types with a proper `types` entry scoped to the config.
 */
declare module "node:fs/promises" {
  export function readFile(path: string): Promise<Uint8Array>;
}
