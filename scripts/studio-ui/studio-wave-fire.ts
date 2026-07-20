/**
 * studio-wave-fire.ts (#3702, fatia 1 do escopo — orquestração básica, SEM
 * habilitar o botão da UI e SEM superfície de progresso SSE polida)
 *
 * ## O que esta fatia entrega
 *
 * `GET /api/waves` (`studio-waves.ts`) já propõe QUAL onda disparar (clusters
 * de conflito + teto de concorrência), mas é só preview — nada executava.
 * Este módulo é a peça que falta: `runWaveFire` conduz UMA sessão real do
 * Claude Agent SDK (`query()`) que age como COORDENADORA da onda, seguindo o
 * mesmo protocolo documentado em `.claude/skills/diaria-develop/SKILL.md`
 * ("Paralelização segura no desenvolvimento") — mas para a lista de issues já
 * pré-computada pela onda, sem os gates humanos interativos do develop (a
 * população elegível pro botão "disparar onda" já passou pelo filtro
 * `classifyDispatchTrack === "elegivel"` de `studio-waves.ts`, o mesmo
 * critério que o `/diaria-overnight` usa pra agir sem supervisão).
 *
 * ## Decisão de arquitetura: 1 sessão coordenadora, não N sessões cruas
 *
 * A issue-mãe descreve "N sessões `query()`, uma por worktree isolado". Este
 * módulo implementa isso via UMA sessão `query()` (a "coordenadora") que, por
 * sua vez, usa a tool `Agent` do próprio Claude Code com `isolation:
 * "worktree"` — exatamente o mecanismo que `/diaria-develop` já usa hoje pra
 * paralelizar (ver SKILL.md: "cada unidade da onda roda num worktree isolado
 * próprio (`isolation: worktree`)"). Isso é DELIBERADO, não uma
 * simplificação preguiçosa: `isolation: "worktree"` é uma feature do harness
 * (cria o worktree, restringe Edit/Write a ele, faz cleanup automático se o
 * agente não mudar nada) que levou trabalho de engenharia de segurança pra
 * existir — reimplementar isso à mão aqui (criar worktree via `git worktree
 * add`, garantir que Edit/Write não escapem dele, limpar em caso de erro)
 * duplicaria essa superfície de risco sem necessidade, violando a instrução
 * explícita da issue ("reuso da maquinaria do `/diaria-develop`, não
 * reimplementar"). O `query()` da sessão coordenadora é o "query() por
 * worktree" da issue — só que orquestrado através da tool `Agent` em vez do
 * studio-server gerenciar `git worktree` diretamente.
 *
 * ## Por que a pasta principal NUNCA é tocada diretamente por esta sessão
 *
 * `cwd` da sessão coordenadora é `rootDir` (a pasta principal onde
 * `npm run studio` roda — precisa disso pra carregar CLAUDE.md/skills/
 * settings.json, igual ao chat drawer de `studio-chat.ts`). Mas a pasta
 * principal pode estar em uso ativo pelo editor numa sessão manual em
 * paralelo (incidente documentado: `git reset` de um coordenador colidiu com
 * edição não-commitada numa sessão manual, 260716). Por isso o prompt da
 * coordenadora (`buildWaveFireCoordinatorPrompt`) instrui explicitamente:
 * NUNCA rodar `git checkout`/`git pull`/`git stash`/qualquer coisa que mude
 * o working tree da pasta principal — toda mutação de arquivo acontece SÓ
 * dentro dos worktrees isolados dispatchados via `Agent`. As únicas ações
 * diretas da coordenadora fora do `Agent` tool são comandos `gh` (API-level:
 * `gh pr checks`, `gh pr merge`, `gh api graphql` pro gate de threads — não
 * tocam o working tree local, então são seguros de rodar da pasta principal).
 *
 * ## Guard de publicação como CÓDIGO, não só prosa (defesa em profundidade)
 *
 * `context/overnight-dispatch-rules.md` §1 já proíbe em prosa disparar
 * publishers de verdade. Como esta sessão roda SEM supervisão humana (é o
 * ponto do botão — clicar e a onda inteira roda sozinha), adicionamos um
 * `canUseTool` (`makeWaveSafeCanUseTool`) que nega DETERMINISTICAMENTE
 * qualquer `Bash` cujo comando toque `scripts/publish-*`,
 * `clarice-schedule-sends`, `clarice-import-*`, `close-poll`, ou qualquer
 * script Beehiiv/LinkedIn/Facebook/Brevo — mesmo que um prompt mal-formado
 * ou um agente dispatchado tentasse. Fora do blocklist, o `canUseTool`
 * segue o padrão CONSERVADOR de `studio-chat.ts` (nega por padrão qualquer
 * tool call que `.claude/settings.json` não resolveu sozinho) — a sessão
 * coordenadora deliberadamente NÃO expande permissões além do que um
 * terminal interativo já teria; qualquer lacuna real (ex: `gh api graphql`
 * pro gate de threads não estar no `allow` de `.claude/settings.json`) vai
 * aparecer como um evento de denial no stream em vez de travar
 * silenciosamente — e é um item explícito do follow-up de validação ao vivo
 * (a issue de escopo restante, ver PR body do #3702).
 *
 * ## O que NÃO está nesta fatia (documentado explicitamente, #3702)
 *
 * - **Validação ao vivo**: nunca foi disparado contra o SDK real — o
 *   subagente que implementou isto não pode (recursão de `Agent` bloqueada,
 *   #207) e não deveria (dispararia PRs/merges reais e não-revisados numa
 *   rodada overnight não supervisionada). `runWaveFire` é testado só com
 *   `queryFn` mockado, mesmo padrão de `runChatTurn` (`studio-chat.ts`,
 *   #3556) — que TAMBÉM não foi validado ao vivo antes do merge original.
 * - **Botão da UI**: `fire-wave-btn` (`triagem.html`/`triagem.js`) continua
 *   `disabled` — não foi religado a este endpoint nesta fatia.
 * - **Progresso SSE fino** (cards por worktree/PR, não só o feed bruto de
 *   tool calls): a issue explicitamente permite entregar isso depois. Por
 *   ora, `runWaveFire` reusa a tradução genérica `sdkMessageToChatEvents` de
 *   `studio-chat.ts` (mesmos eventos `chat-init`/`chat-tool`/`chat-done` do
 *   chat drawer) — dá visibilidade real (cada `Agent`/`Bash` chamado aparece)
 *   sem inventar um contrato de wire novo.
 * - **Endpoint gateado por env var** (`STUDIO_WAVE_FIRE_ENABLED`, ver
 *   `server.ts`) — mesmo com o código pronto, a rota responde 501 a menos
 *   que essa variável esteja setada, pra nenhuma instância existente do
 *   Studio passar a aceitar disparos reais só por atualizar o código.
 */

