// PostToolUse hook — auto-trigger /code-review after a PR is created.
//
// Wired in .claude/settings.json under hooks.PostToolUse:
//   matcher "Bash", if "Bash(gh pr create*)", shell "bash".
//
// Gating (when this fires):
//   1. Platform: PostToolUse runs only after the Bash tool SUCCEEDS. A failed
//      `gh pr create` (e.g. "a pull request already exists", non-zero exit)
//      routes to PostToolUseFailure, not here — this is the real success gate.
//   2. `if` filter: restricts to `gh pr create*` so `gh pr view`/`gh pr list`
//      (which also print /pull/ URLs) never run it. It is a START-ANCHORED
//      prefix, so it only matches a STANDALONE `gh pr create …` call — NOT a
//      chained `git push && gh pr create …`. Create PRs with a standalone
//      `gh pr create` call so the hook fires.
//   3. This script then extracts the created PR's URL from the tool output and
//      only emits the instruction when one is present (skips `--help`, etc.).
//
// Output: a PostToolUse `additionalContext` payload instructing Claude to run
// the effort-aware /code-review on the new PR.
//
// Effort: o default do caminho "sem sinal de overnight" mora na constante
// `DEFAULT_EFFORT` (ver o docblock dela) e já foi nos dois sentidos — `max` com
// desconto pra overnight (#2754), `low` geral (#3326, motivado pelo PR #3324
// que queimou ~1,5M tokens num diff de ~250 linhas), e `max` de novo desde
// #4234 (260728), a pedido do editor e declaradamente provisório. NÃO repetir o
// valor vigente aqui: este cabeçalho já ficou mentindo uma vez, entre o #4234 e
// a correção em #4242 — e não sozinho (o mesmo PR achou outras duas cópias do
// valor espalhadas pelo arquivo). O que é estável e vale documentar neste nível:
//   - branch `overnight/*` (#2754) e guard de sessão ativa (#3322) resolvem
//     `low` explicitamente, independente do default — é o caminho
//     token-sensível, e o guard existe porque naming é convenção frágil
//     (incidente #3321, 260710: ~50 PRs, zero com o prefixo, gating nunca
//     disparou a noite inteira);
//   - #4813 (260810): pra QUALQUER PR sem sinal de overnight, o effort passou a
//     ser resolvido por tamanho de diff (ver `EFFORT_DIFF_LINE_THRESHOLD`) — não
//     mais direto pelo `DEFAULT_EFFORT`. `DEFAULT_EFFORT` virou o fallback de
//     "tamanho de diff desconhecido", ver o docblock dele;
//   - estado genuinamente indeterminado (gh indisponível, número de PR não
//     parseável, guard lançando erro) resolve `max` como fail-safe, também
//     independente do default;
//   - o `warning` do #3322 é sobre naming divergente, nunca sobre effort.
// Never throws / never exits non-zero, so it can't block the Bash tool.
//
// #3322: branch-prefix alone is NOT the primary signal anymore — it's a fragile
// naming convention any dispatch prompt can forget (exactly what happened in the
// 260710 incident, #3321: ~50 PRs, zero used `overnight/*`, gating silently never
// fired `low` all night). `isOvernightRoundActive` adds a second, naming-independent
// signal: a lightweight per-machine marker file written/removed by the
// `/diaria-overnight` skill itself (`scripts/overnight-session-marker.ts`, Fase 0
// passo 1 / Fase 2 passo 0) — `data/overnight/.active-session-{machine}.json`.
// Branch prefix is checked FIRST (cheap, no disk/process I/O) as a fast-path; the
// active-session check is the fallback that makes the gate correct even when
// naming drifts again.
//
// Deliberately NOT `data/overnight/{AAMMDD}/plan.json` (the coordinator's own
// progress-tracking document, owned by an unrelated statusline feature, schema
// still evolving). An earlier revision of this fix reused it, and code review
// surfaced 3 real gaps: (1) no staleness bound — a crashed/abandoned round stayed
// "active" forever; (2) the plan-lookup only ever inspects the single
// lexicographically-most-recent round directory — if that happens to belong to a
// DIFFERENT machine, this machine's own active round is never even checked; (3)
// inverted fail-direction inherited from a progress-bar helper (unrecognized/
// missing issue status ⇒ "still going", the wrong default for a cost gate, which
// wants "on doubt, assume NOT active" so it falls back to the expensive default).
// A dedicated, per-machine, self-timestamped marker avoids all three by
// construction — the entire contract is "exists + fresh + mine".
//
// Also deliberately self-contained (no `scripts/*.ts` imports): this hook's own
// invariant is "never throws, never blocks `gh pr create`" — a static top-level
// `import` of a project `.ts` file executes before any try/catch in this file and
// would crash the WHOLE hook (silently, zero stdout) on any Node build without
// native TS type-stripping (this repo has no `engines` pin, and sessions can run
// in differently-provisioned local/cloud/worktree environments). Path/tag logic
// here is intentionally duplicated (not imported) from
// `scripts/overnight-session-marker.ts`, which is the write/remove side used only
// by the skill's own coordinator — see that file's docblock for the split
// rationale. Keep the two in sync by hand; each side has its own test file.

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

