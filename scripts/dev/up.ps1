$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$envFile = Join-Path $root ".env"
$cvatDir = Join-Path $root ".local\cvat"

$skipCvat = $false
$build = $false
$resetDb = $false
$skipDbResetBackup = $false
$withServerless = $false

function Show-Usage {
  @"
Uso:
  .\start.ps1 [opcoes]

Opcoes:
  -Build, --build                      Rebuilda backend/worker/frontend antes de subir.
  -SkipCvat, --skip-cvat               Sobe apenas a stack da aplicacao, sem iniciar o CVAT.
  -WithServerless, --with-serverless   Sobe o CVAT com o compose serverless oficial.
  -ResetDb                             Recria o banco local da aplicacao antes de subir.
  -SkipDbResetBackup                   Nao cria backup antes do reset local.
  -Help, -h, --help                    Mostra esta ajuda.

Exemplos:
  .\start.ps1
  .\start.ps1 -Build
  .\start.ps1 -SkipCvat
"@
}

for ($i = 0; $i -lt $args.Count; $i++) {
  switch -Regex ($args[$i]) {
    '^(--build|-Build)$' {
      $build = $true
      continue
    }
    '^(--skip-cvat|-SkipCvat)$' {
      $skipCvat = $true
      continue
    }
    '^(--with-serverless|-WithServerless)$' {
      $withServerless = $true
      continue
    }
    '^(-ResetDb)$' {
      $resetDb = $true
      continue
    }
    '^(-SkipDbResetBackup)$' {
      $skipDbResetBackup = $true
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

function Get-EnvValue {
  param(
    [string]$Key,
    [string]$DefaultValue
  )

  $processValue = [Environment]::GetEnvironmentVariable($Key, "Process")
  if ($null -ne $processValue -and $processValue -ne "") {
    return $processValue
  }

  if (Test-Path -LiteralPath $envFile) {
    $line = Get-Content -LiteralPath $envFile | Where-Object { $_ -match "^$([regex]::Escape($Key))=" } | Select-Object -Last 1
    if ($line) {
      return ($line -replace "^$([regex]::Escape($Key))=", "")
    }
  }

  return $DefaultValue
}

function Set-EnvValue {
  param(
    [string]$Key,
    [string]$Value
  )

  if (-not (Test-Path -LiteralPath $envFile)) {
    New-Item -ItemType File -Path $envFile -Force | Out-Null
  }

  $pattern = "(?m)^$([regex]::Escape($Key))=.*$"
  $line = "$Key=$Value"
  $content = Get-Content -LiteralPath $envFile -Raw

  if ($content -match $pattern) {
    $content = [regex]::Replace($content, $pattern, [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $line })
  } else {
    if ($content.Length -gt 0 -and -not $content.EndsWith("`n")) {
      $content += "`n"
    }
    $content += "$line`n"
  }

  Set-Content -LiteralPath $envFile -Value $content -NoNewline
}

function Get-PublishedPortForContainer {
  param(
    [string]$Container,
    [int]$TargetPort
  )

  try {
    $ports = @(docker port $Container "$TargetPort/tcp" 2>$null)
  } catch {
    return ""
  }

  if ($LASTEXITCODE -ne 0 -or -not $ports) {
    return ""
  }

  $output = $ports[0]
  if ($output -match ':(\d+)$') {
    return $Matches[1]
  }

  return ""
}

function Test-PortInUse {
  param([int]$Port)

  $connections = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
  return $null -ne $connections
}

function Get-NumericOrDefault {
  param(
    [string]$Value,
    [int]$DefaultValue
  )

  $parsed = 0
  if ([int]::TryParse($Value, [ref]$parsed)) {
    return $parsed
  }
  return $DefaultValue
}

function Get-HostNvidiaGpus {
  if (-not (Get-Command nvidia-smi -ErrorAction SilentlyContinue)) {
    return ""
  }

  $rows = & nvidia-smi --query-gpu=index,name,memory.total --format=csv,noheader,nounits 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $rows) {
    return ""
  }

  $items = foreach ($row in $rows) {
    $parts = $row -split ","
    if ($parts.Count -ge 2) {
      $index = $parts[0].Trim()
      $name = $parts[1].Trim()
      $memory = if ($parts.Count -ge 3) { $parts[2].Trim() } else { "" }
      if ($index -ne "" -and $name -ne "") {
        "$index|$name|$memory"
      }
    }
  }

  return ($items -join ";")
}

function Test-DockerGpuAvailable {
  $runtimes = docker info --format '{{json .Runtimes}}' 2>$null
  if ($LASTEXITCODE -ne 0 -or $runtimes -notmatch '"nvidia"') {
    return $false
  }

  try {
    docker run --rm --gpus all --entrypoint nvidia-smi nvidia/cuda:12.8.0-base-ubuntu24.04 -L *> $null
    return $LASTEXITCODE -eq 0
  } catch {
    return $false
  }
}

function Save-MinioPorts {
  param(
    [int]$Port,
    [int]$ConsolePort
  )

  Set-EnvValue "MINIO_PORT" "$Port"
  Set-EnvValue "MINIO_CONSOLE_PORT" "$ConsolePort"
  Set-EnvValue "S3_ENDPOINT" "http://localhost:$Port"
}

function Configure-MinioPorts {
  $requestedPort = Get-NumericOrDefault (Get-EnvValue "MINIO_PORT" "9000") 9000
  $requestedConsole = Get-NumericOrDefault (Get-EnvValue "MINIO_CONSOLE_PORT" "9001") 9001
  $existingPort = Get-PublishedPortForContainer "anotator-dev-minio-1" 9000
  $existingConsole = Get-PublishedPortForContainer "anotator-dev-minio-1" 9001

  if ($existingPort -and $existingConsole) {
    $env:MINIO_PORT = $existingPort
    $env:MINIO_CONSOLE_PORT = $existingConsole
    Save-MinioPorts $existingPort $existingConsole
    return
  }

  if (-not (Test-PortInUse $requestedPort) -and -not (Test-PortInUse $requestedConsole)) {
    $env:MINIO_PORT = "$requestedPort"
    $env:MINIO_CONSOLE_PORT = "$requestedConsole"
    Save-MinioPorts $requestedPort $requestedConsole
    return
  }

  $candidate = $requestedPort
  while ((Test-PortInUse $candidate) -or (Test-PortInUse ($candidate + 1))) {
    $candidate += 2
  }

  $env:MINIO_PORT = "$candidate"
  $env:MINIO_CONSOLE_PORT = "$($candidate + 1)"
  Save-MinioPorts $candidate ($candidate + 1)
  Write-Host "Portas do MinIO $requestedPort/$requestedConsole ocupadas; usando $candidate/$($candidate + 1) nesta execucao."
}

function Configure-GpuRuntime {
  param([System.Collections.Generic.List[string]]$ComposeFiles)

  $mode = (Get-EnvValue "ENABLE_GPU" "auto").ToLowerInvariant()
  $env:HOST_NVIDIA_GPUS = Get-HostNvidiaGpus
  $env:ANOTATOR_DOCKER_GPU_ENABLED = "false"

  if ($mode -in @("false", "0", "no")) {
    return
  }

  if (-not $env:HOST_NVIDIA_GPUS) {
    if ($mode -in @("true", "1", "yes")) {
      throw "ENABLE_GPU=true, mas nenhuma GPU NVIDIA foi detectada pelo nvidia-smi no host."
    }
    return
  }

  Write-Host "GPU NVIDIA detectada no host: $env:HOST_NVIDIA_GPUS"
  if (Test-DockerGpuAvailable) {
    $env:ANOTATOR_DOCKER_GPU_ENABLED = "true"
    $ComposeFiles.Add("-f")
    $ComposeFiles.Add((Join-Path $root "infra\docker-compose.gpu.yml"))
    Write-Host "Docker com GPU habilitada; backend e worker usarao imagem CUDA."
    return
  }

  if ($mode -in @("true", "1", "yes")) {
    throw "ENABLE_GPU=true, mas o Docker nao aceita --gpus all. Instale/configure o NVIDIA Container Toolkit e rode .\start.ps1 novamente."
  }

  Write-Host "Aviso: a GPU existe no host, mas o Docker nao tem acesso a ela. A aplicacao subira em CPU."
  Write-Host "Para usar GPU no treino, instale/configure o NVIDIA Container Toolkit."
}

function Ensure-LocalCvatToken {
  $names = docker ps --format '{{.Names}}'
  if ($names -notcontains "cvat_server") {
    return
  }

  $py = "from django.contrib.auth import get_user_model; from rest_framework.authtoken.models import Token; User=get_user_model(); user=User.objects.filter(is_superuser=True,is_active=True).order_by('id').first(); token=Token.objects.get_or_create(user=user)[0] if user else None; print('ANOTATOR_CVAT_TOKEN=' + token.key) if token else None; print('ANOTATOR_CVAT_USER=' + user.username) if user else None"

  for ($attempt = 1; $attempt -le 30; $attempt++) {
    try {
      $output = docker exec cvat_server python3 /home/django/manage.py shell -c $py 2>$null
    } catch {
      $output = @()
    }
    $token = ($output | Where-Object { $_ -like "ANOTATOR_CVAT_TOKEN=*" } | Select-Object -First 1) -replace "^ANOTATOR_CVAT_TOKEN=", ""
    $username = ($output | Where-Object { $_ -like "ANOTATOR_CVAT_USER=*" } | Select-Object -First 1) -replace "^ANOTATOR_CVAT_USER=", ""

    if ($token) {
      Set-EnvValue "CVAT_ACCESS_TOKEN" $token
      Set-EnvValue "CVAT_AUTH_SCHEME" "Token"
      if (-not $username) {
        $username = "admin"
      }
      Write-Host "Token do CVAT local atualizado no .env para o usuario $username."
      return
    }

    Start-Sleep -Seconds 2
  }

  Write-Host "Aviso: nao consegui gerar token local do CVAT. Crie um superusuario no CVAT e preencha CVAT_ACCESS_TOKEN no .env."
}

Require-Command "docker"

docker info *> $null
if ($LASTEXITCODE -ne 0) {
  throw "Docker nao esta respondendo. Abra/inicie o Docker e rode .\start.ps1 novamente."
}

if (-not (Test-Path -LiteralPath $envFile)) {
  $example = Join-Path $root ".env.example"
  if (-not (Test-Path -LiteralPath $example)) {
    throw "Nao encontrei .env nem .env.example na raiz do projeto."
  }
  Copy-Item -LiteralPath $example -Destination $envFile
  Write-Host "Criei .env a partir de .env.example."
  Write-Host "Preencha CVAT_ACCESS_TOKEN no .env para importar/sincronizar dados do CVAT."
}

Configure-MinioPorts

if ($resetDb) {
  $resetArgs = @("-ConfirmReset")
  if ($skipDbResetBackup) {
    $resetArgs += "-SkipBackup"
  }
  & (Join-Path $PSScriptRoot "reset-local-db.ps1") @resetArgs
}

if (-not $skipCvat) {
  if (-not (Test-Path -LiteralPath $cvatDir)) {
    Require-Command "git"
    New-Item -ItemType Directory -Path (Split-Path -Parent $cvatDir) -Force | Out-Null
    Write-Host "Clonando CVAT em $cvatDir..."
    git clone https://github.com/cvat-ai/cvat $cvatDir
  } else {
    Write-Host "Usando CVAT existente em $cvatDir"
  }

  Write-Host "Subindo CVAT..."
  $cvatCompose = @("-f", "docker-compose.yml")
  if ($withServerless) {
    $cvatCompose += @("-f", "components/serverless/docker-compose.serverless.yml")
  }

  Push-Location $cvatDir
  try {
    docker compose @cvatCompose up -d
  } finally {
    Pop-Location
  }

  Ensure-LocalCvatToken
}

Write-Host "Subindo stack da aplicacao..."
$appComposeFiles = [System.Collections.Generic.List[string]]::new()
$appComposeFiles.Add("-f")
$appComposeFiles.Add((Join-Path $root "infra\docker-compose.dev.yml"))
Configure-GpuRuntime $appComposeFiles

$compose = @("compose", "--env-file", $envFile) + $appComposeFiles + @("up", "-d")
if ($build) {
  $compose += "--build"
}
docker @compose

$frontendPort = Get-EnvValue "FRONTEND_PORT" "3000"
$backendPort = Get-EnvValue "BACKEND_PORT" "8020"
$mlflowPort = Get-EnvValue "MLFLOW_PORT" "5000"
$minioConsolePort = Get-EnvValue "MINIO_CONSOLE_PORT" "9001"

if (-not (Get-EnvValue "CVAT_ACCESS_TOKEN" "")) {
  Write-Host ""
  Write-Host "Aviso: CVAT_ACCESS_TOKEN esta vazio no .env. A UI sobe, mas sync/importacao do CVAT podem falhar."
}

Write-Host ""
Write-Host "Tudo subindo. Acesse:"
Write-Host "Frontend: http://localhost:$frontendPort"
Write-Host "Backend:  http://localhost:$backendPort/docs"
Write-Host "CVAT:     http://localhost:8080"
Write-Host "MLflow:   http://localhost:$mlflowPort"
Write-Host "MinIO:    http://localhost:$minioConsolePort"
Write-Host ""
Write-Host "Para ver status:"
Write-Host "docker compose --env-file .env -f infra/docker-compose.dev.yml ps"
