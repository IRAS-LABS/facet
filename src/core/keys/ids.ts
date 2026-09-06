/**
 * Command ids, as constants.
 *
 * Separate from `commands.ts` so the shell can switch on an id without pulling
 * in the declarations — and so a typo is a build error rather than a `case`
 * that quietly never runs, which is the exact failure a keymap must not have.
 */

export const KEY_ID = {
  palette: "shell.palette",
  settings: "shell.settings",
  sidebar: "shell.sidebar",
  shortcuts: "shell.shortcuts",

  address: "explorer.address",
  back: "explorer.back",
  reload: "explorer.reload",
  filter: "explorer.filter",
  viewMode: "explorer.viewMode",
  bigger: "explorer.bigger",
  smaller: "explorer.smaller",

  open: "file.open",
  quickLook: "file.quickLook",
  info: "file.info",
  copy: "file.copy",
  share: "file.share",
  edit: "file.edit",

  hex: "tool.hex",
  table: "tool.table",
  transcribe: "tool.transcribe",
  subtitles: "tool.subtitles",
  ocr: "tool.ocr",
  sign: "tool.sign",
  batch: "tool.batch",
  watch: "tool.watch",
} as const;
