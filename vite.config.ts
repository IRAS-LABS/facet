import { readdir, readFile, rm, stat } from "node:fs/promises";
import { defineConfig, type Plugin } from "vite";

// Resolve a path relative to this file without pulling in @types/node just for
// `fileURLToPath`. On Windows the URL pathname is "/C:/…", so strip the leading
// slash before the drive letter, and decode in case the checkout path has
// escaped characters.
const here = (rel: string): string =>
  decodeURIComponent(new URL(rel, import.meta.url).pathname).replace(
    /^\/([A-Za-z]:)/,
    "$1",
  );

/**
 * Serves the dev harnesses' sample files, in dev only, from `fixtures/`.
 *
 * metacheck, hexcheck and tablecheck need real photographs and real
 * spreadsheets — a decoder tested against bytes it generated itself proves
 * only that it is self-consistent. The obvious place to put them is
 * `public/`, and that is where they lived until 2026-08-16, when two things
 * went wrong on the same afternoon.
 *
 * They rotted: somebody cleaned the staged folders up, and from then on all
 * three harnesses died at their first fetch. They did not report a failure —
 * two threw on a null partway through — so the suite quietly ran nine of
 * twelve and still called itself green.
 *
 * Then they shipped: `public/` is copied wholesale into `dist/`, `dist/` is
 * baked into the Rust binary by `generate_context!`, and an APK was built
 * with somebody's holiday photos inside it. Nothing left the machine, but
 * only because nobody had installed it yet.
 *
 * Serving them from outside `public/` makes the second failure impossible
 * rather than merely unlikely: there is no build step that copies
 * `fixtures/`, so no staging mistake can reach an artifact. `apply: "serve"`
 * means this plugin does not exist during `vite build` at all.
 */
function fixtures(): Plugin {
  const DIRS = ["_metacheck", "_hexcheck", "_tablecheck", "_autoblurcheck"];
  return {
    name: "facet-fixtures",
    apply: "serve",
    configureServer(server) {
      // `url?: string | undefined`, not `url?: string`: under
      // exactOptionalPropertyTypes those are different types, and the second
      // one says "absent, or a string" — which node's IncomingMessage, whose
      // `url` is present and possibly undefined, does not satisfy.
      server.middlewares.use((req: { url?: string | undefined }, res, next) => {
        const url = (req.url ?? "").split("?")[0] ?? "";
        const dir = DIRS.find((d) => url.startsWith(`/${d}/`));
        if (!dir) return next();

        // Reject anything with a path segment beyond `<dir>/<name>`; these
        // files are read straight off disk and the dev server, though bound
        // to 127.0.0.1, has no business resolving "..".
        const name = url.slice(dir.length + 2);
        if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) {
          return next();
        }

        void readFile(here(`./fixtures/${dir}/${name}`)).then(
          (bytes: Uint8Array) => {
            res.setHeader("Content-Type", "application/octet-stream");
            res.end(bytes);
          },
          () => {
            // A 404 here means "run scripts/fixtures.ps1", and the harness
            // that hits it will otherwise fail somewhere far less obvious.
            res.statusCode = 404;
            res.end(`${url} is not staged — run scripts/fixtures.ps1`);
          },
        );
      });
    },
  };
}


/**
 * Deletes anything from `dist/` that is not on the allowlist below.
 *
 * `public/` is copied wholesale into `dist/`, and `dist/` is baked into the
 * Rust binary by `generate_context!`. So a file that is merely *sitting* in
 * `public/` -- a scratch file, a locally generated blob, a photograph staged
 * for one afternoon -- ends up inside every installer and every APK built
 * from that tree, where it cannot be noticed and cannot be taken back.
 *
 * An allowlist rather than a denylist, and enforced on the output rather than
 * the input, because the failure this guards against is precisely the file
 * nobody thought about. Adding a genuinely new asset means adding a line here,
 * which is the point: one deliberate edit, in a file that gets reviewed.
 *
 * Each removal is printed, and the files the app fetches by hand at runtime are
 * checked for afterwards. Printing was supposed to be enough and twice was not:
 * a warning in the middle of a hundred lines of build output is not a warning.
 * `tessdata` went missing and OCR silently reached for a CDN; `voice` went
 * missing and read-aloud silently guessed every word. Both shipped. So the
 * required list below is asserted rather than announced, and a build that would
 * drop one of them fails instead.
 */
