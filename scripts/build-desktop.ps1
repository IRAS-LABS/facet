<#
.SYNOPSIS
  Builds the FACET Windows app and installer without leaking builder paths.

.DESCRIPTION
  `npx tauri build` on its own produces a facet.exe that spells out the
  builder's account name and the whole layout of their disk. Every Rust panic
  records the source file it came from, and unless told otherwise the compiler
  writes that as an absolute path; those strings are ordinary data, not
  symbols, so `strip = true` does not touch them. A plain release build of this
  crate carried 164 of them.

  The NSIS installer looks clean to `strings` only because the exe inside it is
  LZMA-compressed. Once installed, the extracted exe carries every one.

  This script sets the same --remap-path-prefix RUSTFLAGS that build-apk.ps1
  sets, and then -- unlike a wrapper you can forget to use -- checks the result
  and refuses to leave a leaking binary behind.

.PARAMETER Debug
  Build the debug variant. Skips the bundle and the leak check: a debug build
  is not something anyone ships.

.PARAMETER NoBundle
  Build facet.exe but skip the NSIS installer.

.PARAMETER NoFfmpeg
  Leave ffmpeg out of the installer; the app then uses whatever is on PATH.

.PARAMETER FfmpegZip
  Where the bundled ffmpeg comes from. Defaults to BtbN's win64 gpl-shared
  build of FFmpeg 8.1: shared, so ffmpeg.exe and ffprobe.exe share one set of
  DLLs instead of carrying two static copies, and GPL because the video export
  encodes with libx264, which no LGPL build contains. The Android binaries are
  GPL for the same reason. See THIRD-PARTY-NOTICES.md for what that obliges.
