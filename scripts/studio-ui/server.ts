/**
 * server.ts (#3555) — studio-server: fundação da EPIC "Studio UI" (#3554).
 *
 * Servidor HTTP local, **loopback-only** (`127.0.0.1`, nunca `0.0.0.0`),
 * servindo:
 *   - a SPA de status (HTML/CSS/JS vanilla, `./public/`);
 *   - `GET /api/state` — snapshot read-only (edição corrente, estágio por
 *     edição, gates pendentes) via `studio-state.ts`;
 *   - `GET /api/editions/:aammdd` — detalhe de UMA edição via
 *     `studio-edition-detail.ts`;
 *   - `GET /api/events` — SSE: tail do run-log + push de linhas novas
 *     (`run-log-tail.ts`) e mudanças em `plan.json` overnight/develop
 *     (`plan-watch.ts`);
 *   - `GET /tokens.generated.css` — tokens do DS em CSS (`tokens-css.ts`);
 *   - `GET /edicao/:aammdd` — cockpit de UMA edição (#3558): rewrite pra
 *     `public/edicao.html` (SPA shell client-side, sem lógica server nova —
 *     a página consome as mesmas `/api/state` + `/api/editions/:aammdd` +
 *     `/api/events` já existentes). AAMMDD não é validado aqui: a página
 *     cliente delega a validação/404 pras chamadas de API que ela mesma faz.
 *   - `GET /api/issues` — issues abertas + PRs abertos do GitHub (via `gh
 *     issue list` / `gh pr list`, cache+throttle em `studio-issues.ts`) pra a
 *     view de triagem (#3562), agora com classificação
 *     elegível/bloqueada/ambígua por issue + resumo de CI por PR. (#4004:
 *     a composição de onda em preview que rodava sobre este mesmo
 *     snapshot foi removida; o mecanismo de disparo real já tinha sido
 *     descontinuado no #3720/#3985.)
 *   - `GET /triagem` — cockpit de triagem de issues/PRs (#3562): mesma
 *     estratégia de rewrite client-side de `/edicao/:aammdd`, servindo
 *     `public/triagem.html`.
 *   - `POST /api/chat` — chat drawer (#3556): sessão Claude Agent SDK
 *     embutida, `cwd` = `rootDir` (mesmas skills/MCPs/CLAUDE.md do terminal).
 *     Streaming via SSE (mesmo `sse.ts` do `/api/events`) — eventos
 *     `chat-init`/`chat-delta`/`chat-tool`/`chat-permission-request`/
 *     `chat-done`/`chat-error`, contrato em `studio-chat.ts`. Fail-soft: erro
 *     do SDK vira `chat-error` no stream, nunca um 500 nem crash do processo.
 *   - `POST /api/chat/answer` — gates da sessão de chat (#3557): resolve um
 *     `chat-permission-request` pendente (a sessão chamou `AskUserQuestion`)
 *     com a resposta do editor. Ver `studio-chat.ts` (`makeInteractiveCanUseTool`,
 *     `resolvePendingPermissionRequest`) pro mecanismo completo — a stream
 *     SSE de `POST /api/chat` que originou a pergunta retoma sozinha assim
 *     que esta rota resolve a Promise pendente, sem coordenação extra aqui.
 *     `GET /api/state`/`GET /api/events` expõem `chatPermissionsPending`
 *     (badge global) via `studio-state.ts`.
 *   - `POST /api/chat/tool-decision` — gate de TOOL (#3804): resolve um
 *     `chat-tool-permission-request` pendente (a sessão chamou uma tool
 *     não-`AskUserQuestion` fora do allowlist, ex: um `Bash` do playbook de
 *     `/diaria-edicao`) com `{decision: allow|always|deny}`. Simétrico a
 *     `/api/chat/answer` — mesmo mecanismo de Promise pendurada em
 *     `studio-chat.ts` (`resolvePendingToolPermission`).
 *   - `GET /api/chat/pending` (#3617) — payload COMPLETO (`questions[]` pros
 *     gates de pergunta, `input` pros gates de tool #3804) dos gates
 *     pendentes, pra `chat-drawer.js` reidratar o card ao montar qualquer
 *     página, sem depender do stream SSE ao vivo que originou a pergunta (fix
 *     do bug "gate pendente inalcançável" — ver `studio-chat.ts`
 *     `listPendingPermissionRequestsFull`).
 *   - `GET /api/chat/history` (#3803) — payload do TRANSCRIPT já acumulado
 *     (mensagens do editor + texto final do assistente + chips de tool call
 *     de turnos ANTERIORES) pro `rootDir` corrente, mesmo princípio do
 *     `/api/chat/pending` acima mas cobrindo o histórico de MENSAGENS em vez
 *     do gate pendente — fecha o TODO(#3561/#3562) órfão citado no topo de
 *     `chat-drawer.js` (navegação entre páginas do Studio esvaziava o
 *     transcript visível mesmo com a sessão do Agent SDK viva no servidor).
 *     `?sessionId=` opcional invalida (resposta vazia) um transcript
 *     atrelado a uma sessão já superada — ver `studio-chat.ts`
 *     `getChatHistory`/`appendChatHistoryEvent`.
 *   - `GET/PUT /api/chat/enabled` (#4078) — toggle "chat ativo/desativado":
 *     GET devolve `{enabled, updatedAt}`; PUT `{enabled: boolean}` liga/
 *     desliga. Estado persistido em `data/studio-chat-enabled.json` (novo,
 *     dedicado — nunca sobrescreve outro arquivo de estado do Studio), lido/
 *     escrito via `scripts/lib/studio-chat-enabled.ts` — o MESMO módulo que
 *     uma sessão de automação (overnight/develop) importa (ou invoca via CLI,
 *     `npx tsx scripts/lib/studio-chat-enabled.ts`) pra checar
 *     `isChatEnabled()` ANTES de reiniciar o `Diaria-Studio-Server`, sem
 *     precisar do server rodando (incidente
 *     260726/27: restart em cima de uma conversa em andamento invalidou o
 *     gate/`toolUseId` do painel e derrubou uma edição não salva).
 *     `POST /api/chat` recusa com 409 quando o toggle está desligado (ver
 *     `handleApiChat`), pra uma aba antiga aberta não burlar o desligamento.
 *   - `GET /revisao/:aammdd` — painel de revisão de conteúdo rica (#3559):
 *     mesma estratégia de rewrite, servindo `public/revisao.html`. Consome
 *     `GET/PUT /api/editions/:aammdd/review/:slug` (`slug` = categorized |
 *     reviewed | social | html-final — #3635, editor de última milha do
 *     `_internal/newsletter-final.html` publicado de verdade pela Etapa 5),
 *     `.../diff`, `.../lint`, `.../reset-baseline` e
 *     `GET /api/editions/:aammdd/preview.html` (HTML completo do e-mail,
 *     pra `<iframe>`) + `GET /api/editions/:aammdd/social-preview.html`
 *     (#3663 — HTML legível do `03-social.md`: posts LinkedIn/Facebook/
 *     Instagram com quebras de linha e hashtags como aparecem publicados,
 *     mesmo renderer `render-social-html.ts` que a Etapa 4 real usa)
 *     — ver `studio-review.ts` pro detalhe. #3828: a seção "Ações rápidas"
 *     (swap de destaque via UI + os 2 ganchos de prompt) foi removida do
 *     painel — `POST /api/editions/:aammdd/actions/swap-destaque` não existe
 *     mais; `scripts/swap-destaque.ts` continua disponível via CLI.
 *   - `GET /api/rounds` (#3841 item 2/3) — sequência cronológica de TODAS as
 *     rodadas (overnight + develop), mais recente primeiro — ver
 *     `listRoundSummaries` em `studio-round.ts`.
 *   - `GET /api/round/:kind[?session=AAMMDD[sufixo]]` (#3561, `kind` =
 *     `overnight` | `develop`; `?session=` #3841 item 2/3) — fila
 *     classificada (entram/pendente/fora, com motivo) + timeline por unidade
 *     do `plan.json` daquele kind, pra `/rodada`. Sem `?session=`, usa o
 *     `plan.json` MAIS RECENTE (comportamento pré-#3841). Com `?session=`,
 *     busca o detalhe de uma entrada específica da sequência de
 *     `GET /api/rounds`. Read-only: visualização de uma rodada já em
 *     andamento/resumível, não dispara nenhuma varredura/sessão nova — ver
 *     `studio-round.ts`.
 *   - `GET /rodada` — acompanhamento de rodada overnight/develop (#3561,
 *     redesenhado #3841): mesma estratégia de rewrite, servindo
 *     `public/rodada.html`. Consome `GET /api/rounds` (lista cronológica) +
 *     `GET /api/round/:kind?session=` (detalhe da entrada expandida).
 *   - `GET /apoios` — CRM simples de apoios apoia.se (#3602): mesma
 *     estratégia de rewrite, servindo `public/apoios.html`. Consome
 *     `GET /api/apoios` (contatos + status cruzado via `checkBacker` +
 *     agregação de campanha) e `PUT /api/apoios/contacts/:id` (editar
 *     contato existente) — ver `studio-apoios.ts` pro detalhe. Dado pessoal:
 *     só em `data/apoia-se/contacts.jsonl` (junction OneDrive, nunca no
 *     repo). (#3862: o form manual "Adicionar contato" e a rota
 *     `POST /api/apoios/contacts` que ele chamava foram removidos — contato
 *     passa a existir só via `createContact` chamado in-process pelo drain
 *     de e-mail do #3859, nunca mais via HTTP.)
 *     (#3844: os recursos de follow-up/outreach — incluindo a rota
 *     `POST /api/apoios/contacts/:id/outreach` — foram removidos; a área
 *     refoca em visão por grupo/nível de recompensa, ainda pendente.)
 *     (#3859: `POST /api/apoios/refresh` — botão "Atualizar status".
 *     `refreshApoiosData` em `studio-apoios.ts` faz DUAS coisas em sequência:
 *     (metade 1) drena notificações "novo apoio" do Gmail pessoal via REST
 *     não-MCP (`scripts/lib/apoia-se-gmail-drain.ts`, mesmo mecanismo de
 *     `inbox-drain.ts`) e cria contato automaticamente pra apoiador ainda não
 *     cadastrado; (metade 2) força re-consulta do mês corrente na apoia.se
 *     só pra contatos ainda não confirmados como "apoiando" — protege o teto
 *     de 5.000 req/mês. Ambas fail-soft: falha de qualquer uma nunca derruba
 *     a outra nem quebra a rota, só documenta em `error`.)
 *   - `GET /api/reports` (#3714) — lista os relatórios de fim de trabalho
 *     (edição diária, overnight, develop, mensal) registrados no índice
 *     file-based `data/reports/index.jsonl` (`studio-reports.ts::listReports`),
 *     mais recentes primeiro. Substitui o antigo draft de e-mail (decisão do
 *     editor #3714, 260720) — o registro é feito pelos próprios scripts que
 *     geram cada relatório (`send-edition-report.ts`, `register-report.ts`
 *     no fecho de overnight/develop), nunca via chamada HTTP a este server
 *     (que pode estar parado no momento em que o relatório é gerado).
 *   - `GET /relatorios/:id` (#3714) — serve o CONTEÚDO do relatório
 *     resolvido (`resolveReportHtml`): HTML cru se o registro apontar pra um
 *     `.html`, ou um wrap HTML mínimo se apontar pra um `.md` (overnight/
 *     develop ainda geram markdown puro). 404 se o id nunca foi registrado
 *     ou o arquivo referenciado sumiu do disco.
 *   - `GET /relatorios` — cockpit de Relatórios (#3714): mesma estratégia de
 *     rewrite de `/triagem`/`/rodada`/`/apoios`, servindo
 *     `public/relatorios.html`. Consome `GET /api/reports`.
 *   - `GET /api/integrations` (#3848) — status de todas as integrações
 *     (APIs via key/token em `.env` + MCPs): configurada? alcançável? última
 *     checagem? Probe real (fetch de verdade) pras mais críticas (Beehiiv,
 *     Facebook/Instagram Graph, Cloudflare, Clarice cortex REST, Worker
 *     LinkedIn `/health`); as demais só "configurada? sim/não" — ver
 *     `studio-integrations.ts` pro detalhe e o motivo por integração.
 *     `?refresh=1` bypassa o cache de 5min. Nunca expõe valor de secret, só
 *     nome de env var ausente.
 *   - `GET /integracoes` — página de status (#3848): mesma estratégia de
 *     rewrite de `/apoios`/`/relatorios`, servindo `public/integracoes.html`.
 *   - `GET /api/skills` (#4270) — catálogo read-only das skills versionadas
 *     em `.claude/skills/{id}/SKILL.md`, gerado do filesystem a cada request
 *     (sem cache, sem lista paralela) — ver `studio-skills.ts` pro parser.
 *   - `GET /skills` (#4270) — catálogo de skills: mesma estratégia de
 *     rewrite, servindo `public/skills.html`. Consome `GET /api/skills`.
 *   - `GET /api/tasks` (#4799) — status de todas as `SCHEDULED_TASKS`
 *     (`scripts/lib/scheduled-tasks.ts`, registro declarativo #4805): armada
 *     no agendador desta máquina (Windows Task Scheduler ou systemd)?
 *     última execução (quando/duração/resultado/trecho de log, lido de
 *     `data/{logPath}`)? próxima execução prevista? atrasada? Só leitura
 *     (issue #4799 escopo — ações "rodar agora"/habilitar/desabilitar ficam
 *     pra uma 2ª fatia opcional). `?refresh=1` bypassa o cache de 2min. Ver
 *     `studio-tasks.ts`/`scripts/lib/scheduled-task-status.ts` pro detalhe.
 *   - `GET /tarefas` (#4799) — página de tasks agendadas: mesma estratégia
 *     de rewrite, servindo `public/tarefas.html`. Consome `GET /api/tasks`.
 *   - `GET /api/ads` (#5236) — custo por leitor por canal: cruza
 *     `data/aquisicao/spend.csv` (import manual) com o snapshot mais recente
 *     de `data/beehiiv-backup/` (leitor-v1, abertura agregada da coorte vs.
 *     base, degradação desde o snapshot anterior) e o orçamento do mês.
 *     Fail-soft por camada (spend/snapshot/origem) — sessão cloud sem
 *     `data/` nunca lança, só reporta ausência. `?refresh=1` bypassa o cache
 *     de 10min. Ver `studio-ads.ts`/`scripts/lib/cac.ts` pro núcleo puro.
 *   - `GET /ads` (#5236) — página de custo por leitor por canal: mesma
 *     estratégia de rewrite, servindo `public/ads.html`. Consome `GET /api/ads`.
 *   - `POST /api/painel/eia/refresh` (#3861) — botão "Atualizar É IA?" da
 *     dashboard diária embutida (`GET /painel/diaria`, `dashboard-diaria.ts`):
 *     regenera SÓ `data/poll-eia-summary.json` local a partir dos endpoints
 *     públicos do worker poll (`refreshPollEiaSummaryLocal`,
 *     `scripts/build-poll-eia-data.ts`) — nunca dispara o push paralelo pro
 *     KV do clarice-dashboard que o CLI `--push` faz (produção, requer
 *     credenciais Cloudflare). O botão em si (e o `<script>` que o alimenta)
 *     só existem no HTML quando `buildDiariaDashboardHtml` passa
 *     `studioMode: true` pra `renderDashboardHtml` — nunca no Worker de
 *     produção, que renderiza o MESMO módulo sem esse parâmetro. `?force=1`
 *     (#3882, mandado sempre pelo botão) ignora o cache TTL curto de
 *     `refreshPollEiaSummaryLocal` — sem a flag, um refresh repetido dentro do
 *     TTL serve o `poll-eia-summary.json` já em disco sem novo fetch (o fetch
 *     completo percorre N edições × M meses de leaderboard, historicamente >25s).
 *   - `GET /caixas` — seção "Caixas" (#3924): mesma estratégia de rewrite de
 *     `/apoios`/`/relatorios`, servindo `public/caixas.html`. Consome
 *     `GET /api/boxes` (lista dinâmica de `data/snippets/*.md`, exceto
 *     `README.md`, com badge de slot cruzado de `platform.config.json` →
 *     `boxes_divulgacao`) + `GET/PUT /api/boxes/:slug` (conteúdo + save com o
 *     MESMO guard de mtime de `#3729`, ver `studio-boxes.ts`) +
 *     `GET/PUT /api/boxes/slots` (#3937 — atribuição dos 4 slots de
 *     divulgação, slot0/1/2/3 (slot0 desde #4290), pela própria UI, escrita
 *     cirúrgica de `boxes_divulgacao` em `platform.config.json`, mesmo guard
 *     de mtime). Criação de caixa nova está fora de escopo — só edita
 *     conteúdo já existente.
 *   - Notificação push por e-mail (#3564, canal Gmail desde #5341, sem rota
 *     HTTP própria): um watcher em background, subido por `startStudioServer`
 *     e fechado em `close()`, observa `gatesPending`/`chatPermissionsPending`
 *     (mesmo `buildStudioState` de `GET /api/state`) e dispara notificação
 *     com deep-link + dedup quando algo passa a esperar o editor — ver
 *     `studio-push-notify.ts`. Fail-soft total: qualquer falha de
 *     auth/rede, o Studio segue normal.
 *
 * **Read-only por construção, com exceções controladas** (#3555 é a fatia
 * fundação da EPIC — as fatias de AÇÃO vêm depois, #3556+): nenhuma rota aqui
 * escreve em disco nem dispara nada, EXCETO `POST /api/chat` (#3556), que
 * conduz uma sessão Claude real (a UI só invoca — a lógica de negócio
 * permanece nas skills/scripts que essa sessão chama, mesmo princípio do epic
 * #3554), `POST /api/chat/answer` (#3557, resolve um gate em memória — não
 * escreve disco, mas é mutação de estado do processo), `PUT /api/chat/enabled`
 * (#4078, escreve `data/studio-chat-enabled.json` — arquivo novo e dedicado ao
 * toggle, ver doc-comment acima), e as rotas de ação de
 * revisão de conteúdo (#3559, detalhadas
 * abaixo). Sem autenticação nesta fatia — acesso remoto é escopo da #3560;
 * aqui o único guard de segurança é o bind loopback. #3558 (cockpit de
 * edição) e #3562 (triagem de issues/PRs) preservam o invariante read-only
 * original: são só mais views. #3562 em particular nunca expõe token do
 * GitHub (o server só invoca o binário `gh`, que resolve auth localmente) e
 * nunca chama subcomando de mutação (`close`/`comment`/`merge`) — só `list`.
 *
 * **Exceção controlada (#3559 — revisão de conteúdo rica):** as rotas
 * `PUT /api/editions/:aammdd/review/:slug` (salvar edição) e
 * `POST /api/editions/:aammdd/review/:slug/reset-baseline` são a 1ª quebra
 * deliberada do invariante read-only — a fatia de AÇÃO que #3555 previa.
 * Escopo estreito e auditável: só escrevem os 3 arquivos gate-facing de
 * revisão (`01-categorized.md`, `02-reviewed.md`, `03-social.md`) e o
 * baseline interno de diff (`_internal/studio-review-baseline/`). Toda a
 * lógica mora em `studio-review.ts` (arquivo próprio desta fatia) — ver o
 * cabeçalho pro detalhe do design. (#3828: a rota de ação
 * `POST /api/editions/:aammdd/actions/swap-destaque`, que invocava
 * `scripts/swap-destaque.ts` como subprocess, foi removida — o script segue
 * disponível via CLI direta.)
 *
 * **Exceção controlada (#3602 — CRM de apoios):** `PUT /api/apoios/contacts/:id`
 * escreve SÓ `data/apoia-se/contacts.jsonl` (dado pessoal, junction OneDrive,
 * nunca no repo/KV) — nunca toca credenciais nem a API apoia.se em modo de
 * escrita (o cruzamento de status é sempre leitura via `checkBacker`). Toda a
 * lógica mora em `studio-apoios.ts`. (#3862: a rota de criação manual,
 * `POST /api/apoios/contacts`, foi removida junto com o form que a chamava —
 * `createContact` segue existindo, mas só é invocado in-process pelo drain
 * de e-mail abaixo, nunca mais via HTTP.)
 * (#3859: `POST /api/apoios/refresh` é a mesma classe de exceção — dispara
 * LEITURAS a mais na apoia.se via `checkBacker`/`forceRefresh` (grava só o
 * cache `data/apoia-se/{campanha}/{YYYY-MM}.json`, já uma superfície de
 * escrita pré-existente de `checkBacker`), e TAMBÉM pode escrever
 * `contacts.jsonl` quando o drain de e-mail (metade 1) encontra um apoiador
 * novo — mesmo dado pessoal, mesma pasta, disparado automaticamente pelo
 * botão "Atualizar status" em vez de por submissão de form.)
 *
 * **Exceção controlada (#3861 — botão "Atualizar É IA?"):**
 * `POST /api/painel/eia/refresh` escreve SÓ `data/poll-eia-summary.json`
 * (`refreshPollEiaSummaryLocal` em `scripts/build-poll-eia-data.ts`) — nunca
 * chama o push pro KV do clarice-dashboard que o CLI `--push` faz (isso
 * exigiria credenciais Cloudflare de produção e não é papel de um botão de
 * painel local). Mesma classe de exceção que #3559/#3602/#3859: escopo
 * estreito, 1 arquivo local, fail-soft total.
 *
 * **Exceção controlada (#3924 — seção "Caixas"):** `PUT /api/boxes/:slug`
 * escreve SÓ o conteúdo de um snippet já existente em `data/snippets/`
 * (junction OneDrive, gitignored — snippets de caixa migraram do repo git
 * pra lá em #5227, não são mais versionados). Mesma classe
 * de exceção que #3559/#3602: escopo estreito (1 arquivo por vez, slug
 * validado contra traversal/`README.md`), guard de mtime idêntico ao #3729.
 * Toda a lógica mora em `studio-boxes.ts`.
 *
 * **Exceção controlada (#3937 — gestão de slots de divulgação):**
 * `PUT /api/boxes/slots` escreve SÓ a chave `boxes_divulgacao` de
 * `platform.config.json` (regra #495 — nunca o objeto inteiro, ver
 * `replaceBoxesDivulgacaoBlock` em `studio-boxes.ts`) — o arquivo mais
 * sensível desta tela, já que afeta a montagem de TODA edição diária
 * (`stitch-newsletter.ts`). Guards: caixa apontada precisa existir (viva, não
 * arquivada); nenhuma caixa em 2 slots ao mesmo tempo; mesmo guard de mtime
 * do #3729. Fecha o loop com o Arquivar (#3928): uma vez livre o slot aqui, a
 * caixa deixa de estar `blockedBySlot` e pode ser arquivada normalmente.
 *
 * Ver "Decisões de design" no PR body pra rationale completo (framework
 * escolhido, estrutura de diretórios, formato das APIs, pontos de extensão).
 *
 * Uso (CLI):
 *   npx tsx scripts/studio-ui/server.ts [--port N] [--root-dir <dir>]
 *   npm run studio
 *
 * Programmatic (usado por testes e por outros scripts):
 *   import { startStudioServer } from "./server.ts";
 *   const server = await startStudioServer({ port: 0 });
 *   // server.url, server.port
 *   await server.close();
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "../lib/env-loader.ts";
// #3867: chamada explícita — hoje `.env` já carrega de forma
// TRANSITIVA porque `dashboard-clarice.ts` (importado abaixo) chama
// `loadProjectEnv()` no próprio topo (#3563); um lazy-import ou split futuro
// desse módulo quebraria isso em silêncio (`GET/POST /api/apoios*` voltam a
// "sem dados" sem erro óbvio — dependem de `APOIA_SE_*` via
// `readApoiaSeEnv`, scripts/lib/apoia-se.ts). Idempotente (env-loader.ts
// nunca sobrescreve vars já setadas) — chamar de novo não tem custo mesmo
// com o import transitivo ainda existindo. Guard de regressão:
// test/studio-server-env-loading.test.ts.
loadProjectEnv();
import { parseArgs as parseCliArgs, isMainModule } from "../lib/cli-args.ts";
import { resolveRunLogPath } from "../lib/run-log.ts";
import { buildStudioState } from "./studio-state.ts";
import { buildEditionDetail } from "./studio-edition-detail.ts";
import { tailJsonl, watchRunLogAppends, type RunLogWatchHandle } from "./run-log-tail.ts";
import { watchPlanFiles, type PlanWatchHandle } from "./plan-watch.ts";
// #3565: espelho read-only do Studio local — push periódico do snapshot pro
// KV do worker diaria-dashboard. Ver studio-snapshot-watcher.ts.
import { watchAndPushStudioSnapshot, type StudioSnapshotWatchHandle } from "./studio-snapshot-watcher.ts";
import { formatSseEvent, formatSseComment } from "./sse.ts";
import { serveStaticFile, mimeFor } from "./static-serve.ts";
import { buildTokensCss } from "./tokens-css.ts";
import { fetchTriageData, type GhRunFn } from "./studio-issues.ts";
// #3561: visualização da fila classificada + timeline ao vivo de uma rodada
// overnight/develop já em andamento/resumível — arquivo próprio desta
// fatia, import isolado (nenhuma outra rota depende dele). Ver studio-round.ts.
import { buildRoundPayload, isRoundKind, listRoundSummaries } from "./studio-round.ts";
// #3714: superfície de Relatórios — lista + serve os relatórios de fim de
// trabalho (edição/overnight/develop/mensal) registrados via
// `scripts/register-report.ts` (overnight/develop) ou direto por
// `send-edition-report.ts` (edição). Read-only: só lê o registry + os
// arquivos de relatório já persistidos por outros scripts — ver studio-reports.ts.
import { listReports, getReportById, resolveReportHtml } from "./studio-reports.ts";
import { buildDiariaDashboardHtml } from "./dashboard-diaria.ts";
import { buildClariceDashboardHtml } from "./dashboard-clarice.ts";
import {
  parseChatRequestBody,
  parseChatAnswerRequestBody,
  parseChatToolDecisionRequestBody,
  runChatTurn,
  getSessionId,
  setSessionId,
  clearSession,
  resolvePendingPermissionRequest,
  resolvePendingToolPermission,
  watchPendingChatPermissions,
  listPendingPermissionRequestsFull,
  appendChatHistoryUserMessage,
  appendChatHistoryEvent,
  getChatHistory,
  createCloseAbortGuard,
  DEFAULT_CHAT_CLOSE_ABORT_DEBOUNCE_MS,
  type QueryFn,
} from "./studio-chat.ts";
// #4078: toggle "chat ativo/desativado" — estado persistido em
// data/studio-chat-enabled.json, lido/escrito tanto por este server quanto
// por sessões de automação externas (ver docstring do módulo).
import { readChatEnabledState, setChatEnabled, isChatEnabled } from "../lib/studio-chat-enabled.ts";
import { shutdownWithTimeout } from "../lib/shutdown-with-timeout.ts";
// #3559: painel de revisão de conteúdo rica — arquivos próprios desta fatia,
// import isolado (nenhuma outra rota depende deles). Ver studio-review.ts.
import {
  isReviewSlug,
  readReviewFile,
  saveReviewFile,
  resetBaseline,
  computeReviewDiff,
  runReviewLints,
  buildReviewPreviewHtml,
  buildSocialPreviewHtml,
  resolveReviewImagePath,
  applyDestaqueTitleEdit,
} from "./studio-review.ts";
// #6447 Fatia 1: painel "Gate" — resumo consolidado do Stage 4 (títulos
// original/final, checklist, lints estendidos) lido só de disco. Arquivo
// próprio (`studio-gate.ts`), mesma convenção de import isolado do #3559.
import { buildGateSummary } from "./studio-gate.ts";
import { resolveEditionDir } from "../lib/find-current-edition.ts";
// #3602: CRM simples de apoios apoia.se — arquivo próprio desta fatia, import
// isolado (nenhuma outra rota depende dele). Ver studio-apoios.ts.
import {
  buildApoiosData,
  refreshApoiosData,
  updateContactById,
  parseUpdateContactBody,
  type ApoiosMutationResult,
} from "./studio-apoios.ts";
import type { DrainApoiaSeResult } from "../lib/apoia-se-gmail-drain.ts";
// #3564/#5341: notificação push por e-mail (gate 4/6 pendente +
// AskUserQuestion pendente no chat) com dedup — arquivo próprio desta
// fatia, import isolado (nenhuma outra rota depende dele). Ver
// studio-push-notify.ts.
import {
  startPushNotifyWatcher,
  maybeNotifyChatDone,
  type PushNotifyWatchHandle,
} from "./studio-push-notify.ts";
// #3848: status de todas as integrações (APIs + MCPs) — arquivo próprio
// desta fatia, import isolado (nenhuma outra rota depende dele). Ver
// studio-integrations.ts.
import { buildIntegrationsData } from "./studio-integrations.ts";
// #4041: inventário de UTMs (registry) × conversão real (Beehiiv) × clique
// (Brevo). Ver studio-utms.ts pra fronteira de edição (só metadados).
import { buildUtmsData, saveUtmMetadata } from "./studio-utms.ts";
// #4270: catálogo read-only das skills versionadas (.claude/skills/*/SKILL.md),
// gerado do filesystem — ver studio-skills.ts.
import { buildSkillsData } from "./studio-skills.ts";
// #4799: status de todas as tasks agendadas (registro declarativo
// scripts/lib/scheduled-tasks.ts) — armada? última execução? próxima
// prevista? atraso? Ver studio-tasks.ts.
import { buildTasksData } from "./studio-tasks.ts";
// #3861: botão "Atualizar É IA?" da dashboard diária embutida — reusa a
// função exportada de build-poll-eia-data.ts (mesmo módulo do CLI --push),
// mas SÓ a metade local (nunca o push pro KV do clarice-dashboard). Ver
// docstring de refreshPollEiaSummaryLocal.
import { refreshPollEiaSummaryLocal } from "../build-poll-eia-data.ts";
// #5236: custo por leitor por canal — qual canal traz leitor mais barato,
// abertura da coorte vs. base, orçamento do mês, degradação. Ver studio-ads.ts.
import { buildAdsData } from "./studio-ads.ts";
import { watchStudioSource, type StudioSourceChange, type StudioSourceWatchHandle } from "./studio-source-watch.ts";
// #5894: sendJson + readRequestBody extraídos pra http-utils.ts; handlers de
// Caixas extraídos pra routes/boxes.ts — server.ts encolheu de 2389 → ~1700 linhas.
import { sendJson, readRequestBody } from "./http-utils.ts";
import {
  handleApiBoxesList,
  handleApiBoxGet,
  handleApiBoxSave,
  handleApiBoxCreate,
  handleApiBoxArchive,
  handleApiBoxUnarchive,
  handleApiArchivedBoxesList,
  handleApiBoxSlotsGet,
  handleApiBoxSlotsSave,
  handleApiParaEncerrarGet,
  handleApiParaEncerrarSave,
} from "./routes/boxes.ts";

