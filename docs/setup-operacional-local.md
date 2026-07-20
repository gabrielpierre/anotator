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
| `CVAT_ACCESS_TOKEN` | Token usado pelo backend para chamar a API do CVAT. |
| `INTERNAL_API_KEY` | Chave opcional para proteger a API local. Se vazia, auth interna fica desligada. |
| `NEXT_PUBLIC_INTERNAL_API_KEY` | Mesma chave para o frontend chamar a API quando `INTERNAL_API_KEY` estiver ativa. |
| `NEXT_PUBLIC_ENABLE_MOCK_FALLBACK` | `false` por padrao. Use `true` apenas para demo visual offline. |
| `DATABASE_URL` | Postgres local da stack propria. |
| `REDIS_URL` | Broker/result backend do Celery. |
| `MLFLOW_TRACKING_URI` | Tracking server do MLflow. |
| `S3_ENDPOINT` / `S3_BUCKET` | MinIO para releases, datasets derivados e artefatos MLflow. |

## Subida

```powershell
$env:CVAT_ACCESS_TOKEN = "<token>"
.\scripts\dev\up.ps1
```

URLs:

- Frontend: `http://localhost:3000`
- Backend docs: `http://localhost:8000/docs`
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

## Autenticacao interna

Para proteger a API local, defina a mesma chave para backend e frontend:

```powershell
$env:INTERNAL_API_KEY = "dev-local-secret"
$env:NEXT_PUBLIC_INTERNAL_API_KEY = "dev-local-secret"
.\scripts\dev\up.ps1
```

O backend aceita:

- Header `X-API-Key: <chave>`
- Header `Authorization: Bearer <chave>`
- Query `?api_key=<chave>` para SSE e imagens carregadas pelo navegador

Rotas isentas por padrao: `/api/v1/health`, `/docs`, `/redoc`, `/openapi.json`.

## Mocks

O frontend nao usa mocks como fallback operacional por padrao. Se o backend estiver fora, as telas mostram estados vazios.

Para demo visual offline:

```powershell
$env:NEXT_PUBLIC_ENABLE_MOCK_FALLBACK = "true"
pnpm dev
```

Fixtures devem permanecer em `lib/mock-data.ts` e nao devem ser usadas para mascarar falhas de API em operacao normal.

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

- Backend `401`: confira `INTERNAL_API_KEY` e `NEXT_PUBLIC_INTERNAL_API_KEY`.
- CVAT `authenticated=false`: gere novo token no CVAT e reinicie backend/worker.
- Releases travados em `building`: verifique worker Celery e Redis em `/jobs` e logs do container `worker`.
- MinIO sem artefatos: confirme `S3_ENDPOINT`, credenciais e bucket `anotator-artifacts`.
- MLflow sem metricas: confirme `MLFLOW_TRACKING_URI` e logs do worker de treino.
- Frontend sem dados: execute sync CVAT e confirme que `NEXT_PUBLIC_ENABLE_MOCK_FALLBACK=false` nao esta escondendo a falta de dados reais.

## Limites conhecidos

- Autenticacao interna e uma chave compartilhada local, nao RBAC.
- Usuarios CVAT ainda nao sao federados como usuarios internos.
- Datasets derivados gravam metadados e previews; crop pixel-real dos frames originais ainda e item de hardening.
- Treino Ultralytics aceita override `config.ultralytics.data` para `data.yaml` materializado.
- Operacoes destrutivas de anotacao continuam fora do padrao e exigem confirmacao explicita.
