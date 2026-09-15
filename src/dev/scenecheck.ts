/**
 * Checks the 3D viewer (item 13) and the editing and export on top of it
 * (item 6).
 *
 * Five claims, and the reason each one is here rather than left to the eye.
 *
 * **1. The extension is a hint; the bytes are the fact.** One format punishes
 * getting that backwards. A binary STL opens with 80 bytes of free-form header,
 * and a large share of exporters write `solid <name>` into it — which is also
 * exactly how a *text* STL begins. Believe the first five bytes and the ASCII
 * parser finds no triangles and reports an empty model, so the file looks broken
 * rather than the reader looking wrong. The tests below build both kinds by hand
 * so the trap can be sprung without shipping a fixture.
 *
 * **2. The camera has to find the model.** This is the whole first impression
 * and the thing that cannot be checked by opening one file: models in the wild
 * run from 0.01 units across to 40,000, and sit anywhere in space. So the
 * framing is asserted the only way that means anything — build the camera the
 * viewer would build, then check every corner of the model's bounding box is
 * actually inside its frustum, at four wildly different scales and off the
 * origin.
 *
 * **3. A file with no faces is a point cloud.** Scanner and photogrammetry PLYs
 * are frequently vertices only, and drawn as a mesh they produce an object with
 * a bounding box and nothing visible — indistinguishable from a failed load. The
 * subtlety is that "no index buffer" cannot be the test on its own, because an
 * STL never has one either; the STL case is asserted alongside so the fix cannot
 * regress into breaking it.
 *
 * **4. The GPU gets its memory back.** three frees nothing when a JavaScript
 * reference is dropped. A leak here is invisible until a driver starts refusing
 * allocations, so disposal is asserted by listening for the events three fires,
 * including on the textures hanging off a material — which `material.dispose()`
 * does *not* release.
 *
 * **5. An export must carry the file's axes and not the screen's.** The viewer
 * rotates a CAD part upright to show it, and STL, OBJ and PLY all write
 * vertices through `matrixWorld` — so that display rotation is one careless
 * line away from being written into the saved file. The symptom arrives a
 * round-trip later, as a part lying on its side with the original already
 * overwritten, which is why the check is on the bytes and not on the screen.
 *
 * No WebGL context is created anywhere in this file. That is deliberate and it
 * is why any of this is testable: three's scene graph, geometry, bounding
 * volumes and camera maths are all pure, and only the renderer needs a GPU.
 *
 * Dev-only. Loaded by /dev/scenecheck.html, which is not a build input.
 *
 *   http://localhost:8183/dev/scenecheck.html
 */

import "../styles/base.css";
import "../styles/scene.css";
import "../styles/scene-edit.css";

import {
  AgXToneMapping,
  AnimationClip,
  AnimationMixer,
  Box3,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  Frustum,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  NumberKeyframeTrack,
  Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  PointsMaterial,
  Scene,
  ShadowMaterial,
  Texture,
  TorusKnotGeometry,
  Vector3,
  type Camera,
  type WebGLRenderer,
} from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { strToU8, zipSync } from "three/examples/jsm/libs/fflate.module.js";
import { ThreeMFLoader } from "three/examples/jsm/loaders/3MFLoader.js";
import { ColladaLoader } from "three/examples/jsm/loaders/ColladaLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import "../styles/base.css";
import "../styles/scene.css";
import "../styles/scene-edit.css";

import {
  applyLook,
  applyPlacement,
  clampScale,
  cloneEdit,
  encode,
  EXPORTS,
  exportKind,
  hasGeometry,
  isUntouched,
  MAX_SCALE,
  MIN_SCALE,
  NO_EDIT,
  outName,
} from "@core/model3d/edit";
import {
  canView,
  formatLabel,
  hasOwnMaterials,
  sniff,
  SNIFF_BYTES,
  whyNot,
  type Model3DFormat,
} from "@core/model3d/formats";
import {
  advance,
  clock,
  pause,
  play,
  playhead,
  poseTime,
  progress,
  scrub,
  withLoop,
  withSpeed,
} from "@core/model3d/anim";
import { readScenePrefs, writeScenePref, TONE_MAPS, type ScenePrefs } from "@core/model3d/prefs";
import {
  buildDrawable,
  buildEdges,
  buildGrid,
  buildShadowFloor,
  defaultUp,
  dims,
  disposeEdges,
  disposeTree,
  edgeCount,
  frameFor,
  keyLightPosition,
  ORTHO_DISTANCE,
  orthoFrameFor,
  orthoZoomFor,
  pointSize,
  presetDirection,
  screenshotPath,
  screenshotScale,
  survey,
  syncEdges,
  VIEW_PRESETS,
  type EdgeOverlay,
  type OrthoFraming,
  type ViewPreset,
} from "@core/model3d/scene";
import { BUILT_IN, OpensStore, memoryOpens, resolveOpen } from "@core/explorer/opens";
import { kindForExt } from "@core/explorer/types";
import { ALL_SETTINGS, GROUPS, PREF } from "@core/settings/registry";
import { memoryBackend, SettingsStore } from "@core/settings/store";
import { themes } from "@core/theme/theme-engine";
import { SceneView } from "@ui/scene-view";

themes.init();

let pass = 0;
let fail = 0;

const ok = (name: string, cond: boolean, detail = ""): void => {
  if (cond) {
    pass++;
    console.log("ok  ", name);
  } else {
    fail++;
    console.error("FAIL", name, detail);
  }
};

// ── Fixtures, built byte by byte ──────────────────────────────────────────

/**
 * A binary STL, with whatever you like in its 80-byte header.
 *
 * `header` is the parameter that matters: passing `"solid tetrahedron"` produces
 * the exact file that breaks the naive reader.
 */
function binaryStl(triangles: number, header: string): Uint8Array {
  const bytes = new Uint8Array(84 + triangles * 50);
  for (let i = 0; i < Math.min(header.length, 80); i++) bytes[i] = header.charCodeAt(i);
  new DataView(bytes.buffer).setUint32(80, triangles, true);
  return bytes;
}

