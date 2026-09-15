/**
 * The pop-out page, in the app: `pip.html?id=N`, one per window that
 * `src-tauri/src/pip.rs` built. All it does is wire `mountPip` to the real
 * window. The id in the URL is only a key — the path comes back from Rust, so
 * a pop-out cannot be pointed at a file by editing its address.
 */

import "../styles/base.css";
import "../styles/shell.css";
import "../styles/scene.css";
import "../styles/scene-edit.css";
import "../styles/skin.css";
import "../styles/pip.css";

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { IS_NATIVE, TauriFs } from "@core/explorer/tauri-fs";
import { themes } from "@core/theme/theme-engine";
import "@core/settings/registry";
import { applyLook } from "@core/settings/look";
import { settings } from "@core/settings/store";

import { mountPip, type PipBridge, type PipInfo } from "./pip-app";

themes.init();
// The explorer's skin, corners and glow, read from the same settings it saves.
applyLook(document.documentElement, settings);

async function boot(): Promise<void> {
  const host = document.getElementById("pip");
  if (!host) return;
  if (!IS_NATIVE) {
    host.textContent = "Pop-outs open from the FACET app.";
    return;
  }
  const fs = new TauriFs();
  const win = getCurrentWindow();
  const bridge: PipBridge = {
    info: () => invoke<PipInfo | null>("pip_info"),
    ready: (aspect) => void invoke("pip_ready", { aspect }).catch(() => {}),
    close: () => void win.close(),
    startDrag: () => void win.startDragging().catch(() => {}),
    startResize: (dir) => void win.startResizeDragging(dir).catch(() => {}),
    setOnTop: (v) => void win.setAlwaysOnTop(v).catch(() => {}),
    reveal: () => void invoke("pip_reveal").catch(() => {}),
    fileUrl: (p) => fs.fileUrl(p),
    openExternal: (p) => fs.openExternal(p),
    readHead: (p, max) => fs.readHead(p, max),
    readRange: (p, o, l) => fs.readRange(p, o, l),
    readTail: (p, l) => fs.readTail(p, l),
    writeFile: (p, b, o) => fs.writeFile(p, b, o),
    frameAt: (p, at, w) => fs.frameAt(p, at, w),
  };
  await mountPip(host, bridge);
}

void boot();
