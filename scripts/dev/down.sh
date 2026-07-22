#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
CVAT_DIR="$ROOT_DIR/.local/cvat"

KEEP_CVAT=0
VOLUMES=0
WITH_SERVERLESS=0

usage() {
  cat <<'EOF'
Uso:
  ./stop.sh [opcoes]

Opcoes:
  --keep-cvat       Para apenas a aplicacao, mantendo o CVAT rodando.
  --volumes         Remove volumes Docker tambem. Apaga banco/artefatos locais.
  --with-serverless Usa tambem o compose serverless do CVAT ao parar.
  -h, --help        Mostra esta ajuda.

Exemplos:
  ./stop.sh
  ./stop.sh --keep-cvat
  ./stop.sh --volumes
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep-cvat)
      KEEP_CVAT=1
      shift
      ;;
    --volumes)
      VOLUMES=1
      shift
      ;;
    --with-serverless)
      WITH_SERVERLESS=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Opcao desconhecida: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Comando obrigatorio nao encontrado: $1" >&2
    exit 1
  fi
}

require_command docker

if ! docker info >/dev/null 2>&1; then
  echo "Docker nao esta respondendo. Abra/inicie o Docker e rode ./stop.sh novamente." >&2
  exit 1
fi

app_compose=(docker compose)
if [[ -f "$ENV_FILE" ]]; then
  app_compose+=(--env-file "$ENV_FILE")
fi
app_compose+=(-f "$ROOT_DIR/infra/docker-compose.dev.yml")

down_args=(down)
if [[ "$VOLUMES" -eq 1 ]]; then
  echo "Aviso: --volumes remove banco, Redis, MinIO, MLflow e node_modules persistidos da stack local."
  down_args+=(-v)
fi

echo "Parando stack da aplicacao..."
"${app_compose[@]}" "${down_args[@]}"

if [[ "$KEEP_CVAT" -eq 0 ]]; then
  if [[ -d "$CVAT_DIR" ]]; then
    echo "Parando CVAT..."
    cvat_compose=(-f docker-compose.yml)
    if [[ "$WITH_SERVERLESS" -eq 1 ]]; then
      cvat_compose+=(-f components/serverless/docker-compose.serverless.yml)
    fi
    cvat_down_args=(down)
    if [[ "$VOLUMES" -eq 1 ]]; then
      echo "Aviso: --volumes tambem remove volumes locais do CVAT."
      cvat_down_args+=(-v)
    fi
    (
      cd "$CVAT_DIR"
      docker compose "${cvat_compose[@]}" "${cvat_down_args[@]}"
    )
  else
    echo "CVAT nao encontrado em $CVAT_DIR; nada para parar."
  fi
fi

echo ""
echo "Tudo finalizado."
if [[ "$VOLUMES" -eq 0 ]]; then
  echo "Volumes preservados. Rode ./start.sh para subir novamente com os mesmos dados."
fi
