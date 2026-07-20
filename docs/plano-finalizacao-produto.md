# Plano de finalizacao do produto

Este documento define o plano executavel para fechar as lacunas restantes do projeto. O escopo e backend primeiro, com as integracoes minimas no frontend para validar cada fluxo ponta a ponta.

## Objetivo

Finalizar a aplicacao como uma camada de orquestracao confiavel sobre CVAT, Ultralytics, MLflow, Celery, Postgres e MinIO.

O resultado esperado e que um operador consiga, pela interface da aplicacao:

1. Autenticar-se com usuario real.
2. Gerenciar usuarios, papeis e membros de projetos.
3. Criar/importar lotes de dados sem sair para o CVAT manualmente.
4. Sincronizar, revisar e auditar anotacoes.
5. Criar releases imutaveis com artefatos baixaveis.
6. Materializar datasets YOLO reais para treino.
7. Rodar treino com metricas e politica de recurso observaveis.
8. Registrar, importar, promover, arquivar e baixar modelos.
9. Gerar datasets derivados com crops pixel-real.
10. Revisar tracks/video com operacoes de produto, nao apenas edicao basica.

## Estado atual

Ja existe:

- Backend FastAPI com healthcheck, CORS, auth interna opcional por chave e rotas versionadas em `/api/v1`.
- Modelos SQLAlchemy para projetos, tasks, labels, jobs, revisao, releases, treino, modelos, pipelines, assets derivados e auditoria.
- Sync CVAT por REST para projects, tasks, jobs, labels, data meta, previews e anotacoes.
- Fila de revisao derivada de shapes, tracks e tags sincronizados.
- Decisoes `accepted`, `rejected`, `corrected`, `uncertain`, `escalated` persistidas localmente.
- Patch incremental em CVAT para `accepted`, `rejected` e `corrected`.
- Releases imutaveis com export CVAT para MinIO/S3.
- Jobs assincronos via Celery/Redis e SSE para snapshots de jobs.
- Inferencia Ultralytics com sugestoes persistidas por camada/modelo.
- Treino Ultralytics vinculado a release pronta e registro local de `ModelVersion`.
- Pipeline simples para dataset derivado, hoje baseado em `AnnotationRecord`, manifesto e preview SVG.
- Frontend consumindo API real para Dados, Anotar, Revisar, Jobs, Releases, Treinar, Modelos e Visao Geral quando ha backend.

Ainda falta:

- Auth, usuarios e RBAC reais.
- Auditoria consultavel por API e tela sem mock.
- Importacao/criacao de tasks e lotes pelo backend.
- Download/proxy ou signed URLs para artefatos.
- Materializacao real de dataset YOLO a partir do export CVAT.
- Crop pixel-real e pipelines derivados com imagem real.
- Registro manual, importacao, promocao, arquivamento e download de modelos.
- Metricas de sistema e politicas de recurso aplicadas a jobs.
- Revisao avancada de tracks/video.
- Migrations confiaveis para banco limpo e evolucao de schema.

## Principios de implementacao

- O CVAT continua como fonte operacional de midia, labels, shapes, tracks, revisao e QA.
- O backend nunca acessa diretamente o banco interno do CVAT.
- Toda operacao longa deve virar `JobRecord`, rodar via Celery e aparecer em SSE.
- Todo artefato relevante deve ter registro persistente, URI rastreavel e caminho de download via backend.
- Todo fluxo com decisao humana deve gerar `AuditEvent`.
- O frontend nao deve ter fallback de mocks; falta de dado real deve aparecer como estado vazio, `--` ou erro operacional.
- APIs novas devem ter schemas Pydantic, testes pytest e tipos TypeScript exportaveis.
- O frontend deve usar a API real como fonte de verdade. Estado local so deve ser cache de UI.

## Fase 1 - Migrations e base operacional

### Objetivo