function ascii(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

function glb(): Uint8Array {
  const bytes = new Uint8Array(64);
  const dv = new DataView(bytes.buffer);
  dv.setUint32(0, 0x46546c67, true); // "glTF"
  dv.setUint32(4, 2, true);
  dv.setUint32(8, 64, true);
  return bytes;
}

/** How the viewer calls it: a head, the true total length, and a name. */
function look(bytes: Uint8Array, ext: string, total = bytes.length): Model3DFormat | null {
  return sniff(bytes.subarray(0, Math.min(bytes.length, SNIFF_BYTES)), total, ext);
}

/** An indexed triangle soup with an optional colour attribute. */
function triangles(count: number, scale = 1, colours = false): BufferGeometry {
  const g = new BufferGeometry();
  const position = new Float32Array(count * 9);
  for (let i = 0; i < count * 9; i++) position[i] = ((i * 37) % 100) / 100 * scale;
  g.setAttribute("position", new BufferAttribute(position, 3));
  const index: number[] = [];
  for (let i = 0; i < count * 3; i++) index.push(i);
  g.setIndex(index);
  if (colours) g.setAttribute("color", new BufferAttribute(new Float32Array(count * 9), 3));
  return g;
}

/** Vertices and nothing else — a scanner PLY. */
function cloud(count: number, scale = 1): BufferGeometry {
  const g = new BufferGeometry();
  const position = new Float32Array(count * 3);
  for (let i = 0; i < count * 3; i++) position[i] = ((i * 17) % 100) / 100 * scale;
  g.setAttribute("position", new BufferAttribute(position, 3));
  return g;
}

/**
 * Is every corner of this object's bounding box actually on screen?
 *
 * The corners rather than the sphere, because the sphere is what the framing was
 * *derived from* — checking it against itself would prove nothing about whether
 * the margin, the aspect correction or the near and far planes are right.
 */
function fullyVisible(object: Object3D, fov: number, aspect: number): boolean {
  const f = frameFor(object, fov, aspect);
  const camera = new PerspectiveCamera(fov, aspect, f.near, f.far);
  camera.position.copy(f.position);
  camera.lookAt(f.target);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();

  const frustum = new Frustum().setFromProjectionMatrix(
    new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
  );
  const box = new Box3().setFromObject(object);
  const c: Vector3[] = [];
  for (const x of [box.min.x, box.max.x]) {
    for (const y of [box.min.y, box.max.y]) {
      for (const z of [box.min.z, box.max.z]) c.push(new Vector3(x, y, z));
    }
  }
  return c.every((p) => frustum.containsPoint(p));
}

/**
 * How much of the vertical field the model's bounding sphere subtends, as a
 * fraction — 1.0 would be exactly edge to edge.
 *
 * Scale-invariance of this number is the real claim `frameFor` makes, and it is
 * a stronger one than "inside the frustum": a model can be inside the frustum
 * and be one pixel across.
 */
function fillFraction(object: Object3D, fov: number, aspect: number): number {
  const f = frameFor(object, fov, aspect);
  const dist = f.position.distanceTo(f.center);
  const half = Math.asin(Math.min(1, f.radius / dist));
  return (2 * half) / ((fov * Math.PI) / 180);
}

function main(): void {
  // ── 1. The bytes decide ─────────────────────────────────────────────────

  ok("a binary STL that says 'solid' in its header is still binary",
    look(binaryStl(12, "solid tetrahedron exported by something"), "stl") === "stl-binary");
  ok("…and one with an ordinary header is too",
    look(binaryStl(400, "Created with a slicer"), "stl") === "stl-binary");
  ok("a text STL is text",
    look(ascii("solid part\n  facet normal 0 0 1\n    outer loop\n"), "stl") === "stl-ascii");
  ok("a truncated binary STL is not claimed to be binary",
    look(binaryStl(400, "x"), "stl", 84 + 399 * 50) === "stl-ascii",
    "a size that does not match the claim must fall through, not draw garbage");
  ok("an absurd triangle count cannot be multiplied into a false match",
    look(binaryStlClaiming(0xffff_ffff), "stl") === "stl-ascii");
  ok("size 84 exactly — a binary STL with no triangles at all",
    look(binaryStl(0, "empty"), "stl") === "stl-binary");

  ok("GLB is recognised by magic even when it is named .gltf",
    look(glb(), "gltf") === "glb");
  ok("GLB is recognised by magic",
    look(glb(), "glb") === "glb");
  ok("a JSON glTF named .glb is read as JSON, because the magic is absent",
    look(ascii('{"asset":{"version":"2.0"}}'), "glb") === "gltf");

  ok("PLY text", look(ascii("ply\nformat ascii 1.0\nelement vertex 3\n"), "ply") === "ply-ascii");
  ok("PLY binary, little-endian",
    look(ascii("ply\nformat binary_little_endian 1.0\n"), "ply") === "ply-binary");
  ok("PLY binary, big-endian",
    look(ascii("ply\nformat binary_big_endian 1.0\n"), "ply") === "ply-binary");
  ok("a .ply whose header is not 'ply' is refused rather than guessed at",
    look(ascii("<!doctype html><title>404"), "ply") === null);

  ok("OBJ", look(ascii("v 0 0 0\nv 1 0 0\nf 1 2 3\n"), "obj") === "obj");
  ok("the extension is matched case-insensitively", canView(".STL") && canView("Glb"));

  // ── 1b. The formats FACET does not draw say so ──────────────────────────

  ok("a .blend is refused", !canView("blend"));
  ok("…with a sentence that names Blender", (whyNot("blend") ?? "").includes("Blender"));
  ok("a .fbx is refused with its own reason", (whyNot("fbx") ?? "").includes("Autodesk"));
  ok("an extension nobody thought about still gets a sentence",
    (whyNot("xyzzy") ?? "").includes("xyzzy"));
  ok("nothing to complain about for the five that work",
    ["glb", "gltf", "obj", "stl", "ply"].every((e) => whyNot(e) === null));

  ok("only glTF brings its own materials",
    hasOwnMaterials("glb") && hasOwnMaterials("gltf") &&
    !hasOwnMaterials("stl-binary") && !hasOwnMaterials("obj") && !hasOwnMaterials("ply-ascii"));
  ok("every format has a label", (["glb", "gltf", "obj", "stl-binary", "stl-ascii", "ply-binary", "ply-ascii"] as Model3DFormat[])
    .every((f) => formatLabel(f).length > 2));

  ok("STL and PLY default to Z up; glTF and OBJ do not",
    defaultUp("stl-binary") === "z" && defaultUp("ply-ascii") === "z" &&
    defaultUp("glb") === "y" && defaultUp("obj") === "y");

  // ── 2. The camera finds the model ───────────────────────────────────────

  const FOV = 50;
  const SCALES = [["a 2 mm screw", 0.002], ["a mug", 0.12], ["a person", 1.8], ["a building", 40_000]] as const;
  const fills: number[] = [];
  for (const [label, scale] of SCALES) {
    const mesh = new Mesh(new BoxGeometry(scale, scale * 0.6, scale * 1.3));
    ok(`${label} (${scale} units) is entirely on screen`, fullyVisible(mesh, FOV, 16 / 9));
    fills.push(fillFraction(mesh, FOV, 16 / 9));
  }

  // Being inside the frustum is necessary and nowhere near sufficient — a 2 mm
  // screw viewed from five units away is "on screen" and is also a single
  // pixel. The property that actually matters is that the model subtends the
  // *same* share of the view at every scale, which is what makes this framing
  // rather than luck. A fixed camera passes the visibility test above for three
  // of these four and fails this one for all of them.
  ok("the model fills the same share of the view at every scale",
    Math.max(...fills) - Math.min(...fills) < 1e-6,
    fills.map((f) => f.toFixed(4)).join(" / "));
  ok("…and that share is most of the view, not a speck in the middle of it",
    fills[0]! > 0.5 && fills[0]! < 0.95, String(fills[0]));

  const far = new Mesh(new BoxGeometry(3, 3, 3));
  far.position.set(5000, -800, 12_000);
  far.updateMatrixWorld(true);
  ok("a small model a long way from the origin is on screen",
    fullyVisible(far, FOV, 16 / 9),
    "CAD and GIS exports routinely sit thousands of units out");

  const tall = new Mesh(new BoxGeometry(1, 1, 1));
  ok("a portrait window does not crop the sides", fullyVisible(tall, FOV, 0.45));
  ok("a very wide window does not crop either", fullyVisible(tall, FOV, 4));

  const small = frameFor(new Mesh(new BoxGeometry(0.01, 0.01, 0.01)), FOV, 1);
  const big = frameFor(new Mesh(new BoxGeometry(10_000, 10_000, 10_000)), FOV, 1);
  ok("the near plane scales with the model rather than being a constant",
    small.near < big.near / 1000,
    `${small.near} vs ${big.near}`);
  ok("the far plane clears the far side of the model",
    big.far > big.position.distanceTo(big.center) + big.radius);
  ok("near is always in front of far, and both are positive",
    small.near > 0 && small.near < small.far && big.near > 0 && big.near < big.far);

  const degenerate = frameFor(new Points(cloud(1)), FOV, 1);
  ok("a model with no extent at all produces finite numbers, not NaN",
    [degenerate.near, degenerate.far, degenerate.position.x, degenerate.position.y, degenerate.position.z]
      .every((v) => Number.isFinite(v)));

  const off = frameFor(far, FOV, 16 / 9);
  ok("the orbit target is the model, not the origin",
    off.target.distanceTo(new Vector3(5000, -800, 12_000)) < 1,
    `${off.target.toArray().join(",")}`);

  const empty = frameFor(new Group(), FOV, 1);
  ok("an empty scene does not throw and does not produce NaN",
    Number.isFinite(empty.near) && Number.isFinite(empty.far));

  // ── 3. Faces, or the absence of them ────────────────────────────────────

  ok("a PLY with no faces becomes a point cloud",
    buildDrawable(cloud(500), true) instanceof Points);
  ok("a PLY with faces becomes a mesh",
    buildDrawable(triangles(40), true) instanceof Mesh);
  ok("an STL with no index buffer is STILL a mesh",
    buildDrawable(stlLike(40), false) instanceof Mesh,
    "an STL never has an index — 'no index means points' would break every STL");
  ok("a mesh with no normals gets them computed, or it lights as pure black",
    (buildDrawable(triangles(10), false) as Mesh).geometry.getAttribute("normal") !== undefined);
  ok("normals already in the file are left alone", (() => {
    const g = triangles(10);
    const normal = new Float32Array(g.getAttribute("position").count * 3).fill(0.5);
    g.setAttribute("normal", new BufferAttribute(normal, 3));
    const before = g.getAttribute("normal").array[0];
    buildDrawable(g, false);
    return g.getAttribute("normal").array[0] === before;
  })());
  /* The STL specification lets a writer leave the facet normal at (0,0,0) and
     expects the reader to take it from the winding order instead, and a great
     many exporters do exactly that. Because STLLoader always *supplies* the
     attribute, "is it missing?" answers no and the model lights as a flat
     silhouette — which reads as a broken file rather than a viewer that trusted
     a field it should have checked. */
  ok("an STL whose normals are all zeroes — which the format allows — gets them recomputed",
    (() => {
      const g = stlLike(40);
      (g.getAttribute("normal").array as Float32Array).fill(0);
      buildDrawable(g, false);
      const n = g.getAttribute("normal");
      // The strongest normal, not the first: one degenerate triangle in the
      // fixture would otherwise fail an assertion about the code around it.
      let longest = 0;
      for (let i = 0; i < n.count; i++) {
        longest = Math.max(longest, Math.hypot(n.getX(i), n.getY(i), n.getZ(i)));
      }
      return longest > 0.9;
    })(),
    "present-but-degenerate has to count as absent");
  ok("…and one stray zero normal does not flatten a genuinely smooth mesh",
    (() => {
      const g = triangles(30);
      const normal = new Float32Array(g.getAttribute("position").count * 3).fill(0);
      // Smooth, except for a single bad vertex — a PLY, not an exporter-wide
      // choice. Recomputing here would replace rounded shading with facets.
      for (let i = 3; i < normal.length; i += 3) normal[i + 1] = 1;
      g.setAttribute("normal", new BufferAttribute(normal, 3));
      buildDrawable(g, false);
      return g.getAttribute("normal").getY(1) === 1 && g.getAttribute("normal").getY(0) === 0;
    })());
  ok("vertex colours in the file are switched on, or the model renders white",
    ((buildDrawable(triangles(10, 1, true), false) as Mesh).material as MeshStandardMaterial).vertexColors);
  ok("point size scales with the cloud",
    pointSize(cloud(200, 4000)) > pointSize(cloud(200, 0.01)) * 1000);
  ok("point size is never zero, however small the cloud", pointSize(cloud(4, 1e-9)) > 0);

  // ── 3b. What the status line will say ───────────────────────────────────

  const box = new Mesh(new BoxGeometry(2, 4, 6));
  const s1 = survey(box);
  ok("a box is 12 triangles", s1.triangles === 12, String(s1.triangles));
  ok("…of 24 vertices", s1.vertices === 24, String(s1.vertices));
  ok("…in one mesh", s1.meshes === 1);
  ok("…and its size is reported", dims(s1.size) === "2.00 × 4.00 × 6.00", dims(s1.size));

  const two = new Group();
  two.add(new Mesh(new BoxGeometry(1, 1, 1)), new Mesh(new BoxGeometry(1, 1, 1)));
  ok("meshes and triangles add up across a scene",
    survey(two).meshes === 2 && survey(two).triangles === 24);

  const scan = survey(buildDrawable(cloud(999), true));
  ok("a point cloud reports points and no meshes",
    scan.points && scan.meshes === 0 && scan.vertices === 999);
  ok("vertex colours are noticed", survey(buildDrawable(triangles(4, 1, true), false)).vertexColors);

  // ── 3c. The grid is sized to the model ──────────────────────────────────

  const gSmall = buildGrid(new Vector3(), 0.01);
  const gBig = buildGrid(new Vector3(), 5000);
  const span = (g: { geometry: BufferGeometry }): number => {
    g.geometry.computeBoundingBox();
    const b = g.geometry.boundingBox;
    return b ? b.max.x - b.min.x : 0;
  };
  ok("the grid under a screw is not the size of the grid under a building",
    span(gBig) > span(gSmall) * 100_000, `${span(gSmall)} vs ${span(gBig)}`);
  ok("the grid sits under the model, not through it",
    Math.abs(buildGrid(new Vector3(0, 10, 0), 4).position.y - 6) < 1e-6);

  // ── 4. The GPU gets its memory back ─────────────────────────────────────

  const freed = new Set<string>();
  const geometry = new BoxGeometry(1, 1, 1);
  const material = new MeshStandardMaterial();
  const texture = new Texture();
  material.map = texture;
  geometry.addEventListener("dispose", () => freed.add("geometry"));
  material.addEventListener("dispose", () => freed.add("material"));
  texture.addEventListener("dispose", () => freed.add("texture"));

  const tree = new Group();
  tree.add(new Mesh(geometry, material));
  disposeTree(tree);
  ok("the geometry is freed", freed.has("geometry"));
  ok("the material is freed", freed.has("material"));
  ok("the texture is freed too — disposing a material does NOT release its maps",
    freed.has("texture"));

  // ── 5. The shell can reach it (item 40's layers) ────────────────────────

  ok("3D models now open in the viewer rather than being handed to Windows",
    BUILT_IN.model3d === "scene");
  ok("the view is asked what it handles, not the kind",
    SceneView.handles("glb") && SceneView.handles("STL") && !SceneView.handles("blend"));

  const store = new OpensStore(memoryOpens());
  ok("a .glb resolves to the 3D viewer",
    resolveOpen({ kind: "model3d", ext: "glb" }, store, ["scene", "meta", "system"]) === "scene");
  ok("a .blend, which the viewer cannot take, falls through to Windows",
    resolveOpen({ kind: "model3d", ext: "blend" }, store, ["meta", "system"]) === "system",
    "the preference is real; availability is what declines it");
  store.setExt("stl", "meta");
  ok("a per-extension pin still beats the new default",
    resolveOpen({ kind: "model3d", ext: "stl" }, store, ["scene", "meta", "system"]) === "meta");
  ok("…and does not disturb the kind beside it",
    resolveOpen({ kind: "model3d", ext: "ply" }, store, ["scene", "meta", "system"]) === "scene");

  viewer();
  void editing().then(live);
}

/**
 * The viewer's parity work (items A2–A20), everything that needs no GPU.
 *
 * Kept apart from `main` because each of these is a claim about arithmetic the
 * live view only *uses*: that "front" really is in front, that an orthographic
 * box built for a screw and one built for a building both hold their model, that
 * a cube has twelve creases and not eighteen. Checked here, a regression names
 * the sum that broke; checked only through the canvas, it is a picture that
 * looks slightly wrong.
 */
function viewer(): void {
  // ── A2. View presets ─────────────────────────────────────────────────────

  const FOV = 50;
  const offCentre = new Mesh(new BoxGeometry(3, 2, 1));
  offCentre.position.set(120, -40, 75);
  offCentre.updateMatrixWorld(true);
  const centre = new Box3().setFromObject(offCentre).getCenter(new Vector3());
  const distances: number[] = [];
  for (const view of VIEW_PRESETS) {
    const dir = presetDirection(view);
    const f = frameFor(offCentre, FOV, 16 / 9, dir);
    const seen = f.position.clone().sub(f.target).normalize();
    distances.push(f.position.distanceTo(f.target));
    ok(`the ${view} preset puts the camera on its own side of the model`,
      seen.distanceTo(dir) < 1e-6 && near(dir.length(), 1, 1e-9),
      `${seen.toArray().map((n) => n.toFixed(3))} vs ${dir.toArray().map((n) => n.toFixed(3))}`);
    ok(`…and the ${view} view still has every corner on screen`,
      presetVisible(offCentre, FOV, 16 / 9, view));
  }
  ok("every preset stands the same distance back — a view is a direction, not a zoom",
    distances.every((d) => near(d, distances[0]!, 1e-6)), distances.join(", "));
  const at = (view: ViewPreset): Vector3 => frameFor(offCentre, FOV, 1, presetDirection(view)).position;
  ok("front is +Z of the model, back is −Z",
    at("front").z > centre.z && near(at("front").x, centre.x) && at("back").z < centre.z);
  ok("right is +X, left is −X", at("right").x > centre.x && at("left").x < centre.x);
  ok("top is above and bottom below", at("top").y > centre.y && at("bottom").y < centre.y);
  ok("isometric is up, right and in front at once",
    at("iso").x > centre.x && at("iso").y > centre.y && at("iso").z > centre.z);
  /* The pole nudge. Looking straight down Y, `lookAt` has no right vector and
     three either produces NaN or picks a roll by accident. With the nudge the
     plan view is laid out the way a drawing is: the model's front edge (+Z) at
     the bottom of the screen. */
  const topCam = presetCamera(offCentre, FOV, 1, "top");
  ok("the top view has a well-defined roll, not a NaN matrix",
    topCam.matrixWorld.elements.every(Number.isFinite));
  ok("…with the model's front at the bottom of the screen, as a plan is drawn",
    centre.clone().add(new Vector3(0, 0, 1)).project(topCam).y < centre.clone().project(topCam).y);
  const bottomCam = presetCamera(offCentre, FOV, 1, "bottom");
  ok("the bottom view is finite too", bottomCam.matrixWorld.elements.every(Number.isFinite));

  // ── A3. Orthographic framing at the two extremes ─────────────────────────

  const unit = orthoFrameFor(new Mesh(new BoxGeometry(1, 1, 1)), 16 / 9);
  for (const radius of [0.01, 40_000]) {
    const side = (2 * radius) / Math.sqrt(3); // a cube whose bounding sphere is `radius`
    const cube = new Mesh(new BoxGeometry(side, side, side));
    const places: Array<[string, Vector3]> = [
      ["at the origin", new Vector3()],
      ["far off it", new Vector3(radius * 30, -radius * 7, radius * 12)],
    ];
    for (const [where, offset] of places) {
      cube.position.copy(offset);
      cube.updateMatrixWorld(true);
      for (const aspect of [16 / 9, 0.45]) {
        for (const view of ["fit", "top", "right"] as const) {
          const o = orthoFrameFor(cube, aspect, presetDirection(view));
          ok(`orthographic framing holds a radius-${radius} model ${where}, ${view}, aspect ${aspect.toFixed(2)}`,
            orthoVisible(cube, o), `half ${o.halfWidth} × ${o.halfHeight}, near ${o.near}, far ${o.far}`);
        }
      }
    }
    const o = orthoFrameFor(cube, 16 / 9);
    const dist = o.position.distanceTo(o.target);
    ok(`the radius the ortho framing measured is the model's (${radius})`, near(o.radius, radius, radius * 1e-4));
    ok(`…its near plane is positive and in front of the model (${radius})`,
      o.near > 0 && o.near < dist - o.radius, `near ${o.near}, nearest surface ${dist - o.radius}`);
    ok(`…and its far plane is behind it (${radius})`, o.far > dist + o.radius);
    ok(`…and the box is the same share of the model at every scale (${radius})`,
      near(o.halfHeight / o.radius, unit.halfHeight / unit.radius, 1e-6));
  }
  ok("a portrait window widens the ortho box, as it widens the perspective distance",
    orthoFrameFor(offCentre, 0.45).halfHeight > orthoFrameFor(offCentre, 16 / 9).halfHeight);
  ok("the ortho zoom that matches a perspective view shows the same slice through the target",
    near(3 / orthoZoomFor(12, 50, 3), 12 * Math.tan((25 * Math.PI) / 180), 1e-9));
  ok("…and a camera sitting on its target gets zoom 1 rather than infinity",
    orthoZoomFor(0, 50, 3) === 1 && orthoZoomFor(Number.NaN, 50, 3) === 1);
  const standOff = orthoFrameFor(offCentre, 1);
  ok("the ortho camera stands a fixed number of radii back",
    near(standOff.position.distanceTo(centre) / standOff.radius, ORTHO_DISTANCE, 1e-6));

  // ── A5. Edges ────────────────────────────────────────────────────────────

  const cube = new Mesh(new BoxGeometry(1, 1, 1));
  const cubeEdges = buildEdges(cube, 30, 0);
  ok("a unit cube has 12 edges, not the 18 its triangles have", edgeCount(cubeEdges) === 12, String(edgeCount(cubeEdges)));
  ok("…and the lines are not hung under the mesh, where an export would write them",
    cube.children.length === 0 && cubeEdges.group.children.length === 1);
  const plane = buildEdges(new Mesh(new PlaneGeometry(1, 1)), 30, 0);
  ok("a flat square has only its four outside edges — the diagonal is not a crease", edgeCount(plane) === 4, String(edgeCount(plane)));
  const shallow = buildEdges(new Mesh(new BoxGeometry(1, 1, 1)), 95, 0);
  ok("an angle above 90° drops a cube's corners, so the slider does something", edgeCount(shallow) === 0, String(edgeCount(shallow)));
  cube.position.set(5, 6, 7);
  cube.updateMatrixWorld(true);
  syncEdges(cubeEdges);
  const line = cubeEdges.pairs[0]![1];
  ok("the lines follow the mesh when it moves, without a rebuild",
    new Vector3().setFromMatrixPosition(line.matrixWorld).distanceTo(new Vector3(5, 6, 7)) < 1e-9);
  let edgeFreed = 0;
  line.geometry.addEventListener("dispose", () => edgeFreed++);
  (line.material as MeshStandardMaterial).addEventListener("dispose", () => edgeFreed++);
  disposeEdges(cubeEdges);
  ok("disposing the edges frees their geometry and the shared material", edgeFreed === 2, String(edgeFreed));
  ok("…and empties the overlay", cubeEdges.pairs.length === 0 && cubeEdges.group.children.length === 0);
  disposeEdges(plane);
  disposeEdges(shallow);

  // ── A10. The playhead ────────────────────────────────────────────────────

  const two = play(playhead(2));
  const fresh = playhead(2);
  ok("a fresh playhead starts at zero, looping, paused",
    fresh.time === 0 && fresh.loop && !fresh.playing && fresh.speed === 1);
  ok("advancing moves time on by the delta", near(advance(two, 0.5).time, 0.5));
  ok("a loop wraps with a true modulo — a late frame several clips long lands inside the clip",
    near(advance(two, 5.3).time, 1.3, 1e-9), String(advance(two, 5.3).time));
  const ended = advance(withLoop(two, false), 3);
  ok("a one-shot stops at the end and says it has stopped", ended.time === 2 && !ended.playing);
  const again = play(ended);
  ok("…and play starts it from the top rather than doing nothing", again.playing && again.time === 0);
  ok("a paused playhead does not move", advance(pause(advance(two, 0.4)), 1).time === advance(two, 0.4).time);
  ok("a clip with no duration cannot be played",
    !play(playhead(0)).playing && advance(play(playhead(0)), 1).time === 0);
  ok("a NaN duration becomes zero, not NaN everywhere downstream", playhead(Number.NaN).duration === 0);
  ok("speed snaps to the nearest offered speed", withSpeed(two, 1.9).speed === 2 && withSpeed(two, 0.3).speed === 0.25);
  ok("…and is applied to the delta", near(advance(withSpeed(two, 2), 0.25).time, 0.5));
  ok("scrubbing a quarter of the way is a quarter of the duration", near(scrub(two, 0.25).time, 0.5));
  ok("scrubbing past the end means the end, not frame one", scrub(two, 1.7).time === 2);
  ok("scrubbing NaN goes to the start", scrub(two, Number.NaN).time === 0);
  ok("scrubbing does not stop a playing clip", scrub(two, 0.5).playing);
  ok("progress is the fraction through", near(progress(scrub(two, 0.4)), 0.4));
  ok("the mixer is never handed exactly the duration, which it would show as frame one",
    poseTime(scrub(two, 1)) < 2 && poseTime(scrub(two, 1)) > 1.999);
  ok("the clock reads m:ss.t", clock(61.25) === "1:01.2" && clock(0) === "0:00.0" && clock(2) === "0:02.0",
    `${clock(61.25)} ${clock(0)} ${clock(2)}`);
  ok("…and NaN or a negative reads as zero", clock(Number.NaN) === "0:00.0" && clock(-3) === "0:00.0");

  /* And that the numbers above pose a real mixer the way the view uses them —
     `action.time` then `update(0)` — because a playhead that is right on paper
     and applied a frame late is still a model a frame behind the scrub bar. */
  const mover = new Object3D();
  const mixer = new AnimationMixer(mover);
  const clip = new AnimationClip("slide", 2, [new NumberKeyframeTrack(".position[x]", [0, 2], [0, 10])]);
  const action = mixer.clipAction(clip);
  action.play();
  action.time = poseTime(scrub(two, 0.5));
  mixer.update(0);
  ok("scrubbing half way poses a real mixer half way", near(mover.position.x, 5, 1e-6), String(mover.position.x));
  action.time = poseTime(scrub(two, 1));
  mixer.update(0);
  ok("…and scrubbing to the end shows the last pose, not the first", mover.position.x > 9.99, String(mover.position.x));
  mixer.stopAllAction();
  mixer.uncacheRoot(mover);

  // ── A14. What the info panel counts ──────────────────────────────────────

  const shared = new MeshStandardMaterial({ map: new Texture() });
  const other = new MeshStandardMaterial({ map: shared.map, normalMap: new Texture() });
  const tree = new Group();
  tree.add(new Mesh(new BoxGeometry(), shared), new Mesh(new BoxGeometry(), shared));
  tree.add(new Mesh(new BoxGeometry(), [shared, other]));
  tree.animations = [clip, new AnimationClip("spin", 1, [])];
  const counts = survey(tree);
  ok("meshes are counted per mesh", counts.meshes === 3, String(counts.meshes));
  ok("a material shared by three meshes is one material", counts.materials === 2, String(counts.materials));
  ok("a texture shared by two materials is one texture", counts.textures === 2, String(counts.textures));
  ok("animations are counted", counts.animations === 2, String(counts.animations));
  ok("triangles still add up across a material array", counts.triangles === 36, String(counts.triangles));

  // ── A20. 3MF and COLLADA ─────────────────────────────────────────────────

  const zipHead = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0]);
  ok("a .3mf is recognised by its zip signature", look(zipHead, "3mf") === "3mf");
  ok("…and a web page saved as .3mf is not", look(ascii("<!doctype html><title>404"), "3mf") === null);
  const dae = "\ufeff<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<!-- exported -->\n" +
    "<COLLADA xmlns=\"http://www.collada.org/2005/11/COLLADASchema\" version=\"1.4.1\">";
  ok("a .dae with a BOM, a prolog and a comment is COLLADA", look(new TextEncoder().encode(dae), "dae") === "dae");
  ok("…lower case too", look(ascii("<collada version=\"1.5\">"), "dae") === "dae");
  ok("…but not an element that merely starts with the word", look(ascii("<colladafoo>"), "dae") === null);
  ok("…and not a web page saved as .dae", look(ascii("<!doctype html><title>404"), "dae") === null);
  ok("both are viewable, with no complaint",
    canView("3mf") && canView("DAE") && whyNot("3mf") === null && whyNot("dae") === null);
  ok("both have labels", formatLabel("3mf") === "3MF" && formatLabel("dae") === "COLLADA");
  ok("both bring their own materials", hasOwnMaterials("3mf") && hasOwnMaterials("dae"));
  ok("3MF is Z up, as a print bed is; COLLADA declares its own and reads as Y",
    defaultUp("3mf") === "z" && defaultUp("dae") === "y");
  ok("the explorer calls both of them 3D models", kindForExt("3mf") === "model3d" && kindForExt("dae") === "model3d");
  ok("…and so the viewer is asked to handle them",
    SceneView.handles("3mf") && SceneView.handles("dae"));

  const threeMf = new ThreeMFLoader().parse(bufferOf(threeMfFile()));
  ok("a hand-built 3MF parses to its four triangles", survey(threeMf).triangles === 4, String(survey(threeMf).triangles));
  disposeTree(threeMf);
  const collada = new ColladaLoader().parse(COLLADA_TETRA, "");
  const colladaTris = collada ? survey(collada.scene).triangles : -1;
  ok("a hand-built COLLADA document parses to its four triangles", colladaTris === 4, String(colladaTris));
  if (collada) disposeTree(collada.scene);

  // ── A12. Screenshot names and sizes ──────────────────────────────────────

  ok("a screenshot is named after the model",
    screenshotPath("C:/parts/bracket.stl", 3) === "C:/parts/bracket-screenshot-3.png");
  ok("…a dot in a folder is not an extension", screenshotPath("C:/v1.2/part", 1) === "C:/v1.2/part-screenshot-1.png");
  ok("…backslashes count as folders too", screenshotPath("C:\\v1.2\\part", 1) === "C:\\v1.2\\part-screenshot-1.png");
  ok("…and a dotfile keeps its whole name", screenshotPath("/x/.hidden", 2) === "/x/.hidden-screenshot-2.png");
  ok("4× of a 2560-pixel window is scaled into what the GPU can hold",
    near(screenshotScale(4, 2560, 1440, 8192), 3.2, 1e-9));
  ok("…and a request that fits is left alone", screenshotScale(2, 800, 600, 8192) === 2);
  ok("…and nothing ever asks for a zero-sized canvas", screenshotScale(4, 1e9, 1, 8192) === 0.1);

  // ── A8, A9. The key light and the shadow floor ───────────────────────────

  const c = new Vector3(1, 2, 3);
  const kl = (az: number, el: number): Vector3 => keyLightPosition(c, 5, az, el).sub(c);
  ok("key light at 0° stands in front of the model", kl(0, 0).distanceTo(new Vector3(0, 0, 20)) < 1e-9);
  ok("…at 90° to its right", kl(90, 0).distanceTo(new Vector3(20, 0, 0)) < 1e-9);
  ok("…at 90° height straight above", kl(37, 90).distanceTo(new Vector3(0, 20, 0)) < 1e-9);
  ok("…and always four radii away",
    [[0, 0], [123, 45], [300, 80]].every(([a, e]) => near(kl(a!, e!).length(), 20, 1e-9)));
  const floor = buildShadowFloor(c, 5, -7);
  ok("the shadow floor only catches shadow",
    floor.material instanceof ShadowMaterial && floor.receiveShadow && !floor.castShadow);
  ok("…and lies flat at the model's lowest point, facing up",
    floor.position.y === -7 &&
    new Vector3(0, 0, 1).applyQuaternion(floor.quaternion).distanceTo(new Vector3(0, 1, 0)) < 1e-9);
  disposeTree(floor);

  // ── A19. Preferences survive a restart ───────────────────────────────────

  const backend = memoryBackend();
  const first = new SettingsStore(backend);
  first.register(...ALL_SETTINGS);
  const defaults = readScenePrefs(first);
  ok("the defaults are what a first run should see",
    defaults.toneMap === "neutral" && defaults.exposure === 1 && defaults.background === "theme" &&
    defaults.environment && defaults.turntableSpeed === 4 && !defaults.panelOpen, JSON.stringify(defaults));
  const wanted: ScenePrefs = {
    toneMap: "agx", exposure: 1.35, background: "gradient", environment: false, turntableSpeed: 12, panelOpen: true,
  };
  for (const key of Object.keys(wanted) as Array<keyof ScenePrefs>) writeScenePref(first, key, wanted[key]);
  const second = new SettingsStore(backend);
  second.register(...ALL_SETTINGS);
  const back = readScenePrefs(second);
  ok("every viewer preference written is read back by the next session",
    JSON.stringify(back) === JSON.stringify(wanted), JSON.stringify(back));
  writeScenePref(second, "exposure", 99);
  ok("an exposure out of range is clamped by the store",
    readScenePrefs(second).exposure === 3, String(readScenePrefs(second).exposure));
  second.set(PREF.sceneToneMap, "filmic-from-the-future");
  ok("a tone map this build does not know comes back as one it does",
    TONE_MAPS.includes(readScenePrefs(second).toneMap), readScenePrefs(second).toneMap);
  ok("an empty store still reads sensible defaults",
    JSON.stringify(readScenePrefs(new SettingsStore(memoryBackend()))) === JSON.stringify(defaults));
  ok("the settings screen has a 3D viewer group", (GROUPS as readonly string[]).includes("3D viewer"));
  const ids = [PREF.sceneToneMap, PREF.sceneExposure, PREF.sceneBackground, PREF.sceneEnvironment,
    PREF.sceneTurntableSpeed, PREF.scenePanelOpen];
  ok("…holding all six viewer preferences",
    ids.every((id) => ALL_SETTINGS.some((s) => s.id === id && s.group === "3D viewer")));
}

