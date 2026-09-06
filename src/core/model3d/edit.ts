/**
 * Editing a model, and writing one back out (item 6).
 *
 * DOM-free and GPU-free, exactly like `./scene` and for the same reason: three's
 * exporters are pure. STL, OBJ and PLY are produced by walking the scene graph
 * and reading buffers, and glTF by serialising nodes — not one of them touches a
 * `WebGLRenderer`. That means every byte this module writes can be asserted in a
 * harness without a canvas, which matters more here than anywhere else in the
 * viewer: **an export is the only thing FACET does with a 3D file that the user
 * cannot undo by pressing Escape.**
 *
 * The edit itself is a small, serialisable record of *intent* — move, rotate,
 * scale, and a handful of material numbers — and never a mutation of the vertex
 * buffers. That is the same rule the photo editor follows (a region list, never
 * pixels) and it buys the same things: undo is free, the original geometry is
 * always one step away, and the whole edit fits in the crash-recovery record
 * that item 21 already writes.
 */

import type { BufferGeometry, Material, Mesh, Object3D } from "three";

/** A transform, in the units a person types rather than the ones three wants. */
export interface Placement {
  /** Model units. */
  move: { x: number; y: number; z: number };
  /** **Degrees**, because nobody types radians into a box. */
  turn: { x: number; y: number; z: number };
  /** Multipliers. 1 is the file's own size. */
  size: { x: number; y: number; z: number };
  /** When set, dragging one scale axis carries the other two with it. */
  locked: boolean;
}

/** The material numbers FACET is willing to change. */
export interface Look {
  /** Off means "leave the file's own materials completely alone". */
  on: boolean;
  /** `#rrggbb`. */
  colour: string;
  roughness: number;
  metalness: number;
  /** Faceted rather than smoothed. Reads the same normals; shades them per-face. */
  flat: boolean;
  /** 0–1. Anything below 1 also turns on transparency. */
  opacity: number;
}

/** One edit, whole. Small enough to keep a stack of, and to write to disk. */
export interface Edit {
  place: Placement;
  look: Look;
}

export const NO_EDIT: Edit = {
  place: {
    move: { x: 0, y: 0, z: 0 },
    turn: { x: 0, y: 0, z: 0 },
    size: { x: 1, y: 1, z: 1 },
    locked: true,
  },
  look: { on: false, colour: "#b9bfc9", roughness: 0.65, metalness: 0.05, flat: false, opacity: 1 },
};

/** A deep copy. Every edit on the undo stack has to be its own object. */
export function cloneEdit(e: Edit): Edit {
  return {
    place: {
      move: { ...e.place.move },
      turn: { ...e.place.turn },
      size: { ...e.place.size },
      locked: e.place.locked,
    },
    look: { ...e.look },
  };
}

/** Is this edit still the file as it arrived? Drives the "unsaved" mark. */
export function isUntouched(e: Edit): boolean {
  const p = e.place;
  return (
    !e.look.on &&
    p.move.x === 0 && p.move.y === 0 && p.move.z === 0 &&
    p.turn.x === 0 && p.turn.y === 0 && p.turn.z === 0 &&
    p.size.x === 1 && p.size.y === 1 && p.size.z === 1
  );
}

/**
 * A scale of zero is not a small model, it is a **destroyed** one.
 *
 * It flattens the geometry into a plane — or, on all three axes, a point — and
 * the damage is permanent the moment it is exported, because there is no factor
 * that brings a zero back. It also produces a zero-radius bounding sphere, which
 * `frameFor` guards against but only by refusing to divide by it. Clamping at a
 * thousandth keeps the model recoverable by typing a number, which is what
 * someone who overshot a slider is about to do.
 */
export const MIN_SCALE = 0.001;
export const MAX_SCALE = 1000;

/**
 * The sign is kept, and only the magnitude is clamped.
 *
 * A negative scale mirrors the model, which is a real operation someone might
 * want — and clamping it into the positive range would answer a typed `-1` with
 * a model collapsed to a sliver, which is the exact failure this function
 * exists to prevent. It is worth knowing that a mirror also reverses triangle
 * winding, so a mirrored part exported to STL reads as inside-out to a slicer;
 * that is what mirroring means, not something to be quietly corrected.
 */
export function clampScale(v: number): number {
  if (!Number.isFinite(v) || v === 0) return MIN_SCALE;
  const sign = v < 0 ? -1 : 1;
  return sign * Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.abs(v)));
}

/**
 * Put the edit on the object.
 *
 * Applied to the *model*, never to the stand that carries the up-axis
 * correction, so what gets exported is the file's own axes plus the edit the
 * user actually asked for.
 */
export function applyPlacement(object: Object3D, p: Placement): void {
  object.position.set(p.move.x, p.move.y, p.move.z);
  object.rotation.set(rad(p.turn.x), rad(p.turn.y), rad(p.turn.z));
  object.scale.set(clampScale(p.size.x), clampScale(p.size.y), clampScale(p.size.z));
  object.updateMatrixWorld(true);
}

