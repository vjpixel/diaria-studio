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
 *     elegível/bloqueada/ambígua por issue + resumo de CI por PR.
 *   - `GET /api/waves` (#3562, entrega 2) — composição de wave PREVIEW:
 *     clusters de conflito (arquivos citados por issue) + a onda paralela
 *     segura proposta, sobre o MESMO snapshot cacheado de `/api/issues`
 *     (`studio-waves.ts`, zero chamada `gh` extra). Read-only — só propõe,
 *     nunca dispara worktree/implementador (isso é #3556/#3557).
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
 *   - `POST /api/waves/fire` (#3702) — dispara a sessão COORDENADORA de uma
 *     onda já composta por `GET /api/waves`: usa a tool `Agent` do próprio
 *     Claude Code (`isolation: "worktree"`, mesmo mecanismo do
 *     `/diaria-develop`) pra fan-out paralelo, gate 2 determinístico +
 *     merge serial — ver `studio-wave-fire.ts` pro design completo (por que
 *     1 sessão coordenadora, não N sessões cruas; guard de publicação como
 *     código). **Gateada por `STUDIO_WAVE_FIRE_ENABLED=1` (OFF por
 *     padrão)** — a orquestração nunca foi validada contra o SDK real;
 *     enquanto a flag está desligada, responde 501. Streaming SSE, mesmo
 *     transporte de `/api/chat`. O botão da UI (`fire-wave-btn`,
 *     `triagem.html`) continua desabilitado nesta fatia — só o endpoint
 *     existe.
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
 *   - `GET /api/round/:kind` (#3561, `kind` = `overnight` | `develop`) — fila
 *     classificada (entram/pendente/fora, com motivo) + timeline por unidade
 *     do `plan.json` MAIS RECENTE daquele kind, pra `/rodada`. Read-only:
 *     visualização de uma rodada já em andamento/resumível, não dispara
 *     nenhuma varredura/sessão nova — ver `studio-round.ts`.
 *   - `GET /rodada` — acompanhamento de rodada overnight/develop (#3561):
 *     mesma estratégia de rewrite, servindo `public/rodada.html`. Consome
 *     `GET /api/round/:kind`.
 *   - `GET /apoios` — CRM simples de apoios apoia.se (#3602): mesma
 *     estratégia de rewrite, servindo `public/apoios.html`. Consome
 *     `GET /api/apoios` (contatos + status cruzado via `checkBacker` +
 *     agregação de campanha) e `POST /api/apoios/contacts` /
 *     `PUT /api/apoios/contacts/:id` (CRUD de contato) — ver
 *     `studio-apoios.ts` pro detalhe. Dado pessoal: só em
 *     `data/apoia-se/contacts.jsonl` (junction OneDrive, nunca no repo).
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
 *   - Notificação Telegram (#3564, sem rota HTTP própria): um watcher em
 *     background, subido por `startStudioServer` e fechado em `close()`,
 *     observa `gatesPending`/`chatPermissionsPending` (mesmo `buildStudioState`
 *     de `GET /api/state`) e dispara notificação com deep-link + dedup pro
 *     Telegram quando algo passa a esperar o editor — ver
 *     `studio-telegram-notify.ts`. Fail-soft total: sem credenciais
 *     configuradas, ou qualquer falha de rede, o Studio segue normal.
 *
 * **Read-only por construção, com exceções controladas** (#3555 é a fatia
 * fundação da EPIC — as fatias de AÇÃO vêm depois, #3556+): nenhuma rota aqui
 * escreve em disco nem dispara nada, EXCETO `POST /api/chat` (#3556), que
 * conduz uma sessão Claude real (a UI só invoca — a lógica de negócio
 * permanece nas skills/scripts que essa sessão chama, mesmo princípio do epic
 * #3554), `POST /api/chat/answer` (#3557, resolve um gate em memória — não
 * escreve disco, mas é mutação de estado do processo), e as rotas de ação de
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
 * **Exceção controlada (#3602 — CRM de apoios):** `POST /api/apoios/contacts`
 * e `PUT /api/apoios/contacts/:id` escrevem SÓ `data/apoia-se/contacts.jsonl`
 * (dado pessoal, junction OneDrive, nunca no repo/KV) — nunca tocam
 * credenciais nem a API apoia.se em modo de escrita (o cruzamento de status é
 * sempre leitura via `checkBacker`). Toda a lógica mora em `studio-apoios.ts`.
 * (#3859: `POST /api/apoios/refresh` é a mesma classe de exceção — dispara
 * LEITURAS a mais na apoia.se via `checkBacker`/`forceRefresh` (grava só o
 * cache `data/apoia-se/{campanha}/{YYYY-MM}.json`, já uma superfície de
 * escrita pré-existente de `checkBacker`), e TAMBÉM pode escrever
 * `contacts.jsonl` quando o drain de e-mail (metade 1) encontra um apoiador
 * novo — mesmo dado pessoal, mesma pasta, mesmo padrão de escrita de
 * `POST /api/apoios/contacts` acima, só que disparado automaticamente em vez
 * de por submissão manual do form.)
 *
 * **Exceção controlada (#3861 — botão "Atualizar É IA?"):**
 * `POST /api/painel/eia/refresh` escreve SÓ `data/poll-eia-summary.json`
 * (`refreshPollEiaSummaryLocal` em `scripts/build-poll-eia-data.ts`) — nunca
 * chama o push pro KV do clarice-dashboard que o CLI `--push` faz (isso
 * exigiria credenciais Cloudflare de produção e não é papel de um botão de
 * painel local). Mesma classe de exceção que #3559/#3602/#3859: escopo
 * estreito, 1 arquivo local, fail-soft total.
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
// #3867: chamada explícita — hoje `.env`/`.env.local` já carregam de forma
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
import { serveStaticFile, mimeFor, SECURITY_HEADERS } from "./static-serve.ts";
import { buildTokensCss } from "./tokens-css.ts";
import { fetchTriageData, type GhRunFn } from "./studio-issues.ts";
import { buildWaveProposal } from "./studio-waves.ts";
// #3561: visualização da fila classificada + timeline ao vivo de uma rodada
// overnight/develop já em andamento/resumível — arquivo próprio desta
// fatia, import isolado (nenhuma outra rota depende dele). Ver studio-round.ts.
import { buildRoundPayload, isRoundKind } from "./studio-round.ts";
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
// #3702: dispara a sessão coordenadora de uma onda (fan-out via Agent tool
// isolation:worktree + gate 2 + merge serial) — arquivo próprio, import
// isolado (nenhuma outra rota depende dele). Ver studio-wave-fire.ts.
import {
  parseWaveFireRequestBody,
  runWaveFire,
  type QueryFn as WaveFireQueryFn,
  type IssueTerminalCheck,
} from "./studio-wave-fire.ts";
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
import { resolveEditionDir } from "../lib/find-current-edition.ts";
// #3602: CRM simples de apoios apoia.se — arquivo próprio desta fatia, import
// isolado (nenhuma outra rota depende dele). Ver studio-apoios.ts.
import {
  buildApoiosData,
  refreshApoiosData,
  addContact,
  updateContactById,
  parseCreateContactBody,
  parseUpdateContactBody,
  type ApoiosMutationResult,
} from "./studio-apoios.ts";
// #3564: notificação Telegram (gate 4/6 pendente + AskUserQuestion pendente
// no chat) com dedup — arquivo próprio desta fatia, import isolado (nenhuma
// outra rota depende dele). Ver studio-telegram-notify.ts.
import {
  startTelegramNotifyWatcher,
  maybeNotifyChatDone,
  type TelegramNotifyWatchHandle,
} from "./studio-telegram-notify.ts";
// #3848: status de todas as integrações (APIs + MCPs) — arquivo próprio
// desta fatia, import isolado (nenhuma outra rota depende dele). Ver
// studio-integrations.ts.
import { buildIntegrationsData } from "./studio-integrations.ts";
// #3861: botão "Atualizar É IA?" da dashboard diária embutida — reusa a
// função exportada de build-poll-eia-data.ts (mesmo módulo do CLI --push),
// mas SÓ a metade local (nunca o push pro KV do clarice-dashboard). Ver
// docstring de refreshPollEiaSummaryLocal.
import { refreshPollEiaSummaryLocal } from "../build-poll-eia-data.ts";

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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    // #3891 (item 10): nosniff em toda resposta JSON — defesa em profundidade
    // barata (mesma constante de static-serve.ts, mas só o header de
    // MIME-sniffing: CSP não faz sentido pra uma resposta que nunca é
    // renderizada como página).
    "X-Content-Type-Options": SECURITY_HEADERS["X-Content-Type-Options"],
  });
  res.end(payload);
}

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
  /** Intervalo de polling (ms) do watcher de notificação Telegram (#3564) —
   * default 15s (independente de `pollIntervalMs` acima, que é tunado pra
   * SSE de baixa latência; aqui 1 tick/s seria polling desnecessariamente
   * agressivo pra um evento que só interessa notificar 1x). Reduzido em
   * testes. */
  telegramPollIntervalMs?: number;
  /** Tamanho máximo (bytes) do corpo de `POST /api/chat` — default 256KB,
   * generoso pra uma mensagem de chat digitada à mão, protege contra corpo
   * absurdo consumindo memória do processo. */
  chatMaxBodyBytes?: number;
  /** Notificador injetável do evento `chat-done` (#3822) — default
   * `maybeNotifyChatDone` (`studio-telegram-notify.ts`); testes mockam pra
   * observar chamadas sem bater na rede do Telegram. */
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
  /** `query()` injetável pra `POST /api/waves/fire` (#3702) — testes mockam
   * a sessão coordenadora sem spawnar o CLI real; produção usa o default de
   * `studio-wave-fire.ts`. */
  waveFireQueryFn?: WaveFireQueryFn;
  /** Liga `POST /api/waves/fire` de verdade — OFF por padrão (inclusive em
   * testes que não setam isso explicitamente). A orquestração nunca foi
   * validada contra o SDK real (#3702); com a flag desligada, a rota
   * responde 501 em vez de aceitar disparos. `main()` liga a partir de
   * `STUDIO_WAVE_FIRE_ENABLED=1` no uso real. */
  waveFireEnabled?: boolean;
  /** Teto de concorrência de `POST /api/waves/fire` — default 6, mesmo teto
   * de `GET /api/waves` (`studio-waves.ts`). */
  waveFireMaxConcurrency?: number;
  /** #3765 — injetável pra testes: substitui a validação pós-turno de
   * estado terminal (`gh issue view` real) por um fake. Produção usa o
   * default de `studio-wave-fire.ts` (`checkAllIssuesTerminalState`). */
  waveFireCheckTerminalStateFn?: (issueNumbers: number[], cwd: string, sinceIso: string) => IssueTerminalCheck[];
  /** `fetch` injetável pra `GET /api/integrations` (#3848) — testes SEMPRE
   * passam um mock que nunca bate em rede real (proibido testar os probes
   * ao vivo, ver doc-comment de `studio-integrations.ts`). Produção usa o
   * default (`fetch` global) de `buildIntegrationsData`. */
  integrationsFetchImpl?: typeof fetch;
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

/** `GET /api/waves` (#3562, entrega 2) — composição de wave PREVIEW: reusa o
 * mesmo snapshot cacheado de `fetchTriageData` (zero chamada `gh` extra) e
 * roda a análise pura de cluster de conflito (`studio-waves.ts`) sobre as
 * issues classificadas `elegivel`. Read-only por construção: só propõe, não
 * dispara nada — ver disclaimer em `studio-waves.ts`. */
function handleApiWaves(rootDir: string, res: ServerResponse, ghRun?: GhRunFn): void {
  const triage = fetchTriageData(rootDir, { run: ghRun });
  const proposal = buildWaveProposal(
    triage.issues.map((i) => ({
      number: i.number,
      files: i.files,
      priority: i.priority,
      dispatchTrack: i.dispatchTrack,
    })),
  );
  sendJson(res, 200, {
    generatedAt: triage.generatedAt,
    error: triage.error,
    cached: triage.cached,
    ...proposal,
  });
}

/** `GET /api/round/:kind` (#3561) — fila classificada (entram/pendente/fora,
 * com motivo) + timeline por unidade do `plan.json` MAIS RECENTE de `kind`
 * ("overnight" | "develop"). Sempre 200 com `found:false` quando não há
 * nenhuma sessão — `kind` inválido é o único 400 desta rota. Read-only:
 * `buildRoundPayload` só lê disco, nunca dispara nada (ver studio-round.ts). */
function handleApiRound(rootDir: string, kind: string, res: ServerResponse): void {
  if (!isRoundKind(kind)) {
    sendJson(res, 400, { error: "kind inválido — use 'overnight' ou 'develop'", kind });
    return;
  }
  sendJson(res, 200, buildRoundPayload(rootDir, kind));
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
function readRequestBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error(`corpo da request excede o limite de ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

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
 * à parte, ver doc-comment de `studio-telegram-notify.ts`). Chamada
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
      // ver doc-comment de `handleApiChat`/`studio-telegram-notify.ts`) —
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

/**
 * `POST /api/waves/fire` (#3702) — dispara a sessão coordenadora de uma onda
 * já composta por `GET /api/waves`. Gateada por `opts.enabled`
 * (`STUDIO_WAVE_FIRE_ENABLED=1`, OFF por padrão): a orquestração real
 * (fan-out via `Agent` tool `isolation: "worktree"` + gate 2 + merge serial,
 * `studio-wave-fire.ts`) nunca foi validada contra o SDK real, então o
 * código existe e é testado com `queryFn` mockado (mesmo padrão de
 * `POST /api/chat`, #3556), mas fica inerte por padrão — responde 501 em vez
 * de aceitar um disparo, pra nenhuma instância existente do Studio passar a
 * aceitar disparos reais só por atualizar o código. Quando habilitado,
 * streaming SSE — mesmo transporte de `POST /api/chat`.
 */
async function handleApiWavesFire(
  rootDir: string,
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    enabled: boolean;
    queryFn?: WaveFireQueryFn;
    maxBodyBytes: number;
    maxConcurrency?: number;
    checkTerminalStateFn?: (issueNumbers: number[], cwd: string, sinceIso: string) => IssueTerminalCheck[];
  },
): Promise<void> {
  if (!opts.enabled) {
    sendJson(res, 501, {
      error:
        "disparo de onda desabilitado nesta instância (STUDIO_WAVE_FIRE_ENABLED não setado) — orquestração ainda não validada ao vivo, ver #3702.",
    });
    return;
  }

  let raw: string;
  try {
    raw = await readRequestBody(req, opts.maxBodyBytes);
  } catch (e) {
    sendJson(res, 413, { error: (e as Error).message });
    return;
  }

  const parsed = parseWaveFireRequestBody(raw, { maxConcurrency: opts.maxConcurrency });
  if (!parsed.ok) {
    sendJson(res, 400, { error: parsed.error });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  res.write(formatSseComment("connected"));

  const abortController = new AbortController();
  const onClose = () => abortController.abort();
  req.on("close", onClose);

  await runWaveFire({
    issueNumbers: parsed.value.issueNumbers,
    cwd: rootDir,
    queryFn: opts.queryFn,
    maxConcurrency: opts.maxConcurrency,
    checkTerminalStateFn: opts.checkTerminalStateFn,
    abortController,
    onEvent: (wireEvent) => {
      try {
        res.write(formatSseEvent(wireEvent.event, wireEvent.data));
      } catch {
        // conexão já fechada — a sessão coordenadora segue rodando de
        // qualquer forma; só não há mais pra onde emitir o evento.
      }
    },
  });

  req.off("close", onClose);
  res.end();
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
      sendHtml(res, 500, `<!DOCTYPE html><html><body><h1>Painel Clarice — erro</h1><p>${escHtmlLite((e as Error).message)}</p></body></html>`);
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
function handleApiApoiosRefresh(rootDir: string, res: ServerResponse): void {
  refreshApoiosData(rootDir)
    .then((data) => sendJson(res, 200, data))
    .catch((e) => sendJson(res, 500, { error: (e as Error).message }));
}

async function handleApiApoiosCreate(rootDir: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let raw: string;
  try {
    raw = await readRequestBody(req, APOIOS_MAX_BODY_BYTES);
  } catch (e) {
    sendJson(res, 413, { error: (e as Error).message });
    return;
  }
  const parsed = parseCreateContactBody(raw);
  if (!parsed.ok) {
    sendJson(res, 400, { error: parsed.error });
    return;
  }
  const result = addContact(rootDir, parsed.value);
  sendJson(res, result.ok ? 201 : 400, result);
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
  const waveFireQueryFn = opts.waveFireQueryFn;
  const waveFireEnabled = opts.waveFireEnabled ?? false;
  const waveFireMaxConcurrency = opts.waveFireMaxConcurrency ?? 6;
  const waveFireCheckTerminalStateFn = opts.waveFireCheckTerminalStateFn;
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

      // #3702: dispara a sessão coordenadora de uma onda — mesmo tratamento
      // "rota de mutação checada antes do guard read-only" de /api/chat
      // acima. Gateada por waveFireEnabled (ver handleApiWavesFire).
      if (urlPath === "/api/waves/fire") {
        if (req.method !== "POST") {
          sendJson(res, 405, { error: "POST obrigatório em /api/waves/fire" });
          return;
        }
        handleApiWavesFire(rootDir, req, res, {
          enabled: waveFireEnabled,
          queryFn: waveFireQueryFn,
          maxBodyBytes: chatMaxBodyBytes,
          maxConcurrency: waveFireMaxConcurrency,
          checkTerminalStateFn: waveFireCheckTerminalStateFn,
        }).catch((e) => {
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
      // #3559 acima — CRUD do CRM de apoios. Checadas ANTES do guard
      // genérico de método.
      if (urlPath === "/api/apoios/contacts" && req.method === "POST") {
        handleApiApoiosCreate(rootDir, req, res).catch((e) => sendJson(res, 500, { error: (e as Error).message }));
        return;
      }
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
        handleApiApoiosRefresh(rootDir, res);
        return;
      }
      // #3861: botão "Atualizar É IA?" — mesmo tratamento das rotas de
      // escrita acima (checada antes do guard genérico de método).
      if (urlPath === "/api/painel/eia/refresh" && req.method === "POST") {
        handleApiPainelEiaRefresh(rootDir, req, res);
        return;
      }

      if (req.method !== "GET" && req.method !== "HEAD") {
        sendJson(res, 405, { error: "method not allowed — studio-server é read-only nesta fatia (#3555), exceto POST /api/chat (#3556), POST /api/waves/fire (#3702) e as rotas de ação do #3559/#3602/#3806/#3859/#3861" });
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
      if (urlPath === "/api/waves") {
        handleApiWaves(rootDir, res, ghRun);
        return;
      }
      // #3561: fila classificada + timeline de uma rodada overnight/develop.
      const roundMatch = urlPath.match(/^\/api\/round\/([^/]+)$/);
      if (roundMatch) {
        handleApiRound(rootDir, roundMatch[1], res);
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
  // Studio aberta). Fail-soft por construção (ver studio-telegram-notify.ts).
  const telegramNotifyWatch: TelegramNotifyWatchHandle = startTelegramNotifyWatcher(rootDir, {
    pollIntervalMs: opts.telegramPollIntervalMs,
  });
  // #3565: opt-in (ver StudioServerOptions.enableSnapshotPush) — nunca ativo
  // implicitamente em teste, só quando main() liga pro uso real.
  const snapshotWatch: StudioSnapshotWatchHandle | null = opts.enableSnapshotPush
    ? watchAndPushStudioSnapshot(rootDir, { intervalMs: opts.snapshotPushIntervalMs })
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
        telegramNotifyWatch.close();
        snapshotWatch?.close();
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
  // #3702: OFF por padrão — a orquestração de onda real nunca foi validada
  // contra o SDK real (ver studio-wave-fire.ts). Opt-in explícito via env,
  // não flag de CLI, pra não ser ligado sem querer num `npm run studio` comum.
  const waveFireEnabled = process.env.STUDIO_WAVE_FIRE_ENABLED === "1";

  const server = await startStudioServer({ port, rootDir, enableSnapshotPush, waveFireEnabled });
  console.log(`[studio-server] ${server.url} (rootDir=${server.rootDir})`);

  const shutdown = () => {
    server.close().finally(() => process.exit(0));
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
