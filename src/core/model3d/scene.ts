/**
 * Everything about a 3D scene that is arithmetic rather than a screen (item 13).
 *
 * Split out of `@ui/scene-view` for one concrete reason: **a WebGL context needs
 * a GPU and none of this does.** three's scene graph, its geometry, its bounding
 * volumes and every line of the camera-framing maths run perfectly well with no
 * renderer in existence — so putting them here is what lets the harness assert
 * that a 0.01-unit model and a 40,000-unit model both end up on screen, which is
 * the single most important behaviour in the viewer and the one that is
 * impossible to check by eye without a folder of pathological files.
 *
 * DOM-free. Three-dependent, unlike `./formats`, which is deliberately neither.
 */

import {
  Box3,
  BufferGeometry,
  DoubleSide,
  EdgesGeometry,
  GridHelper,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Points,
  PointsMaterial,
  ShadowMaterial,
  Sphere,
  Texture,
  Vector3,
  type Material,
} from "three";

import type { Model3DFormat } from "./formats";

/** Which way is up. */
export type UpAxis = "y" | "z";

/** What the status line says about the model currently on screen. */
export interface Survey {
  meshes: number;
  triangles: number;
  vertices: number;
  /** Size along each axis, in the space `survey` was handed — see there. */
  size: Vector3;
  points: boolean;
  vertexColors: boolean;
  /**
   * Distinct materials, textures and animation clips (item A14). Distinct by
   * identity, not by slot: a glTF that hands one material to 400 meshes has one
   * material, and a status line saying 400 would send someone looking for a
   * duplication bug in their exporter that is not there.
   */
  materials: number;
  textures: number;
  animations: number;
}

/** Where to put the camera, and what to clip with. */
export interface Framing {
  position: Vector3;
  target: Vector3;
  near: number;
  far: number;
  /** The bounding sphere the rest was derived from. The grid wants it too. */
  center: Vector3;
  radius: number;
}

/**
 * glTF is defined Y-up by its own specification. STL and PLY say nothing at all,
 * and the tools that write them — CAD packages, slicers, scanners — are Z-up by
 * overwhelming convention, so a printed part loaded without this correction lies
 * on its side. OBJ is Y-up by convention from its graphics lineage.
 *
 * 3MF is the one format that settles it in writing: its specification is Z-up,
 * in millimetres. COLLADA declares its own `up_axis`, and three's loader already
 * turns a Z-up file upright, so correcting it again here would lay it down.
 *
 * This is a *default*, not a fact, which is why the viewer puts it on a key.
 */
export function defaultUp(format: Model3DFormat): UpAxis {
  return format.startsWith("stl") || format.startsWith("ply") || format === "3mf" ? "z" : "y";
}

/**
 * Wrap a bare geometry in something drawable.
 *
 * `mayBePoints` is passed rather than inferred, and that is the whole subtlety.
 * A PLY straight off a scanner is frequently vertices and nothing else, and a
 * `Mesh` built from it has a bounding box and no visible surface — which looks
 * exactly like a file that failed to load. But "has no index buffer" cannot be
 * the test on its own, because an STL *never* has one: an STL is a flat list of
 * triangles by definition, indexed by nothing. So the format decides whether
 * facelessness is even possible, and only then does the index buffer decide.
 */
export function buildDrawable(geometry: BufferGeometry, mayBePoints: boolean): Object3D {
  const colours = geometry.getAttribute("color") !== undefined;

  if (mayBePoints && geometry.index === null) {
    const material = new PointsMaterial({ size: pointSize(geometry), sizeAttenuation: true });
    if (colours) material.vertexColors = true;
    return new Points(geometry, material);
  }
  // PLY frequently arrives with no normals at all, and a mesh without them
  // lights as a flat silhouette — the same "looks broken" failure again. STL
  // *always* has the attribute, which is the trap: the format permits a writer
  // to leave the facet normal as (0,0,0) and expects the reader to derive it
  // from vertex winding instead, and plenty of exporters take that option. A
  // present-but-degenerate normal set has to count as no normals at all.
  if (geometry.getAttribute("normal") === undefined || normalsAreDegenerate(geometry)) {
    geometry.computeVertexNormals();
  }
  return new Mesh(geometry, plainMaterial(geometry));
}