function rad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Every material under an object, flattened and de-duplicated. */
export function eachMaterial(root: Object3D, fn: (m: Material) => void): void {
  const seen = new Set<Material>();
  root.traverse((o) => {
    const m = (o as Partial<Mesh>).material;
    if (!m) return;
    for (const one of Array.isArray(m) ? m : [m]) {
      if (seen.has(one)) continue;
      seen.add(one);
      fn(one);
    }
  });
}

/**
 * Materials that FACET can meaningfully edit.
 *
 * A `LineBasicMaterial` on a helper, or a `PointsMaterial` on a scan, has no
 * roughness and no metalness; writing those properties onto it puts fields on
 * an object that will never read them and quietly does nothing. Checking for
 * `roughness` is how three's own code distinguishes a standard-model material.
 */
function isShaded(m: Material): m is Material & {
  color: { set(v: string): void };
  roughness: number;
  metalness: number;
  flatShading: boolean;
  needsUpdate: boolean;
} {
  return "roughness" in m && "metalness" in m && "color" in m;
}

/**
 * Apply the look, or take it back off.
 *
 * Reversible on purpose. The file's own values are stashed under
 * `userData.fctLook` the first time they are overwritten, so turning the panel
 * off restores the material the file shipped rather than a guess at it — the
 * same contract the viewer's plain-material toggle already keeps with
 * `userData.fctOriginal`.
 */
