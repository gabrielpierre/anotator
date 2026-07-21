param(
  [switch]$IncludeCvat,
  [string]$CvatDir = ""
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")

$compose = @("compose")
$envFile = Join-Path $root ".env"
if (Test-Path -LiteralPath $envFile) {
  $compose += @("--env-file", $envFile)
}
$compose += @("-f", (Join-Path $root "infra\docker-compose.dev.yml"), "down")
docker @compose

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
