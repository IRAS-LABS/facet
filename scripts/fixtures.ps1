<#
.SYNOPSIS
  Stages (and unstages) the sample files that three dev harnesses need.

.DESCRIPTION
  metacheck, hexcheck, tablecheck, autoblurcheck, facecheck and veditcheck
  read their inputs over HTTP, because they test decoders and detectors, and a
  decoder tested on bytes it generated itself proves only that it is
  self-consistent. Those inputs are real photographs and real spreadsheets, so
  they are staged on demand rather than committed.

  They go in fixtures/, NOT in public/, and the difference matters. public/
  is copied wholesale into dist/, and dist/ is baked into the Rust binary by
  generate_context!, so anything staged in public/ would ship inside the
  build. Nothing copies fixtures/, so a staging mistake cannot reach a build
  at all. The dev server reaches them through the facet-fixtures plugin in
  vite.config.ts.

  Staging is one command that says out loud what it did. If the staged
  folders are missing, the harnesses used to die at their first fetch without
  reporting a failure; now a missing file 404s with the name of this script
  in the response body.

  Sources come from $env:FACET_FIXTURE_SRC, a folder you control that holds:
    a.jpg        any camera-original JPEG with EXIF (GPS / serial data intact)
    b.jpg        any other JPEG
    c.png        any PNG (a screenshot is fine)
    face-a.jpg   a photo with one clear, roughly front-on face
    face-b.jpg   a photo with several faces at different sizes
    screens.jpg  a desk with monitors on it, screens readable
    plates.jpg   a car with a readable licence plate

  The last four are what the detectors are judged against. Use images you have
  the right to use; CC0 photographs from Openverse work well. Nothing staged is
  ever committed, so whatever you pick stays on your machine.

  -Clean recycles the staged folders again. Nothing here is ever permanently
  deleted; it goes to the Recycle Bin.

.EXAMPLE
  .\scripts\fixtures.ps1              # stage
  .\scripts\fixtures.ps1 -Clean       # unstage
#>
param([switch]$Clean)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$stage = Join-Path $root 'fixtures'

$targets = @(
    (Join-Path $stage '_metacheck'),
    (Join-Path $stage '_hexcheck'),
    (Join-Path $stage '_tablecheck'),
    (Join-Path $stage '_autoblurcheck')
)

if ($Clean) {
    Add-Type -AssemblyName Microsoft.VisualBasic
    foreach ($t in $targets) {
        if (Test-Path $t) {
            [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(
                $t, 'OnlyErrorDialogs', 'SendToRecycleBin')
            Write-Host "recycled $t" -ForegroundColor DarkYellow
        }
    }
    return
}

# The photographs. A camera original is required for a.jpg specifically: the
# panel's whole reason to exist is the alert it raises over embedded GPS and
# serial numbers, and a screenshot or a re-saved web image has had all of that
# stripped long before it reaches disk.
$srcRoot = $env:FACET_FIXTURE_SRC
if (-not $srcRoot) {
    throw "Set FACET_FIXTURE_SRC to a folder holding a.jpg (camera JPEG with EXIF), b.jpg and c.png."
}
$sources = @{
    '_metacheck\a.jpg'                 = Join-Path $srcRoot 'a.jpg'
    '_metacheck\b.jpg'                 = Join-Path $srcRoot 'b.jpg'
    '_metacheck\c.png'                 = Join-Path $srcRoot 'c.png'
    '_hexcheck\a.jpg'                  = Join-Path $srcRoot 'a.jpg'
    '_autoblurcheck\face-a.jpg'        = Join-Path $srcRoot 'face-a.jpg'
    '_autoblurcheck\face-b.jpg'        = Join-Path $srcRoot 'face-b.jpg'
    '_autoblurcheck\autoblur-office.jpg' = Join-Path $srcRoot 'screens.jpg'
    '_autoblurcheck\autoblur-car.jpg'    = Join-Path $srcRoot 'plates.jpg'
}

foreach ($t in $targets) {
    if (-not (Test-Path $t)) { New-Item -ItemType Directory -Force -Path $t | Out-Null }
}

foreach ($rel in $sources.Keys) {
    $src = $sources[$rel]
    if (-not (Test-Path $src)) {
        throw "missing source for ${rel}: $src`nPut that file in `$env:FACET_FIXTURE_SRC."
    }
    Copy-Item $src (Join-Path $stage $rel) -Force
    $kb = [int]((Get-Item (Join-Path $stage $rel)).Length / 1kb)
    Write-Host ("staged {0,-20} {1,6} KB" -f $rel, $kb) -ForegroundColor Green
}

# The tables are generated rather than borrowed. mktable.py writes them with
# duckdb, openpyxl and the stdlib csv module — three readers that are not
# FACET — and dumps a truth.json alongside saying what each one contains.
$tbl = Join-Path $root 'src\dev\tbl'
Write-Host "`n== generating table fixtures" -ForegroundColor Cyan
Push-Location $root
try {
    & py (Join-Path $root 'src\dev\mktable.py')
    if ($LASTEXITCODE -ne 0) { throw "mktable.py failed ($LASTEXITCODE)" }
} finally { Pop-Location }

Copy-Item (Join-Path $tbl '*') (Join-Path $stage '_tablecheck') -Force
Get-ChildItem (Join-Path $stage '_tablecheck') |
    ForEach-Object { Write-Host ("staged {0,-20} {1,6} KB" -f "_tablecheck\$($_.Name)", [int]($_.Length / 1kb)) -ForegroundColor Green }

Write-Host "`nNow open http://localhost:8183/dev/allcheck.html" -ForegroundColor Cyan
Write-Host "Afterwards: .\scripts\fixtures.ps1 -Clean" -ForegroundColor DarkYellow