/** A camera placed exactly as the view places it for `view`. */
function presetCamera(object: Object3D, fov: number, aspect: number, view: ViewPreset): PerspectiveCamera {
  const f = frameFor(object, fov, aspect, presetDirection(view));
  const camera = new PerspectiveCamera(fov, aspect, f.near, f.far);
  camera.position.copy(f.position);
  camera.lookAt(f.target);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  return camera;
}

function presetVisible(object: Object3D, fov: number, aspect: number, view: ViewPreset): boolean {
  return cornersInside(object, presetCamera(object, fov, aspect, view));
}

function orthoVisible(object: Object3D, o: OrthoFraming): boolean {
  const camera = new OrthographicCamera(-o.halfWidth, o.halfWidth, o.halfHeight, -o.halfHeight, o.near, o.far);
  camera.position.copy(o.position);
  camera.lookAt(o.target);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  return cornersInside(object, camera);
}

function cornersInside(object: Object3D, camera: Camera): boolean {
  const frustum = new Frustum().setFromProjectionMatrix(
    new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
  );
  const box = new Box3().setFromObject(object);
  for (const x of [box.min.x, box.max.x]) {
    for (const y of [box.min.y, box.max.y]) {
      for (const z of [box.min.z, box.max.z]) {
        if (!frustum.containsPoint(new Vector3(x, y, z))) return false;
      }
    }
  }
  return true;
}

