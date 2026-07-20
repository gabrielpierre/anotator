param(
  [switch]$SkipCvat,
  [switch]$Build
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")

if (-not $SkipCvat) {
  & (Join-Path $PSScriptRoot "setup-cvat.ps1")
}

$compose = @("compose", "-f", (Join-Path $root "infra\docker-compose.dev.yml"), "up", "-d")
if ($Build) {
  $compose += "--build"
}
docker @compose

Write-Host ""
Write-Host "Frontend: http://localhost:3000"
Write-Host "Backend:  http://localhost:8000/docs"
Write-Host "CVAT:     http://localhost:8080"
Write-Host "MLflow:   http://localhost:5000"
Write-Host "MinIO:    http://localhost:9001"
