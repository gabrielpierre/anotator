# Plano de Implementacao do Backend CVAT

## Estado desta implementacao

Esta implementacao entrega a fundacao executavel do plano e todos os marcos do plano inicial: backend FastAPI separado, modelos persistentes, endpoints publicos iniciais, cliente CVAT por REST, Celery/Redis, infraestrutura local, scripts de desenvolvimento, contrato TypeScript manual inicial, integracao progressiva no frontend, hardening local e documentacao operacional.

Marcos 1, 2, 3, 4, 5, 6, 7 e 8 implementados no repositorio:

- Sync idempotente de Projects, Tasks, Jobs, Labels, Data Meta e Previews usando API/REST do CVAT.
- Modelos locais para labels, metadados de midia e previews, com `external_id`/`task_external_id`.
- Proxy de preview pelo backend em `GET /api/v1/tasks/{task_id}/preview`.
- Fila de revisao derivada de shapes, tracks e tags CVAT sincronizados.
- Decisoes `accepted`, `rejected`, `corrected`, `uncertain`, `escalated` persistidas localmente.
- `accepted`, `rejected` e `corrected` sincronizam com CVAT via `PATCH /api/jobs/{id}/annotations/?action=update|delete`, evitando `PUT`/replace.
- Registro de `ReviewDecision`, `AnnotationRevision`, `TrackRevision` e eventos de auditoria.
- Telas Dados, Anotar, Revisar, Jobs e Visao Geral consumindo a API real quando ha dados sincronizados.
- `DatasetRelease` imutavel com snapshot de tasks, jobs, labels, splits, contagens e origem CVAT.
- Export CVAT por task usando a API de dataset export e armazenamento de artefatos em MinIO/S3.
- Snapshot de QA com Ground Truth jobs sincronizados e relatorios de qualidade quando configurados no CVAT.
- Tela Releases consumindo API real e criando releases a partir das tasks sincronizadas.
- Treino bloqueado para releases que nao estejam `ready`, imutaveis e com artefato exportado.
- Maquina de estados de jobs: `queued`, `running`, `paused`, `succeeded`, `failed`, `canceled`.
- Celery/Redis integrado para sync CVAT, build de release/export, training runs e pipeline runs.
- Endpoints de jobs para leitura, cancelamento e SSE: `/jobs/events` e `/jobs/{id}/events`.
- Central de jobs consumindo eventos em tempo real e cancelando jobs nao finais.
- Worker de inferencia Ultralytics para deteccao, segmentacao, classificacao e tracking.
- Sugestoes persistidas em `InferenceSuggestion`, preservando modelo, versao, threshold, NMS, score, usuario e timestamp.
- Politica segura de autoanotacao: append por padrao; replace apenas com `confirm_replace=true` e restrito a sugestoes do mesmo modelo/camada.
- Endpoints de inferencia: `POST /api/v1/inference-runs`, `GET /api/v1/inference-runs/suggestions`, `DELETE /api/v1/inference-runs/suggestions`.
- Tela Anotar enfileira inferencia real, recarrega sugestoes por SSE de jobs e mantem camadas por modelo.
- Worker de treinamento Ultralytics enfileirado por Celery e vinculado obrigatoriamente a `DatasetRelease` pronto, imutavel e com artefatos.
- Logging de params, metricas e artefatos no MLflow, com `mlflow_run_id` persistido em `TrainingRun`.
- Registro local de `ModelVersion` ao final do treino, com metricas, params, artifact URI e vinculo com release e run.
- SSE de treino em `GET /api/v1/training-runs/{id}/events` para progresso, status, metricas e artefatos.
- Telas Treinar, Detalhe do treino e Modelos consumindo training runs e model versions reais quando o backend esta disponivel.
- `PipelineDefinition` persistente e `PipelineRun` com grafo simples detecção -> filtro -> crop -> classificação -> revisão -> release.
- `DerivedAsset` com linhagem de imagem/anotação/track, padding, classe, score, modelo, split e correções humanas.
- Materialização de dataset derivado de classificação com manifesto JSON, previews SVG, split estável por track e `DatasetRelease` próprio.
- Endpoints de pipeline definitions, pipeline runs e derived assets, com a tela Dados podendo enfileirar o pipeline derivado e listar crops recentes.
- Fallback operacional de mocks desligado por padrao via `NEXT_PUBLIC_ENABLE_MOCK_FALLBACK=false`; fixtures ficam disponiveis apenas para demo explicita.
- Autenticacao interna opcional por `INTERNAL_API_KEY`, com suporte a header, bearer token e query param para SSE/imagens.
- Guia operacional em `docs/setup-operacional-local.md`, cobrindo setup, variaveis, troubleshooting, backup local e limites conhecidos.
- Criacao de projeto local com pasta planejada e quota de storage por projeto, persistida em `Project.raw.storage`.

Crop pixel-real a partir dos frames originais permanece como limite conhecido de hardening incremental, mas o Marco 8 operacional esta implementado.

## Resumo