Tornar o schema confiavel em banco limpo e em banco existente, removendo dependencia operacional de `Base.metadata.create_all()` como mecanismo primario de evolucao.

### Entregaveis

- Revisar migrations existentes e criar uma linha Alembic consistente.
- Substituir a migration inicial baseada em `Base.metadata.create_all()` por migrations declarativas ou criar uma baseline nova documentada para ambientes ainda nao produtivos.
- Definir `AUTO_CREATE_TABLES=false` como padrao recomendado para stack com Postgres.
- Adicionar comando/documentacao para `alembic upgrade head` no fluxo local.
- Garantir que SQLite local continue funcionando para testes.

### APIs e modelos afetados

- Sem API publica nova.
- Todos os modelos SQLAlchemy existentes devem estar cobertos por migrations.
- Validar tabelas de: `projects`, `tasks`, `cvat_labels`, `task_data_meta`, `task_previews`, `annotation_records`, `inference_suggestions`, `review_decisions`, `annotation_revisions`, `track_revisions`, `job_records`, `dataset_releases`, `training_runs`, `model_versions`, `pipeline_definitions`, `pipeline_runs`, `derived_assets`, `audit_events`.

### Integracao frontend

- Nenhuma mudanca visual obrigatoria.
- Frontend deve continuar apontando para `NEXT_PUBLIC_API_BASE_URL`.

### Testes

- `alembic upgrade head` em banco Postgres limpo.
- `alembic downgrade base` quando suportado em ambiente temporario.
- `pytest` com SQLite em memoria.
- Smoke do Docker Compose subindo backend, worker e Postgres.

### Criterio de aceite

- Um banco Postgres vazio sobe ate `head` sem conflito de tabela ou coluna.
- O backend inicia sem `AUTO_CREATE_TABLES=true`.
- A suite backend passa sem depender de ordem acidental de criacao de tabelas.

## Fase 2 - Auth, usuarios, RBAC e membros de projeto

### Objetivo

Substituir a simulacao de usuarios no frontend por backend real de usuarios, login, papeis e associacao usuario-projeto.

### Entregaveis

- Criar modelos persistentes:
  - `User`: nome, email unico, password hash, role, status, avatar opcional, timestamps.
  - `UserSession` ou estrategia JWT stateless com expiracao.
  - `ProjectMember`: projeto, usuario, papel no projeto, timestamps.
- Implementar hash de senha com algoritmo seguro, por exemplo `bcrypt` via `passlib` ou equivalente.
- Criar usuario admin seed no primeiro boot ou comando documentado.
- Remover credenciais hardcoded do frontend como fonte de verdade.
- Manter `INTERNAL_API_KEY` apenas para automacao/dev interno, nao como login de usuario.

### APIs e contratos

- `POST /api/v1/auth/login`
  - Entrada: email e senha.
  - Saida: token/sessao, usuario atual e expiracao.
- `GET /api/v1/auth/me`
  - Retorna usuario autenticado e permissoes derivadas.
- `POST /api/v1/auth/logout`
  - Invalida sessao quando a estrategia for stateful.
- `GET /api/v1/users`
- `POST /api/v1/users`
- `PATCH /api/v1/users/{user_id}`
- `DELETE /api/v1/users/{user_id}` ou desativacao logica.
- `GET /api/v1/projects/{project_id}/members`
- `PUT /api/v1/projects/{project_id}/members`
- `DELETE /api/v1/projects/{project_id}/members/{user_id}`

### Regras

- Roles iniciais: `admin` e `anotador`.
- `admin` gerencia usuarios, projetos, releases, treino, modelos e pipeline.
- `anotador` acessa projetos em que e membro e fluxos de anotacao/revisao atribuidos.
- Nao permitir remover/desativar o ultimo admin ativo.
- Email deve ser unico e normalizado em lowercase.
- Senha nunca deve aparecer em resposta de API ou auditoria.

### Integracao frontend

