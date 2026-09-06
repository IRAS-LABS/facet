/**
 * The phone settings sheet.
 *
 * A full-screen fixed sheet at z-index 40, like the trash sheet, and for the
 * same reason: the shell's hardware-back handler closes "the top fixed body
 * child at z ≥ 40" by dispatching Escape at it, so sitting at 40 and closing on
 * Escape is the whole back-button integration.
 *
 * There is no Save. Every control writes straight into the prefs store, the
 * store persists and notifies, and `bindPrefs` repaints the root classes and
 * variables — the screen behind the sheet is already changed by the time the
 * finger lifts. "Reset to defaults" is the one button that does more than one
 * key at a time.
 *
 * Controls are three shapes, chosen so nothing scrolls sideways (shell rule 1)
 * and every target is 48px tall (rule 3): a *segmented* row of equal-width
 * buttons for a choice, a *switch* row for a boolean, and a *slider* row for a
 * number. The sheet's own look — glass header, hairline section rules, soft
 * accent on the active segment — is the design language it lets you tune,
 * so a change is visible in the sheet itself before you close it.
 */

import {
  ACCENTS, ALBUM_STYLES, CHIPS, COLS, TABS, TEXT_SIZES, THEMES,
  type AlbumStylePref, type ChipsPref, type ColsPref, type PhonePrefs,
  type PhonePrefsStore, type TabPref, type TextSizePref, type ThemePref,
  haptic,
} from "@core/phone/prefs";
import { autoBlurStore, type AutoBlurStore } from "@core/phone/autoblur-prefs";
import { AUTO_CATEGORIES, CATEGORY_NAMES, type AutoCategory } from "@core/vision/autoblur-config";
import type { BlurKind } from "@core/edit/blur";
import { el, fill } from "./dom";
import { icon } from "./icons";
import { iconBtn } from "./photos-tab";

/** Short names for the blur styles, in the order the Blur panel lists them. */
const KIND_LABEL: Record<BlurKind, string> = {
  gaussian: "Blur", pixelate: "Pixel", solid: "Bar", mosaic: "Mosaic",
  motion: "Motion", radial: "Spin", frosted: "Frost", box: "Box",
};
/** The four styles that fit a 360px segmented row; the other four are a tap away in the Blur panel. */
const KIND_CHOICES: readonly BlurKind[] = ["gaussian", "pixelate", "solid", "mosaic"];
const CATEGORY_ICON: Record<AutoCategory, string> = {
  faces: "face", plates: "rect-shape", screens: "monitor", terminals: "code",
  cards: "file-text", codes: "grid", text: "type",
};
const CATEGORY_HINT: Record<AutoCategory, string> = {
  faces: "On-device face model, with the classic detector as a fallback.",
  plates: "Number plates, on vehicles or on their own.",
  screens: "Monitors, laptops and TVs. Phones are a switch below.",
  terminals: "Only screens showing a terminal or code: dark, monospaced text. Needs the text reader.",
  cards: "Bank cards, IDs and documents: dense printed text in a card shape. Catches posters too, so it is off until you switch it on.",
  codes: "QR codes and barcodes.",
  text: "Lines the text reader finds that match the rules below.",
};
const FPS_CHOICES = [0.5, 1, 2, 4] as const;

/** The words on the segments. Keys are the stored values; the UI never stores a label. */
const THEME_LABEL: Record<ThemePref, string> = { dark: "Dark", light: "Light", system: "System" };
const THEME_ICON: Record<ThemePref, string> = { dark: "moon", light: "sun", system: "monitor" };
const CHIPS_LABEL: Record<ChipsPref, string> = { hidden: "Off", segmented: "Underline", bubbles: "Bubbles" };
const ALBUM_LABEL: Record<AlbumStylePref, string> = { borderless: "Open", boxed: "Cards", stack: "Stack" };
const TEXT_LABEL: Record<TextSizePref, string> = { small: "Small", default: "Default", large: "Large" };
const TAB_LABEL: Record<TabPref, string> = {
  photos: "Photos", all: "All", albums: "Albums", files: "Files", search: "Search",
};

export class SettingsSheet {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private resetBtn: HTMLButtonElement;
  private unsubscribe: (() => void) | null = null;
  /** Re-renderers for the rows, run on any change so the sheet reflects a reset. */
  private syncs: (() => void)[] = [];