/**
 * The smallest 3MF three will read: a zip holding the relationship that names
 * the model part, and the part — a tetrahedron, four vertices, four triangles.
 */
function threeMfFile(): Uint8Array {
  const rels = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>" +
    "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">" +
    "<Relationship Target=\"/3D/3dmodel.model\" Id=\"rel0\" " +
    "Type=\"http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel\"/></Relationships>";
  const model = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>" +
    "<model unit=\"millimeter\" xml:lang=\"en-US\" xmlns=\"http://schemas.microsoft.com/3dmanufacturing/core/2015/02\">" +
    "<resources><object id=\"1\" type=\"model\"><mesh><vertices>" +
    "<vertex x=\"0\" y=\"0\" z=\"0\"/><vertex x=\"10\" y=\"0\" z=\"0\"/>" +
    "<vertex x=\"5\" y=\"8.6\" z=\"0\"/><vertex x=\"5\" y=\"2.9\" z=\"8\"/>" +
    "</vertices><triangles>" +
    "<triangle v1=\"0\" v2=\"2\" v3=\"1\"/><triangle v1=\"0\" v2=\"1\" v3=\"3\"/>" +
    "<triangle v1=\"1\" v2=\"2\" v3=\"3\"/><triangle v1=\"2\" v2=\"0\" v3=\"3\"/>" +
    "</triangles></mesh></object></resources><build><item objectid=\"1\"/></build></model>";
  const types = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>" +
    "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">" +
    "<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>" +
    "<Default Extension=\"model\" ContentType=\"application/vnd.ms-package.3dmanufacturing-3dmodel+xml\"/></Types>";
  return zipSync({
    "[Content_Types].xml": strToU8(types),
    "_rels/.rels": strToU8(rels),
    "3D/3dmodel.model": strToU8(model),
  });
}