- Trocar `lib/auth/user-context.tsx` para consumir `/auth/login`, `/auth/me` e `/users`.
- Tela `/login` passa a autenticar no backend.
- Tela `/usuarios` passa a fazer CRUD real.
- Tela `/projetos` passa a persistir membros em `/projects/{id}/members`.
- `AdminOnly` deve usar role vinda do backend.

### Testes

- Login com credenciais validas e invalidas.
- Token ausente, expirado ou invalido retorna 401.
- Anotador sem acesso a projeto recebe 403.
- Admin cria, edita, desativa usuario e associa projeto.
- Nao e possivel remover o ultimo admin.

### Criterio de aceite

- Recarregar o navegador nao perde a sessao valida.
- Usuarios e membros persistem apos reiniciar frontend/backend.
- Rotas administrativas sao bloqueadas para anotador.

## Fase 3 - Auditoria consultavel por API

### Objetivo

Transformar `AuditEvent` em recurso de produto consultavel, filtravel e exportavel.

### Entregaveis

- Criar schemas de leitura e filtros para auditoria.
- Adicionar paginacao cursor ou page/limit.
- Suportar filtros por ator, action, target, periodo, entidade e texto livre.
- Exportar CSV ou JSON pelo backend.
- Registrar eventos ausentes nos novos fluxos das fases seguintes.

### APIs e contratos

- `GET /api/v1/audit/events`
  - Query: `actor`, `action`, `target`, `from`, `to`, `q`, `limit`, `cursor` ou `page`.
- `GET /api/v1/audit/events/export`
  - Query igual a listagem.
  - Retorna `text/csv` por padrao, com opcao JSON se necessario.

### Integracao frontend

- Tela de auditoria deve consumir API real.
- Botao "Exportar log" deve baixar o arquivo gerado pelo backend.
- Remover dependencia operacional de `auditEvents` mock.

### Testes

- Listagem paginada.
- Filtros combinados.
- Export CSV com cabecalhos esperados.
- Eventos criados por review, release, treino, pipeline, auth e modelos aparecem na consulta.

### Criterio de aceite

- A tela de auditoria funciona sem mocks.
- Um operador consegue encontrar quem alterou uma anotacao, criou release, iniciou treino ou promoveu modelo.

## Fase 4 - Importacao e criacao de tasks/lotes via backend

### Objetivo

Permitir que o usuario crie/importe lotes pela aplicacao, mantendo CVAT como motor operacional.

### Entregaveis

- Criar camada de servico para criacao de projects/tasks no CVAT por REST.
- Suportar importacao por arquivos enviados e por pasta local permitida.
- Criar job assincrono para upload/importacao.
- Sincronizar automaticamente a task criada apos sucesso.
- Validar quota do projeto antes de iniciar importacao.
- Registrar origem do lote e politica de storage em auditoria.

### APIs e contratos

- `POST /api/v1/imports/tasks`
  - Cria job de importacao.
  - Entrada: `project_id`, `name`, labels opcionais, fonte e configuracoes.
- `POST /api/v1/imports/tasks/{job_id}/files`
  - Upload multipart quando a fonte for arquivo.
- `GET /api/v1/imports/{job_id}`
  - Retorna status consolidado do job.
- Opcional: `GET /api/v1/imports/sources/directories`
  - Pode reutilizar `/system/directories` com permissoes restritas.

### Regras

- Se a task ja existir no CVAT, o backend deve falhar com mensagem clara ou exigir flag explicita de reutilizacao.
- Nao adicionar midia a task CVAT existente; criar nova task para novo lote.
- Importacao deve respeitar `storage.quota_bytes`.
- Jobs cancelados devem limpar artefatos temporarios quando possivel.

### Integracao frontend

- Botao "Importar lote" em `/dados` abre dialog real.
- Dialog permite escolher projeto, nome do lote, fonte e labels.
- Listagem de lotes atualiza apos job concluir e sync terminar.

### Testes

