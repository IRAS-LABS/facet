/**
 * The 3D viewer (item 13) — glTF/GLB, OBJ, STL and PLY, with orbit, materials
 * and wireframe.
 *
 * Four decisions shape this file, and three of them are about *not* doing the
 * obvious thing.
 *
 * **One renderer, for the life of the app.** A WebGL context is a scarce
 * resource — browsers cap them somewhere around sixteen and silently kill the
 * oldest when you ask for one too many. Creating a renderer per file opened
 * would work for the first dozen models of a session and then start blanking
 * earlier tabs and windows with no error anyone could act on. So the renderer,
 * the camera and the controls are built once and the *contents* of the scene are
 * what gets swapped. `dispose()` on unload is not an optimisation for the same
 * reason: three does not free GPU buffers when the JavaScript object becomes
 * garbage, so a session of flicking through models leaks video memory until the
 * driver complains.
 *
 * **Frames are drawn on demand, not sixty times a second.** A still model on an
 * idle render loop is a GPU held at load for a picture that is not changing —
 * on a laptop that is measurable fan noise for nothing. Every input that can
 * change the image asks for a frame; damping asks for a few more until it
 * settles.
 *
 * **The camera is placed from the model, not from a guess.** This is the whole
 * first impression and it is where naive 3D viewers fail: a model can be 0.01
 * units across or 40,000, and can sit at the origin or a mile from it — CAD and
 * GIS exports routinely do the latter. A fixed camera at (0,0,5) shows an empty
 * grey field for most real files, which reads as *the file is broken*. So the
 * bounding sphere drives the camera distance, and the near and far planes are
 * derived from its radius too: leave near at 0.1 for a 40,000-unit model and the
 * depth buffer has no precision left, which looks like the model tearing itself
 * apart as you orbit.
 *
 * **A PLY with no faces is a point cloud, and drawing it as a mesh draws
 * nothing.** Scanner and photogrammetry output is frequently vertices only. The
 * mesh path would produce an object with a bounding box and zero visible
 * surface — again, indistinguishable from a broken file.
 *
 * What this file deliberately does not do is decide *what a file is*; that is
 * `@core/model3d/formats`, which is DOM-free and byte-level so the binary-STL
 * trap can be tested without shipping fixtures.
 */

