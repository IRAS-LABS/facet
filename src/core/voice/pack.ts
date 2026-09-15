/**
 * The Kokoro voice pack: getting it, keeping it, removing it (item 22).
 *
 * FACET's promise is that nothing leaves the machine, and a feature that
 * quietly downloaded 100 MB the first time you pressed play would break that
 * promise in the most literal way possible. So the pack is never fetched on
 * its own. The system voices speak immediately, for free, and the download is
 * something the user asks for, sees the size of before agreeing to, watches
 * the progress of, and can remove again in one press.
 *
 * Voices are fetched one at a time, not in a block. The model is 88 MB and is
 * needed once; each voice is 523 kB and only the ones actually chosen are ever
 * downloaded. Pulling all 54 up front would nearly double the wait to hear the
 * first word for no benefit -- almost nobody uses more than two or three.
 *
 * It is stored in IndexedDB rather than on disk. That is a deliberate choice
 * with a real trade-off:
 *
 * For it -- one implementation covers Windows and Android identically, no new
 * filesystem permission is needed on either, no directory has to be chosen or
 * created, and uninstalling FACET takes the pack with it rather than leaving
 * 100 MB orphaned in an app-data folder forever.
 *
 * Against it -- the pack is not a file the user can see in their own file
 * manager, and on Android an aggressive "clear storage" removes it. Both are
 * survivable: the reader says whether the pack is present, and re-downloading
 * is one button. Losing a model you can re-fetch is not losing data.
 *
 * An offline install is supported too, by handing `install` the bytes from a
 * local file. A machine that never touches the internet can still have the
 * good voices, which for this app's users is not a hypothetical.
 */

const DB = "facet-voice";
const STORE = "pack";
const VERSION = 1;

/** One file of the pack. `voice:af_heart` for a voice, `model` for the model. */
export type PartName = string;

interface Part {
  name: PartName;
  bytes: ArrayBuffer;
  /** Where it came from, so the reader can show its provenance. */
  source: string;
  at: number;
}

export interface PackStatus {
  /** The model is present: Kokoro can speak any voice that is also present. */
  installed: boolean;
  /** Bytes on hand. */
  size: number;
  /** Voice ids that have been downloaded. */
  voices: string[];
  parts: { name: PartName; size: number; source: string }[];
}

/**
 * Where the pack comes from.
 *
 * Both are public model repositories and both are Apache-2.0. Neither is
 * contacted unless the user presses the download button. The quantised build
 * is the one worth having on a laptop and a phone: the full-precision model is
 * roughly four times the size for a difference most listeners cannot hear
 * through a phone speaker.
 */
const REPO = "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main";
export const MODEL_URL = `${REPO}/onnx/model_q8f16.onnx`;
export const voiceUrl = (id: string): string => `${REPO}/voices/${id}.bin`;

/** Rough sizes, shown before the user agrees to a download. */
export const MODEL_BYTES = 88_000_000;
export const VOICE_BYTES = 523_264;

export const MODEL = "model";
export const voiceKey = (id: string): string => `voice:${id}`;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = (): void => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "name" });
    };
    req.onsuccess = (): void => resolve(req.result);
    req.onerror = (): void => reject(req.error ?? new Error("Could not open the voice store"));
  });
}

function run<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = (): void => resolve(req.result);
    req.onerror = (): void => reject(req.error ?? new Error("Voice store failed"));
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => Promise<T>): Promise<T> {
  const db = await open();
  try {
    const tx = db.transaction(STORE, mode);
    const out = await fn(tx.objectStore(STORE));
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = (): void => resolve();
      tx.onerror = (): void => reject(tx.error ?? new Error("Voice store failed"));
      tx.onabort = (): void => reject(tx.error ?? new Error("Voice store aborted"));
    });
    return out;
  } finally {
    db.close();
  }
}

/**
 * What is installed right now.
 *
 * Never throws. A browser with IndexedDB disabled, a private window, a phone
 * that cleared the app's storage -- all of them mean "no pack", which is a
 * state the reader already handles, rather than an error it would have to.
 */
export async function status(): Promise<PackStatus> {
  try {
    const parts = await withStore("readonly", (s) => run(s.getAll() as IDBRequest<Part[]>));
    const listed = parts.map((p) => ({ name: p.name, size: p.bytes.byteLength, source: p.source }));
    return {
      installed: parts.some((p) => p.name === MODEL && p.bytes.byteLength > 0),
      size: listed.reduce((n, p) => n + p.size, 0),
      voices: listed.filter((p) => p.name.startsWith("voice:")).map((p) => p.name.slice(6)),
      parts: listed,
    };
  } catch {
    return { installed: false, size: 0, voices: [], parts: [] };
  }
}

/** Read one part. Null when it is not installed. */
export async function part(name: PartName): Promise<ArrayBuffer | null> {
  try {
    const found = await withStore("readonly", (s) => run(s.get(name) as IDBRequest<Part | undefined>));
    return found?.bytes ?? null;
  } catch {
    return null;
  }
}

/** Store one part, replacing whatever was there. */
export async function install(name: PartName, bytes: ArrayBuffer, source: string): Promise<void> {
  await withStore("readwrite", (s) => run(s.put({ name, bytes, source, at: Date.now() } satisfies Part)));
}

/** Remove the whole pack. The reader offers this beside the download button. */
export async function remove(): Promise<void> {
  await withStore("readwrite", (s) => run(s.clear()));
}

/** Remove one voice, keeping the model. */
export async function removeVoice(id: string): Promise<void> {
  await withStore("readwrite", (s) => run(s.delete(voiceKey(id))));
}

export interface Progress {
  /** What is being fetched, in words: "the model", "Heart". */
  what: string;
  done: number;
  total: number;
}

/**
 * Fetch one part, unless it is already here.
 *
 * Streams rather than buffering the whole response, so the progress bar is
 * real and a cancel takes effect immediately instead of at the end of an
 * eighty-megabyte read.
 */
export async function fetchPart(
  name: PartName,
  url: string,
  what: string,
  expected: number,
  onProgress?: (p: Progress) => void,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const have = await part(name);
  if (have) return have;

  const res = await fetch(url, { signal: signal ?? null, redirect: "follow" });
  if (!res.ok) throw new Error(`Could not download ${what}: ${res.status} ${res.statusText}`);

  const total = Number(res.headers.get("content-length") ?? 0) || expected;
  const bytes = await drain(res, (done) => onProgress?.({ what, done, total }), signal);
  await install(name, bytes, url);
  return bytes;
}

/** Download the model. The big one, and the one the user is asked about. */
export const fetchModel = (onProgress?: (p: Progress) => void, signal?: AbortSignal): Promise<ArrayBuffer> =>
  fetchPart(MODEL, MODEL_URL, "the voice model", MODEL_BYTES, onProgress, signal);

/** Download one voice. Half a megabyte; done without asking once the model is here. */
export const fetchVoice = (
  id: string,
  label: string,
  onProgress?: (p: Progress) => void,
  signal?: AbortSignal,
): Promise<ArrayBuffer> => fetchPart(voiceKey(id), voiceUrl(id), label, VOICE_BYTES, onProgress, signal);

/** Read a response body, reporting progress as it goes. */
async function drain(
  res: Response,
  onDone: (n: number) => void,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  if (!res.body) return res.arrayBuffer();

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let done = 0;

  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
      done += next.value.byteLength;
      onDone(done);
    }
  } finally {
    reader.releaseLock();
  }

  const out = new Uint8Array(done);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out.buffer;
}

/** A size a person can read: "88 MB". */
export function niceSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} kB`;
  return `${bytes} B`;
}