- Criacao de task mockando CVAT.
- Upload multipart pequeno.
- Quota excedida bloqueia job antes de chamar CVAT.
- Cancelamento marca job e limpa temporarios.
- Sync automatico cria `Task`, labels e preview local.

### Criterio de aceite

- Um usuario admin cria um lote pela UI e ele aparece em Dados, Anotar e Revisar sem operacao manual no CVAT.

## Fase 5 - Artefatos baixaveis e proxy/signed URLs

### Objetivo

Permitir download seguro de releases, manifests, crops, pesos de modelo e artefatos de treino pelo backend.

### Entregaveis

- Criar modelo ou schema de `ArtifactRef` quando necessario.
- Adicionar metodos no `ArtifactStore` para `get`, `exists`, `stat` e signed URL.
- Suportar MinIO/S3 e fallback local para testes.
- Criar endpoints de download/proxy.
- Atualizar releases, models, training runs e derived assets para expor artefatos com nomes e tipos.

### APIs e contratos

- `GET /api/v1/artifacts/{artifact_id}/download`
- `GET /api/v1/artifacts/presign?uri=...`
- `GET /api/v1/dataset-releases/{release_id}/artifacts`
- `GET /api/v1/dataset-releases/{release_id}/download`
- `GET /api/v1/models/{model_id}/download`
- `GET /api/v1/derived-assets/{asset_id}/download`

### Regras

- Nao expor credenciais S3 ao frontend.
- Validar permissao do usuario antes de gerar URL.
- Para `s3://bucket/key`, gerar URL assinada ou stream proxy.
- Para artefatos inexistentes, retornar 404 com detalhe claro.

### Integracao frontend

- Botoes de download em Releases, Modelos e Detalhe de treino passam a chamar backend.
- Previews de crops devem usar URL HTTP valida.

### Testes

- Upload e download de artefato em store fake.
- Signed URL com MinIO em teste de integracao opcional.
- 404 para artefato ausente.
- 403 para usuario sem acesso ao projeto.

### Criterio de aceite

- Todo botao "Baixar" visivel no frontend baixa algo real ou fica desabilitado com motivo claro.

## Fase 6 - Materializacao real de datasets YOLO

### Objetivo

Transformar exports CVAT em datasets YOLO reais, com `data.yaml`, imagens, labels e splits reproduziveis.

### Entregaveis

- Criar worker de preparo de dataset a partir de `DatasetRelease`.
- Baixar export CVAT do MinIO/S3.
- Descompactar e converter anotacoes para formato YOLO compativel com familia do treino.
- Materializar estrutura:
  - `images/train`, `images/val`, `images/test`
  - `labels/train`, `labels/val`, `labels/test`
  - `data.yaml`
  - `manifest.json`
- Persistir URI do dataset preparado no snapshot da release ou em entidade dedicada.
- Atualizar `prepare_training_dataset` para usar dataset materializado por padrao.

### APIs e contratos

- `POST /api/v1/dataset-releases/{release_id}/prepare-yolo`
  - Enfileira job idempotente.
- `GET /api/v1/dataset-releases/{release_id}/prepared-dataset`
  - Retorna manifest, `data_yaml_uri`, classes e contagens.

### Regras

- Nao treinar contra dataset vazio.
- Split deve ser reproduzivel por seed e respeitar configuracao da release.
- Para video/tracks, manter todos os crops/frames do mesmo grupo no mesmo split quando metadata permitir.
- Falhas de conversao devem marcar job como `failed` e manter release original imutavel.

### Integracao frontend

- Tela Releases mostra status de dataset preparado.
- Tela Treinar bloqueia inicio quando nao ha dataset YOLO preparado, ou dispara preparo antes do treino com confirmacao clara.

### Testes

- Conversao com fixture CVAT pequena.
- `data.yaml` aponta para arquivos existentes.
- Labels YOLO possuem classe valida e coordenadas normalizadas.
- Treino falha cedo se dataset preparado esta vazio.

