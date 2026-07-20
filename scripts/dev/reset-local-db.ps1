param(
  [switch]$ConfirmReset,
  [switch]$SkipBackup,
  [string]$BackupDir = ".local\backup"
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$composeFile = Join-Path $root "infra\docker-compose.dev.yml"
$compose = @("compose", "-f", $composeFile)
$volumeName = "anotator-dev_postgres_data"

if (-not $ConfirmReset) {
  Write-Host "Este script remove o volume Docker '$volumeName' e recria o banco local." -ForegroundColor Yellow
  Write-Host "Execute novamente com -ConfirmReset para confirmar:"
  Write-Host "  powershell -ExecutionPolicy Bypass -File scripts/dev/reset-local-db.ps1 -ConfirmReset"
  exit 1
}

$backupPath = $null
if (-not $SkipBackup) {
  $resolvedBackupDir = Join-Path $root $BackupDir
  New-Item -ItemType Directory -Force $resolvedBackupDir | Out-Null
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $backupPath = Join-Path $resolvedBackupDir "anotator-before-baseline-$stamp.sql"

  Write-Host "Garantindo Postgres para backup..."
  & docker @compose up -d postgres
  Write-Host "Criando backup em $backupPath"
  try {
    & docker @compose exec -T postgres pg_dump -U anotator -d anotator > $backupPath
  } catch {
    Write-Host "Backup falhou. O banco pode ainda nao existir ou estar vazio." -ForegroundColor Yellow
    Write-Host "Use -SkipBackup apenas se tiver certeza de que pode perder os dados locais."
    throw
  }
}

Write-Host "Parando stack dev..."
& docker @compose down

Write-Host "Removendo volume $volumeName..."
& docker volume rm $volumeName

Write-Host "Subindo Postgres limpo..."
& docker @compose up -d postgres

Write-Host "Aguardando Postgres ficar pronto..."
for ($attempt = 1; $attempt -le 30; $attempt++) {
  & docker @compose exec -T postgres pg_isready -U anotator -d anotator | Out-Null
  if ($LASTEXITCODE -eq 0) {
    break
  }
  Start-Sleep -Seconds 2
}
if ($LASTEXITCODE -ne 0) {
  throw "Postgres nao ficou pronto no tempo esperado."
}

Write-Host "Aplicando Alembic baseline..."
& docker @compose run --rm backend alembic upgrade head

Write-Host ""
Write-Host "Banco local pronto para teste."
if ($backupPath) {
  Write-Host "Backup salvo em: $backupPath"
}
Write-Host "Admin inicial: admin@cvat.plus / admin123"