// #3555: SEMPRE loopback — nunca 0.0.0.0. Acesso remoto (Tunnel + Access) é
// escopo de outra fatia (#3560) do epic #3554, com auth explícita.
const HOST = "127.0.0.1";

// Porta default arbitrária, escolhida só pra não colidir com convenções já
// em uso no repo (oauth-setup.ts usa 8765; serve-preview.ts usa porta
// efêmera 0). Sempre sobrescrevível via --port ou STUDIO_PORT.
const DEFAULT_PORT = 4174;

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(__dirname, "public");

const AAMMDD_RE = /^[0-9]{6}$/;

export interface StudioServerOptions {
  /** Porta fixa; omitida ou `0` = porta efêmera OS-assigned (útil em testes). */
  port?: number;
  /** Raiz do projeto (onde `data/` mora) — injetável pra testes apontarem pra um tmpdir. */
  rootDir?: string;
  /** Quantas linhas de run-log incluir no tail inicial de `/api/events`. */
  runLogTailSize?: number;
  /** Intervalo de polling (ms) dos watchers — reduzido em testes. */
  pollIntervalMs?: number;
  /** Runner de `gh` injetável pra `/api/issues` (#3562) — testes mockam sem
   * invocar o binário real nem rede; produção usa o default de `studio-issues.ts`. */
  ghRun?: GhRunFn;
  /** `query()` injetável pra `POST /api/chat` (#3556) — testes mockam o
   * Claude Agent SDK sem spawnar o CLI real; produção usa o default de
   * `studio-chat.ts`. */
  chatQueryFn?: QueryFn;
  /** Intervalo de polling (ms) do watcher de notificação push (#3564,
   * canal e-mail desde #5341) — default 15s (independente de
   * `pollIntervalMs` acima, que é tunado pra SSE de baixa latência; aqui
   * 1 tick/s seria polling desnecessariamente agressivo pra um evento que
   * só interessa notificar 1x). Reduzido em testes. */
  pushPollIntervalMs?: number;
  /** Tamanho máximo (bytes) do corpo de `POST /api/chat` — default 256KB,
   * generoso pra uma mensagem de chat digitada à mão, protege contra corpo
   * absurdo consumindo memória do processo. */
  chatMaxBodyBytes?: number;
  /** Notificador injetável do evento `chat-done` (#3822) — default
   * `maybeNotifyChatDone` (`studio-push-notify.ts`); testes mockam pra
   * observar chamadas sem bater na rede/Gmail real. */
  chatDoneNotifyFn?: typeof maybeNotifyChatDone;
  /** Relógio injetável usado só pra medir a duração de um turno de chat
   * (#3822 — decide se `chatDoneNotifyFn` dispara, comparando contra o
   * threshold) — default `Date.now`; testes injetam uma sequência fixa pra
   * simular um turno "longo" sem esperar segundos de verdade. */
  chatDoneNowFn?: () => number;
  /** Debounce (ms) entre o `close` da request de `/api/chat` e o abort de
   * fato da sessão do Agent SDK (#3887) — default `DEFAULT_CHAT_CLOSE_ABORT_DEBOUNCE_MS`
   * (2.5s). Testes injetam um valor pequeno pra não esperar segundos de
   * verdade num close persistente. Ver `createCloseAbortGuard` (`studio-chat.ts`). */
  chatCloseAbortDebounceMs?: number;
  /** #3565: liga o watcher de push periódico do snapshot pro KV (espelho
   * read-only externo, `workers/diaria-dashboard` rota `/studio`).
   * DESLIGADO por padrão — inclusive em testes, que criam `StudioServer` sem
   * setar isso; `main()` liga explicitamente pro uso real (`npm run studio`).
   * Fail-soft total mesmo ligado: falha de rede/Cloudflare nunca derruba o
   * Studio local (ver `studio-snapshot-watcher.ts`). */
  enableSnapshotPush?: boolean;
  /** Intervalo (ms) do push periódico — default 5min (`studio-snapshot-watcher.ts`). */
  snapshotPushIntervalMs?: number;
  /** Drain de Gmail injetável pra `POST /api/apoios/refresh` (#3859 metade 1)
   * — sem isso, `handleApiApoiosRefresh` chama `refreshApoiosData` sem
   * `opts.gmailDrain`, caindo no default real (`drainApoiaSeNotifications`),
   * que lê `data/.credentials.json` por um path fixo (`google-auth.ts`,
   * resolvido a partir do próprio módulo, não de `rootDir`) — um teste com
   * `rootDir` isolado (tmpdir) ainda assim bate no Gmail REAL se a máquina
   * tiver credenciais válidas (achado em produção: `test/studio-apoios-page.test.ts`
   * esperava 1 contato e recebeu 17, vindos de notificações reais da conta).
   * Testes HTTP-level devem injetar um no-op aqui; produção usa o default. */
  apoiosGmailDrain?: () => Promise<DrainApoiaSeResult>;
  /** `fetch` injetável pra `GET /api/integrations` (#3848) — testes SEMPRE
   * passam um mock que nunca bate em rede real (proibido testar os probes
   * ao vivo, ver doc-comment de `studio-integrations.ts`). Produção usa o
   * default (`fetch` global) de `buildIntegrationsData`. */
  integrationsFetchImpl?: typeof fetch;
  /** #5674: observa as árvores importadas pelo server e permite ao processo
   * principal reiniciar quando o código server-rendered mudar. Desligado por
   * padrão para manter testes e consumidores programáticos sob controle. */
  enableSourceWatch?: boolean;
  /** Intervalo do watcher de mtime do código server-rendered. */
  sourceWatchPollIntervalMs?: number;
  /** Callback injetável para observar uma mudança sem matar o processo (testes). */
  onSourceChange?: (change: StudioSourceChange) => void;
}

