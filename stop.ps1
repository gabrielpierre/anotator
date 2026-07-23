$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path $root "scripts\dev\down.ps1"

& $script @args
exit $LASTEXITCODE
