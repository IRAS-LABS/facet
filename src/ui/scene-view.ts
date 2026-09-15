/**
 * The 3D viewer (item 13) — glTF/GLB, OBJ, STL, PLY, 3MF and COLLADA, with
 * orbit, materials, lighting, views, animation and capture.
 *
 * Four decisions shape this file, and three of them are about *not* doing the
 * obvious thing.
 *
 * **One renderer, for the life of the app.** A WebGL context is a scarce
 * resource — browsers cap them somewhere around sixteen and silently kill the
 * oldest when you ask for one too many. Creating a renderer per file opened
 * would work for the first dozen models of a session and then start blanking
 * earlier tabs and windows with no error anyone could act on. So the renderer,
 * the cameras and the controls are built once and the *contents* of the scene
 * are what gets swapped. `dispose()` on unload is not an optimisation for the
 * same reason: three does not free GPU buffers when the JavaScript object
 * becomes garbage, so a session of flicking through models leaks video memory
 * until the driver complains. That goes for everything this file adds on top of
 * the model, too — the environment map, the edge lines, the shadow floor, the
 * animation mixer — each has an owner here and a line that gives it back.
 *
 * **Frames are drawn on demand, not sixty times a second.** A still model on an
 * idle render loop is a GPU held at load for a picture that is not changing —
 * on a laptop that is measurable fan noise for nothing. Every input that can
 * change the image asks for a frame; damping asks for a few more until it
 * settles. Only three things draw continuously, and only while they are
 * actually happening: the turntable, a playing animation, and the gizmo's
 * swing to a new view (see `continuous`).
 *
 * **The camera is placed from the model, not from a guess.** This is the whole
 * first impression and it is where naive 3D viewers fail: a model can be 0.01
 * units across or 40,000, and can sit at the origin or a mile from it — CAD and
 * GIS exports routinely do the latter. A fixed camera at (0,0,5) shows an empty
 * grey field for most real files, which reads as *the file is broken*. So the
 * bounding sphere drives the camera distance, and the near and far planes are
 * derived from its radius too: leave near at 0.1 for a 40,000-unit model and the
 * depth buffer has no precision left, which looks like the model tearing itself
 * apart as you orbit. The same holds for the orthographic camera, the key
 * light's shadow box and the floor the shadow falls on.
 *
 * **A PLY with no faces is a point cloud, and drawing it as a mesh draws
 * nothing.** Scanner and photogrammetry output is frequently vertices only. The
 * mesh path would produce an object with a bounding box and zero visible
 * surface — again, indistinguishable from a broken file.
 *
 * What this file deliberately does not do is decide *what a file is*, or any of
 * the arithmetic behind the camera, the edges, the playhead or the screenshot
 * names; those are `@core/model3d/*`, DOM-free so the harness can reach them.
 * This is the half that touches a GPU and a page.
 *
 * The controls live in a side panel that starts closed, so the bar keeps to the
 * handful of things someone flicking through a folder presses. Below about
 * 520 px of stage the view goes compact: the bar drops to essentials, the panel
 * becomes an overlay rather than a column that would leave no model to look at,
 * and the gizmo steps aside.
 */

import {
  ACESFilmicToneMapping,
  AgXToneMapping,
  AmbientLight,
  AnimationMixer,
  Box3,
  Box3Helper,
  CanvasTexture,
  Color,
  DirectionalLight,
  GridHelper,
  Group,
  LoopRepeat,
  Mesh,
  NeutralToneMapping,
  NoToneMapping,
  Object3D,
  OrthographicCamera,
  PCFShadowMap,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
  type AnimationAction,
  type AnimationClip,
  type Camera,
  type Material,
  type ToneMapping,
  type WebGLRenderTarget,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { ViewHelper } from "three/examples/jsm/helpers/ViewHelper.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { ThreeMFLoader } from "three/examples/jsm/loaders/3MFLoader.js";
import { ColladaLoader } from "three/examples/jsm/loaders/ColladaLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";

import { formatSize, type FileEntry } from "@core/explorer/types";
import {
  advance,
  clock,
  pause,
  play,
  playhead,
  poseTime,
  progress,
  scrub,
  SPEEDS,
  withLoop,
  withSpeed,
  type Playhead,
} from "@core/model3d/anim";
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
  readScenePrefs,
  writeScenePref,
  type BackgroundName,
  type ScenePrefs,
  type ToneMapName,
} from "@core/model3d/prefs";
import {
  buildDrawable,
  buildEdges,
  buildGrid,
  buildShadowFloor,
  defaultUp,
  dims,
  disposeEdges,
  disposeMaterial,
  disposeTree,
  EDGE_ANGLE,
  frameFor,
  keyLightPosition,
  materials,
  ORTHO_DISTANCE,
  orthoFrameFor,
  orthoZoomFor,
  plainMaterial,
  presetDirection,
  screenshotPath,
  screenshotScale,
  survey,
  syncEdges,
  type EdgeOverlay,
  type Survey,
  type UpAxis,
  type ViewPreset,
} from "@core/model3d/scene";
import { settings, type SettingsStore } from "@core/settings/store";
import { SceneEdit } from "@ui/scene-edit";

export interface SceneHost {
  fileUrl(path: string): Promise<string>;
  openExternal(path: string): Promise<void>;
  /** Read a model back whole, to keep as the backup an overwrite leaves behind. */
  readAll(path: string, max: number): Promise<Uint8Array>;
  /** Where an export lands (item 6). Rejects in the browser build. */
  writeFile(path: string, bytes: Uint8Array, overwrite: boolean): Promise<string>;
  /**
   * Where the panel's preferences are remembered (item A19). The app's own
   * settings when absent; the harness hands in a memory store so a test run
   * does not leave its toggles behind in the next real session.
   */
  prefs?: SettingsStore;
}

/** What the status line says about the model currently on screen. */
interface Loaded extends Survey {
  format: Model3DFormat;
  ownMaterials: boolean;
}

type RenderMode = "shaded" | "wireframe" | "edges";
type Projection = "perspective" | "orthographic";

/**
 * Frames to keep drawing after the last input.
 *
 * Damped orbit keeps moving after you let go, and it settles asymptotically, so
 * there is no event that means "it has stopped". A small budget of frames after
 * the last interaction covers the visible part of the settle without turning
 * this back into an always-on render loop.
 */
const SETTLE_FRAMES = 90;

/** Below this stage width the view goes compact. See the header. */
const COMPACT_WIDTH = 520;

/** The gizmo's fixed size in three's ViewHelper, and its gap from the corner. */
const GIZMO_SIZE = 128;
const GIZMO_GAP = 12;

/**
 * The lamps' starting positions and strengths, kept close to the two-light rig
 * this viewer had before the panel existed: a key up and to the front-right, a
 * weaker rim from behind and below so the away side is never pure black.
 */
const KEY_AZIMUTH = 35;
const KEY_ELEVATION = 50;
const KEY_STRENGTH = 2;
const AMBIENT_STRENGTH = 0.35;
const ENV_STRENGTH = 0.8;

const TONE: Readonly<Record<ToneMapName, ToneMapping>> = {
  neutral: NeutralToneMapping,
  aces: ACESFilmicToneMapping,
  agx: AgXToneMapping,
  none: NoToneMapping,
};

const STUDIO_GREY = 0x3c3f45;
const EDGE_COLOUR = 0x101318;

/** Where three's example decoders were copied to; see THIRD-PARTY-NOTICES. */
const DECODERS = `${import.meta.env.BASE_URL}decoders/`;

export class SceneView {
  private readonly root: HTMLElement;
  private readonly stage = el("div", "sv-stage");
  private readonly canvas = document.createElement("canvas");
  private readonly title = el("div", "sv-title");
  private readonly status = el("div", "sv-status");
  private readonly note = el("div", "sv-note");
  private readonly panel = el("aside", "sv-panel");
  private readonly info = el("dl", "sv-info");
  private readonly anim = el("div", "sv-anim");
  private readonly help = el("div", "sv-help");
  private readonly toast = el("div", "sv-toast");
  private readonly gizmoHit = el("div", "sv-gizmo");