export interface StudioServer {
  url: string;
  port: number;
  rootDir: string;
  close: () => Promise<void>;
}

function handleApiState(rootDir: string, res: ServerResponse): void {
  sendJson(res, 200, buildStudioState(rootDir));
}

/** `GET /api/chat/pending` (#3617) — payload COMPLETO dos gates
 * `AskUserQuestion` pendentes pro `rootDir` corrente (`questions[]` inteiro,
 * não só `firstQuestion`) — o que faltava pra `chat-drawer.js` reidratar o
 * card ao montar QUALQUER página do Studio, sem depender do stream SSE ao
 * vivo que originou a pergunta. Reusa `listPendingPermissionRequestsFull`
 * (mesmo Map de `studio-chat.ts` que já alimenta `chatPermissionsPending`
 * em `/api/state`) — não duplica estado. Sempre 200 (lista vazia = nenhum
 * gate pendente); não há "erro" possível numa leitura de Map em memória. */
function handleApiChatPending(rootDir: string, res: ServerResponse): void {
  sendJson(res, 200, { pending: listPendingPermissionRequestsFull(rootDir) });
}

/** `GET /api/chat/history` (#3803) — payload do TRANSCRIPT já acumulado pro
 * `rootDir` corrente (mensagens do editor + texto final do assistente +
 * chips de tool call de turnos ANTERIORES) — o gap órfão citado no TODO de
 * topo de `chat-drawer.js` (#3561/#3562 nunca cobriram isso; só o gate
 * pendente foi reidratado, #3617). Reusa `getChatHistory` (mesmo buffer em
 * memória de `studio-chat.ts` que `appendChatHistoryUserMessage`/
 * `appendChatHistoryEvent` já alimentam dentro de `handleApiChat` — não
 * duplica estado).
 *
 * `?sessionId=` é opcional; quando presente E o servidor já tem uma sessão
 * corrente DIFERENTE pro `rootDir` (`getSessionId`), a resposta vem VAZIA —
 * o `sessionId` que o cliente guarda em localStorage é de uma conversa já
 * superada (reset disparado por outra aba, ou processo reiniciado depois de
 * uma sessão nova), então o transcript antigo não deve reaparecer atrelado a
 * um ponteiro que o servidor não reconhece mais como corrente. Sem
 * `sessionId` na query (cliente ainda sem nenhuma conversa) ou sem sessão
 * corrente no servidor (processo acabou de subir), serve o buffer como está
 * — mesma disciplina "sempre 200, nunca erro" de `handleApiChatPending`. */
function handleApiChatHistory(rootDir: string, req: IncomingMessage, res: ServerResponse): void {
  const queriedSessionId = new URL(req.url ?? "/", "http://localhost").searchParams.get("sessionId");
  const currentSessionId = getSessionId(rootDir);
  if (queriedSessionId && currentSessionId && queriedSessionId !== currentSessionId) {
    sendJson(res, 200, { history: [], sessionId: currentSessionId });
    return;
  }
  sendJson(res, 200, { history: getChatHistory(rootDir), sessionId: currentSessionId ?? null });
}

// ── #4078: toggle "chat ativo/desativado" ───────────────────────────────────

const CHAT_ENABLED_MAX_BODY_BYTES = 2_000; // corpo é só {enabled: boolean} — teto pequeno de propósito.

/** `GET /api/chat/enabled` (#4078) — estado atual do toggle "chat ativo/
 * desativado". Sempre 200: `readChatEnabledState` é fail-soft (arquivo
 * ausente/corrompido -> `{enabled:true, updatedAt:null}`, nunca lança) —
 * mesma disciplina "sempre 200, nunca erro" de `handleApiChatPending`. */
function handleApiChatEnabledGet(rootDir: string, res: ServerResponse): void {
  sendJson(res, 200, readChatEnabledState(rootDir));
}