import {
  AmbientLight,
  DirectionalLight,
  GridHelper,
  Group,
  Mesh,
  Object3D,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
  type Material,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";

import { formatSize, type FileEntry } from "@core/explorer/types";
import {
  canView,
  formatLabel,
  hasOwnMaterials,
  sniff,
  SNIFF_BYTES,
  whyNot,
  type Model3DFormat,
} from "@core/model3d/formats";
import { SceneEdit } from "@ui/scene-edit";
import {
  buildDrawable,
  buildGrid,
  defaultUp,
  dims,
  disposeMaterial,
  disposeTree,
  frameFor,
  materials,
  plainMaterial,
  survey,
  type Survey,
  type UpAxis,
} from "@core/model3d/scene";

export interface SceneHost {
  fileUrl(path: string): Promise<string>;
  openExternal(path: string): Promise<void>;
  /** Where an export lands (item 6). Rejects in the browser build. */
  writeFile(path: string, bytes: Uint8Array, overwrite: boolean): Promise<string>;
}

/** What the status line says about the model currently on screen. */
interface Loaded extends Survey {
  format: Model3DFormat;
  ownMaterials: boolean;
}

/**
 * Frames to keep drawing after the last input.
 *
 * Damped orbit keeps moving after you let go, and it settles asymptotically, so
 * there is no event that means "it has stopped". A small budget of frames after
 * the last interaction covers the visible part of the settle without turning
 * this back into an always-on render loop.
 */
const SETTLE_FRAMES = 90;

export class SceneView {
  private readonly root: HTMLElement;
  private readonly canvas = document.createElement("canvas");
  private readonly title = document.createElement("div");
  private readonly status = document.createElement("div");
  private readonly note = document.createElement("div");

  /** The edit panel (item 6). Built with the view; shown on demand. */
  private readonly editor: SceneEdit;

  private renderer: WebGLRenderer | null = null;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(50, 1, 0.1, 1000);
  private controls: OrbitControls | null = null;
  private grid: GridHelper | null = null;

  /**
   * The file's own contents, exactly as its loader handed them over. Cleared and
   * disposed on load.
   *
   * This is deliberately *not* the node that gets rotated to stand the model up
   * — see `stand` below.
   */
  private model: Object3D | null = null;
  /**
   * A wrapper that carries the up-axis correction, and nothing else.
   *
   * The rotation that stands a CAD part upright is a **statement about how FACET
   * is showing the file, not about what is in it**, and the two must never be
   * confused, because item 6 exports from here. Every exporter bakes world
   * transforms — STL, OBJ and PLY have nowhere else to put them, and glTF writes
   * them as node TRS — so rotating the model itself would write the correction
   * into the saved file. Open that file again, get the correction applied a
   * second time, and a part that started upright is on its side; a third
   * round-trip has it upside down. Nothing warns you, and the original is gone.
   * The wrapper keeps the display rotation somewhere an export never looks.
   */
  private stand: Group | null = null;
  private loaded: Loaded | null = null;

  private entries: FileEntry[] = [];
  private index = 0;

  private wireframe = false;
  private showGrid = true;
  private override = false;
  private up: UpAxis = "y";

  /** Frames still owed. Zero means nothing is scheduled. */
  private owed = 0;
  private frame = 0;
  private ro: ResizeObserver | null = null;
  /**
   * Which load is current. A model on a slow disk can land after the user has
   * already pressed → twice; the token is checked before anything is added to
   * the scene, so a late arrival is dropped rather than painted over the file
   * they are actually looking at.
   */
  private seq = 0;

  constructor(private readonly host: SceneHost) {
    this.root = document.createElement("div");
    this.root.className = "sv";
    this.root.hidden = true;

    this.editor = new SceneEdit({
      // The model, never the stand — an edit is a statement about the file, and
      // the stand is a statement about the screen.
      model: () => this.model,
      path: () => this.current()?.path ?? null,
      redraw: () => this.request(2),
      reframe: () => this.frameModel(),
      writeFile: (p, b, o) => this.host.writeFile(p, b, o),
    });

    const stage = document.createElement("div");
    stage.className = "sv-stage";
    this.canvas.className = "sv-canvas";
    this.note.className = "sv-note";
    this.note.hidden = true;
    stage.append(this.canvas, this.note, this.editor.root);

    const bar = document.createElement("header");
    bar.className = "sv-bar";
    this.title.className = "sv-title";
    bar.append(
      this.btn("‹", "Previous model  (←)", () => void this.step(-1)),
      this.btn("›", "Next model  (→)", () => void this.step(1)),
      this.title,
      this.toggle("▦", "Grid  (G)", () => this.setGrid(!this.showGrid), () => this.showGrid),
      this.toggle("△", "Wireframe  (W)", () => this.setWireframe(!this.wireframe), () => this.wireframe),
      this.toggle("◐", "Plain material — ignore the file's own  (M)", () => this.setOverride(!this.override), () => this.override),
      this.toggle("↥", "Z is up  (Z)", () => this.setUp(this.up === "z" ? "y" : "z"), () => this.up === "z"),
      this.toggle("✎", "Move, turn, size, material and save-as  (E)", () => this.toggleEditor(), () => this.editor.isOpen),
      this.btn("⤢", "Frame the model  (F)", () => this.frameModel()),
      this.btn("↗", "Open in the default app", () => void this.openExternal()),
      this.btn("✕", "Close  (Esc)", () => this.close()),
    );

    this.status.className = "sv-status";

    this.root.append(bar, stage, this.status);
    document.body.appendChild(this.root);

    this.wireKeys();
  }

  /**
   * Whether the 3D viewer can take this file, for the shell's availability list
   * (item 40). Deliberately the extension test and not a byte test: the shell
   * asks this while building a *menu*, over a whole selection, and reading the
   * head of forty files to draw a right-click menu would be absurd. The bytes
   * get their say in `load`, where being wrong costs one message instead of a
   * stalled menu.
   */
  static handles(ext: string): boolean {
    return canView(ext);
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  async open(entries: FileEntry[], entry: FileEntry): Promise<void> {
    // Only the ones this viewer can actually draw, so ← and → never land on a
    // .blend and dead-end. A .blend opened *directly* still reaches here and
    // gets `whyNot`'s sentence; it just is not something you can walk onto.
    this.entries = entries.filter((e) => e.kind === "model3d" && canView(e.ext));
    if (!this.entries.some((e) => e.path === entry.path)) this.entries = [entry, ...this.entries];
    this.index = Math.max(0, this.entries.findIndex((e) => e.path === entry.path));
    this.root.hidden = false;
    this.ensureRenderer();
    await this.load();
  }

  close(): void {
    this.root.hidden = true;
    this.unload();
    this.owed = 0;
    if (this.frame) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  /** What this surface is showing, for the session record. Null when closed. */
  get openPath(): string | null {
    return this.isOpen ? (this.current()?.path ?? null) : null;
  }

  /**
   * Give the GPU everything back.
   *
   * Only for a real teardown — the shell keeps one of these for the life of the
   * window, which is the whole point of the single-renderer rule above.
   */
  destroy(): void {
    this.close();
    this.ro?.disconnect();
    this.ro = null;
    this.controls?.dispose();
    this.controls = null;
    this.renderer?.dispose();
    this.renderer = null;
    this.root.remove();
  }

  // ── The renderer, built once ────────────────────────────────────────────

  private ensureRenderer(): void {
    if (this.renderer) return;

    // `antialias` is on because a 3D model is nearly all edges and the jaggies
    // on an unantialiased mesh read as low quality in a way they do not for a
    // photo. `alpha: false` lets the theme background be painted by the clear
    // colour instead of composited every frame.
    const renderer = new WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer = renderer;

    // Two lights and no shadows. A key light alone leaves the away side of the
    // model in pure black, which looks like missing geometry; the ambient fill
    // is what makes an unlit STL readable. Shadows are the expensive, glitchy
    // part of a first 3D viewer and buy nothing for inspecting a mesh.
    const key = new DirectionalLight(0xffffff, 2.2);
    key.position.set(3, 6, 4);
    const rim = new DirectionalLight(0xffffff, 0.7);
    rim.position.set(-4, -2, -3);
    this.scene.add(key, rim, new AmbientLight(0xffffff, 0.55));

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    // Every interaction buys frames; nothing else runs the loop.
    this.controls.addEventListener("change", () => this.request(SETTLE_FRAMES));

    // A canvas has no layout opinion of its own, so the drawing buffer has to be
    // told the size of the box it sits in — and told again whenever that
    // changes, or the model stretches with the window.
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.canvas.parentElement ?? this.root);
    this.resize();
  }

  private resize(): void {
    const r = this.renderer;
    if (!r) return;
    const box = this.canvas.parentElement;
    const w = Math.max(1, box?.clientWidth ?? 1);
    const h = Math.max(1, box?.clientHeight ?? 1);
    r.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.request(1);
  }

  /** Ask for `n` more frames. Cheap to call from anywhere, including per-event. */
  private request(n: number): void {
    this.owed = Math.max(this.owed, n);
    if (this.frame) return;
    const tick = (): void => {
      this.frame = 0;
      if (this.root.hidden || !this.renderer) {
        this.owed = 0;
        return;
      }
      this.controls?.update();
      this.renderer.render(this.scene, this.camera);
      if (--this.owed > 0) this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  // ── Loading ─────────────────────────────────────────────────────────────

  private current(): FileEntry | null {
    return this.entries[this.index] ?? null;
  }

  private async step(by: number): Promise<void> {
    if (this.entries.length < 2) return;
    this.index = (this.index + by + this.entries.length) % this.entries.length;
    await this.load();
  }

  private async load(): Promise<void> {
    const entry = this.current();
    if (!entry) return;
    const token = ++this.seq;

    this.title.textContent = entry.name;
    this.unload();
    this.say(`Reading ${entry.name}…`);
    this.status.textContent = "";

    const refused = whyNot(entry.ext);
    if (refused) {
      this.say(`${refused}\n\n↗ hands it to whatever Windows opens it with.`);
      return;
    }

    let bytes: ArrayBuffer;
    try {
      const url = await this.host.fileUrl(entry.path);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      bytes = await res.arrayBuffer();
    } catch (err) {
      if (token !== this.seq) return;
      this.say(`Could not read the file.\n${message(err)}`);
      return;
    }
    if (token !== this.seq) return;

    const head = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, SNIFF_BYTES));
    const format = sniff(head, bytes.byteLength, entry.ext);
    if (!format) {
      this.say(`This does not look like a ${entry.ext.toUpperCase()} file inside.`);
      return;
    }

    let object: Object3D;
    try {
      object = await this.parse(bytes, format, entry.path);
    } catch (err) {
      if (token !== this.seq) return;
      // The loader's own message, verbatim. "Unexpected token < in JSON" is
      // ugly, but it tells whoever hits it that they downloaded an HTML error
      // page instead of a model, which no sentence of mine would have.
      this.say(`${formatLabel(format)} did not parse.\n${message(err)}`);
      return;
    }
    if (token !== this.seq) {
      disposeTree(object);
      return;
    }

    this.model = object;
    /*
     * Surveyed **before** it is mounted, and that ordering is the whole point.
     * Handing `survey` the model rather than the stand is not enough on its own:
     * `Box3.setFromObject` calls `updateWorldMatrix(true, …)` and measures every
     * vertex through `matrixWorld`, so it walks *up* past the model into the
     * stand's rotation regardless of which node it was given. Surveyed while the
     * model is still parentless, world is local, and the dimensions on the
     * status line are the file's own — they do not swap because someone pressed
     * Z, and they are the same numbers the edit panel scales and an exporter
     * writes.
     */
    this.loaded = { ...survey(object), format, ownMaterials: hasOwnMaterials(format) };
    this.stand = new Group();
    this.stand.add(object);
    this.up = defaultUp(format);
    this.applyUp();
    this.scene.add(this.stand);
    // The file's own dimensions. The panel steps its move boxes by a fraction
    // of the largest — so a nudge means the same thing for a ring and for a
    // terrain — and reports what those dimensions become once scaled, which is
    // the number someone sizing a part to print is actually editing toward.
    this.editor.attach(this.loaded.size);
    this.applyMaterialFlags();
    this.frameModel();
    this.note.hidden = true;
    this.renderStatus(entry);
  }

  /** Hand the bytes to the right loader. Each one is `parse`, never `load`. */
  private async parse(bytes: ArrayBuffer, format: Model3DFormat, path: string): Promise<Object3D> {
    switch (format) {
      case "glb":
      case "gltf": {
        // `parse` takes a resource path so a .gltf's sibling .bin and textures
        // resolve. A GLB carries its own and ignores it.
        const dir = await this.resourceDir(path);
        const loader = new GLTFLoader();
        const data: ArrayBuffer | string = format === "glb" ? bytes : new TextDecoder().decode(bytes);
        const gltf = await new Promise<{ scene: Group }>((resolve, reject) => {
          loader.parse(data, dir, (g) => resolve(g as { scene: Group }), reject);
        });
        return gltf.scene;
      }
      case "obj":
        // No .mtl. Loading one means a second fetch for a file that is usually
        // missing from a shared OBJ anyway, and a failed material fetch would
        // turn a model that renders fine into an error. It arrives as geometry
        // and the status line says so.
        return new OBJLoader().parse(new TextDecoder().decode(bytes));
      case "stl-binary":
      case "stl-ascii":
        // Never points: an STL is a list of triangles or it is not an STL.
        return buildDrawable(new STLLoader().parse(bytes), false);
      case "ply-binary":
      case "ply-ascii":
        return buildDrawable(new PLYLoader().parse(bytes), true);
    }
  }

  /** The folder a file lives in, as a URL, for glTF's sibling resources. */
  private async resourceDir(path: string): Promise<string> {
    const sep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    if (sep < 0) return "";
    const url = await this.host.fileUrl(path.slice(0, sep));
    return url.endsWith("/") ? url : `${url}/`;
  }

  private unload(): void {
    if (this.stand) {
      this.scene.remove(this.stand);
      this.stand = null;
    }
    if (this.model) {
      // The stand is a bare Group and owns no GPU memory; everything that does
      // hangs off the model.
      disposeTree(this.model);
      this.model = null;
    }
    this.loaded = null;
    this.editor.detach();
    this.setGridObject(null);
  }

  // ── Framing ─────────────────────────────────────────────────────────────

  /**
   * Put the whole model on screen. The arithmetic — and the reason there is
   * any — lives in `@core/model3d/scene`; this is the half that touches a
   * camera.
   */
  private frameModel(): void {
    if (!this.stand) return;
    // The stand, not the model: framing is about what is on screen, and on
    // screen the model is standing up.
    const f = frameFor(this.stand, this.camera.fov, this.camera.aspect);
    this.camera.near = f.near;
    this.camera.far = f.far;
    this.camera.updateProjectionMatrix();
    this.camera.position.copy(f.position);
    this.controls?.target.copy(f.target);
    this.controls?.update();

    this.setGridObject(this.showGrid ? buildGrid(f.center, f.radius) : null);
    this.request(2);
  }

  // ── Display toggles ─────────────────────────────────────────────────────

  private setWireframe(on: boolean): void {
    this.wireframe = on;
    this.applyMaterialFlags();
    this.syncToggles();
    this.request(2);
  }

  private setOverride(on: boolean): void {
    this.override = on;
    this.applyMaterialFlags();
    this.syncToggles();
    // `renderStatus` reads `override`, so without this the line that explains
    // why the model just went grey does not appear until some *other* toggle
    // happens to redraw it — the one sentence that answers "did the file export
    // wrong, or did I press something?", arriving after the question.
    this.renderStatus(this.current());
    this.request(2);
  }

  private toggleEditor(): void {
    this.editor.toggle();
    this.syncToggles();
    // The panel floats over the stage rather than taking width from it, so the
    // drawing buffer is unchanged and the model does not jump when it opens.
    this.request(1);
  }

  private setGrid(on: boolean): void {
    this.showGrid = on;
    if (!on) this.setGridObject(null);
    else this.frameModel();
    this.syncToggles();
    this.request(2);
  }

  /**
   * Which way is up.
   *
   * Not cosmetic and not guessable from the bytes. glTF *defines* Y-up; STL and
   * PLY carry no opinion at all, and the CAD and 3D-printing tools that write
   * them are overwhelmingly Z-up, so a printed part loaded without this lies on
   * its side. Defaulting per format is right most of the time and wrong often
   * enough that it has to be one keystroke to correct — which is also why it is
   * a rotation on a wrapper and never a rewrite of the geometry: pressing it
   * twice must return the exact vertices, and item 6 will export them.
   */
  private setUp(axis: UpAxis): void {
    this.up = axis;
    this.applyUp();
    this.frameModel();
    this.syncToggles();
    this.renderStatus(this.current());
  }

  private applyUp(): void {
    if (!this.stand) return;
    // On the stand, never on the model — see the field's comment. An export
    // reads the model, so this rotation must not be reachable from there.
    this.stand.rotation.set(this.up === "z" ? -Math.PI / 2 : 0, 0, 0);
    this.stand.updateMatrixWorld(true);
  }

  private setGridObject(next: GridHelper | null): void {
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.geometry.dispose();
      disposeMaterial(this.grid.material);
      this.grid = null;
    }
    if (next) {
      this.scene.add(next);
      this.grid = next;
    }
  }

  /**
   * Push the wireframe and material choices down the tree.
   *
   * The override keeps the original materials attached to the meshes rather than
   * replacing them, so turning it off restores the file's own appearance
   * exactly — a viewer that destroys what it was given cannot be trusted with
   * item 6's export.
   */
  private applyMaterialFlags(): void {
    if (!this.model) return;
    this.model.traverse((o) => {
      if (!(o instanceof Mesh)) return;
      const mesh = o as Mesh & { userData: { fctOriginal?: Material | Material[] } };
      mesh.userData.fctOriginal ??= mesh.material;
      const original = mesh.userData.fctOriginal;
      if (this.override) {
        const plain = plainMaterial(mesh.geometry);
        plain.wireframe = this.wireframe;
        mesh.material = plain;
        return;
      }
      mesh.material = original ?? mesh.material;
      for (const m of materials(mesh.material)) {
        if ("wireframe" in m) (m as Material & { wireframe: boolean }).wireframe = this.wireframe;
      }
    });
  }

  // ── Chrome ──────────────────────────────────────────────────────────────

  private renderStatus(entry: FileEntry | null): void {
    const l = this.loaded;
    if (!l || !entry) {
      this.status.textContent = "";
      return;
    }
    const bits: string[] = [formatLabel(l.format), formatSize(entry.size)];
    if (l.points) bits.push(`${l.vertices.toLocaleString()} points`);
    else bits.push(`${l.triangles.toLocaleString()} triangles`, `${l.vertices.toLocaleString()} vertices`);
    if (l.meshes > 1) bits.push(`${l.meshes} meshes`);
    bits.push(dims(l.size));
    // Say where the colour is coming from. A user looking at a grey STL and a
    // grey glTF has no way to tell which of them exported wrong, and this is
    // the one sentence that distinguishes them.
    if (this.override) bits.push("plain material");
    else if (!l.ownMaterials) bits.push(l.vertexColors ? "vertex colours" : "no materials in file");
    if (this.up === "z") bits.push("Z up");
    this.status.textContent = bits.join("  ·  ");
  }

  private say(text: string): void {
    this.note.textContent = text;
    this.note.hidden = false;
    this.status.textContent = "";
  }

  private async openExternal(): Promise<void> {
    const entry = this.current();
    if (entry) await this.host.openExternal(entry.path);
  }

  private readonly toggles: Array<[HTMLButtonElement, () => boolean]> = [];

  private syncToggles(): void {
    for (const [b, on] of this.toggles) {
      const state = on();
      b.setAttribute("aria-pressed", state ? "true" : "false");
      if (state) b.dataset["on"] = "1";
      else delete b.dataset["on"];
    }
  }

  private btn(glyph: string, tip: string, run: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.className = "sv-btn";
    b.type = "button";
    b.textContent = glyph;
    b.title = tip;
    b.setAttribute("aria-label", tip);
    b.addEventListener("click", run);
    return b;
  }

  private toggle(glyph: string, tip: string, run: () => void, on: () => boolean): HTMLButtonElement {
    const b = this.btn(glyph, tip, run);
    this.toggles.push([b, on]);
    b.setAttribute("aria-pressed", on() ? "true" : "false");
    if (on()) b.dataset["on"] = "1";
    return b;
  }

  private wireKeys(): void {
    window.addEventListener("keydown", (e) => {
      if (!this.isOpen) return;
      // A modifier means the shortcut belongs to the shell, not to this surface.
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      // Someone typing in the edit panel is typing, not pressing shortcuts. Not
      // theoretical: a number box takes `e` for exponents and `-` for sign, so
      // without this, typing a negative rotation would open and close the very
      // panel being typed into.
      if (e.target instanceof HTMLElement && isTyping(e.target)) return;
      switch (e.key) {
        // Escape peels one layer at a time. Closing the whole viewer because a
        // panel was open is how you lose the model you were reading.
        case "Escape": if (this.editor.isOpen) this.editor.close(); else this.close(); break;
        case "e": case "E": this.toggleEditor(); break;
        case "ArrowLeft": void this.step(-1); break;
        case "ArrowRight": void this.step(1); break;
        case "f": case "F": this.frameModel(); break;
        case "w": case "W": this.setWireframe(!this.wireframe); break;
        case "g": case "G": this.setGrid(!this.showGrid); break;
        case "m": case "M": this.setOverride(!this.override); break;
        case "z": case "Z": this.setUp(this.up === "z" ? "y" : "z"); break;
        default: return;
      }
      e.preventDefault();
      e.stopPropagation();
    }, true);
  }
}
// ── Module helpers ────────────────────────────────────────────────────────
//
// Only the two that are genuinely about this screen. Everything else that was
// here — framing, surveying, disposal, the grid — is `@core/model3d/scene`,
// because none of it needs a GPU and the harness can only reach it there.

function message(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Unknown error.";
}

/**
 * Is this element one that keystrokes belong to?
 *
 * A range slider is excluded on purpose: the arrow keys are how you nudge one,
 * and it has no text to type, so treating it as a text field would take away
 * the letters without giving anything back.
 */
function isTyping(el: HTMLElement): boolean {
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  return el instanceof HTMLInputElement && el.type !== "range" && el.type !== "checkbox";
}