  private readonly auto: AutoBlurStore;
  private unsubscribeAuto: (() => void) | null = null;

  constructor(private readonly store: PhonePrefsStore, auto: AutoBlurStore = autoBlurStore()) {
    this.auto = auto;
    this.body = el("div.ph-set-body");
    this.resetBtn = el<"button">("button.ph-note-btn.ph-set-reset", {
      type: "button", text: "Reset to defaults",
    });
    this.resetBtn.addEventListener("click", () => {
      this.store.reset();
      haptic(this.store, 12);
    });

    this.el = el("section.ph-set", {
      hidden: true,
      role: "dialog",
      "aria-modal": "true",
      "aria-label": "Settings",
      tabindex: "-1",
    },
      el("header.ph-head.ph-set-head", {},
        iconBtn("←", "Back", () => this.close()),
        el("h1.ph-title", { text: "Settings" }),
      ),
      this.body,
      el("footer.ph-set-foot", {}, this.resetBtn),
    );

    // Escape is what the shell's back handler sends; a keyboard on desktop
    // testing sends the same thing.
    this.el.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); this.close(); }
    });

    this.build();
    document.body.append(this.el);
  }

  open(): void {
    this.el.hidden = false;
    this.unsubscribe ??= this.store.subscribe(() => this.sync());
    this.unsubscribeAuto ??= this.auto.subscribe(() => this.sync());
    this.sync();
    this.el.focus();
  }

  close(): void {
    this.el.hidden = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unsubscribeAuto?.();
    this.unsubscribeAuto = null;
  }

  dispose(): void {
    this.close();
    this.el.remove();
  }

  private sync(): void {
    for (const fn of this.syncs) fn();
    this.resetBtn.disabled = !this.store.dirty;
  }

  /* ── Rows ────────────────────────────────────────────────────────────── */

  private build(): void {
    const p = (): PhonePrefs => this.store.get();

    fill(this.body,
      this.section("Look", "palette",
        this.segmented("Theme", THEMES, (v) => THEME_LABEL[v], () => p().theme,
          (v) => this.store.set({ theme: v }), (v) => THEME_ICON[v]),
        this.swatches(),
        this.slider("Translucency", "droplet", 0, 100, 5, () => p().glass,
          (v) => this.store.set({ glass: v }), (v) => `${v}%`,
          "Bars and sheets only. Higher costs a little battery while scrolling under them."),
        this.toggle("Motion", "zap", () => p().motion, (v) => this.store.set({ motion: v }),
          "Short fades and slides. Off follows your system's reduce-motion setting too."),
        this.toggle("Glow", "glow", () => p().glow, (v) => this.store.set({ glow: v }),
          "A soft halo behind the accent colour on bars and buttons."),
        this.segmented("Text size", TEXT_SIZES, (v) => TEXT_LABEL[v], () => p().textSize,
          (v) => this.store.set({ textSize: v })),
      ),

      this.section("Roll", "grid",
        this.segmented("Filter row", CHIPS, (v) => CHIPS_LABEL[v], () => p().chips,
          (v) => this.store.set({ chips: v }), undefined,
          "The Media / Docs / Audio filters on the All tab. Underline is a thin strip; Bubbles are the old pills."),
        this.slider("Tile corners", "square", 0, 20, 1, () => p().tileRadius,
          (v) => this.store.set({ tileRadius: v }), (v) => (v === 0 ? "Sharp" : `${v} px`)),
        this.slider("Tile gap", "columns", 0, 8, 1, () => p().tileGap,
          (v) => this.store.set({ tileGap: v }), (v) => (v === 0 ? "None" : `${v} px`)),
        this.segmented("Photos columns", COLS, colsLabel, () => p().colsPhotos,
          (v) => this.store.set({ colsPhotos: v }), undefined,
          "Pinch lets the two-finger gesture decide."),
        this.segmented("All columns", COLS, colsLabel, () => p().colsAll,
          (v) => this.store.set({ colsAll: v })),
        this.toggle("File name labels", "tag", () => p().labels, (v) => this.store.set({ labels: v }),
          "Names under documents, audio and archives in the roll."),
        this.toggle("Video badges", "play", () => p().badges, (v) => this.store.set({ badges: v }),
          "Duration and the play mark on video tiles."),
        this.toggle("Day counts", "info", () => p().dayCounts, (v) => this.store.set({ dayCounts: v }),
          "The number beside each date header."),
      ),

      this.section("Albums", "albums",
        this.segmented("Style", ALBUM_STYLES, (v) => ALBUM_LABEL[v], () => p().albumStyle,
          (v) => this.store.set({ albumStyle: v }), albumIcon,
          "Open is edge to edge with no frame. Cards puts each cover in a box. Stack fans the cover like a pile of prints."),
        this.segmented("Columns", [2, 3, 4] as const, (v) => String(v), () => p().colsAlbums,
          (v) => this.store.set({ colsAlbums: v })),
        this.toggle("Names", "type", () => p().albumNames, (v) => this.store.set({ albumNames: v })),
        this.toggle("Counts", "info", () => p().albumCounts, (v) => this.store.set({ albumCounts: v })),
      ),

      this.section("Behaviour", "sliders",
        this.segmented("Open on", TABS, (v) => TAB_LABEL[v], () => p().defaultTab,
          (v) => this.store.set({ defaultTab: v }), undefined,
          "The tab the app starts on."),
        this.toggle("Haptics", "vibrate", () => p().haptics, (v) => this.store.set({ haptics: v }),
          "A tick from the vibration motor on tab switches and settings changes."),
      ),

      this.autoBlurSection(),
    );
  }

  /* ── Auto-blur ───────────────────────────────────────────────────────── */

  /**
   * One block per category — on/off, style, strength, padding, smallest
   * size — then the switches that cut across them. Every control writes to
   * the auto-blur store (`fct.autoblur.v1`), which the editor's Auto-blur
   * sheet, the video workspace and the batch runner all read.
   */
  private autoBlurSection(): HTMLElement {
    const a = (): ReturnType<AutoBlurStore["get"]> => this.auto.get();
    const rows: HTMLElement[] = [];
    for (const c of AUTO_CATEGORIES) {
      const cat = (): ReturnType<AutoBlurStore["get"]>["categories"][AutoCategory] => a().categories[c];
      rows.push(
        this.toggle(CATEGORY_NAMES[c].title, CATEGORY_ICON[c], () => cat().on,
          (v) => this.auto.setCategory(c, { on: v }), CATEGORY_HINT[c]),
        this.segmented(`${CATEGORY_NAMES[c].title} style`, KIND_CHOICES, (k) => KIND_LABEL[k],
          () => (KIND_CHOICES.includes(cat().kind) ? cat().kind : KIND_CHOICES[0]!),
          (k) => this.auto.setCategory(c, { kind: k })),
        this.slider(`${CATEGORY_NAMES[c].title} strength`, "gauge", 1, 25, 1, () => Math.round(cat().amount * 100),
          (v) => this.auto.setCategory(c, { amount: v / 100 }), (v) => `${v}%`),
        this.slider(`${CATEGORY_NAMES[c].title} padding`, "resize", 0, 50, 5, () => Math.round(cat().pad * 100),
          (v) => this.auto.setCategory(c, { pad: v / 100 }), (v) => (v === 0 ? "Tight" : `+${v}%`),
          "Extra margin around each find, as a share of its size."),
        this.slider(`${CATEGORY_NAMES[c].title} smallest`, "search", 0, 200, 4, () => cat().minSize,
          (v) => this.auto.setCategory(c, { minSize: v }), (v) => (v === 0 ? "Any" : `${v} px`),
          "Finds narrower than this are ignored."),
      );
    }
    rows.push(
      this.toggle("Phones count as screens", "monitor", () => a().screensIncludePhones,
        (v) => this.auto.patch({ screensIncludePhones: v }),
        "A phone in someone's hand is a screen too. Off blurs only monitors, laptops and TVs."),
      this.toggle("Face model", "face", () => a().faceModel, (v) => this.auto.patch({ faceModel: v }),
        "The neural face detector. Off uses the classic detector everywhere."),
      this.toggle("Video: whole clip", "film", () => a().video.wholeClip, (v) => this.auto.patch({ video: { wholeClip: v } }),
        "Keep each blur on for the whole video, not just the seconds it was seen. Right for monitors; wrong for a car passing by."),
      this.segmented("Video: looks per second", FPS_CHOICES, (v) => (v < 1 ? "½" : String(v)), () => a().video.fps,
        (v) => this.auto.patch({ video: { fps: v } }), undefined,
        "How often the detectors look at the clip. More is slower and catches shorter appearances."),
      this.toggle("Text: emails", "type", () => a().text.emails, (v) => this.auto.patch({ text: { emails: v } })),
      this.toggle("Text: phone numbers", "type", () => a().text.phones, (v) => this.auto.patch({ text: { phones: v } })),
      this.toggle("Text: links", "type", () => a().text.urls, (v) => this.auto.patch({ text: { urls: v } })),
      this.toggle("Text: card numbers", "type", () => a().text.cardNumbers, (v) => this.auto.patch({ text: { cardNumbers: v } }),
        "Sixteen digits that pass the card checksum."),
      this.keywords(),
      this.autoReset(),
    );
    const sec = this.section("Auto-blur", "sparkles", ...rows);
    sec.classList.add("ph-set-auto");
    return sec;
  }

  /** A text field: one keyword per comma. Written on blur or Enter, not per keystroke. */
  private keywords(): HTMLElement {
    const input = el<"input">("input.ph-set-input", {
      type: "text", "aria-label": "Text: keywords", placeholder: "name, address, project…",
      autocomplete: "off", autocapitalize: "off", spellcheck: "false",
    });
    const write = (): void => {
      const list = input.value.split(",").map((s) => s.trim()).filter(Boolean);
      this.auto.patch({ text: { keywords: list } });
    };
    input.addEventListener("change", write);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); write(); input.blur(); } });
    this.syncs.push(() => {
      if (document.activeElement !== input) input.value = this.auto.get().text.keywords.join(", ");
    });
    return el("div.ph-set-row.ph-set-row-slider", {},
      this.label("Text: keywords", "tag", "Your own words — a name, a street, a project — blurred wherever the reader finds them. Separate with commas."),
      el("div.ph-set-slider", {}, input),
    );
  }

  private autoReset(): HTMLElement {
    const b = el<"button">("button.ph-note-btn.ph-set-reset-auto", { type: "button", text: "Reset auto-blur" });
    b.addEventListener("click", () => { this.auto.reset(); haptic(this.store, 12); });
    this.syncs.push(() => { b.disabled = !this.auto.dirty; });
    return el("div.ph-set-row", {}, b);
  }

  private section(title: string, iconKey: string, ...rows: HTMLElement[]): HTMLElement {
    return el("section.ph-set-section", {},
      el("h2.ph-set-title", {},
        el("span.ph-set-title-icon", { "aria-hidden": true }, icon(iconKey)),
        title,
      ),
      ...rows,
    );
  }

  private label(text: string, iconKey: string | null, hint?: string): HTMLElement {
    return el("div.ph-set-label", {},
      iconKey ? el("span.ph-set-icon", { "aria-hidden": true }, icon(iconKey)) : null,
      el("div.ph-set-text", {},
        el("span.ph-set-name", { text }),
        hint ? el("span.ph-set-hint", { text: hint }) : null,
      ),
    );
  }

  /**
   * A row of equal-width buttons, one pressed. `aria-pressed` carries the
   * state so the CSS and a screen reader read the same thing. Six or fewer
   * options fit a 360px phone; the column pickers are exactly six.
   */
  private segmented<T extends string | number>(
    name: string,
    options: readonly T[],
    labelOf: (v: T) => string,
    read: () => T,
    write: (v: T) => void,
    iconOf?: (v: T) => string,
    hint?: string,
  ): HTMLElement {
    const buttons = options.map((v) => {
      const b = el<"button">("button.ph-set-seg", { type: "button", "aria-pressed": "false" },
        iconOf ? el("span.ph-set-seg-icon", { "aria-hidden": true }, icon(iconOf(v))) : null,
        el("span.ph-set-seg-text", { text: labelOf(v) }),
      );
      b.addEventListener("click", () => { write(v); haptic(this.store); });
      return b;
    });
    const group = el("div.ph-set-segs", { role: "group", "aria-label": name }, ...buttons);
    group.dataset["count"] = String(options.length);

    this.syncs.push(() => {
      const cur = read();
      options.forEach((v, i) => {
        const b = buttons[i];
        if (b) b.setAttribute("aria-pressed", v === cur ? "true" : "false");
      });
    });
    return el("div.ph-set-row.ph-set-row-seg", {}, this.label(name, null, hint), group);
  }

  private toggle(
    name: string,
    iconKey: string,
    read: () => boolean,
    write: (v: boolean) => void,
    hint?: string,
  ): HTMLElement {
    // `data-fct-labelled` opts out of panel-fit's auto-labelling, which would
    // otherwise write the row's name inside the 52px switch; the row already
    // carries the name beside it.
    const sw = el<"button">("button.ph-set-switch", {
      type: "button", role: "switch", "aria-checked": "false", "aria-label": name,
      "data-fct-labelled": true,
    }, el("span.ph-set-knob", { "aria-hidden": true }));
    sw.addEventListener("click", () => { write(!read()); haptic(this.store); });

    this.syncs.push(() => sw.setAttribute("aria-checked", read() ? "true" : "false"));

    // The whole row is the target, not just the 48px switch at its end.
    const row = el("div.ph-set-row.ph-set-row-toggle", {}, this.label(name, iconKey, hint), sw);
    row.addEventListener("click", (e) => {
      if (e.target instanceof Node && sw.contains(e.target)) return;
      sw.click();
    });
    return row;
  }

  private slider(
    name: string,
    iconKey: string,
    min: number,
    max: number,
    step: number,
    read: () => number,
    write: (v: number) => void,
    format: (v: number) => string,
    hint?: string,
  ): HTMLElement {
    const out = el("output.ph-set-value");
    const input = el<"input">("input.ph-set-range", {
      type: "range", min, max, step, "aria-label": name,
    });
    // `input`, not `change`: the value applies while the thumb moves. The
    // store rejects no-op writes, so a stationary thumb costs nothing.
    input.addEventListener("input", () => write(Number(input.value)));
    input.addEventListener("change", () => haptic(this.store));

    this.syncs.push(() => {
      const v = read();
      input.value = String(v);
      out.textContent = format(v);
      // The filled track left of the thumb, drawn by CSS from this variable.
      input.style.setProperty("--fct-range", `${((v - min) / (max - min)) * 100}%`);
    });

    return el("div.ph-set-row.ph-set-row-slider", {},
      this.label(name, iconKey, hint),
      el("div.ph-set-slider", {}, input, out),
    );
  }

  /** The accent row: the theme's own colour, six swatches, and a free picker. */
  private swatches(): HTMLElement {
    const buttons = ACCENTS.map((a) => {
      // The name is drawn by the sheet itself (rule 2, a control says what it
      // is), so panel-fit is told not to add a second one.
      const b = el<"button">("button.ph-set-swatch", {
        type: "button", "aria-label": a.name, "aria-pressed": "false", "data-fct-labelled": true,
      },
        el("span.ph-set-swatch-dot", { "aria-hidden": true }),
        el("span.ph-set-swatch-name", { text: a.name }),
      );
      if (a.value === "") b.classList.add("ph-set-swatch-theme");
      else b.style.setProperty("--fct-swatch", a.value);
      b.addEventListener("click", () => { this.store.set({ accent: a.value }); haptic(this.store); });
      return b;
    });

    // The native colour picker: one tap opens the system dialog, which is the
    // one place a "custom colour" belongs on a phone. Labelled, like everything.
    const picker = el<"input">("input.ph-set-picker", { type: "color", "aria-label": "Custom accent" });
    picker.addEventListener("input", () => this.store.set({ accent: picker.value }));
    const custom = el("label.ph-set-swatch.ph-set-swatch-custom", { "aria-pressed": "false" },
      el("span.ph-set-swatch-dot", { "aria-hidden": true }, icon("plus")),
      el("span.ph-set-swatch-name", { text: "Custom" }),
      picker,
    );

    const row = el("div.ph-set-swatches", { role: "group", "aria-label": "Accent colour" }, ...buttons, custom);

    this.syncs.push(() => {
      const cur = this.store.get().accent;
      let matched = false;
      ACCENTS.forEach((a, i) => {
        const on = a.value === cur;
        matched ||= on;
        buttons[i]?.setAttribute("aria-pressed", on ? "true" : "false");
      });
      custom.setAttribute("aria-pressed", matched ? "false" : "true");
      if (cur !== "") { picker.value = cur; custom.style.setProperty("--fct-swatch", cur); }
      else custom.style.removeProperty("--fct-swatch");
    });

    return el("div.ph-set-row.ph-set-row-seg", {}, this.label("Accent", null), row);
  }
}

function colsLabel(v: ColsPref): string {
  return v === "pinch" ? "Pinch" : String(v);
}

function albumIcon(v: AlbumStylePref): string {
  return v === "boxed" ? "square" : v === "stack" ? "stack" : "square-sharp";
}
