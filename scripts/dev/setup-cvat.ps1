param(
  [string]$CvatDir = "",
  [switch]$WithServerless
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
if (-not $CvatDir) {
  $CvatDir = Join-Path $root ".local\cvat"
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw "Docker CLI was not found. Install Docker Desktop with WSL2 integration enabled."
}

if (-not (Test-Path -LiteralPath $CvatDir)) {
  New-Item -ItemType Directory -Force -Path (Split-Path $CvatDir) | Out-Null
  git clone https://github.com/cvat-ai/cvat $CvatDir
} else {
  Write-Host "Using existing CVAT checkout at $CvatDir"
}

Push-Location $CvatDir
try {
  $composeArgs = @("compose", "-f", "docker-compose.yml")
  if ($WithServerless) {
    $composeArgs += @("-f", "components/serverless/docker-compose.serverless.yml")
  }
  $composeArgs += @("up", "-d")
  docker @composeArgs
  Write-Host ""
  Write-Host "CVAT is expected at http://localhost:8080"
  Write-Host "If this is a fresh CVAT install, create an admin user with:"
  Write-Host "docker exec -it cvat_server bash -ic 'python3 ~/manage.py createsuperuser'"
} finally {
  Pop-Location
}