/** The same tetrahedron as COLLADA 1.4.1, with no material, as a scan would export it. */
const COLLADA_TETRA = `<?xml version="1.0" encoding="utf-8"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
  <asset><unit name="meter" meter="1"/><up_axis>Y_UP</up_axis></asset>
  <library_geometries>
    <geometry id="tetra" name="tetra"><mesh>
      <source id="tetra-pos">
        <float_array id="tetra-pos-array" count="12">0 0 0 10 0 0 5 8.6 0 5 2.9 8</float_array>
        <technique_common><accessor source="#tetra-pos-array" count="4" stride="3">
          <param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/>
        </accessor></technique_common>
      </source>
      <vertices id="tetra-vtx"><input semantic="POSITION" source="#tetra-pos"/></vertices>
      <triangles count="4"><input semantic="VERTEX" source="#tetra-vtx" offset="0"/><p>0 2 1 0 1 3 1 2 3 2 0 3</p></triangles>
    </mesh></geometry>
  </library_geometries>
  <library_visual_scenes>
    <visual_scene id="scene"><node id="tetra-node" name="tetra"><instance_geometry url="#tetra"/></node></visual_scene>
  </library_visual_scenes>
  <scene><instance_visual_scene url="#scene"/></scene>
</COLLADA>`;

/**
 * Editing and export (item 6).
 *
 * Async only because the exporters are imported on demand; none of it needs a
 * GPU, which is the whole reason the export path lives in `@core/model3d/edit`
 * and not in the view. The claim worth the most here is the one about
 * ancestors: STL, OBJ and PLY all write vertices through `matrixWorld`, so the
 * stand that holds the up-axis correction is *exactly* the kind of node that
 * silently ends up baked into a saved file — and the symptom is a part that
 * arrives on its side one round-trip later, upside down two round-trips later,
 * with the original already overwritten.
 */
async function editing(): Promise<void> {
  // ── The record ──────────────────────────────────────────────────────────

  ok("a fresh edit is untouched", isUntouched(NO_EDIT));
  const copy = cloneEdit(NO_EDIT);
  copy.place.turn.y = 90;
  ok("a clone is deep — editing one does not reach the other",
    isUntouched(NO_EDIT) && !isUntouched(copy));
  copy.place.turn.y = 0;
  copy.look.on = true;
  ok("turning the material override on counts as an edit on its own",
    !isUntouched(copy));

  ok("a scale of zero is refused — it destroys the model, it does not shrink it",
    clampScale(0) === MIN_SCALE);
  ok("…and so is a scale too small to come back from", clampScale(1e-9) === MIN_SCALE);
  ok("…and nonsense becomes something safe", clampScale(Number.NaN) === MIN_SCALE);
  ok("an absurd scale is capped", clampScale(1e9) === MAX_SCALE);
  ok("an ordinary scale passes through untouched", clampScale(2.5) === 2.5);
  ok("a negative scale keeps its sign, because that is a mirror and not a mistake",
    clampScale(-2) === -2 && clampScale(-1e-9) === -MIN_SCALE);

  // ── Placement ───────────────────────────────────────────────────────────

  const one = new Mesh(new BoxGeometry(2, 4, 6), new MeshStandardMaterial());
  const place = cloneEdit(NO_EDIT).place;
  place.move = { x: 1, y: 2, z: 3 };
  place.turn = { x: 0, y: 90, z: 0 };
  place.size = { x: 2, y: 2, z: 2 };
  applyPlacement(one, place);
  ok("the placement moves the object", one.position.x === 1 && one.position.z === 3);
  ok("…turns it in degrees, which is what the boxes are labelled in",
    Math.abs(one.rotation.y - Math.PI / 2) < 1e-6, String(one.rotation.y));
  ok("…and sizes it", one.scale.x === 2);
  applyPlacement(one, cloneEdit(NO_EDIT).place);
  ok("…and resets exactly, because none of it ever touched a vertex",
    one.position.length() === 0 && one.rotation.y === 0 && one.scale.x === 1);

  // ── Look ────────────────────────────────────────────────────────────────

  const shaded = new MeshStandardMaterial({ color: 0x8844aa, roughness: 0.3, metalness: 0.9 });
  const lit = new Mesh(new BoxGeometry(1, 1, 1), shaded);
  const look = cloneEdit(NO_EDIT).look;
  look.on = true;
  look.colour = "#ff0000";
  look.roughness = 1;
  look.flat = true;
  look.opacity = 0.5;
  const version = shaded.version;
  applyLook(lit, look);
  ok("the override paints the material", shaded.color.getHex() === 0xff0000);
  ok("…sets roughness", shaded.roughness === 1);
  ok("…turns on transparency when the opacity is below 1",
    shaded.transparent && shaded.opacity === 0.5);
  /* Asserted through `version`, because `needsUpdate` is a write-only setter —
     reading it back gives `undefined` however faithfully it was set, and a
     check that reads it passes and fails for the wrong reasons. Bumping the
     version is what actually makes three recompile the shader, which flat
     shading needs and a uniform change does not. */
  ok("…and asks three to recompile, which flat shading needs",
    shaded.version > version, `${version} → ${shaded.version}`);
  look.on = false;
  applyLook(lit, look);
  ok("turning it off restores the file's own colour exactly, not a guess at it",
    shaded.color.getHex() === 0x8844aa, shaded.color.getHexString());
  ok("…and its own roughness, metalness and opacity",
    shaded.roughness === 0.3 && shaded.metalness === 0.9 && shaded.opacity === 1 && !shaded.transparent);

  // A point cloud has no roughness to set; writing one would put a field on an
  // object that never reads it, and pretend the slider did something.
  const cloudPoints = new Points(cloud(30), new PointsMaterial({ size: 1 }));
  look.on = true;
  applyLook(cloudPoints, look);
  ok("a material with no shading model is left alone rather than half-written",
    !("roughness" in (cloudPoints.material as object)));

  ok("an empty group has nothing to export", !hasGeometry(new Group()));
  ok("…and a mesh does", hasGeometry(lit));

  // ── Names and honesty ───────────────────────────────────────────────────

  ok("the export is named from the source, with the chosen format's extension",
    outName("C:/x/part.stl", "glb") === "C:/x/part-facet.glb");
  ok("…and a file with no extension keeps its whole name",
    outName("C:/x/part", "stl") === "C:/x/part-facet.stl");
  ok("…and a dot in a folder name is not mistaken for one",
    outName("C:/a.b/part", "obj") === "C:/a.b/part-facet.obj",
    outName("C:/a.b/part", "obj"));
  ok("STL says out loud that it cannot carry a material",
    (exportKind("stl").drops ?? "").includes("material"));
  ok("…and GLB says it drops nothing", exportKind("glb").drops === null);
  ok("every format is offered exactly once",
    new Set(EXPORTS.map((k) => k.id)).size === EXPORTS.length);

  // ── The bytes ───────────────────────────────────────────────────────────

  /* The setup that matters: a mesh of known, deliberately unequal dimensions,
     inside a group rotated the way the viewer rotates its stand. If the
     ancestor leaks into the file, Y and Z come back swapped. */
  const stand = new Group();
  stand.rotation.set(-Math.PI / 2, 0, 0);
  const part = new Mesh(new BoxGeometry(2, 4, 6), new MeshStandardMaterial());
  stand.add(part);
  stand.updateMatrixWorld(true);

  const stl = await encode(part, "stl");
  ok("the STL is binary and its header counts the box's twelve triangles",
    new DataView(stl.buffer, stl.byteOffset).getUint32(80, true) === 12,
    String(new DataView(stl.buffer, stl.byteOffset).getUint32(80, true)));

  const back = sizeOf(new STLLoader().parse(bufferOf(stl)));
  ok("the exported STL carries the file's own axes, not the stand's rotation",
    near(back.x, 2) && near(back.y, 4) && near(back.z, 6),
    `${back.x} × ${back.y} × ${back.z} — 2 × 6 × 4 would mean the stand was baked in`);
  // The detach has to be invisible to everything else: the model is back on the
  // stand, and its world matrix has the stand's rotation in it again — up is
  // once more where the screen wants it rather than where the file put it.
  const up = new Vector3(0, 1, 0).applyMatrix4(part.matrixWorld);
  ok("…and the model is back on the stand afterwards, standing up as before",
    part.parent === stand && near(up.z, -1) && near(up.y, 0),
    `up=(${up.x}, ${up.y}, ${up.z})`);

  // The edit, on the other hand, absolutely must be in the file — it is what
  // the user asked to save.
  applyPlacement(part, { ...cloneEdit(NO_EDIT).place, turn: { x: 0, y: 90, z: 0 } });
  const turned = sizeOf(new STLLoader().parse(bufferOf(await encode(part, "stl"))));
  ok("the edit itself does reach the file — a 90° turn swaps X and Z",
    near(turned.x, 6) && near(turned.y, 4) && near(turned.z, 2),
    `${turned.x} × ${turned.y} × ${turned.z}`);
  applyPlacement(part, cloneEdit(NO_EDIT).place);

  const obj = new TextDecoder().decode(await encode(part, "obj"));
  ok("the OBJ is text with vertices in it", /^v -?\d/m.test(obj));
  ok("…and its Y is the file's, not the stand's",
    Math.abs(extent(obj, 1) - 4) < 0.01, String(extent(obj, 1)));

  const glb = await encode(part, "glb");
  ok("the GLB starts with the glTF magic", new TextDecoder().decode(glb.slice(0, 4)) === "glTF");

  const gltf = JSON.parse(new TextDecoder().decode(await encode(part, "gltf"))) as {
    asset?: { version?: string }; buffers?: Array<{ uri?: string }>;
  };
  ok("the text glTF is JSON that declares its version", gltf.asset?.version === "2.0");
  ok("…and embeds its buffers, so the file cannot arrive without them",
    (gltf.buffers?.[0]?.uri ?? "").startsWith("data:"),
    "a sibling .bin is a file that gets separated from the model it belongs to");

  const ply = await encode(part, "ply");
  const plyHead = new TextDecoder().decode(ply.slice(0, 64));
  ok("the PLY is binary and says so in its header",
    plyHead.startsWith("ply") && plyHead.includes("binary_little_endian"), plyHead.slice(0, 40));
}