/** `PUT /api/chat/enabled` (#4078) — liga/desliga o chat do painel. Corpo
 * `{enabled: boolean}`. O editor usa isto pra sinalizar explicitamente "não
 * estou usando o chat agora" (`enabled: false`) antes de uma sessão de
 * automação reiniciar/religar o Studio — ver docstring de
 * `scripts/lib/studio-chat-enabled.ts` pra como uma sessão de automação
 * CHECA esse estado (sem precisar do server rodando). 400 corpo malformado,
 * 500 só se a escrita em disco falhar de verdade (I/O real, não parte do
 * contrato fail-soft de leitura).
 *
 * Decisão consciente (#4141 finding 2): SEM o guard de mtime/conflito 409
 * que `saveBox`/`saveBoxSlots`/`saveReviewFile` têm (#3729). Duas abas
 * clicando o toggle quase ao mesmo tempo dão last-write-wins silencioso —
 * aceito de propósito porque é um boolean de baixo blast radius (nunca perde
 * CONTEÚDO editorial, só o estado do toggle) e "o valor mais recente vence"
 * é a semântica certa pra um interruptor, não um conflito real a resolver.
 * Não portar o guard de mtime aqui sem motivo novo. */
async function handleApiChatEnabledSave(
  rootDir: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: unknown;
  try {
    body = JSON.parse(await readRequestBody(req, CHAT_ENABLED_MAX_BODY_BYTES));
  } catch {
    sendJson(res, 400, { error: "corpo da request precisa ser JSON válido" });
    return;
  }
  const parsed = body as { enabled?: unknown } | null;
  if (typeof parsed?.enabled !== "boolean") {
    sendJson(res, 400, { error: "campo 'enabled' (boolean) é obrigatório no corpo" });
    return;
  }
  try {
    sendJson(res, 200, setChatEnabled(rootDir, parsed.enabled));
  } catch (e) {
    sendJson(res, 500, { error: (e as Error).message });
  }
}

function handleApiEdition(rootDir: string, aammdd: string, res: ServerResponse): void {
  if (!AAMMDD_RE.test(aammdd)) {
    sendJson(res, 400, { error: "AAMMDD inválido", edition: aammdd });
    return;
  }
  const detail = buildEditionDetail(rootDir, aammdd);
  if (!detail.found) {
    sendJson(res, 404, { error: "edição não encontrada", edition: aammdd });
    return;
  }
  sendJson(res, 200, detail);
}

function handleApiEvents(
  rootDir: string,
  req: IncomingMessage,
  res: ServerResponse,
  opts: { runLogTailSize: number; pollIntervalMs: number },
): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // #3555: loopback-only server — CORS não é necessário (mesma origem), mas
    // deixar explícito documenta a intenção pra próximas fatias que possam
    // servir a SPA de outra origem (ex: dev server com hot-reload).
  });
  res.write(formatSseComment("connected"));

  const logPath = resolveRunLogPath(rootDir);
  res.write(formatSseEvent("state", buildStudioState(rootDir)));
  res.write(formatSseEvent("log-init", tailJsonl(logPath, opts.runLogTailSize)));

  const logWatch: RunLogWatchHandle = watchRunLogAppends(
    logPath,
    (events) => {
      for (const event of events) res.write(formatSseEvent("log", event));
    },
    { pollIntervalMs: opts.pollIntervalMs },
  );

  const planWatch: PlanWatchHandle = watchPlanFiles(
    rootDir,
    (sig) => res.write(formatSseEvent("plan", sig)),
    { pollIntervalMs: opts.pollIntervalMs },
  );

  // #3557: badge global de gates pendentes — re-emite o snapshot completo de
  // `/api/state` (o browser já sabe renderizar `state.chatPermissionsPending`)
  // assim que uma AskUserQuestion chega OU é respondida, sem esperar o
  // próximo evento de run-log/plan.json que disparasse esse refresh por
  // acaso.
  const chatPermissionWatch = watchPendingChatPermissions(
    rootDir,
    () => res.write(formatSseEvent("state", buildStudioState(rootDir))),
    { pollIntervalMs: opts.pollIntervalMs },
  );

  const heartbeat = setInterval(() => {
    res.write(formatSseComment("heartbeat"));
  }, 20_000);

  const cleanup = () => {
    clearInterval(heartbeat);
    logWatch.close();
    planWatch.close();
    chatPermissionWatch.close();
  };
  req.on("close", cleanup);
  res.on("error", cleanup);
}

/** `GET /api/issues` — issues abertas + PRs abertos do GitHub (#3562). Sempre
 * 200: `fetchTriageData` é fail-soft (nunca lança), erros de `gh` vêm
 * embutidos no campo `error` do payload. */
function handleApiIssues(rootDir: string, res: ServerResponse, ghRun?: GhRunFn): void {
  sendJson(res, 200, fetchTriageData(rootDir, { run: ghRun }));
}

/** `GET /api/round/:kind[?session=AAMMDD[sufixo]]` (#3561, `?session=` #3841
 * item 2/3) — fila classificada (entram/pendente/fora, com motivo) +
 * timeline por unidade do `plan.json` de `kind` ("overnight" | "develop").
 * Sem `?session=`, usa o `plan.json` MAIS RECENTE (comportamento pré-#3841
 * preservado). Com `?session=`, busca o `plan.json` daquela sessão
 * específica — usado pelo painel `/rodada` quando o editor expande uma
 * entrada da sequência cronológica (`GET /api/rounds`) que não é
 * necessariamente a mais recente. Sempre 200 com `found:false` quando não há
 * nenhuma sessão (inclusive `session` inexistente/inválido) — `kind`
 * inválido é o único 400 desta rota. Read-only: `buildRoundPayload` só lê
 * disco, nunca dispara nada (ver studio-round.ts). */
function handleApiRound(rootDir: string, kind: string, req: IncomingMessage, res: ServerResponse): void {
  if (!isRoundKind(kind)) {
    sendJson(res, 400, { error: "kind inválido — use 'overnight' ou 'develop'", kind });
    return;
  }
  const session = new URL(req.url ?? "/", "http://localhost").searchParams.get("session");
  sendJson(res, 200, buildRoundPayload(rootDir, kind, session ?? undefined));
}

/** `GET /api/rounds` (#3841 item 2/3) — sequência cronológica de TODAS as
 * rodadas (overnight + develop), mais recente primeiro. Substitui a antiga
 * UX de "1 rodada por kind" do painel `/rodada`: o editor não escolhe mais
 * um kind pra ver "a rodada corrente" desse kind — vê a sequência inteira e
 * expande a entrada que quiser (`GET /api/round/:kind?session=` busca o
 * detalhe). Sempre 200 — `listRoundSummaries` é fail-soft por construção
 * (entrada com `plan.json` corrompido é só omitida, nunca derruba a rota). */
function handleApiRounds(rootDir: string, res: ServerResponse): void {
  sendJson(res, 200, { rounds: listRoundSummaries(rootDir) });
}

/** `GET /api/reports` (#3714) — lista os relatórios registrados, mais
 * recentes primeiro (`listReports` já ordena). Sempre 200: `listReports` é
 * fail-soft (registry ausente/corrompido vira `[]`, nunca lança). */
function handleApiReports(rootDir: string, res: ServerResponse): void {
  sendJson(res, 200, { reports: listReports(rootDir) });
}

/** `GET /relatorios/:id` (#3714) — serve o CONTEÚDO do relatório (não uma
 * view SPA) resolvido por `resolveReportHtml`: HTML cru se o arquivo
 * registrado for `.html` (edição/mensal), ou um wrap HTML mínimo se for
 * `.md` (overnight/develop, ainda markdown puro). 404 quando o id nunca foi
 * registrado; 404 também quando o arquivo referenciado sumiu do disco
 * (`resolveReportHtml` retorna `ok:false` nesse caso — mesmo status, corpo
 * HTML já explica o motivo). */
function handleReportContent(rootDir: string, id: string, res: ServerResponse): void {
  const entry = getReportById(rootDir, id);
  if (!entry) {
    sendHtml(res, 404, `<!doctype html><p>relatório não encontrado: ${escHtmlLite(id)}</p>`);
    return;
  }
  const rendered = resolveReportHtml(rootDir, entry);
  sendHtml(res, rendered.ok ? 200 : 404, rendered.html);
}

/** Coleta o corpo da request em memória, com um teto de bytes pra evitar que
 * um corpo absurdo (ou um cliente malicioso/travado) segure memória do
 * processo indefinidamente. Rejeita (`reject`) assim que o teto é excedido —
 * não espera o `end` do stream. */
// readRequestBody + sendJson movidos pra ./http-utils.ts (#5894) — ambos usados
// por server.ts e pelos handlers em ./routes/*.ts.

/**

 * `POST /api/chat` — chat drawer (#3556). Lê o corpo, valida via
 * `parseChatRequestBody` (400 se inválido), abre a resposta como SSE e
 * conduz UM turno via `runChatTurn`, streamando cada evento traduzido pro
 * browser. `chat-init`/`chat-done` atualizam a sessão em memória pro próximo
 * turno resolver `resume` corretamente (1 sessão ad-hoc por `rootDir`, ver
 * `studio-chat.ts`). `parsed.value.context` (#3687 — edição/arquivo/aba
 * abertos no painel, reenviado a cada turno pelo cliente) é repassado direto
 * pra `runChatTurn`, que o prefixa no `prompt` via `buildChatPrompt`.
 *
 * Único handler do server que escreve estado em memória — todo o resto do
 * arquivo permanece read-only (ver doc-comment do módulo).
 *
 * #3822: mede a duração do turno (`opts.nowFn`, default `Date.now`) desde
 * ANTES de `runChatTurn` até o evento `chat-done` chegar no `onEvent` abaixo,
 * e repassa pra `opts.chatDoneNotifyFn` (default `maybeNotifyChatDone`) —
 * disparo direto no fluxo que já emite o evento (não um watcher de polling
 * à parte, ver doc-comment de `studio-push-notify.ts`). Chamada
 * fire-and-forget (`.catch` só loga) — nunca atrasa o `res.write`/`res.end`
 * do turno em si, mesmo espírito fail-soft do resto do módulo.
 */
async function handleApiChat(
  rootDir: string,
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    queryFn?: QueryFn;
    maxBodyBytes: number;
    chatDoneNotifyFn?: typeof maybeNotifyChatDone;
    nowFn?: () => number;
    closeAbortDebounceMs?: number;
  },
): Promise<void> {
  let raw: string;
  try {
    raw = await readRequestBody(req, opts.maxBodyBytes);
  } catch (e) {
    sendJson(res, 413, { error: (e as Error).message });
    return;
  }

  const parsed = parseChatRequestBody(raw);
  if (!parsed.ok) {
    sendJson(res, 400, { error: parsed.error });
    return;
  }

  // #4078: o editor desativou o chat pelo painel (sinal explícito de "não
  // estou usando agora") — recusa a mensagem em vez de rodar o turno. Cobre
  // o caso de uma aba ANTIGA ainda aberta tentar enviar depois do toggle ser
  // desligado em outra aba/sessão (o toggle sozinho não fecha conexões já
  // abertas, só impede turnos NOVOS).
  if (!isChatEnabled(rootDir)) {
    sendJson(res, 409, {
      error: "chat desativado pelo painel — reative em \"Chat ativo\" no header do drawer antes de enviar mensagens.",
    });
    return;
  }

  if (parsed.value.reset) clearSession(rootDir);
  const sessionId = parsed.value.sessionId ?? getSessionId(rootDir);
  // #3803: a mensagem do editor nunca passa por `sdkMessageToChatEvents` (o
  // SDK só vê o `prompt` final montado por `buildChatPrompt`) — registrada
  // aqui, direto, pro histórico reidratável cobrir também o lado do editor.
  appendChatHistoryUserMessage(rootDir, parsed.value.message);

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  res.write(formatSseComment("connected"));

  const abortController = new AbortController();
  // #3887: `close` já não aborta a sessão real do Agent SDK no primeiro
  // evento — o abort de fato fica atrás de um debounce (`closeAbortGuard`,
  // `createCloseAbortGuard` em studio-chat.ts) pra tolerar uma queda de
  // rede transitória (celular trocando Wi-Fi→4G em cima do tunnel) sem
  // matar o turno.
  //
  // Escuta tanto `req` quanto `res` (achado deste PR, não coberto pela
  // redação original da issue): `req` é um Readable cujo 'close' já dispara
  // perto do fim de `readRequestBody` (corpo inteiro já consumido) — pra
  // uma request cujo corpo cabe num único chunk (o caso comum de uma
  // mensagem de chat digitada à mão), esse 'close' já fica pra trás ANTES
  // do listener abaixo existir, e o Node não reemite. `res` continua vivo
  // (escrevendo a stream SSE) e É o sinal que sobrevive confiável até o
  // socket de verdade cair — `createCloseAbortGuard.onClose()` é reentrante
  // por design (ver doc-comment), então registrar nos dois não duplica
  // abort nem quebra nada se algum dia os dois dispararem.
  const closeAbortGuard = createCloseAbortGuard(
    () => abortController.abort(),
    opts.closeAbortDebounceMs ?? DEFAULT_CHAT_CLOSE_ABORT_DEBOUNCE_MS,
  );
  req.on("close", closeAbortGuard.onClose);
  res.on("close", closeAbortGuard.onClose);

  const nowFn = opts.nowFn ?? Date.now;
  const chatDoneNotifyFn = opts.chatDoneNotifyFn ?? maybeNotifyChatDone;
  const turnStartedAt = nowFn();

  await runChatTurn({
    message: parsed.value.message,
    sessionId,
    cwd: rootDir,
    context: parsed.value.context,
    queryFn: opts.queryFn,
    abortController,
    onEvent: (wireEvent) => {
      if (wireEvent.event === "chat-init" && wireEvent.data.sessionId) {
        setSessionId(rootDir, wireEvent.data.sessionId);
      }
      if (wireEvent.event === "chat-done" && wireEvent.data.sessionId) {
        setSessionId(rootDir, wireEvent.data.sessionId);
      }
      // #3822: dispara DIRETO daqui (não de um watcher de polling à parte —
      // ver doc-comment de `handleApiChat`/`studio-push-notify.ts`) —
      // fire-and-forget, o `.catch` só loga; nunca atrasa o `res.write`
      // abaixo nem a resolução deste turno.
      if (wireEvent.event === "chat-done") {
        const durationMs = nowFn() - turnStartedAt;
        chatDoneNotifyFn(wireEvent, durationMs).catch((e) => {
          console.warn(`[studio-chat] notificação de turno concluído falhou: ${(e as Error).message}`);
        });
      }
      // #3803: acumula no buffer de histórico reidratável — mesmo evento já
      // traduzido pro SSE do browser, sem I/O extra nem depender do SDK.
      appendChatHistoryEvent(rootDir, wireEvent);
      // #3557 (fallback): se o navegador que abriu este turno já se
      // desconectou no instante em que a AskUserQuestion chega, não há UI
      // pra renderizar o form agora — logamos um aviso, mas a sessão SEGUE
      // esperando (mesma semântica do terminal: sem timeout). O gate ainda
      // aparece pro badge global via `/api/state` pra qualquer outra aba
      // conectada, e `POST /api/chat/answer` continua funcionando
      // normalmente quando alguém finalmente responder.
      if (
        (wireEvent.event === "chat-permission-request" ||
          wireEvent.event === "chat-tool-permission-request") &&
        (res.writableEnded || res.destroyed)
      ) {
        const kind =
          wireEvent.event === "chat-tool-permission-request"
            ? `gate de tool (${wireEvent.data.toolName})`
            : "AskUserQuestion";
        console.warn(
          `[studio-chat] ${kind} pendente (toolUseId=${wireEvent.data.toolUseId}) sem UI/SSE conectada no momento — a sessão continua esperando a resposta do editor.`,
        );
      }
      try {
        res.write(formatSseEvent(wireEvent.event, wireEvent.data));
      } catch {
        // conexão já fechada — a sessão SDK segue rodando/esperando de
        // qualquer forma; só não há mais pra onde emitir o evento.
      }
    },
  });

  req.off("close", closeAbortGuard.onClose);
  res.off("close", closeAbortGuard.onClose);
  // #3887: limpa o timer de debounce pendente (se `close` chegou a disparar
  // mas o turno terminou normalmente dentro da janela) — sem isto, um
  // `close` transitório que se resolveu sozinho ainda dispararia o abort
  // atrasado sobre um `abortController` de um turno que já terminou (inerte
  // na prática, mas o timer ficaria pendurado até disparar à toa).
  closeAbortGuard.cancel();
  res.end();
}

