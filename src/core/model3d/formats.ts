/**
 * Telling one 3D file from another, before anything tries to draw it (item 13).
 *
 * The explorer already calls eleven extensions `model3d`, and FACET can draw
 * five of them. That gap is the first thing this file exists for: a `.blend` has
 * to be turned away *with a sentence* rather than opened into an empty grey
 * scene, because an empty scene is a claim about the file ("it has nothing in
 * it") and turning it away is a claim about FACET ("I can't read this"), and
 * only the second one is true.
 *
 * The second thing is that **the extension is a hint and the bytes are the
 * fact**, and for exactly one format that difference bites hard enough to
 * matter. See `sniff`.
 *
 * DOM-free and loader-free on purpose: this decides *what* a file is, three.js
 * decides how to read it, and the view decides what to say. Keeping the first
 * one here means the harness can hand it byte arrays it built by hand — which is
 * the only way to test the binary-STL trap without shipping a fixture.
 */

/**
 * What FACET can actually put on screen.
 *
 * The two STL and two PLY entries are separate members rather than a flag,
 * because the loader is chosen from this value and a wrong guess doesn't
 * degrade — it produces either a parse error or, worse, a mesh made of
 * misinterpreted floats.
 */
export type Model3DFormat =
  | "glb"
  | "gltf"
  | "obj"
  | "stl-binary"
  | "stl-ascii"
  | "ply-binary"
  | "ply-ascii";

/** The extensions `sniff` will attempt. Everything else is somebody else's job. */
export const VIEWABLE_EXTS: readonly string[] = ["glb", "gltf", "obj", "stl", "ply"];

/**
 * The 3D extensions FACET recognises but cannot draw, each with the reason.
 *
 * Written out rather than derived as "the ones not in VIEWABLE_EXTS", because
 * the reasons differ and a user staring at a file they cannot open deserves the
 * specific one. `.blend` is not a mesh format at all; `.fbx` is a proprietary
 * format with a licence that a bundled reader would have to answer for; `.usd`
 * needs a runtime an order of magnitude larger than the rest of this app.
 */
export const UNSUPPORTED: Readonly<Record<string, string>> = {
  fbx: "FBX is Autodesk's format and FACET has no reader for it.",
  blend: "A .blend is a whole Blender session, not a mesh — open it in Blender.",
  usd: "USD needs a runtime larger than the rest of FACET put together.",
  usdz: "USD needs a runtime larger than the rest of FACET put together.",
  dae: "COLLADA is readable but nothing here reads it yet.",
  "3mf": "3MF is a print package, not a scene — nothing here reads it yet.",
};

/** Normalise however the extension arrived: `.STL`, `STL`, `stl` all match. */
function ext(raw: string): string {
  return raw.trim().replace(/^\.+/, "").toLowerCase();
}

/** Whether `sniff` will even look at a file with this extension. */
export function canView(rawExt: string): boolean {
  return VIEWABLE_EXTS.includes(ext(rawExt));
}

/** The sentence to show instead of a scene, or null if there is no complaint. */
export function whyNot(rawExt: string): string | null {
  const e = ext(rawExt);
  if (canView(e)) return null;
  return UNSUPPORTED[e] ?? `FACET does not read .${e} files.`;
}

/**
 * How much of the head of a file `sniff` needs.
 *
 * The PLY header can legitimately run long (one line per element property, and
 * a scanner dump can declare a dozen), so this is generous rather than tight;
 * it is still a single small read instead of the whole mesh.
 */
export const SNIFF_BYTES = 4096;

const GLB_MAGIC = 0x46546c67; // "glTF", read as a little-endian uint32.