/** The dimensions of a geometry's bounding box. */
function sizeOf(g: BufferGeometry): Vector3 {
  g.computeBoundingBox();
  return g.boundingBox?.getSize(new Vector3()) ?? new Vector3();
}

/**
 * A copy of the bytes as their own ArrayBuffer.
 *
 * A `Uint8Array` can be a window onto a larger buffer, and every loader here
 * takes the whole buffer and ignores the offset — which reads the wrong bytes
 * without ever failing.
 */
function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

/** The extent of one axis across an OBJ's `v` lines. */
function extent(obj: string, axis: number): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (const line of obj.split("\n")) {
    if (!line.startsWith("v ")) continue;
    const v = Number(line.trim().split(/\s+/)[axis + 1]);
    if (!Number.isFinite(v)) continue;
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  return hi - lo;
}

function near(a: number, b: number, tol = 1e-3): boolean {
  return Math.abs(a - b) < tol;
}

/**
 * Wait for something to become true, or give up.
 *
 * The export is asynchronous — a dynamic import, then an exporter — so the
 * click that starts it has returned long before the bytes exist. Polling with a
 * ceiling is the honest version of that wait: a hang fails the check instead of
 * hanging the harness.
 */
async function until(cond: () => boolean, ms = 4000): Promise<void> {
  const stop = performance.now() + ms;
  while (!cond() && performance.now() < stop) {
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * The one part that needs a GPU: open a real file in the real view.
 *
 * Everything above this deliberately avoids a WebGL context so it can run
 * anywhere. This section is the end-to-end counterpart — a tetrahedron built
 * byte by byte, handed to the actual `SceneView` through a blob URL, and asked
 * what it thinks it is looking at. If the environment has no GPU it reports a
 * skip rather than a failure, because "this machine has no WebGL" is not a
 * defect in the viewer.
 */
async function live(): Promise<void> {
  const stl = tetrahedron();
  const url = URL.createObjectURL(new Blob([stl as BlobPart], { type: "model/stl" }));
  // Stands in for the desktop app's writer. Keeping the bytes is what lets the
  // panel's export be asserted end to end rather than only "the click threw no
  // error" — and it returns a *different* name, the way a real `writeFile` does
  // when the obvious one is taken, so the button is checked against what was
  // actually written rather than what was asked for.
  const written: Array<{ path: string; bytes: Uint8Array }> = [];
  // Screenshots are kept apart, and the first name is refused the way the
  // desktop writer refuses a file that exists, so the viewer has to step on.
  const shots: Array<{ path: string; bytes: Uint8Array }> = [];
  const refused: string[] = [];
  const urls = new Map<string, string>();
  // A store of its own, so the run neither reads nor leaves behind the real
  // app's remembered panel and tone map.
  const prefs = new SettingsStore(memoryBackend());
  prefs.register(...ALL_SETTINGS);
  const view = new SceneView({
    fileUrl: (path) => Promise.resolve(urls.get(path) ?? url),
    openExternal: () => Promise.resolve(),
    writeFile: (path, bytes) => {
      if (path.includes("-screenshot-")) {
        if (path.endsWith("-screenshot-1.png")) {
          refused.push(path);
          return Promise.reject(new Error(`${path}: already exists`));
        }
        shots.push({ path, bytes: bytes.slice() });
        return Promise.resolve(path);
      }
      written.push({ path, bytes: bytes.slice() });
      return Promise.resolve(path.replace(/\.(\w+)$/, " (2).$1"));
    },
    prefs,
  });

  try {
    await view.open([], {
      path: "C:/x/tetra.stl", name: "tetra.stl", kind: "model3d", ext: "stl",
      size: stl.length, modified: 1_700_000_000_000,
    });
    await new Promise((r) => setTimeout(r, 250));

    const status = document.querySelector(".sv-status")?.textContent ?? "";
    const note = document.querySelector(".sv-note");
    const shown = note && !(note as HTMLElement).hidden ? note.textContent : "";

    ok("a hand-built binary STL opens in the real view",
      status.includes("STL (binary)"), `status="${status}" note="${shown}"`);
    ok("…and is counted correctly", status.includes("4 triangles"), status);
    ok("…and reports that the file brought no materials of its own",
      status.includes("no materials in file"), status);
    ok("…and that it was stood up Z-first, as an STL should be",
      status.includes("Z up"), status);
    ok("the canvas has a real drawing buffer",
      ((document.querySelector(".sv-canvas") as HTMLCanvasElement | null)?.width ?? 0) > 0);

    /* Both of these ask the *browser*, not the DOM property, and that
       distinction is the entire point. The `shown` check above reads
       `note.hidden`, which was perfectly true while the note sat on screen
       across the model all session: `.sv-note` carries an author `display:
       flex`, and an author rule beats the user agent's `[hidden] { display:
       none }` however specific either one is. A stale note is only the visible
       half — spanning the stage at `inset: 0`, it also ate the pointerdown that
       begins an orbit, so the model could not be turned at all. */
    const style = note ? getComputedStyle(note) : null;
    ok("the note is really gone once a model is up, not merely marked hidden",
      style?.display === "none",
      `display=${style?.display} — an author display beats [hidden]`);
    ok("…and never takes the mouse from the canvas even while it is showing",
      style?.pointerEvents === "none", `pointer-events=${style?.pointerEvents}`);

    /* The override is the answer to "did this file export wrong, or did I press
       something?", and it was arriving one toggle late: `renderStatus` reads
       `override`, so the line only refreshed when some *other* control happened
       to redraw it. Asserted through the button rather than the method, because
       the method was never the part that was broken. */
    const plain = [...document.querySelectorAll(".sv-btn")]
      .find((b) => (b as HTMLButtonElement).title.startsWith("Plain material"));
    (plain as HTMLButtonElement | undefined)?.click();
    ok("switching to the plain material says so in the status line at once",
      (document.querySelector(".sv-status")?.textContent ?? "").includes("plain material"),
      document.querySelector(".sv-status")?.textContent ?? "");
    (plain as HTMLButtonElement | undefined)?.click();

    /* The size on the status line is a statement about the file, and pressing Z
       is a statement about the screen — so the numbers must not move. They did:
       the survey was taken after the model was hung on the stand, and
       `Box3.setFromObject` updates world matrices *upwards* from whatever it is
       given, so it measured the stand's rotation however carefully the model was
       the node passed in. The tetrahedron reported 10 × 8 × 8.6 with Z up and
       10 × 8.6 × 8 with Y up: same file, two answers, and the wrong one on
       screen by default. */
    const dimsOf = (): string =>
      ((document.querySelector(".sv-status")?.textContent ?? "")
        .split("·").map((s) => s.trim()).find((s) => s.includes("×")) ?? "");
    const zUp = [...document.querySelectorAll(".sv-btn")]
      .find((b) => (b as HTMLButtonElement).title.startsWith("Z is up")) as HTMLButtonElement | undefined;
    const zDims = dimsOf();
    zUp?.click();
    const yDims = dimsOf();
    zUp?.click();
    ok("the size on the status line is the file's own and does not swap when Z-up is toggled",
      zDims === yDims && zDims.length > 0, `${zDims} then ${yDims}`);
    ok("…and it is the file's axes that are reported, not the screen's",
      zDims.startsWith("10.00 × 8.60 × 8.00"), zDims);

    // ── The edit panel, through the buttons a person would press (item 6) ──

    const pencil = [...document.querySelectorAll(".sv-btn")]
      .find((b) => (b as HTMLButtonElement).title.startsWith("Move, turn")) as HTMLButtonElement | undefined;
    pencil?.click();
    const panel = document.querySelector(".se") as HTMLElement | null;
    ok("the edit panel opens from the toolbar", !!panel && !panel.hidden);
    /* Asked of the browser and not of the property, for the reason `.sv-note`
       taught: an author `display: flex` outlives `hidden`, and a panel that
       cannot close is also a panel that permanently covers the model. */
    ok("…and its `hidden` really hides it",
      (() => {
        pencil?.click();
        const gone = panel ? getComputedStyle(panel).display === "none" : false;
        pencil?.click();
        return gone;
      })(),
      "an author display beats [hidden]");

    const pick = document.querySelector(".se-pick") as HTMLSelectElement | null;
    ok("every format is on offer", (pick?.options.length ?? 0) === EXPORTS.length);
    if (pick) {
      pick.value = "stl";
      pick.dispatchEvent(new Event("change"));
    }
    ok("choosing STL warns that it cannot carry a material, before the save",
      (document.querySelector(".se-warn")?.textContent ?? "").includes("material"),
      document.querySelector(".se-warn")?.textContent ?? "(no warning shown)");
    ok("…and shows the name it will write",
      (document.querySelector(".se-out")?.textContent ?? "") === "tetra-facet.stl",
      document.querySelector(".se-out")?.textContent ?? "");

    // Turn it 90° about Y through the real number box, so what is asserted is
    // the panel's own plumbing and not `applyPlacement` a second time.
    const turnY = [...document.querySelectorAll(".se-num")]
      .find((i) => (i as HTMLInputElement).title === "Turn ° Y") as HTMLInputElement | undefined;
    if (turnY) {
      turnY.value = "90";
      turnY.dispatchEvent(new Event("change"));
    }
    ok("typing a turn into the panel says the model has been edited",
      (document.querySelector(".se-foot")?.textContent ?? "").includes("edited"),
      document.querySelector(".se-foot")?.textContent ?? "");

    (document.querySelector(".se-save") as HTMLButtonElement | null)?.click();
    await until(() => written.length > 0);
    ok("the export reaches the writer", written.length === 1, `${written.length} writes`);

    const out = written[0];
    ok("…under a name derived from the file, with the chosen extension",
      out?.path.endsWith("tetra-facet.stl") ?? false, out?.path ?? "");
    ok("…never overwriting: the button reports the name that was really written",
      (document.querySelector(".se-save")?.textContent ?? "").includes("tetra-facet (2).stl"),
      document.querySelector(".se-save")?.textContent ?? "");

    const saved = out ? sizeOf(new STLLoader().parse(bufferOf(out.bytes))) : new Vector3();
    /* The tetrahedron is 10 × 8.6 × 8 in the file, and the viewer is showing it
       stood up Z-first. Turned 90° about Y it must be 8 × 8.6 × 10 — which is
       the edit and only the edit. Had the stand gone in too, Y and Z would have
       traded places on top of that. */
    ok("what lands on disk is the file's own axes plus the edit, and nothing else",
      near(saved.x, 8) && near(saved.y, 8.6) && near(saved.z, 10),
      `${saved.x} × ${saved.y} × ${saved.z} — expected 8 × 8.6 × 10`);

    // Undo, by the keystroke, not by calling the method.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
    ok("Ctrl+Z puts the model back where it started",
      (document.querySelector(".se-foot")?.textContent ?? "").includes("unchanged"),
      document.querySelector(".se-foot")?.textContent ?? "");
    ok("…and the number box on screen agrees with it",
      ((document.querySelector(".se-num") as HTMLInputElement | null)?.value ?? "") === "0");

    /* The footer's size, which is the panel's answer to the one question the
       status line deliberately will not answer. That line reports the file as
       it sits on disk and it stays that way — but somebody scaling a part to
       print it is editing *toward* a number, and the number they need is what
       it will be, not what it was. Asserted as a ratio rather than against a
       printed string, so it holds whatever `dims` decides to round to. */
    const footSize = (): number[] =>
      (document.querySelector(".se-foot")?.textContent ?? "")
        .split("·").pop()!.split("×").map((s) => Number(s.trim()));
    const before = footSize();
    ok("the panel reports the model's own size while nothing has been scaled",
      before.length === 3 && near(before[0]!, 10) && near(before[2]!, 8),
      document.querySelector(".se-foot")?.textContent ?? "");

    const sizeX = [...document.querySelectorAll(".se-num")]
      .find((i) => (i as HTMLInputElement).title === "Size × X") as HTMLInputElement | undefined;
    if (sizeX) {
      sizeX.value = "2";
      sizeX.dispatchEvent(new Event("change"));
    }
    const after = footSize();
    ok("…and reports what it becomes once it is scaled, which is the number a print needs",
      after.length === 3 && after.every((v, i) => near(v, before[i]! * 2, 0.02)),
      `${document.querySelector(".se-foot")?.textContent ?? ""} — expected every axis doubled`);

    // ── The parity work, through the keys and the panel (items A2–A19) ─────

    pencil?.click(); // shut the edit panel, so Escape below has one layer to peel
    const peek = view as unknown as Peek;
    const root = document.querySelector(".sv") as HTMLElement;
    const keyDown = (key: string): void => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    };
    const visible = (selector: string): boolean => {
      const e = document.querySelector(selector);
      return !!e && getComputedStyle(e).display !== "none";
    };

    /* The panel starts shut because the parent's pop-out window can be 320 px
       wide, and a remembered-open panel there would be the whole window. */
    ok("the side panel starts collapsed", !visible(".sv-panel"),
      `display=${getComputedStyle(document.querySelector(".sv-panel")!).display}`);
    const burger = [...document.querySelectorAll(".sv-btn")]
      .find((b) => (b as HTMLButtonElement).title.startsWith("Display, lighting")) as HTMLButtonElement | undefined;
    burger?.click();
    ok("☰ opens it — really, not merely unhidden", visible(".sv-panel"));
    ok("…and the next session remembers it was open", prefs.get<boolean>(PREF.scenePanelOpen) === true);

    const target = (): Vector3 => peek.controls?.target.clone() ?? new Vector3();
    const facing = (): Vector3 => peek.camera.position.clone().sub(target()).normalize();
    keyDown("1");
    ok("1 is the front view", facing().distanceTo(new Vector3(0, 0, 1)) < 1e-3, facing().toArray().join(","));
    keyDown("2");
    ok("2 is the right view", facing().distanceTo(new Vector3(1, 0, 0)) < 1e-3, facing().toArray().join(","));
    keyDown("0");
    ok("0 is isometric", facing().distanceTo(new Vector3(1, 1, 1).normalize()) < 1e-3, facing().toArray().join(","));

    /* Switching projection is a question about the drawing, so the model must
       not change size on screen. Measured as the projected height of one
       radius at the target — the plane the orbit turns about. */
    const onScreen = (): number => {
      const cam = peek.camera;
      cam.updateMatrixWorld(true);
      const up = new Vector3().setFromMatrixColumn(cam.matrixWorld, 1).normalize();
      return target().addScaledVector(up, peek.radius).project(cam).y - target().project(cam).y;
    };
    const perspSize = onScreen();
    const perspDistance = peek.camera.position.distanceTo(target());
    keyDown("5");
    ok("5 switches to orthographic", peek.projection === "orthographic" && peek.camera instanceof OrthographicCamera);
    ok("…without the model changing size on screen",
      Math.abs(onScreen() / perspSize - 1) < 0.01, `${perspSize} then ${onScreen()}`);
    ok("…and the field-of-view slider goes, since it means nothing there", !visible(".sv-fov"));
    keyDown("5");
    ok("5 again comes back to perspective at the same distance",
      peek.projection === "perspective" && Math.abs(peek.camera.position.distanceTo(target()) / perspDistance - 1) < 1e-6,
      `${perspDistance} then ${peek.camera.position.distanceTo(target())}`);

    const segButton = (text: string): HTMLButtonElement | undefined =>
      [...document.querySelectorAll(".sv-seg-btn")].find((b) => b.textContent === text) as HTMLButtonElement | undefined;
    segButton("Edges")?.click();
    ok("the Edges button draws the tetrahedron's six edges", !!peek.edges && edgeCount(peek.edges) === 6,
      String(peek.edges ? edgeCount(peek.edges) : "no overlay"));
    ok("…and the crease angle slider appears with it", visible(".sv-edge-angle"));
    segButton("Shaded")?.click();
    ok("Shaded takes the lines away again", peek.edges === null);
    keyDown("b");
    ok("B shows the bounding box", peek.box !== null);
    keyDown("b");
    ok("…and B again hides it", peek.box === null);

    // Draw on demand, measured by counting the view's own draws.
    let draws = 0;
    const realDraw = peek.draw.bind(view);
    peek.draw = (withGizmo: boolean): void => {
      draws++;
      realDraw(withGizmo);
    };
    const drawsOver = async (ms: number): Promise<number> => {
      const from = draws;
      await new Promise((r) => setTimeout(r, ms));
      return draws - from;
    };
    let idle = -1;
    for (let i = 0; i < 20 && idle !== 0; i++) idle = await drawsOver(300);
    ok("a still model is not redrawn", idle === 0, `${idle} draws in 300 ms`);

    const before3 = peek.camera.position.clone();
    keyDown("r");
    const spinning = await drawsOver(600);
    ok("R starts the turntable, drawing continuously", spinning > 10, `${spinning} draws in 600 ms`);
    ok("…and the camera really goes round", peek.camera.position.distanceTo(before3) > peek.radius * 0.05);
    keyDown("r");
    let settled = -1;
    for (let i = 0; i < 20 && settled !== 0; i++) settled = await drawsOver(300);
    ok("…and R again lets it fall idle", settled === 0, `${settled} draws in 300 ms`);

    /* A damped orbit fires "change" from inside the frame it draws. Every one of
       those asked for another frame, and before the guard each asked for its own
       — two loops, then four, all drawing the same picture. */
    let frames = 0;
    let counting = true;
    const countFrame = (): void => {
      if (!counting) return;
      frames++;
      requestAnimationFrame(countFrame);
    };
    requestAnimationFrame(countFrame);
    const from = draws;
    peek.controls?._rotateLeft(0.6);
    peek.controls?.update();
    await new Promise((r) => setTimeout(r, 800));
    counting = false;
    ok("a damped orbit draws at most once a frame, however many change events it fires",
      draws - from > 0 && draws - from <= frames + 2, `${draws - from} draws in ${frames} frames`);

    (document.querySelector('.sv-swatch[data-bg="black"]') as HTMLButtonElement | null)?.click();
    ok("the Black swatch paints the background black",
      peek.scene.background instanceof Color && peek.scene.background.getHex() === 0);
    ok("…and is remembered", prefs.get<string>(PREF.sceneBackground) === "black");
    const tone = [...document.querySelectorAll(".sv-panel .sv-select")]
      .find((s) => [...(s as HTMLSelectElement).options].some((o) => o.value === "agx")) as HTMLSelectElement | undefined;
    if (tone) {
      tone.value = "agx";
      tone.dispatchEvent(new Event("change"));
    }
    ok("choosing AgX tone mapping reaches the renderer", peek.renderer?.toneMapping === AgXToneMapping);
    ok("…and is remembered", prefs.get<string>(PREF.sceneToneMap) === "agx");

    keyDown("s");
    await until(() => shots.length > 0);
    ok("S saves a screenshot, stepping past a name that is taken",
      refused.some((p) => p.endsWith("tetra-screenshot-1.png")) &&
      (shots[0]?.path.endsWith("tetra-screenshot-2.png") ?? false), shots[0]?.path ?? "(nothing written)");
    const png = shots[0]?.bytes ?? new Uint8Array();
    ok("…and what is written is a PNG", png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47);
    ok("…and the toast names the file", (document.querySelector(".sv-toast")?.textContent ?? "").includes("tetra-screenshot-2.png"),
      document.querySelector(".sv-toast")?.textContent ?? "");

    keyDown("?");
    ok("? opens the shortcut sheet", visible(".sv-help"));
    keyDown("Escape");
    ok("Escape closes the sheet and only the sheet", !visible(".sv-help") && view.isOpen);

    const statusNow = document.querySelector(".sv-status")?.textContent ?? "";
    ok("the status line counts meshes", statusNow.includes("1 mesh"), statusNow);
    const info = document.querySelector(".sv-info")?.textContent ?? "";
    ok("the panel's Model section counts triangles", info.includes("Triangles") && info.includes("4"), info);
    ok("the orientation gizmo is on screen beside an open panel", visible(".sv-gizmo"));

    // An animated glTF, built by hand: one triangle that slides 10 along X in 2 s.
    const animated = animatedGltf();
    urls.set("C:/x/slide.gltf", URL.createObjectURL(new Blob([animated as BlobPart], { type: "model/gltf+json" })));
    await view.open([], { path: "C:/x/slide.gltf", name: "slide.gltf", kind: "model3d", ext: "gltf", size: animated.length });
    await until(() => (document.querySelector(".sv-status")?.textContent ?? "").includes("animation"));
    const animStatus = document.querySelector(".sv-status")?.textContent ?? "";
    ok("a glTF with a clip says so on the status line", animStatus.includes("1 animation"), animStatus);
    ok("…shows the animation bar", visible(".sv-anim"));
    ok("…and starts playing", peek.head.playing);
    keyDown(" ");
    ok("Space pauses it", !peek.head.playing);
    const scrubber = document.querySelector(".sv-anim-scrub") as HTMLInputElement | null;
    if (scrubber) {
      scrubber.value = "500";
      scrubber.dispatchEvent(new Event("input"));
    }
    const moverX = peek.model?.getObjectByName("mover")?.position.x ?? Number.NaN;
    ok("scrubbing half way poses the model half way", near(moverX, 5, 1e-3), String(moverX));
    ok("…and the clock says where", (document.querySelector(".sv-anim-time")?.textContent ?? "") === "0:01.0 / 0:02.0",
      document.querySelector(".sv-anim-time")?.textContent ?? "");
    const speed = document.querySelector(".sv-anim-speed") as HTMLSelectElement | null;
    if (speed) {
      speed.value = "2";
      speed.dispatchEvent(new Event("change"));
    }
    ok("the speed menu sets the speed", peek.head.speed === 2);
    (document.querySelector(".sv-anim-loop") as HTMLButtonElement | null)?.click();
    ok("the loop button turns looping off", !peek.head.loop);

    const mf = threeMfFile();
    urls.set("C:/x/tetra.3mf", URL.createObjectURL(new Blob([mf as BlobPart], { type: "model/3mf" })));
    await view.open([], { path: "C:/x/tetra.3mf", name: "tetra.3mf", kind: "model3d", ext: "3mf", size: mf.length });
    await until(() => (document.querySelector(".sv-status")?.textContent ?? "").includes("3MF"));
    const mfStatus = document.querySelector(".sv-status")?.textContent ?? "";
    ok("a 3MF opens in the real view", mfStatus.includes("3MF") && mfStatus.includes("4 triangles"), mfStatus);
    ok("…and the animation bar goes, since it has no clips", !visible(".sv-anim"));
    ok("…and the clip it left behind is let go", peek.head.duration === 0 && !peek.head.playing);

    /* The pop-out window. Below ~520 px the bar keeps only what it cannot do
       without and the panel becomes a sheet over the model. */
    root.style.width = "360px";
    await until(() => root.dataset["compact"] === "1");
    ok("a narrow viewer switches to compact", root.dataset["compact"] === "1");
    ok("…and hides the optional toolbar buttons", !visible(".sv-opt"));
    ok("…and the gizmo, which would cover most of it", !visible(".sv-gizmo"));
    root.style.width = "";
    await until(() => root.dataset["compact"] === undefined);
  } catch (err) {
    // A missing WebGL context is the expected failure here and the only one
    // worth forgiving; anything else is a real defect and is reported as one.
    const why = err instanceof Error ? err.message : String(err);
    if (/webgl|context/i.test(why)) console.warn("live 3D skipped — no WebGL here:", why);
    else ok("the live open did not throw", false, why);
  } finally {
    // `?keep` leaves a good-looking model open in the view, for screenshots.
    if (KEEP) await showcase(view, urls);
    else {
      view.destroy();
      URL.revokeObjectURL(url);
      for (const u of urls.values()) URL.revokeObjectURL(u);
    }
  }

  const line = `scene: ${pass} passed, ${fail} failed`;
  console.log(`%c${line}`, `color:${fail ? "#ff6b6b" : "#3ddc84"}`);
  document.title = line;
  if (!KEEP) document.body.textContent = line;
}

const KEEP = new URLSearchParams(location.search).has("keep");

/** The private parts of the view the live checks read. Test-only, and cast to. */
interface Peek {
  camera: PerspectiveCamera | OrthographicCamera;
  controls: (OrbitControls & { _rotateLeft(angle: number): void }) | null;
  renderer: WebGLRenderer | null;
  scene: Scene;
  edges: EdgeOverlay | null;
  box: Object3D | null;
  head: { playing: boolean; time: number; duration: number; speed: number; loop: boolean };
  model: Object3D | null;
  projection: string;
  radius: number;
  draw(withGizmo: boolean): void;
}

/**
 * A torus knot, handed to the view as a real GLB, so the screenshots show what
 * the lighting does to a curved, shiny surface rather than to four flat faces.
 */
async function showcase(view: SceneView, urls: Map<string, string>): Promise<void> {
  const knot = new Mesh(
    new TorusKnotGeometry(1, 0.32, 220, 36),
    new MeshStandardMaterial({ color: 0x8fb4ff, metalness: 0.55, roughness: 0.28 }),
  );
  knot.name = "knot";
  const scene = new Scene();
  scene.add(knot);
  const out = await new GLTFExporter().parseAsync(scene, { binary: true });
  const bytes = new Uint8Array(out as ArrayBuffer);
  urls.set("C:/x/knot.glb", URL.createObjectURL(new Blob([bytes as BlobPart], { type: "model/gltf-binary" })));
  await view.open([], { path: "C:/x/knot.glb", name: "knot.glb", kind: "model3d", ext: "glb", size: bytes.length });
  disposeTree(scene);
}

/**
 * One triangle called "mover", with one clip called "slide" that carries it
 * from x = 0 to x = 10 over two seconds — the smallest glTF with an animation.
 */
function animatedGltf(): Uint8Array {
  const bin = new ArrayBuffer(68);
  new Float32Array(bin, 0, 9).set([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  new Float32Array(bin, 36, 2).set([0, 2]);
  new Float32Array(bin, 44, 6).set([0, 0, 0, 10, 0, 0]);
  let raw = "";
  for (const b of new Uint8Array(bin)) raw += String.fromCharCode(b);
  const gltf = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: "mover", mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: 68, uri: `data:application/octet-stream;base64,${btoa(raw)}` }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 8 },
      { buffer: 0, byteOffset: 44, byteLength: 24 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 2, type: "SCALAR", min: [0], max: [2] },
      { bufferView: 2, componentType: 5126, count: 2, type: "VEC3" },
    ],
    animations: [{
      name: "slide",
      channels: [{ sampler: 0, target: { node: 0, path: "translation" } }],
      samplers: [{ input: 1, output: 2, interpolation: "LINEAR" }],
    }],
  };
  return new TextEncoder().encode(JSON.stringify(gltf));
}

