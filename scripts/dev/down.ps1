param(
  [switch]$IncludeCvat,
  [string]$CvatDir = ""
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")

docker compose -f (Join-Path $root "infra\docker-compose.dev.yml") down

if ($IncludeCvat) {
  if (-not $CvatDir) {
    $CvatDir = Join-Path $root ".local\cvat"
  }
  if (Test-Path -LiteralPath $CvatDir) {
    Push-Location $CvatDir
    try {
      docker compose down
    } finally {
      Pop-Location
    }
  }
}