/**
 * Does this geometry carry normals in name only?
 *
 * Sampled rather than scanned: a five-million-triangle STL means fifteen million
 * vertices, and walking all of them on the main thread to answer a yes/no
 * question would stall the window before the model ever appeared.
 *
 * The test is deliberately *every* sample rather than *any*. An exporter makes
 * this choice once for a whole file — it either writes normals or it writes
 * zeroes — so all-degenerate is the real-world shape of the bug. Recomputing on
 * a single bad vertex would instead throw away the genuine smooth normals on a
 * PLY, replacing a rounded surface with a faceted one, which is a worse and much
 * harder-to-spot regression than the thing being fixed.
 */
export function normalsAreDegenerate(geometry: BufferGeometry): boolean {
  const n = geometry.getAttribute("normal");
  if (!n || n.count === 0) return true;
  const samples = Math.min(n.count, 64);
  const stride = Math.max(1, Math.floor(n.count / samples));
  for (let i = 0; i < n.count; i += stride) {
    if (Math.hypot(n.getX(i), n.getY(i), n.getZ(i)) > 1e-6) return false;
  }
  return true;
}

/**
 * Point size scaled to the model, so a 0.01-unit scan and a 4,000-unit one both
 * come out as a readable cloud rather than one dot or one solid block.
 */
export function pointSize(geometry: BufferGeometry): number {
  geometry.computeBoundingSphere();
  const r = geometry.boundingSphere?.radius ?? 1;
  return Math.max(r / 400, 1e-5);
}

/** The stand-in material, also used by the viewer's override toggle. */
export function plainMaterial(geometry: BufferGeometry): MeshStandardMaterial {
  const m = new MeshStandardMaterial({
    color: 0xb9bfc9,
    roughness: 0.65,
    metalness: 0.05,
    // Double-sided because STL and OBJ in the wild routinely have inconsistent
    // winding, and a single-sided default renders those faces as holes.
    side: DoubleSide,
  });
  if (geometry.getAttribute("color") !== undefined) m.vertexColors = true;
  return m;
}

/**
 * Count what is on screen, for the status line.
 *
 * **`size` is measured through `matrixWorld`**, because `Box3.setFromObject` is,
 * and no argument changes that — it updates the world matrix upwards from the
 * root before it starts. So the size is in the root's own space only while the
 * root has no parent. Survey a model that has already been hung under something
 * rotated and the numbers are that something's, not the file's.
 */
export function survey(root: Object3D): Survey {
  let meshes = 0;
  let triangles = 0;
  let vertices = 0;
  let points = false;
  let vertexColors = false;
  let animations = 0;
  const mats = new Set<Material>();
  const textures = new Set<Texture>();
  root.traverse((o) => {
    // Clips hang off whichever node the loader chose — glTF's scene, COLLADA's
    // root — so they are summed over the tree rather than read from the top.
    animations += o.animations.length;
    const material = (o as Partial<Mesh>).material;
    if (material) {
      for (const m of materials(material)) {
        mats.add(m);
        for (const t of texturesOf(m)) textures.add(t);
      }
    }
    const geometry = (o as Partial<Mesh>).geometry;
    if (!geometry) return;
    const position = geometry.getAttribute("position");
    if (!position) return;
    vertices += position.count;
    if (geometry.getAttribute("color") !== undefined) vertexColors = true;
    if (o instanceof Points) {
      points = true;
      return;
    }
    meshes++;
    triangles += Math.floor((geometry.index?.count ?? position.count) / 3);
  });
  const box = new Box3().setFromObject(root);
  const size = box.isEmpty() ? new Vector3() : box.getSize(new Vector3());
  return {
    meshes, triangles, vertices, size, points, vertexColors,
    materials: mats.size, textures: textures.size, animations,
  };
}

/**
 * Every texture a material holds, found the only way that covers them all.
 *
 * There is no list of which slots a given material type has — a physical
 * material has a dozen a standard one lacks, and a glTF extension can add more
 * — so every property is checked. `disposeMaterial` walks the same way, for the
 * same reason.
 */
export function texturesOf(m: Material): Texture[] {
  const out: Texture[] = [];
  for (const value of Object.values(m as unknown as Record<string, unknown>)) {
    if (value instanceof Texture) out.push(value);
  }
  return out;
}