/** Four triangles, written as a real binary STL — header text and all. */
function tetrahedron(): Uint8Array {
  const v: Array<[number, number, number]> = [
    [0, 0, 0], [10, 0, 0], [5, 8.6, 0], [5, 2.9, 8],
  ];
  const faces = [[0, 1, 2], [0, 1, 3], [1, 2, 3], [2, 0, 3]];
  const bytes = new Uint8Array(84 + faces.length * 50);
  const dv = new DataView(bytes.buffer);
  // The header that breaks a naive reader, in the file the viewer actually gets.
  const header = "solid tetrahedron";
  for (let i = 0; i < header.length; i++) bytes[i] = header.charCodeAt(i);
  dv.setUint32(80, faces.length, true);
  let at = 84;
  for (const f of faces) {
    dv.setFloat32(at, 0, true); dv.setFloat32(at + 4, 0, true); dv.setFloat32(at + 8, 1, true);
    at += 12;
    for (const i of f) {
      const p = v[i]!;
      dv.setFloat32(at, p[0], true);
      dv.setFloat32(at + 4, p[1], true);
      dv.setFloat32(at + 8, p[2], true);
      at += 12;
    }
    at += 2; // attribute byte count
  }
  return bytes;
}

/** A header that claims more triangles than any file could hold. */
function binaryStlClaiming(count: number): Uint8Array {
  const bytes = new Uint8Array(500);
  new DataView(bytes.buffer).setUint32(80, count, true);
  return bytes;
}

/** Non-indexed with normals — the exact shape STLLoader hands back. */
function stlLike(count: number): BufferGeometry {
  const g = new BufferGeometry();
  const position = new Float32Array(count * 9);
  for (let i = 0; i < position.length; i++) position[i] = ((i * 13) % 50) / 50;
  g.setAttribute("position", new BufferAttribute(position, 3));
  g.setAttribute("normal", new BufferAttribute(new Float32Array(count * 9).fill(1), 3));
  return g;
}

main();
