param(
  [string]$BackendUrl = "http://localhost:8000/openapi.json",
  [string]$OutputJson = "backend\openapi.json",
  [string]$OutputTypes = "lib\api\openapi-types.ts"
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$jsonPath = Join-Path $root $OutputJson
$typesPath = Join-Path $root $OutputTypes

Invoke-WebRequest -Uri $BackendUrl -OutFile $jsonPath
pnpm dlx openapi-typescript $jsonPath -o $typesPath
Write-Host "OpenAPI schema written to $jsonPath"
Write-Host "TypeScript types written to $typesPath"
