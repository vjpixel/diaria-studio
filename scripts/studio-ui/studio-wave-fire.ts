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
 * `clarice-schedule-` (prefixo — cobre `clarice-schedule-sends`,
 * `clarice-schedule-group`, `clarice-schedule-ramp`, mesmo blast radius de
 * agendamento real de campanha Brevo, #3728 Gap 2), `clarice-import-*`,
 * `close-poll`, ou qualquer script Beehiiv/LinkedIn/Facebook/Brevo — mesmo
 * que um prompt mal-formado ou um agente dispatchado tentasse. Também nega
 * DETERMINISTICAMENTE `git checkout`/`git pull`/`git stash`/`git reset`
 * (#3728 Gap 1 + #3738 — defesa em profundidade, ver limitação conhecida
 * abaixo). Fora do blocklist, o `canUseTool` segue o padrão CONSERVADOR de
 * `studio-chat.ts` (nega por padrão qualquer tool call que
 * `.claude/settings.json` não resolveu sozinho) — a sessão coordenadora
 * deliberadamente NÃO expande permissões além do que um terminal interativo
 * já teria; a lacuna real que sobra (`gh api graphql` pro gate de threads
 * não estar no `allow` de `.claude/settings.json`, #3728 Gap 3 original) vai
 * aparecer como um evento de denial no stream em vez de travar
 * silenciosamente — é escopo do #3720 (validação ao vivo + extensão do
 * allow-list, sessão supervisionada `/diaria-develop`, não overnight), não
 * desta fatia.
 *
 * ## LIMITAÇÃO CONHECIDA — dois guards são bypassados por `.claude/settings.json` (#3738)
 *
 * Investigação do #3738 (Fase 1.5b, angle A) confirmou por leitura direta de
 * `.claude/settings.json` que dois blocos deste módulo NUNCA são de fato
 * alcançados pra uma classe inteira de comandos, porque o SDK resolve o
 * allow-list de `settings.json` ANTES de invocar `canUseTool` (precedência
 * do harness, não bug deste módulo):
 *
 * (a) **Guard de working-tree** (`WAVE_WORKTREE_GUARD_RE`) — efetivo pra
 *     `git pull`/`git stash`/`git reset` (nenhum dos três está pré-aprovado
 *     em `settings.json`), mas **NÃO** pra `git checkout`/`git push` — ambos
 *     já allowlistados incondicionalmente em `.claude/settings.json`
 *     (`"Bash(git checkout *)"`, `"Bash(git push *)"` no bloco
 *     `permissions.allow` — não citamos número de linha aqui de propósito,
 *     drifta fácil; buscar pela string literal). Um `git checkout master`
 *     disparado pela coordenadora é auto-aprovado pelo harness antes de
 *     `evaluateWaveTool` sequer rodar.
 * (b) **Guard de publicação** (`WAVE_PUBLISH_GUARD_RE`, o guard PRINCIPAL do
 *     módulo) — `.claude/settings.json` também tem `"Bash(npx tsx
 *     scripts/*.ts)"` no allow-list incondicional. Isso cobre QUALQUER
 *     script invocado nesse formato, inclusive os próprios scripts que este
 *     guard tenta bloquear: `npx tsx scripts/publish-facebook.ts`,
 *     `npx tsx scripts/clarice-schedule-sends.ts`,
 *     `npx tsx scripts/clarice-import-waves.ts`,
 *     `npx tsx scripts/close-poll.ts`. Todos batem no padrão já pré-aprovado
 *     e portanto nunca chegam a `evaluateWaveTool`. Isso undermina a
 *     alegação CENTRAL do módulo (bloquear publicação real numa sessão sem
 *     supervisão) — não é uma proteção secundária como (a), é a proteção
 *     primária.
 *
 * Nenhum dos dois é corrigível com um fix mecânico neste arquivo — corrigir
 * de verdade exige restringir ou remover essas entradas do allow-list de
 * `.claude/settings.json` (potencialmente só no contexto de uma sessão
 * wave-fire, não globalmente, já que outras skills legitimamente precisam
 * desses padrões amplos). Essa é uma decisão de arquitetura/produto, não um
 * fix de regex — **o lugar certo pra resolver é o #3720** (validação
 * supervisionada + decisão sobre o allow-list, sessão `/diaria-develop` com
 * o editor presente). Os regexes abaixo continuam valendo como defesa em
 * profundidade pro resíduo de casos onde `canUseTool` é de fato invocado
 * (ex.: comandos que não batem em nenhum padrão pré-aprovado) e como
 * documentação executável da intenção do módulo.
 *
 * ## Guard de "espera de CI" como CÓDIGO, não só prosa (#3753)
 *
 * Validação ao vivo do #3720 (sessão 260720) achou que a coordenadora, ao ver
 * CI ainda rodando nos PRs recém-abertos, chamou a tool `ScheduleWakeup` (2x,
 * delay 300s) esperando ser retomada mais tarde pra checar `gh pr checks` de
 * novo. Isso nunca acontece: `ScheduleWakeup` agenda a retomada da sessão
 * PRINCIPAL do harness CLI interativo — não existe nada do lado do
 * `studio-server` que escute esse agendamento e dispare uma continuação desta
 * sessão `query()` específica (ela é uma chamada de biblioteca embutida no
 * processo do servidor, iniciada por uma requisição HTTP e streamada via
 * SSE; quando o `for await` deste módulo termina, a stream acaba e não sobra
 * nenhum processo escutando). O resultado observado: a onda trava
 * permanentemente sem qualquer `chat-error` — a resposta SSE fecha
 * normalmente porque, do ponto de vista do SDK, o turno terminou com
 * sucesso.
 *
 * A prosa do prompt (`buildWaveFireCoordinatorPrompt`, passo 3) já instrui a
 * coordenadora a esperar CI via polling síncrono bloqueante (`gh pr checks
 * {pr} --watch` ou um loop `Bash` com `sleep`/retry) dentro do mesmo turno, e
 * a nunca usar `ScheduleWakeup`. Mas, igual ao guard de publicação acima,
 * prosa sozinha é insuficiente pra uma sessão sem supervisão — por isso
 * `runWaveFire` também passa `disallowedTools: ["ScheduleWakeup",
 * "CronCreate"]` pro SDK (`Options.disallowedTools`, "removed from the
 * model's context and cannot be used, even if they would otherwise be
 * allowed" — mais forte que `canUseTool`/`evaluateWaveTool`, que só age
 * quando o SDK de fato consulta o handler; ver "LIMITAÇÃO CONHECIDA" acima
 * sobre como esse consult pode ser pulado). `CronCreate` entra pelo mesmo
 * motivo de raiz de `ScheduleWakeup` (agenda uma retomada futura que nenhum
 * listener externo vai disparar pra esta sessão embutida) mesmo sem ter sido
 * o mecanismo observado no incidente — é o mesmo bug de arquitetura, não um
 * segundo bug.
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
    `3. ANTES do Gate 2, espere o CI de cada PR terminar via POLLING SÍNCRONO BLOQUEANTE, dentro deste MESMO turno:`,
    `   \`gh pr checks {pr} --watch\` (bloqueia até o CI resolver) ou um loop \`Bash\` com \`sleep\`/retry chamando`,
    `   \`gh pr checks {pr} --json bucket,name\` até nenhum bucket ficar "pending". NUNCA use \`ScheduleWakeup\` (nem`,
    `   \`CronCreate\`/qualquer outro agendamento) pra esperar o CI — essa tool nem está disponível nesta sessão`,
    `   (removida via disallowedTools), e mesmo que estivesse: você é uma sessão query() do Agent SDK embutida no`,
    `   studio-server, sem NADA do lado do servidor que escute um agendamento e retome esta sessão específica —`,
    `   agendar um wakeup aqui deixa a onda travada pra sempre, sem qualquer sinalização de erro pro chamador`,
    `   HTTP (achado real, #3753). Toda espera precisa acontecer dentro desta mesma invocação, nunca delegada`,
    `   pra uma retomada futura.`,
    `4. Só então, para cada PR aberto, rode o GATE 2 determinístico (mesmo do overnight/develop, #2210/#2222)`,
    `   ANTES de mergear: (a) \`gh pr checks {pr} --json bucket,name\` — todo bucket precisa ser "pass"; (b) via`,
    `   \`gh api graphql\`, checar que não há review threads não-resolvidas excluindo as marcadas FORBIDDEN.`,
    `   Só prossiga pro merge se AMBAS as condições passarem.`,
    `5. MERGE É SEMPRE SERIAL — nunca rode dois \`gh pr merge\` ao mesmo tempo, mesmo com múltiplos PRs prontos.`,
    `   Um de cada vez: \`gh pr merge {pr} --squash\`, confirme sucesso, só então passe pro próximo PR pronto.`,
    `6. IMPORTANTE — nunca rode \`git checkout\`/\`git pull\`/\`git stash\`/qualquer comando que mude o working tree`,
    `   da pasta em que VOCÊ (coordenadora) está rodando — essa pasta pode estar em uso ativo numa sessão manual`,
    `   do editor em paralelo (incidente real: colisão de working tree, 260716). Toda mutação de arquivo acontece`,
    `   SÓ dentro dos worktrees isolados que os Agent dispatchados criam sozinhos via \`isolation: "worktree"\`.`,
    `   Suas ações diretas (fora do Agent tool) ficam limitadas a comandos \`gh\` (API-level, não tocam o working`,
    `   tree local).`,
    `7. NUNCA rode \`scripts/publish-*\`, \`clarice-schedule-sends\`, \`clarice-import-*\`, \`close-poll\`, ou qualquer`,
    `   script que toque Beehiiv/LinkedIn/Facebook/Brevo — nem você, nem instrua os agentes dispatchados a rodar`,
    `   (guard de publicação, INVARIANTE, ${dispatchRulesPath} §1).`,
    ``,
    `Ao final (todas as issues processadas — mergeadas, com PR pendente de CI, ou com falha documentada), produza`,
    `um resumo em texto: por issue, o resultado (mergeada / PR aberto aguardando CI / falhou — motivo).`,
  ].join("\n");
}