// 24h — comfortably above the longest observed round (~16h, rodada 260611) while
// still bounding "stuck active forever" to at most a day if Fase 2's cleanup is
// ever skipped (crash, kill -9, etc).
const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;

/** Sanitiza o hostname pra um nome de arquivo seguro. Nunca lança — "unknown" em falha. */
function localMachineTag() {
  try {
    return (hostname() || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
  } catch {
    return "unknown";
  }
}

/**
 * Resolve a raiz do checkout PRINCIPAL do repo — nunca a raiz de um worktree
 * vinculado. `git rev-parse --git-common-dir` retorna o `.git` COMPARTILHADO
 * entre todos os worktrees (o do checkout principal) mesmo quando executado de
 * dentro de um worktree linkado; derivar a raiz de `import.meta.url` (a
 * localização do PRÓPRIO arquivo deste hook) não faz essa distinção — resolveria
 * pra dentro do worktree, que não tem a junction `data/` (confirmado: todo
 * subagente implementador do overnight roda com `isolation: "worktree"`, e
 * SKILL.md já documenta "worktree novo não tem node_modules/ nem a junction
 * data/"). Usar a raiz errada faria este guard nunca encontrar
 * `data/overnight/`, justamente no processo que mais precisa dele — o subagente
 * cujo PR está sendo avaliado agora mesmo.
 */
function resolveMainRepoRoot(execFn = execFileSync) {
  try {
    const gitDir = execFn("git", ["rev-parse", "--git-common-dir"], {
      encoding: "utf8",
      timeout: 10_000,
    }).trim();
    return dirname(resolvePath(gitDir));
  } catch {
    // Fallback só correto quando este arquivo roda do checkout principal (nunca
    // de um worktree) — pior caso equivale ao comportamento pré-#3322 (cai pro
    // branch-prefix check).
    return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  }
}

function activeSessionPath(repoRoot, tag) {
  return join(repoRoot, "data", "overnight", `.active-session-${tag}.json`);
}

/**
 * #3322: true quando há uma rodada `/diaria-overnight` genuinamente em progresso
 * NESTA máquina — independe 100% de como o subagente nomeou a branch do PR.
 *
 * Fail-open pra `false` (não força low) em qualquer erro, marker ausente,
 * marker mais velho que `MAX_SESSION_AGE_MS`, OU marker com `started_at` no
 * FUTURO relativo a `now` (clock skew entre escrita e leitura, ou marker
 * corrompido/editado à mão) — sem o guard `startedAtMs <= now`, uma idade
 * negativa passaria trivialmente em `<= MAX_SESSION_AGE_MS`, invertendo a
 * direção de fail-safe pra exatamente o tipo de estado duvidoso que ela
 * deveria proteger contra (achado da verificação adversarial do PR #3324).
 * Na dúvida, não afirma que uma rodada está ativa — nunca finge certeza sobre
 * um marker ausente/expirado/corrompido.
 *
 * O peso desta função sobre o effort resolvido oscila com `DEFAULT_EFFORT`, e
 * o fail-open pra `false` está certo em qualquer um dos dois regimes: enquanto
 * o default foi `low` (#3326), retornar `false` não mudava effort nenhum e só
 * decidia se o `warning` de naming (#3322) era anexado; com o default em `max`
 * (#4234), `false` volta a empurrar o caller pro caminho caro. Em ambos, a
 * justificativa é a mesma e independe do default: não afirmar "rodada ativa"
 * sobre marker ausente/expirado/corrompido. Na dúvida, o caro — nunca conceder
 * o desconto em cima de estado que não se conseguiu determinar.
 *
 * **#5156, `callerSessionId` (opcional):** com o marker carregando
 * `session_id` (rollout novo — ver `scripts/overnight-session-marker.ts`),
 * este guard só conta como "rodada ativa" quando `callerSessionId` (o
 * `session_id` da chamada `gh pr create` que disparou este hook) bate com
 * `marker.session_id` — a PR pertence à MESMA sessão overnight, não a uma
 * sessão `/diaria-develop` rodando em paralelo na mesma máquina. Marker SEM
 * `session_id` (formato antigo, inclusive rodada já em progresso no momento
 * em que este campo foi introduzido) **preserva o comportamento pré-#5156**:
 * "ativo nesta máquina" já basta, independente de `callerSessionId` — nunca
 * degradar o desconto de effort de uma rodada em voo por causa de um marker
 * que ela não sabe que precisa reescrever.
 */
export function isOvernightRoundActive(
  repoRoot = resolveMainRepoRoot(),
  machineTag = localMachineTag(),
  now = Date.now(),
  callerSessionId = undefined,
) {
  try {
    const markerPath = activeSessionPath(repoRoot, machineTag);
    if (!existsSync(markerPath)) return false;
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    const startedAtMs = Date.parse(marker.started_at);
    if (!Number.isFinite(startedAtMs)) return false;
    const ageMs = now - startedAtMs;
    if (!(ageMs >= 0 && ageMs <= MAX_SESSION_AGE_MS)) return false;
    if (marker.session_id === undefined || marker.session_id === null) return true;
    return callerSessionId === marker.session_id;
  } catch {
    return false;
  }
}

/**
 * Effort do review por PR quando NÃO há sinal de rodada overnight (branch sem
 * prefixo `overnight/*` e sem sessão ativa nesta máquina) **e** o tamanho do
 * diff não pôde ser determinado (`getDiffLineCount` retornou `null` — gh
 * indisponível, JSON malformado, etc). Desde #4813 (260810) este NÃO é mais o
 * default do caminho "sem sinal de overnight" em geral — esse caminho agora
 * resolve por tamanho de diff (`EFFORT_DIFF_LINE_THRESHOLD`, ver abaixo).
 * `DEFAULT_EFFORT` ficou reduzido a um fallback: "tamanho de diff desconhecido,
 * sem sinal de overnight" — o mesmo valor histórico, papel mais estreito.
 *
 * Histórico curto: #2754 usava `max` aqui com desconto pra overnight; #3326
 * (260711) inverteu pra `low` geral, motivado pelo PR #3324 (~1,5M tokens de
 * review num diff de ~250 linhas). #4234 (260728): o editor pediu `max` de
 * volta **por enquanto** — decisão declaradamente provisória, tomada logo
 * depois de `max` passar a significar algo distinto de `low` (fleet de 5
 * agentes do pr-review-toolkit em paralelo, contra 1 agente no `low`; antes do
 * #4234 os dois efforts mandavam o MESMO rubrico e diferiam só numa frase).
 * #4813 (260810): generalizou o limiar de tamanho (#4243) do piso barato de
 * diffs triviais pro critério PRIMÁRIO de todo o caminho sem sinal de
 * overnight — `DEFAULT_EFFORT` deixou de decidir o caso geral e passou a
 * decidir só o caso "tamanho desconhecido".
 *
 * Voltar ao comportamento do #3326 é trocar esta constante por `"low"` — uma
 * linha, de propósito, porque a decisão é temporária. O desconto de `low` pra
 * overnight (#2754/#3322) NÃO passa por aqui e segue intacto: rodada overnight
 * é o caminho token-sensível e continua em 1 agente. Na prática isto restaura
 * a semântica pré-#3326: `max` geral, `low` pra overnight — só que, pós-#4813,
 * "geral" já não passa mais por `DEFAULT_EFFORT` na maioria dos PRs (a maioria
 * tem tamanho de diff conhecido, então resolve por `EFFORT_DIFF_LINE_THRESHOLD`
 * antes de chegar aqui).
 *
 * AO TROCAR ESTA CONSTANTE, varrer o arquivo por cópias do valor antigo:
 * `grep -nE "default (geral|low|max)|#3326 default|token-discount"`. O #4234
 * trocou a constante e deixou três afirmações stale pra trás (o cabeçalho do
 * arquivo, o docblock de `buildReviewInstruction` e — pior — a própria string
 * de instrução entregue ao agente, que seguiu chamando `low` de "#3326 default"
 * depois que `low` já era só o desconto de overnight). O #4242 limpou as três.
 */
export const DEFAULT_EFFORT = "max";

/**
 * #4813 (260810): decide `low`/`max` para QUALQUER PR sem sinal de rodada
 * overnight (branch sem prefixo `overnight/*` e sem sessão ativa nesta
 * máquina) — generaliza o "piso barato pro fleet" que o #4243 introduziu só
 * pra diffs triviais (<50 linhas). Motivação da issue: o fleet review por PR
 * já era ~2/3 do gasto diário de tokens de desenvolvimento (~11,4M/dia
 * medidos), e a medição feita na própria #4813 mostrou mediana de 497 linhas e
 * p90 de 1.375 linhas por PR — com um piso de 50, quase todo PR real caía no
 * fleet de 5 agentes de qualquer jeito; **34% dos PRs recentes tinham menos de
 * 300 linhas**, faixa que se qualificou pro review de 1 agente. O editor
 * decidiu inicialmente pelo limiar mais conservador (300, não 500 — a outra
 * opção discutida na issue): ver a decisão registrada em
 * https://github.com/vjpixel/diaria-studio/issues/4813#issuecomment-5235991770.
 *
 * **#5420 (260816): limiar subiu de 300 para 500.** Segunda medição, feita em
 * agosto/2026, mostrou mediana de 497 linhas e p90 de 1.375 linhas — com o
 * limiar em 300, a MEDIANA dos PRs (a maioria) já caía no fleet caro de 5
 * agentes, o que o #4813 original não previa (a medição dele foi anterior e
 * mais otimista sobre quanto do tráfego real ficava abaixo de 300). Subir o
 * limiar pra 500 é exatamente a outra opção que o #4813 já tinha discutido e
 * descartado — decisão revisitada com dado novo, não uma reversão por
 * capricho: ver a decisão do editor registrada em
 * https://github.com/vjpixel/diaria-studio/issues/5420#issuecomment-5308999233
 * (16/08/2026, "DECISÃO DO EDITOR (16/08/2026) — limiar de 500 linhas").
 * Economia estimada
 * ~4,5M tokens/dia — metade dos PRs (a mediana de agosto) passa a cair no
 * review de 1 agente, e o p90 (1.375 linhas) continua protegido no fleet
 * completo.
 *
 * Isto SUBSTITUI o antigo `TRIVIAL_DIFF_LINE_THRESHOLD` (50) — não é um
 * segundo limiar rodando ao lado do primeiro; todo diff <50 já é <500, então
 * não há duas checagens de tamanho sobrepostas.
 */
export const EFFORT_DIFF_LINE_THRESHOLD = 500;

/**
 * Soma additions+deletions do PR via `gh pr view --json additions,deletions`.
 * Retorna `null` em QUALQUER falha (gh indisponível, JSON malformado, campos
 * não-numéricos) — o caller trata `null` como "não dá pra saber o tamanho do
 * diff" e nunca deixa isso virar "pular o review" (#4243/#4813: fail-soft
 * obrigatório, sempre cai no `DEFAULT_EFFORT`).
 */
function getDiffLineCount(num, execFn) {
  try {
    const raw = execFn("gh", ["pr", "view", num, "--json", "additions,deletions"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    const parsed = JSON.parse(raw);
    const total = Number(parsed.additions) + Number(parsed.deletions);
    return Number.isFinite(total) ? total : null;
  } catch {
    return null;
  }
}

/**
 * Resolve o headRefName de um PR e decide o effort de /code-review.
 * `execFn` é injetável (default = execFileSync real) pra ser testável sem gh live.
 * `checkRoundActive` é injetável (default = isOvernightRoundActive real) pra ser
 * testável sem tocar `data/overnight/` no disco real.
 *
 * Caminhos com sinal de overnight — prefixo `overnight/*` (#2754) ou sessão
 * ativa nesta máquina (#3322) — continuam resolvendo `low` explicitamente,
 * independente de tamanho de diff ou do `DEFAULT_EFFORT`.
 *
 * #4813 (260810, generaliza #4243): quando NENHUM sinal de overnight se
 * aplica, effort passa a ser resolvido por TAMANHO DE DIFF — critério
 * primário, não mais o `DEFAULT_EFFORT` direto. Diff pequeno (soma de
 * additions+deletions < `EFFORT_DIFF_LINE_THRESHOLD`) rebaixa pra `low`; diff
 * de tamanho CONHECIDO e ≥ limiar resolve `max` explicitamente (`reason:
 * "diff_grande"`) — decisão baseada em tamanho, não mais "default genérico".
 * Só quando o tamanho é DESCONHECIDO (`getDiffLineCount` retornou `null` — gh
 * indisponível, JSON malformado, campos não-numéricos) o fluxo cai no
 * `DEFAULT_EFFORT` (`reason: "default"`) como fail-safe — nunca pula o review
 * por não saber o tamanho do diff. Antes do #4813 só o caso trivial (<50
 * linhas) tinha esse tratamento especial; o resto do range (inclusive diffs
 * médios de 50-299 linhas) caía direto no `DEFAULT_EFFORT`/fleet de 5 agentes.
 *
 * Fail-safe: em estado genuinamente indeterminado — gh indisponível, PR sem
 * número reconhecível na URL, `checkRoundActive` lançando erro — mantém `max`.
 * Continua sendo uma escolha deliberada e independente do default geral (era o
 * único uso de `max` entre #3326 e #4234, e segue valendo mesmo se o default
 * voltar pra `low`): quando o hook não consegue nem determinar o que está
 * revisando, erra pro lado mais caro em vez de conceder o mais barato
 * silenciosamente sobre um estado desconhecido.
 *
 * Retorna `{ effort, warning, reason }`: `warning` é `null` no caminho feliz, ou
 * uma nota (#3322 direção 3) quando a branch NÃO seguiu a convenção
 * `overnight/*` (#3321) apesar de uma rodada ativa nesta máquina. O warning é
 * sobre naming, não sobre effort: entre #3326 e #4234 ele não mudava o effort
 * resolvido (era `low` de qualquer jeito); com o default de volta em `max`
 * (#4234) o guard volta a ter efeito real sobre o effort, mas o texto do
 * warning segue falando só do naming divergente — que é o que ele sempre
 * tornou visível ao coordenador, em vez de passar em silêncio (era justamente
 * esse silêncio que atrasou a detecção do #3321).
 *
 * `reason` (#4252, ramos de tamanho reformulados em #4813): código curto e
 * estável identificando QUAL ramo decidiu — `pr_sem_numero` |
 * `branch_overnight` | `sessao_overnight_ativa` | `diff_pequeno` |
 * `diff_grande` | `default` | `estado_indeterminado`. `diff_pequeno` e
 * `diff_grande` (tamanho CONHECIDO, dos dois lados do limiar) substituem o
 * antigo `diff_trivial`; `default` agora significa especificamente "tamanho
 * DESCONHECIDO, caiu no fallback" — distinção que existe pra instrumentação
 * (`logEffortDecision`) conseguir separar "grande de propósito" de
 * "desconhecido, caiu no fallback". Campo aditivo: nenhum teste existente
 * inspeciona o objeto inteiro (só `.effort`/`.warning`), então adicioná-lo não
 * quebra nada. Existe só pra alimentar o log de instrumentação
 * (`logEffortDecision`, chamado no entrypoint CLI abaixo — nunca aqui dentro,
 * pra manter `resolveEffort` livre de I/O e os ~20 call sites do teste
 * existentes hermeticamente intocados) — descoberto como lacuna na própria
 * #4252: "nada hoje registra qual effort foi resolvido por PR nem quantos
 * agentes rodaram".
 */
export function resolveEffort(
  prUrl,
  execFn = execFileSync,
  // #5156: o default NÃO é `isOvernightRoundActive` direto — chamá-lo como
  // `checkRoundActive(sessionId)` passaria `sessionId` na posição de
  // `repoRoot` (1º parâmetro de `isOvernightRoundActive`), corrompendo a
  // resolução do path do marker. Este wrapper resolve `repoRoot`/`machineTag`/
  // `now` pelos defaults reais de `isOvernightRoundActive` (via `undefined`
  // explícito, que aciona o default de cada parâmetro) e só repassa
  // `callerSessionId` na posição correta (4º parâmetro).
  checkRoundActive = (callerSessionId) => isOvernightRoundActive(undefined, undefined, undefined, callerSessionId),
  sessionId = undefined,
) {
  try {
    const num = prUrl.match(/\/pull\/(\d+)/)?.[1];
    // fail-safe: sem número de PR nem dá pra chamar `gh` — estado indeterminado,
    // mantém max independente de qual seja o DEFAULT_EFFORT vigente.
    if (!num) return { effort: "max", warning: null, reason: "pr_sem_numero" };
    const branch = execFn(
      "gh",
      ["pr", "view", num, "--json", "headRefName", "--jq", ".headRefName"],
      { encoding: "utf8", timeout: 10_000 },
    ).trim();
    if (branch.startsWith("overnight/")) return { effort: "low", warning: null, reason: "branch_overnight" };
    // #5156: `sessionId` (o session_id da chamada gh pr create que criou esta
    // PR, extraído do payload do hook no entrypoint CLI abaixo) é repassado a
    // checkRoundActive — quando o default real (isOvernightRoundActive) lê um
    // marker COM session_id, só conta como "ativo" se bater com esta PR;
    // marker sem session_id (formato antigo) ignora o argumento e mantém o
    // comportamento pré-#5156. Mocks de teste (`noActiveRound`/`activeRound`)
    // ignoram o argumento livremente — não quebra nenhum teste existente.
    if (checkRoundActive(sessionId)) {
      return {
        effort: "low",
        warning:
          `branch "${branch}" não usa o prefixo overnight/ apesar de uma sessão ` +
          "overnight ativa nesta máquina (data/overnight/.active-session-*.json) — " +
          "SKILL.md diaria-overnight (Fase 1, passo 2) deveria ter instruído esse " +
          "prefixo no dispatch do subagente implementador (#3321). O desconto de " +
          "effort foi aplicado pelo guard de sessão ativa, não pelo naming — este " +
          "warning é só sobre o naming divergente.",
        reason: "sessao_overnight_ativa",
      };
    }
    // Sem sinal de overnight/rodada-ativa: effort resolve por tamanho de diff
    // (#4813). getDiffLineCount() retornando `null` (falha de qualquer tipo)
    // faz os dois ramos de tamanho abaixo serem ignorados de propósito.
    const diffLineCount = getDiffLineCount(num, execFn);
    if (diffLineCount !== null && diffLineCount < EFFORT_DIFF_LINE_THRESHOLD) {
      return { effort: "low", warning: null, reason: "diff_pequeno" };
    }
    // Diff de tamanho CONHECIDO e ≥ limiar → max explícito (não é mais
    // "default geral" — é uma decisão baseada em tamanho, #4813). Diff de
    // tamanho DESCONHECIDO (getDiffLineCount retornou null, ex: gh
    // indisponível) também cai aqui embaixo, mas por motivo diferente:
    // fail-safe pro DEFAULT_EFFORT vigente, nunca "pular o review" (mesma
    // garantia do #4243).
    if (diffLineCount !== null) {
      return { effort: "max", warning: null, reason: "diff_grande" };
    }
    return { effort: DEFAULT_EFFORT, warning: null, reason: "default" };
  } catch {
    // fail-safe: estado desconhecido (gh indisponível, timeout, checkRoundActive
    // lançando erro) → `max` literal, nunca DEFAULT_EFFORT. São decisões
    // independentes: esta vale mesmo quando o default geral for `low`, porque o
    // hook não consegue nem determinar o que está revisando.
    return { effort: "max", warning: null, reason: "estado_indeterminado" };
  }
}

/**
 * Quantos agentes de review o effort resolvido dispara — 1 pra `low`
 * (`REVIEW_AGENT` sozinho), 5 pra `max` (`REVIEW_AGENT` + `REVIEW_FLEET_MAX`,
 * ver `buildReviewInstruction`). Usado só pro log de instrumentação (#4252).
 */
function agentCountForEffort(effort) {
  return effort === "low" ? 1 : REVIEW_FLEET_MAX.length + 1;
}

/**
 * #4252: instrumenta a decisão de effort no run-log — a lacuna descoberta na
 * própria issue ("nada hoje registra qual effort foi resolvido por PR nem
 * quantos agentes rodaram"). Chamado UMA vez, só no entrypoint CLI (não dentro
 * de `resolveEffort`, que fica livre de I/O e é o que a suíte de testes
 * chama diretamente — instrumentar ali obrigaria os ~20 call sites existentes
 * a injetar um logger fake ou passar a escrever de verdade em
 * `data/run-log.jsonl` a cada `npx tsx --test`, incluindo o checkout PRINCIPAL
 * compartilhado quando o teste roda de dentro de um worktree — ver
 * `resolveMainRepoRoot`).
 *
 * Não reusa `scripts/log-event.ts` diretamente: aquele arquivo é um script CLI
 * que faz `process.exit()`/parse de `process.argv` no top-level assim que é
 * importado (sem uma função exportada) — importar de um `.mjs` self-contained
 * (ver docblock do topo do arquivo: "no `scripts/*.ts` imports") executaria
 * esse top-level e potencialmente abortaria o hook inteiro. Em vez disso,
 * replica o MESMO formato de linha JSON (`timestamp, edition, stage, agent,
 * level, message, details`) — ver `LogEvent` em `scripts/log-event.ts`.
 *
 * Fail-soft, igual ao resto do hook: nunca lança, nunca bloqueia a criação da
 * PR nem a instrução de review por falha ao logar (disco cheio, `data/`
 * ausente — worktree sem junction e sem fallback de repo root, etc).
 */
export function logEffortDecision(
  { prUrl, effort, reason },
  { repoRoot = resolveMainRepoRoot(), appendFn = appendFileSync, mkdirFn = mkdirSync } = {},
) {
  try {
    const pr = prUrl?.match(/\/pull\/(\d+)/)?.[1] ?? null;
    const event = {
      timestamp: new Date().toISOString(),
      edition: null,
      stage: null,
      agent: "code-review",
      level: "info",
      message: "effort_resolved",
      details: { pr, effort, motivo: reason, agentes: agentCountForEffort(effort) },
    };
    const logPath = join(repoRoot, "data", "run-log.jsonl");
    mkdirFn(dirname(logPath), { recursive: true });
    appendFn(logPath, JSON.stringify(event) + "\n", "utf8");
  } catch {
    // Swallow everything, same contract as the rest of this file: a logging
    // failure must never block PR creation or the review instruction.
  }
}

/**
 * Monta o additionalContext do hook a partir da URL do PR, effort resolvido e
 * warning opcional. Pure/testável.
 *
 * #4034 (260726): `/code-review` deixou de ser invocável via Skill tool
 * (`disable-model-invocation` — gate de plataforma, não config nossa,
 * confirmado usageCount:462 funcionando por meses antes do flip). A
 * instrução deixou de pedir `/code-review {effort} --comment` (o Skill tool
 * rejeita a chamada) e passa a pedir um dispatch via ferramenta Agent
 * (imune a esse gate, que só afeta Skill), postando os achados como
 * comentários inline na PR. Mesmo mecanismo usado na Fase 1.5 do
 * overnight/develop (`.claude/skills/diaria-overnight/SKILL.md`,
 * `.claude/skills/diaria-develop/SKILL.md`).
 *
 * #4234 (260728): o dispatch passou a usar os agentes do plugin
 * `pr-review-toolkit@claude-plugins-official` — a opção (b) que o #4034 deixou
 * pendente de verificação ("é agente, não comando, então não caiu no gate do
 * code-review; mas confirmar disponibilidade antes de depender dele").
 * Verificado em 260728: registram com nome PREFIXADO pelo plugin
 * (`pr-review-toolkit:code-reviewer`), não `code-reviewer` puro como o plano
 * do #4034 supunha — usar o nome sem prefixo resolve `Agent type not found`.
 *
 * FALLBACK obrigatório: a habilitação viaja no repo (`enabledPlugins` no
 * `.claude/settings.json` versionado), mas os ARQUIVOS do plugin vêm do
 * marketplace por máquina — sessão cloud, clone fresco ou plugin desabilitado
 * resolvem `Agent type ... not found`. Nesse caso a instrução manda cair no
 * `general-purpose` + rubrico inline, que é exatamente o comportamento
 * pré-#4234 (#4057). O caminho degradado é sempre "review pior", nunca
 * "review nenhum em silêncio".
 *
 * Mapeamento de effort: `low` = UM agente (`code-reviewer`); `max` = fleet
 * paralelo com os 4 analisadores especializados junto. Antes do #4234 os dois
 * efforts mandavam o MESMO rubrico e diferiam só numa frase de profundidade —
 * `max` só a partir dali tem conteúdo próprio.
 *
 * #5304: o desconto do `low` é o NÚMERO DE AGENTES, nunca a profundidade do
 * relatório. Até aqui o ramo `low` também pedia "report only a few
 * high-confidence findings" (herdado do #3326) — um filtro de severidade que
 * Sonnet 5 e Opus 5 passaram a obedecer LITERALMENTE: o agente investiga e
 * acha igual, e então deixa de reportar o que julga abaixo da barra. Precisão
 * sobe, recall MEDIDO cai. Isso era um trade-off aceitável enquanto o
 * consumidor era o editor lendo o resumo; deixou de ser quando o #5251 fez
 * "sem findings de alta confiança" virar a condição de auto-merge, e o #4813
 * fez o `low` pegar todo diff < `EFFORT_DIFF_LINE_THRESHOLD` (a maioria das
 * PRs), não só branch `overnight/*`. A instrução por chamada deixou de
 * reforçar o filtro e passou a pedir cobertura + tag de confiança/severidade,
 * pro ranqueamento ser do consumidor (gate do #5251).
 *
 * ATENÇÃO ao alcance real disto (achado do review da própria PR #5308, #5311):
 * isto NÃO remove o filtro — remove o reforço dele daqui. O system prompt do
 * `pr-review-toolkit:code-reviewer` é um arquivo do MARKETPLACE, fora deste
 * repo (`~/.claude/plugins/.../agents/code-reviewer.md`), e contém
 * literalmente `Only report issues with confidence ≥ 80` e `filter
 * aggressively - quality over quantity`. O que esta instrução consegue é
 * SOBREPOR essa diretiva por especificidade/recência — sobreposição observada
 * funcionando, mas não garantida por nada neste repo, e não coberta pelos
 * testes (que travam a string do hook, nunca o comportamento do agente).
 * Enquanto o #5311 não decidir o encaminhamento, tratar como mitigação
 * parcial, não como problema fechado. Consequência deliberada: o fail-safe `max` de
 * `resolveEffort` (estado indeterminado) passou a custar 5 agentes em vez de
 * 1 — segue valendo a escolha de errar pro lado caro quando o hook não
 * consegue nem determinar o que está revisando, e o caminho é raro.
 */

/** Agente primário do review por PR (nome prefixado pelo plugin — ver #4234). */
export const REVIEW_AGENT = "pr-review-toolkit:code-reviewer";

/** Analisadores especializados que entram junto SÓ no effort `max` (#4234). */
export const REVIEW_FLEET_MAX = [
  "pr-review-toolkit:silent-failure-hunter",
  "pr-review-toolkit:pr-test-analyzer",
  "pr-review-toolkit:comment-analyzer",
  "pr-review-toolkit:type-design-analyzer",
];

export function buildReviewInstruction(prUrl, effort, warning = null) {
  const effortNote =
    effort === "low"
      ? `at LOW effort (overnight token-discount, #2754/#3322): dispatch ONE Agent, subagent_type \`${REVIEW_AGENT}\`, ` +
        "model:sonnet explicit (#2019). The discount is ONE agent instead of the fleet — it is NOT a shallower report: " +
        "report every finding, including low-severity ones and ones you are unsure about, and do not filter for " +
        "importance or confidence at this stage"
      : `at ULTRACODE / MAXIMUM effort: dispatch the full toolkit fleet IN PARALLEL — \`${REVIEW_AGENT}\` plus ` +
        `${REVIEW_FLEET_MAX.join(", ")} — each with model:sonnet explicit (#2019), then aggregate their findings`;
  // O caminho degradado tem que preservar a PROFUNDIDADE pedida, não só existir:
  // sem isto, um `max` que caia no fallback (plugin ausente — justamente sessão
  // cloud / clone fresco) produziria instrução idêntica à de `low`, entregando
  // review raso sob o effort mais caro. Vale ainda mais desde que `max` virou o
  // default (#4234): o fallback deixou de ser caminho de exceção.
  const fallbackDepth =
    effort === "low"
      ? ""
      : " Keep MAXIMUM depth in that degraded path too: be thorough, read every changed file, not just the diff hunks.";
  const warningNote = warning ? ` [aviso: ${warning}]` : "";
  return (
    `A pull request was just created: ${prUrl} — per project policy, review it now. ` +
    "`/code-review` cannot be self-invoked via the Skill tool (platform gate, #4034) — instead, dispatch an Agent " +
    `${effortNote}, over \`git diff\` for this PR's branch vs its base. State that range EXPLICITLY in the prompt — ` +
    "the toolkit agents default to reviewing UNSTAGED changes, which are not this PR. " +
    "Instruct every agent to stay READ-ONLY (no file edits, no `git checkout`/`switch`/`stash`/`reset`, no commits): " +
    "a concurrent session may share this checkout (incidents 260703/260708). " +
    `If a dispatch fails with \`Agent type ... not found\` (plugin \`pr-review-toolkit\` absent — cloud session or ` +
    "fresh clone), fall back to `general-purpose` with an inline review rubric (correctness, " +
    `simplification/efficiency, test-coverage, security) — never skip the review silently (#4234).${fallbackDepth} ` +
    "Tag every finding with its confidence (alta/média/baixa) and severity (P0..P3): ranking and filtering are a " +
    "SEPARATE downstream step (the auto-merge gate of #5251 reads those tags), never the reviewing agent's job (#5304). " +
    "Then post the findings as inline PR comments (`gh pr comment`/`gh api`). " +
    "Do NOT use cloud `ultra` (it is user-triggered/billed and cannot be self-launched)." +
    warningNote
  );
}

// #2019: CLI guard — só roda o corpo do hook quando este arquivo é o entrypoint
// (nunca ao ser importado por test/pr-create-review-hook.test.ts).
const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (data += chunk));
  process.stdin.on("end", () => {
    try {
      const payload = JSON.parse(data || "{}");
      const resp =
        typeof payload.tool_response === "string"
          ? payload.tool_response
          : JSON.stringify(payload.tool_response ?? "");
      const match = resp.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/);
      if (match) {
        // #5156: repassa o session_id deste hook (a sessão que rodou `gh pr create`)
        // pra resolveEffort — permite que isOvernightRoundActive discrimine
        // marker com session_id sem quebrar o caminho default (marker sem
        // session_id ignora o argumento).
        const { effort, warning, reason } = resolveEffort(match[0], undefined, undefined, payload.session_id);
        logEffortDecision({ prUrl: match[0], effort, reason }); // #4252
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PostToolUse",
              additionalContext: buildReviewInstruction(match[0], effort, warning),
            },
          }),
        );
      }
    } catch {
      // Swallow everything: a hook that errors must not block the PR creation.
    }
  });
}
