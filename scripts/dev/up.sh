#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
CVAT_DIR="$ROOT_DIR/.local/cvat"

SKIP_CVAT=0
BUILD=0
WITH_SERVERLESS=0

usage() {
  cat <<'EOF'
Uso:
  ./start.sh [opcoes]

Opcoes:
  --build            Rebuilda backend/worker/frontend antes de subir.
  --skip-cvat        Sobe apenas a stack da aplicacao, sem iniciar o CVAT.
  --with-serverless  Sobe o CVAT com o compose serverless oficial.
  -h, --help         Mostra esta ajuda.

Exemplos:
  ./start.sh
  ./start.sh --build
  ./start.sh --skip-cvat
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --build)
      BUILD=1
      shift
      ;;
    --skip-cvat)
      SKIP_CVAT=1
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

env_value() {
  local key="$1"
  local default_value="$2"
  local line

  if [[ -n "${!key-}" ]]; then
    printf '%s' "${!key}"
    return
  fi

  if [[ -f "$ENV_FILE" ]]; then
    line="$(grep -E "^${key}=" "$ENV_FILE" | tail -n 1 || true)"
    if [[ -n "$line" ]]; then
      printf '%s' "${line#*=}"
      return
    fi
  fi

  printf '%s' "$default_value"
}

published_port_for_container() {
  local container="$1"
  local target_port="$2"

  docker port "$container" "${target_port}/tcp" 2>/dev/null | head -n 1 | awk -F: '{print $NF}'
}

port_in_use() {
  local port="$1"

  ss -ltnH 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]${port}$"
}

numeric_or_default() {
  local value="$1"
  local default_value="$2"

  if [[ "$value" =~ ^[0-9]+$ ]]; then
    printf '%s' "$value"
  else
    printf '%s' "$default_value"
  fi
}

set_env_value() {
  local key="$1"
  local value="$2"
  local escaped

  escaped="$(printf '%s' "$value" | sed -e 's/[\/&]/\\&/g')"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    sed -i -E "s/^${key}=.*/${key}=${escaped}/" "$ENV_FILE"
  else
    printf '\n%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

detect_host_nvidia_gpus() {
  if ! command -v nvidia-smi >/dev/null 2>&1; then
    return
  fi

  nvidia-smi --query-gpu=index,name,memory.total --format=csv,noheader,nounits 2>/dev/null \
    | awk -F, '{
        gsub(/^[ \t]+|[ \t]+$/, "", $1);
        gsub(/^[ \t]+|[ \t]+$/, "", $2);
        gsub(/^[ \t]+|[ \t]+$/, "", $3);
        if ($1 != "" && $2 != "") {
          printf "%s%s|%s|%s", sep, $1, $2, $3;
          sep=";";
        }
      }'
}

docker_gpu_available() {
  if ! docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -qi '"nvidia"'; then
    return 1
  fi
  docker run --rm --gpus all --entrypoint nvidia-smi nvidia/cuda:12.8.0-base-ubuntu24.04 -L >/dev/null 2>&1
}

persist_minio_ports() {
  local port="$1"
  local console_port="$2"

  set_env_value MINIO_PORT "$port"
  set_env_value MINIO_CONSOLE_PORT "$console_port"
  set_env_value S3_ENDPOINT "http://localhost:${port}"
}

configure_minio_ports() {
  local requested_port requested_console existing_port existing_console candidate

  requested_port="$(numeric_or_default "$(env_value MINIO_PORT 9000)" 9000)"
  requested_console="$(numeric_or_default "$(env_value MINIO_CONSOLE_PORT 9001)" 9001)"
  existing_port="$(published_port_for_container anotator-dev-minio-1 9000 || true)"
  existing_console="$(published_port_for_container anotator-dev-minio-1 9001 || true)"

  if [[ -n "$existing_port" && -n "$existing_console" ]]; then
    export MINIO_PORT="$existing_port"
    export MINIO_CONSOLE_PORT="$existing_console"
    persist_minio_ports "$MINIO_PORT" "$MINIO_CONSOLE_PORT"
    return
  fi

  if ! port_in_use "$requested_port" && ! port_in_use "$requested_console"; then
    export MINIO_PORT="$requested_port"
    export MINIO_CONSOLE_PORT="$requested_console"
    persist_minio_ports "$MINIO_PORT" "$MINIO_CONSOLE_PORT"
    return
  fi

  candidate="$requested_port"
  while port_in_use "$candidate" || port_in_use "$((candidate + 1))"; do
    candidate="$((candidate + 2))"
  done

  export MINIO_PORT="$candidate"
  export MINIO_CONSOLE_PORT="$((candidate + 1))"
  persist_minio_ports "$MINIO_PORT" "$MINIO_CONSOLE_PORT"
  echo "Portas do MinIO ${requested_port}/${requested_console} ocupadas; usando ${MINIO_PORT}/${MINIO_CONSOLE_PORT} nesta execucao."
}