// ─── guard de publicação como código (puro, defesa em profundidade) ───────

const WAVE_PUBLISH_GUARD_RE =
  /\bscripts[\\/](publish-|clarice-schedule-|clarice-import-)|close-poll\.ts|\b(beehiiv|linkedin|facebook|brevo)\b/i;

/**
 * Guard de working-tree (#3728 Gap 1 + #3738, defesa em profundidade).
 * Bloqueia `checkout`/`pull`/`stash`/`reset` (#3738 Gap 1 — `reset` estava
 * faltando; foi o comando literal do incidente 260716, `git reset --hard`,
 * que passava batido pelo regex anterior). Tolerante a flags/argumentos
 * entre `git` e o subcomando (#3738 Gap 3 — ex: `git -C ../other-worktree
 * checkout master`, `git.exe checkout master`) via um grupo não-capturante
 * que consome tokens que NÃO são um dos quatro subcomandos até achar um que
 * seja. O ponto de parada de cada subcomando exige fronteira de TOKEN
 * (`(?=\s|$)`, não `\b`) — `\b` sozinho também "acha" esses quatro nomes
 * quando são só PREFIXO de um token maior (nome de arquivo/branch que
 * começa com a palavra, ex: `reset-connection-pool`, `checkout-flow.ts`):
 * `\b` marca fronteira entre char de palavra e não-palavra, e `-`/`.` já
 * contam como não-palavra, então `reset\b`/`checkout\b` casavam mesmo sem
 * ser o subcomando de verdade (#3745 — regex casava substring em posição
 * errada; resultado allow/deny não mudava, já que o guard nega por padrão
 * de qualquer forma, mas o motivo do log ficava impreciso).
 *
 * `.claude/settings.json` já allowlista `Bash(git checkout *)`/
 * `Bash(git push *)` incondicionalmente — o que, pelo funcionamento do SDK
 * descrito no doc-comment do módulo, significa que `git checkout`/`git
 * push` costumam ser auto-aprovados ANTES desta função sequer ser invocada.
 * Este regex é EFETIVO pra `git pull`/`git stash`/`git reset` (nenhum dos
 * três está pré-aprovado em `settings.json`) mas NÃO pra `git checkout`/
 * `git push` — ver seção "LIMITAÇÃO CONHECIDA" no topo do módulo. A lacuna
 * real de settings.json é escopo do #3720 (validação ao vivo + extensão do
 * allow-list numa sessão supervisionada), não desta issue.
 */