/**
 * Margin around the framed model, as a multiple of the exact-fit distance.
 *
 * Pulled out as a constant because it is the only number here chosen by taste
 * rather than derived; everything else in `frameFor` follows from it.
 */
const MARGIN = 1.4;

/**
 * Where to put the camera so the whole model is on screen — whatever scale it is
 * at, and wherever in space it happens to sit.
 *
 * This is the viewer's entire first impression, and it is where naive 3D
 * viewers fail. A model can be 0.01 units across or 40,000; it can sit on the
 * origin or a mile off it, which CAD and GIS exports do routinely. A camera
 * parked at a fixed (0, 0, 5) shows an empty grey field for most real files —
 * and an empty field reads as *this file is broken*, which is a claim about the
 * user's data rather than about the viewer.
 *
 * The bounding **sphere** rather than the box, because the camera can be at any
 * angle to a box and the sphere is the only radius that is true from all of
 * them. `radius / sin(fov/2)` is the distance at which the sphere exactly fills
 * the vertical field; a portrait window is narrower horizontally than
 * vertically, so the margin is widened by the aspect there or the model is cut
 * off at the sides.
 *
 * **Near and far are derived, never constants**, and that is the non-obvious
 * half. Leave near at 0.1 for a 40,000-unit model and the depth buffer has no
 * precision left to spend: surfaces tear through each other as it turns, which
 * looks like broken geometry. Leave far at 1000 for a model 4,000 units away and
 * it is simply never drawn.
 */
export function frameFor(
  object: Object3D,
  fovDegrees: number,
  aspect: number,
  direction: Vector3 = presetDirection("fit"),
): Framing {
  const sphere = boundsOf(object);
  const radius = sphere.radius;

  const fov = (fovDegrees * Math.PI) / 180;
  const fit = radius / Math.sin(fov / 2);
  const dist = fit * (aspect < 1 ? MARGIN / aspect : MARGIN);

  // Which side the camera looks from is the caller's (item A2); how far away
  // it has to be is not, and does not depend on the side.
  const dir = direction.clone().normalize();
  return {
    position: sphere.center.clone().addScaledVector(dir, dist),
    target: sphere.center.clone(),
    near: Math.max(radius / 1000, 1e-4),
    far: dist + radius * 4,
    center: sphere.center.clone(),
    radius,
  };
}

/**
 * The bounding sphere `frameFor` and `orthoFrameFor` both start from.
 *
 * An empty scene gets a unit sphere at the origin, and a single-point model a
 * radius of one millionth rather than zero — every division downstream of a
 * zero radius is an infinity that reaches the camera matrix as NaN, and a NaN
 * camera draws nothing at all, forever, with no error.
 */
export function boundsOf(object: Object3D): Sphere {
  const box = new Box3().setFromObject(object);
  const sphere = box.isEmpty() ? new Sphere(new Vector3(), 1) : box.getBoundingSphere(new Sphere());
  sphere.radius = Math.max(sphere.radius, 1e-6);
  return sphere;
}

// ── View presets (item A2) ────────────────────────────────────────────────

/** The named camera positions on the side panel and the number keys. */
export type ViewPreset = "front" | "back" | "left" | "right" | "top" | "bottom" | "iso" | "fit";

export const VIEW_PRESETS: readonly ViewPreset[] = ["front", "back", "left", "right", "top", "bottom", "iso", "fit"];

/**
 * Which way the camera looks *from*, as a unit vector out of the model.
 *
 * World space, and always Y-up, because by the time a camera sees the model the
 * stand has already turned a Z-up file upright. "Front" is therefore the front
 * of what is on screen — which is what someone pressing 1 means — and not the
 * file's own −Y, which for a Z-up part would be its underside.
 *
 * **Top and bottom are a thousandth of a radian off the pole**, and that is not
 * sloppiness. Looking exactly down the up axis, `lookAt` has no way to decide
 * which way the picture is turned — the cross product it builds the camera's
 * right vector from is zero — so three picks one by numerical accident, and the
 * orbit controls, which clamp at the pole, then flip the model half a turn on
 * the first drag. Nudged towards +Z, the top view comes out with the front at
 * the bottom of the screen, the way a plan drawing is laid out.
 *
 * `fit` is the three-quarter view the viewer opens on. Straight down an axis is
 * the one angle from which a box and a cube look identical, so the default is
 * deliberately not one.
 */