/**
 * `POST /api/chat/answer` (#3557) — resolve um gate `AskUserQuestion`
 * pendente. Corpo: `{toolUseId, answers, response?}` (`parseChatAnswerRequestBody`).
 * A resolução em si é `resolvePendingPermissionRequest` (`studio-chat.ts`):
 * localiza a Promise pendente pelo `toolUseId`, resolve com
 * `{behavior:'allow', updatedInput}` e a sessão original (bloqueada no
 * `for await` de `runChatTurn` dessa OUTRA request HTTP, a de `POST /api/chat`)
 * retoma sozinha — os eventos subsequentes (`chat-tool` end, mais deltas,
 * `chat-done`) continuam chegando na stream SSE já aberta daquela request,
 * sem qualquer coordenação extra aqui.
 */
async function handleApiChatAnswer(
  rootDir: string,
  req: IncomingMessage,
  res: ServerResponse,
  opts: { maxBodyBytes: number },
): Promise<void> {
  let raw: string;
  try {
    raw = await readRequestBody(req, opts.maxBodyBytes);
  } catch (e) {
    sendJson(res, 413, { error: (e as Error).message });
    return;
  }

  const parsed = parseChatAnswerRequestBody(raw);
  if (!parsed.ok) {
    sendJson(res, 400, { error: parsed.error });
    return;
  }

  const result = resolvePendingPermissionRequest(rootDir, parsed.value.toolUseId, {
    answers: parsed.value.answers,
    response: parsed.value.response,
  });
  sendJson(res, result.ok ? 200 : 404, result);
}

/**
 * `POST /api/chat/tool-decision` (#3804) — resolve um gate de TOOL pendente
 * (Bash/Edit/etc., não-`AskUserQuestion`). Corpo: `{toolUseId, decision}`
 * (`parseChatToolDecisionRequestBody`), `decision ∈ {allow, always, deny}`.
 * Simétrico a `handleApiChatAnswer`: a resolução (`resolvePendingToolPermission`)
 * destrava a Promise pendurada no `for await` de `runChatTurn` da OUTRA
 * request (a stream SSE de `POST /api/chat`), que retoma sozinha — a tool roda
 * (allow/always) ou o modelo recebe o deny e segue. `always` também libera a
 * tool pro resto da sessão (allowlist em memória, ver studio-chat.ts).
 */
async function handleApiChatToolDecision(
  rootDir: string,
  req: IncomingMessage,
  res: ServerResponse,
  opts: { maxBodyBytes: number },
): Promise<void> {
  let raw: string;
  try {
    raw = await readRequestBody(req, opts.maxBodyBytes);
  } catch (e) {
    sendJson(res, 413, { error: (e as Error).message });
    return;
  }

  const parsed = parseChatToolDecisionRequestBody(raw);
  if (!parsed.ok) {
    sendJson(res, 400, { error: parsed.error });
    return;
  }

  const result = resolvePendingToolPermission(rootDir, parsed.value.toolUseId, parsed.value.decision);
  sendJson(res, result.ok ? 200 : 404, result);
}

function handleTokensCss(res: ServerResponse): void {
  const css = buildTokensCss();
  res.writeHead(200, {
    "Content-Type": "text/css; charset=utf-8",
    "Content-Length": Buffer.byteLength(css),
  });
  res.end(css);
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  const body = Buffer.from(html, "utf8");
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": body.length,
  });
  res.end(body);
}

