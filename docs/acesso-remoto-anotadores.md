# Acesso remoto para anotadores

Este documento descreve a arquitetura recomendada para permitir que anotadores acessem a ferramenta de qualquer lugar usando seus proprios computadores, enquanto a maquina principal continua sendo o servidor central de dados, anotacao, revisao, treino e artefatos.

## Objetivo

Permitir que anotadores trabalhem remotamente sem copiar datasets, pesos ou infraestrutura para seus computadores pessoais.

O modelo esperado e:

- A maquina principal fica ligada durante anotacao, revisao, importacao, inferencia e treino.
- A maquina principal roda a stack completa da ferramenta.
- Os anotadores acessam a interface web pelo navegador.
- O acesso remoto acontece por uma rede privada Tailscale.
- Imagens, anotacoes, releases, datasets derivados, pesos e metricas ficam armazenados na maquina principal.

## Decisao arquitetural

A arquitetura oficial para acesso remoto privado deve usar Tailscale como rede entre a maquina principal e os computadores autorizados.

Nao e necessario dominio publico, IP fixo ou abertura de portas no roteador. O Tailscale cria uma rede privada criptografada entre os dispositivos permitidos.

Cloudflare Tunnel, dominio publico ou portal externo podem ser adicionados no futuro para clientes externos, mas nao sao o caminho principal deste projeto enquanto o objetivo for uma operacao privada com equipe conhecida.

## Diagrama textual

```text
Computador do anotador
Navegador + Tailscale
        |
        | rede privada Tailscale
        v
Maquina principal
Frontend + Backend + CVAT + Postgres + Redis + Worker + MinIO + MLflow + GPU
        |
        v
Storage local do projeto
Imagens originais + anotacoes + releases + crops + pesos + metricas
```

## Maquina principal

A maquina principal e o servidor soberano do sistema. Ela deve concentrar todos os componentes que manipulam dados sensiveis ou executam trabalho pesado:

- Frontend Next.js.
- Backend FastAPI.
- CVAT.
- Postgres.
- Redis e Celery.
- Worker de sincronizacao, inferencia, releases, derivados e treino.
- MinIO para artefatos.
- MLflow para runs, metricas e artefatos de treino.
- GPU e drivers quando houver treino/inferencia acelerados.
- Storage local dos projetos.

Os dados que devem permanecer nessa maquina incluem:

- Imagens originais importadas.
- Previews e imagens otimizadas para anotacao.
- Anotacoes sincronizadas.
- Dataset releases.
- Datasets derivados.
- Pesos de modelos.
- Logs, metricas e manifestos.
- Backups.

Os computadores dos anotadores nao devem virar fonte de verdade para nenhum desses dados.

## Computadores dos anotadores

O computador do anotador deve ser tratado como cliente leve.

Ele precisa apenas de:

- Navegador moderno.
- Cliente Tailscale instalado e autenticado.
- Login proprio na ferramenta.

Ele nao deve rodar:

- Docker.
- CVAT local.
- Python/Conda.
- Backend.
- Banco de dados.
- Worker.
- Treinamento.
- MinIO ou MLflow.

O anotador recebe imagens/previews pela rede privada e envia comandos para a aplicacao central: criar anotacao, editar objeto, aceitar/rejeitar revisao, comentar, salvar e navegar entre frames.

## Rede Tailscale

Cada pessoa autorizada deve entrar na mesma tailnet Tailscale da operacao.

Fluxo recomendado:

1. Instalar Tailscale na maquina principal.
2. Entrar com a conta administradora da tailnet.
3. Ativar MagicDNS no painel do Tailscale.
4. Definir um nome claro para a maquina principal, por exemplo `vetra-server` ou `maquina-treino`.
5. Instalar Tailscale no computador de cada anotador.
6. Convidar o anotador para a tailnet.
7. Confirmar que o anotador consegue acessar a maquina principal pelo nome MagicDNS ou pelo IP Tailscale.

URLs esperadas:

```text
http://vetra-server:3000
```