export function presetDirection(view: ViewPreset): Vector3 {
  const POLE = 1e-3;
  switch (view) {
    case "front": return new Vector3(0, 0, 1);
    case "back": return new Vector3(0, 0, -1);
    case "left": return new Vector3(-1, 0, 0);
    case "right": return new Vector3(1, 0, 0);
    case "top": return new Vector3(0, 1, POLE).normalize();
    case "bottom": return new Vector3(0, -1, POLE).normalize();
    case "iso": return new Vector3(1, 1, 1).normalize();
    case "fit": return new Vector3(0.7, 0.5, 1).normalize();
  }
}

// ── Orthographic framing (item A3) ────────────────────────────────────────

/** A framing for an orthographic camera: the box it sees as well as where it sits. */
export interface OrthoFraming extends Framing {
  /** Half the frustum's height and width, in world units, at zoom 1. */
  halfHeight: number;
  halfWidth: number;
}

/**
 * How far back the orthographic camera sits, in radii.
 *
 * Distance does not change the picture in an orthographic projection — that is
 * the whole point of one — so this only has to put the camera clear of the
 * model with room for the near plane between them. It matters for one reason:
 * the orbit controls turn the camera about the target at this distance, and the
 * gizmo animates along the same sphere.
 */
export const ORTHO_DISTANCE = 4;

/**
 * The orthographic counterpart of `frameFor`.
 *
 * The perspective framing gets the model on screen by *distance*; an
 * orthographic camera ignores distance and gets it on screen by the *size of its
 * box*. So the arithmetic is simpler and the failure is the same one: a fixed
 * ±1 box shows a 2 mm screw as a single pixel and a building as one texel of
 * wall. Half the height is the radius with the same margin, widened for a
 * portrait window exactly as `frameFor` widens its distance.
 *
 * **Near and far still scale with the model**, even though depth precision in
 * an orthographic projection is spread evenly rather than crowded at the near
 * plane: a far plane at a constant 1000 still drops a building 4,000 units away.
 */
export function orthoFrameFor(
  object: Object3D,
  aspect: number,
  direction: Vector3 = presetDirection("fit"),
): OrthoFraming {
  const sphere = boundsOf(object);
  const radius = sphere.radius;
  const halfHeight = radius * (aspect < 1 ? MARGIN / aspect : MARGIN);
  const dist = radius * ORTHO_DISTANCE;
  const dir = direction.clone().normalize();
  return {
    position: sphere.center.clone().addScaledVector(dir, dist),
    target: sphere.center.clone(),
    // The model's nearest point is `dist - radius` away. Near sits a radius in
    // front of that, so a model turned or panned a little does not clip.
    near: Math.max(dist - radius * 2, 1e-7),
    far: dist + radius * 4,
    center: sphere.center.clone(),
    radius,
    halfHeight,
    halfWidth: halfHeight * aspect,
  };
}

/**
 * The orthographic zoom that shows what a perspective camera was showing.
 *
 * Switching projection should not make the model leap to a different size — it
 * is a question about the drawing, not a request to re-frame. A perspective
 * camera `distance` from its target sees a slice `2·d·tan(fov/2)` tall through
 * that target, and the orthographic box is `2·halfHeight` tall at zoom 1, so
 * their ratio is the zoom that keeps the target plane the same size on screen.
 */
export function orthoZoomFor(distance: number, fovDegrees: number, halfHeight: number): number {
  const seen = distance * Math.tan((fovDegrees * Math.PI) / 360);
  return seen > 0 && Number.isFinite(seen) ? halfHeight / seen : 1;
}

// ── Edges (item A5) ───────────────────────────────────────────────────────

/**
 * The crease angle, in degrees, above which a shared edge is drawn.
 *
 * Wireframe draws every triangle, so it shows how a mesh was *tessellated* —
 * the exporter's business. Edges draw only where the surface actually turns —
 * the shape's. Thirty degrees keeps a cylinder's facets quiet and a box's
 * corners loud, and it is on a slider because a scan with no hard edges at all
 * needs it lower.
 */