// #3563 (self-review): mensagens de erro (ex: exceção de node:sqlite/fetch)
// entram numa página HTML — escapar por padrão, mesmo em servidor
// loopback-only, é mais barato que justificar por que não em toda revisão.
function escHtmlLite(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// #3563 (endereça #3550): painel diária embutido — HTML autocontido, mesmo
// render do Worker (workers/diaria-dashboard), agregado localmente a partir
// de data/ (sempre fresco, sem KV). A aba "É IA?" embutida no MESMO
// documento cobre o pedido de embed do dashboard "poll" (data/poll-eia-summary.json).
function handlePainelDiaria(res: ServerResponse): void {
  buildDiariaDashboardHtml()
    .then((html) => sendHtml(res, 200, html))
    .catch((e) => {
      sendHtml(res, 500, `<!DOCTYPE html><html><body><h1>Painel diária — erro</h1><p>${escHtmlLite((e as Error).message)}</p></body></html>`);
    });
}

// #3563 (endereça #3553-A): painel Clarice/mensal local embutido — Brevo API
// direto + store SQLite local (contactsSummary), sem KV/Cloudflare. Async —
// respondido via promise chain (o handler HTTP síncrono não bloqueia
// aguardando; a resposta chega quando a promise resolve).
function handlePainelClarice(req: IncomingMessage, res: ServerResponse): void {
  const fresh = new URL(req.url ?? "/", "http://localhost").searchParams.get("fresh") === "1";
  buildClariceDashboardHtml({ fresh })
    .then((html) => sendHtml(res, 200, html))
    .catch((e) => {
      // #4187: `e` nem sempre é um Error (fetch nativo/dependência externa
      // pode lançar qualquer valor) -- `(e as Error).message` num não-Error é
      // `undefined`; guard evita que o `.catch()` em si lance de novo (o que
      // viraria unhandled rejection e derrubaria o processo do studio-server,
      // pior que um 500 por request).
      sendHtml(res, 500, `<!DOCTYPE html><html><body><h1>Painel Clarice — erro</h1><p>${escHtmlLite(e instanceof Error ? e.message : String(e))}</p></body></html>`);
    });
}

// ── #3559: painel de revisão de conteúdo rica ──────────────────────────

// #3559: teto de corpo pras rotas de escrita de revisão. Reusa o
// `readRequestBody(req, maxBytes)` do #3556 (mesmo helper) em vez de duplicar.
// 2 MB folga pra o maior 02-reviewed.md (~algumas dezenas de KB), mas ainda
// limita corpo absurdo.
const REVIEW_MAX_BODY_BYTES = 2_000_000;

function editionDirFor(rootDir: string, aammdd: string): string {
  return resolveEditionDir(resolve(rootDir, "data", "editions"), aammdd);
}

// #6447 Fatia 1: painel "Gate" — mesmo padrão fail-soft dos demais handlers
// de revisão (nunca lança; `buildGateSummary` já degrada campo a campo).
function handleGateSummary(rootDir: string, aammdd: string, res: ServerResponse): void {
  const summary = buildGateSummary(rootDir, aammdd);
  sendJson(res, summary.editionExists ? 200 : 404, summary);
}

function handleReviewGet(rootDir: string, aammdd: string, slug: string, res: ServerResponse): void {
  if (!isReviewSlug(slug)) {
    sendJson(res, 400, { error: "arquivo de revisão desconhecido", slug });
    return;
  }
  // #3723: pull best-effort do Drive (#494) removido — #3636 aposentou o
  // Drive sync do fluxo diário, então a pasta da edição nunca mais existe lá
  // e a chamada só desperdiçava latência a cada GET (spawnSync + falha
  // silenciosa garantida).
  const state = readReviewFile(rootDir, aammdd, slug);
  sendJson(res, state.ok ? 200 : 400, state);
}

function handleReviewDiff(rootDir: string, aammdd: string, slug: string, res: ServerResponse): void {
  if (!isReviewSlug(slug)) {
    sendJson(res, 400, { error: "arquivo de revisão desconhecido", slug });
    return;
  }
  const diff = computeReviewDiff(rootDir, aammdd, slug);
  sendJson(res, diff.ok ? 200 : 400, diff);
}

function handleReviewLint(rootDir: string, aammdd: string, slug: string, res: ServerResponse): void {
  if (!isReviewSlug(slug)) {
    sendJson(res, 400, { error: "arquivo de revisão desconhecido", slug });
    return;
  }
  const state = readReviewFile(rootDir, aammdd, slug);
  if (!state.ok || !state.exists) {
    sendJson(res, 200, { ok: true, checks: [], skipped: [], note: "arquivo ainda não existe — nada pra lintar" });
    return;
  }
  const report = runReviewLints(rootDir, editionDirFor(rootDir, aammdd), slug, state.content);
  sendJson(res, 200, report);
}

function handleReviewPreview(rootDir: string, aammdd: string, res: ServerResponse): void {
  const preview = buildReviewPreviewHtml(editionDirFor(rootDir, aammdd), aammdd);
  sendHtml(res, preview.ok ? 200 : 422, preview.html);
}

/** #3663: preview HTML do conteúdo social (`03-social.md`), análogo ao
 * preview de e-mail acima mas pro card LinkedIn/Facebook/Instagram — pedido
 * da issue: "só markdown cru" não deixava erro de formatação visível antes
 * de aprovar o gate do Stage 4. Mesmo status 200/422 e mesmo tipo de conteúdo
 * (`text/html`) do preview de e-mail. */
function handleReviewSocialPreview(rootDir: string, aammdd: string, res: ServerResponse): void {
  const preview = buildSocialPreviewHtml(editionDirFor(rootDir, aammdd), aammdd);
  sendHtml(res, preview.ok ? 200 : 422, preview.html);
}

/** #achado-260716: as imagens da edição (`04-d1-2x1.jpg` etc, geradas pela
 * Etapa 3) não apareciam no preview do painel de revisão — `renderHTML` do
 * pipeline produz `<img src="{{IMG:filename}}">`, um placeholder que só a
 * pipeline REAL resolve (upload público + substituição). `handleReviewPreview`
 * agora aponta esses placeholders pra esta rota, que serve o arquivo já
 * gerado em disco pela edição — sem subir nada publicamente cedo demais. */
function handleReviewImage(rootDir: string, aammdd: string, filename: string, res: ServerResponse): void {
  const resolved = resolveReviewImagePath(editionDirFor(rootDir, aammdd), filename);
  if (!resolved) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  const body = readFileSync(resolved);
  res.writeHead(200, { "Content-Type": mimeFor(resolved), "Content-Length": body.length, "Cache-Control": "no-store" });
  res.end(body);
}

async function handleReviewSave(
  rootDir: string,
  req: IncomingMessage,
  res: ServerResponse,
  aammdd: string,
  slug: string,
): Promise<void> {
  if (!isReviewSlug(slug)) {
    sendJson(res, 400, { error: "arquivo de revisão desconhecido", slug });
    return;
  }
  let body: unknown;
  try {
    body = JSON.parse(await readRequestBody(req, REVIEW_MAX_BODY_BYTES));
  } catch {
    sendJson(res, 400, { error: "corpo da request precisa ser JSON válido" });
    return;
  }
  const parsed = body as { content?: unknown; expectedModifiedAt?: unknown; force?: unknown } | null;
  const content = parsed?.content;
  if (typeof content !== "string") {
    sendJson(res, 400, { error: "campo 'content' (string) é obrigatório no corpo" });
    return;
  }
  // #3729: `expectedModifiedAt` (mtime ISO visto pelo client ao abrir o
  // painel, ou `null` quando o arquivo ainda não existia) é opcional — campo
  // ausente do corpo mantém compat com clients antigos (pula a checagem de
  // divergência, mesmo comportamento de antes). `force: true` ignora
  // divergência detectada (editor já confirmou no dialog de conflito).
  let expectedModifiedAt: string | null | undefined;
  if (parsed && "expectedModifiedAt" in parsed) {
    const raw = parsed.expectedModifiedAt ?? null;
    if (raw !== null && typeof raw !== "string") {
      sendJson(res, 400, { error: "campo 'expectedModifiedAt' precisa ser string ISO ou null" });
      return;
    }
    expectedModifiedAt = raw;
  }
  const force = parsed?.force === true;
  const result = saveReviewFile(rootDir, aammdd, slug, content, { expectedModifiedAt, force });
  const status = result.ok ? 200 : result.conflict ? 409 : 400;
  sendJson(res, status, result);
}

/**
 * #3806 (Opção B spike): `PUT /api/editions/:aammdd/review/reviewed/destaque-title`
 * — edição visual de UM campo (título de destaque) na visão renderizada, sem
 * expor o Markdown cru. Corpo: `{n: 1|2|3, title: string, expectedModifiedAt?,
 * force?}` — mesmo shape de guard de conflito de `handleReviewSave` (#3729),
 * reusado sem duplicação via `applyDestaqueTitleEdit` (que já chama
 * `saveReviewFile` internamente). Resposta inclui `lint` (rede de segurança
 * de sempre, não bloqueia o save — mesmo comportamento do editor de MD: o
 * editor decide o que fazer com um lint vermelho).
 */
async function handleReviewFieldDestaqueTitle(
  rootDir: string,
  req: IncomingMessage,
  res: ServerResponse,
  aammdd: string,
): Promise<void> {
  let body: unknown;
  try {
    body = JSON.parse(await readRequestBody(req, REVIEW_MAX_BODY_BYTES));
  } catch {
    sendJson(res, 400, { error: "corpo da request precisa ser JSON válido" });
    return;
  }
  const parsed = body as { n?: unknown; title?: unknown; expectedModifiedAt?: unknown; force?: unknown } | null;
  const n = parsed?.n;
  if (n !== 1 && n !== 2 && n !== 3) {
    sendJson(res, 400, { error: "campo 'n' (1, 2 ou 3) é obrigatório no corpo" });
    return;
  }
  const title = parsed?.title;
  if (typeof title !== "string" || title.trim() === "") {
    sendJson(res, 400, { error: "campo 'title' (string não-vazia) é obrigatório no corpo" });
    return;
  }
  // #3729: mesmo contrato de expectedModifiedAt/force de handleReviewSave —
  // ver comentário lá pro rationale completo (não duplicado aqui).
  let expectedModifiedAt: string | null | undefined;
  if (parsed && "expectedModifiedAt" in parsed) {
    const raw = parsed.expectedModifiedAt ?? null;
    if (raw !== null && typeof raw !== "string") {
      sendJson(res, 400, { error: "campo 'expectedModifiedAt' precisa ser string ISO ou null" });
      return;
    }
    expectedModifiedAt = raw;
  }
  const force = parsed?.force === true;
  const result = applyDestaqueTitleEdit(rootDir, aammdd, n, title, { expectedModifiedAt, force });
  const status = result.ok ? 200 : result.conflict ? 409 : 400;
  sendJson(res, status, result);
}

function handleReviewResetBaseline(rootDir: string, aammdd: string, slug: string, res: ServerResponse): void {
  if (!isReviewSlug(slug)) {
    sendJson(res, 400, { error: "arquivo de revisão desconhecido", slug });
    return;
  }
  const result = resetBaseline(rootDir, aammdd, slug);
  sendJson(res, result.ok ? 200 : 400, result);
}

// ── #3602: CRM simples de apoios apoia.se ───────────────────────────────

// Corpo pequeno (nome + emails + notas livres) — 200KB é generoso e mantém o
// mesmo teto de proteção contra corpo absurdo dos outros handlers de escrita.
const APOIOS_MAX_BODY_BYTES = 200_000;

/** `GET /api/apoios` — contatos + status cruzado + campanha (#3602). Sempre
 * 200: `buildApoiosData` é fail-soft (data/ ausente, credenciais ausentes,
 * 401 da apoia.se viram `error` no payload, nunca uma exceção). */
function handleApiApoiosGet(rootDir: string, res: ServerResponse): void {
  buildApoiosData(rootDir)
    .then((data) => sendJson(res, 200, data))
    .catch((e) => sendJson(res, 500, { error: (e as Error).message }));
}

/** `POST /api/apoios/refresh` — botão "Atualizar status" (#3859, as DUAS
 * metades): (1) drena notificações "novo apoio" do Gmail pessoal e importa
 * contato automaticamente pra apoiador ainda não cadastrado; (2) força
 * re-consulta do mês corrente na apoia.se, mas só pra contatos AINDA NÃO
 * confirmados como "apoiando" (protege o teto de 5.000 req/mês) — ver
 * `refreshApoiosData` em `studio-apoios.ts`. Sempre 200: fail-soft no mesmo
 * padrão de `handleApiApoiosGet` (falha de qualquer uma das duas etapas vira
 * `error` no payload, nunca derruba a outra nem a rota). */
function handleApiApoiosRefresh(
  rootDir: string,
  res: ServerResponse,
  gmailDrain?: () => Promise<DrainApoiaSeResult>,
): void {
  refreshApoiosData(rootDir, { gmailDrain })
    .then((data) => sendJson(res, 200, data))
    .catch((e) => sendJson(res, 500, { error: (e as Error).message }));
}

/** Único ponto de mapeamento resultado→status HTTP pra mutação que pode
 * alvejar um id inexistente (update) — evita duplicar (e desalinhar) o
 * `result.error.includes("não encontrado") ? 404 : 400` caso outra mutação
 * do mesmo tipo apareça no futuro. (#3844: a outra chamadora, outreach, foi
 * removida.) */
function sendApoiosMutationResult(res: ServerResponse, result: ApoiosMutationResult): void {
  if (result.ok) {
    sendJson(res, 200, result);
    return;
  }
  sendJson(res, result.error.includes("não encontrado") ? 404 : 400, result);
}

async function handleApiApoiosUpdate(
  rootDir: string,
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
): Promise<void> {
  let raw: string;
  try {
    raw = await readRequestBody(req, APOIOS_MAX_BODY_BYTES);
  } catch (e) {
    sendJson(res, 413, { error: (e as Error).message });
    return;
  }
  const parsed = parseUpdateContactBody(raw);
  if (!parsed.ok) {
    sendJson(res, 400, { error: parsed.error });
    return;
  }
  const result = updateContactById(rootDir, id, parsed.value);
  sendApoiosMutationResult(res, result);
}

// #3924: seção "Caixas" — handlers movidos pra ./routes/boxes.ts (#5894).

// ── #3848: status de todas as integrações (APIs + MCPs) ────────────────

/** `GET /api/integrations` — status de todas as integrações (#3848). Sempre
 * 200: `buildIntegrationsData` é fail-soft por design (cada integração é
 * avaliada isoladamente, nenhum probe individual derruba a resposta).
 * `?refresh=1` bypassa o cache de 5min (botão "Atualizar" da UI). */
function handleApiIntegrations(
  rootDir: string,
  req: IncomingMessage,
  res: ServerResponse,
  fetchImpl?: typeof fetch,
): void {
  const forceRefresh = new URL(req.url ?? "/", "http://localhost").searchParams.get("refresh") === "1";
  buildIntegrationsData(rootDir, { forceRefresh, fetchImpl })
    .then((data) => sendJson(res, 200, data))
    .catch((e) => sendJson(res, 500, { error: (e as Error).message }));
}

// ── #4041: inventário de UTMs × conversão × clique ─────────────────────

/** `GET /api/utms` — inventário do registry cruzado com Beehiiv (conversão)
 * e Brevo (clique), mais o drift nos dois sentidos. Sempre 200:
 * `buildUtmsData` é fail-soft por design (cada fonte externa vira campo
 * `error` próprio). `?refresh=1` bypassa o cache de 10min. */
function handleApiUtms(rootDir: string, req: IncomingMessage, res: ServerResponse): void {
  const forceRefresh = new URL(req.url ?? "/", "http://localhost").searchParams.get("refresh") === "1";
  buildUtmsData(rootDir, { forceRefresh })
    .then((data) => sendJson(res, 200, data))
    .catch((e) => sendJson(res, 500, { error: (e as Error).message }));
}

/** `PUT /api/utms/:id` — edita METADADOS editoriais de um emissor
 * (description/status/note). Nunca os VALORES de UTM: `saveUtmMetadata`
 * rejeita (400) qualquer campo fora da allowlist, porque um source/campaign
 * editado pela UI dessincronizaria a página do que o emissor realmente
 * produz (ver header de studio-utms.ts). */
async function handleApiUtmsPut(
  rootDir: string,
  id: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let patch: Record<string, unknown>;
  try {
    const raw = await readRequestBody(req, 64 * 1024);
    patch = JSON.parse(raw || "{}");
  } catch (e) {
    sendJson(res, 400, { ok: false, error: `corpo inválido: ${(e as Error).message}` });
    return;
  }
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    sendJson(res, 400, { ok: false, error: "corpo precisa ser um objeto JSON" });
    return;
  }
  const result = saveUtmMetadata(rootDir, id, patch);
  sendJson(res, result.ok ? 200 : 400, result);
}

// ── #4270: catálogo read-only de skills (.claude/skills/*/SKILL.md) ────

/** `GET /api/skills` — inventário das skills versionadas, gerado do
 * filesystem (`buildSkillsData`). Sempre 200: leitura local só de arquivos
 * pequenos, sem rede/credencial — o único jeito de falhar é `rootDir`
 * inacessível, que já quebraria o server inteiro antes de chegar aqui. */
function handleApiSkills(rootDir: string, res: ServerResponse): void {
  try {
    sendJson(res, 200, buildSkillsData(rootDir));
  } catch (e) {
    sendJson(res, 500, { error: (e as Error).message });
  }
}

// ── #4799: status de todas as tasks agendadas (registro declarativo) ──

/** `GET /api/tasks` — status de TODAS as `SCHEDULED_TASKS` (#4799): armada?
 * última execução (quando/duração/resultado/trecho de log)? próxima
 * prevista? atraso? Sempre 200: `buildTasksData` é fail-soft por task
 * (mesmo padrão de `handleApiIntegrations`/`buildIntegrationsData`).
 * `?refresh=1` bypassa o cache de 2min (botão "Atualizar" da UI). */
function handleApiTasks(rootDir: string, req: IncomingMessage, res: ServerResponse): void {
  try {
    const forceRefresh = new URL(req.url ?? "/", "http://localhost").searchParams.get("refresh") === "1";
    sendJson(res, 200, buildTasksData(rootDir, { forceRefresh }));
  } catch (e) {
    sendJson(res, 500, { error: (e as Error).message });
  }
}

// ── #5236: custo por leitor por canal ──

/** `GET /api/ads` — custo por leitor por canal (#5236): qual canal traz
 * leitor mais barato? abertura da coorte vs. base? orçamento do mês
 * consumido? degradação desde o snapshot anterior? Sempre 200:
 * `buildAdsData` é fail-soft por camada (spend/snapshot/origem — nunca
 * lança, mesmo em sessão cloud sem `data/`). `?refresh=1` bypassa o cache
 * de 10min (botão "Atualizar" da UI). */
function handleApiAds(rootDir: string, req: IncomingMessage, res: ServerResponse): void {
  try {
    const forceRefresh = new URL(req.url ?? "/", "http://localhost").searchParams.get("refresh") === "1";
    sendJson(res, 200, buildAdsData(rootDir, { forceRefresh }));
  } catch (e) {
    sendJson(res, 500, { error: (e as Error).message });
  }
}

/** `POST /api/painel/eia/refresh` — botão "Atualizar É IA?" (#3861): regenera
 * SÓ `data/poll-eia-summary.json` local a partir dos endpoints públicos do
 * worker poll (`refreshPollEiaSummaryLocal`) — NUNCA dispara o push paralelo
 * pro KV do clarice-dashboard que o CLI `--push` faz (ver docstring do
 * módulo). Sempre 200: `refreshPollEiaSummaryLocal` é fail-soft por
 * construção (data/editions ausente, sem edições, falha de rede/escrita
 * viram `{ok:false,error}`, nunca uma exceção).
 * `?force=1` (#3882) — o botão sempre manda essa flag — ignora o cache TTL
 * curto de `refreshPollEiaSummaryLocal` e garante um fetch novo ao worker poll. */
function handleApiPainelEiaRefresh(rootDir: string, req: IncomingMessage, res: ServerResponse): void {
  const force = new URL(req.url ?? "/", "http://localhost").searchParams.get("force") === "1";
  refreshPollEiaSummaryLocal({ rootDir, force })
    .then((result) => sendJson(res, 200, result))
    .catch((e) => sendJson(res, 500, { ok: false, error: (e as Error).message }));
}