#>
param(
    [switch]$Debug,
    [switch]$NoBundle,
    [switch]$NoFfmpeg,
    [string]$FfmpegZip = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-win64-gpl-shared-8.1.zip'
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot

# Vite has been known to blow past the default heap on a cold build of this repo.
$env:NODE_OPTIONS = '--max-old-space-size=1536'

# Computed here rather than written down: the whole point is that no real path
# ends up in a file anyone reads. Cargo's `trim-paths` profile key would do the
# same job in Cargo.toml, where it could not be bypassed at all, but it is not
# stable yet -- checked on cargo 1.96.1, which still calls it unstabilized.
$cargoHome = if ($env:CARGO_HOME) { $env:CARGO_HOME } else { Join-Path $env:USERPROFILE '.cargo' }
$remap = "--remap-path-prefix=$cargoHome=/cargo",
         "--remap-path-prefix=$root=/facet"
$env:RUSTFLAGS = ((@($env:RUSTFLAGS) + $remap) -ne '' -join ' ').Trim()

# ── ffmpeg, bundled ──────────────────────────────────────────────────────────
#
# Fetched once into src-tauri/binaries (ignored by git: ~90 MB of someone
# else's binaries do not belong in the history) and handed to the bundler as a
# resource through --config, so tauri.conf.json, CI and a plain `tauri build`
# stay exactly as they were. The installer puts it in <install dir>\ffmpeg\,
# which is where ffmpeg.rs looks before falling back to PATH.
$tauriConfig = $null
if (-not $Debug -and -not $NoBundle -and -not $NoFfmpeg) {
    $ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest crawls with the bar on
    $bin     = Join-Path $root 'src-tauri\binaries'
    $zipPath = Join-Path $bin ([IO.Path]::GetFileName(([uri]$FfmpegZip).AbsolutePath))
    $unzip   = Join-Path $bin 'ffmpeg-download'
    $stage   = Join-Path $bin 'ffmpeg-win64'
    if (-not (Test-Path $bin)) { New-Item -ItemType Directory -Path $bin | Out-Null }

    if (-not (Test-Path (Join-Path $stage 'ffmpeg.exe'))) {
        if (-not (Test-Path $zipPath)) {
            Write-Host "   downloading ffmpeg: $FfmpegZip" -ForegroundColor DarkGray
            Invoke-WebRequest -Uri $FfmpegZip -OutFile $zipPath -UseBasicParsing
        }
        # Kept rather than cleaned up after: it is the cache, and this machine's
        # rule is that nothing is deleted outright.
        Expand-Archive -Path $zipPath -DestinationPath $unzip -Force
        $top = Get-ChildItem $unzip -Directory | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        New-Item -ItemType Directory -Force -Path $stage | Out-Null
        # ffplay is not used by the app; the headers, import libraries and docs
        # in the zip are for building against ffmpeg, not running it.
        Get-ChildItem (Join-Path $top.FullName 'bin') -File |
            Where-Object { $_.Name -ne 'ffplay.exe' } |
            Copy-Item -Destination $stage -Force
        Copy-Item (Join-Path $top.FullName 'LICENSE.txt') (Join-Path $stage 'LICENSE-ffmpeg.txt') -Force

        # What the GPL asks a redistributor to be able to say: exactly which
        # build this is and how it was configured, and where its source is.
        $hash    = (Get-FileHash $zipPath -Algorithm SHA256).Hash
        $version = & (Join-Path $stage 'ffmpeg.exe') -hide_banner -version 2>$null | Select-Object -First 3
        @(
            'FFmpeg bundled with FACET'
            ''
            "Binary build: $FfmpegZip"
            "SHA-256 of that archive: $hash"
            'Build scripts: https://github.com/BtbN/FFmpeg-Builds'
            'FFmpeg source: https://ffmpeg.org/download.html  (git: https://git.ffmpeg.org/ffmpeg.git)'
            ''
            $version
            ''
            'This build is licensed under the GPL (see LICENSE-ffmpeg.txt). FACET runs it as a'
            'separate program; FACET itself remains MIT-licensed.'
        ) | Out-File -FilePath (Join-Path $stage 'BUILD-INFO.txt') -Encoding utf8
    }

    $mb = (Get-ChildItem $stage -File | Measure-Object Length -Sum).Sum / 1MB
    Write-Host ("   bundling ffmpeg ({0:N0} MB uncompressed) -> <install dir>\ffmpeg\" -f $mb) -ForegroundColor DarkGray
    # A JSON file rather than an inline string: PowerShell 5.1 strips the
    # quotes out of a JSON argument on its way to a native program.
    $tauriConfig = Join-Path $bin 'bundle-ffmpeg.json'
    '{ "bundle": { "resources": { "binaries/ffmpeg-win64/*": "ffmpeg/" } } }' |
        Out-File -FilePath $tauriConfig -Encoding ascii
}

Push-Location $root
try {
    $tauriArgs = @('tauri', 'build')
    if ($Debug)    { $tauriArgs += '--debug' }
    if ($NoBundle) { $tauriArgs += @('--no-bundle') }
    if ($tauriConfig) { $tauriArgs += @('--config', $tauriConfig) }

    & npx @tauriArgs
    if ($LASTEXITCODE -ne 0) { throw "tauri build failed with exit code $LASTEXITCODE" }
}
finally {
    Pop-Location
}

$profileDir = if ($Debug) { 'debug' } else { 'release' }
$exe = Join-Path $root "src-tauri\target\$profileDir\facet.exe"
if (-not (Test-Path $exe)) { throw "expected a binary at $exe and there is none" }

Write-Host ''
Write-Host ("exe: {0}" -f $exe)
Write-Host ("size: {0:N1} MB   built: {1:yyyy-MM-dd HH:mm}" -f `
    ((Get-Item $exe).Length / 1MB), (Get-Item $exe).LastWriteTime)

if ($Debug) {
    Write-Host 'debug build - skipping the path check, this is not a shipping binary'
    exit 0
}

# ── The check that makes the remap worth having ──────────────────────────────
#
# Read the file as bytes and look for the account name in both encodings a
# Windows binary can carry it in. Rust string literals are UTF-8; anything that
# came through a Windows API may be UTF-16. Searching the decoded text for both
# is cheaper and more honest than shelling out to `strings`, which is not on a
# stock Windows box anyway.
$bytes = [System.IO.File]::ReadAllBytes($exe)
$utf8  = [System.Text.Encoding]::UTF8.GetString($bytes)
$utf16 = [System.Text.Encoding]::Unicode.GetString($bytes)

$needles = @(
    [regex]::Escape($env:USERNAME),
    [regex]::Escape($cargoHome),
    [regex]::Escape($root),
    'C:\\Users\\'
) | Where-Object { $_ -ne '' } | Select-Object -Unique

$leaks = @()
foreach ($n in $needles) {
    $c = ([regex]::Matches($utf8, $n, 'IgnoreCase')).Count +
         ([regex]::Matches($utf16, $n, 'IgnoreCase')).Count
    if ($c -gt 0) { $leaks += "{0}  x{1}" -f $n, $c }
}

if ($leaks.Count -gt 0) {
    Write-Host ''
    Write-Host 'LEAK: this binary contains the builder''s paths:' -ForegroundColor Red
    $leaks | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
    Write-Host ''
    Write-Host 'Do not publish it. Cargo makes RUSTFLAGS part of the fingerprint,'
    Write-Host 'so a flag change alone does force a rebuild -- which means a leak'
    Write-Host 'here is a real one and not a stale artifact. Something is putting a'
    Write-Host 'path in on purpose: check build.rs, env! and include_str! first.'
    exit 1
}

Write-Host 'path check: clean - no account name, CARGO_HOME or project path in the binary'

if (-not $NoBundle) {
    # Name the installer for *this* version, not every installer in the folder.
    # bundle/nsis is never cleaned, so it accumulates every release ever built
    # here -- and a list of four setup.exes is exactly how the wrong one gets
    # uploaded. Anything older is called out as such rather than shown as an
    # equal option.
    $ver  = (Get-Content (Join-Path $root 'src-tauri\tauri.conf.json') -Raw |
             ConvertFrom-Json).version
    $nsis = Join-Path $root 'src-tauri\target\release\bundle\nsis'
    $all  = @(Get-ChildItem $nsis -Filter *.exe -ErrorAction SilentlyContinue)
    $mine = $all | Where-Object { $_.Name -like "*_${ver}_*" }

    if ($mine) {
        $mine | ForEach-Object {
            Write-Host ("installer: {0}  ({1:N1} MB, {2:yyyy-MM-dd HH:mm})" -f `
                $_.FullName, ($_.Length / 1MB), $_.LastWriteTime)
        }
    } else {
        Write-Host "no installer for version $ver in $nsis" -ForegroundColor Yellow
    }

    $stale = $all | Where-Object { $_.Name -notlike "*_${ver}_*" }
    if ($stale) {
        Write-Host ''
        Write-Host ("{0} installer(s) for older versions are still in that folder:" -f $stale.Count) -ForegroundColor Yellow
        $stale | ForEach-Object { Write-Host ("  {0}" -f $_.Name) -ForegroundColor Yellow }
        Write-Host 'Do not upload those.' -ForegroundColor Yellow
    }
}