export const EDGE_ANGLE = 30;

/** The lines drawn over a model in edges mode, and the mesh each one follows. */
export interface EdgeOverlay {
  group: Group;
  pairs: Array<[Mesh, LineSegments]>;
}

/**
 * Build the edge lines for every mesh under `root`.
 *
 * **They are never children of the model.** The model is what the edit panel
 * exports, and an exporter walks the whole tree — lines hung under a mesh would
 * be written into the saved GLB as a second object nobody asked for. So the
 * overlay is its own group, and each line copies its mesh's world matrix before
 * a frame is drawn (`syncEdges`), which also means the lines follow the edit
 * panel's moves without being rebuilt.
 *
 * A skinned or morphing mesh is the one case this does not follow: its creases
 * come from the bind pose, because recomputing them every frame would cost more
 * than the animation does.
 */
export function buildEdges(root: Object3D, angleDegrees: number, colour: number): EdgeOverlay {
  const group = new Group();
  group.name = "facet-edges";
  const pairs: Array<[Mesh, LineSegments]> = [];
  // One material for the lot: they are all the same colour, and a thousand-part
  // assembly would otherwise compile and hold a thousand identical programs.
  const material = new LineBasicMaterial({ color: colour });
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (!(o instanceof Mesh)) return;
    const geometry = o.geometry as BufferGeometry;
    if (!geometry.getAttribute("position")) return;
    const line = new LineSegments(new EdgesGeometry(geometry, angleDegrees), material);
    // Placed by hand from the mesh every frame, so three must not recompute it
    // from a position and rotation this object does not have.
    line.matrixAutoUpdate = false;
    line.matrixWorldAutoUpdate = false;
    line.matrixWorld.copy(o.matrixWorld);
    group.add(line);
    pairs.push([o, line]);
  });
  if (pairs.length === 0) material.dispose();
  return { group, pairs };
}

/** Put each edge line where its mesh is now. One matrix copy per mesh. */
export function syncEdges(overlay: EdgeOverlay): void {
  for (const [mesh, line] of overlay.pairs) {
    line.matrixWorld.copy(mesh.matrixWorld);
    line.visible = mesh.visible;
  }
}

/** How many line segments an overlay draws. */
export function edgeCount(overlay: EdgeOverlay): number {
  let n = 0;
  for (const [, line] of overlay.pairs) n += line.geometry.getAttribute("position").count / 2;
  return n;
}

export function disposeEdges(overlay: EdgeOverlay): void {
  const shared = new Set<Material>();
  for (const [, line] of overlay.pairs) {
    line.geometry.dispose();
    for (const m of materials(line.material)) shared.add(m);
  }
  for (const m of shared) m.dispose();
  overlay.group.clear();
  overlay.pairs.length = 0;
}

// ── Light and shadow (items A8, A9) ───────────────────────────────────────

/**
 * Where the key light stands, from the two angles on the panel.
 *
 * `azimuth` walks it round the model — 0° is in front (+Z), 90° on the right
 * (+X) — and `elevation` lifts it, 0° level with the centre and 90° overhead.
 * The distance scales with the model for the reason every other number here
 * does: a shadow camera sized for a mug cuts a building's shadow off at the
 * knee.
 */
export function keyLightPosition(
  center: Vector3,
  radius: number,
  azimuthDegrees: number,
  elevationDegrees: number,
): Vector3 {
  const az = (azimuthDegrees * Math.PI) / 180;
  const el = (elevationDegrees * Math.PI) / 180;
  const dist = radius * 4;
  return new Vector3(
    center.x + dist * Math.cos(el) * Math.sin(az),
    center.y + dist * Math.sin(el),
    center.z + dist * Math.cos(el) * Math.cos(az),
  );
}

/**
 * The invisible floor that catches the model's shadow (item A8).
 *
 * `ShadowMaterial` draws nothing but the shadow, so the floor takes on whatever
 * background is behind it — the whole reason for it over a grey plane, which
 * would clash with four of the five backgrounds. It lies at the model's lowest
 * point rather than at the grid's, so the shadow touches the thing casting it;
 * a shadow a radius below a model reads as the model floating.
 */