- O CVAT permanece como fonte operacional para projetos, tasks, jobs, midia, labels, shapes, tracks, revisao e QA.
- O backend proprio passa a orquestrar sincronizacao, decisoes de revisao, auditoria, releases, jobs, training runs e pipeline runs.
- O frontend Next.js deixa de depender operacionalmente de `lib/mock-data.ts` e passa a consumir `NEXT_PUBLIC_API_BASE_URL`; fixtures so aparecem quando `NEXT_PUBLIC_ENABLE_MOCK_FALLBACK=true`.
- O ambiente local alvo usa Docker Desktop/WSL com CVAT local separado e stack propria em `infra/docker-compose.dev.yml`.

## Arquitetura

- `backend/`: FastAPI, Pydantic v2, SQLAlchemy 2, Alembic, Celery, Redis, Postgres, `cvat-sdk`, MLflow e Ultralytics.
- `infra/docker-compose.dev.yml`: frontend, backend, worker, Postgres, Redis, MinIO, bucket initializer e MLflow.
- `scripts/dev/setup-cvat.ps1`: clona e sobe a stack oficial do CVAT em `.local/cvat`.
- `scripts/dev/up.ps1`: sobe CVAT e a stack da aplicacao.
- `scripts/dev/down.ps1`: derruba a stack da aplicacao e opcionalmente o CVAT.
- `scripts/dev/export-openapi.ps1`: exporta OpenAPI e gera tipos TypeScript via `openapi-typescript`.

## API inicial

- `GET /api/v1/health`
- `GET /api/v1/cvat/status`
- `POST /api/v1/cvat/sync`
- `POST /api/v1/cvat/sync/jobs`
- `GET /api/v1/projects`
- `GET /api/v1/projects/{id}/dashboard`
- `GET /api/v1/tasks`
- `GET /api/v1/tasks/{id}`
- `GET /api/v1/tasks/{id}/data-meta`
- `GET /api/v1/tasks/{id}/preview`
- `GET /api/v1/jobs`
- `GET /api/v1/jobs/events`
- `GET /api/v1/jobs/{id}`
- `GET /api/v1/jobs/{id}/events`
- `POST /api/v1/jobs/{id}/cancel`
- `POST /api/v1/inference-runs`
- `GET /api/v1/inference-runs/suggestions`
- `DELETE /api/v1/inference-runs/suggestions`
- `GET /api/v1/labels`
- `GET /api/v1/review/queue`
- `GET /api/v1/review/annotations`
- `GET /api/v1/review/decisions`
- `POST /api/v1/review/decisions`
- `GET /api/v1/review/annotation-revisions`
- `GET /api/v1/review/track-revisions`
- `GET /api/v1/dataset-releases`
- `POST /api/v1/dataset-releases`
- `GET /api/v1/training-runs`
- `GET /api/v1/training-runs/{id}`
- `POST /api/v1/training-runs`
- `GET /api/v1/training-runs/{id}/events`
- `GET /api/v1/models`
- `GET /api/v1/pipeline-definitions`
- `POST /api/v1/pipeline-definitions`
- `GET /api/v1/derived-assets`
- `GET /api/v1/pipeline-runs`
- `GET /api/v1/pipeline-runs/{id}`
- `POST /api/v1/pipeline-runs`

## Marcos de entrega

### Marco 0 - Fundacao local

- Criar backend FastAPI minimo, banco, migrations, healthcheck, CORS e cliente CVAT por token.
- Subir CVAT local via Docker conforme documentacao oficial, sem acessar diretamente o banco interno do CVAT.
- DoD: `scripts/dev/up.ps1` inicia stack local, FastAPI responde, CVAT responde e backend valida conectividade.

### Marco 1 - Sincronizacao CVAT core

- Mapear CVAT Projects, Tasks, Jobs, Labels, Data Meta e Previews para modelos locais.
- Implementar sync idempotente com `external_id`, timestamps e eventos de auditoria.
- Atualizar telas Dados, Anotar, Revisar, Jobs e Visao Geral para consumir API real em modo read-only.
- DoD: UI lista dados reais de uma task CVAT local apos `POST /api/v1/cvat/sync`.

### Marco 2 - Revisao e auditoria

- Implementar fila de revisao baseada em jobs/anotacoes CVAT.
- Persistir decisoes: `accepted`, `rejected`, `corrected`, `uncertain`, `escalated`.
- Atualizar anotacoes por operacao incremental, evitando import/replace destrutivo.
- DoD: aceitar/rejeitar/corrigir uma anotacao na UI altera estado local, registra auditoria e sincroniza com CVAT.
- Status: implementado para shapes/tracks/tags sincronizados. `uncertain` e `escalated` ficam registrados localmente sem patch CVAT ate existir uma politica de atributo/label dedicada.

### Marco 3 - Releases e QA

- Implementar `DatasetRelease` imutavel ligado a project/task/job IDs CVAT e snapshot de labels/splits.
- Gerar export CVAT em formatos suportados e armazenar artefatos no MinIO.
- Integrar Ground Truth jobs e metricas de qualidade quando configurados no CVAT.
- DoD: criar um release a partir de uma task CVAT, exportar artefatos e bloquear treino contra dataset vivo.
- Status: implementado. Desde o Marco 4, `POST /api/v1/dataset-releases` cria o release em `building`, enfileira o export no Celery e expõe progresso/cancelamento pela Central de Jobs.

