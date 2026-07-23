$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$envFile = Join-Path $root ".env"
$cvatDir = Join-Path $root ".local\cvat"

$keepCvat = $false
$volumes = $false
$withServerless = $false

function Show-Usage {
  @"
Uso:
  .\stop.ps1 [opcoes]

Opcoes:
  -KeepCvat, --keep-cvat               Para apenas a aplicacao, mantendo o CVAT rodando.
  -Volumes, --volumes                  Remove volumes Docker tambem. Apaga banco/artefatos locais.
  -WithServerless, --with-serverless   Usa tambem o compose serverless do CVAT ao parar.
  -CvatDir <caminho>                   Caminho local do clone CVAT. Padrao: .local\cvat.
  -Help, -h, --help                    Mostra esta ajuda.

Exemplos:
  .\stop.ps1
  .\stop.ps1 -KeepCvat
  .\stop.ps1 -Volumes
"@
}

for ($i = 0; $i -lt $args.Count; $i++) {
  switch -Regex ($args[$i]) {
    '^(--keep-cvat|-KeepCvat)$' {
      $keepCvat = $true
      continue
    }
    '^(--volumes|-Volumes)$' {
      $volumes = $true
      continue
    }
    '^(--with-serverless|-WithServerless)$' {
      $withServerless = $true
      continue
    }
    '^(-IncludeCvat)$' {
      $keepCvat = $false
      continue
    }
    '^(-CvatDir)$' {
      if ($i + 1 -ge $args.Count) {
        throw "-CvatDir exige um caminho."
      }
      $i++
      $cvatDir = $args[$i]
      continue
    }
    '^(-h|--help|-Help)$' {
      Show-Usage
      exit 0
    }
    default {
      Write-Error "Opcao desconhecida: $($args[$i])"
    }
  }
}

function Require-Command {
  param([string]$Name)

  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Comando obrigatorio nao encontrado: $Name"
  }
}

Require-Command "docker"

docker info *> $null
if ($LASTEXITCODE -ne 0) {
  throw "Docker nao esta respondendo. Abra/inicie o Docker e rode .\stop.ps1 novamente."
}

$compose = @("compose")
if (Test-Path -LiteralPath $envFile) {
  $compose += @("--env-file", $envFile)
}
$compose += @("-f", (Join-Path $root "infra\docker-compose.dev.yml"))

$downArgs = @("down")
if ($volumes) {
  Write-Host "Aviso: -Volumes remove banco, Redis, MinIO, MLflow e node_modules persistidos da stack local."
  $downArgs += "-v"
}

Write-Host "Parando stack da aplicacao..."
docker @compose @downArgs

if (-not $keepCvat) {
  if (Test-Path -LiteralPath $cvatDir) {
    Write-Host "Parando CVAT..."
    $cvatCompose = @("-f", "docker-compose.yml")
    if ($withServerless) {
      $cvatCompose += @("-f", "components/serverless/docker-compose.serverless.yml")
    }

    $cvatDownArgs = @("down")
    if ($volumes) {
      Write-Host "Aviso: -Volumes tambem remove volumes locais do CVAT."
      $cvatDownArgs += "-v"
    }

    Push-Location $cvatDir
    try {
      docker compose @cvatCompose @cvatDownArgs
    } finally {
      Pop-Location
    }
  } else {
    Write-Host "CVAT nao encontrado em $cvatDir; nada para parar."
  }
}

Write-Host ""
Write-Host "Tudo finalizado."
if (-not $volumes) {
  Write-Host "Volumes preservados. Rode .\start.ps1 para subir novamente com os mesmos dados."
}