import type { CanUseTool, Options, PermissionResult, Query } from "@anthropic-ai/claude-agent-sdk";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { sdkMessageToChatEvents, describeChatError, type ChatWireEvent } from "./studio-chat.ts";

// ─── parsing do corpo de POST /api/waves/fire (puro) ───────────────────────

export interface WaveFireRequest {
  issueNumbers: number[];
}

export type ParsedWaveFireRequest = { ok: true; value: WaveFireRequest } | { ok: false; error: string };

/** Valida + normaliza o corpo cru de `POST /api/waves/fire`. Pura — nunca
 * lança. `maxConcurrency` (default 6, mesmo teto de `studio-waves.ts`)
 * rejeita listas maiores que o teto de paralelismo — o caller (server.ts)
 * já devia ter cortado a lista pela proposta de `/api/waves`, mas validar de
 * novo aqui evita que um corpo forjado (ou um bug de composição no cliente)
 * dispare mais worktrees concorrentes que o pretendido. */
export function parseWaveFireRequestBody(raw: string, opts: { maxConcurrency?: number } = {}): ParsedWaveFireRequest {
  const maxConcurrency = opts.maxConcurrency ?? 6;
  let parsed: unknown;
  try {
    parsed = raw.trim() === "" ? {} : JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `corpo não é JSON válido: ${(e as Error).message}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "corpo deve ser um objeto JSON" };
  }
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.issueNumbers) || obj.issueNumbers.length === 0) {
    return { ok: false, error: "campo 'issueNumbers' é obrigatório (array não-vazio de números)" };
  }
  const issueNumbers: number[] = [];
  const seen = new Set<number>();
  for (const raw of obj.issueNumbers) {
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
      return { ok: false, error: "'issueNumbers' deve conter só inteiros positivos" };
    }
    if (seen.has(raw)) {
      return { ok: false, error: `'issueNumbers' tem duplicata: #${raw}` };
    }
    seen.add(raw);
    issueNumbers.push(raw);
  }
  if (issueNumbers.length > maxConcurrency) {
    return {
      ok: false,
      error: `'issueNumbers' tem ${issueNumbers.length} itens, acima do teto de concorrência (${maxConcurrency}) — componha a onda via GET /api/waves antes de disparar.`,
    };
  }
  return { ok: true, value: { issueNumbers } };
}

