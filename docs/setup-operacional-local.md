# Setup operacional local

Este guia descreve o caminho suportado para um dev subir o ambiente local, revisar dados do CVAT, gerar releases, iniciar treino e criar datasets derivados.

## Requisitos

- Windows com Docker Desktop e WSL habilitado.
- Conda env `anot` criado para comandos locais.
- Token de acesso do CVAT em `CVAT_ACCESS_TOKEN`.
- Portas livres: `3000`, `8000`, `8080`, `5000`, `5433`, `6380`, `9000`, `9001`.

## Variaveis

Copie `.env.example` e preencha os valores necessarios.

| Variavel | Uso |
| --- | --- |
| `CVAT_BASE_URL` | URL do CVAT local. Padrao: `http://localhost:8080`. |
| `CVAT_ACCESS_TOKEN` | Token usado pelo backend para chamar a API do CVAT. No CVAT local, `./start.sh` atualiza esse valor automaticamente quando encontra um superusuario ativo. |
| `CVAT_AUTH_SCHEME` | Esquema do token CVAT. Padrao local: `Token`. |
| `INTERNAL_API_KEY` | Chave opcional para proteger a API local. Se vazia, auth interna fica desligada. |
| `NEXT_PUBLIC_INTERNAL_API_KEY` | Mesma chave para o frontend chamar a API quando `INTERNAL_API_KEY` estiver ativa. |
| `AUTO_CREATE_TABLES` | Deve ficar `false`; schemas sobem por Alembic. |
| `DEFAULT_ADMIN_EMAIL` / `DEFAULT_ADMIN_PASSWORD` | Admin inicial criado quando o banco migrado ainda nao tem usuarios. |
| `DATABASE_URL` | Postgres local da stack propria. |
| `REDIS_URL` | Broker/result backend do Celery. |
| `MLFLOW_TRACKING_URI` | Tracking server do MLflow. |
| `S3_ENDPOINT` / `S3_BUCKET` | MinIO para releases, datasets derivados e artefatos MLflow. |
| `FRONTEND_PORT`, `BACKEND_PORT`, `POSTGRES_PORT`, `REDIS_PORT`, `MINIO_PORT`, `MINIO_CONSOLE_PORT`, `MLFLOW_PORT` | Portas publicadas pelo Compose local. Ajuste se houver conflito. |

## Subida rapida

No Linux/WSL, o caminho recomendado para uso diario e um unico comando na raiz do projeto:

```bash
./start.sh
```

Esse comando sobe o CVAT em `.local/cvat` quando necessario e depois inicia frontend, backend, worker geral, worker de treino, Postgres, Redis, MinIO e MLflow. Se precisar rebuildar as imagens:

```bash
./start.sh --build
```

Quando o container `cvat_server` esta disponivel, o script cria ou reutiliza um token do superusuario ativo do CVAT e grava `CVAT_ACCESS_TOKEN`/`CVAT_AUTH_SCHEME=Token` no `.env`.

Se a porta externa do MinIO estiver ocupada por outro projeto, o script escolhe automaticamente o proximo par livre e mostra a URL correta no final da execucao.

Para subir apenas a stack da aplicacao, mantendo o CVAT como estiver:

```bash
./start.sh --skip-cvat
```

Para finalizar tudo sem apagar dados locais:

```bash
./stop.sh
```

Esse comando para a aplicacao e o CVAT, preservando os volumes Docker. Para parar apenas a aplicacao:

```bash
./stop.sh --keep-cvat
```

Use `./stop.sh --volumes` somente quando quiser apagar banco, MinIO, MLflow e dados locais do CVAT.

## Subida via PowerShell

```powershell
$env:CVAT_ACCESS_TOKEN = "<token>"
.\scripts\dev\up.ps1
```

O Compose executa `alembic upgrade head` antes de iniciar backend e workers. Para rodar manualmente:

```powershell
cd backend
alembic upgrade head
```

Se o banco local antigo precisar ser recriado para a baseline limpa, use:

```powershell
.\scripts\dev\up.ps1 -ResetDb
```

URLs:

- Frontend: `http://localhost:3000`
- Backend docs: `http://localhost:8020/docs`
- CVAT: `http://localhost:8080`
- MLflow: `http://localhost:5000`
- MinIO: `http://localhost:9001`

## Fluxo de aceitacao

1. Criar um projeto em `/` usando `Novo projeto`, escolhendo pasta e limite de storage.
2. Criar/importar uma task no CVAT.
3. Sincronizar pelo backend: `POST /api/v1/cvat/sync/jobs`.
4. Abrir `/dados`, `/anotar` e `/revisar` e confirmar que dados reais aparecem.
5. Criar um `DatasetRelease` em `/releases`.
6. Acompanhar o job em `/jobs` ate o release ficar `ready`.
7. Iniciar treino em `/treinar` usando o release pronto.
8. Acompanhar metricas em `/treinar/{id}` e confirmar `ModelVersion` em `/modelos`.
9. Em `/dados`, acionar `Dataset derivado` para gerar crops de classificacao e um release derivado.

## Storage por projeto

O botao `Novo projeto` registra uma politica de storage no backend:

