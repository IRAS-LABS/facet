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
  Box3,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Frustum,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  Texture,
  Vector3,
} from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";

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
  buildDrawable,
  buildGrid,
  defaultUp,
  dims,
  disposeTree,
  frameFor,
  pointSize,
  survey,
} from "@core/model3d/scene";
import { BUILT_IN, OpensStore, memoryOpens, resolveOpen } from "@core/explorer/opens";
import { SceneView } from "@ui/scene-view";

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

  void editing().then(live);
}

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
  const view = new SceneView({
    fileUrl: () => Promise.resolve(url),
    openExternal: () => Promise.resolve(),
    writeFile: (path, bytes) => {
      written.push({ path, bytes: bytes.slice() });
      return Promise.resolve(path.replace(/\.(\w+)$/, " (2).$1"));
    },
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
  } catch (err) {
    // A missing WebGL context is the expected failure here and the only one
    // worth forgiving; anything else is a real defect and is reported as one.
    const why = err instanceof Error ? err.message : String(err);
    if (/webgl|context/i.test(why)) console.warn("live 3D skipped — no WebGL here:", why);
    else ok("the live open did not throw", false, why);
  } finally {
    view.destroy();
    URL.revokeObjectURL(url);
  }

  const line = `scene: ${pass} passed, ${fail} failed`;
  console.log(`%c${line}`, `color:${fail ? "#ff6b6b" : "#3ddc84"}`);
  document.title = line;
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
