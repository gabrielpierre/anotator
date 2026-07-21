param(
  [switch]$SkipCvat,
  [switch]$Build,
  [switch]$ResetDb,
  [switch]$SkipDbResetBackup
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")

if (-not $SkipCvat) {
  & (Join-Path $PSScriptRoot "setup-cvat.ps1")
}

if ($ResetDb) {
  $resetArgs = @("-ConfirmReset")
  if ($SkipDbResetBackup) {
    $resetArgs += "-SkipBackup"
  }
  & (Join-Path $PSScriptRoot "reset-local-db.ps1") @resetArgs
}

$compose = @("compose")
$envFile = Join-Path $root ".env"
if (Test-Path -LiteralPath $envFile) {
  $compose += @("--env-file", $envFile)
}
$compose += @("-f", (Join-Path $root "infra\docker-compose.dev.yml"), "up", "-d")
if ($Build) {
  $compose += "--build"
}
docker @compose

$frontendPort = if ($env:FRONTEND_PORT) { $env:FRONTEND_PORT } else { "3000" }
$backendPort = if ($env:BACKEND_PORT) { $env:BACKEND_PORT } else { "8020" }
$mlflowPort = if ($env:MLFLOW_PORT) { $env:MLFLOW_PORT } else { "5000" }
$minioConsolePort = if ($env:MINIO_CONSOLE_PORT) { $env:MINIO_CONSOLE_PORT } else { "9001" }

Write-Host ""
Write-Host "Frontend: http://localhost:$frontendPort"
Write-Host "Backend:  http://localhost:$backendPort/docs"
Write-Host "CVAT:     http://localhost:8080"
Write-Host "MLflow:   http://localhost:$mlflowPort"
Write-Host "MinIO:    http://localhost:$minioConsolePort"