### Criterio de aceite

- Um release criado pela aplicacao gera um `data.yaml` real e inicia treino Ultralytics sem override manual.

## Fase 7 - Crops pixel-real e pipelines derivados reais

### Objetivo

Substituir previews SVG por crops reais extraidos dos frames originais e tornar o pipeline derivado util para classificacao.

### Entregaveis

- Implementar carregamento de frame original via CVAT ou artefato de release.
- Aplicar bbox, padding e politica de borda com PIL/OpenCV.
- Salvar crop real no artifact store.
- Gerar preview real e manifest com dimensoes, bbox original, bbox com padding e fonte.
- Executar classificacao opcional nos crops quando configurada.
- Preservar split por track.

### APIs e contratos

- `POST /api/v1/pipeline-runs`
  - Manter endpoint atual, ampliando definicao do grafo.
- `GET /api/v1/derived-assets`
  - Continuar listando assets com `preview_url` HTTP.
- `PATCH /api/v1/derived-assets/{asset_id}`
  - Permitir correcao humana de label/status.
- `POST /api/v1/derived-assets/{asset_id}/review-decision`
  - Registrar aceite/rejeicao/correcao do asset derivado.

### Regras

- Nao gerar crop para anotacao sem bbox valida.
- Padding deve ser rastreavel no `DerivedAsset.padding`.
- Para video, limitar amostras por track conforme `sample_policy`.
- Assets corrigidos por humano devem aparecer no manifest final.

### Integracao frontend

- `/dados` passa a mostrar crops reais.
- Criar vista minima para revisar assets derivados ou integrar com Revisar.
- Botao "Dataset derivado" deve exibir progresso real via Jobs.

### Testes

- Crop com bbox dentro da imagem.
- Crop com padding extrapolando borda.
- Split preservado por track.
- Manifest contem arquivos existentes.
- Correcao humana atualiza asset e auditoria.

### Criterio de aceite

- O pipeline derivado cria imagens reais baixaveis e um release derivado pronto para treino de classificacao.

## Fase 8 - Registro, importacao, promocao e arquivamento de modelos

### Objetivo

Completar o ciclo de vida de modelos alem do registro automatico apos treino.

### Entregaveis

- Permitir importar pesos externos.
- Permitir registrar modelo manualmente com familia, base, versao, dataset opcional, metricas e artefato.
- Adicionar status de ciclo de vida: `draft`, `registered`, `staging`, `approved`, `published`, `archived`.
- Criar operacoes de promocao e arquivamento com auditoria.
- Integrar com MLflow quando houver `mlflow_run_id`.

### APIs e contratos

- `POST /api/v1/models`
- `POST /api/v1/models/import`
- `PATCH /api/v1/models/{model_id}`
- `POST /api/v1/models/{model_id}/promote`
- `POST /api/v1/models/{model_id}/archive`
- `GET /api/v1/models/{model_id}/download`

### Regras

- Promocao para `published` exige artefato baixavel.
- Arquivamento nao deleta artefatos por padrao.
- Registrar versao duplicada para mesmo nome deve retornar 409.
- Toda mudanca de status gera `AuditEvent`.

### Integracao frontend

- Botao "Importar peso" abre upload real.
- Botao "Registrar modelo" cria registro manual.
- Acoes de linha permitem promover, publicar, arquivar e baixar.
- Grafico de evolucao usa modelos reais, nao mock, quando houver dados.

### Testes

- Registro manual.
- Upload de peso pequeno fake.
- Conflito nome/versao.
- Promocao e arquivamento com auditoria.
- Download de peso.

### Criterio de aceite

- Um modelo treinado ou importado pode ser aprovado/publicado pela UI e baixado depois.

## Fase 9 - Metricas de sistema, politicas de recurso e hardening de jobs

### Objetivo