// ─── prompt da sessão coordenadora (puro) ──────────────────────────────────

export interface WaveFirePromptOptions {
  maxConcurrency?: number;
  /** Nome do arquivo de checklist canônico — parametrizado só pra teste;
   * produção sempre usa o default real. */
  dispatchRulesPath?: string;
}

/**
 * Monta o prompt da sessão coordenadora — pura (sem I/O), testável por
 * substring. Espelha em linguagem natural o protocolo já documentado em
 * `.claude/skills/diaria-develop/SKILL.md` §"Paralelização segura no
 * desenvolvimento" + `context/overnight-dispatch-rules.md`, parametrizado
 * pela lista de issues já decidida pela onda (sem Gate 1/Gate de Onda
 * humanos — essas issues já são `elegivel`, população que
 * `/diaria-overnight` já trata como segura pra agir sem supervisão).
 */
export function buildWaveFireCoordinatorPrompt(issueNumbers: number[], opts: WaveFirePromptOptions = {}): string {
  const maxConcurrency = opts.maxConcurrency ?? 6;
  const dispatchRulesPath = opts.dispatchRulesPath ?? "context/overnight-dispatch-rules.md";
  const issueList = issueNumbers.map((n) => `#${n}`).join(", ");

  return [
    `Você é a sessão COORDENADORA de uma onda disparada pelo Studio ("disparar onda", #3702).`,
    `Onda: ${issueList} (${issueNumbers.length} issue(s), teto de concorrência ${maxConcurrency}).`,
    ``,
    `Estas issues já foram filtradas como "elegivel" (sem bloqueio externo, sem trade-off editorial em aberto) —`,
    `mesma população que o /diaria-overnight trata como segura pra agir sem supervisão. NÃO pergunte nada ao`,
    `editor (AskUserQuestion é proibido aqui, mesma Regra 1 do overnight) — se algo travar, documente na issue e siga.`,
    ``,
    `## Sua única responsabilidade: dispatch + gate de merge serial`,
    ``,
    `1. Para CADA issue da lista, dispatche uma tool call \`Agent\` com:`,
    `   - subagent_type: "general-purpose"`,
    `   - isolation: "worktree"`,
    `   - model: "sonnet" (explícito — nunca herdado)`,
    `   - prompt citando \`${dispatchRulesPath}\` (leia esse arquivo no início da própria sessão) + o número da`,
    `     issue + branch \`develop/fix-{numero}\` + "abra PR com \`Refs #{numero}\`, self-review obrigatório (#2038),`,
    `     nunca faça merge você mesma — a coordenadora cuida do merge".`,
    `   Envie até ${maxConcurrency} dessas tool calls NA MESMA mensagem (concorrência real) — nunca mais que`,
    `   ${maxConcurrency} worktrees abertos ao mesmo tempo.`,
    `2. Espere cada Agent retornar. Cada retorno traz (idealmente) um número de PR. Se um agente falhar/não abrir`,
    `   PR, registre a falha e siga para as demais issues — uma falha isolada não aborta a onda inteira.`,
    `3. Para cada PR aberto, rode o GATE 2 determinístico (mesmo do overnight/develop, #2210/#2222) ANTES de`,
    `   mergear: (a) \`gh pr checks {pr} --json bucket,name\` — todo bucket precisa ser "pass"; (b) via`,
    `   \`gh api graphql\`, checar que não há review threads não-resolvidas excluindo as marcadas FORBIDDEN.`,
    `   Só prossiga pro merge se AMBAS as condições passarem.`,
    `4. MERGE É SEMPRE SERIAL — nunca rode dois \`gh pr merge\` ao mesmo tempo, mesmo com múltiplos PRs prontos.`,
    `   Um de cada vez: \`gh pr merge {pr} --squash\`, confirme sucesso, só então passe pro próximo PR pronto.`,
    `5. IMPORTANTE — nunca rode \`git checkout\`/\`git pull\`/\`git stash\`/qualquer comando que mude o working tree`,
    `   da pasta em que VOCÊ (coordenadora) está rodando — essa pasta pode estar em uso ativo numa sessão manual`,
    `   do editor em paralelo (incidente real: colisão de working tree, 260716). Toda mutação de arquivo acontece`,
    `   SÓ dentro dos worktrees isolados que os Agent dispatchados criam sozinhos via \`isolation: "worktree"\`.`,
    `   Suas ações diretas (fora do Agent tool) ficam limitadas a comandos \`gh\` (API-level, não tocam o working`,
    `   tree local).`,
    `6. NUNCA rode \`scripts/publish-*\`, \`clarice-schedule-sends\`, \`clarice-import-*\`, \`close-poll\`, ou qualquer`,
    `   script que toque Beehiiv/LinkedIn/Facebook/Brevo — nem você, nem instrua os agentes dispatchados a rodar`,
    `   (guard de publicação, INVARIANTE, ${dispatchRulesPath} §1).`,
    ``,
    `Ao final (todas as issues processadas — mergeadas, com PR pendente de CI, ou com falha documentada), produza`,
    `um resumo em texto: por issue, o resultado (mergeada / PR aberto aguardando CI / falhou — motivo).`,
  ].join("\n");
}