### Marco 4 - Jobs assincronos e eventos em tempo real

- Implementar maquina de estados: `queued`, `running`, `paused`, `succeeded`, `failed`, `canceled`.
- Usar Celery/Redis para sync, export, release, inferencia, treino e pipelines.
- Expor eventos via SSE para progresso, logs e metricas.
- DoD: Central de jobs mostra progresso real de jobs backend e permite cancelar jobs nao finais.
- Status: implementado para sync CVAT, releases, training runs, inferencia e pipeline runs.

### Marco 5 - Auto-anotacao e inferencia

- Criar worker Ultralytics para deteccao, classificacao, segmentacao e tracking.
- Integrar propostas como sugestoes, preservando modelo, versao, threshold, NMS, score, usuario e timestamp.
- Respeitar politica segura: append por padrao; replace apenas com confirmacao explicita.
- DoD: UI gera sugestoes reais em uma task CVAT e mantem camadas por modelo.
- Status: implementado. O worker usa frames da task CVAT quando disponiveis, cai para preview quando necessario, executa Ultralytics e grava sugestoes locais por camada/modelo. Escrita em CVAT e suportada de forma append-only quando `write_to_cvat=true` e `cvat_job_id` e labels CVAT estao disponiveis.

### Marco 6 - Treinamento e MLflow

- Implementar `TrainingRun`, configuracao de treino, resource policy e vinculo obrigatorio com `DatasetRelease`.
- Rodar Ultralytics em worker, logar params/metricas/artefatos no MLflow e publicar metricas por epoca.
- Alimentar telas Treinar, Detalhe do treino, Modelos e evolucao historica com MLflow + banco local.
- DoD: iniciar treino de um release, acompanhar metricas ao vivo e registrar `ModelVersion`.
- Status: implementado. `POST /api/v1/training-runs` cria run e job Celery, valida release pronto/imutavel, executa Ultralytics no worker, registra params/metricas/artefatos no MLflow e cria `ModelVersion`. A preparacao de dataset gera uma estrutura YOLO basica a partir do snapshot; para datasets reais exportados do CVAT, a config pode sobrescrever `ultralytics.data` apontando para um `data.yaml` materializado.

### Marco 7 - Pipelines e datasets derivados

- Implementar `PipelineDefinition` e `PipelineRun` como grafo simples.
- Entrega inicial: deteccao -> filtro -> crop -> classificacao -> revisao -> release.
- Criar `DerivedAsset` com linhagem: imagem, anotacao, track, padding, classe, modelo, score e correcoes humanas.
- Para video, amostrar crops por track e manter todos os crops do mesmo track no mesmo split.
- DoD: gerar dataset derivado de classificacao com preview, auditoria e release proprio.
- Status: implementado. O worker materializa assets derivados a partir de `AnnotationRecord`, preserva split por track, grava manifesto e previews no artifact store, registra auditoria e cria um `DatasetRelease` derivado pronto. A primeira versão usa previews SVG e metadados de crop; extração pixel-real dos frames fica para hardening.

### Marco 8 - Hardening

- Remover dependencia operacional de mocks, mantendo apenas fixtures de teste.
- Adicionar autenticacao interna simples ou integracao futura com usuarios CVAT.
- Documentar setup, variaveis, troubleshooting, backup local e limites conhecidos.
- DoD: novo dev consegue subir ambiente local, criar task CVAT, revisar, gerar release e iniciar treino seguindo o README.
- Status: implementado. O backend tem auth opcional por `INTERNAL_API_KEY`, o frontend envia a chave quando configurada, mocks nao entram como fallback padrao, projetos podem ter pasta/quota de storage e o setup operacional esta documentado em `docs/setup-operacional-local.md`.

## Testes e aceitacao

- Backend: `pytest`, testes unitarios de schemas, mappers CVAT, sync, decisoes, releases, jobs e pipelines.
- Contratos: validacao contra FastAPI OpenAPI e cliente TypeScript gerado.
- Integracao: suite com CVAT local e dataset pequeno de fixtures para projects/tasks/jobs/annotations.
- Frontend: smoke E2E das rotas `/dados`, `/anotar`, `/revisar`, `/jobs`, `/releases`, `/treinar`.
- Aceitacao final: criar/importar task no CVAT, sincronizar, revisar anotacoes, auditar decisoes, criar release, rodar pipeline simples e iniciar treino com MLflow.

## Assumptions

- Primeira versao e dev local completo, nao staging remoto.
- CVAT e dependencia externa local via Docker, nao vendorizado no repo.
- A aplicacao nao escreve diretamente no banco do CVAT; usa REST API/SDK.
- Operacoes destrutivas de anotacao ficam fora do MVP ou exigem confirmacao explicita.
- Comparacao historica de modelos exige `DatasetRelease` imutavel e validacao fixa.
