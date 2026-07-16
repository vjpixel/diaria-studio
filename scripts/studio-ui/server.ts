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
 *     `chat-init`/`chat-delta`/`chat-tool`/`chat-done`/`chat-error`, contrato
 *     em `studio-chat.ts`. Fail-soft: erro do SDK vira `chat-error`
 *     no stream, nunca um 500 nem crash do processo.
 *   - `GET /revisao/:aammdd` — painel de revisão de conteúdo rica (#3559):
 *     mesma estratégia de rewrite, servindo `public/revisao.html`. Consome
 *     `GET/PUT /api/editions/:aammdd/review/:slug` (`slug` = categorized |
 *     reviewed | social), `.../diff`, `.../lint`, `.../reset-baseline` e
 *     `GET /api/editions/:aammdd/preview.html` (HTML completo do e-mail,
 *     pra `<iframe>`) + `POST /api/editions/:aammdd/actions/swap-destaque`
 *     — ver `studio-review.ts`/`studio-review-actions.ts` pro detalhe.
 *
 * **Read-only por construção, com exceções controladas** (#3555 é a fatia
 * fundação da EPIC — as fatias de AÇÃO vêm depois, #3556+): nenhuma rota aqui
 * escreve em disco nem dispara nada, EXCETO `POST /api/chat` (#3556), que
 * conduz uma sessão Claude real (a UI só invoca — a lógica de negócio
 * permanece nas skills/scripts que essa sessão chama, mesmo princípio do epic
 * #3554), e as rotas de ação de revisão de conteúdo (#3559, detalhadas
 * abaixo). Sem autenticação nesta fatia — acesso remoto é escopo da #3560;
 * aqui o único guard de segurança é o bind loopback. #3558 (cockpit de
 * edição) e #3562 (triagem de issues/PRs) preservam o invariante read-only
 * original: são só mais views. #3562 em particular nunca expõe token do
 * GitHub (o server só invoca o binário `gh`, que resolve auth localmente) e
 * nunca chama subcomando de mutação (`close`/`comment`/`merge`) — só `list`.
 *
 * **Exceção controlada (#3559 — revisão de conteúdo rica):** as rotas
 * `PUT /api/editions/:aammdd/review/:slug` (salvar edição) e
 * `POST /api/editions/:aammdd/review/:slug/reset-baseline` +
 * `POST /api/editions/:aammdd/actions/swap-destaque` são a 1ª quebra
 * deliberada do invariante read-only — a fatia de AÇÃO que #3555 previa.
 * Escopo estreito e auditável: só escrevem os 3 arquivos gate-facing de
 * revisão (`01-categorized.md`, `02-reviewed.md`, `03-social.md`) e o
 * baseline interno de diff (`_internal/studio-review-baseline/`), ou
 * invocam `scripts/swap-destaque.ts` como subprocess (mesma CLI que o
 * editor rodaria manualmente). Toda a lógica mora em `studio-review.ts` /
 * `studio-review-actions.ts` (arquivos próprios desta fatia) — ver o
 * cabeçalho de cada um pro detalhe do design.
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
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as parseCliArgs, isMainModule } from "../lib/cli-args.ts";
import { resolveRunLogPath } from "../lib/run-log.ts";
import { buildStudioState } from "./studio-state.ts";
import { buildEditionDetail } from "./studio-edition-detail.ts";
import { tailJsonl, watchRunLogAppends, type RunLogWatchHandle } from "./run-log-tail.ts";
import { watchPlanFiles, type PlanWatchHandle } from "./plan-watch.ts";
import { formatSseEvent, formatSseComment } from "./sse.ts";
import { serveStaticFile } from "./static-serve.ts";
import { buildTokensCss } from "./tokens-css.ts";
import { fetchTriageData, type GhRunFn } from "./studio-issues.ts";
import { buildWaveProposal } from "./studio-waves.ts";
import { buildDiariaDashboardHtml } from "./dashboard-diaria.ts";
import { buildClariceDashboardHtml } from "./dashboard-clarice.ts";
import {
  parseChatRequestBody,
  runChatTurn,
  getSessionId,
  setSessionId,
  clearSession,
  type QueryFn,
} from "./studio-chat.ts";
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
  pullReviewFileBestEffort,
} from "./studio-review.ts";
import { runSwapDestaque, type SwapDestaqueRequest } from "./studio-review-actions.ts";
import { resolveEditionDir } from "../lib/find-current-edition.ts";

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
  /** Tamanho máximo (bytes) do corpo de `POST /api/chat` — default 256KB,
   * generoso pra uma mensagem de chat digitada à mão, protege contra corpo
   * absurdo consumindo memória do processo. */
  chatMaxBodyBytes?: number;
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

  const heartbeat = setInterval(() => {
    res.write(formatSseComment("heartbeat"));
  }, 20_000);

  const cleanup = () => {
    clearInterval(heartbeat);
    logWatch.close();
    planWatch.close();
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
 * `studio-chat.ts`).
 *
 * Único handler do server que escreve estado em memória — todo o resto do
 * arquivo permanece read-only (ver doc-comment do módulo).
 */
async function handleApiChat(
  rootDir: string,
  req: IncomingMessage,
  res: ServerResponse,
  opts: { queryFn?: QueryFn; maxBodyBytes: number },
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

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  res.write(formatSseComment("connected"));

  const abortController = new AbortController();
  const onClose = () => abortController.abort();
  req.on("close", onClose);

  await runChatTurn({
    message: parsed.value.message,
    sessionId,
    cwd: rootDir,
    queryFn: opts.queryFn,
    abortController,
    onEvent: (wireEvent) => {
      if (wireEvent.event === "chat-init" && wireEvent.data.sessionId) {
        setSessionId(rootDir, wireEvent.data.sessionId);
      }
      if (wireEvent.event === "chat-done" && wireEvent.data.sessionId) {
        setSessionId(rootDir, wireEvent.data.sessionId);
      }
      res.write(formatSseEvent(wireEvent.event, wireEvent.data));
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
  // #494: pull best-effort do Drive antes de abrir — fail-soft (offline, sem
  // credenciais, sem cache viram `pull.ok === false`, nunca bloqueiam a
  // leitura do arquivo local).
  const pull = pullReviewFileBestEffort(rootDir, aammdd, slug);
  const state = readReviewFile(rootDir, aammdd, slug);
  sendJson(res, state.ok ? 200 : 400, { ...state, pull });
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
  const preview = buildReviewPreviewHtml(editionDirFor(rootDir, aammdd));
  sendHtml(res, preview.ok ? 200 : 422, preview.html);
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
  const content = (body as { content?: unknown } | null)?.content;
  if (typeof content !== "string") {
    sendJson(res, 400, { error: "campo 'content' (string) é obrigatório no corpo" });
    return;
  }
  const result = saveReviewFile(rootDir, aammdd, slug, content);
  sendJson(res, result.ok ? 200 : 400, result);
}

function handleReviewResetBaseline(rootDir: string, aammdd: string, slug: string, res: ServerResponse): void {
  if (!isReviewSlug(slug)) {
    sendJson(res, 400, { error: "arquivo de revisão desconhecido", slug });
    return;
  }
  const result = resetBaseline(rootDir, aammdd, slug);
  sendJson(res, result.ok ? 200 : 400, result);
}

async function handleReviewSwap(
  rootDir: string,
  req: IncomingMessage,
  res: ServerResponse,
  aammdd: string,
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await readRequestBody(req, REVIEW_MAX_BODY_BYTES)) as Record<string, unknown>;
  } catch {
    sendJson(res, 400, { error: "corpo da request precisa ser JSON válido" });
    return;
  }
  const request: SwapDestaqueRequest = {
    aammdd,
    promote: String(body.promote ?? ""),
    demote: String(body.demote ?? ""),
    drop: !!body.drop,
    dryRun: !!body.dryRun,
  };
  const result = runSwapDestaque(rootDir, request);
  sendJson(res, result.ok ? 200 : 400, result);
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
        handleApiChat(rootDir, req, res, { queryFn: chatQueryFn, maxBodyBytes: chatMaxBodyBytes }).catch((e) => {
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
      const resetBaselineMatch = urlPath.match(/^\/api\/editions\/([^/]+)\/review\/([^/]+)\/reset-baseline$/);
      if (req.method === "POST" && resetBaselineMatch) {
        handleReviewResetBaseline(rootDir, resetBaselineMatch[1], resetBaselineMatch[2], res);
        return;
      }
      const swapMatch = urlPath.match(/^\/api\/editions\/([^/]+)\/actions\/swap-destaque$/);
      if (req.method === "POST" && swapMatch) {
        handleReviewSwap(rootDir, req, res, swapMatch[1]).catch((e) => sendJson(res, 500, { error: (e as Error).message }));
        return;
      }

      if (req.method !== "GET" && req.method !== "HEAD") {
        sendJson(res, 405, { error: "method not allowed — studio-server é read-only nesta fatia (#3555), exceto POST /api/chat (#3556) e as rotas de ação do #3559" });
        return;
      }

      if (urlPath === "/api/state") {
        handleApiState(rootDir, res);
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
        const served = serveStaticFile(PUBLIC_DIR, "/edicao.html", res);
        if (!served) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Not found");
        }
        return;
      }
      // #3559: mesma estratégia de rewrite — a página busca
      // /api/editions/:aammdd/review/:slug (+ diff/lint/preview.html).
      if (/^\/revisao\/[^/]+\/?$/.test(urlPath)) {
        const served = serveStaticFile(PUBLIC_DIR, "/revisao.html", res);
        if (!served) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Not found");
        }
        return;
      }
      // #3562: mesma estratégia de rewrite — a página busca /api/issues.
      if (urlPath === "/triagem" || urlPath === "/triagem/") {
        const served = serveStaticFile(PUBLIC_DIR, "/triagem.html", res);
        if (!served) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Not found");
        }
        return;
      }

      const served = serveStaticFile(PUBLIC_DIR, urlPath, res);
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

  const server = await startStudioServer({ port, rootDir });
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
