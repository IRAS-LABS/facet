/**
 * Tesseract, driven (item 32).
 *
 * All the I/O and none of the opinions: this file starts a worker, hands it a
 * canvas, and turns what comes back into an `OcrPage`. Every judgement about
 * what the result *means* — reading order, paragraphs, hyphens, whether the
 * scan was any good — is in `page.ts`, where it can be checked against
 * hand-built input without a 3 MB WASM binary in the loop.
 *
 * Why Tesseract rather than one of the transformer models already installed
 * here for transcription: TrOCR and Florence-2 read a *line* — they take a
 * pre-cropped strip of text and have no idea where the lines are. Finding them
 * is the layout analysis Tesseract has and they do not, and a document-capable
 * vision model that does both is 500 MB to a gigabyte. Tesseract is ~4 MB of
 * WASM and ~2 MB per language, gives per-word boxes and confidences that make
 * the click-to-select overlay possible, and writes a searchable PDF. For
 * scanned documents — which is what item 32 is — it is simply the right tool.
 *
 * Everything is loaded from the app's own bundle except the language data,
 * which is fetched once per language and then cached in IndexedDB by
 * tesseract.js itself. That is the only part of this that needs the network,
 * it needs it once, and `LANGUAGES` says so where the user picks one.
 */

import { createWorker, type Worker } from "tesseract.js";

// Bundled, not fetched from a CDN: `?url` copies the file into the build and
// gives back a path the packaged app serves itself. The *self-contained* core
// (`.wasm.js`, ~3.9 MB with the WASM base64'd inside) rather than the 89 KB
// loader beside it, because that loader fetches its sibling `.wasm` by name
// and Vite hashes the two files independently — the name it asks for would not
// exist. Bigger file, no broken fetch.
//
// SIMD-LSTM specifically: tesseract.js only picks a build itself when given a
// directory, and there is no directory to give once the assets are hashed.
// Every WebView2 and every Chromium since 2021 has fixed-width SIMD, and LSTM
// is the only engine mode this app uses.
import coreUrl from "tesseract.js-core/tesseract-core-simd-lstm.wasm.js?url";
import workerUrl from "tesseract.js/dist/worker.min.js?url";

import { fromRaw, rescale, type OcrPage, type RawResult } from "./page";

/** LSTM only. The legacy engine needs different data files and is worse. */
const LSTM_ONLY = 1;

export interface Language {
  code: string;
  name: string;
}

/**
 * The languages offered, and the order they are offered in.
 *
 * Not all 100-odd Tesseract has: a list that long is a wall, and every entry
 * costs a download the first time it is chosen. These are the scripts most
 * likely to arrive as a scan on this machine, with Latin ones first because
 * they are also the ones the default handles well.
 *
 * Two or three can be combined — Tesseract takes `eng+heb` — which is worth
 * doing for a bilingual document and worth *not* doing otherwise, since each
 * added language slows recognition and gives the engine more ways to be wrong.
 */
export const LANGUAGES: readonly Language[] = [
  { code: "eng", name: "English" },
  { code: "heb", name: "Hebrew" },
  { code: "fra", name: "French" },
  { code: "deu", name: "German" },
  { code: "spa", name: "Spanish" },
  { code: "ita", name: "Italian" },
  { code: "por", name: "Portuguese" },
  { code: "nld", name: "Dutch" },
  { code: "pol", name: "Polish" },
  { code: "rus", name: "Russian" },
  { code: "ukr", name: "Ukrainian" },
  { code: "ara", name: "Arabic" },
  { code: "ell", name: "Greek" },
  { code: "tur", name: "Turkish" },
  { code: "hin", name: "Hindi" },
  { code: "jpn", name: "Japanese" },
  { code: "kor", name: "Korean" },
  { code: "chi_sim", name: "Chinese (simplified)" },
  { code: "chi_tra", name: "Chinese (traditional)" },
  { code: "vie", name: "Vietnamese" },
  { code: "tha", name: "Thai" },
];

export const nameOfLanguage = (code: string): string =>
  code
    .split("+")
    .map((c) => LANGUAGES.find((l) => l.code === c)?.name ?? c)
    .join(" + ");

export interface Progress {
  /** Something short and true, for a status line. */
  what: string;
  /** 0–1, or -1 when there is no way to know. */
  done: number;
}

export interface ReadOptions {
  /** One or more Tesseract codes, joined with "+". */
  language?: string;
  /** Also produce a searchable PDF of this page. */
  pdf?: boolean;
  /** Title recorded in that PDF. */
  title?: string;
  onProgress?(p: Progress): void;
}

export interface ReadResult {
  page: OcrPage;
  /** Present only when `pdf` was asked for. A one-page searchable PDF. */
  pdf?: Uint8Array;
}

/**
 * What the view talks to. The real one is below; the harness supplies its own.
 *
 * An interface rather than the class directly because every check in this
 * feature that is worth running — does the overlay line up, does search
 * highlight the right word, does cancelling mid-run leave the panel usable —
 * is a question about the *app*, and answering it should not take thirty
 * seconds and a model download.
 */