/**
 * Sobe o studio-server. `rootDir` default é `process.cwd()` (o repo aberto
 * no Claude Code); injete um tmpdir em testes.
 */
export async function startStudioServer(opts: StudioServerOptions = {}): Promise<StudioServer> {
  const rootDir = resolve(opts.rootDir ?? process.cwd());
  const runLogTailSize = opts.runLogTailSize ?? 50;
  const pollIntervalMs = opts.pollIntervalMs ?? 1000;
  const ghRun = opts.ghRun;
  const chatQueryFn = opts.chatQueryFn;
  const chatMaxBodyBytes = opts.chatMaxBodyBytes ?? 256_000;
  const chatDoneNotifyFn = opts.chatDoneNotifyFn;
  const chatDoneNowFn = opts.chatDoneNowFn;
  const chatCloseAbortDebounceMs = opts.chatCloseAbortDebounceMs;
  const apoiosGmailDrain = opts.apoiosGmailDrain;
  const integrationsFetchImpl = opts.integrationsFetchImpl;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    try {
      const urlPath = (req.url ?? "/").split("?")[0];

      // #3556: rota de chat aceita POST — mutação/ação (sessão de chat),
      // tratada ANTES do guard read-only genérico abaixo.
      if (urlPath === "/api/chat") {
        if (req.method !== "POST") {
          sendJson(res, 405, { error: "POST obrigatório em /api/chat" });
          return;
        }
        handleApiChat(rootDir, req, res, {
          queryFn: chatQueryFn,
          maxBodyBytes: chatMaxBodyBytes,
          chatDoneNotifyFn,
          nowFn: chatDoneNowFn,
          closeAbortDebounceMs: chatCloseAbortDebounceMs,
        }).catch((e) => {
          // runChatTurn já é fail-soft (erros do SDK viram evento chat-error);
          // este catch cobre só falhas síncronas anteriores (ex: writeHead
          // já chamado e o socket morreu no meio) — sem headers ainda
          // enviados, respondemos 500; senão só fechamos a conexão.
          if (!res.headersSent) {
            sendJson(res, 500, { error: (e as Error).message });
          } else {
            res.end();
          }
        });
        return;
      }

      // #3557: resolve um gate AskUserQuestion pendente — mesmo tratamento
      // "rota de mutação checada antes do guard read-only" de /api/chat acima.
      if (urlPath === "/api/chat/answer") {
        if (req.method !== "POST") {
          sendJson(res, 405, { error: "POST obrigatório em /api/chat/answer" });
          return;
        }
        handleApiChatAnswer(rootDir, req, res, { maxBodyBytes: chatMaxBodyBytes }).catch((e) => {
          if (!res.headersSent) {
            sendJson(res, 500, { error: (e as Error).message });
          } else {
            res.end();
          }
        });
        return;
      }

      // #3804: resolve um gate de TOOL pendente (Bash/etc.) — mesmo tratamento
      // "rota de mutação checada antes do guard read-only" de /api/chat/answer.
      if (urlPath === "/api/chat/tool-decision") {
        if (req.method !== "POST") {
          sendJson(res, 405, { error: "POST obrigatório em /api/chat/tool-decision" });
          return;
        }
        handleApiChatToolDecision(rootDir, req, res, { maxBodyBytes: chatMaxBodyBytes }).catch((e) => {
          if (!res.headersSent) {
            sendJson(res, 500, { error: (e as Error).message });
          } else {
            res.end();
          }
        });
        return;
      }

      // #4078: liga/desliga o chat do painel — mesmo tratamento "rota de
      // mutação checada antes do guard read-only" das rotas de /api/chat/*
      // acima. GET (leitura do estado atual) é tratado mais abaixo, junto
      // das outras rotas read-only de /api/chat/*.
      if (urlPath === "/api/chat/enabled" && req.method === "PUT") {
        handleApiChatEnabledSave(rootDir, req, res).catch((e) => {
          if (!res.headersSent) {
            sendJson(res, 500, { error: (e as Error).message });
          } else {
            res.end();
          }
        });
        return;
      }

      // #3559: exceção estreita ao invariante read-only (ver nota no topo do
      // arquivo) — só estas 3 rotas aceitam método de escrita, e só pra
      // AÇÕES do painel de revisão de conteúdo. Checadas ANTES do guard
      // genérico de método, senão cairiam no 405.
      const reviewFileMatch = urlPath.match(/^\/api\/editions\/([^/]+)\/review\/([^/]+)$/);
      if (req.method === "PUT" && reviewFileMatch) {
        handleReviewSave(rootDir, req, res, reviewFileMatch[1], reviewFileMatch[2]).catch((e) =>
          sendJson(res, 500, { error: (e as Error).message }),
        );
        return;
      }
      // #3806 (Opção B spike): edição visual de campo — checada ANTES do
      // `resetBaselineMatch` abaixo por convenção (rotas de escrita mais
      // específicas primeiro), embora os regex não colidam de fato (`/lint`
      // vs `/destaque-title` são sufixos distintos).
      const destaqueTitleMatch = urlPath.match(/^\/api\/editions\/([^/]+)\/review\/reviewed\/destaque-title$/);
      if (req.method === "PUT" && destaqueTitleMatch) {
        handleReviewFieldDestaqueTitle(rootDir, req, res, destaqueTitleMatch[1]).catch((e) =>
          sendJson(res, 500, { error: (e as Error).message }),
        );
        return;
      }
      const resetBaselineMatch = urlPath.match(/^\/api\/editions\/([^/]+)\/review\/([^/]+)\/reset-baseline$/);
      if (req.method === "POST" && resetBaselineMatch) {
        handleReviewResetBaseline(rootDir, resetBaselineMatch[1], resetBaselineMatch[2], res);
        return;
      }
      // #3602: exceção estreita ao invariante read-only, mesmo padrão do
      // #3559 acima — CRUD do CRM de apoios. Checada ANTES do guard
      // genérico de método. (#3862: a rota de criação manual,
      // `POST /api/apoios/contacts`, foi removida junto com o form — só a
      // edição de contato existente segue como mutação HTTP.)
      const apoiosUpdateMatch = urlPath.match(/^\/api\/apoios\/contacts\/([^/]+)$/);
      if (req.method === "PUT" && apoiosUpdateMatch) {
        handleApiApoiosUpdate(rootDir, req, res, decodeURIComponent(apoiosUpdateMatch[1])).catch((e) =>
          sendJson(res, 500, { error: (e as Error).message }),
        );
        return;
      }
      // #3859 (as duas metades): botão "Atualizar status" — import automático
      // via e-mail apoia.se (metade 1) + force-refresh seletivo do mês
      // corrente na apoia.se (metade 2). Mesmo tratamento das rotas de
      // escrita acima (checada antes do guard genérico de método).
      if (urlPath === "/api/apoios/refresh" && req.method === "POST") {
        handleApiApoiosRefresh(rootDir, res, apoiosGmailDrain);
        return;
      }
      // #3861: botão "Atualizar É IA?" — mesmo tratamento das rotas de
      // escrita acima (checada antes do guard genérico de método).
      if (urlPath === "/api/painel/eia/refresh" && req.method === "POST") {
        handleApiPainelEiaRefresh(rootDir, req, res);
        return;
      }
      // #3937: salvar a atribuição dos 3 slots de divulgação — checado ANTES
      // do save genérico de caixa logo abaixo (mesmo motivo do #3928 pra
      // "archived": o regex `/api/boxes/:slug` casaria "slots" também, já
      // que não tem barra adicional pra diferenciar).
      if (urlPath === "/api/boxes/slots" && req.method === "PUT") {
        handleApiBoxSlotsSave(rootDir, req, res).catch((e) =>
          sendJson(res, 500, { error: (e as Error).message }),
        );
        return;
      }
      // #4274: salvar o conteúdo dos slots A/B do PARA ENCERRAR — mesmo
      // motivo de checagem antecipada do bloco de "slots" acima (o regex
      // `/api/boxes/:slug` casaria "para-encerrar" também).
      if (urlPath === "/api/boxes/para-encerrar" && req.method === "PUT") {
        handleApiParaEncerrarSave(rootDir, req, res).catch((e) =>
          sendJson(res, 500, { error: (e as Error).message }),
        );
        return;
      }
      // #3924: seção "Caixas" — salvar 1 snippet. Mesmo tratamento das rotas
      // de escrita acima (checada antes do guard genérico de método).
      const boxSaveMatch = urlPath.match(/^\/api\/boxes\/([^/]+)$/);
      if (req.method === "PUT" && boxSaveMatch) {
        handleApiBoxSave(rootDir, req, res, decodeURIComponent(boxSaveMatch[1])).catch((e) =>
          sendJson(res, 500, { error: (e as Error).message }),
        );
        return;
      }
      // #4041: editar METADADOS de um emissor de UTM (description/status/note).
      // Antes do guard de método, como as demais rotas de escrita. Os VALORES
      // de UTM continuam read-only pela UI — `saveUtmMetadata` devolve 400.
      const utmMetaMatch = urlPath.match(/^\/api\/utms\/([^/]+)$/);
      if (req.method === "PUT" && utmMetaMatch) {
        handleApiUtmsPut(rootDir, decodeURIComponent(utmMetaMatch[1]), req, res).catch((e) =>
          sendJson(res, 500, { ok: false, error: (e as Error).message }),
        );
        return;
      }
      // #3928: criar caixa nova — POST /api/boxes (bare). Antes do guard de
      // método (mesma disciplina das rotas de escrita acima).
      if (urlPath === "/api/boxes" && req.method === "POST") {
        handleApiBoxCreate(rootDir, req, res).catch((e) =>
          sendJson(res, 500, { error: (e as Error).message }),
        );
        return;
      }
      // #3928: arquivar / restaurar caixa — POST /api/boxes/:slug/(archive|
      // unarchive). Regex com sufixo não colide com o save (`.../:slug$`).
      const boxArchiveMatch = urlPath.match(/^\/api\/boxes\/([^/]+)\/archive$/);
      if (req.method === "POST" && boxArchiveMatch) {
        handleApiBoxArchive(rootDir, decodeURIComponent(boxArchiveMatch[1]), res);
        return;
      }
      const boxUnarchiveMatch = urlPath.match(/^\/api\/boxes\/([^/]+)\/unarchive$/);
      if (req.method === "POST" && boxUnarchiveMatch) {
        handleApiBoxUnarchive(rootDir, decodeURIComponent(boxUnarchiveMatch[1]), res);
        return;
      }

      if (req.method !== "GET" && req.method !== "HEAD") {
        sendJson(res, 405, { error: "method not allowed — studio-server é read-only nesta fatia (#3555), exceto POST /api/chat (#3556) e as rotas de ação do #3559/#3602/#3806/#3859/#3861/#3924/#3928/#4078" });
        return;
      }

      if (urlPath === "/api/state") {
        handleApiState(rootDir, res);
        return;
      }
      // #3617: hidratação do chat drawer — checada antes de /api/events pra
      // não colidir com o guard genérico de rota de API desconhecida abaixo.
      if (urlPath === "/api/chat/pending") {
        handleApiChatPending(rootDir, res);
        return;
      }
      // #3803: reidratação do TRANSCRIPT do chat drawer — mesmo motivo de
      // checagem antecipada do bloco acima (não colidir com o guard genérico
      // de rota de API desconhecida mais abaixo).
      if (urlPath === "/api/chat/history") {
        handleApiChatHistory(rootDir, req, res);
        return;
      }
      // #4078: estado ATUAL do toggle "chat ativo/desativado" — o PUT (escrita)
      // já foi tratado acima, na seção de mutação.
      if (urlPath === "/api/chat/enabled") {
        handleApiChatEnabledGet(rootDir, res);
        return;
      }
      if (urlPath === "/api/events") {
        handleApiEvents(rootDir, req, res, { runLogTailSize, pollIntervalMs });
        return;
      }
      const editionMatch = urlPath.match(/^\/api\/editions\/([^/]+)$/);
      if (editionMatch) {
        handleApiEdition(rootDir, editionMatch[1], res);
        return;
      }
      if (urlPath === "/api/issues") {
        handleApiIssues(rootDir, res, ghRun);
        return;
      }
      // #3841 item 2/3: sequência cronológica de TODAS as rodadas — checada
      // ANTES do regex de `/api/round/:kind` abaixo (não colide, mas mesma
      // disciplina de ordenação das demais rotas de prefixo compartilhado
      // deste arquivo, ex: `/api/chat/*` antes de `/api/events`).
      if (urlPath === "/api/rounds") {
        handleApiRounds(rootDir, res);
        return;
      }
      // #3561: fila classificada + timeline de uma rodada overnight/develop.
      const roundMatch = urlPath.match(/^\/api\/round\/([^/]+)$/);
      if (roundMatch) {
        handleApiRound(rootDir, roundMatch[1], req, res);
        return;
      }
      // #3714: superfície de Relatórios — lista (JSON) + conteúdo (HTML).
      if (urlPath === "/api/reports") {
        handleApiReports(rootDir, res);
        return;
      }
      const reportContentMatch = urlPath.match(/^\/relatorios\/([^/]+)$/);
      if (reportContentMatch) {
        handleReportContent(rootDir, decodeURIComponent(reportContentMatch[1]), res);
        return;
      }
      // #3602: CRM de apoios — GET (POST/PUT de mutação já tratados acima,
      // antes do guard de método).
      if (urlPath === "/api/apoios") {
        handleApiApoiosGet(rootDir, res);
        return;
      }
      // #3848: status de todas as integrações (APIs + MCPs).
      if (urlPath === "/api/integrations") {
        handleApiIntegrations(rootDir, req, res, integrationsFetchImpl);
        return;
      }
      // #4041: inventário de UTMs × conversão × clique.
      if (urlPath === "/api/utms") {
        handleApiUtms(rootDir, req, res);
        return;
      }
      // #4270: catálogo read-only de skills.
      if (urlPath === "/api/skills") {
        handleApiSkills(rootDir, res);
        return;
      }
      // #4799: status de todas as tasks agendadas.
      if (urlPath === "/api/tasks") {
        handleApiTasks(rootDir, req, res);
        return;
      }
      // #5236: custo por leitor por canal.
      if (urlPath === "/api/ads") {
        handleApiAds(rootDir, req, res);
        return;
      }
      // #3924: seção "Caixas" — GET (PUT de save já tratado acima, antes do
      // guard de método). Lista checada antes do get-por-slug pra não colidir
      // (regex de slug `[^/]+` casaria "boxes" também se checado depois, mas
      // "/api/boxes" bare não tem barra final pro regex de slug casar — a
      // ordem aqui é só disciplina de leitura, mesmo padrão do resto do arquivo).
      if (urlPath === "/api/boxes") {
        handleApiBoxesList(rootDir, res);
        return;
      }
      // #3928: lista de caixas ARQUIVADas — checada ANTES do get-por-slug
      // abaixo (o regex `/api/boxes/([^/]+)` casaria "archived" como slug e
      // devolveria 404).
      if (urlPath === "/api/boxes/archived") {
        handleApiArchivedBoxesList(rootDir, res);
        return;
      }
      // #3937: atribuição atual dos 3 slots de divulgação — mesmo motivo de
      // checagem antecipada do bloco acima ("archived"): o regex de
      // get-por-slug casaria "slots" também.
      if (urlPath === "/api/boxes/slots") {
        handleApiBoxSlotsGet(rootDir, req, res);
        return;
      }
      // #4274: conteúdo atual dos slots A/B do PARA ENCERRAR — mesmo motivo
      // de checagem antecipada do bloco de "slots" acima.
      if (urlPath === "/api/boxes/para-encerrar") {
        handleApiParaEncerrarGet(rootDir, res);
        return;
      }
      const boxGetMatch = urlPath.match(/^\/api\/boxes\/([^/]+)$/);
      if (boxGetMatch) {
        handleApiBoxGet(rootDir, decodeURIComponent(boxGetMatch[1]), res);
        return;
      }
      // #3559: painel de revisão de conteúdo rica — leitura (GET) do arquivo,
      // diff contra baseline, lints e preview do e-mail. As rotas de ESCRITA
      // (PUT/POST) já foram tratadas acima, antes do guard de método.
      const reviewLintMatch = urlPath.match(/^\/api\/editions\/([^/]+)\/review\/([^/]+)\/lint$/);
      if (reviewLintMatch) {
        handleReviewLint(rootDir, reviewLintMatch[1], reviewLintMatch[2], res);
        return;
      }
      const reviewDiffMatch = urlPath.match(/^\/api\/editions\/([^/]+)\/review\/([^/]+)\/diff$/);
      if (reviewDiffMatch) {
        handleReviewDiff(rootDir, reviewDiffMatch[1], reviewDiffMatch[2], res);
        return;
      }
      const reviewGetMatch = urlPath.match(/^\/api\/editions\/([^/]+)\/review\/([^/]+)$/);
      if (reviewGetMatch) {
        handleReviewGet(rootDir, reviewGetMatch[1], reviewGetMatch[2], res);
        return;
      }
      // #6447 Fatia 1: painel "Gate" — checado ANTES do preview genérico
      // abaixo (regex distinto, não colide, mas mantém a leitura por seção).
      const gateMatch = urlPath.match(/^\/api\/editions\/([^/]+)\/gate$/);
      if (gateMatch) {
        handleGateSummary(rootDir, gateMatch[1], res);
        return;
      }
      const reviewPreviewMatch = urlPath.match(/^\/api\/editions\/([^/]+)\/preview\.html$/);
      if (reviewPreviewMatch) {
        handleReviewPreview(rootDir, reviewPreviewMatch[1], res);
        return;
      }
      // #3663: preview do conteúdo social — checado ANTES do preview de
      // e-mail acima seria redundante (regex distinto, `/social-preview.html`
      // nunca casa `/preview.html`), mas a ordem aqui espelha a leitura
      // natural (e-mail primeiro, social logo depois).
      const socialPreviewMatch = urlPath.match(/^\/api\/editions\/([^/]+)\/social-preview\.html$/);
      if (socialPreviewMatch) {
        handleReviewSocialPreview(rootDir, socialPreviewMatch[1], res);
        return;
      }
      const reviewImageMatch = urlPath.match(/^\/api\/editions\/([^/]+)\/image\/([^/]+)$/);
      if (reviewImageMatch) {
        handleReviewImage(rootDir, reviewImageMatch[1], decodeURIComponent(reviewImageMatch[2]), res);
        return;
      }
      if (urlPath === "/tokens.generated.css") {
        handleTokensCss(res);
        return;
      }
      // #3563: painéis embutidos (diária/poll + Clarice-mensal), servidos
      // localmente a partir dos dados-fonte frescos — ver dashboard-diaria.ts
      // e dashboard-clarice.ts.
      if (urlPath === "/painel/diaria") {
        handlePainelDiaria(res);
        return;
      }
      if (urlPath === "/painel/clarice") {
        handlePainelClarice(req, res);
        return;
      }
      if (urlPath.startsWith("/api/")) {
        sendJson(res, 404, { error: "rota de API desconhecida", path: urlPath });
        return;
      }
      // #3558: rewrite client-side-routed pra o shell estático — a página
      // valida o AAMMDD e busca dados via /api/editions/:aammdd (mesmo guard
      // de 400/404 já coberto por handleApiEdition).
      if (/^\/edicao\/[^/]+\/?$/.test(urlPath)) {
        const served = serveStaticFile(PUBLIC_DIR, "/edicao.html", res, req);
        if (!served) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Not found");
        }
        return;
      }
      // #3559: mesma estratégia de rewrite — a página busca
      // /api/editions/:aammdd/review/:slug (+ diff/lint/preview.html).
      if (/^\/revisao\/[^/]+\/?$/.test(urlPath)) {
        const served = serveStaticFile(PUBLIC_DIR, "/revisao.html", res, req);
        if (!served) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Not found");
        }
        return;
      }
      // #3562: mesma estratégia de rewrite — a página busca /api/issues.
      if (urlPath === "/triagem" || urlPath === "/triagem/") {
        const served = serveStaticFile(PUBLIC_DIR, "/triagem.html", res, req);
        if (!served) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Not found");
        }
        return;
      }
      // #3561: mesma estratégia de rewrite — a página busca /api/round/:kind.
      if (urlPath === "/rodada" || urlPath === "/rodada/") {
        const served = serveStaticFile(PUBLIC_DIR, "/rodada.html", res, req);
        if (!served) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Not found");
        }
        return;
      }
      // #3602: mesma estratégia de rewrite — a página busca /api/apoios.
      if (urlPath === "/apoios" || urlPath === "/apoios/") {
        const served = serveStaticFile(PUBLIC_DIR, "/apoios.html", res, req);
        if (!served) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Not found");
        }
        return;
      }
      // #3924: mesma estratégia de rewrite — a página busca /api/boxes.
      if (urlPath === "/caixas" || urlPath === "/caixas/") {
        const served = serveStaticFile(PUBLIC_DIR, "/caixas.html", res, req);
        if (!served) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Not found");
        }
        return;
      }
      // #4041: mesma estratégia de rewrite — a página busca /api/utms.
      if (urlPath === "/utms" || urlPath === "/utms/") {
        const served = serveStaticFile(PUBLIC_DIR, "/utms.html", res, req);
        if (!served) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Not found");
        }
        return;
      }
      // #4270: mesma estratégia de rewrite — a página busca /api/skills.
      if (urlPath === "/skills" || urlPath === "/skills/") {
        const served = serveStaticFile(PUBLIC_DIR, "/skills.html", res, req);
        if (!served) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Not found");
        }
        return;
      }
      // #4799: mesma estratégia de rewrite — a página busca /api/tasks.
      if (urlPath === "/tarefas" || urlPath === "/tarefas/") {
        const served = serveStaticFile(PUBLIC_DIR, "/tarefas.html", res, req);
        if (!served) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Not found");
        }
        return;
      }
      // #5236: mesma estratégia de rewrite — a página busca /api/ads.
      if (urlPath === "/ads" || urlPath === "/ads/") {
        const served = serveStaticFile(PUBLIC_DIR, "/ads.html", res, req);
        if (!served) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Not found");
        }
        return;
      }
      // #3848: mesma estratégia de rewrite — a página busca /api/integrations.
      if (urlPath === "/integracoes" || urlPath === "/integracoes/") {
        const served = serveStaticFile(PUBLIC_DIR, "/integracoes.html", res, req);
        if (!served) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Not found");
        }
        return;
      }
      // #3714: mesma estratégia de rewrite — a página busca /api/reports.
      // Só o path BARE (sem id) — `/relatorios/:id` (conteúdo do relatório em
      // si) já foi tratado acima, antes deste bloco.
      if (urlPath === "/relatorios" || urlPath === "/relatorios/") {
        const served = serveStaticFile(PUBLIC_DIR, "/relatorios.html", res, req);
        if (!served) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Not found");
        }
        return;
      }

      const served = serveStaticFile(PUBLIC_DIR, urlPath, res, req);
      if (!served) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
      }
    } catch (e) {
      sendJson(res, 500, { error: (e as Error).message });
    }
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? DEFAULT_PORT, HOST, () => resolvePromise());
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (opts.port ?? DEFAULT_PORT);

  // #3564: watcher independente de qualquer cliente SSE conectado — o
  // cenário-alvo é justamente o editor longe do computador (nenhuma aba do
  // Studio aberta). Fail-soft por construção (ver studio-push-notify.ts).
  const pushNotifyWatch: PushNotifyWatchHandle = startPushNotifyWatcher(rootDir, {
    pollIntervalMs: opts.pushPollIntervalMs,
  });
  // #3565: opt-in (ver StudioServerOptions.enableSnapshotPush) — nunca ativo
  // implicitamente em teste, só quando main() liga pro uso real.
  const snapshotWatch: StudioSnapshotWatchHandle | null = opts.enableSnapshotPush
    ? watchAndPushStudioSnapshot(rootDir, { intervalMs: opts.snapshotPushIntervalMs })
    : null;
  // #5674: módulos server-rendered ficam em cache no processo; o watcher é
  // opt-in para a API programática e ligado pela CLI abaixo. O callback da
  // CLI encerra o processo para que systemd (Restart=always) suba um boot
  // limpo, em vez de tentar invalidar parcialmente o cache ESM.
  const sourceWatch: StudioSourceWatchHandle | null = opts.enableSourceWatch
    ? watchStudioSource(
        rootDir,
        (change) => {
          opts.onSourceChange?.(change);
        },
        { pollIntervalMs: opts.sourceWatchPollIntervalMs },
      )
    : null;

  let closed = false;
  return {
    url: `http://${HOST}:${port}/`,
    port,
    rootDir,
    close: () =>
      new Promise<void>((resolveClose, reject) => {
        if (closed) {
          resolveClose();
          return;
        }
        closed = true;
        pushNotifyWatch.close();
        snapshotWatch?.close();
        sourceWatch?.close();
        server.close((err) => (err ? reject(err) : resolveClose()));
      }),
  };
}