  /** The edit panel (item 6). Built with the view; shown on demand. */
  private readonly editor: SceneEdit;
  private readonly prefs: SettingsStore;

  private renderer: WebGLRenderer | null = null;
  private readonly scene = new Scene();
  private readonly persp = new PerspectiveCamera(50, 1, 0.1, 1000);
  private readonly ortho = new OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
  /** Whichever of the two is drawing. The controls and the gizmo follow it. */
  private camera: PerspectiveCamera | OrthographicCamera = this.persp;
  /** The orthographic box's half-height at zoom 1, from the last framing. */
  private orthoHalf = 1;
  private controls: OrbitControls | null = null;
  private gizmo: ViewHelper | null = null;
  private grid: GridHelper | null = null;

  private readonly key = new DirectionalLight(0xffffff, KEY_STRENGTH);
  private readonly rim = new DirectionalLight(0xffffff, 0.6);
  private readonly ambient = new AmbientLight(0xffffff, AMBIENT_STRENGTH);

  /** Built the first time something needs it, then kept; see `environmentMap`. */
  private envTarget: WebGLRenderTarget | null = null;
  private gradient: CanvasTexture | null = null;
  private draco: DRACOLoader | null = null;
  private ktx2: KTX2Loader | null = null;

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

  /*
   * Everything drawn *about* the model rather than the model itself — edges,
   * the bounding box, the shadow floor. None of them is ever a child of the
   * model, for the same reason the stand is not: an export walks the model.
   */
  private edges: EdgeOverlay | null = null;
  private box: Box3Helper | null = null;
  private floor: Mesh | null = null;
  /** The bounding sphere from the last framing; the lights and floor use it. */
  private center = new Vector3();
  private radius = 1;

  private mixer: AnimationMixer | null = null;
  private clips: AnimationClip[] = [];
  private action: AnimationAction | null = null;
  private clipIndex = 0;
  private head: Playhead = playhead(0);
  private scrubbing = false;

  private entries: FileEntry[] = [];
  private index = 0;

  // Display state. The first five are remembered (see `ScenePrefs`); the rest
  // are about one look at one model and start fresh with the view.
  private look: ScenePrefs;
  private mode: RenderMode = "shaded";
  private showGrid = true;
  private override = false;
  private up: UpAxis = "y";
  private projection: Projection = "perspective";
  private edgeAngle = EDGE_ANGLE;
  private showBox = false;
  private shadow = false;
  private turntable = false;
  private envStrength = ENV_STRENGTH;
  private keyAzimuth = KEY_AZIMUTH;
  private keyElevation = KEY_ELEVATION;
  private shotScale = 1;
  private compact = false;

  /** Frames still owed. Zero means nothing is scheduled. */
  private owed = 0;
  private frame = 0;
  private last = 0;
  /**
   * True while a frame is being drawn. The controls announce every movement as
   * a `change` event, and they do it from inside the frame; without this, each
   * of those would schedule a second frame alongside the one the loop is about
   * to schedule anyway, and a damped settle would double the frames it draws on
   * every frame it draws.
   */
  private ticking = false;
  private ro: ResizeObserver | null = null;
  private toastTimer = 0;
  /**
   * Which load is current. A model on a slow disk can land after the user has
   * already pressed → twice; the token is checked before anything is added to
   * the scene, so a late arrival is dropped rather than painted over the file
   * they are actually looking at.
   */
  private seq = 0;