configure_gpu_runtime() {
  local mode

  mode="$(env_value ENABLE_GPU auto)"
  mode="${mode,,}"
  export HOST_NVIDIA_GPUS
  HOST_NVIDIA_GPUS="$(detect_host_nvidia_gpus || true)"
  export ANOTATOR_DOCKER_GPU_ENABLED=false

  if [[ "$mode" == "false" || "$mode" == "0" || "$mode" == "no" ]]; then
    return
  fi

  if [[ -z "$HOST_NVIDIA_GPUS" ]]; then
    if [[ "$mode" == "true" || "$mode" == "1" || "$mode" == "yes" ]]; then
      echo "ENABLE_GPU=true, mas nenhuma GPU NVIDIA foi detectada pelo nvidia-smi no host." >&2
      exit 1
    fi
    return
  fi

  echo "GPU NVIDIA detectada no host: ${HOST_NVIDIA_GPUS}"
  if docker_gpu_available; then
    export ANOTATOR_DOCKER_GPU_ENABLED=true
    app_compose_files+=(-f "$ROOT_DIR/infra/docker-compose.gpu.yml")
    echo "Docker com GPU habilitada; backend e worker usarao imagem CUDA."
    return
  fi

  if [[ "$mode" == "true" || "$mode" == "1" || "$mode" == "yes" ]]; then
    echo "ENABLE_GPU=true, mas o Docker nao aceita --gpus all." >&2
    echo "Instale/configure o NVIDIA Container Toolkit e rode ./start.sh novamente." >&2
    exit 1
  fi

  echo "Aviso: a GPU existe no host, mas o Docker nao tem acesso a ela. A aplicacao subira em CPU."
  echo "Para usar GPU no treino, instale/configure o NVIDIA Container Toolkit."
}

ensure_local_cvat_token() {
  local token username

  if ! docker ps --format '{{.Names}}' | grep -qx 'cvat_server'; then
    return
  fi

  for _ in $(seq 1 30); do
    token="$(
      docker exec cvat_server bash -lc "python3 ~/manage.py shell -c \"
from django.contrib.auth import get_user_model
from rest_framework.authtoken.models import Token
User = get_user_model()
user = User.objects.filter(is_superuser=True, is_active=True).order_by('id').first()
if user:
    token, _ = Token.objects.get_or_create(user=user)
    print('ANOTATOR_CVAT_TOKEN=' + token.key)
    print('ANOTATOR_CVAT_USER=' + user.username)
\"" 2>/dev/null | awk -F= '/^ANOTATOR_CVAT_TOKEN=/{print $2; exit}'
    )"
    username="$(
      docker exec cvat_server bash -lc "python3 ~/manage.py shell -c \"
from django.contrib.auth import get_user_model
User = get_user_model()
user = User.objects.filter(is_superuser=True, is_active=True).order_by('id').first()
if user:
    print('ANOTATOR_CVAT_USER=' + user.username)
\"" 2>/dev/null | awk -F= '/^ANOTATOR_CVAT_USER=/{print $2; exit}'
    )"
    if [[ -n "$token" ]]; then
      set_env_value CVAT_ACCESS_TOKEN "$token"
      set_env_value CVAT_AUTH_SCHEME "Token"
      echo "Token do CVAT local atualizado no .env para o usuario ${username:-admin}."
      return
    fi
    sleep 2
  done

  echo "Aviso: nao consegui gerar token local do CVAT. Crie um superusuario no CVAT e preencha CVAT_ACCESS_TOKEN no .env."
}

require_command docker
require_command ss

if ! docker info >/dev/null 2>&1; then
  echo "Docker nao esta respondendo. Abra/inicie o Docker e rode ./start.sh novamente." >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  if [[ ! -f "$ROOT_DIR/.env.example" ]]; then
    echo "Nao encontrei .env nem .env.example na raiz do projeto." >&2
    exit 1
  fi
  cp "$ROOT_DIR/.env.example" "$ENV_FILE"
  echo "Criei .env a partir de .env.example."
  echo "Preencha CVAT_ACCESS_TOKEN no .env para importar/sincronizar dados do CVAT."
fi

configure_minio_ports

if [[ "$SKIP_CVAT" -eq 0 ]]; then
  if [[ ! -d "$CVAT_DIR" ]]; then
    require_command git
    mkdir -p "$(dirname "$CVAT_DIR")"
    echo "Clonando CVAT em $CVAT_DIR..."
    git clone https://github.com/cvat-ai/cvat "$CVAT_DIR"
  else
    echo "Usando CVAT existente em $CVAT_DIR"
  fi

  echo "Subindo CVAT..."
  cvat_compose=(-f docker-compose.yml)
  if [[ "$WITH_SERVERLESS" -eq 1 ]]; then
    cvat_compose+=(-f components/serverless/docker-compose.serverless.yml)
  fi
  (
    cd "$CVAT_DIR"
    docker compose "${cvat_compose[@]}" up -d
  )
  ensure_local_cvat_token
fi

echo "Subindo stack da aplicacao..."
app_compose_files=(-f "$ROOT_DIR/infra/docker-compose.dev.yml")
configure_gpu_runtime
app_compose=(docker compose --env-file "$ENV_FILE" "${app_compose_files[@]}")
up_args=(up -d)
if [[ "$BUILD" -eq 1 ]]; then
  up_args+=(--build)
fi
"${app_compose[@]}" "${up_args[@]}"

frontend_port="$(env_value FRONTEND_PORT 3000)"
backend_port="$(env_value BACKEND_PORT 8020)"
mlflow_port="$(env_value MLFLOW_PORT 5000)"
minio_console_port="$(env_value MINIO_CONSOLE_PORT 9001)"

if [[ -z "$(env_value CVAT_ACCESS_TOKEN "")" ]]; then
  echo ""
  echo "Aviso: CVAT_ACCESS_TOKEN esta vazio no .env. A UI sobe, mas sync/importacao do CVAT podem falhar."
fi

echo ""
echo "Tudo subindo. Acesse:"
echo "Frontend: http://localhost:${frontend_port}"
echo "Backend:  http://localhost:${backend_port}/docs"
echo "CVAT:     http://localhost:8080"
echo "MLflow:   http://localhost:${mlflow_port}"
echo "MinIO:    http://localhost:${minio_console_port}"
echo ""
echo "Para ver status:"
echo "docker compose --env-file .env -f infra/docker-compose.dev.yml ps"