function shipOnly(): Plugin {
  const ALLOWED = new Set([
    "index.html",
    "assets",
    "models",
    // The bundled English OCR data. It is here for the same reason `models`
    // is: fetched by `scripts/fetch-models.py`, pinned by sha256, and needed
    // at runtime. Without this line the build silently dropped it and OCR
    // fell back to a CDN fetch the packaged app's CSP had no host for -- the
    // exact failure bundling it was meant to end.
    "tessdata",
    // The read-aloud pronunciation dictionary, for exactly the same reason,
    // and it was missed for exactly as long. Every build of FACET ever shipped
    // dropped `voice/` here, so `cmudict-ipa.txt.gz` 404'd in the packaged app,
    // `dictionary()` swallowed it as designed, and every single word the
    // natural voices read was guessed by letter-to-sound rule. It sounded like
    // it. Nothing caught it because the dev server serves `public/` straight
    // off disk, so every check passed on a dictionary the shipped app did not
    // have. espeak-ng does the English now and does not need this file, but the
    // non-English voices and any machine where espeak will not load still fall
    // back to it, and a fallback that is not in the build is not a fallback.
    "voice",
    // The pop-out window's page. A second entry rather than a mode of
    // index.html, so a pop-out does not boot the whole explorer to show one
    // file.
    "pip.html",
    // The 3D viewer's Draco / KTX2 decoders, copied out of three's own
    // examples so a compressed glTF never needs a CDN.
    "decoders",
    "favicon.ico",
    "icon-192.png",
    "icon-512.png",
  ]);
  return {
    name: "facet-ship-only",
    apply: "build",
    async closeBundle() {
      const dist = here("./dist");
      let names: string[];
      try {
        names = await readdir(dist);
      } catch {
        return;
      }
      for (const name of names) {
        if (ALLOWED.has(name)) continue;
        await rm(`${dist}/${name}`, { recursive: true, force: true });
        console.warn(`[facet] not on the ship list, dropped from dist/: ${name}`);
      }

      // Assets the app asks for by URL at runtime. A bundler cannot see these
      // -- there is no import to follow -- so nothing but this list stands
      // between a missing file and an app that degrades quietly in the hands
      // of someone who will never know what it was supposed to sound like.
      const REQUIRED = [
        "voice/cmudict-ipa.txt.gz",
        "tessdata/eng.traineddata.gz",
      ];
      const missing: string[] = [];
      for (const rel of REQUIRED) {
        try {
          await stat(`${dist}/${rel}`);
        } catch {
          missing.push(rel);
        }
      }
      if (missing.length > 0) {
        throw new Error(
          `[facet] the build is missing runtime assets the app fetches by URL: ${missing.join(", ")}. `
            + "Either the file is not in public/, or its top folder is not on the ship list above.",
        );
      }
    },
  };
}

// 127.0.0.1 only, and strictPort so a collision fails loudly instead of
// silently drifting to 8184 -- the Tauri config points at one fixed port.
export default defineConfig({
  plugins: [fixtures(), shipOnly()],
  // A stamp that changes on every build, read by core/undo/session.ts. It is
  // there to tell "the app was replaced" apart from "the app crashed", which
  // the "still running" flag alone cannot do: an installer force-kills the
  // running copy without it getting to say goodbye. The version in
  // package.json cannot stand in -- it does not move between two sideloads of
  // the same version, which is exactly the case that misfires.
  define: {
    __BUILD_ID__: JSON.stringify(Date.now().toString(36)),
  },
  server: {
    host: "127.0.0.1",
    port: 8183,
    strictPort: true,
    watch: {
      // The Rust build writes multi-GB of churning binaries into target/. The
      // watcher has no business there, and on Windows it dies outright trying
      // to stat an .exe cargo is mid-write on.
      //
      // `src/dev/tbl/` is the same hazard in miniature: the fixture generator
      // writes half-gigabyte parquet files there through temporaries, and on
      // 2026-08-16 the watcher took an EBUSY on one of them and brought the
      // whole dev server down mid-suite. Nothing imports these files — the
      // harnesses fetch them over HTTP — so there is nothing to watch for.
      //
      // One ignore per crate, not one glob over "**/target/**", so a stray
      // node_modules/…/target stays watched.
      ignored: [
        "**/src-tauri/**",
        "**/src/dev/tbl/**",
        "**/fixtures/**",
      ],
    },
  },
  resolve: {
    alias: {
      "@core": here("./src/core"),
      "@ui": here("./src/ui"),
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
    rollupOptions: {
      // The explorer, and the pop-out page. Anything else that needs building
      // has its own config, so its assets are not emptied and rewritten every
      // time FACET is rebuilt.
      input: {
        main: here("./index.html"),
        pip: here("./pip.html"),
      },
    },
  },
});