ou, se MagicDNS nao estiver disponivel:

```text
http://100.x.y.z:3000
```

O IP `100.x.y.z` e o endereco privado Tailscale da maquina principal.

## Entrada da aplicacao

Para acesso remoto confiavel, a ferramenta deve ter uma entrada clara para o navegador do anotador.

O desenho mais simples e publicar o frontend na porta `3000` da maquina principal:

```text
http://vetra-server:3000
```

Como o navegador roda no computador do anotador, qualquer URL publica no frontend nao pode apontar para `localhost` quando precisar chamar o backend. Para acesso remoto, existem duas formas seguras:

1. Preferencial: usar uma entrada unica com reverse proxy.
   - O anotador acessa uma unica URL.
   - O proxy encaminha `/api` para o backend.
   - O frontend e a API ficam sob a mesma origem.
   - Isso reduz problemas de CORS e evita expor portas separadas para usuarios comuns.

2. Alternativa simples: publicar frontend e backend por portas Tailscale.
   - Frontend: `http://vetra-server:3000`.
   - Backend: `http://vetra-server:8020/api/v1`.
   - `NEXT_PUBLIC_API_BASE_URL` deve apontar para a URL Tailscale do backend.
   - `CORS_ORIGINS` deve incluir a origem Tailscale do frontend.

Exemplo conceitual de variaveis para modo remoto:

```env
NEXT_PUBLIC_API_BASE_URL=http://vetra-server:8020/api/v1
CORS_ORIGINS=http://vetra-server:3000,http://100.x.y.z:3000
```

Em operacao final, a entrada unica com proxy e preferivel porque permite expor apenas a interface necessaria para anotadores.

## Seguranca e permissoes

A seguranca deve ter duas camadas.

Primeira camada: Tailscale.

- Decide quais dispositivos conseguem chegar na maquina principal.
- Evita abrir portas publicas no roteador.
- Permite remover um anotador da rede quando ele sair do projeto.
- Permite criar ACLs para limitar quais usuarios acessam quais portas.

Segunda camada: aplicacao.

- Cada anotador deve ter usuario proprio.
- O backend decide projetos, papeis e permissoes.
- O frontend so mostra projetos aos quais o usuario tem acesso.
- Jobs, revisoes, datasets e releases devem continuar escopados por projeto.

Portas administrativas devem ser restritas a administradores:

- CVAT admin.
- MinIO console.
- MLflow.
- Backend docs.
- Banco Postgres.
- Redis.
- Docker host.

Anotadores comuns devem acessar apenas a aplicacao necessaria para anotar e revisar.

## Fluxo de anotacao

1. Admin liga a maquina principal.
2. Admin sobe a stack com:

```bash
./start.sh
```

3. A maquina principal entra na tailnet Tailscale.
4. O anotador abre o Tailscale no proprio computador.
5. O anotador acessa:

```text
http://vetra-server:3000
```

6. O anotador faz login.
7. A ferramenta mostra apenas os projetos disponiveis para aquele usuario.
8. O anotador abre a tela de anotacao.
9. O backend envia previews/imagens otimizadas.
10. As anotacoes sao salvas no backend central e sincronizadas conforme o fluxo do projeto.

## Fluxo de revisao

1. O revisor acessa a mesma URL privada da aplicacao.
2. A tela de revisao lista somente itens anotados e pendentes de revisao dentro dos projetos permitidos.
3. Ao aceitar, a anotacao fica pronta para o proximo release.
4. Ao rejeitar, a imagem ou objeto volta para anotacao.
5. Ao corrigir, a edicao acontece na ferramenta e a decisao fica auditavel.
6. Toda decisao relevante deve gerar evento de auditoria no backend central.

## Fluxo de importacao de lotes

Uploads pequenos podem ser enviados diretamente pela interface.

Uploads grandes devem usar upload resumivel em chunks. Esse ponto e importante porque arquivos multi-GB podem falhar por oscilacao de rede, suspensao do notebook do anotador ou timeout de navegador.

O comportamento esperado para datasets grandes:

