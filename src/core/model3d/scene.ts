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
  GridHelper,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Points,
  PointsMaterial,
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
 * This is a *default*, not a fact, which is why the viewer puts it on a key.
 */
export function defaultUp(format: Model3DFormat): UpAxis {
  return format.startsWith("stl") || format.startsWith("ply") ? "z" : "y";
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
  root.traverse((o) => {
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
  return { meshes, triangles, vertices, size, points, vertexColors };
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
export function frameFor(object: Object3D, fovDegrees: number, aspect: number): Framing {
  const box = new Box3().setFromObject(object);
  const sphere = box.isEmpty()
    ? new Sphere(new Vector3(), 1)
    : box.getBoundingSphere(new Sphere());
  // A single-point model has radius zero, and every division below it would be
  // an infinity that propagates into the camera matrix as NaN.
  const radius = Math.max(sphere.radius, 1e-6);

  const fov = (fovDegrees * Math.PI) / 180;
  const fit = radius / Math.sin(fov / 2);
  const dist = fit * (aspect < 1 ? MARGIN / aspect : MARGIN);

  // Three-quarter view. Straight down an axis is the one angle from which a box
  // and a cube look identical, so the default is deliberately not one.
  const dir = new Vector3(0.7, 0.5, 1).normalize();
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