const WAVE_WORKTREE_GUARD_RE =
  /\bgit(?:\.exe)?\s+(?:(?!(?:checkout|pull|stash|reset)(?:\s|$))\S+\s+)*(?:checkout|pull|stash|reset)(?:\s|$)/i;

export interface WaveToolDecision {
  allow: boolean;
  reason?: string;
}

/**
 * Decisão pura pra 1 tool call da sessão coordenadora — separada de
 * `makeWaveSafeCanUseTool` (que é só o wrapper async exigido pelo shape
 * `CanUseTool` do SDK) pra ser testável sem mockar o SDK. Três camadas:
 * (1) blocklist de working-tree (#3728 Gap 1, #3738 Gaps 1+3), INVARIANTE, nunca contornável;
 * (2) blocklist de publicação, INVARIANTE, nunca contornável; (3) fora
 * disso, nega por padrão (mesmo espírito conservador do chat drawer,
 * `studio-chat.ts` `denyToolResult`) — esta sessão roda sem supervisão
 * humana, então "permitir por padrão" é o erro mais caro possível aqui.
 * `.claude/settings.json` já resolveu (allow) tudo que a coordenadora
 * legitimamente precisa ANTES desta função ser chamada — ela só é invocada
 * pro resíduo que pediria um prompt interativo (ver doc-comment do módulo).
 */
