<#
.SYNOPSIS
  Builds the FACET Android APK on a Windows box without Developer Mode.

.DESCRIPTION
  `tauri android build` does three things: build the frontend, cargo-build the
  Rust for each Android ABI, then hand off to Gradle. Between the second and
  third it drops a *symbolic link* to the built .so into app/src/main/jniLibs.

  Creating a symlink on Windows needs SeCreateSymbolicLinkPrivilege, which an
  ordinary account only has when Developer Mode is on. Without it the CLI dies
  at that step with "Creation symbolic link is not allowed for this system" —
  after a completely successful compile, which is what makes it so annoying.

  This script does the same three steps but copies the .so instead of linking
  it, then calls Gradle directly with the CLI's own Rust task skipped (that task
  just shells back into the CLI and would hit the same wall).

  Turning Developer Mode on in Settings > System > For developers makes this
  script unnecessary — plain `npx tauri android build --debug --apk` then works.
  It is kept because it also works on a locked-down machine.

.PARAMETER Release
  Build the release variant. The resulting APK is unsigned; add your own
  signing config in src-tauri/gen/android/app/build.gradle.kts.
#>
param(
    [switch]$Release,
    [string]$Abi = 'aarch64'
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk" }
if (-not $env:NDK_HOME) {
    # Newest NDK under the SDK, unless the caller already chose one.
    $ndkRoot = Join-Path $env:ANDROID_HOME 'ndk'
    $ndk = Get-ChildItem -Path $ndkRoot -Directory -ErrorAction SilentlyContinue |
        Sort-Object { [version]($_.Name -replace '[^0-9.].*$', '') } -Descending |
        Select-Object -First 1
    if ($ndk) { $env:NDK_HOME = $ndk.FullName }
}
# JAVA_HOME is left alone: if it is unset, gradlew falls back to whatever
# `java` is on PATH. Set it yourself if you need a specific JDK (17 works).
# Vite has been known to blow past the default heap on a cold build of this repo.
$env:NODE_OPTIONS = '--max-old-space-size=1536'

# Every Rust panic records the source file it came from, and unless told
# otherwise the compiler writes that as an absolute path on the machine doing
# the build. Those strings survive `strip` -- they are ordinary data, not
# symbols -- so a shipped .so spells out the builder's account name and the
# layout of their disk to anyone who runs `strings` on it. Cargo's `trim-paths`
# profile key does the same job but is not stable yet (checked on 1.96), so the
# remap goes through RUSTFLAGS, computed here rather than written down: the
# whole point is that no real path ends up in a file anyone reads.
$cargoHome = if ($env:CARGO_HOME) { $env:CARGO_HOME } else { Join-Path $env:USERPROFILE '.cargo' }
$remap = "--remap-path-prefix=$cargoHome=/cargo",
         "--remap-path-prefix=$root=/facet"
$env:RUSTFLAGS = ((@($env:RUSTFLAGS) + $remap) -ne '' -join ' ').Trim()
Write-Host "   build paths remapped out of the binary" -ForegroundColor DarkGray

$profile = if ($Release) { 'release' } else { 'debug' }
$variant = if ($Release) { 'Release' } else { 'Debug' }

$apkRoot = Join-Path $root 'src-tauri\gen\android\app\build\outputs\apk'

function Get-Apk {
    if (-not (Test-Path $apkRoot)) { return $null }
    Get-ChildItem -Path $apkRoot -Filter '*.apk' -Recurse |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
}

function Show-Apk($apk) {
    Write-Host ""
    Write-Host "APK: $($apk.FullName)" -ForegroundColor Green
    # The timestamp is printed rather than checked: gradle skips packaging when
    # nothing changed, so an unchanged rebuild legitimately leaves the old mtime.
    # Treating "not newer than the run" as failure fails a perfectly good build.
    Write-Host ("size: {0:N1} MB   built: {1:yyyy-MM-dd HH:mm}" -f ($apk.Length / 1MB), $apk.LastWriteTime) -ForegroundColor Green
}

$abiMap = @{
    'aarch64' = @{ Triple = 'aarch64-linux-android'; JniDir = 'arm64-v8a'; Flavor = 'Arm64' }
    'armv7'   = @{ Triple = 'armv7-linux-androideabi'; JniDir = 'armeabi-v7a'; Flavor = 'Arm' }
    'x86_64'  = @{ Triple = 'x86_64-linux-android'; JniDir = 'x86_64'; Flavor = 'X86_64' }
    'i686'    = @{ Triple = 'i686-linux-android'; JniDir = 'x86'; Flavor = 'X86' }
}
if (-not $abiMap.ContainsKey($Abi)) { throw "Unknown ABI '$Abi'. Use one of: $($abiMap.Keys -join ', ')" }
$target = $abiMap[$Abi]

Write-Host "== 1/3  frontend + cargo ($($target.Triple), $profile)" -ForegroundColor Cyan
Push-Location $root
try {
    # Expected to fail at the symlink step; everything before it is the work we
    # want, and a failure earlier shows up as the missing .so checked below.
    #
    # Deliberately NOT piped or 2>&1-redirected: Windows PowerShell wraps a
    # native command's stderr in ErrorRecords, and with $ErrorActionPreference
    # set to Stop the CLI's ordinary progress chatter would abort this script
    # before it ever got to the part that works around the failure.
    $cliArgs = @('tauri', 'android', 'build', '--apk', '--target', $Abi)
    if (-not $Release) { $cliArgs += '--debug' }
    & npx @cliArgs
} catch {
    Write-Host "  (tauri CLI exited non-zero - continuing to the workaround)" -ForegroundColor DarkYellow
} finally {
    $global:LASTEXITCODE = 0
    Pop-Location
}

$jni = Join-Path $root "src-tauri\gen\android\app\src\main\jniLibs\$($target.JniDir)"
$jniSo = Join-Path $jni 'libfacet_lib.so'

# With Developer Mode on, the CLI gets past the symlink step and builds the APK
# itself — and then the workaround below is not merely unnecessary, it fails:
# step 2 tries to overwrite the very symlink the CLI just created and takes an
# IOException on a file the toolchain still holds, turning a perfectly good
# APK into a red build log.
#
# The signal is the symlink, not the APK's timestamp. A reparse point here means
# the CLI cleared the exact step this script exists to work around, so it also
# ran gradle. The timestamp cannot be used: gradle skips packaging when nothing
# changed, and an up-to-date APK keeps its old mtime.
$link = Get-Item -LiteralPath $jniSo -Force -ErrorAction SilentlyContinue
if ($link -and ($link.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    $apk = Get-Apk
    if ($apk) {
        Write-Host "the CLI symlinked and built on its own - skipping the workaround" -ForegroundColor DarkYellow
        Show-Apk $apk
        exit 0
    }
}

$so = Join-Path $root "src-tauri\target\$($target.Triple)\$profile\libfacet_lib.so"
if (-not (Test-Path $so)) {
    throw "cargo did not produce $so - the failure above was real, not the symlink step."
}

Write-Host "== 2/3  copying the shared library into jniLibs" -ForegroundColor Cyan
if (-not (Test-Path $jni)) { New-Item -ItemType Directory -Force -Path $jni | Out-Null }
Copy-Item $so $jniSo -Force

Write-Host "== 3/3  gradle assemble$($target.Flavor)$variant" -ForegroundColor Cyan
Push-Location (Join-Path $root 'src-tauri\gen\android')
try {
    & .\gradlew.bat "assemble$($target.Flavor)$variant" "-xrustBuild$($target.Flavor)$variant"
    if ($LASTEXITCODE -ne 0) { throw "gradle failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}

$apk = Get-Apk
if (-not $apk) { throw "gradle reported success but there is no APK under $apkRoot." }
Show-Apk $apk