// ─── guard de publicação como código (puro, defesa em profundidade) ───────

const WAVE_PUBLISH_GUARD_RE =
  /\bscripts[\\/](publish-|clarice-schedule-sends|clarice-import-)|close-poll\.ts|\b(beehiiv|linkedin|facebook|brevo)\b/i;

export interface WaveToolDecision {
  allow: boolean;
  reason?: string;
}

/**
 * Decisão pura pra 1 tool call da sessão coordenadora — separada de
 * `makeWaveSafeCanUseTool` (que é só o wrapper async exigido pelo shape
 * `CanUseTool` do SDK) pra ser testável sem mockar o SDK. Duas camadas:
 * (1) blocklist de publicação, INVARIANTE, nunca contornável; (2) fora
 * disso, nega por padrão (mesmo espírito conservador do chat drawer,
 * `studio-chat.ts` `denyToolResult`) — esta sessão roda sem supervisão
 * humana, então "permitir por padrão" é o erro mais caro possível aqui.
 * `.claude/settings.json` já resolveu (allow) tudo que a coordenadora
 * legitimamente precisa ANTES desta função ser chamada — ela só é invocada
 * pro resíduo que pediria um prompt interativo (ver doc-comment do módulo).
 */
export function evaluateWaveTool(toolName: string, input: Record<string, unknown>): WaveToolDecision {
  if (toolName === "Bash" && typeof input.command === "string" && WAVE_PUBLISH_GUARD_RE.test(input.command)) {
    return {
      allow: false,
      reason:
        "guard de publicação (INVARIANTE): esta sessão nunca dispara scripts/publish-*, clarice-schedule-sends, " +
        "clarice-import-*, close-poll ou qualquer script Beehiiv/LinkedIn/Facebook/Brevo, mesmo em onda automática.",
    };
  }
  return {
    allow: false,
    reason:
      `"${toolName}" exigiria confirmação interativa que esta sessão headless não tem como dar — ` +
      `só tools já resolvidas por .claude/settings.json rodam automaticamente aqui (#3702, escopo conservador; ` +
      `estender o allow-list de settings.json é parte do follow-up de validação ao vivo).`,
  };
}