Tornar jobs observaveis, controlaveis e mais previsiveis em treino, inferencia, release e pipeline.

### Entregaveis

- Padronizar `resource_policy` em jobs.
- Coletar CPU, memoria, disco e GPU quando disponivel.
- Persistir snapshots em `JobRecord.resource_metrics` ou entidade historica dedicada.
- Adicionar retry, timeout e prioridade para tipos de job.
- Expor fila e capacidade dos workers.
- Atualizar cancelamento para lidar com subtarefas e limpeza parcial.

### APIs e contratos

- `GET /api/v1/jobs/capacity`
- `PATCH /api/v1/jobs/{job_id}/priority`
- `POST /api/v1/jobs/{job_id}/retry`
- `GET /api/v1/jobs/{job_id}/metrics`

### Regras

- Limites duros de CPU/memoria so devem ser prometidos quando executados em container/ambiente que suporte enforcement.
- Em execucao local sem enforcement, mostrar como politica solicitada e metricas observadas.
- Retry nao pode duplicar artefatos finais sem idempotencia.
- Jobs finais permanecem imutaveis, exceto metadados de auditoria.

### Integracao frontend

- `/jobs` mostra GPU/CPU/memoria reais quando disponiveis.
- Tela de treino exibe metricas de sistema e metricas de modelo separadamente.
- Wizard de treino envia `resource_policy` com formato documentado.

### Testes

- Job com timeout falha com motivo claro.
- Retry cria novo job vinculado ao anterior.
- Metricas sao serializadas em SSE.
- Cancelamento de treino marca `TrainingRun` como `canceled`.

### Criterio de aceite

- Um operador consegue entender se o job esta lento por dado/modelo ou por saturacao da maquina.

## Fase 10 - Revisao avancada de tracks e video

### Objetivo

Adicionar operacoes de produto para revisao de video/tracks, aproveitando CVAT sem substituir seu editor completo.

### Entregaveis

- Modelar decisoes de track/segmento com faixa de frames.
- Implementar aceitar segmento, corrigir keyframe, aplicar classe ao track, dividir track e encerrar track quando suportado pela API CVAT.
- Registrar revisoes em `TrackRevision` com before/after rico.
- Expor operacoes seguras e idempotentes no backend.
- Manter fallback para abrir CVAT quando a operacao exigir edicao geometrica complexa.

### APIs e contratos

- `POST /api/v1/review/tracks/{track_id}/accept-segment`
- `POST /api/v1/review/tracks/{track_id}/correct-keyframe`
- `POST /api/v1/review/tracks/{track_id}/apply-label`
- `POST /api/v1/review/tracks/{track_id}/split`
- `POST /api/v1/review/tracks/{track_id}/close`

### Regras

- Operacoes destrutivas exigem confirmacao explicita.
- Toda operacao deve guardar intervalo de frames afetado.
- Se o patch CVAT falhar, a decisao local deve manter `cvat_synced=false` e `cvat_error`.
- UI deve separar modo decisao de modo edicao.

### Integracao frontend

- Revisar passa a ter controles de track quando `annotation_type=track`.
- Atalhos de teclado podem disparar decisoes de segmento, mantendo confirmacao para operacoes destrutivas.
- Mostrar link para abrir item no CVAT quando necessario.

### Testes

- Aceitar segmento cria `TrackRevision`.
- Aplicar label resolve label id correto.
- Falha de CVAT fica auditada.
- Operacao destrutiva sem confirmacao retorna 400.

### Criterio de aceite

- Um reviewer consegue revisar tracks comuns sem sair da aplicacao, e casos complexos continuam encaminhados ao CVAT.

## Ordem recomendada

1. Fase 1, porque migrations quebradas contaminam todas as entregas seguintes.
2. Fase 2, porque permissao e usuario real afetam todos os novos endpoints.
3. Fase 3 e Fase 5, porque auditoria e artefatos sao infraestrutura comum.
4. Fase 4 e Fase 6, para fechar o fluxo dados -> release -> treino real.
5. Fase 8 e Fase 9, para fechar governanca de modelos e operacao.
6. Fase 7 e Fase 10, para elevar pipelines e revisao de video ao nivel de produto.

