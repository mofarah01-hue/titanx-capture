# Release: the only thing that changes the live link. Run only when Mohammad says "release".
#   tools/release.ps1 -Version 0.1.0 [-SkipE2E] [-Real]
# Without -Real the live link stays a demo (simulated sensors only). -Real is for the Phase 1
# release, when the remote user starts using real sensors.
# Runs the tests, stamps version.json and core/version.js with the version, today's date and the
# list of app files (the update banner refetches them so a reload never mixes old and new files),
# commits, tags, pushes main and moves the live branch that GitHub Pages serves.
param(
  [Parameter(Mandatory = $true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version,
  [switch]$SkipE2E,
  [switch]$Real
)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

if (git status --porcelain) { throw 'Commit or stash your changes first. A release must match a commit.' }
if (git tag --list "v$Version") { throw "Tag v$Version already exists." }

npm run -s test:unit
if ($LASTEXITCODE -ne 0) { throw 'Unit tests failed. Nothing released.' }
if (-not $SkipE2E) {
  npx playwright test
  if ($LASTEXITCODE -ne 0) { throw 'End to end tests failed. Nothing released.' }
}

$built = Get-Date -Format 'yyyy-MM-dd'
$files = @('index.html', 'app/styles.css') +
  (Get-ChildItem -Recurse -File app, core, strings -Include *.js | ForEach-Object { (Resolve-Path -Relative $_.FullName).Substring(2).Replace('\', '/') })
$json = [ordered]@{ version = $Version; built = $built; files = $files } | ConvertTo-Json -Depth 3
[IO.File]::WriteAllText("$PWD/version.json", $json + "`n")
$demo = if ($Real) { 'false' } else { 'true' }
[IO.File]::WriteAllText("$PWD/core/version.js", "// Bumped together with /version.json by tools/release.ps1. The update banner compares the two.`nexport const VERSION = '$Version';`nexport const BUILT = '$built';`n// true: the live link (github.io) runs simulated sensors only. The Phase 1 release sets it false.`nexport const PAGES_DEMO = $demo;`n")

git add version.json core/version.js
git commit -m "Release v$Version"
git tag "v$Version"
git push origin main --tags
git push origin HEAD:live --force-with-lease
Write-Host "Released v$Version. GitHub Pages updates the live link in about a minute."
