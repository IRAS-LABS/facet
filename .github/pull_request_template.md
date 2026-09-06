## What this changes

<!-- One or two sentences. Link the issue if there is one. -->

## How you tested it

<!-- Which dev harness page, which platform, what you actually clicked.
     "Builds clean" is not testing. -->

## Checklist

- [ ] `npm run build` passes (that runs `tsc --noEmit` too)
- [ ] Rust changes: `cargo check` passes in `src-tauri/`
- [ ] Tested on the platform(s) the change affects
- [ ] Nothing added that phones home — no network calls, no telemetry, no analytics
- [ ] No API keys, tokens, hostnames, personal paths or real file names in the diff
- [ ] No screenshots or fixtures containing real personal data