## Contratos transversais

### Erros

- Usar respostas JSON com `detail` legivel.
- Usar 400 para payload invalido de negocio, 401 para nao autenticado, 403 para sem permissao, 404 para recurso ausente e 409 para conflito.
- Jobs que falham devem gravar motivo em `JobRecord.detail` e auditoria.

### Paginacao

- Listagens novas devem aceitar `limit`.
- Para tabelas grandes, preferir cursor por `created_at` + `id`.
- O frontend nao deve depender de retorno completo para auditoria, jobs ou assets.

### Auditoria

- Eventos devem incluir `actor`, `action`, `target`, `reason`, `confidence` quando aplicavel e `payload` com ids das entidades.
- Nao registrar senha, token, chave interna ou credenciais S3.

### Seguranca

- Usuario autenticado deve ser resolvido no backend, nao confiado do frontend.
- Admin pode tudo no escopo local.
- Anotador so acessa projetos em que e membro.
- Downloads e signed URLs devem validar permissao antes de expor artefato.

### Artefatos

- Todo artefato deve ter nome, content type, tamanho quando conhecido e URI interna.
- O frontend deve receber URLs HTTP ou endpoints de download, nunca `s3://` cru.

## Plano de testes consolidado

### Backend unitario

- Schemas Pydantic de todas as APIs novas.
- Servicos de auth, users, audit, artifacts, imports, YOLO materialization, pipelines e models.
- Regras de permissao por role e projeto.

### Backend integracao

- Alembic em Postgres limpo.
- MinIO com upload/download de artefatos.
- CVAT mockado para criar task, exportar dataset, buscar frames e patch de anotacoes.
- Celery em modo eager para jobs criticos.

### Frontend smoke

- `/login`: login real e erro de credencial.
- `/usuarios`: criar usuario e associar projeto.
- `/projetos`: criar projeto, editar quota e membros.
- `/dados`: importar lote e criar dataset derivado.
- `/releases`: criar release, preparar YOLO e baixar artefato.
- `/treinar`: iniciar treino sem override manual.
- `/modelos`: importar, promover, arquivar e baixar modelo.
- `/jobs`: acompanhar SSE, cancelar e retry.
- `/auditoria`: filtrar e exportar eventos.

### Aceitacao ponta a ponta

1. Subir stack local com Postgres, Redis, MinIO, MLflow, backend, worker e frontend.
2. Criar admin real.
3. Criar projeto com pasta e quota.
4. Criar anotador e associar ao projeto.
5. Importar lote pela UI.
6. Sincronizar CVAT automaticamente.
7. Revisar anotacoes e registrar auditoria.
8. Criar release.
9. Preparar dataset YOLO real.
10. Iniciar treino e acompanhar metricas.
11. Registrar/promover modelo.
12. Baixar release e peso de modelo.
13. Criar dataset derivado com crops reais.
14. Confirmar que eventos aparecem em auditoria.

## Definicao de pronto

O produto sera considerado finalizado para esta etapa quando:

- Nao houver dependencia operacional de dados mockados no frontend.
- Um banco limpo subir com Alembic sem `create_all`.
- Todo botao de acao principal da UI chamar backend real ou estar explicitamente desabilitado.
- Releases gerarem artefatos baixaveis.
- Treino usar dataset YOLO real materializado pelo backend.
- Modelos tiverem ciclo de vida completo.
- Jobs tiverem progresso, cancelamento, retry e metricas observaveis.
- Pipelines derivados gerarem crops reais.
- Revisao de tracks comuns for possivel pela aplicacao.
- A suite backend e os smoke tests frontend cobrirem o fluxo de aceitacao.