  constructor(private readonly host: SceneHost) {
    this.prefs = host.prefs ?? settings;
    this.look = readScenePrefs(this.prefs);

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
      readAll: (p, max) => this.host.readAll(p, max),
      writeFile: (p, b, o) => this.host.writeFile(p, b, o),
    });

    this.canvas.className = "sv-canvas";
    this.note.hidden = true;
    this.panel.hidden = true;
    this.anim.hidden = true;
    this.help.hidden = true;
    this.toast.hidden = true;
    this.toast.setAttribute("role", "status");
    this.buildPanel();
    this.buildAnimBar();
    this.buildHelp();
    this.gizmoHit.title = "Click an axis to look along it";
    this.gizmoHit.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.gizmoHit.addEventListener("click", (e) => this.gizmoClick(e));
    this.stage.append(
      this.canvas, this.note, this.gizmoHit, this.panel, this.anim, this.editor.root, this.help, this.toast,
    );

    const bar = el("header", "sv-bar");
    this.title.textContent = "";
    bar.append(
      this.toggle("☰", "Display, lighting and capture  (P)", () => this.setPanel(this.panel.hidden), () => !this.panel.hidden),
      this.btn("‹", "Previous model  (←)", () => void this.step(-1)),
      this.btn("›", "Next model  (→)", () => void this.step(1)),
      this.title,
      optional(this.toggle("▦", "Grid  (G)", () => this.setGrid(!this.showGrid), () => this.showGrid)),
      optional(this.toggle("△", "Wireframe  (W)", () => this.setMode(this.mode === "wireframe" ? "shaded" : "wireframe"), () => this.mode === "wireframe")),
      optional(this.toggle("◐", "Plain material — ignore the file's own  (M)", () => this.setOverride(!this.override), () => this.override)),
      optional(this.toggle("↥", "Z is up  (Z)", () => this.setUp(this.up === "z" ? "y" : "z"), () => this.up === "z")),
      optional(this.toggle("✎", "Move, turn, size, material and save-as  (E)", () => this.toggleEditor(), () => this.editor.isOpen)),
      this.btn("⤢", "Frame the model  (F)", () => this.setView("fit")),
      optional(this.btn("↗", "Open in the default app", () => void this.openExternal())),
      optional(this.btn("?", "Keyboard shortcuts  (?)", () => this.setHelp(this.help.hidden))),
      this.btn("✕", "Close  (Esc)", () => this.close()),
    );

    this.root.append(bar, this.stage, this.status);
    document.body.appendChild(this.root);

    // Lights exist before a renderer does; they are plain scene objects. The
    // key light's target is added too, or it aims at wherever the origin is
    // rather than at the model.
    this.scene.add(this.key, this.key.target, this.rim, this.ambient);
    this.placeLights();

    this.wireKeys();
    this.sync();
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
    const wasOpen = this.isOpen;
    this.root.hidden = false;
    this.ensureRenderer();
    this.resize();
    if (!wasOpen) {
      // The remembered panel state applies only where the panel is a column
      // beside the model. As an overlay it would hide the thing just opened.
      this.panel.hidden = !(this.look.panelOpen && !this.compact);
      this.applyLook();
      this.sync();
    }
    await this.load();
  }

  close(): void {
    this.root.hidden = true;
    this.unload();
    this.setHelp(false);
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
    window.clearTimeout(this.toastTimer);
    this.ro?.disconnect();
    this.ro = null;
    this.controls?.dispose();
    this.controls = null;
    this.gizmo?.dispose();
    this.gizmo = null;
    this.envTarget?.dispose();
    this.envTarget = null;
    this.scene.environment = null;
    this.scene.background = null;
    this.gradient?.dispose();
    this.gradient = null;
    // The shadow map is a render target the light owns, allocated the first
    // time a shadow was drawn.
    this.key.dispose();
    this.rim.dispose();
    // Both decoders hold workers, which outlive everything else if not ended.
    this.draco?.dispose();
    this.draco = null;
    this.ktx2?.dispose();
    this.ktx2 = null;
    this.renderer?.dispose();
    this.renderer = null;
    this.root.remove();
  }

  // ── The renderer, built once ────────────────────────────────────────────

  private ensureRenderer(): void {
    if (this.renderer) return;

    // `antialias` is on because a 3D model is nearly all edges and the jaggies
    // on an unantialiased mesh read as low quality in a way they do not for a
    // photo. `alpha: false` lets the background be painted by the clear colour
    // instead of composited every frame.
    const renderer = new WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // Enabled once and left on. Whether anything is *drawn* into the shadow map
    // is the key light's `castShadow`, which three folds into its program cache
    // key, so turning shadows on and off recompiles what it must by itself —
    // flipping `shadowMap.enabled` at runtime would not.
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFShadowMap;
    this.renderer = renderer;

    this.key.shadow.mapSize.set(2048, 2048);
    this.key.shadow.radius = 4;

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    // Every interaction buys frames; nothing else runs the loop.
    this.controls.addEventListener("change", () => this.request(SETTLE_FRAMES));

    this.gizmo = new ViewHelper(this.camera, this.canvas);
    this.gizmo.location.top = null;
    this.gizmo.location.right = 0;
    this.gizmo.location.left = GIZMO_GAP;
    this.gizmo.location.bottom = GIZMO_GAP;
    this.gizmo.setLabels("X", "Y", "Z");
    this.gizmo.setLabelStyle("600 22px system-ui, sans-serif", "#0b0d12", 15);
    // The gizmo's colours are its meaning — red is X — so tone mapping, which
    // the model wants, must not wash them out.
    this.gizmo.traverse((o) => {
      const m = (o as Partial<Mesh>).material;
      if (m) for (const one of materials(m)) one.toneMapped = false;
    });

    // A canvas has no layout opinion of its own, so the drawing buffer has to be
    // told the size of the box it sits in — and told again whenever that
    // changes, or the model stretches with the window.
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.stage);
    this.resize();
  }

  private resize(): void {
    const w = Math.max(1, this.stage.clientWidth);
    const h = Math.max(1, this.stage.clientHeight);
    const compact = w < COMPACT_WIDTH;
    if (compact !== this.compact) {
      this.compact = compact;
      if (compact) this.root.dataset["compact"] = "1";
      else delete this.root.dataset["compact"];
    }
    const r = this.renderer;
    if (!r) return;
    r.setSize(w, h, false);
    const aspect = w / h;
    this.persp.aspect = aspect;
    this.persp.updateProjectionMatrix();
    this.shapeOrtho(aspect);
    this.placeGizmo();
    this.request(1);
  }

  private aspect(): number {
    return Math.max(1, this.stage.clientWidth) / Math.max(1, this.stage.clientHeight);
  }

  private shapeOrtho(aspect: number): void {
    this.ortho.top = this.orthoHalf;
    this.ortho.bottom = -this.orthoHalf;
    this.ortho.left = -this.orthoHalf * aspect;
    this.ortho.right = this.orthoHalf * aspect;
    this.ortho.updateProjectionMatrix();
  }

  /** Ask for `n` more frames. Cheap to call from anywhere, including per-event. */
  private request(n: number): void {
    this.owed = Math.max(this.owed, n);
    if (this.frame || this.ticking) return;
    this.last = performance.now();
    const tick = (now: number): void => {
      this.frame = 0;
      if (this.root.hidden || !this.renderer) {
        this.owed = 0;
        return;
      }
      this.ticking = true;
      // Capped, so a frame that arrives after the window was hidden for a
      // minute does not spin the turntable through forty turns in one step.
      const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
      this.last = now;
      this.stepAnimation(dt);
      if (this.gizmo?.animating) {
        this.gizmo.update(dt);
        // The controls keep their own idea of where the camera is; once the
        // swing has landed they are told, or the next drag starts from the old
        // angle and the model jumps.
        if (!this.gizmo.animating) this.controls?.update();
      } else {
        // The delta makes `autoRotateSpeed` mean turns per minute, rather than
        // per-frame degrees that would spin twice as fast on a 120 Hz screen.
        this.controls?.update(dt);
      }
      this.draw(true);
      if (this.continuous()) this.owed = Math.max(this.owed, 2);
      this.ticking = false;
      if (--this.owed > 0) this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  /** The three reasons to keep drawing with no input. See the header. */
  private continuous(): boolean {
    return (this.turntable && !!this.stand) || this.head.playing || !!this.gizmo?.animating;
  }

  private draw(withGizmo: boolean): void {
    const r = this.renderer;
    if (!r) return;
    if (this.edges || this.box) {
      // The overlays copy the model's world matrices, so those have to be
      // current first — render would only bring them up to date afterwards.
      this.scene.updateMatrixWorld();
      if (this.edges) syncEdges(this.edges);
      if (this.box && this.stand) this.box.box.setFromObject(this.stand);
    }
    r.render(this.scene, this.camera);
    if (withGizmo && this.gizmo && this.gizmoVisible()) {
      // ViewHelper clears depth and draws into a corner viewport; with
      // `autoClear` on, its render would wipe the model first.
      r.autoClear = false;
      this.gizmo.render(r);
      r.autoClear = true;
    }
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
    this.applyCasting();
    this.setupAnimation(object);
    this.frameModel();
    this.note.hidden = true;
    this.renderStatus(entry);
    this.sync();
  }

  /** Hand the bytes to the right loader. Each one is `parse`, never `load`. */
  private async parse(bytes: ArrayBuffer, format: Model3DFormat, path: string): Promise<Object3D> {
    switch (format) {
      case "glb":
      case "gltf": {
        // `parse` takes a resource path so a .gltf's sibling .bin and textures
        // resolve. A GLB carries its own and ignores it.
        const dir = await this.resourceDir(path);
        const loader = this.gltfLoader();
        const data: ArrayBuffer | string = format === "glb" ? bytes : new TextDecoder().decode(bytes);
        const gltf = await new Promise<{ scene: Group; animations: AnimationClip[] }>((resolve, reject) => {
          loader.parse(data, dir, (g) => resolve(g), reject);
        });
        // glTF keeps its clips beside the scene rather than on it; hung on the
        // scene they travel with the model, and `survey` counts them.
        gltf.scene.animations = gltf.animations;
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
      case "3mf":
        return new ThreeMFLoader().parse(bytes);
      case "dae": {
        // COLLADA references its textures by relative path, like a .gltf.
        const dir = await this.resourceDir(path);
        const collada = new ColladaLoader().parse(new TextDecoder().decode(bytes), dir);
        if (!collada) throw new Error("No scene in this COLLADA file.");
        return collada.scene;
      }
    }
  }

  /**
   * A glTF loader that can read the three compressions real-world glTF uses.
   *
   * Draco and KTX2 decode in workers loaded from `public/decoders/` — copies of
   * three's own, shipped with the app, because the CSP allows no outside host
   * and a viewer that needs the network to open a file on disk is broken
   * offline. Both are built once: each spins up workers, and a loader per file
   * would start a new pool every time someone pressed →. Meshopt is small
   * enough to be bundled and needs no worker.
   */
  private gltfLoader(): GLTFLoader {
    const loader = new GLTFLoader();
    this.draco ??= new DRACOLoader().setDecoderPath(`${DECODERS}draco/`);
    loader.setDRACOLoader(this.draco);
    if (this.renderer) {
      // KTX2 has to ask the GPU which compressed formats it can take before it
      // can choose what to transcode to, so it needs the renderer first.
      this.ktx2 ??= new KTX2Loader().setTranscoderPath(`${DECODERS}basis/`).detectSupport(this.renderer);
      loader.setKTX2Loader(this.ktx2);
    }
    loader.setMeshoptDecoder(MeshoptDecoder);
    return loader;
  }

  /** The folder a file lives in, as a URL, for glTF's sibling resources. */
  private async resourceDir(path: string): Promise<string> {
    const sep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    if (sep < 0) return "";
    const url = await this.host.fileUrl(path.slice(0, sep));
    return url.endsWith("/") ? url : `${url}/`;
  }

  private unload(): void {
    this.teardownAnimation();
    this.setEdges(false);
    this.setBoxObject(false);
    this.setFloor(false);
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
    this.renderInfo();
    this.placeGizmo();
  }

  // ── Framing and views ───────────────────────────────────────────────────

  /**
   * Put the whole model on screen from one of the named sides. The arithmetic —
   * and the reason there is any — lives in `@core/model3d/scene`; this is the
   * half that touches a camera.
   *
   * Both cameras are framed every time, not just the one drawing, so switching
   * projection straight after a reframe has a correct box to switch to.
   */
  private frameModel(view: ViewPreset = "fit"): void {
    if (!this.stand) return;
    // The stand, not the model: framing is about what is on screen, and on
    // screen the model is standing up.
    const aspect = this.aspect();
    const dir = presetDirection(view);
    const f = frameFor(this.stand, this.persp.fov, aspect, dir);
    this.persp.near = f.near;
    this.persp.far = f.far;
    this.persp.updateProjectionMatrix();

    const o = orthoFrameFor(this.stand, aspect, dir);
    this.orthoHalf = o.halfHeight;
    this.ortho.near = o.near;
    this.ortho.far = o.far;
    this.ortho.zoom = 1;
    this.shapeOrtho(aspect);

    const chosen = this.projection === "orthographic" ? o : f;
    this.camera.position.copy(chosen.position);
    this.camera.lookAt(chosen.target);
    this.controls?.target.copy(chosen.target);
    this.controls?.update();

    this.center.copy(f.center);
    this.radius = f.radius;
    if (this.gizmo) this.gizmo.center.copy(f.center);
    this.placeLights();
    this.setGridObject(this.showGrid ? buildGrid(f.center, f.radius) : null);
    this.setBoxObject(this.showBox);
    this.setFloor(this.shadow);
    this.placeGizmo();
    this.request(2);
  }

  private setView(view: ViewPreset): void {
    this.frameModel(view);
    this.flash(`${VIEW_NAMES[view]} view`);
  }

  /**
   * Swap projection without the model leaping to a new size or angle.
   *
   * The new camera sits on the same line through the target, and its zoom (or
   * distance, going back) is chosen so the plane through the target is the same
   * size on screen — `orthoZoomFor` and its exact inverse. A switch is a question
   * about the drawing, not a request to re-frame.
   */
  private setProjection(next: Projection): void {
    if (next === this.projection) return;
    const target = this.controls?.target.clone() ?? this.center.clone();
    const from = this.camera;
    const offset = from.position.clone().sub(target);
    const dir = offset.lengthSq() > 0 ? offset.clone().normalize() : presetDirection("fit");
    const halfFov = (this.persp.fov * Math.PI) / 360;

    if (next === "orthographic") {
      const distance = offset.length();
      this.ortho.position.copy(target).addScaledVector(dir, this.radius * ORTHO_DISTANCE);
      this.ortho.zoom = orthoZoomFor(distance, this.persp.fov, this.orthoHalf);
      this.ortho.up.copy(from.up);
      this.camera = this.ortho;
    } else {
      const zoom = this.ortho.zoom > 0 ? this.ortho.zoom : 1;
      const distance = this.orthoHalf / (zoom * Math.tan(halfFov));
      this.persp.position.copy(target).addScaledVector(dir, distance);
      this.persp.far = Math.max(this.persp.far, distance + this.radius * 4);
      this.persp.updateProjectionMatrix();
      this.camera = this.persp;
    }
    this.camera.lookAt(target);
    this.shapeOrtho(this.aspect());
    this.projection = next;
    if (this.controls) {
      this.controls.object = this.camera;
      this.controls.update();
    }
    if (this.gizmo) (this.gizmo as unknown as { camera: Camera }).camera = this.camera;
    this.sync();
    this.request(2);
  }

  /**
   * Field of view, keeping the model the same size on screen.
   *
   * Narrowing the lens without moving the camera is a zoom, and zoom is already
   * the scroll wheel. What the slider is for is *how much perspective* — a
   * product shot at 25° against a wide 80° — so the camera dollies to hold the
   * target plane still while the angle changes.
   */
  private setFov(fov: number): void {
    const target = this.controls?.target ?? this.center;
    const before = (this.persp.fov * Math.PI) / 360;
    const after = (fov * Math.PI) / 360;
    const offset = this.persp.position.clone().sub(target);
    const distance = offset.length() * (Math.tan(before) / Math.tan(after));
    if (offset.lengthSq() > 0) this.persp.position.copy(target).addScaledVector(offset.normalize(), distance);
    this.persp.fov = fov;
    this.persp.far = Math.max(this.persp.far, distance + this.radius * 4);
    this.persp.updateProjectionMatrix();
    this.controls?.update();
    this.request(2);
  }

  private gizmoVisible(): boolean {
    return !this.compact && this.stage.clientHeight >= GIZMO_SIZE + 80 && !!this.stand;
  }

  /**
   * Keep the gizmo out from under the side panel. ViewHelper places itself in
   * pixels from a corner of the canvas, so the corner moves when the panel
   * opens rather than the gizmo being drawn beneath it.
   */
  private placeGizmo(): void {
    const visible = this.gizmoVisible();
    this.gizmoHit.hidden = !visible;
    const panelEdge = !this.panel.hidden && !this.compact ? this.panel.offsetLeft + this.panel.offsetWidth : 0;
    const left = panelEdge + GIZMO_GAP;
    if (this.gizmo) this.gizmo.location.left = left;
    this.gizmoHit.style.left = `${left}px`;
    this.gizmoHit.style.bottom = `${GIZMO_GAP}px`;
  }

  private gizmoClick(e: MouseEvent): void {
    if (!this.gizmo || !this.controls) return;
    this.gizmo.center.copy(this.controls.target);
    if (this.gizmo.handleClick(e)) {
      this.setTurntable(false);
      this.request(2);
    }
  }

  // ── Display ─────────────────────────────────────────────────────────────

  private setMode(mode: RenderMode): void {
    this.mode = mode;
    this.applyMaterialFlags();
    this.setEdges(mode === "edges");
    this.sync();
    this.request(2);
  }

  private setOverride(on: boolean): void {
    this.override = on;
    this.applyMaterialFlags();
    this.sync();
    // `renderStatus` reads `override`, so without this the line that explains
    // why the model just went grey does not appear until some *other* toggle
    // happens to redraw it — the one sentence that answers "did the file export
    // wrong, or did I press something?", arriving after the question.
    this.renderStatus(this.current());
    this.request(2);
  }

  private toggleEditor(): void {
    this.editor.toggle();
    // Both panels at once in a narrow window would leave no model at all.
    if (this.editor.isOpen && this.compact) this.setPanel(false);
    this.sync();
    // The panel floats over the stage rather than taking width from it, so the
    // drawing buffer is unchanged and the model does not jump when it opens.
    this.request(1);
  }

  private setGrid(on: boolean): void {
    this.showGrid = on;
    if (!on) this.setGridObject(null);
    else if (this.stand) this.setGridObject(buildGrid(this.center, this.radius));
    this.sync();
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
    // The edge lines copy world matrices, which the stand's turn just changed.
    this.frameModel();
    this.sync();
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
   * Edge lines on or off. Rebuilt rather than updated when the angle changes,
   * because `EdgesGeometry` bakes the angle into which lines exist at all.
   */
  private setEdges(on: boolean): void {
    if (this.edges) {
      this.scene.remove(this.edges.group);
      disposeEdges(this.edges);
      this.edges = null;
    }
    if (on && this.model) {
      this.edges = buildEdges(this.model, this.edgeAngle, EDGE_COLOUR);
      this.scene.add(this.edges.group);
    }
  }

  private setBoxObject(on: boolean): void {
    if (this.box) {
      this.scene.remove(this.box);
      this.box.geometry.dispose();
      disposeMaterial(this.box.material);
      this.box = null;
    }
    if (on && this.stand) {
      const accent = cssColour(this.root, "--fct-accent", "#4c8dff");
      this.box = new Box3Helper(new Box3().setFromObject(this.stand), accent);
      this.scene.add(this.box);
    }
  }

  private setFloor(on: boolean): void {
    if (this.floor) {
      this.scene.remove(this.floor);
      this.floor.geometry.dispose();
      disposeMaterial(this.floor.material);
      this.floor = null;
    }
    if (on && this.stand) {
      const lowest = new Box3().setFromObject(this.stand).min.y;
      // A hair below the lowest point, so a part resting flat on its base does
      // not z-fight with the floor it is standing on.
      this.floor = buildShadowFloor(this.center, this.radius, lowest - this.radius * 0.002);
      this.scene.add(this.floor);
    }
  }

  private setShadow(on: boolean): void {
    this.shadow = on;
    this.key.castShadow = on;
    this.applyCasting();
    this.setFloor(on);
    this.sync();
    this.request(2);
  }

  /** Meshes cast only while shadows are on; points never do. */
  private applyCasting(): void {
    this.model?.traverse((o) => {
      if (o instanceof Mesh) o.castShadow = this.shadow;
    });
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
    const wire = this.mode === "wireframe";
    this.model.traverse((o) => {
      if (!(o instanceof Mesh)) return;
      const mesh = o as Mesh & { userData: { fctOriginal?: Material | Material[] } };
      mesh.userData.fctOriginal ??= mesh.material;
      const original = mesh.userData.fctOriginal;
      if (this.override) {
        // The plain material this replaces was made for the last toggle and is
        // nobody else's; the file's own stays safe in `fctOriginal`.
        if (mesh.material !== original) disposeMaterial(mesh.material);
        const plain = plainMaterial(mesh.geometry);
        plain.wireframe = wire;
        mesh.material = plain;
        return;
      }
      if (mesh.material !== original) disposeMaterial(mesh.material);
      mesh.material = original ?? mesh.material;
      for (const m of materials(mesh.material)) {
        if ("wireframe" in m) (m as Material & { wireframe: boolean }).wireframe = wire;
      }
    });
  }

  // ── Light, tone and background ──────────────────────────────────────────

  private placeLights(): void {
    const c = this.center;
    const r = this.radius;
    this.key.position.copy(keyLightPosition(c, r, this.keyAzimuth, this.keyElevation));
    this.key.target.position.copy(c);
    this.key.target.updateMatrixWorld();
    this.rim.position.copy(keyLightPosition(c, r, this.keyAzimuth + 180, -20));
    // The shadow camera is a box around the model, scaled with it: a fixed box
    // cuts a building's shadow off at the knee and spends a screw's shadow on
    // four texels.
    const cam = this.key.shadow.camera;
    const s = r * 1.8;
    cam.left = -s;
    cam.right = s;
    cam.top = s;
    cam.bottom = -s;
    cam.near = r * 0.5;
    cam.far = r * 9;
    cam.updateProjectionMatrix();
    this.key.shadow.bias = -0.0005;
    this.key.shadow.normalBias = r * 0.004;
  }

  /** Tone map, exposure, environment and background, from `look`. */
  private applyLook(): void {
    const r = this.renderer;
    if (r) {
      r.toneMapping = TONE[this.look.toneMap];
      r.toneMappingExposure = this.look.exposure;
    }
    const env = this.look.environment || this.look.background === "environment" ? this.environmentMap() : null;
    this.scene.environment = this.look.environment ? env : null;
    this.scene.environmentIntensity = this.envStrength;
    this.scene.backgroundBlurriness = 0;
    switch (this.look.background) {
      case "theme":
        this.scene.background = cssColour(this.root, "--fct-bg", "#0b0d12");
        break;
      case "gradient":
        this.scene.background = this.gradientTexture();
        break;
      case "black":
        this.scene.background = new Color(0x000000);
        break;
      case "studio":
        this.scene.background = new Color(STUDIO_GREY);
        break;
      case "environment":
        this.scene.background = env;
        // The room is a plain box of lights; blurred, it reads as a studio
        // cove instead of as a low-polygon room.
        this.scene.backgroundBlurriness = 0.45;
        break;
    }
    this.request(2);
  }

  /**
   * The soft studio room the model is lit from, prefiltered once.
   *
   * RoomEnvironment is a scene of a few boxes and emissive panels; PMREM turns it
   * into the mip-chained cube a physical material samples for its reflections.
   * Without it, glTF's metals — which have no diffuse colour at all by
   * definition — render black under lamps alone, and that reads as a broken
   * export. Built lazily because a session of STLs never needs it, and kept for
   * the renderer's life because it costs a few hundred milliseconds to make.
   */
  private environmentMap(): WebGLRenderTarget["texture"] | null {
    const r = this.renderer;
    if (!r) return null;
    if (!this.envTarget) {
      const pmrem = new PMREMGenerator(r);
      const room = new RoomEnvironment();
      this.envTarget = pmrem.fromScene(room, 0.04);
      room.dispose();
      pmrem.dispose();
    }
    return this.envTarget.texture;
  }

  private gradientTexture(): CanvasTexture {
    if (this.gradient) return this.gradient;
    const c = document.createElement("canvas");
    c.width = 2;
    c.height = 512;
    const g = c.getContext("2d");
    if (g) {
      const fill = g.createLinearGradient(0, 0, 0, c.height);
      fill.addColorStop(0, "#26303f");
      fill.addColorStop(0.55, "#12161e");
      fill.addColorStop(1, "#07080b");
      g.fillStyle = fill;
      g.fillRect(0, 0, c.width, c.height);
    }
    this.gradient = new CanvasTexture(c);
    // Authored in sRGB like any picture; tagged so, three leaves it untouched by
    // tone mapping instead of darkening it as if it were light.
    this.gradient.colorSpace = SRGBColorSpace;
    return this.gradient;
  }

  private setLook<K extends keyof ScenePrefs>(key: K, value: ScenePrefs[K]): void {
    this.look = { ...this.look, [key]: value };
    // The panel's state is only remembered where it is a choice; see `open`.
    if (key !== "panelOpen" || !this.compact) writeScenePref(this.prefs, key, value);
    if (key === "turntableSpeed" && this.controls) this.controls.autoRotateSpeed = this.look.turntableSpeed;
    if (key !== "panelOpen" && key !== "turntableSpeed") this.applyLook();
    this.sync();
  }

  // ── Turntable ───────────────────────────────────────────────────────────

  private setTurntable(on: boolean): void {
    this.turntable = on;
    if (this.controls) {
      this.controls.autoRotate = on;
      this.controls.autoRotateSpeed = this.look.turntableSpeed;
    }
    this.sync();
    this.request(2);
  }

  // ── Animation ───────────────────────────────────────────────────────────

  /**
   * Find the clips and pose the model at the first frame of the first one.
   *
   * It starts playing, because a model with a walk cycle standing in its bind
   * pose looks like one without — but the mixer never keeps the time. The
   * playhead in `@core/model3d/anim` does, and the mixer is told "pose it here"
   * each frame; see that module for why.
   */
  private setupAnimation(model: Object3D): void {
    const seen = new Set<AnimationClip>();
    model.traverse((o) => {
      for (const clip of o.animations) seen.add(clip);
    });
    this.clips = [...seen];
    if (this.clips.length === 0) {
      this.anim.hidden = true;
      return;
    }
    this.mixer = new AnimationMixer(model);
    this.pickClip(0, true);
    this.anim.hidden = false;
  }

  private pickClip(i: number, autoplay: boolean): void {
    const clip = this.clips[i];
    if (!this.mixer || !clip) return;
    this.action?.stop();
    this.clipIndex = i;
    const action = this.mixer.clipAction(clip);
    // Always repeat on the action: the playhead decides what "once" means, and a
    // LoopOnce action would disable itself at the end and stop posing.
    action.setLoop(LoopRepeat, Infinity);
    action.play();
    this.action = action;
    const fresh = withLoop(withSpeed(playhead(clip.duration), this.head.speed), this.head.loop);
    this.head = autoplay ? play(fresh) : fresh;
    this.pose();
    this.syncAnim();
    this.request(2);
  }

  private pose(): void {
    if (!this.mixer || !this.action) return;
    this.action.time = poseTime(this.head);
    this.mixer.update(0);
  }

  private stepAnimation(dt: number): void {
    if (!this.head.playing || this.scrubbing) return;
    this.head = advance(this.head, dt);
    this.pose();
    this.syncAnim();
  }

  private setPlaying(on: boolean): void {
    if (!this.action) return;
    this.head = on ? play(this.head) : pause(this.head);
    this.pose();
    this.syncAnim();
    this.request(2);
  }

  private teardownAnimation(): void {
    if (this.mixer) {
      this.mixer.stopAllAction();
      for (const clip of this.clips) this.mixer.uncacheClip(clip);
      if (this.model) this.mixer.uncacheRoot(this.model);
    }
    this.mixer = null;
    this.action = null;
    this.clips = [];
    this.clipIndex = 0;
    this.head = withLoop(withSpeed(playhead(0), this.head.speed), this.head.loop);
    this.anim.hidden = true;
  }

  // ── Screenshot ──────────────────────────────────────────────────────────

  /**
   * Save what is on screen as a PNG beside the model (item A12).
   *
   * Drawn again at the chosen scale rather than read off the screen, so "4×" is
   * four times the pixels and not an upscale. The picture is taken in the same
   * task as the draw: a WebGL canvas keeps its pixels only until the page is
   * composited, and `toBlob` snapshots at the moment it is called. The gizmo is
   * left out — it is a control, not part of the picture.
   *
   * Never overwrites: the writer refuses a name that exists, and the next
   * number is tried, so the first free `-screenshot-N` wins without this ever
   * listing the folder.
   */
  private async screenshot(): Promise<void> {
    const entry = this.current();
    const r = this.renderer;
    if (!entry || !r || !this.stand) return;

    const w = Math.max(1, this.stage.clientWidth);
    const h = Math.max(1, this.stage.clientHeight);
    const gl = r.getContext();
    const limit = Math.min(
      8192,
      r.capabilities.maxTextureSize,
      Number(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE)) || 8192,
    );
    const base = r.getPixelRatio();
    const ratio = screenshotScale(this.shotScale * base, w, h, limit);

    let blob: Blob | null = null;
    r.setPixelRatio(ratio);
    r.setSize(w, h, false);
    try {
      this.draw(false);
      const pending = new Promise<Blob | null>((resolve) => this.canvas.toBlob(resolve, "image/png"));
      r.setPixelRatio(base);
      r.setSize(w, h, false);
      this.draw(true);
      blob = await pending;
    } finally {
      r.setPixelRatio(base);
      r.setSize(w, h, false);
      this.request(2);
    }
    if (!blob) {
      this.flash("Could not capture the picture.");
      return;
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    for (let n = 1; n <= 9999; n++) {
      try {
        const written = await this.host.writeFile(screenshotPath(entry.path, n), bytes, false);
        this.flash(`Saved ${basename(written)}`);
        return;
      } catch (err) {
        if (/already exists/i.test(message(err))) continue;
        this.flash(`Could not save the screenshot. ${message(err)}`);
        return;
      }
    }
  }

  // ── Chrome ──────────────────────────────────────────────────────────────

  private renderStatus(entry: FileEntry | null): void {
    const l = this.loaded;
    this.renderInfo();
    if (!l || !entry) {
      this.status.textContent = "";
      return;
    }
    const bits: string[] = [formatLabel(l.format), formatSize(entry.size)];
    if (l.points) bits.push(`${l.vertices.toLocaleString()} points`);
    else bits.push(`${l.triangles.toLocaleString()} triangles`, `${l.vertices.toLocaleString()} vertices`);
    bits.push(dims(l.size));
    // Say where the colour is coming from. A user looking at a grey STL and a
    // grey glTF has no way to tell which of them exported wrong, and this is
    // the one sentence that distinguishes them.
    if (this.override) bits.push("plain material");
    else if (!l.ownMaterials) bits.push(l.vertexColors ? "vertex colours" : "no materials in file");
    if (this.up === "z") bits.push("Z up");
    if (!l.points) bits.push(plural(l.meshes, "mesh", "meshes"));
    // Counted only where the file brought them: an STL's one material is the
    // stand-in this viewer made, and counting it would claim the file had one.
    if (l.ownMaterials) bits.push(plural(l.materials, "material"), plural(l.textures, "texture"));
    if (l.animations > 0) bits.push(plural(l.animations, "animation"));
    this.status.textContent = bits.join("  ·  ");
  }

  private renderInfo(): void {
    const l = this.loaded;
    this.info.replaceChildren();
    const rows: Array<[string, string]> = l
      ? [
          ["Meshes", l.meshes.toLocaleString()],
          [l.points ? "Points" : "Triangles", (l.points ? l.vertices : l.triangles).toLocaleString()],
          ["Vertices", l.vertices.toLocaleString()],
          ["Materials", l.ownMaterials ? l.materials.toLocaleString() : "none in file"],
          ["Textures", l.textures.toLocaleString()],
          ["Animations", l.animations.toLocaleString()],
          ["Size", dims(l.size)],
        ]
      : [["Model", "none loaded"]];
    for (const [k, v] of rows) this.info.append(el("dt", "", k), el("dd", "", v));
  }

  private say(text: string): void {
    this.note.textContent = text;
    this.note.hidden = false;
    this.status.textContent = "";
  }

  /** A short message that fades by itself: a view name, a saved file. */
  private flash(text: string): void {
    this.toast.textContent = text;
    this.toast.hidden = false;
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toast.hidden = true;
    }, 2200);
  }

  private async openExternal(): Promise<void> {
    const entry = this.current();
    if (entry) await this.host.openExternal(entry.path);
  }

  private setPanel(open: boolean): void {
    this.panel.hidden = !open;
    if (open && this.compact && this.editor.isOpen) this.editor.close();
    this.setLook("panelOpen", open);
    this.placeGizmo();
    this.request(2);
  }

  private setHelp(open: boolean): void {
    this.help.hidden = !open;
  }

  private readonly toggles: Array<[HTMLButtonElement, () => boolean]> = [];
  /** Everything on the panel that shows a state, refreshed together. */
  private readonly syncers: Array<() => void> = [];

  private sync(): void {
    for (const [b, on] of this.toggles) {
      const state = on();
      b.setAttribute("aria-pressed", state ? "true" : "false");
      if (state) b.dataset["on"] = "1";
      else delete b.dataset["on"];
    }
    for (const s of this.syncers) s();
    this.root.dataset["projection"] = this.projection;
    this.root.dataset["mode"] = this.mode;
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

  // ── The side panel ──────────────────────────────────────────────────────

  private buildPanel(): void {
    this.panel.setAttribute("aria-label", "3D view controls");
    const head = el("div", "sv-panel-head");
    const close = el("button", "sv-icon", "✕");
    close.type = "button";
    close.title = "Close the panel  (P)";
    close.addEventListener("click", () => this.setPanel(false));
    head.append(el("span", "sv-panel-title", "View controls"), close);
    const body = el("div", "sv-panel-body");
    this.panel.append(head, body);

    // ── View
    const presets = el("div", "sv-presets");
    for (const [view, label, keyHint] of PRESET_BUTTONS) {
      const b = el("button", "sv-chip", label);
      b.type = "button";
      b.title = keyHint ? `${VIEW_NAMES[view]} view  (${keyHint})` : `${VIEW_NAMES[view]} view`;
      b.addEventListener("click", () => this.setView(view));
      presets.append(b);
    }
    const fov = this.slider("Field of view", 20, 90, 1, () => this.persp.fov, (v) => this.setFov(v), (v) => `${Math.round(v)}°`);
    fov.classList.add("sv-fov");
    body.append(this.section("View", true, [
      this.seg<Projection>("Projection", [["perspective", "Perspective"], ["orthographic", "Orthographic"]],
        () => this.projection, (v) => this.setProjection(v)),
      fov,
      presets,
      this.switch("Turntable", "R", () => this.turntable, (v) => this.setTurntable(v)),
      this.slider("Turntable speed", 0.5, 30, 0.5, () => this.look.turntableSpeed,
        (v) => this.setLook("turntableSpeed", v), (v) => `${v} rpm`),
    ]));

    // ── Display
    const angle = this.slider("Edge angle", 1, 89, 1, () => this.edgeAngle, (v) => {
      this.edgeAngle = v;
      if (this.mode === "edges") this.setEdges(true);
      this.request(2);
    }, (v) => `${Math.round(v)}°`);
    angle.classList.add("sv-edge-angle");
    body.append(this.section("Display", true, [
      this.seg<RenderMode>("Render", [["shaded", "Shaded"], ["wireframe", "Wire"], ["edges", "Edges"]],
        () => this.mode, (v) => this.setMode(v)),
      angle,
      this.switch("Grid", "G", () => this.showGrid, (v) => this.setGrid(v)),
      this.switch("Bounding box", "B", () => this.showBox, (v) => {
        this.showBox = v;
        this.setBoxObject(v);
        this.sync();
        this.request(2);
      }),
      this.switch("Ground shadow", "", () => this.shadow, (v) => this.setShadow(v)),
      this.switch("Plain material", "M", () => this.override, (v) => this.setOverride(v)),
      this.switch("Z is up", "Z", () => this.up === "z", (v) => this.setUp(v ? "z" : "y")),
    ]));

    // ── Lighting
    body.append(this.section("Lighting", false, [
      this.select<ToneMapName>("Tone mapping",
        [["neutral", "Neutral"], ["aces", "ACES filmic"], ["agx", "AgX"], ["none", "None"]],
        () => this.look.toneMap, (v) => this.setLook("toneMap", v)),
      this.slider("Exposure", 0.2, 3, 0.05, () => this.look.exposure, (v) => this.setLook("exposure", v), (v) => `${v.toFixed(2)}×`),
      this.switch("Environment light", "", () => this.look.environment, (v) => this.setLook("environment", v)),
      this.slider("Environment strength", 0, 3, 0.05, () => this.envStrength, (v) => {
        this.envStrength = v;
        this.applyLook();
      }, (v) => v.toFixed(2)),
      this.slider("Key light angle", 0, 360, 1, () => this.keyAzimuth, (v) => {
        this.keyAzimuth = v;
        this.placeLights();
        this.request(2);
      }, (v) => `${Math.round(v)}°`),
      this.slider("Key light height", 5, 88, 1, () => this.keyElevation, (v) => {
        this.keyElevation = v;
        this.placeLights();
        this.request(2);
      }, (v) => `${Math.round(v)}°`),
      this.slider("Key light strength", 0, 6, 0.05, () => this.key.intensity, (v) => {
        this.key.intensity = v;
        this.request(2);
      }, (v) => v.toFixed(2)),
      this.slider("Ambient", 0, 2, 0.05, () => this.ambient.intensity, (v) => {
        this.ambient.intensity = v;
        this.request(2);
      }, (v) => v.toFixed(2)),
    ]));

    // ── Background
    const swatches = el("div", "sv-swatches");
    for (const [name, label] of BACKGROUND_SWATCHES) {
      const b = el("button", "sv-swatch");
      b.type = "button";
      b.title = label;
      b.dataset["bg"] = name;
      b.append(el("span", "sv-swatch-chip"), el("span", "sv-swatch-name", label));
      b.addEventListener("click", () => this.setLook("background", name));
      this.syncers.push(() => {
        if (this.look.background === name) b.dataset["on"] = "1";
        else delete b.dataset["on"];
        b.setAttribute("aria-pressed", this.look.background === name ? "true" : "false");
      });
      swatches.append(b);
    }
    body.append(this.section("Background", false, [swatches]));

    // ── Capture
    const save = el("button", "sv-action", "Save PNG");
    save.type = "button";
    save.title = "Save a screenshot beside the model  (S)";
    save.addEventListener("click", () => void this.screenshot());
    const edit = el("button", "sv-action sv-action-quiet", "Edit & export…");
    edit.type = "button";
    edit.title = "Move, turn, size, material and save-as  (E)";
    edit.addEventListener("click", () => this.toggleEditor());
    const actions = el("div", "sv-actions");
    actions.append(save, edit);
    body.append(this.section("Capture", false, [
      this.seg<string>("Scale", [["1", "1×"], ["2", "2×"], ["4", "4×"]],
        () => String(this.shotScale), (v) => {
          this.shotScale = Number(v);
          this.sync();
        }),
      actions,
    ]));

    // ── Info
    this.renderInfo();
    body.append(this.section("Model", true, [this.info]));
  }

  private section(title: string, open: boolean, children: HTMLElement[]): HTMLElement {
    const d = document.createElement("details");
    d.className = "sv-sec";
    d.open = open;
    const s = el("summary", "sv-sec-head", title);
    const b = el("div", "sv-sec-body");
    b.append(...children);
    d.append(s, b);
    return d;
  }

  private seg<T extends string>(label: string, options: Array<[T, string]>, get: () => T, set: (v: T) => void): HTMLElement {
    const field = el("div", "sv-field");
    const group = el("div", "sv-seg");
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", label);
    for (const [value, text] of options) {
      const b = el("button", "sv-seg-btn", text);
      b.type = "button";
      b.addEventListener("click", () => set(value));
      this.syncers.push(() => {
        const on = get() === value;
        if (on) b.dataset["on"] = "1";
        else delete b.dataset["on"];
        b.setAttribute("aria-pressed", on ? "true" : "false");
      });
      group.append(b);
    }
    field.append(el("span", "sv-label", label), group);
    return field;
  }

  private slider(
    label: string, min: number, max: number, step: number,
    get: () => number, set: (v: number) => void, show: (v: number) => string,
  ): HTMLElement {
    const field = el("label", "sv-field sv-range");
    const row = el("span", "sv-row");
    const value = el("output", "sv-val");
    row.append(el("span", "sv-label", label), value);
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    const paint = (v: number): void => {
      value.textContent = show(v);
      input.style.setProperty("--p", `${((v - min) / (max - min)) * 100}%`);
    };
    input.addEventListener("input", () => {
      const v = Number(input.value);
      paint(v);
      set(v);
    });
    this.syncers.push(() => {
      // Not while it is being dragged: writing the value back mid-drag moves
      // the thumb out from under the pointer on a stepped slider.
      if (document.activeElement === input) return;
      const v = get();
      input.value = String(v);
      paint(v);
    });
    field.append(row, input);
    return field;
  }

  private switch(label: string, keyHint: string, get: () => boolean, set: (v: boolean) => void): HTMLElement {
    const b = el("button", "sv-switch");
    b.type = "button";
    b.setAttribute("role", "switch");
    b.title = keyHint ? `${label}  (${keyHint})` : label;
    b.append(el("span", "sv-switch-label", label));
    if (keyHint) b.append(el("kbd", "sv-kbd", keyHint));
    b.append(el("span", "sv-switch-track"));
    b.addEventListener("click", () => set(!get()));
    this.syncers.push(() => {
      const on = get();
      b.setAttribute("aria-checked", on ? "true" : "false");
      if (on) b.dataset["on"] = "1";
      else delete b.dataset["on"];
    });
    return b;
  }

  private select<T extends string>(label: string, options: Array<[T, string]>, get: () => T, set: (v: T) => void): HTMLElement {
    const field = el("label", "sv-field");
    const s = document.createElement("select");
    s.className = "sv-select";
    for (const [value, text] of options) {
      const o = document.createElement("option");
      o.value = value;
      o.textContent = text;
      s.append(o);
    }
    s.addEventListener("change", () => set(s.value as T));
    this.syncers.push(() => {
      s.value = get();
    });
    field.append(el("span", "sv-label", label), s);
    return field;
  }

  // ── The animation bar ───────────────────────────────────────────────────

  private readonly animPlay = el("button", "sv-anim-play", "▶");
  private readonly animClip = document.createElement("select");
  private readonly animScrub = document.createElement("input");
  private readonly animTime = el("span", "sv-anim-time");
  private readonly animSpeed = document.createElement("select");
  private readonly animLoop = el("button", "sv-anim-loop", "⟲");

  private buildAnimBar(): void {
    this.anim.setAttribute("aria-label", "Animation");
    this.animPlay.type = "button";
    this.animPlay.title = "Play or pause  (Space)";
    this.animPlay.addEventListener("click", () => this.setPlaying(!this.head.playing));

    this.animClip.className = "sv-select sv-anim-clip";
    this.animClip.title = "Animation clip";
    this.animClip.addEventListener("change", () => this.pickClip(Number(this.animClip.value), this.head.playing));

    this.animScrub.type = "range";
    this.animScrub.className = "sv-anim-scrub";
    this.animScrub.min = "0";
    this.animScrub.max = "1000";
    this.animScrub.step = "1";
    this.animScrub.value = "0";
    this.animScrub.title = "Scrub";
    this.animScrub.addEventListener("pointerdown", () => {
      this.scrubbing = true;
    });
    const release = (): void => {
      this.scrubbing = false;
    };
    this.animScrub.addEventListener("pointerup", release);
    this.animScrub.addEventListener("change", release);
    this.animScrub.addEventListener("input", () => {
      this.head = scrub(this.head, Number(this.animScrub.value) / 1000);
      this.pose();
      this.syncAnim();
      this.request(2);
    });

    this.animSpeed.className = "sv-select sv-anim-speed";
    this.animSpeed.title = "Playback speed";
    for (const s of SPEEDS) {
      const o = document.createElement("option");
      o.value = String(s);
      o.textContent = `${s}×`;
      this.animSpeed.append(o);
    }
    this.animSpeed.addEventListener("change", () => {
      this.head = withSpeed(this.head, Number(this.animSpeed.value));
      this.syncAnim();
    });

    this.animLoop.type = "button";
    this.animLoop.title = "Loop";
    this.animLoop.addEventListener("click", () => {
      this.head = withLoop(this.head, !this.head.loop);
      this.syncAnim();
    });

    this.anim.append(this.animPlay, this.animClip, this.animScrub, this.animTime, this.animSpeed, this.animLoop);
  }

  private syncAnim(): void {
    const playing = this.head.playing;
    const glyph = playing ? "❚❚" : "▶";
    if (this.animPlay.textContent !== glyph) this.animPlay.textContent = glyph;
    this.animPlay.setAttribute("aria-pressed", playing ? "true" : "false");
    if (this.animClip.options.length !== this.clips.length) {
      this.animClip.replaceChildren(...this.clips.map((c, i) => {
        const o = document.createElement("option");
        o.value = String(i);
        o.textContent = c.name || `Clip ${i + 1}`;
        return o;
      }));
    }
    this.animClip.hidden = this.clips.length < 2;
    this.animClip.value = String(this.clipIndex);
    if (!this.scrubbing) this.animScrub.value = String(Math.round(progress(this.head) * 1000));
    this.animScrub.style.setProperty("--p", `${progress(this.head) * 100}%`);
    const time = `${clock(this.head.time)} / ${clock(this.head.duration)}`;
    if (this.animTime.textContent !== time) this.animTime.textContent = time;
    this.animSpeed.value = String(this.head.speed);
    if (this.head.loop) this.animLoop.dataset["on"] = "1";
    else delete this.animLoop.dataset["on"];
    this.animLoop.setAttribute("aria-pressed", this.head.loop ? "true" : "false");
  }

  // ── Help ────────────────────────────────────────────────────────────────

  private buildHelp(): void {
    this.help.setAttribute("role", "dialog");
    this.help.setAttribute("aria-label", "Keyboard shortcuts");
    const card = el("div", "sv-help-card");
    card.append(el("div", "sv-panel-title", "Keyboard shortcuts"));
    const grid = el("dl", "sv-help-grid");
    for (const [keys, what] of SHORTCUTS) {
      const dt = el("dt");
      for (const k of keys) dt.append(el("kbd", "sv-kbd", k));
      grid.append(dt, el("dd", "", what));
    }
    card.append(grid, el("p", "sv-help-foot", "Drag to orbit · right-drag to pan · scroll to zoom"));
    this.help.append(card);
    this.help.addEventListener("click", (e) => {
      if (e.target === this.help) this.setHelp(false);
    });
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
        case "Escape":
          if (!this.help.hidden) this.setHelp(false);
          else if (this.editor.isOpen) this.editor.close();
          else if (this.compact && !this.panel.hidden) this.setPanel(false);
          else this.close();
          this.sync();
          break;
        case "e": case "E": this.toggleEditor(); break;
        case "ArrowLeft": void this.step(-1); break;
        case "ArrowRight": void this.step(1); break;
        case "f": case "F": this.setView("fit"); break;
        case "w": case "W": this.setMode(this.mode === "wireframe" ? "shaded" : "wireframe"); break;
        case "g": case "G": this.setGrid(!this.showGrid); break;
        case "m": case "M": this.setOverride(!this.override); break;
        case "z": case "Z": this.setUp(this.up === "z" ? "y" : "z"); break;
        case "1": this.setView("front"); break;
        case "2": this.setView("right"); break;
        case "3": this.setView("top"); break;
        case "0": this.setView("iso"); break;
        case "5": this.setProjection(this.projection === "perspective" ? "orthographic" : "perspective"); break;
        case "r": case "R": this.setTurntable(!this.turntable); break;
        case "b": case "B":
          this.showBox = !this.showBox;
          this.setBoxObject(this.showBox);
          this.sync();
          this.request(2);
          break;
        case "s": case "S": void this.screenshot(); break;
        case "p": case "P": this.setPanel(this.panel.hidden); break;
        case "?": this.setHelp(this.help.hidden); break;
        case " ":
          // Only a model with clips has anything to play; otherwise the space
          // bar is left to whatever button has focus.
          if (!this.action) return;
          this.setPlaying(!this.head.playing);
          break;
        default: return;
      }
      e.preventDefault();
      e.stopPropagation();
    }, true);
  }
}