function makeWaveSafeCanUseTool(): CanUseTool {
  return async (toolName, input) => {
    const decision = evaluateWaveTool(toolName, input);
    if (decision.allow) return { behavior: "allow", updatedInput: input };
    return { behavior: "deny", message: decision.reason ?? "negado" } as PermissionResult;
  };
}

// ─── invocação real do SDK (I/O, injetável — mesmo padrão de studio-chat.ts) ──

export type QueryFn = (params: { prompt: string; options?: Options }) => Query;

function defaultQueryFn(params: { prompt: string; options?: Options }): Query {
  return sdkQuery(params);
}

export interface RunWaveFireOptions {
  issueNumbers: number[];
  /** cwd da sessão coordenadora — sempre a raiz do repo (`rootDir` do
   * studio-server), pra carregar CLAUDE.md/skills/settings.json. A
   * coordenadora é instruída (via prompt) a nunca mutar o working tree
   * desta pasta diretamente — ver doc-comment do módulo. */
  cwd: string;
  onEvent: (event: ChatWireEvent) => void;
  queryFn?: QueryFn;
  abortController?: AbortController;
  maxConcurrency?: number;
}

/**
 * Conduz a sessão coordenadora de UMA onda: monta o prompt
 * (`buildWaveFireCoordinatorPrompt`), chama `query()` e traduz cada
 * `SDKMessage` em eventos de wire via `onEvent` — reusa
 * `sdkMessageToChatEvents` de `studio-chat.ts` (mesmo contrato do chat
 * drawer: `chat-init`/`chat-tool`/`chat-done`/etc.), então cada `Agent`/
 * `Bash` que a coordenadora dispatcha já aparece no stream sem precisar de
 * um tradutor novo. Fail-soft (mesmo padrão de `runChatTurn`): qualquer
 * exceção vira um único `chat-error`, nunca propaga — o caller HTTP nunca
 * precisa de try/catch próprio em volta desta chamada.
 */
export async function runWaveFire(opts: RunWaveFireOptions): Promise<void> {
  const runQuery = opts.queryFn ?? defaultQueryFn;
  const prompt = buildWaveFireCoordinatorPrompt(opts.issueNumbers, { maxConcurrency: opts.maxConcurrency });

  try {
    const stream = runQuery({
      prompt,
      options: {
        cwd: opts.cwd,
        settingSources: ["user", "project", "local"],
        includePartialMessages: true,
        permissionMode: "default",
        canUseTool: makeWaveSafeCanUseTool(),
        abortController: opts.abortController,
      },
    });

    for await (const msg of stream) {
      for (const wireEvent of sdkMessageToChatEvents(msg)) {
        opts.onEvent(wireEvent);
      }
    }
  } catch (e) {
    opts.onEvent({ event: "chat-error", data: { message: describeChatError(e) } });
  }
}