- `storage.path`: pasta local planejada para o projeto.
- `storage.quota_gb`: limite maximo escolhido, por exemplo 30 GB ou 40 GB.
- `storage.quota_bytes`: mesmo limite em bytes.
- `storage.used_bytes`: uso conhecido pelo backend.
- `storage.enforce_quota`: indica que fluxos de dataset devem respeitar a quota.

Ao criar `DatasetRelease`, o backend estima o tamanho do release a partir das tasks sincronizadas e bloqueia a criacao quando `used_bytes + estimated_bytes` ultrapassa `quota_bytes`.

O navegador pode nao expor o caminho absoluto da pasta por seguranca. Quando isso acontecer, informe o caminho manualmente no campo de pasta.

## Baseline limpa de migrations

Esta versao usa uma baseline Alembic limpa. Em ambiente local antigo, faca backup antes de resetar o Postgres:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/dev/reset-local-db.ps1 -ConfirmReset
```

O script cria backup em `.local\backup`, remove apenas o volume `anotator-dev_postgres_data`, sobe um Postgres limpo e aplica `alembic upgrade head`. Para ambientes descartaveis, use `-SkipBackup`.

Se precisar restaurar dados antigos, restaure o backup em um banco separado e migre manualmente apenas os registros necessarios.

## Login e API key interna

O login real usa `POST /api/v1/auth/login`. A sessao retorna um token opaco salvo no navegador em `sessionStorage` e enviado como `Authorization: Bearer <token>`.

Admin inicial em banco vazio:

- `DEFAULT_ADMIN_EMAIL=admin@cvat.plus`
- `DEFAULT_ADMIN_PASSWORD=admin123`

Troque a senha inicial apos o primeiro acesso.

## Autenticacao interna

Para proteger a API local, defina a mesma chave para backend e frontend:

```powershell
$env:INTERNAL_API_KEY = "dev-local-secret"
$env:NEXT_PUBLIC_INTERNAL_API_KEY = "dev-local-secret"
.\scripts\dev\up.ps1
```

`INTERNAL_API_KEY` continua disponivel para automacao/dev, mas nao substitui RBAC de usuario. O backend aceita:

- Header `X-API-Key: <chave>`
- Header `Authorization: Bearer <chave>`
- Query `?api_key=<chave>` para SSE e imagens carregadas pelo navegador

Rotas isentas por padrao: `/api/v1/health`, `/api/v1/auth/login`, `/docs`, `/redoc`, `/openapi.json`.

## Dados reais

O frontend nao possui fallback de mocks. Todas as telas usam o backend como fonte de verdade; quando nao houver registro sincronizado, a tela mostra estado vazio, `--` ou uma mensagem operacional.

Para popular as telas, suba o backend, faca login, sincronize o CVAT e execute os fluxos reais de importacao, releases, treino, modelos, jobs e auditoria.

## Backup local

Backup do Postgres:

```powershell
docker compose -f infra/docker-compose.dev.yml exec postgres pg_dump -U anotator -d anotator > .local\backup\anotator.sql
```

Restore do Postgres:

```powershell
Get-Content .local\backup\anotator.sql | docker compose -f infra/docker-compose.dev.yml exec -T postgres psql -U anotator -d anotator
```

Backup de artefatos MinIO:

```powershell
docker compose -f infra/docker-compose.dev.yml run --rm createbuckets /usr/bin/mc mirror local/anotator-artifacts /tmp/anotator-artifacts
```

Em uso real, prefira copiar o volume `minio_data` ou configurar mirror externo do MinIO.

## Troubleshooting

- Backend `401`: faca login novamente ou confira `INTERNAL_API_KEY`/`NEXT_PUBLIC_INTERNAL_API_KEY` em automacoes.
- CVAT `authenticated=false`: gere novo token no CVAT e reinicie backend/worker.
- Releases travados em `building`: verifique o worker geral, Redis em `/jobs` e logs do container `worker`.
- MinIO sem artefatos: confirme `S3_ENDPOINT`, credenciais e bucket `anotator-artifacts`.
- MLflow/treino sem metricas: confirme `MLFLOW_TRACKING_URI` e logs do container `worker-training`.
- Treino parado antes da primeira epoca, com progresso fixo e sem metricas: verifique `/dev/shm` do `worker-training`. PyTorch DataLoader precisa de memoria compartilhada; o Compose local usa `TRAINING_SHM_SIZE=2gb` e limita workers por `TRAINING_GPU_MAX_WORKERS`/`TRAINING_MIN_SHM_PER_WORKER_MB`.
- Treino marcado como executando depois de processo morto: o backend usa heartbeat (`TRAINING_HEARTBEAT_SECONDS`) e considera jobs sem atualizacao por `JOB_STALE_AFTER_SECONDS` como obsoletos.
- Frontend sem dados: execute sync CVAT e confirme que o backend tem registros para a rota exibida.

## Limites conhecidos

- Usuarios CVAT ainda nao sao federados como usuarios internos.
- Operacoes de track `split`/`close` registram before/after local e exigem reconciliacao manual quando o CVAT nao aceitar sync direto.
- Operacoes destrutivas de anotacao continuam fora do padrao e exigem confirmacao explicita.
