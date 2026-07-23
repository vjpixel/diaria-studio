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
 * abaixo, RESOLVIDA em #3720). Fora do blocklist e fora do allow-list
 * explícito descrito na seção "A correção (#3720)" abaixo, `canUseTool`
 * nega por padrão — desde que `runWaveFire` passa `settingSources: []`,
 * `.claude/settings.json` deixou de ser consultado NESTA sessão
 * especificamente, então toda decisão de tool call passa por
 * `evaluateWaveTool` sem exceção (ver "LIMITAÇÃO CONHECIDA" abaixo pro
 * histórico completo do porquê isso importa). A sessão coordenadora
 * deliberadamente NÃO expande permissões além do estritamente necessário
 * pro protocolo de dispatch + Gate 2 + merge que o próprio prompt
 * (`buildWaveFireCoordinatorPrompt`) instrui: `Agent` (só com `isolation:
 * "worktree"` explícito) e um punhado de formas EXATAS de `gh pr checks`/
 * `gh pr merge`/`gh api graphql`/`gh issue view` (constantes
 * `GH_PR_CHECKS_*`/`GH_PR_MERGE_SQUASH_RE`/`GH_API_GRAPHQL_*`/
 * `GH_ISSUE_VIEW_JSON_RE` abaixo — #3720 fecha a lacuna que antes aparecia
 * como "evento de denial no stream" pro Gate 2, #3728 Gap 3 original).
 * **Exceção pontual (#3791):** `gh issue comment`/`gh issue close` são
 * explicitamente ALLOW em `evaluateWaveTool` (não fazem parte do "fora do
 * blocklist nega por padrão") — são os 2 subcomandos text-only que o
 * protocolo do #3781/#3782 depende (marcador de diagnóstico, fallback de
 * fechamento). `.claude/settings.json` também tem `Bash(gh issue comment
 * *)`/`Bash(gh issue close *)`/`Bash(gh issue view *)` no allow-list
 * incondicional (mesmo padrão de `Bash(gh pr *)` já existente) — isso
 * continua relevante pra OUTRAS sessões que preservam `settingSources:
 * ["user", "project", "local"]` (terminal interativo, chat drawer de
 * `studio-chat.ts`), mas deixou de ter qualquer efeito NESTA sessão desde
 * #3720; por isso `evaluateWaveTool` allowlista esses mesmos comandos de
 * forma independente (`GH_ISSUE_ALLOWED_SHAPE_RE` abaixo), sem depender do
 * `settings.json` compartilhado.
 *
 * ## LIMITAÇÃO CONHECIDA — RESOLVIDA EM #3720 (settingSources: [])
 *
 * Investigação do #3738 (Fase 1.5b, angle A) confirmou por leitura direta de
 * `.claude/settings.json` que blocos deste módulo NUNCA eram de fato
 * alcançados pra uma classe inteira de comandos, porque o SDK resolve o
 * allow-list de `settings.json` ANTES de invocar `canUseTool` (precedência
 * do harness, não bug deste módulo):
 *
 * (a) **Guard de working-tree** (`WAVE_WORKTREE_GUARD_RE`) — efetivo pra
 *     `git pull`/`git stash`/`git reset` (nenhum dos três estava
 *     pré-aprovado em `settings.json`), mas **NÃO** pra `git checkout`/`git
 *     push` — ambos allowlistados incondicionalmente em
 *     `.claude/settings.json` (`"Bash(git checkout *)"`, `"Bash(git push
 *     *)"` no bloco `permissions.allow`). Um `git checkout master`
 *     disparado pela coordenadora era auto-aprovado pelo harness antes de
 *     `evaluateWaveTool` sequer rodar.
 * (b) **Guard de publicação** (`WAVE_PUBLISH_SCRIPT_EXEC_RE`/
 *     `WAVE_PUBLISH_PLATFORM_WORD_RE`, o guard PRINCIPAL do módulo —
 *     `WAVE_PUBLISH_GUARD_RE` original foi split em dois em #3791, ver
 *     doc-comment das duas constantes) — `.claude/settings.json` também tem
 *     `"Bash(npx tsx scripts/*.ts)"` no allow-list incondicional. Isso cobria
 *     QUALQUER script invocado nesse formato, inclusive os próprios scripts
 *     que este guard tenta bloquear: `npx tsx scripts/publish-facebook.ts`,
 *     `npx tsx scripts/clarice-schedule-sends.ts`,
 *     `npx tsx scripts/clarice-import-waves.ts`,
 *     `npx tsx scripts/close-poll.ts`. Todos batiam no padrão já
 *     pré-aprovado e portanto nunca chegavam a `evaluateWaveTool`. Isso
 *     undermina a alegação CENTRAL do módulo (bloquear publicação real numa
 *     sessão sem supervisão) — não era uma proteção secundária como (a),
 *     era a proteção primária.
 * (c) **Não documentado antes de #3720** — `Agent` (a tool que dispatcha
 *     cada unidade da onda, ver `buildWaveFireCoordinatorPrompt` passo 1)
 *     também estava no allow-list incondicional de `.claude/settings.json`
 *     (`"Agent"`, sem qualificação de argumento nenhuma). Uma chamada
 *     `Agent` SEM `isolation: "worktree"` (prompt mal-formado, bug futuro na
 *     sessão coordenadora) também era auto-aprovada antes de
 *     `evaluateWaveTool` rodar — undermina, por outro caminho, a MESMA
 *     garantia que (a) protege ("a pasta principal nunca é tocada
 *     diretamente pela coordenadora").
 *
 * ### A correção (#3720)
 *
 * `runWaveFire` passa `settingSources: []` pro SDK (`Options.settingSources`
 * — "Pass `[]` to disable filesystem settings (SDK isolation mode)", ver
 * `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`). Isso desliga
 * COMPLETAMENTE a resolução de `user`/`project`/`local` settings.json pra
 * ESTA sessão específica — `.claude/settings.json` do repo (que outras
 * sessões continuam usando normalmente e sem mudança nenhuma, inclusive o
 * chat drawer de `studio-chat.ts`) deixa de existir do ponto de vista do SDK
 * aqui. Consequência: TODA decisão de tool call desta sessão passa, sem
 * exceção, por `evaluateWaveTool` — os três bypasses acima são
 * estruturalmente impossíveis agora (não há allow-list externo pra
 * consultar antes de `canUseTool` sequer ser chamado).
 *
 * A tentação óbvia seria compensar via `Options.settings` (a "flag
 * settings" layer, prioridade mais alta) com os MESMOS wildcards largos que
 * `.claude/settings.json` já tinha (`Bash(git checkout *)`, `Bash(npx tsx
 * scripts/*.ts)`, `"Agent"` sem qualificação, etc.) — isso recriaria
 * EXATAMENTE o mesmo bypass, só que escopado a esta sessão em vez de
 * compartilhado com o resto do repo. Rejeitado de propósito (decisão de
 * arquitetura tomada com o editor presente): os comandos que a coordenadora
 * de fato precisa são resolvidos INTEIRAMENTE dentro de `evaluateWaveTool` —
 * um allow-list cirúrgico por comando (âncora de string inteira, sem
 * metacaractere de shell, sem flag fora do esperado), mesmo padrão de rigor
 * já usado pra `GH_ISSUE_ALLOWED_SHAPE_RE`/`GH_ISSUE_SHELL_CHAIN_RE`:
 *
 * - `Agent` — só com `isolation: "worktree"` explícito no input (fecha o
 *   gap (c) acima; `subagent_type`/`model` não são validados aqui, afetam
 *   qualidade/custo, não blast radius).
 * - `gh pr checks {N} --watch` / `gh pr checks {N} --json bucket,name` (e
 *   variações de ordem/subconjunto desses 2 campos) — espera de CI +
 *   condição 1 do Gate 2 (`GH_PR_CHECKS_WATCH_RE`/`GH_PR_CHECKS_JSON_RE`).
 * - `gh api graphql -f query="..."` — só pras 2 formas EXATAS que o Gate 2
 *   usa (query read-only de `reviewThreads` de um PR, mutation
 *   `resolveReviewThread` com um `threadId` variável) — qualquer outra
 *   query/mutation, ou a mesma com texto adicional encadeado, cai no
 *   default-deny (`GH_API_GRAPHQL_REVIEW_THREADS_RE`/
 *   `GH_API_GRAPHQL_RESOLVE_THREAD_RE`).
 * - `gh pr merge {N} --squash` — só essa forma exata, sem `--admin`/
 *   `--auto` nem qualquer flag adicional (`GH_PR_MERGE_SQUASH_RE`).
 * - `gh issue view {N} --json state` (e a forma com os 3 campos usados pela
 *   validação pós-turno, `state,comments,closedByPullRequestsReferences`,
 *   em qualquer ordem suportada) — confirmação de fechamento no passo 5 do
 *   prompt (`GH_ISSUE_VIEW_JSON_RE`).
 *
 * **Efeito colateral aceito, documentado (não é regressão silenciosa):** com
 * `settingSources: []`, tools antes triviais (`Read`, `Write`, `Edit`,
 * `Glob`, `Grep`, `WebFetch`, `WebSearch`) não têm mais allow nenhum nesta
 * sessão — a coordenadora não tem como tocar arquivo/rede diretamente, só
 * via `Agent` (subagentes em worktree isolado) e os comandos `gh` acima.
 * Isso não é uma regressão: o prompt da coordenadora
 * (`buildWaveFireCoordinatorPrompt`) já a instruía a nunca fazer isso ("Sua
 * única responsabilidade: dispatch + gate de merge serial") —
 * `evaluateWaveTool` agora torna essa instrução também estruturalmente
 * verdadeira, não só uma convenção de prosa.
 *
 * A validação ao vivo contra o SDK real (não mockada) — confirmar que a
 * sessão de fato consegue dispatchar `Agent`, rodar o Gate 2 via `gh api
 * graphql`, e mergear com este allow-list — é responsabilidade do
 * COORDENADOR da sessão `/diaria-develop` (Gate B + validação ao vivo),
 * nunca deste PR (ver "O que NÃO está nesta fatia" abaixo: nenhuma sessão
 * real foi disparada como parte deste fix).
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
 * ## #3914 — subagentes dispatchados ficavam presos no MESMO allow-list ultra-estreito da coordenadora
 *
 * Validação ao vivo do #3720 (sessão 260722) confirmou que os 3 bypasses de
 * `.claude/settings.json` estavam de fato fechados — a coordenadora tentou
 * `Bash` genérico, foi negada, se autodiagnosticou corretamente e
 * dispatchou `Agent` (isolation: worktree, model: sonnet) normalmente. O
 * GAP NOVO: o(s) subagente(s) dispatchado(s) tentaram `gh issue view
 * {numero} --json number,title,body,labels,comments` (passo normal de
 * qualquer implementador pra entender a própria issue) e foram NEGADOS
 * também — resultado observado: 3 worktrees criados em ~8min, ZERO rodou
 * `npm ci`, a onda travou sem produzir PR nenhum e sem sinalização de erro.
 *
 * **Causa raiz confirmada** (leitura de `node_modules/@anthropic-ai/claude-agent-sdk`,
 * sem rodar o SDK real — #207 bloqueia recursão de `Agent` de dentro deste
 * worktree):
 *
 * 1. `settingSources: []` (a correção do #3720, ver seção acima) é traduzido
 *    pelo SDK num flag `--setting-sources=` do PROCESSO INTEIRO spawnado
 *    (`sdk.mjs`: `if(U!==void 0)W.push(\`--setting-sources=${U.join(",")}\`)`
 *    — `W` é o array de argv do `claude` CLI, não algo reconfigurável por
 *    dispatch individual de `Agent`). Nem `AgentDefinition` nem `AgentInput`
 *    (`sdk-tools.d.ts`) têm campo `settingSources`/`canUseTool` próprio — não
 *    existe como um dispatch de `Agent` pedir uma resolução de settings
 *    diferente da sessão pai.
 * 2. `CanUseTool` (`sdk.d.ts`) recebe, como 3º parâmetro, `options.agentID?:
 *    string` — "If running within the context of a sub-agent, the
 *    sub-agent's ID." Ou seja: o MESMO `canUseTool` registrado em
 *    `runWaveFire` (`makeWaveSafeCanUseTool`) governa TAMBÉM as tool calls
 *    de qualquer subagente dispatchado, não só as da coordenadora —
 *    confirma o mecanismo observado ao vivo.
 *
 * Consequência: `evaluateWaveTool`, desenhado deliberadamente ultra-estreito
 * só pros ~10 comandos exatos que a COORDENADORA precisa (dispatch + Gate 2
 * + merge serial), também decidia allow/deny pra TUDO que um subagente
 * implementador tentasse — sem allow nenhum pra `Read`/`Write`/`Edit` (nem
 * pra ler `context/overnight-dispatch-rules.md`, passo 1 do próprio prompt
 * de dispatch), `npm ci`, `git add`/`commit`/`push`, ou `gh pr create`.
 *
 * **Fix (#3914):** `evaluateWaveTool` ganhou um 3º parâmetro opcional
 * (`agentID`) e, quando presente, consulta um allow-list SEPARADO — mais
 * permissivo que o da coordenadora mas ainda sujeito aos MESMOS guards
 * INVARIANTES de publicação (nunca lifted, dispatch-rules.md §1 é explícito:
 * "todo subagente implementador") — ver doc-comment das constantes
 * `WAVE_SUBAGENT_*` (logo antes de `WaveToolDecision`) pro allow-list
 * completo e o raciocínio de cada peça (por que `Read`/`Write`/`Edit` são
 * seguros de liberar incondicionalmente, por que o guard de working-tree não
 * se aplica a um cwd que já é um worktree isolado, por que `gh pr merge`/
 * `gh api graphql` continuam EXCLUSIVOS da coordenadora). Mitigação
 * complementar: `fetchWaveIssueSummaries` busca título/corpo/labels de cada
 * issue ANTES da sessão coordenadora iniciar (fora da sessão SDK) e
 * `buildWaveFireCoordinatorPrompt` embute esse conteúdo no prompt de
 * dispatch — reduz (não elimina) a dependência de cada subagente em rodar
 * `gh issue view` ele mesmo.
 *
 * **O que ISTO NÃO resolve, fica pra validação ao vivo (Parte B, fora do
 * escopo desta PR):** (a) confirmação empírica de que `agentID` de fato
 * chega no shape esperado pra um dispatch `general-purpose` sem `agents:`
 * customizado (a doc do SDK descreve o campo, mas nenhuma chamada real foi
 * feita); (b) o incidente original menciona a coordenadora/subagente
 * tentando o comando "via `Bash` E via `PowerShell`" — este módulo só
 * inspeciona `input.command` como string via regex ancorado em `gh`/`git`/
 * `npm`/`npx`; um comando envolto em `powershell -Command "..."` NÃO bate
 * em nenhum desses padrões (ficaria no default-deny). Não implementado de
 * propósito: desembrulhar `powershell -Command "..."`/`cmd /c "..."` de
 * forma segura exigiria parsing de aspas/escaping arbitrário — superfície de
 * risco nova (um allow indevido aqui seria pior que o status quo). A leitura
 * mais provável do incidente é que isso foi uma tentativa de WORKAROUND da
 * negação original (CLAUDE.md deste repo já instrui a tool `Bash` normal
 * deste projeto a rodar via Git Bash, não PowerShell) — uma vez que `gh
 * issue view` com campos amplos passa a ser permitido diretamente, não
 * deveria haver motivo pro subagente tentar o wrapper; se a validação ao
 * vivo mostrar o contrário, é um padrão novo pra adicionar aqui depois,
 * nunca pra assumir resolvido sem reconfirmar; (c) se o protocolo completo
 * (`npm ci` → `tsc` → teste → commit → push → `gh pr create`) realmente
 * completa fim-a-fim dentro do worktree isolado do subagente — só um
 * disparo real contra 1 issue trivial confirma isso.
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
import { spawnGhSync, GH_SPAWN_TIMEOUT_MS, type GhSpawnResult } from "./gh-run.ts";

// #3783 — `spawnGhSync`/`GH_SPAWN_TIMEOUT_MS` moraram aqui até #3773; movidos
// pra `gh-run.ts` (módulo compartilhado com `studio-issues.ts`, que tinha o
// mesmo gap de spawnSync sem timeout). Re-exportados aqui pra não quebrar os
// call sites/testes existentes que importam de `studio-wave-fire.ts`.
export { spawnGhSync, GH_SPAWN_TIMEOUT_MS };

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

/**
 * #3914 — resumo de 1 issue da onda, buscado por `fetchWaveIssueSummaries`
 * ANTES da sessão coordenadora iniciar (fora da sessão SDK, via `gh issue
 * view` direto — nunca sujeito a `evaluateWaveTool`). Campos opcionais: um
 * `gh` que falhe pra uma issue específica (rate limit, issue deletada) não
 * deve derrubar a onda inteira — `fetchWaveIssueSummaries` é fail-soft por
 * issue, ver doc-comment da função.
 */
export interface WaveIssueSummary {
  number: number;
  title?: string;
  body?: string;
  labels?: string[];
  url?: string;
}

export interface WaveFirePromptOptions {
  maxConcurrency?: number;
  /** Nome do arquivo de checklist canônico — parametrizado só pra teste;
   * produção sempre usa o default real. */
  dispatchRulesPath?: string;
  /**
   * #3914 — resumos (título/corpo/labels) já buscados pra cada issue da onda.
   * Quando presente, o prompt embute o corpo completo de cada issue
   * diretamente no dispatch, em vez de instruir cada subagente a descobrir
   * sozinho via `gh issue view` (mitigação complementar ao fix de permissão
   * em `evaluateWaveTool`: reduz a dependência do subagente na chamada `gh`
   * que motivou o achado original do #3914, mesmo padrão já usado pelos
   * outros dispatches overnight/develop desta mesma rodada — citar o corpo
   * da issue no prompt em vez de pedir pro subagente buscar sozinho). Uma
   * issue sem summary correspondente (fetch falhou) cai de volta pra
   * instrução antiga (buscar via `gh issue view`, agora permitido pro
   * subagente desde #3914).
   */
  issues?: WaveIssueSummary[];
}

/**
 * Marcador literal (#3782) que a coordenadora é instruída a prefixar em
 * qualquer comentário de diagnóstico/falha que ela mesma poste numa issue
 * (`buildWaveFireCoordinatorPrompt` passo 2). Substitui `author.login` como
 * sinal de "quem escreveu este comentário": este repo é de operador único
 * (`gh auth status` sempre a mesma conta pra coordenadora, editor humano
 * comentando manualmente, e qualquer sessão overnight/develop paralela) —
 * `author.login === botLogin` era verdadeiro nos 3 casos, então o filtro do
 * #3772 Bug 2 não distinguia nada na prática. `evaluateIssueTerminalState`
 * exige que o `body` do comentário comece com este marcador pra contar como
 * diagnóstico pós-dispatch da própria automação.
 */
export const WAVE_DIAGNOSTIC_COMMENT_PREFIX = "[wave-fire-diagnostic]";

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
  const marker = WAVE_DIAGNOSTIC_COMMENT_PREFIX;
  // #3914 — quando o caller já buscou os detalhes de cada issue (fora da
  // sessão SDK, via `gh issue view` direto em `fetchWaveIssueSummaries`),
  // embute o corpo completo aqui — reduz a dependência do subagente
  // dispatchado em rodar `gh issue view` ele mesmo pra descobrir do que se
  // trata a própria issue (mitigação complementar ao fix de permissão em
  // `evaluateWaveTool` abaixo). Uma issue sem summary (fetch falhou pra ela
  // especificamente, fail-soft por issue) simplesmente não aparece aqui — o
  // subagente cai de volta pra buscar via `gh issue view`, agora permitido
  // (ver `isAllowedWaveSubagentGhIssueView`).
  const issuesByNumber = new Map((opts.issues ?? []).map((i) => [i.number, i]));
  const issueDetailsBlock = issueNumbers
    .map((n) => issuesByNumber.get(n))
    .filter((i): i is WaveIssueSummary => i !== undefined && (i.title !== undefined || i.body !== undefined))
    .map((i) => {
      const labels = i.labels && i.labels.length > 0 ? i.labels.join(", ") : "(nenhuma)";
      return [
        `### Issue #${i.number}${i.title ? `: ${i.title}` : ""}`,
        `Labels: ${labels}`,
        i.url ? `URL: ${i.url}` : undefined,
        ``,
        i.body && i.body.trim() !== "" ? i.body : "(corpo vazio)",
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n");
    });
  const step1IssueBodyNote =
    issueDetailsBlock.length > 0
      ? 'O TÍTULO E CORPO COMPLETO de cada issue já estão anexados na seção "Detalhes das issues" no final deste ' +
        "prompt — cole esse conteúdo DIRETO no prompt de dispatch de cada subagente (não instrua o subagente a rodar " +
        "`gh issue view` pra descobrir do que se trata; #3914)."
      : "Inclua no prompt de dispatch o número da issue — o subagente pode rodar `gh issue view {numero} --json " +
        "number,title,body,labels,comments,assignees,state,url` pra ler os detalhes (permitido a subagentes " +
        "dispatchados desde #3914).";

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
    `     issue + branch \`develop/fix-{numero}\` + "abra PR com \`Closes #{numero}\` (closing keyword real do GitHub —`,
    `     NUNCA \`Refs #{numero}\`, que não fecha a issue nem popula closedByPullRequestsReferences, #3781), self-review`,
    `     obrigatório (#2038), nunca faça merge você mesma — a coordenadora cuida do merge". ${step1IssueBodyNote}`,
    `   Envie até ${maxConcurrency} dessas tool calls NA MESMA mensagem (concorrência real) — nunca mais que`,
    `   ${maxConcurrency} worktrees abertos ao mesmo tempo.`,
    `2. Espere cada Agent retornar. Cada retorno traz (idealmente) um número de PR. Se um agente falhar/não abrir`,
    `   PR, registre a falha via \`gh issue comment {numero} --body "${marker} <descrição da falha/bloqueio>"\` e siga`,
    `   para as demais issues — uma falha isolada não aborta a onda inteira. O prefixo literal \`${marker}\` no INÍCIO`,
    `   do corpo do comentário é OBRIGATÓRIO — é o único jeito da validação pós-turno (#3782) diferenciar um`,
    `   comentário de diagnóstico SEU de um comentário manual do editor ou de outra sessão overnight/develop`,
    `   paralela na mesma issue: este repo é de operador único, as 3 fontes autenticam com a MESMA conta \`gh\`, então`,
    `   \`author.login\` sozinho nunca distingue quem escreveu o quê.`,
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
    `   Depois de CADA merge, confirme que a issue correspondente fechou (o \`Closes #{numero}\` do PR deveria fechar`,
    `   automaticamente). Se a issue seguir \`OPEN\` (\`gh issue view {numero} --json state\`) alguns segundos depois —`,
    `   rede lenta, delay de propagação do GitHub — feche explicitamente com \`gh issue close {numero} --comment`,
    `   "${marker} fechada via PR #{pr} (squash-merge)"\` (o marcador é OBRIGATÓRIO aqui também — sem ele, este`,
    `   fechamento manual conta como NÃO-terminal na validação pós-turno, #3782) antes de seguir pro próximo PR pronto (#3781).`,
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
    ...(issueDetailsBlock.length > 0
      ? [``, `## Detalhes das issues (#3914 — cole no prompt de dispatch de cada subagente)`, ``, ...issueDetailsBlock]
      : []),
  ].join("\n");
}

// ─── guard de publicação como código (puro, defesa em profundidade) ───────

/**
 * Bloqueia EXECUÇÃO de publisher. #3791 original: incondicional, nunca isento
 * pra nenhum comando, inclusive `gh issue comment`/`gh issue close` —
 * separada da checagem de palavra-solta abaixo justamente pra manter esse
 * pedaço incondicional.
 *
 * #3795 Bug 2: essa premissa causava falso-negativo funcional — um
 * comentário de diagnóstico 100% texto (`gh issue comment ... --body
 * "agente tentou rodar scripts/publish-facebook.ts e foi bloqueado"`) SEM
 * nenhum metacaractere de encadeamento (`GH_ISSUE_SHELL_CHAIN_RE` não bate)
 * recebia `allow: false` só por MENCIONAR o path do script em prosa, mesmo
 * não sendo execução nenhuma — o mesmo raciocínio que já isentava
 * `WAVE_PUBLISH_PLATFORM_WORD_RE` (menção textual != execução) se aplica
 * aqui igualmente. Isento agora também pra `gh issue comment`/`gh issue
 * close` quando `isGhIssueTextOnly` é true — ou seja, quando já é garantido
 * (pelo `GH_ISSUE_SHELL_CHAIN_RE`) que não há como o resto da string ser
 * INTERPRETADO como comando adicional pelo shell. Um comando que de fato
 * ENCADEIA execução (`gh issue comment 1 --body x && scripts/publish-*`)
 * tem `&&` e portanto falha `isGhIssueTextOnly` — cai no guard normal,
 * `allow: false`.
 */
const WAVE_PUBLISH_SCRIPT_EXEC_RE = /\bscripts[\\/](publish-|clarice-schedule-|clarice-import-)|close-poll\.ts/i;

/**
 * Bloqueia MENÇÃO textual a uma plataforma em qualquer lugar do comando —
 * pensado originalmente pra pegar chamadas cruas (`curl
 * https://api.brevo.com/...`, scripts fora do padrão `scripts/publish-*`)
 * que a checagem de execução acima não cobre. #3791: essa checagem por
 * PALAVRA (não por execução) é isenta especificamente pra `gh issue
 * comment`/`gh issue close` (ver `GH_ISSUE_TEXT_ONLY_RE` abaixo) — esses 2
 * subcomandos só escrevem/postam TEXTO numa issue do GitHub, nunca executam
 * nada, e o prompt da coordenadora (#3781/#3782) instrui explicitamente a
 * mencionar a plataforma bloqueadora num comentário de diagnóstico legítimo
 * ("bloqueado por falta de credencial do Beehiiv") — sem a isenção, esse
 * comentário auto-bloqueia a si mesmo.
 */
const WAVE_PUBLISH_PLATFORM_WORD_RE = /\b(beehiiv|linkedin|facebook|brevo)\b/i;

/**
 * #3791 — subcomandos `gh issue comment`/`gh issue close` são TEXT-ONLY:
 * postam/fecham com um comentário, nunca executam nada. São exatamente os 2
 * subcomandos que o prompt da coordenadora (`buildWaveFireCoordinatorPrompt`
 * passos 2 e 5) usa pro marcador de diagnóstico (#3782) e pro fallback de
 * fechamento manual (#3781) — sem isenção da checagem de palavra-solta
 * acima, um comentário de diagnóstico legítimo que mencione a plataforma
 * bloqueadora nunca conseguiria ser postado. Tolerante a `gh.exe` (mesmo
 * padrão de `WAVE_WORKTREE_GUARD_RE`); exige que o comando COMECE com `gh
 * issue comment`/`gh issue close` (não basta mencionar em outra parte do
 * comando) — cirúrgico de propósito, não abre exceção pra outros
 * subcomandos `gh issue *` nem pra `gh` encadeado depois de outro comando.
 *
 * IMPORTANTE (self-review #3791): este regex sozinho só ancora o PREFIXO do
 * comando — `^\s*gh(?:\.exe)?\s+issue\s+(?:comment|close)\b` casa igual num
 * comando encadeado tipo `gh issue comment 1 --body "x" && curl evil.com`,
 * porque não olha pro resto da string depois do prefixo. Como este módulo
 * introduz aqui o ÚNICO caminho `allow: true` de toda a função (antes desta
 * mudança, todo `Bash` acabava negado, mesmo sem bater em nenhum blocklist —
 * ver o teste removido "nunca allow=true"), um prefixo sozinho não é
 * suficiente pra decidir ALLOW com segurança: teria virado uma forma nova de
 * command injection (encadear qualquer comando depois de um `gh issue
 * comment` válido). Por isso `isGhIssueTextOnly` abaixo TAMBÉM exige ausência
 * de metacaracteres de encadeamento de shell (`GH_ISSUE_SHELL_CHAIN_RE`) —
 * um `--body`/`--comment` legítimo quase nunca precisa desses caracteres
 * crus fora de aspas, e o pior caso de falso-positivo (um body que
 * genuinamente contém `&&`/`;`/`|`/backtick/`$(`) é só cair no default-deny
 * conservador (igual ao comportamento de antes desta mudança), nunca um
 * allow indevido.
 *
 * #3795 Bug 1: o char class original (`[;&|`\n]|\$\(`) não cobria `<`/`>` —
 * redirect (`> arquivo`) e process substitution (`> >(comando)`) passavam
 * batidos como "sem encadeamento" e um `gh issue comment ... > >(touch
 * /tmp/pwned)` (ou `> .claude/settings.json`, sobrescrevendo o próprio
 * allow-list) recebia `allow: true` indevido. `<`/`>` adicionados ao char
 * class — mesmo espírito conservador: falso-positivo (body legítimo que
 * usa `<`/`>` cru) só cai no default-deny, nunca allow indevido.
 */
const GH_ISSUE_TEXT_ONLY_RE = /^\s*gh(?:\.exe)?\s+issue\s+(?:comment|close)\b/i;
const GH_ISSUE_SHELL_CHAIN_RE = /[;&|`\n<>]|\$\(/;

/**
 * #3801 — allowlist explícita de flags pra `gh issue comment`/`gh issue
 * close`, fechando uma exfiltração de segredo que `GH_ISSUE_TEXT_ONLY_RE` +
 * `GH_ISSUE_SHELL_CHAIN_RE` sozinhos não cobriam: essas duas checagens só
 * ancoram o PREFIXO do subcomando e a ausência de metacaracteres de
 * encadeamento de SHELL — nenhuma delas olha pra quais FLAGS do próprio `gh`
 * seguem. `--body-file`/`-F` (comment) e `--comment-file` (close) são flags
 * NATIVAS do `gh` CLI que leem o conteúdo de um arquivo local e o publicam
 * como corpo do comentário — sem passar por shell nenhum, então nenhuma
 * checagem de metacaractere jamais pegaria isso. Resultado pré-fix: `gh issue
 * comment 123 --body-file .env` recebia `allow: true` (nenhum char de
 * `GH_ISSUE_SHELL_CHAIN_RE` presente), dando à coordenadora headless um
 * primitivo "ler qualquer arquivo local legível e publicar publicamente como
 * comentário de issue" — sem execução de comando (não é RCE), mas é
 * exfiltração de segredo direta (`.env`, `.claude/settings.json`, etc).
 *
 * Fix: em vez de blocklist (rejeitar `--body-file`/`-F`/`--comment-file` por
 * nome — sempre vulnerável a uma flag equivalente futura do `gh` CLI que a
 * gente não pensou em blocklistar), este regex exige que o comando INTEIRO
 * (âncoras `^...$`) tenha exatamente a forma:
 * `gh[.exe] issue comment|close <id numérico> [(--body|--comment|-b|-c)(=| )
 * <valor>]` — nenhum outro token, nenhuma flag adicional, nada sobrando. O
 * `<valor>` pode ser uma string entre aspas simples/duplas (aceita QUALQUER
 * conteúdo dentro — inclusive menção textual a `git checkout`/`scripts/
 * publish-*`/nomes de plataforma, isso é conteúdo de comentário legítimo,
 * não execução, mesmo raciocínio de #3795 Bug 2) ou um token sem espaço
 * (`--body=valor`). Qualquer flag fora do allowlist (`--body-file`, `-F`,
 * `--comment-file`, ou a MESMA flag com `=` em vez de espaço, ex:
 * `--body-file=.env` — conferido no self-review, ver teste de regressão)
 * deixa sobra de texto que a âncora `$` não consome — `test()` retorna
 * `false`, `isGhIssueTextOnly` vira `false`, e o comando cai no guard normal
 * (default-deny, já que nenhuma das flags-alvo aparece nos outros
 * blocklists). Múltiplas flags (`--body "x" --body-file leak`) também falham
 * pelo mesmo motivo — o grupo opcional só casa UMA vez.
 */
const GH_ISSUE_ALLOWED_SHAPE_RE =
  /^\s*gh(?:\.exe)?\s+issue\s+(?:comment|close)\s+\d+\s*(?:(?:--body|--comment|-b|-c)(?:=|\s+)(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+))?\s*$/i;

// ─── #3720: comandos gh da sessão coordenadora (Gate 2 + espera de CI + merge) ──
//
// Com `runWaveFire` passando `settingSources: []` (ver doc-comment do
// módulo, seção "LIMITAÇÃO CONHECIDA — RESOLVIDA EM #3720"), NENHUM comando
// `gh` desta sessão é mais pré-aprovado por `.claude/settings.json` — cada
// forma abaixo precisa de allow explícito aqui, ou o protocolo inteiro do
// prompt da coordenadora (`buildWaveFireCoordinatorPrompt` passos 3-5) trava
// na primeira tentativa. Cada constante cobre EXATAMENTE (âncoras `^...$`)
// uma das formas citadas nesses passos do prompt — nenhuma flag adicional,
// nenhuma variação de subcomando, nenhum metacaractere de shell tem onde se
// esconder, porque a string inteira precisa bater no template fixo.

/**
 * #3720 — `gh pr checks {N} --watch` (passo 3: polling síncrono bloqueante
 * de CI, "`gh pr checks {pr} --watch` (bloqueia até o CI resolver)"). Só
 * aceita um número de PR (`\d+`) seguido exatamente de `--watch` — nenhuma
 * flag extra, nenhum encadeamento (a âncora `$` logo depois de `--watch\s*`
 * já reprova qualquer `&&`/`;`/`|` anexado, sem precisar de um char-class
 * separado como o de `GH_ISSUE_SHELL_CHAIN_RE`: aqui não há um "valor livre"
 * pra escapar, é uma forma 100% fixa).
 */
const GH_PR_CHECKS_WATCH_RE = /^\s*gh(?:\.exe)?\s+pr\s+checks\s+\d+\s+--watch\s*$/i;

/**
 * #3720 — `gh pr checks {N} --json bucket,name` (passos 3 e 4: loop de
 * poll + condição 1 do Gate 2 determinístico, "todo bucket precisa ser
 * 'pass'"). `bucket`/`name` são os 2 únicos campos que o prompt da
 * coordenadora de fato usa — allowlist explícita dos 2 nomes (em qualquer
 * ordem/subconjunto: `bucket,name` | `name,bucket` | `bucket` | `name`),
 * nunca um `--jq` com expressão arbitrária (que poderia extrair qualquer
 * outro campo do payload, incluindo potencialmente dados de outro PR via
 * uma expressão jq malformada de propósito) — mesmo espírito conservador do
 * resto do módulo: se a coordenadora precisar de outro campo, a chamada cai
 * no default-deny, nunca um allow indevido.
 */
const GH_PR_CHECKS_JSON_RE =
  /^\s*gh(?:\.exe)?\s+pr\s+checks\s+\d+\s+--json\s+(?:bucket,name|name,bucket|bucket|name)\s*$/i;

/**
 * #3720 — `gh pr merge {N} --squash` (passo 5: "MERGE É SEMPRE SERIAL...
 * `gh pr merge {pr} --squash`"). Confirmado por leitura de
 * `buildWaveFireCoordinatorPrompt` que o prompt NUNCA instrui `--admin` nem
 * `--auto` — ambas escalam privilégio (`--admin` ignora required checks/
 * reviews; `--auto` deixa o merge agendado sem confirmação síncrona) e por
 * isso são deliberadamente EXCLUÍDAS do allowlist: só a forma exata `gh pr
 * merge <N> --squash`, nenhuma flag além dela. Uma tentativa de anexar
 * `--admin`/`--auto`/qualquer outra flag cai no default-deny.
 */
const GH_PR_MERGE_SQUASH_RE = /^\s*gh(?:\.exe)?\s+pr\s+merge\s+\d+\s+--squash\s*$/i;

/**
 * #3720 — `gh issue view {N} --json state` (passo 5: "Se a issue seguir
 * OPEN (`gh issue view {numero} --json state`) alguns segundos depois").
 * Também aceita a forma de 3 campos que a validação pós-turno deste módulo
 * usa internamente (`checkIssueTerminalState` →
 * `state,comments,closedByPullRequestsReferences`, ver mais abaixo) caso a
 * coordenadora decida rodar a mesma checagem por conta própria — em
 * qualquer uma das 2 ordens observadas (a ordem literal do código e a ordem
 * como aparece na descrição da issue #3720). Nenhum outro campo (`body`,
 * `title`, etc.) é aceito — read-only estritamente escopado ao que os dois
 * call sites reais precisam.
 */
const GH_ISSUE_VIEW_JSON_RE =
  /^\s*gh(?:\.exe)?\s+issue\s+view\s+\d+\s+--json\s+(?:state|state,comments,closedByPullRequestsReferences|state,closedByPullRequestsReferences,comments)\s*$/i;

/**
 * #3720 — `gh api graphql -f query="..."` pra LER review threads de um PR
 * (passo 4, condição 2 do Gate 2: "via `gh api graphql`, checar que não há
 * review threads não-resolvidas"). O shape é o MESMO literal de
 * `.claude/skills/diaria-overnight/SKILL.md` (linha ~225): query fixa sobre
 * `repository(owner:"vjpixel",name:"diaria-studio"){ pullRequest(number:N){
 * reviewThreads(first:100){ nodes{ id isResolved } pageInfo{ hasNextPage
 * endCursor } } } } }`, com `N` (número do PR) como ÚNICA parte variável —
 * capturado só como dígitos (`\d+`), sem espaço pra metacaractere nenhum.
 * `owner`/`name` são LITERAIS fixos (não parametrizados) — uma query contra
 * qualquer outro repo (`name:"outro-repo"`) não bate no regex e cai no
 * default-deny. A âncora `^...$` cobre toda a string do comando (inclusive
 * as aspas de fechamento do `-f query="..."` e o que vier depois) — um
 * comando que anexe `&&`/`;`/`|`/qualquer coisa após a query válida deixa
 * sobra de texto que o `\s*$` final não consome, então NÃO precisa de um
 * char-class de encadeamento separado (diferente do caso `gh issue comment`,
 * que aceita um `<valor>` livre — aqui a query INTEIRA é fixa, não há
 * "valor livre" nenhum pra um atacante preencher com metacaracteres).
 * Suporta só a forma double-quoted com aspas internas escapadas
 * (`\"vjpixel\"`) — a mesma convenção do SKILL.md linha ~226 (`-f
 * query="$QUERY"` com `$QUERY` sendo um literal single-quoted que, ao ser
 * embutido direto sem variável de shell, precisa escapar as aspas internas
 * pra permanecer 1 argumento válido). A forma single-quoted (`-f
 * query='...'`) NÃO é suportada — limitação deliberada pra manter o regex
 * tratável; se a coordenadora usar essa forma na validação ao vivo, a
 * chamada cai no default-deny (fail-safe) e fica documentada como gap pro
 * coordenador ajustar o prompt, nunca um allow indevido.
 */
const GH_API_GRAPHQL_REVIEW_THREADS_RE = new RegExp(
  String.raw`^\s*gh(?:\.exe)?\s+api\s+graphql\s+-f\s+query="\{\s*repository\(owner:\\"vjpixel\\",name:\\"diaria-studio\\"\)\{\s*pullRequest\(number:(\d+)\)\{\s*reviewThreads\(first:100\)\{\s*nodes\{\s*id\s+isResolved\s*\}\s*pageInfo\{\s*hasNextPage\s+endCursor\s*\}\s*\}\s*\}\s*\}\s*\}"\s*$`,
  "i",
);

/**
 * #3720 — `gh api graphql -f query="mutation { resolveReviewThread(...) }"`
 * pra RESOLVER 1 review thread (passo 4, mesmo Gate 2 — reusa o loop de
 * resolução do `.claude/skills/diaria-overnight/SKILL.md` linha ~244).
 * Mesmo raciocínio de âncora total de `GH_API_GRAPHQL_REVIEW_THREADS_RE`
 * acima (comando inteiro fixo, só `threadId` varia, sem espaço pra
 * metacaractere). `threadId` é um node ID opaco do GitHub GraphQL
 * (base64url-like) — charset restrito a `[A-Za-z0-9_=-]+`, o que já exclui
 * QUALQUER caractere de shell (aspas, `$`, backtick, `;`, `&`, `|`, `<`,
 * `>`, espaço) do valor capturado. Isso é DELIBERADAMENTE só a mutation
 * `resolveReviewThread` com esse shape exato — `mutation { deleteRepo(...)
 * }` ou qualquer outra mutation cai no default-deny; o guard não confia em
 * "começa com `mutation {`" sozinho, precisa bater o corpo inteiro.
 */
const GH_API_GRAPHQL_RESOLVE_THREAD_RE = new RegExp(
  String.raw`^\s*gh(?:\.exe)?\s+api\s+graphql\s+-f\s+query="mutation\s*\{\s*resolveReviewThread\(input:\{threadId:\\"([A-Za-z0-9_=-]+)\\"\}\)\{\s*thread\{\s*id\s+isResolved\s*\}\s*\}\s*\}"\s*$`,
  "i",
);

/**
 * #3720 — decisão pura combinando as 6 formas acima num único predicado,
 * usada por `evaluateWaveTool` como um allow-list independente do guard de
 * `gh issue comment`/`close` (#3791/#3795/#3801) — comandos diferentes,
 * mesmo espírito (âncora de string inteira, sem margem pra metacaractere).
 */
function isAllowedWaveCoordinatorGhCommand(command: string): boolean {
  return (
    GH_PR_CHECKS_WATCH_RE.test(command) ||
    GH_PR_CHECKS_JSON_RE.test(command) ||
    GH_PR_MERGE_SQUASH_RE.test(command) ||
    GH_ISSUE_VIEW_JSON_RE.test(command) ||
    GH_API_GRAPHQL_REVIEW_THREADS_RE.test(command) ||
    GH_API_GRAPHQL_RESOLVE_THREAD_RE.test(command)
  );
}

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
 * `.claude/settings.json` allowlista `Bash(git checkout *)`/`Bash(git push
 * *)` incondicionalmente — o que, ANTES de #3720, significava que `git
 * checkout` era auto-aprovado pelo SDK sem sequer invocar esta função (ver
 * seção "LIMITAÇÃO CONHECIDA — RESOLVIDA EM #3720" no topo do módulo).
 * Desde #3720, `runWaveFire` passa `settingSources: []` — essa
 * pré-aprovação não existe mais NESTA sessão, então este regex agora é
 * EFETIVO pras 4 formas que ele cobre (`checkout`/`pull`/`stash`/`reset`;
 * `git push` nunca esteve no blocklist deste regex — o prompt da
 * coordenadora nunca precisa rodar `git push` diretamente, ela só mergeia
 * via `gh pr merge`, então não há forma correspondente pra bloquear aqui).
 */
const WAVE_WORKTREE_GUARD_RE =
  /\bgit(?:\.exe)?\s+(?:(?!(?:checkout|pull|stash|reset)(?:\s|$))\S+\s+)*(?:checkout|pull|stash|reset)(?:\s|$)/i;

// ─── #3914 — allow-list pra chamadas de tool NESTED (originadas de um sub-
// agente dispatchado via Agent isolation:worktree, não da coordenadora) ────
//
// Achado do #3914: `CanUseTool` do SDK recebe `options.agentID` — "If running
// within the context of a sub-agent, the sub-agent's ID" (`sdk.d.ts`) — ou
// seja, o MESMO `canUseTool` (`makeWaveSafeCanUseTool`) registrado em
// `runWaveFire` governa TAMBÉM as tool calls de qualquer subagente
// dispatchado, não só as da coordenadora. Como `settingSources: []` (#3720)
// já era um flag `--setting-sources=` de PROCESSO INTEIRO (confirmado lendo
// `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`, não algo que se possa
// reconfigurar por chamada `Agent` individual — `AgentDefinition`/`AgentInput`
// não têm campo `settingSources`/`canUseTool` próprios), os subagentes
// dispatchados ficavam presos no MESMO allow-list ultra-estreito desenhado só
// pros 6 comandos `gh` de Gate 2/merge da coordenadora — sem `Read` (nem pra
// ler `context/overnight-dispatch-rules.md`, passo 1 do prompt), sem
// `Write`/`Edit` (o trabalho de implementação em si), sem `npm ci`/`npx tsc`/
// testes, sem `git add`/`commit`/`push`, sem `gh pr create`. Resultado: onda
// travava sem produzir PR nenhum (achado ao vivo do #3914 — 3 worktrees, zero
// `npm ci` rodado).
//
// Fix: quando `agentID` está presente (chamada de um subagente, não da
// coordenadora), `evaluateWaveTool` consulta este allow-list SEPARADO,
// deliberadamente mais permissivo que o da coordenadora mas AINDA sujeito aos
// MESMOS guards INVARIANTES (publicação, palavra de plataforma) — essas duas
// checagens continuam rodando incondicionalmente pra QUALQUER `agentID`,
// coordenadora ou subagente (dispatch-rules.md §1 é explícito: "todo
// subagente implementador", não só a coordenadora). Duas diferenças
// deliberadas do lado subagente:
//
// 1. `Read`/`Write`/`Edit`/`Glob`/`Grep`/`WebFetch`/`WebSearch` — allow
//    incondicional. Edit/Write já são contidos pelo PRÓPRIO harness
//    (`isolation: "worktree"` restringe onde o subagente pode escrever, ver
//    doc-comment do módulo) — permitir aqui não abre blast radius NOVO além
//    do que a isolação de worktree já garante estruturalmente; sem isso o
//    subagente não tem como fazer NADA (nem ler um arquivo).
// 2. O guard de working-tree (`WAVE_WORKTREE_GUARD_RE`, checkout/pull/stash/
//    reset) NÃO se aplica a chamadas de subagente — a razão de existir desse
//    guard é proteger o cwd COMPARTILHADO da coordenadora (`rootDir`, onde
//    `npm run studio` roda), que pode estar em uso ativo numa sessão manual
//    do editor. O cwd de um subagente dispatchado com `isolation: "worktree"`
//    é o SEU PRÓPRIO worktree isolado — `git checkout -b <branch>`/`git
//    reset`/etc dentro dele é trabalho normal de implementação, não risco de
//    colisão com o editor.
//
// O que este fix NÃO tenta resolver: dar ao subagente o MESMO nível de
// confiança que uma sessão overnight/develop normal (terminal interativo,
// `.claude/settings.json` completo) teria — deliberadamente mais estreito
// (sem `gh pr merge`, sem `gh api graphql`, sem MCP tools) porque (a) merge é
// EXPLICITAMENTE responsabilidade só da coordenadora (prompt: "nunca faça
// merge você mesma"), permitir merge aqui reabriria esse invariante por outro
// caminho; (b) o restante não é citado como necessário por
// `context/overnight-dispatch-rules.md`/`buildWaveFireCoordinatorPrompt`. Se
// a validação ao vivo (Parte B, fora do escopo desta PR — #207 bloqueia
// recursão de Agent, não dá pra testar isto por dentro deste worktree)
// encontrar mais um comando bloqueado que um subagente implementador precisa
// de verdade, adicionar aqui é a mesma receita: um padrão explícito, nunca
// reabrir settingSources.

/** Bootstrap (`npm ci`) + typecheck (`npx tsc --noEmit`) + testes escopados
 * (`npx tsx --test ...`) — os 3 passos que `context/overnight-dispatch-rules.md`
 * §3/§4 exigem de todo subagente implementador antes de abrir PR. */
const WAVE_SUBAGENT_NPM_RE = /^\s*npm(?:\.cmd)?\s+(?:ci|install|run\s+\S+)\b/i;
const WAVE_SUBAGENT_TSC_RE = /^\s*npx(?:\.cmd)?\s+tsc\b/i;
const WAVE_SUBAGENT_TEST_RE = /^\s*npx(?:\.cmd)?\s+tsx\s+--test\b/i;

/** Mesmo padrão que `.claude/settings.json` já concede a QUALQUER sessão
 * interativa normal (`Bash(npx tsx scripts/*.ts)`) — ainda sujeito aos guards
 * INVARIANTES de publicação checados ANTES deste allow-list (`scripts/publish-*`,
 * `clarice-schedule-*`, `clarice-import-*`, `close-poll.ts` continuam negados
 * mesmo batendo este regex, porque são checados primeiro na função). */
const WAVE_SUBAGENT_SCRIPT_RE = /^\s*npx(?:\.cmd)?\s+tsx\s+scripts[\\/]/i;

/** Workflow git normal de implementação dentro do PRÓPRIO worktree isolado —
 * substitui o guard de working-tree (que só faz sentido pro cwd COMPARTILHADO
 * da coordenadora, ver doc-comment da seção acima). Inclui `checkout`/`pull`/
 * `stash`/`reset` (criar branch / sincronizar / desfazer commit local)
 * porque, ao contrário da coordenadora, o subagente MEXE no próprio checkout
 * o tempo todo — é o trabalho. Não inclui `clean`/`gc`/`filter-branch` (não
 * citados como necessários pelo protocolo, escopo deliberadamente contido ao que
 * `git status`/`add`/`commit`/`push`/`checkout -b` cobrem). */
const WAVE_SUBAGENT_GIT_RE =
  /^\s*git(?:\.exe)?\s+(?:status|diff|log|show|add|commit|push|pull|checkout|fetch|branch|rev-parse|remote|stash|reset)\b/i;

/** `gh pr create`/`view`/`diff`/`list` — deliberadamente SEM `merge` (só a
 * coordenadora mergeia, ver doc-comment da seção acima) e SEM `checks` (Gate 2
 * é responsabilidade da coordenadora, não do subagente individual). */
const WAVE_SUBAGENT_GH_PR_RE = /^\s*gh(?:\.exe)?\s+pr\s+(?:create|view|diff|list)\b/i;

/** Campos seguros pra `gh issue view --json` de um subagente — mais amplo que
 * o allow-list estreito da coordenadora (`GH_ISSUE_VIEW_JSON_RE`, só
 * `state`/`comments`/`closedByPullRequestsReferences`) porque um subagente
 * implementador PRECISA do título/corpo/labels da própria issue pra entender
 * a tarefa (o gap literal reportado no #3914: `gh issue view 3901 --json
 * number,title,body,labels,comments` foi negado). `--jq`/campos fora deste
 * set continuam negados (função abaixo exige TODOS os campos pedidos
 * estarem no set, e a forma inteira do comando bater no template fixo). */
const WAVE_SUBAGENT_GH_ISSUE_VIEW_FIELDS = new Set([
  "number",
  "title",
  "body",
  "labels",
  "comments",
  "assignees",
  "state",
  "url",
  "milestone",
  "createdAt",
  "updatedAt",
  "closedByPullRequestsReferences",
]);
const WAVE_SUBAGENT_GH_ISSUE_VIEW_RE = /^\s*gh(?:\.exe)?\s+issue\s+view\s+\d+\s+--json\s+([\w,]+)\s*$/i;

function isAllowedWaveSubagentGhIssueView(command: string): boolean {
  const match = WAVE_SUBAGENT_GH_ISSUE_VIEW_RE.exec(command);
  if (!match) return false;
  const fields = match[1].split(",");
  return fields.length > 0 && fields.every((f) => WAVE_SUBAGENT_GH_ISSUE_VIEW_FIELDS.has(f));
}

/**
 * Denylist EXTRA, só pro lado subagente (defesa em profundidade além dos
 * guards invariantes de publicação): `rm -rf`/variações de flag (`-fr`, etc)
 * e `git push --force`/`-f` — mesmo espírito do `"deny": ["Bash(rm -rf *)"]`
 * já presente em `.claude/settings.json` pra qualquer sessão normal. Nenhum
 * passo do protocolo de dispatch pede isso; um subagente que tentar é sinal
 * de comportamento fora do esperado, não um caso de uso legítimo a acomodar.
 */
const WAVE_SUBAGENT_DANGEROUS_RE =
  /\brm\b[^\n]*\s-[a-zA-Z]*(?:r[a-zA-Z]*f|f[a-zA-Z]*r)[a-zA-Z]*\b|\bgit\s+push\b[^\n]*(?:--force\b|(?<!\S)-f\b)/i;

function isAllowedWaveSubagentDevCommand(command: string): boolean {
  return (
    WAVE_SUBAGENT_NPM_RE.test(command) ||
    WAVE_SUBAGENT_TSC_RE.test(command) ||
    WAVE_SUBAGENT_TEST_RE.test(command) ||
    WAVE_SUBAGENT_SCRIPT_RE.test(command) ||
    WAVE_SUBAGENT_GIT_RE.test(command) ||
    WAVE_SUBAGENT_GH_PR_RE.test(command) ||
    isAllowedWaveSubagentGhIssueView(command)
  );
}

export interface WaveToolDecision {
  allow: boolean;
  reason?: string;
}

/**
 * Decisão pura pra 1 tool call da sessão coordenadora — separada de
 * `makeWaveSafeCanUseTool` (que é só o wrapper async exigido pelo shape
 * `CanUseTool` do SDK) pra ser testável sem mockar o SDK. Desde #3720
 * (`settingSources: []` em `runWaveFire`), esta função é a ÚNICA fonte de
 * allow/deny pra sessão coordenadora — `.claude/settings.json` não é mais
 * consultado aqui, então não há allow-list externo pra cair de volta em
 * nenhum caso. Camadas, em ordem:
 *
 * (-1) `toolName === "Agent"` — allow SE E SOMENTE SE `input.isolation ===
 * "worktree"` (#3720, fecha o gap (c) da seção "LIMITAÇÃO CONHECIDA" no topo
 * do módulo: antes de #3720, `.claude/settings.json` allowlistava `"Agent"`
 * incondicionalmente, então um dispatch SEM isolamento também passava
 * batido). Checado ANTES do bloco `Bash` porque `Agent` não é `Bash` — sem
 * este ramo, a coordenadora não conseguiria dispatchar unidade NENHUMA da
 * onda, quebrando a função central do módulo.
 *
 * (0) `isAllowedWaveCoordinatorGhCommand` — calculado logo no início do
 * ramo `Bash`, ANTES de qualquer outra checagem: as 6 formas exatas de `gh
 * pr checks`/`gh pr merge`/`gh api graphql`/`gh issue view` que o Gate 2 +
 * merge serial + espera de CI da coordenadora precisam (#3720, ver
 * doc-comment de cada constante `GH_PR_CHECKS_*`/`GH_PR_MERGE_SQUASH_RE`/
 * `GH_API_GRAPHQL_*`/`GH_ISSUE_VIEW_JSON_RE` acima). Todas são âncoras de
 * string INTEIRA contra um template fixo — não podem colidir com nenhum dos
 * blocklists abaixo (não mencionam plataforma, não tocam working-tree, não
 * executam publisher), então checar antes ou depois dos blocklists dá o
 * mesmo resultado; checar ANTES só evita trabalho redundante.
 *
 * (1) `isGhIssueTextOnly` — calculado antes de qualquer blocklist de texto:
 * `gh issue comment`/`gh issue close` (#3791) sem nenhum metacaractere de
 * encadeamento de shell (`GH_ISSUE_SHELL_CHAIN_RE`, estendido em #3795 pra
 * cobrir `<`/`>`) E cuja forma inteira bate com o allowlist de flags
 * `GH_ISSUE_ALLOWED_SHAPE_RE` (#3801 — só `--body`/`--comment`/`-b`/`-c`,
 * nunca `--body-file`/`-F`/`--comment-file`, que leem arquivo local em vez de
 * receber argumento literal) é garantidamente text-only — o resto da string
 * só pode ser argumento literal de `--body`/`--comment`, nunca comando
 * adicional interpretado pelo shell nem leitura de arquivo; (2) blocklist de
 * working-tree (#3728 Gap 1, #3738
 * Gaps 1+3), INVARIANTE pra qualquer comando que NÃO seja `isGhIssueTextOnly`;
 * (3) blocklist de EXECUÇÃO de publisher, INVARIANTE pra qualquer comando que
 * NÃO seja `isGhIssueTextOnly` (#3795 Bug 2 — a isenção de #3791, que
 * originalmente só cobria a camada de palavra-solta (5), foi estendida pras
 * camadas (2) e (3) também: menção textual a `git checkout`/`scripts/publish-*`
 * dentro de um comentário de diagnóstico legítimo não é execução de nada,
 * mesmo raciocínio que já isentava (5)); (4) se `isGhIssueTextOnly`, ALLOW
 * explícito aqui — necessário pro marcador de diagnóstico (#3782) e fallback
 * de fechamento (#3781) da coordenadora; (5) checagem de palavra-solta de
 * plataforma pra qualquer outro `Bash` que NÃO seja `isGhIssueTextOnly`,
 * INVARIANTE; (6) fora disso, nega por padrão (mesmo espírito conservador
 * do chat drawer, `studio-chat.ts` `denyToolResult`) — esta sessão roda sem
 * supervisão humana, então "permitir por padrão" é o erro mais caro
 * possível aqui.
 *
 * #3914 — `agentID` (3º parâmetro, opcional): quando presente, a chamada
 * originou de um SUBAGENTE dispatchado (não da coordenadora — ver
 * `options.agentID` do `CanUseTool` do SDK, "If running within the context
 * of a sub-agent, the sub-agent's ID"). Nesse caso, ANTES do fallback
 * conservador (6) acima, um segundo allow-list mais permissivo é consultado
 * (`Read`/`Write`/`Edit`/`Glob`/`Grep`/`WebFetch`/`WebSearch` sempre allow;
 * `isAllowedWaveSubagentDevCommand` pro workflow normal de implementação —
 * bootstrap/typecheck/teste/git/gh pr/gh issue view de campos amplos) — e o
 * guard de working-tree (2) NÃO se aplica (cwd do subagente é o PRÓPRIO
 * worktree isolado, não o cwd compartilhado da coordenadora). Os guards
 * INVARIANTES de publicação (3) e o denylist extra de comandos destrutivos
 * (`WAVE_SUBAGENT_DANGEROUS_RE`) continuam valendo incondicionalmente pra
 * `agentID` também — ver doc-comment da seção "#3914" acima das constantes
 * `WAVE_SUBAGENT_*` pro raciocínio completo.
 */
export function evaluateWaveTool(
  toolName: string,
  input: Record<string, unknown>,
  agentID?: string,
): WaveToolDecision {
  const isSubagentCall = agentID !== undefined;
  if (
    isSubagentCall &&
    (toolName === "Read" ||
      toolName === "Write" ||
      toolName === "Edit" ||
      toolName === "Glob" ||
      toolName === "Grep" ||
      toolName === "WebFetch" ||
      toolName === "WebSearch")
  ) {
    return {
      allow: true,
      reason:
        `#3914: "${toolName}" chamado por um subagente dispatchado (agentID presente) — allow incondicional. ` +
        "Edit/Write já são contidos pelo próprio harness (isolation: worktree restringe onde o subagente escreve), " +
        "então permitir aqui não abre blast radius novo; sem isso o subagente não tem como fazer nada (nem ler " +
        "context/overnight-dispatch-rules.md, passo 1 do prompt de dispatch).",
    };
  }
  if (toolName === "Agent") {
    if (input.isolation === "worktree") {
      return {
        allow: true,
        reason:
          "Agent com isolation: worktree (#3720): dispatch de unidade da onda em worktree isolado, o mecanismo " +
          "central do módulo — allow explícito passou a ser necessário porque settingSources: [] remove a " +
          "pré-aprovação incondicional que .claude/settings.json dava a 'Agent' (ver LIMITAÇÃO CONHECIDA, gap c).",
      };
    }
    return {
      allow: false,
      reason:
        "Agent SEM isolation: worktree (INVARIANTE, #3720): escreveria no mesmo cwd da sessão coordenadora — a " +
        "pasta principal, potencialmente em uso ativo numa sessão manual do editor em paralelo (incidente real: " +
        "colisão de working tree, 260716). Toda unidade da onda precisa rodar isolada.",
    };
  }
  if (toolName === "Bash" && typeof input.command === "string") {
    const command = input.command;
    // #3720: as 6 formas exatas de gh pr checks/merge/api graphql/issue view
    // que o Gate 2 + espera de CI + merge serial da coordenadora precisam —
    // ver doc-comment de `isAllowedWaveCoordinatorGhCommand` e das
    // constantes que ela combina. Checado antes de qualquer blocklist
    // (nenhuma dessas 6 formas pode colidir com eles, ver doc-comment da
    // função acima). #3914: gated por `!isSubagentCall` — `gh pr merge`/`gh
    // api graphql` (resolveReviewThread) fazem parte deste combo, e o
    // protocolo exige que SÓ a coordenadora mergeie ("nunca faça merge você
    // mesma"); permitir isso pra um subagente reabriria esse invariante por
    // outro caminho.
    if (!isSubagentCall && isAllowedWaveCoordinatorGhCommand(command)) {
      return {
        allow: true,
        reason:
          "comando gh de Gate 2/espera de CI/merge serial (#3720): forma exata reconhecida " +
          "(gh pr checks/gh pr merge/gh api graphql sobre review threads ou resolveReviewThread/gh issue view) — " +
          "necessário pro protocolo de dispatch + merge da coordenadora funcionar sem .claude/settings.json.",
      };
    }
    // #3795 Bug 2: calculado ANTES das 3 camadas de blocklist (working-tree,
    // script-exec, palavra-solta) — `gh issue comment`/`gh issue close` sem
    // NENHUM metacaractere de encadeamento de shell (`GH_ISSUE_SHELL_CHAIN_RE`)
    // é garantidamente text-only: o resto da string não pode ser interpretado
    // como comando adicional pelo shell, só como argumento literal de
    // `--body`/`--comment`. Isso vale igualmente pras 3 camadas, não só pra
    // palavra-solta (#3791 original isentava só essa última) — menção textual
    // a `git checkout`/`scripts/publish-*`/`beehiiv` dentro de um comentário
    // de diagnóstico legítimo não é execução de nada. Um comando que de fato
    // ENCADEIA outro comando (`&&`, `;`, `|`, backtick, `$(`, `<`/`>`) falha
    // esta checagem e cai no guard normal (default-deny se nenhum outro
    // caminho de allow existir).
    //
    // #3801: NENHUMA das duas checagens acima olha pra quais FLAGS do `gh`
    // seguem o subcomando — `--body-file`/`-F`/`--comment-file` são flags
    // nativas que LEEM UM ARQUIVO LOCAL e o publicam como corpo do
    // comentário, sem shell nenhum envolvido (não têm os metacaracteres de
    // `GH_ISSUE_SHELL_CHAIN_RE`). `GH_ISSUE_ALLOWED_SHAPE_RE` fecha essa
    // brecha exigindo que o comando INTEIRO seja exatamente `gh issue
    // comment|close <id> [(--body|--comment|-b|-c)(=| )<valor>]` — qualquer
    // flag de leitura de arquivo (ou qualquer flag fora do allowlist) deixa
    // sobra de texto que a âncora `$` não consome, reprovando a checagem.
    const isGhIssueTextOnly =
      GH_ISSUE_TEXT_ONLY_RE.test(command) &&
      !GH_ISSUE_SHELL_CHAIN_RE.test(command) &&
      GH_ISSUE_ALLOWED_SHAPE_RE.test(command);
    // #3914: guard de working-tree só se aplica à COORDENADORA — o cwd de um
    // subagente dispatchado é o seu PRÓPRIO worktree isolado (não o cwd
    // compartilhado da coordenadora que este guard protege), então
    // checkout/pull/stash/reset dentro dele é workflow normal de
    // implementação, não risco de colisão com o editor.
    if (!isSubagentCall && !isGhIssueTextOnly && WAVE_WORKTREE_GUARD_RE.test(command)) {
      return {
        allow: false,
        reason:
          "guard de working-tree (INVARIANTE, defesa em profundidade): esta sessão coordenadora nunca roda " +
          "git checkout/git pull/git stash/git reset na pasta principal — ela pode estar em uso ativo numa sessão manual " +
          "do editor em paralelo (incidente real: colisão de working tree, 260716). Toda mutação de arquivo " +
          "acontece só dentro dos worktrees isolados dispatchados via Agent.",
      };
    }
    if (!isGhIssueTextOnly && WAVE_PUBLISH_SCRIPT_EXEC_RE.test(command)) {
      return {
        allow: false,
        reason:
          "guard de publicação (INVARIANTE): esta sessão nunca dispara scripts/publish-*, clarice-schedule-*, " +
          "clarice-import-*, close-poll ou qualquer script Beehiiv/LinkedIn/Facebook/Brevo, mesmo em onda automática.",
      };
    }
    if (!isGhIssueTextOnly && WAVE_PUBLISH_PLATFORM_WORD_RE.test(command)) {
      return {
        allow: false,
        reason:
          "guard de publicação (INVARIANTE): esta sessão nunca dispara scripts/publish-*, clarice-schedule-*, " +
          "clarice-import-*, close-poll ou qualquer script Beehiiv/LinkedIn/Facebook/Brevo, mesmo em onda automática.",
      };
    }
    // #3914: denylist EXTRA só pro lado subagente — INVARIANTE, checado
    // depois dos guards de publicação (que já cobrem qualquer agentID) mas
    // antes de qualquer allow de subagente, incluindo o de gh issue
    // comment/close (um `rm -rf`/`git push --force` encadeado a um `gh issue
    // comment` válido ainda deve cair aqui, não no allow de texto).
    if (isSubagentCall && WAVE_SUBAGENT_DANGEROUS_RE.test(command)) {
      return {
        allow: false,
        reason:
          "denylist extra de subagente (#3914, defesa em profundidade): rm -rf/variações de flag e git push " +
          "--force/-f nunca são necessários pelo protocolo de dispatch — mesmo espírito do " +
          "\"deny\": [\"Bash(rm -rf *)\"] já presente em .claude/settings.json pra qualquer sessão normal.",
      };
    }
    if (isGhIssueTextOnly) {
      return {
        allow: true,
        reason:
          "gh issue comment/close (#3791, isenção estendida em #3795): subcomando text-only, nunca executa nada — " +
          "necessário pro marcador de diagnóstico (#3782) e pro fallback de fechamento manual (#3781) da " +
          "coordenadora. Isento das 3 camadas de blocklist (working-tree, script-exec, palavra-solta de " +
          "publicação): menção textual a um comando/plataforma bloqueada dentro de um comentário de diagnóstico " +
          "legítimo não é execução de nada.",
      };
    }
    // #3914 — workflow normal de implementação de um subagente dispatchado:
    // bootstrap/typecheck/teste, npx tsx scripts/*.ts (ainda sujeito aos
    // guards de publicação acima), git add/commit/push/checkout/etc no
    // PRÓPRIO worktree, gh pr create/view/diff/list (nunca merge — ver
    // doc-comment da seção "#3914" acima das constantes WAVE_SUBAGENT_*), gh
    // issue view com campos amplos (title/body/labels — o gap literal
    // reportado no #3914).
    if (isSubagentCall && isAllowedWaveSubagentDevCommand(command)) {
      return {
        allow: true,
        reason:
          "#3914: comando de workflow normal de implementação reconhecido pro allow-list de subagente (npm/npx " +
          "tsc/tsx --test/tsx scripts, git status/diff/log/add/commit/push/checkout/fetch/branch/rev-parse/remote/" +
          "stash/reset, gh pr create/view/diff/list, gh issue view com campos amplos) — necessário pro subagente " +
          "conseguir de fato implementar e abrir PR dentro do seu worktree isolado.",
      };
    }
  }
  return {
    allow: false,
    reason: isSubagentCall
      ? `"${toolName}" exigiria confirmação interativa que este subagente headless não tem como dar — ` +
        `com settingSources: [] (#3720/#3914), .claude/settings.json não é consultado nesta sessão (nem pros ` +
        `subagentes dispatchados), então só as formas explicitamente resolvidas aqui (Read/Write/Edit/Glob/Grep/` +
        `WebFetch/WebSearch, o workflow de dev listado em isAllowedWaveSubagentDevCommand, e gh issue comment/close) ` +
        `rodam automaticamente (#3914, escopo deliberadamente conservador — sem merge, sem gh api graphql).`
      : `"${toolName}" exigiria confirmação interativa que esta sessão headless não tem como dar — ` +
        `com settingSources: [] (#3720), .claude/settings.json não é consultado nesta sessão, então só as formas ` +
        `explicitamente resolvidas aqui (Agent com isolation:worktree, gh issue comment/close, e o punhado de ` +
        `comandos gh de Gate 2/espera de CI/merge listados acima) rodam automaticamente (#3702/#3720, escopo ` +
        `deliberadamente conservador).`,
  };
}

function makeWaveSafeCanUseTool(): CanUseTool {
  return async (toolName, input, options) => {
    // #3914 — `options.agentID` distingue chamada da coordenadora (undefined)
    // de chamada de um subagente dispatchado (presente) — ver doc-comment de
    // `evaluateWaveTool` pro allow-list separado que isso habilita.
    const decision = evaluateWaveTool(toolName, input, options.agentID);
    if (decision.allow) return { behavior: "allow", updatedInput: input };
    return { behavior: "deny", message: decision.reason ?? "negado" } as PermissionResult;
  };
}

// ─── validação pós-turno de estado terminal (#3765) ────────────────────────

/**
 * #3765 — o guard do #3753 (`disallowedTools: ["ScheduleWakeup", "CronCreate"]`
 * acima) só bloqueia essas 2 tool calls nomeadas. Mas a causa-raiz documentada
 * no topo do módulo é mais ampla: quando o `for await` de `runWaveFire`
 * termina — por QUALQUER razão, inclusive a coordenadora simplesmente
 * escrevendo um resumo em texto puro sem chamar nenhuma tool ("vou aguardar o
 * CI e retomar depois") — a stream SSE fecha e `handleApiWavesFire` trata
 * isso como sucesso incondicional. Nada nesse fluxo confirma que a onda de
 * fato avançou. `disallowedTools` não cobre "decidir não chamar tool
 * nenhuma" — só chamadas específicas.
 *
 * Este bloco valida, DEPOIS que o turno termina sem lançar, que cada
 * `issueNumber` da onda chegou a um estado que só é alcançável por trabalho
 * real: (a) a issue foi FECHADA (efeito colateral de um PR mergeado com
 * `Closes #N`), ou (b) a issue segue aberta mas tem um comentário criado
 * DEPOIS do início deste turno (`sinceIso`) — o padrão já usado no fluxo
 * overnight normal pra documentar falha/bloqueio sem fechar a issue. Um
 * comentário anterior ao início do turno não conta (evita falso-positivo:
 * uma issue com histórico de comentários antigos não vira "terminal" só por
 * já ter discussão prévia à onda).
 *
 * Verificação via `gh issue view --json state,comments,closedByPullRequestsReferences`
 * — determinístico, mesmo espírito de "validar afirmações de subagent sobre
 * estado externo via TS determinístico" do CLAUDE.md (#573): nunca confiar só
 * no resumo em texto que a coordenadora produziu.
 *
 * #3772 — dois gaps do fix original (#3765) corrigidos aqui: (1) `state ===
 * "CLOSED"` sozinho NÃO é mais prova incondicional de PR mergeado — só conta
 * se `closedByPullRequestsReferences` também vier não-vazio (um `gh issue
 * close N` direto, sem PR, produz CLOSED com essa lista vazia e agora é
 * tratado como NÃO-terminal); (2) [SUBSTITUÍDO no #3782 — ver abaixo]
 * comentário pós-dispatch originalmente só contava como diagnóstico se o
 * `author.login` batesse com a conta autenticada da própria automação.
 *
 * #3782 — o filtro por `author.login` do #3772 Bug 2 não distinguia nada na
 * prática: este repo é de operador único, então a coordenadora, um editor
 * humano comentando manualmente, e qualquer sessão overnight/develop
 * paralela autenticam TODAS com a mesma conta `gh` (`vjpixel`) —
 * `author.login === botLogin` era verdadeiro nos 3 casos. Substituído por um
 * marcador literal (`WAVE_DIAGNOSTIC_COMMENT_PREFIX`) que só a própria
 * coordenadora escreve no início do `body` de um comentário de diagnóstico
 * (`buildWaveFireCoordinatorPrompt` passo 2) — sinal que de fato distingue
 * intenção, já que autoria de conta não distingue neste repo.
 */
export interface IssueTerminalCheck {
  issueNumber: number;
  terminal: boolean;
  reason: string;
}

export type GhIssueRunResult = GhSpawnResult;

/** Mesmo shape de `GhRunFn` (`studio-issues.ts`) — não importado direto pra
 * manter este módulo sem dependência cruzada, mas o contrato é idêntico
 * (injeção de teste sem spawnar `gh` de verdade). */
export type GhIssueRunFn = (args: string[], cwd: string) => GhIssueRunResult;

function defaultGhIssueRun(args: string[], cwd: string): GhIssueRunResult {
  return spawnGhSync(args, cwd);
}

interface GhIssueSummaryRaw {
  number?: number;
  title?: string;
  body?: string;
  labels?: Array<{ name?: string }>;
  url?: string;
}

/**
 * #3914 — busca título/corpo/labels/url de cada issue da onda ANTES da
 * sessão coordenadora iniciar (fora da sessão SDK, `gh issue view` direto —
 * nunca sujeito a `evaluateWaveTool`). Alimenta `buildWaveFireCoordinatorPrompt`
 * (`opts.issues`), que embute esse conteúdo no prompt de dispatch em vez de
 * instruir cada subagente a descobrir sozinho via `gh issue view` — mitigação
 * complementar ao fix de permissão em `evaluateWaveTool` (reduz a
 * DEPENDÊNCIA no allow-list novo, não substitui: se o fetch falhar pra uma
 * issue específica, o subagente ainda cai de volta pro `gh issue view`
 * permitido desde #3914).
 *
 * Fail-soft POR ISSUE (mesmo espírito de `checkIssueTerminalState`): uma
 * falha de `gh` (rate limit, issue deletada, rede) pra UMA issue não deve
 * derrubar o fetch das outras nem a onda inteira — a issue que falhou
 * simplesmente não aparece no bloco "Detalhes das issues" do prompt.
 */
export function fetchWaveIssueSummaries(
  issueNumbers: number[],
  cwd: string,
  run: GhIssueRunFn = defaultGhIssueRun,
): WaveIssueSummary[] {
  return issueNumbers.map((n): WaveIssueSummary => {
    const result = run(["issue", "view", String(n), "--json", "number,title,body,labels,url"], cwd);
    if (result.status !== 0) return { number: n };
    try {
      const parsed = JSON.parse(result.stdout) as GhIssueSummaryRaw;
      return {
        number: n,
        title: typeof parsed.title === "string" ? parsed.title : undefined,
        body: typeof parsed.body === "string" ? parsed.body : undefined,
        labels: Array.isArray(parsed.labels)
          ? parsed.labels.map((l) => l?.name).filter((x): x is string => typeof x === "string")
          : undefined,
        url: typeof parsed.url === "string" ? parsed.url : undefined,
      };
    } catch {
      return { number: n };
    }
  });
}

interface GhIssueViewRaw {
  state?: string;
  /** #3772 Bug 1 — precisa vir junto do `state` pra distinguir "fechada via PR
   * mergeado" (efeito real de `Closes #N`) de "fechada manualmente" (ex: a
   * coordenadora rodou `gh issue close N` direto — não bloqueado por
   * `evaluateWaveTool`, já que o comando não bate em nenhum dos dois
   * blocklists de `Bash`). Vazio/ausente = não foi um PR que fechou a issue. */
  closedByPullRequestsReferences?: Array<{ number?: number }>;
  /** #3782 — `gh issue view --json comments` já traz `body` de graça pra cada
   * comentário (não é um field top-level extra), então checar o prefixo do
   * marcador não custa uma chamada a mais. `author.login` continua
   * declarado/lido mas NÃO é mais usado pra decidir terminalidade (#3782 —
   * ver doc-comment acima). */
  comments?: Array<{ createdAt?: string; body?: string; author?: { login?: string } }>;
}

/**
 * Decisão pura pra 1 issue — separada da chamada de `gh` pra ser testável
 * sem mockar spawn. `raw === null` cobre tanto "gh falhou" (status != 0,
 * binário ausente, etc.) quanto "resposta não é o JSON esperado" — em ambos
 * os casos, tratamos como NÃO-terminal (conservador: falha em CONFIRMAR
 * sucesso nunca deve virar sucesso silencioso, mesmo espírito do resto deste
 * módulo).
 */
export function evaluateIssueTerminalState(
  issueNumber: number,
  raw: GhIssueViewRaw | null,
  sinceIso: string,
): IssueTerminalCheck {
  if (raw === null || typeof raw.state !== "string") {
    return {
      issueNumber,
      terminal: false,
      reason: `gh issue view #${issueNumber} falhou ou retornou formato inesperado — não foi possível confirmar estado terminal`,
    };
  }
  const isClosed = raw.state.toUpperCase() === "CLOSED";
  const closedByMergedPr =
    Array.isArray(raw.closedByPullRequestsReferences) && raw.closedByPullRequestsReferences.length > 0;
  if (isClosed && closedByMergedPr) {
    return {
      issueNumber,
      terminal: true,
      reason: "issue fechada com PR vinculado (closedByPullRequestsReferences não-vazio) — efeito de PR mergeado com Closes",
    };
  }
  const since = Date.parse(sinceIso);
  const comments = Array.isArray(raw.comments) ? raw.comments : [];
  const hasPostDispatchDiagnosticComment = comments.some((c) => {
    const t = typeof c?.createdAt === "string" ? Date.parse(c.createdAt) : NaN;
    const body = typeof c?.body === "string" ? c.body : "";
    return Number.isFinite(t) && Number.isFinite(since) && t >= since && body.startsWith(WAVE_DIAGNOSTIC_COMMENT_PREFIX);
  });
  if (hasPostDispatchDiagnosticComment) {
    return {
      issueNumber,
      terminal: true,
      reason: `issue aberta mas com comentário de diagnóstico pós-dispatch da própria automação (marcador "${WAVE_DIAGNOSTIC_COMMENT_PREFIX}", #3782)`,
    };
  }
  if (isClosed) {
    // #3772 Bug 1 — fechada mas SEM PR vinculado: não confiar cegamente em
    // `state === CLOSED` como prova de trabalho real. Um `gh issue close N`
    // direto (abandono silencioso) produz exatamente este shape.
    return {
      issueNumber,
      terminal: false,
      reason:
        "issue fechada mas SEM PR vinculado (closedByPullRequestsReferences vazio) e sem comentário de diagnóstico " +
        "pós-dispatch da automação documentando a causa — fechamento manual (ex: gh issue close) não é prova de trabalho real (#3772)",
    };
  }
  return {
    issueNumber,
    terminal: false,
    reason:
      `issue segue aberta, sem comentário de diagnóstico pós-dispatch (marcador "${WAVE_DIAGNOSTIC_COMMENT_PREFIX}") da ` +
      "automação — a coordenadora pode ter desistido silenciosamente (turno terminou sem tool calls / sem PR em " +
      "estado terminal, #3765)",
  };
}

/** I/O — 1 issue via `gh issue view`. */
export function checkIssueTerminalState(
  issueNumber: number,
  cwd: string,
  sinceIso: string,
  run: GhIssueRunFn = defaultGhIssueRun,
): IssueTerminalCheck {
  const result = run(
    ["issue", "view", String(issueNumber), "--json", "state,comments,closedByPullRequestsReferences"],
    cwd,
  );
  if (result.status !== 0) {
    return evaluateIssueTerminalState(issueNumber, null, sinceIso);
  }
  try {
    const parsed = JSON.parse(result.stdout) as GhIssueViewRaw;
    return evaluateIssueTerminalState(issueNumber, parsed, sinceIso);
  } catch {
    return evaluateIssueTerminalState(issueNumber, null, sinceIso);
  }
}

/**
 * Checa TODAS as issues da onda. Default real usado por `runWaveFire`;
 * testes injetam `checkTerminalStateFn` (ver `RunWaveFireOptions`) com um
 * `GhIssueRunFn` fake, sem spawnar `gh` de verdade — mesmo padrão de
 * `queryFn`/`ghRun` já usado no resto do módulo/`studio-issues.ts`. Desde o
 * #3782 não resolve mais `botLogin` (removido — ver doc-comment de
 * `evaluateIssueTerminalState`), então não precisa mais de uma chamada
 * `gh api user` extra por onda.
 */
export function checkAllIssuesTerminalState(
  issueNumbers: number[],
  cwd: string,
  sinceIso: string,
  run: GhIssueRunFn = defaultGhIssueRun,
): IssueTerminalCheck[] {
  return issueNumbers.map((n) => checkIssueTerminalState(n, cwd, sinceIso, run));
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
  /** #3765 — injetável pra testes: checa estado terminal de cada issue da
   * onda sem spawnar `gh` de verdade. Produção usa o default real
   * (`checkAllIssuesTerminalState`, que roda `gh issue view` de fato). */
  checkTerminalStateFn?: (issueNumbers: number[], cwd: string, sinceIso: string) => IssueTerminalCheck[];
  /** #3914 — injetável pra testes: busca título/corpo/labels de cada issue
   * da onda ANTES do prompt ser montado, sem spawnar `gh` de verdade.
   * Produção usa o default real (`fetchWaveIssueSummaries`). */
  fetchIssueSummariesFn?: (issueNumbers: number[], cwd: string) => WaveIssueSummary[];
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
  // #3914 — fetch fail-soft: se `gh` falhar (rede, rate limit) o fetch INTEIRO
  // não deve abortar a onda — só significa que o prompt sai sem os corpos
  // embutidos, e os subagentes dispatchados caem de volta pro `gh issue view`
  // (permitido desde #3914, ver `evaluateWaveTool`). `fetchWaveIssueSummaries`
  // já é fail-soft POR ISSUE; este try/catch cobre uma falha mais ampla (ex:
  // `gh` não instalado — spawnSync lançando em vez de retornar status != 0).
  let issues: WaveIssueSummary[] | undefined;
  try {
    const fetchIssueSummaries = opts.fetchIssueSummariesFn ?? fetchWaveIssueSummaries;
    issues = fetchIssueSummaries(opts.issueNumbers, opts.cwd);
  } catch {
    issues = undefined;
  }
  const prompt = buildWaveFireCoordinatorPrompt(opts.issueNumbers, { maxConcurrency: opts.maxConcurrency, issues });
  // #3765 — cutoff pra "comentário pós-dispatch": capturado ANTES do turno
  // começar, pra um comentário já existente na issue (de uma rodada
  // anterior) nunca ser mal-interpretado como diagnóstico DESTE turno.
  const startedAt = new Date().toISOString();

  try {
    const stream = runQuery({
      prompt,
      options: {
        cwd: opts.cwd,
        // #3720 — "SDK isolation mode": `[]` desliga COMPLETAMENTE a
        // resolução de `user`/`project`/`local` settings.json pra esta
        // sessão específica (`.claude/settings.json` do repo, que outras
        // sessões continuam usando sem mudança nenhuma, deixa de existir do
        // ponto de vista do SDK aqui). Fecha os bypasses documentados na
        // seção "LIMITAÇÃO CONHECIDA — RESOLVIDA EM #3720" do doc-comment do
        // módulo (git checkout/push, npx tsx scripts/*.ts, Agent sem
        // isolation, todos pré-aprovados incondicionalmente antes desta
        // mudança) — toda decisão de tool call passa a depender só de
        // `evaluateWaveTool` (allow-list próprio, ver constantes acima).
        // NUNCA reverter pra `["user", "project", "local"]` sem reabrir os
        // 3 gaps — se um comando legítimo precisar de mais allow, adicionar
        // um padrão explícito em `evaluateWaveTool`, não restaurar esta
        // linha.
        settingSources: [],
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

    // #3765 — o `for await` acima terminou sem lançar, mas isso só significa
    // que o TURNO do SDK terminou normalmente (inclusive se a coordenadora
    // simplesmente parou de chamar tools e escreveu um resumo em texto).
    // Não confiar nisso como "a onda avançou" — validar deterministicamente
    // via `gh` que toda issue chegou a um estado só alcançável por trabalho
    // real (fechada, ou aberta com comentário de diagnóstico pós-dispatch).
    let terminalResults: IssueTerminalCheck[];
    try {
      const checkFn = opts.checkTerminalStateFn ?? checkAllIssuesTerminalState;
      terminalResults = checkFn(opts.issueNumbers, opts.cwd, startedAt);
    } catch (e) {
      opts.onEvent({
        event: "chat-error",
        data: {
          message:
            `onda terminou o turno sem erro, mas a validação pós-turno de estado terminal (gh issue view) falhou: ` +
            `${e instanceof Error ? e.message : String(e)}. Não foi possível confirmar que a onda avançou — verifique manualmente.`,
        },
      });
      return;
    }
    const nonTerminal = terminalResults.filter((r) => !r.terminal);
    if (nonTerminal.length > 0) {
      const detail = nonTerminal.map((r) => `#${r.issueNumber} (${r.reason})`).join("; ");
      opts.onEvent({
        event: "chat-error",
        data: {
          message:
            `onda terminou o turno sem erro, mas ${nonTerminal.length} de ${opts.issueNumbers.length} issue(s) não ` +
            `chegaram a estado terminal: ${detail}. A coordenadora pode ter desistido silenciosamente (turno sem ` +
            `tool calls suficientes / sem PR mergeado, #3765) — verifique manualmente antes de considerar a onda concluída.`,
        },
      });
    }
  } catch (e) {
    opts.onEvent({ event: "chat-error", data: { message: describeChatError(e) } });
  }
}