export function applyLook(root: Object3D, look: Look): void {
  eachMaterial(root, (m) => {
    if (!isShaded(m)) return;
    const store = m.userData as Record<string, unknown>;
    if (!store.fctLook) {
      store.fctLook = {
        colour: (m.color as unknown as { getHex(): number }).getHex(),
        roughness: m.roughness,
        metalness: m.metalness,
        flat: m.flatShading,
        opacity: m.opacity,
        transparent: m.transparent,
      };
    }
    const was = store.fctLook as {
      colour: number; roughness: number; metalness: number;
      flat: boolean; opacity: number; transparent: boolean;
    };

    if (look.on) {
      m.color.set(look.colour);
      m.roughness = clamp01(look.roughness);
      m.metalness = clamp01(look.metalness);
      m.flatShading = look.flat;
      m.opacity = clamp01(look.opacity);
      m.transparent = look.opacity < 1;
    } else {
      (m.color as unknown as { setHex(v: number): void }).setHex(was.colour);
      m.roughness = was.roughness;
      m.metalness = was.metalness;
      m.flatShading = was.flat;
      m.opacity = was.opacity;
      m.transparent = was.transparent;
    }
    // Flat shading changes how the shader is compiled, not just a uniform, so
    // three has to be told; without this the checkbox does nothing at all.
    m.needsUpdate = true;
  });
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

// ── Export ────────────────────────────────────────────────────────────────────

export type ExportFormat = "glb" | "gltf" | "obj" | "stl" | "ply";

export interface ExportKind {
  id: ExportFormat;
  label: string;
  ext: string;
  /**
   * What is lost on the way out, in the user's terms, or null when nothing is.
   *
   * This is the whole reason the list is a table rather than five strings. A
   * person who has just spent five minutes choosing a colour and exports to STL
   * gets a grey model back and no explanation, and the natural conclusion is
   * that FACET dropped it. STL genuinely cannot carry a material — the format
   * has no field for one — so the honest thing is to say so *before* the save,
   * not to silently write a file that disappoints later.
   */
  drops: string | null;
}

export const EXPORTS: readonly ExportKind[] = [
  { id: "glb", label: "GLB", ext: "glb", drops: null },
  // One self-contained JSON: three embeds the buffers as data URIs rather than
  // writing a sibling .bin, so the file cannot arrive somewhere without them.
  { id: "gltf", label: "glTF (text)", ext: "gltf", drops: null },
  {
    id: "obj", label: "OBJ", ext: "obj",
    drops: "materials — OBJ keeps them in a separate .mtl that FACET does not write yet",
  },
  {
    id: "stl", label: "STL (binary)", ext: "stl",
    drops: "colour and materials — the STL format has nowhere to put them",
  },
  {
    id: "ply", label: "PLY (binary)", ext: "ply",
    drops: "materials, though per-vertex colours survive",
  },
];

export function exportKind(id: ExportFormat): ExportKind {
  return EXPORTS.find((k) => k.id === id) ?? EXPORTS[0]!;
}

/**
 * The name to save under.
 *
 * `-facet` before the extension, matching the photo editor, and the extension
 * comes from the chosen format rather than the source — exporting an STL as GLB
 * and getting `part-facet.stl` containing glTF is a file that no tool on the
 * machine will open twice.
 */
export function outName(path: string, id: ExportFormat): string {
  const dot = path.lastIndexOf(".");
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const stem = dot > slash ? path.slice(0, dot) : path;
  return `${stem}-facet.${exportKind(id).ext}`;
}

/**
 * Does this object have anything an exporter could write?
 *
 * Worth asking before opening a save dialog: `STLExporter` on a scene with no
 * meshes returns a valid, empty, 84-byte file, and a zero-triangle STL is a
 * file that every other program will open and show nothing — which looks like
 * FACET wrote garbage rather than like there was nothing to write.
 */
export function hasGeometry(root: Object3D): boolean {
  let found = false;
  root.traverse((o) => {
    const g = (o as Partial<Mesh>).geometry as BufferGeometry | undefined;
    if (g?.getAttribute("position")) found = true;
  });
  return found;
}

/**
 * Run something with the object's ancestors out of the picture.
 *
 * STL, OBJ and PLY all write vertices through `mesh.matrixWorld`, which is
 * **absolute** — every transform from the scene root down. That means the
 * stand's up-axis rotation, the one thing that must never reach a file, gets
 * baked in by all three exporters despite living on a separate node. Detaching
 * for the duration is what actually makes the stand/content split hold: with no
 * parent, `updateMatrixWorld` copies the local matrix and world *is* local.
 *
 * `fn` is deliberately synchronous. Nothing on screen is holding a reference to
 * a removed model for even one frame, because no frame can be drawn without the
 * event loop, and this never yields it. The two glTF formats are the async ones
 * and they are also the two that do not need this — `GLTFExporter` writes each
 * node's own position/rotation/scale and never looks up the tree.
 */
function withoutAncestors<T>(root: Object3D, fn: () => T): T {
  const parent = root.parent;
  if (!parent) {
    root.updateMatrixWorld(true);
    return fn();
  }
  parent.remove(root);
  root.updateMatrixWorld(true);
  try {
    return fn();
  } finally {
    parent.add(root);
    root.updateMatrixWorld(true);
  }
}

/**
 * Turn an object into the bytes of a file.
 *
 * Always bytes, never a string, even for the two text formats — because the
 * thing at the other end is `writeFile`, and handing it a string means someone
 * downstream picks an encoding. A model exported with `é` in a material name
 * would round-trip through the wrong code page exactly once before the file
 * stopped loading. `TextEncoder` is UTF-8 and nothing else.
 *
 * The object passed in should be the **model**, never the stand — see the
 * `stand` field in `@ui/scene-view` for what goes wrong otherwise.
 */
export async function encode(root: Object3D, id: ExportFormat): Promise<Uint8Array> {
  switch (id) {
    case "glb":
    case "gltf": {
      const { GLTFExporter } = await import("three/examples/jsm/exporters/GLTFExporter.js");
      const out = await new Promise<ArrayBuffer | object>((resolve, reject) => {
        new GLTFExporter().parse(root, resolve, reject, { binary: id === "glb" });
      });
      return out instanceof ArrayBuffer
        ? new Uint8Array(out)
        : new TextEncoder().encode(JSON.stringify(out));
    }
    case "obj": {
      const { OBJExporter } = await import("three/examples/jsm/exporters/OBJExporter.js");
      const text = withoutAncestors(root, () => new OBJExporter().parse(root));
      return new TextEncoder().encode(text);
    }
    case "stl": {
      const { STLExporter } = await import("three/examples/jsm/exporters/STLExporter.js");
      // Binary rather than ASCII: a 5M-triangle part is ~250 MB binary and
      // roughly a gigabyte as text, and nothing reads the text form better.
      const dv = withoutAncestors(
        root,
        () => new STLExporter().parse(root, { binary: true }) as unknown as DataView,
      );
      // `.slice()` because three hands back a view onto a buffer it may still
      // hold; the copy is what gets written and it has to own its bytes.
      return new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength).slice();
    }
    case "ply": {
      const { PLYExporter } = await import("three/examples/jsm/exporters/PLYExporter.js");
      /* The return value, not the callback. `PLYExporter` does all its work
         synchronously and then hands the same result to `onDone` from a
         `requestAnimationFrame` — so waiting for the callback would put the
         restore of the detached model a frame away, which is a frame in which
         the viewer draws an empty scene. The value is already in hand by then. */
      const out = withoutAncestors(
        root,
        // The callback is not optional in the types even though the result is
        // returned; a no-op satisfies it without waiting for the frame.
        /* `littleEndian` is not the default and has to be asked for. three
           writes `binary_big_endian` otherwise, which is legal PLY and which a
           good half of the tools in the wild read wrong or refuse — the format
           allows both and the world settled on one. Nothing in FACET would have
           noticed, because three's own loader handles both. */
        () => new PLYExporter().parse(root, () => undefined, { binary: true, littleEndian: true }),
      );
      if (out === null) throw new Error("PLY export produced nothing");
      return typeof out === "string" ? new TextEncoder().encode(out) : new Uint8Array(out);
    }
  }
}