- O navegador divide o envio em partes pequenas.
- O backend recebe cada chunk na maquina principal.
- O backend valida tamanho, hash e progresso.
- Se a conexao cair, o upload continua do ultimo chunk confirmado.
- Ao final, o backend remonta o arquivo no storage local do projeto.
- O job de importacao aparece na central de jobs do projeto.
- O dataset final nunca passa a depender do computador do anotador.

Mesmo quando o arquivo nasce no computador do anotador, a fonte de verdade passa a ser o storage local da maquina principal depois que a importacao termina.

## Fluxo de treino

Treino, inferencia pesada e geracao de derivados devem rodar somente na maquina principal.

Fluxo esperado:

1. Dados sao anotados e revisados.
2. Um release de dataset e criado.
3. O job de release materializa os artefatos no storage local/MinIO da maquina principal.
4. O operador inicia o treino pela interface.
5. O worker da maquina principal executa o treino usando CPU/GPU local.
6. Metricas sao registradas no MLflow.
7. Pesos e artefatos ficam armazenados localmente.
8. A interface mostra progresso e resultados para usuarios autorizados.

O computador do anotador nunca treina modelo e nunca precisa baixar pesos para participar do fluxo.

## Operacao diaria

Rotina recomendada para o administrador:

1. Ligar a maquina principal.
2. Confirmar que Tailscale esta conectado.
3. Subir a stack:

```bash
./start.sh
```

4. Abrir a aplicacao localmente e confirmar healthcheck.
5. Confirmar que a URL Tailscale responde de outro dispositivo.
6. Convidar ou remover usuarios da tailnet conforme necessidade.
7. Gerenciar usuarios, projetos e permissoes dentro da aplicacao.
8. Monitorar jobs, storage e falhas operacionais.
9. Encerrar a stack ao fim do uso, se a operacao nao for continua:

```bash
./stop.sh
```

Para operacao continua, a maquina principal deve ser tratada como servidor: energia estavel, disco monitorado, backups, atualizacoes controladas e acesso administrativo restrito.

## Backups

Como datasets e pesos ficam centralizados, backup e parte da arquitetura, nao um detalhe posterior.

Devem entrar no plano de backup:

- Banco Postgres.
- Volumes do MinIO.
- Storage local de projetos.
- Artefatos de treino.
- Configuracoes `.env`.
- Dados relevantes do CVAT.
- Manifestos de releases e derivados.

Recomendacao operacional:

- Backup local em outro disco.
- Backup externo criptografado para dados criticos.
- Teste periodico de restauracao.
- Politica clara de retencao.

O backup pode ir para outro armazenamento, mas isso nao transforma esse armazenamento em fonte operacional de verdade. A operacao diaria continua centralizada na maquina principal.

## Por que nao Cloudflare agora

Cloudflare Tunnel nao e a escolha principal neste momento porque:

- Nao ha dominio proprio.
- A ferramenta nao precisa ser exposta publicamente.
- A equipe de anotadores e conhecida e pode ser convidada para uma rede privada.
- Tailscale resolve acesso remoto sem abrir portas no roteador.
- Tailscale mantem a maquina principal privada na internet.

Cloudflare, dominio publico e portal Zero Trust podem fazer sentido no futuro se houver clientes externos, usuarios temporarios que nao podem instalar Tailscale, ou necessidade de uma URL publica institucional.

## Evolucao futura

Melhorias naturais para essa arquitetura:

- Reverse proxy interno com uma unica entrada para frontend e API.
- HTTPS interno para acesso pela tailnet.
- ACLs Tailscale mais restritivas por grupo.
- Upload resumivel com pausa, retomada e verificacao de hash.
- Cache local de previews no navegador.
- Tiles ou piramide de imagem para imagens muito grandes.
- App desktop leve apenas como empacotamento da interface web.
- Monitoramento de disco, GPU, jobs e backups.

O app desktop, se existir, deve continuar sendo cliente leve. Ele nao deve levar dataset, banco, CVAT ou worker para o computador do anotador.