/**
 * What this file actually is, from its bytes and — only as a tie-breaker — its
 * name.
 *
 * **The one that matters is STL.** A binary STL begins with an 80-byte header
 * that is free-form text, and a large number of exporters write `solid
 * <something>` into it, which is *also* exactly how an ASCII STL begins. Reading
 * the first five bytes and believing them is the obvious test, it is what most
 * code does, and it is wrong for a substantial share of the STLs in the world:
 * the ASCII parser then finds no `facet normal` and reports an empty mesh, so
 * the file looks broken rather than the reader looking wrong.
 *
 * The reliable test is arithmetic and not textual. A binary STL is exactly
 * `80 + 4 + 50n` bytes for `n` triangles, and `n` is stored at offset 80. If the
 * length the file *claims* matches the length the file *has*, it is binary — no
 * text can fake that by accident, and no ASCII STL can satisfy it except by a
 * coincidence too narrow to worry about. That check needs the total size, which
 * is why this takes `totalBytes` separately from the head it is handed.
 *
 * `.gltf` and `.glb` are checked by magic and not by name for a smaller version
 * of the same reason: exporters and download links rename these two into each
 * other constantly, and a GLB fed to the JSON parser fails on byte one.
 *
 * Returns null when the file is not something FACET draws. A null here is not an
 * error — the caller pairs it with `whyNot`.
 */
export function sniff(head: Uint8Array, totalBytes: number, rawExt: string): Model3DFormat | null {
  const e = ext(rawExt);

  // Magic first, because it outranks the name whenever both have an opinion.
  if (head.length >= 4) {
    const dv = new DataView(head.buffer, head.byteOffset, Math.min(head.byteLength, 4));
    if (dv.getUint32(0, true) === GLB_MAGIC) return "glb";
  }
  if (startsWith(head, "ply")) return plyFlavour(head);

  if (e === "stl") return stlFlavour(head, totalBytes);
  if (e === "obj") return "obj";
  if (e === "gltf" || e === "glb") {
    // Magic said it is not a GLB, so a JSON glTF is the only thing left it can
    // honestly be. Trusting the extension here is safe in a way it was not for
    // STL: the glTF parser fails loudly on non-JSON rather than quietly.
    return "gltf";
  }
  // A `.ply` whose header is not `ply` is corrupt, not another format.
  return null;
}

/** `format ascii 1.0` or one of the two binary orderings, on the second line. */
function plyFlavour(head: Uint8Array): Model3DFormat {
  const text = ascii(head, 0, Math.min(head.length, 256)).toLowerCase();
  // Big-endian is folded in with little-endian: which one it is matters to the
  // loader, not to the chooser, and three's PLYLoader reads the header itself.
  return text.includes("format binary") ? "ply-binary" : "ply-ascii";
}

/**
 * The size test described in `sniff`, with the text test kept only as the
 * tie-breaker for the case the size test cannot reach.
 */
function stlFlavour(head: Uint8Array, totalBytes: number): Model3DFormat {
  if (head.length >= 84 && totalBytes >= 84) {
    const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const triangles = dv.getUint32(80, true);
    // A stray uint32 read out of ASCII text is usually enormous; the guard keeps
    // the multiplication away from anything that could overflow into a match.
    if (triangles <= 200_000_000 && 84 + triangles * 50 === totalBytes) return "stl-binary";
  }
  // Either the file is too short to be binary, or its claimed triangle count
  // does not match its size. Both mean text — including a *truncated* binary
  // STL, which lands here and fails in the ASCII parser with a message. That is
  // the right outcome: "I could not read this" beats drawing half a mesh.
  return "stl-ascii";
}

function startsWith(bytes: Uint8Array, prefix: string): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[i] !== prefix.charCodeAt(i)) return false;
  }
  return true;
}

function ascii(bytes: Uint8Array, from: number, to: number): string {
  let out = "";
  for (let i = from; i < to; i++) out += String.fromCharCode(bytes[i] ?? 0);
  return out;
}

/** A human name for the format, for the viewer's status line. */
export function formatLabel(f: Model3DFormat): string {
  switch (f) {
    case "glb":
      return "glTF (binary)";
    case "gltf":
      return "glTF";
    case "obj":
      return "OBJ";
    case "stl-binary":
      return "STL (binary)";
    case "stl-ascii":
      return "STL (text)";
    case "ply-binary":
      return "PLY (binary)";
    case "ply-ascii":
      return "PLY (text)";
  }
}

/**
 * Whether the format carries its own materials.
 *
 * OBJ, STL and PLY arrive as bare geometry — STL has no colour at all, PLY
 * sometimes has per-vertex colours, and an OBJ's `.mtl` is a second file that
 * may not have come along. The viewer needs to know so it can apply a default
 * material *and say that it did*, rather than letting a user conclude that
 * their model exported grey.
 */
export function hasOwnMaterials(f: Model3DFormat): boolean {
  return f === "glb" || f === "gltf";
}