export function evaluateWaveTool(toolName: string, input: Record<string, unknown>): WaveToolDecision {
  if (toolName === "Bash" && typeof input.command === "string") {
    if (WAVE_WORKTREE_GUARD_RE.test(input.command)) {
      return {
        allow: false,
        reason:
          "guard de working-tree (INVARIANTE, defesa em profundidade): esta sessão coordenadora nunca roda " +
          "git checkout/git pull/git stash/git reset na pasta principal — ela pode estar em uso ativo numa sessão manual " +
          "do editor em paralelo (incidente real: colisão de working tree, 260716). Toda mutação de arquivo " +
          "acontece só dentro dos worktrees isolados dispatchados via Agent.",
      };
    }
    if (WAVE_PUBLISH_GUARD_RE.test(input.command)) {
      return {
        allow: false,
        reason:
          "guard de publicação (INVARIANTE): esta sessão nunca dispara scripts/publish-*, clarice-schedule-*, " +
          "clarice-import-*, close-poll ou qualquer script Beehiiv/LinkedIn/Facebook/Brevo, mesmo em onda automática.",
      };
    }
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
        // #3753 — nunca esperar CI via retomada externa: essas tools agendam uma
        // continuação futura que nada do lado do studio-server escuta pra esta
        // sessão embutida (ver doc-comment do módulo, "Guard de espera de CI").
        // Removidas do contexto do modelo por completo (mais forte que canUseTool).
        disallowedTools: ["ScheduleWakeup", "CronCreate"],
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