export function buildShadowFloor(center: Vector3, radius: number, floorY: number): Mesh {
  const floor = new Mesh(
    new PlaneGeometry(radius * 8, radius * 8),
    new ShadowMaterial({ opacity: 0.32, depthWrite: false }),
  );
  floor.name = "facet-shadow-floor";
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(center.x, floorY, center.z);
  floor.receiveShadow = true;
  floor.updateMatrixWorld(true);
  return floor;
}

// ── Screenshots (item A12) ────────────────────────────────────────────────

/**
 * `C:/parts/bracket.stl`, shot 3 → `C:/parts/bracket-screenshot-3.png`.
 *
 * Numbered rather than time-stamped, because someone looking for the picture
 * they just took sorts by name. The first free number is found by asking the
 * writer and being refused (see the viewer), so this only spells a name and
 * never needs to know what is on disk. A dot in a *folder* name is not an
 * extension, which is the mistake a bare `lastIndexOf(".")` makes.
 */
export function screenshotPath(modelPath: string, n: number): string {
  const sep = Math.max(modelPath.lastIndexOf("/"), modelPath.lastIndexOf("\\"));
  const dot = modelPath.lastIndexOf(".");
  const stem = dot > sep + 1 ? modelPath.slice(0, dot) : modelPath;
  return `${stem}-screenshot-${n}.png`;
}

/**
 * The pixel ratio a screenshot is drawn at, kept inside what the GPU can hold.
 *
 * 4× of a 2560-pixel window is a 10,240-pixel canvas — over the texture limit
 * of most integrated GPUs — and asking anyway gives a black image or a lost
 * context. Scaled down to fit instead, so "4×" on a big window means "as large
 * as this machine can draw", which is what the button was for.
 */
export function screenshotScale(requested: number, cssWidth: number, cssHeight: number, maxPixels: number): number {
  const longest = Math.max(1, cssWidth, cssHeight);
  return Math.max(0.1, Math.min(requested, maxPixels / longest));
}

/**
 * A grid the size of the model, not a fixed one.
 *
 * A 10×10 default grid under a 4,000-unit building is an invisible speck, and
 * under a 2 mm screw it is a wall. Sizing it to the bounding sphere is what
 * makes it a sense of scale rather than decoration.
 */
export function buildGrid(center: Vector3, radius: number): GridHelper {
  const span = radius * 4;
  const grid = new GridHelper(span, 20, 0x6c7686, 0x39404d);
  grid.position.set(center.x, center.y - radius, center.z);
  for (const m of materials(grid.material as Material | Material[])) {
    m.transparent = true;
    m.opacity = 0.45;
    // Off, so the grid never hides a face of the model that happens to be
    // coplanar with it — which for a printed part sitting on its bed is most of
    // the underside.
    m.depthWrite = false;
  }
  return grid;
}

/** Model dimensions, rounded to something a human reads. */
export function dims(size: Vector3): string {
  const n = (v: number): string =>
    v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toPrecision(3);
  return `${n(size.x)} × ${n(size.y)} × ${n(size.z)}`;
}

export function materials(m: Material | Material[]): Material[] {
  return Array.isArray(m) ? m : [m];
}

/**
 * Hand back every GPU buffer under an object.
 *
 * three keeps geometries, materials and textures alive on the GPU until it is
 * told otherwise; dropping the JavaScript reference frees nothing. Without this,
 * a session spent flicking through a folder of models climbs until the driver
 * starts refusing allocations, and that surfaces as a blank canvas that nobody
 * would trace back to here.
 */
export function disposeTree(root: Object3D): void {
  root.traverse((o) => {
    (o as Partial<Mesh>).geometry?.dispose();
    const m = (o as Partial<Mesh>).material;
    if (m) disposeMaterial(m);
  });
}

export function disposeMaterial(m: Material | Material[]): void {
  for (const one of materials(m)) {
    // Textures are separate GPU objects and are *not* freed by disposing the
    // material that references them — a glTF with a 4K basecolour, normal and
    // roughness map leaks three of them per model otherwise. There is no list of
    // which slots a given material type uses, so every property is checked.
    for (const value of Object.values(one as unknown as Record<string, unknown>)) {
      if (value instanceof Texture) value.dispose();
    }
    one.dispose();
  }
}