// ── Module helpers ────────────────────────────────────────────────────────
//
// Only the ones that are genuinely about this screen. Everything else that was
// here — framing, surveying, disposal, the grid, the edges, the playhead — is
// `@core/model3d/*`, because none of it needs a GPU and the harness can only
// reach it there.

const VIEW_NAMES: Readonly<Record<ViewPreset, string>> = {
  front: "Front", back: "Back", left: "Left", right: "Right",
  top: "Top", bottom: "Bottom", iso: "Isometric", fit: "Default",
};

const PRESET_BUTTONS: ReadonlyArray<[ViewPreset, string, string]> = [
  ["front", "Front", "1"], ["back", "Back", ""], ["left", "Left", ""], ["right", "Right", "2"],
  ["top", "Top", "3"], ["bottom", "Bottom", ""], ["iso", "Iso", "0"], ["fit", "Fit", "F"],
];

const BACKGROUND_SWATCHES: ReadonlyArray<[BackgroundName, string]> = [
  ["theme", "Theme"], ["gradient", "Gradient"], ["black", "Black"], ["studio", "Studio"], ["environment", "Room"],
];

const SHORTCUTS: ReadonlyArray<[string[], string]> = [
  [["←", "→"], "Previous / next model"],
  [["1", "2", "3", "0"], "Front, right, top, isometric"],
  [["F"], "Frame the model"],
  [["5"], "Perspective / orthographic"],
  [["R"], "Turntable"],
  [["W"], "Wireframe"],
  [["G"], "Grid"],
  [["B"], "Bounding box"],
  [["M"], "Plain material"],
  [["Z"], "Z is up"],
  [["Space"], "Play / pause animation"],
  [["S"], "Save a screenshot"],
  [["E"], "Edit and export"],
  [["P"], "Side panel"],
  [["?"], "This sheet"],
  [["Esc"], "Close, one layer at a time"],
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
}

/** Marks a bar button as one the compact bar can do without. */
function optional(b: HTMLButtonElement): HTMLButtonElement {
  b.classList.add("sv-opt");
  return b;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

function basename(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}

let probe: CanvasRenderingContext2D | null = null;

/**
 * A theme colour as three can use it.
 *
 * Read by painting it rather than parsing it: a theme token can be a hex, an
 * `rgb()`, or a `color-mix()` of two other tokens, and only the browser knows
 * what the last one comes to. One pixel on a scratch canvas asks it.
 */
function cssColour(from: HTMLElement, token: string, fallback: string): Color {
  const raw = getComputedStyle(from).getPropertyValue(token).trim() || fallback;
  probe ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!probe) return new Color(fallback);
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = fallback;
  probe.fillStyle = raw;
  probe.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0] = probe.getImageData(0, 0, 1, 1).data;
  return new Color().setRGB(r / 255, g / 255, b / 255, SRGBColorSpace);
}

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