async function main(): Promise<void> {
  const { values } = parseCliArgs(process.argv.slice(2));
  const portArg = values["port"] ?? process.env.STUDIO_PORT;
  const port = portArg !== undefined ? Number(portArg) : DEFAULT_PORT;
  if (Number.isNaN(port) || port < 0) {
    console.error(`[studio-server] --port inválido: ${portArg}`);
    process.exit(2);
  }
  const rootDir = values["root-dir"] ? resolve(values["root-dir"]) : process.cwd();
  // #3565: espelho read-only ligado por padrão no uso real (`npm run
  // studio`) — `--no-snapshot-push` opta fora (ex: sessão sem credenciais
  // Cloudflare configuradas, editor prefere não tentar o push periódico).
  // Fail-soft mesmo ligado sem credenciais: o watcher só pula o push (ver
  // pushStudioSnapshot's skippedReason="missing-credentials"), nunca lança.
  const enableSnapshotPush = !parseCliArgs(process.argv.slice(2)).flags.has("no-snapshot-push");

  const server = await startStudioServer({
    port,
    rootDir,
    enableSnapshotPush,
    enableSourceWatch: true,
    onSourceChange: (change) => {
      console.warn(`[studio-server] código server-rendered mudou em ${change.path}; reiniciando`);
      process.kill(process.pid, "SIGTERM");
    },
  });
  console.log(`[studio-server] ${server.url} (rootDir=${server.rootDir})`);

  const shutdown = () => {
    // #5737: server.close() pode nunca resolver (conexões penduradas, SSE de
    // /api/events, keep-alive) — sem timeout, o processo fica vivo sem
    // escutar a porta e o Restart=always do systemd nunca dispara porque o
    // PID nunca sai de fato.
    shutdownWithTimeout(() => server.close(), {
      onTimeout: () =>
        console.error(
          "[studio-server] server.close() não completou a tempo; forçando saída para permitir Restart=always",
        ),
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`[studio-server] ${(e as Error).message}`);
    process.exit(1);
  });
}