export interface Recogniser {
  read(image: HTMLCanvasElement, opts?: ReadOptions): Promise<ReadResult>;
  /** Give up on whatever is running. The next `read` starts a fresh worker. */
  cancel(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Below this, Tesseract's accuracy falls off a cliff, so the page is scaled up.
 *
 * Tesseract wants roughly 300 dpi — about 2500 px across an A4 page. A phone
 * photo cropped to a receipt, or a 96 dpi screenshot, comes in far under that
 * and reads as gibberish with confident-looking boxes around it. Bicubic
 * upscaling invents no detail, but it does give the line-finder enough rows
 * per glyph to work with, and in practice it is the difference between a
 * useless result and a good one.
 *
 * The boxes come back in the scaled space and are divided down again before
 * anyone sees them, so the overlay lines up with the picture on screen, not
 * with an intermediate the user never saw.
 */
const WANT_SHORT_SIDE = 1400;
const MAX_SCALE = 3;

export function scaleFor(width: number, height: number): number {
  const short = Math.min(width, height);
  if (short <= 0 || short >= WANT_SHORT_SIDE) return 1;
  // Whole numbers only: a 1.7× resample rings on the sharp edges of text in a
  // way that 2× does not, and the point of this is legibility to a line-finder.
  return Math.min(MAX_SCALE, Math.max(1, Math.round(WANT_SHORT_SIDE / short)));
}

function upscale(source: HTMLCanvasElement, by: number): HTMLCanvasElement {
  if (by <= 1) return source;
  const out = document.createElement("canvas");
  out.width = source.width * by;
  out.height = source.height * by;
  const ctx = out.getContext("2d");
  if (!ctx) return source;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, out.width, out.height);
  return out;
}

/** Tesseract's own status strings, said the way this app says things. */
function phrase(status: string): string {
  if (status.startsWith("loading tesseract core")) return "Starting the reader";
  if (status.startsWith("initializing tesseract")) return "Starting the reader";
  if (status.startsWith("loading language")) return "Fetching the language";
  if (status.startsWith("initializing api")) return "Getting ready";
  if (status.startsWith("recognizing")) return "Reading";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export class Tesseract implements Recogniser {
  private worker: Worker | null = null;
  private language = "";
  /** Set while a run is in flight, so `cancel` knows there is one. */
  private busy = false;
  private report: ((p: Progress) => void) | null = null;

  /**
   * Reuse the worker across pages, but rebuild it when the language changes.
   *
   * Starting one costs about three seconds — the WASM compile plus the
   * language load — and a twenty-page PDF that paid that per page would spend
   * a minute doing nothing. `reinitialize` exists for the language switch, but
   * a fresh worker is one code path instead of two and the switch is rare.
   */
  private async ready(language: string): Promise<Worker> {
    if (this.worker && this.language === language) return this.worker;
    if (this.worker) await this.close();

    const worker = await createWorker(language, LSTM_ONLY, {
      workerPath: workerUrl,
      corePath: coreUrl,
      // Language data is the one thing not in the bundle; caching it means the
      // network is touched once per language for the life of the install.
      cacheMethod: "refresh",
      logger: (m: { status?: string; progress?: number }) => {
        if (!this.report) return;
        this.report({
          what: phrase(m.status ?? ""),
          done: typeof m.progress === "number" ? m.progress : -1,
        });
      },
      errorHandler: (e: unknown) => {
        // Swallowing this would strand the promise below; tesseract.js rejects
        // the pending job itself, so all that is needed is somewhere for the
        // message to go that is not the console alone.
        console.error("[ocr]", e);
      },
    });

    this.worker = worker;
    this.language = language;
    return worker;
  }

  async read(image: HTMLCanvasElement, opts: ReadOptions = {}): Promise<ReadResult> {
    const language = opts.language?.trim() || "eng";
    this.report = opts.onProgress ?? null;
    this.busy = true;
    try {
      const worker = await this.ready(language);
      const by = scaleFor(image.width, image.height);
      const fed = upscale(image, by);

      const result = await worker.recognize(
        fed,
        // Auto-rotation: a page fed in sideways otherwise returns nothing at
        // all, and "nothing at all" is the failure a user cannot diagnose.
        // `problems()` tells them afterwards that it had to be turned.
        { rotateAuto: true, ...(opts.title ? { pdfTitle: opts.title } : {}) },
        { blocks: true, text: false, hocr: false, tsv: false, pdf: opts.pdf === true },
      );

      const raw = result.data as unknown as RawResult;
      const scaled = fromRaw(raw, { width: fed.width, height: fed.height }, language);
      const page = by > 1
        ? rescale(scaled, { width: image.width, height: image.height })
        : scaled;

      const pdfBytes = (result.data as { pdf?: number[] | null }).pdf;
      return pdfBytes && pdfBytes.length > 0
        ? { page, pdf: Uint8Array.from(pdfBytes) }
        : { page };
    } finally {
      this.busy = false;
      this.report = null;
    }
  }

  /**
   * There is no polite way to stop Tesseract mid-page.
   *
   * The WASM call does not yield, so the worker is killed and a new one starts
   * next time. The three seconds that costs are the price of a cancel button
   * that actually stops the machine getting hot, which is what a user pressing
   * it wants; the alternative is a button that greys itself out and lets the
   * page finish anyway.
   */
  async cancel(): Promise<void> {
    if (!this.busy && !this.worker) return;
    await this.close();
  }

  async close(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    this.language = "";
    if (!worker) return;
    try {
      await worker.terminate();
    } catch {
      // Terminating a worker that already died is not a problem worth raising.
    }
  }
}
