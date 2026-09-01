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
//      `gh pr create` call so the hook fires. **#6298: this filter alone was
//      observed firing for a standalone `gh pr comment …` call — cause not
//      confirmed at the harness layer — so this script no longer trusts it
//      exclusively; see point 3 below.**
//   3. `shouldEmitReviewInstruction` (thin wrapper over `resolveEmitDecision`)
//      decides whether to actually emit, combining two checks (#6298): (a)
//      `extractCreatedPrUrl` rejects a `tool_response` URL that carries a
//      `#issuecomment-\d+`/`#discussion_r\d+`/`#pullrequestreview-\d+`
//      fragment — the shape of a COMMENT/REVIEW URL, never a freshly-created
//      PR's own URL (the bug in #6298: `gh pr comment`'s stdout is such a URL,
//      and the old regex matched it because it only looked as far as the PR
//      number, ignoring the fragment after); (b) when
//      `payload.tool_input.command` is available, it must actually be a `gh
//      pr create` invocation (`isGhPrCreateCommand`, duplicated from — but no
//      longer contract-identical to — `isGhPrMergeCommand` in the sibling
//      hook `block-gh-pr-merge-subagent.mjs`: this one returns a 3-state
//      `"create" | "not-create" | "unknown"`, never a boolean, precisely so
//      "command absent" can never collapse into "definitely not a create"
//      again — the ambiguity a fleet review flagged after #6298 shipped) —
//      not `gh pr comment`, and not a citation of the string "gh pr create"
//      inside a quoted `--body`/`--title` of some OTHER command. `command`
//      ABSENT from the payload resolves `"unknown"`, which the call site
//      treats as permissive (decide from the URL alone, same as pre-#6298) —
//      never as silent-deny: this hook's failure direction is "an extra
//      review" over "no review at all".
//   4. Every path that does NOT end in an emitted review instruction — no PR
//      URL at all, a comment/review URL, or a command confirmed NOT to be
//      `gh pr create` — logs its reason via `logSuppressedReviewInstruction`
//      (`data/run-log.jsonl`, message `review_instruction_suppressed`). Added
//      after a fleet review found the 3 reasons indistinguishable in the only
//      observable output (silence): a CORRECT suppression (comment URL) and
//      an INCORRECT one (a genuine PR misclassified by an edge case) produced
//      the exact same nothing. Fail-soft, same contract as
//      `logEffortDecision` below — a logging failure never blocks anything.
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
//   - branch `overnight/*` (#2754) e guard de sessão ativa (#3322) continuam
//     o caminho token-sensível, independente do default — mas desde #6393
//     (260827) deixaram de resolver `low` incondicional: cada um passa por
//     `resolveOvernightDiffEffort`, que compara o tamanho do diff contra
//     `OVERNIGHT_EFFORT_DIFF_LINE_THRESHOLD` (1000, maior que o limiar geral
//     de propósito — overnight continua mais barato que develop no mesmo
//     tamanho de diff, só deixou de ser barato incondicional). O guard de
//     sessão ativa existe porque naming é convenção frágil (incidente #3321,
//     260710: ~50 PRs, zero com o prefixo, gating nunca disparou a noite
//     inteira);
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
 * #6393 (260827): limiar de tamanho de diff PRÓPRIO do caminho overnight —
 * antes desta issue, `branch_overnight`/`sessao_overnight_ativa` resolviam
 * `low` INCONDICIONAL, sem olhar o tamanho do diff, enquanto o caminho geral
 * (develop/sessão comum) já resolvia por `EFFORT_DIFF_LINE_THRESHOLD` desde o
 * #4813. A assimetria estava invertida em relação ao risco: overnight é
 * justamente o fluxo DESASSISTIDO (PR nasce, CI verde, auto-merge, sem editor
 * olhando) — e era ele quem recebia o review mais fraco sempre, mesmo num PR
 * de milhares de linhas.
 *
 * A correção NÃO iguala os dois limiares — decisão explícita do editor
 * (discussão registrada no corpo da #6393): overnight continua mais barato
 * que develop no mesmo tamanho de diff, então este limiar é maior que
 * `EFFORT_DIFF_LINE_THRESHOLD` (500), não igual. 1000 linhas é o valor
 * proposto na issue — o dobro do limiar geral, cobrindo a esmagadora maioria
 * dos PRs overnight reais (tipicamente pequenos: 1 issue, 1-2 arquivos) sem
 * abrir mão do gate pro PR grande mergeado sozinho de madrugada, que é
 * exatamente o buraco que a issue fecha.
 *
 * Fail-direction do caminho overnight continua deliberadamente mais barata
 * que a do caminho geral: tamanho de diff DESCONHECIDO (gh indisponível, JSON
 * malformado) resolve `low` aqui — não `DEFAULT_EFFORT`/`max` como no
 * caminho geral (ver `resolveOvernightDiffEffort`). Overnight já tratava "não
 * sei o tamanho" como "confia no desconto" antes desta issue (curto-
 * circuitava sem nem chamar `getDiffLineCount`); preservar esse viés pro caso
 * desconhecido é exatamente o que os critérios de aceite da issue pedem — só
 * o caso CONHECIDO grande é que precisava deixar de ser sempre `low`.
 */
export const OVERNIGHT_EFFORT_DIFF_LINE_THRESHOLD = 1000;

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
 * #6393: decide low/max para um caminho COM sinal de overnight (branch
 * `overnight/*` ou sessão ativa), agora que esse caminho também olha o
 * tamanho do diff em vez de curto-circuitar sempre em `low`. Limiar PRÓPRIO
 * (`OVERNIGHT_EFFORT_DIFF_LINE_THRESHOLD`, ver docblock da constante) — maior
 * que o do caminho geral, de propósito. Diff CONHECIDO e ≥ limiar → `max`
 * (`reason` recebe o sufixo `_diff_grande`); diff pequeno OU tamanho
 * DESCONHECIDO (`getDiffLineCount` retornou `null`) → `low`, com o `reason`
 * BASE inalterado — overnight preserva o viés histórico de "não sei o
 * tamanho, confia no desconto" que já tinha antes desta issue (diferente do
 * caminho geral, que cai no `DEFAULT_EFFORT`/`max` quando o tamanho é
 * desconhecido).
 */
function resolveOvernightDiffEffort(num, execFn, baseReason) {
  const diffLineCount = getDiffLineCount(num, execFn);
  if (diffLineCount !== null && diffLineCount >= OVERNIGHT_EFFORT_DIFF_LINE_THRESHOLD) {
    return { effort: "max", reason: `${baseReason}_diff_grande` };
  }
  return { effort: "low", reason: baseReason };
}

/**
 * Resolve o headRefName de um PR e decide o effort de /code-review.
 * `execFn` é injetável (default = execFileSync real) pra ser testável sem gh live.
 * `checkRoundActive` é injetável (default = isOvernightRoundActive real) pra ser
 * testável sem tocar `data/overnight/` no disco real.
 *
 * Caminhos com sinal de overnight — prefixo `overnight/*` (#2754) ou sessão
 * ativa nesta máquina (#3322) — continuam token-sensíveis por padrão, mas
 * deixaram de ser `low` INCONDICIONAL desde o #6393: cada um resolve por
 * tamanho de diff via `resolveOvernightDiffEffort`, com um limiar PRÓPRIO
 * (`OVERNIGHT_EFFORT_DIFF_LINE_THRESHOLD`, maior que o do caminho geral) —
 * ver o docblock da constante pro porquê da assimetria estar invertida em
 * relação ao risco antes desta issue (overnight é o fluxo DESASSISTIDO, e
 * era ele quem recebia sempre o review mais fraco).
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
 * `reason` (#4252, ramos de tamanho reformulados em #4813; ramos de overnight
 * reformulados em #6393): código curto e estável identificando QUAL ramo
 * decidiu — `pr_sem_numero` | `branch_overnight` | `branch_overnight_diff_grande` |
 * `sessao_overnight_ativa` | `sessao_overnight_ativa_diff_grande` |
 * `diff_pequeno` | `diff_grande` | `default` | `estado_indeterminado`.
 * `diff_pequeno` e `diff_grande` (tamanho CONHECIDO, dos dois lados do
 * limiar) substituem o antigo `diff_trivial`; `default` agora significa
 * especificamente "tamanho DESCONHECIDO, caiu no fallback" — distinção que
 * existe pra instrumentação (`logEffortDecision`) conseguir separar "grande
 * de propósito" de "desconhecido, caiu no fallback". Os dois sufixos
 * `_diff_grande` (#6393) preservam o `reason` BASE do ramo overnight que
 * decidiu (naming, ver `resolveOvernightDiffEffort`) em vez de reusar
 * `diff_grande` do caminho geral — a instrumentação continua distinguindo
 * "PR overnight grande" de "PR geral grande" sem precisar cruzar com o
 * branch/marker separadamente. Campo aditivo: nenhum teste existente
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
    // #6393: branch overnight/* deixou de ser `low` incondicional — resolve
    // por tamanho de diff, com o limiar PRÓPRIO (maior) do caminho overnight.
    if (branch.startsWith("overnight/")) {
      const { effort, reason } = resolveOvernightDiffEffort(num, execFn, "branch_overnight");
      return { effort, warning: null, reason };
    }
    // #5156: `sessionId` (o session_id da chamada gh pr create que criou esta
    // PR, extraído do payload do hook no entrypoint CLI abaixo) é repassado a
    // checkRoundActive — quando o default real (isOvernightRoundActive) lê um
    // marker COM session_id, só conta como "ativo" se bater com esta PR;
    // marker sem session_id (formato antigo) ignora o argumento e mantém o
    // comportamento pré-#5156. Mocks de teste (`noActiveRound`/`activeRound`)
    // ignoram o argumento livremente — não quebra nenhum teste existente.
    if (checkRoundActive(sessionId)) {
      // #6393: mesmo tratamento de tamanho de diff do ramo `overnight/*`
      // acima — o warning de naming (#3321) é ortogonal ao tamanho, então
      // sai igual independente de o diff ter resolvido `low` ou `max`.
      const { effort, reason } = resolveOvernightDiffEffort(num, execFn, "sessao_overnight_ativa");
      return {
        effort,
        warning:
          `branch "${branch}" não usa o prefixo overnight/ apesar de uma sessão ` +
          "overnight ativa nesta máquina (data/overnight/.active-session-*.json) — " +
          "SKILL.md diaria-overnight (Fase 1, passo 2) deveria ter instruído esse " +
          "prefixo no dispatch do subagente implementador (#3321). O desconto de " +
          "effort foi aplicado pelo guard de sessão ativa, não pelo naming — este " +
          "warning é só sobre o naming divergente.",
        reason,
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

/**
 * #6732: marcador literal que a sessão deve postar quando a ferramenta Agent
 * NÃO está disponível (a delegação do `hermes-diaria-continuo` roda com
 * `--tools` sem `Agent`/`Task`, de propósito — #6712). Duplicado por STRING
 * (não import) de `scripts/lib/pr-review-authenticity.ts` — este arquivo
 * nunca importa `.ts` do repo (ver o docblock no topo, "Also deliberately
 * self-contained"); `REVIEW_AGENT`, logo abaixo, é definido localmente pelo
 * mesmo motivo, nunca importado de outro módulo (correção de fleet review
 * #6820: a frase anterior lia como "REVIEW_AGENT não tem consumidor
 * nenhum", o que é falso — o teste importa esse export; a intenção sempre
 * foi "nunca importado PARA DENTRO deste arquivo"). Manter as duas pontas em
 * sincronia manual — `scripts/check-pr-review-authenticity.ts` é quem lê
 * este marcador de volta.
 */
export const SELF_REVIEW_MARKER = "<!-- self-review: true -->";

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
    "Do NOT use cloud `ultra` (it is user-triggered/billed and cannot be self-launched). " +
    "IF the Agent tool is NOT available to you in THIS session (e.g. the `hermes-diaria-continuo` delegation, which " +
    "intentionally omits it, #6712): do not dispatch anything, and do NOT label your own reading of the diff as an " +
    "agent review under any phrasing resembling \"Review automatizado\" — that is exactly the fabrication #6732 " +
    `exists to stop (measured live on PRs #6713/#6715). Instead, read the diff yourself and post a comment starting ` +
    `with the literal line \`${SELF_REVIEW_MARKER}\` on its own line, followed by plain prose stating this is a ` +
    "self-review by the PR's own authoring session, with no independent reviewer. The pre-merge gate " +
    "(`scripts/check-pr-review-authenticity.ts`, #6732) reads that marker and treats it as NOT satisfying #5251 — " +
    "the PR stays open for external review (`continuo-pr-review.sh`, `opus-daily-diff-review.sh`, or " +
    "overnight/develop pickup), never merges on a self-review alone." +
    warningNote
  );
}

/**
 * #6298 fix 1: extrai a URL de uma PR REALMENTE CRIADA do `tool_response`,
 * rejeitando falsos-positivos de outros subcomandos `gh` cujo output TAMBÉM
 * contém uma URL `/pull/N` — o caso medido ao vivo é `gh pr comment`, cuja
 * saída é `https://github.com/.../pull/N#issuecomment-<id>` e casava o regex
 * antigo (que só olhava até o número da PR, ignorando o que vem depois). O
 * mesmo formato de sufixo existe para comentário inline de review
 * (`#discussion_r<id>`) e para a review em si (`#pullrequestreview-<id>`) —
 * nenhuma PR recém-criada tem fragmento na própria URL, então qualquer um dos
 * três é prova de que a URL pertence a um COMENTÁRIO/REVIEW, não à criação.
 *
 * Backtracking do regex é bloqueado deliberadamente: sem o `(?!\d)` logo após
 * `\d+`, um motor de regex tentaria encolher o número casado (6282 → 628 →
 * 62 → ...) até achar uma posição onde o `(?!#(?:issuecomment|...))` de
 * negative lookahead passasse — produzindo um match TRUNCADO (`.../pull/628`)
 * em vez de simplesmente falhar. `(?!\d)` garante que só o número COMPLETO é
 * aceito como candidato antes de checar o sufixo; se o sufixo malicioso
 * estiver lá, a tentativa nessa posição falha inteira, sem produzir match
 * parcial.
 */
export function extractCreatedPrUrl(text) {
  if (typeof text !== "string") return null;
  const match = text.match(
    // discussion_r's fragment has NO dash before the digits (`#discussion_r123...`),
    // unlike issuecomment/pullrequestreview (`#issuecomment-123...`) — kept as a
    // separate alternative, not folded into the shared `-\d+` suffix.
    /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+(?!\d)(?!#(?:issuecomment-\d+|discussion_r\d+|pullrequestreview-\d+))/,
  );
  return match ? match[0] : null;
}

/**
 * #6920: GitHub só reconhece as palavras-chave de auto-close em INGLÊS
 * (close/closes/closed, fix/fixes/fixed, resolve/resolves/resolved). Este
 * projeto escreve corpo de PR em português (`Fecha #N`, `Corrige #N`,
 * `Resolve #N`, `Encerra #N`, flexões incluídas) — o texto declara a
 * intenção, o GitHub não entende, a issue nunca fecha sozinha (achado #6920:
 * 14 de 90 issues abertas, 16%, já resolvidas e mergeadas). Duplicado
 * (não importado de scripts/lib/) pelo mesmo motivo documentado no topo do
 * arquivo: este hook é self-contained de propósito.
 *
 * As duas listas abaixo compartilham o mesmo formato de regex
 * (`\b(?:verbo)\b` seguido, a até 20 chars de distância sem quebra de linha
 * nem outro `#`, de `#<número>`) para tratar "Fecha o bug #123" e "Fecha
 * #123" da mesma forma sem também casar "#123 fecha a fase 2 do projeto"
 * (o `#` tem que vir DEPOIS do verbo).
 */
const PT_CLOSE_VERBS = [
  "fecha",
  "fecham",
  "fechando",
  "corrige",
  "corrigem",
  "corrigindo",
  "resolve",
  "resolvem",
  "resolvendo",
  "encerra",
  "encerram",
  "encerrando",
];

const EN_CLOSE_KEYWORDS = [
  "close",
  "closes",
  "closed",
  "fix",
  "fixes",
  "fixed",
  "resolve",
  "resolves",
  "resolved",
];

function extractIssueNumbersByVerb(body, verbs) {
  if (typeof body !== "string" || body.length === 0) return [];
  // Captura a "cauda" inteira depois do verbo — permite "Fecha #10 e #11"
  // (múltiplas issues no mesmo verbo), cada repetição do grupo exigindo até
  // 20 chars sem quebra de linha nem outro `#` antes do próximo `#<número>`.
  // A quebra de linha corta a cauda de propósito (evita colar o verbo de uma
  // frase com o `#` de um parágrafo seguinte não relacionado).
  const re = new RegExp(`\\b(?:${verbs.join("|")})\\b((?:[^\\n#]{0,20}#\\d+)+)`, "gi");
  const nums = new Set();
  let match;
  while ((match = re.exec(body)) !== null) {
    const numRe = /#(\d+)/g;
    let numMatch;
    while ((numMatch = numRe.exec(match[1])) !== null) {
      nums.add(Number(numMatch[1]));
    }
  }
  return [...nums];
}

/** Issues que o corpo declara fechar em PORTUGUÊS (`Fecha #N` e variantes). */
export function extractPtCloseIssueNumbers(body) {
  return extractIssueNumbersByVerb(body, PT_CLOSE_VERBS);
}

/** Issues que o corpo já declara fechar com a palavra-chave em INGLÊS que o GitHub reconhece. */
export function extractEnCloseIssueNumbers(body) {
  return extractIssueNumbersByVerb(body, EN_CLOSE_KEYWORDS);
}

/**
 * Computa o texto a ANEXAR ao corpo da PR para que o GitHub feche, ao merge,
 * toda issue que o corpo já declara fechar em português mas ainda não em
 * inglês. Retorna `null` quando nada precisa mudar — corpo sem referência em
 * português (passa intocado), ou issue que já tem a palavra-chave em inglês
 * para o MESMO número (nunca duplica). Nunca REMOVE nem reescreve o texto em
 * português — a issue #6920 é explícita: a forma em português é boa
 * comunicação, o defeito é só a ausência do gatilho que o GitHub entende.
 */
export function computeCloseKeywordAddendum(body) {
  const ptNums = extractPtCloseIssueNumbers(body);
  if (ptNums.length === 0) return null;
  const enNums = new Set(extractEnCloseIssueNumbers(body));
  const missing = ptNums.filter((n) => !enNums.has(n));
  if (missing.length === 0) return null;
  return missing.map((n) => `Closes #${n}`).join("\n");
}

/** Extrai o número da PR de uma URL `https://github.com/{org}/{repo}/pull/{n}`. */
export function extractPrNumberFromUrl(prUrl) {
  const match = /\/pull\/(\d+)/.exec(typeof prUrl === "string" ? prUrl : "");
  return match ? Number(match[1]) : null;
}

/**
 * Lê o corpo atual da PR recém-criada via `gh pr view`, computa o addendum
 * (função pura acima) e, se necessário, anexa via `gh pr edit --body`. Corrige
 * em vez de reclamar (Passo 2a da #6920) — o texto em português continua
 * sendo o que o humano lê, o `Closes #N` em inglês é só o que falta pro
 * GitHub entender. Fail-soft total: qualquer erro (gh indisponível, PR
 * deletada entre create e este passo, JSON malformado) nunca propaga — este
 * hook não pode bloquear nem atrasar a criação da PR, que já aconteceu.
 */
export function ensureCloseKeywords(prUrl, { execFn = execFileSync } = {}) {
  try {
    const num = extractPrNumberFromUrl(prUrl);
    if (!num) return { applied: false, reason: "no-pr-number" };
    const body = execFn("gh", ["pr", "view", String(num), "--json", "body", "-q", ".body"], {
      encoding: "utf8",
    });
    const addendum = computeCloseKeywordAddendum(body);
    if (!addendum) return { applied: false, reason: "not-needed" };
    const newBody = `${body.replace(/\s+$/, "")}\n\n${addendum}\n`;
    execFn("gh", ["pr", "edit", String(num), "--body", newBody], { encoding: "utf8" });
    return { applied: true, addendum };
  } catch {
    return { applied: false, reason: "error" };
  }
}

/**
 * #6298 fix 2: reconfere se o comando que gerou este `PostToolUse` é de fato
 * um `gh pr create` — o `if: "Bash(gh pr create*)"` de `.claude/settings.json`
 * é o filtro documentado (ver cabeçalho do arquivo), mas a issue #6298
 * observou o hook disparar mesmo assim para um `gh pr comment` isolado, sem
 * confirmar a causa raiz na camada do harness. Em vez de confiar só nesse
 * `if`, o hook reconfere o próprio `payload.tool_input.command`.
 *
 * `stripQuotedSpans`/o regex de âncora são DUPLICADOS (não importados) de
 * `.claude/hooks/block-gh-pr-merge-subagent.mjs` (`stripQuotedSpans` +
 * `isGhPrMergeCommand`), que resolve exatamente a mesma classe de problema
 * pra `gh pr merge`: distinguir um comando REAL (início da string, ou depois
 * de separador `&&`/`;`/`|`/`||`/newline) de uma MENÇÃO à mesma string dentro
 * de aspas (ex: um `--body`/`--title` citando "gh pr create" como texto,
 * inclusive o PRÓPRIO corpo desta issue #6298, que cita o comando exato).
 * Duplicar em vez de importar é o padrão já estabelecido entre os dois hooks
 * — ambos são self-contained por design (nenhum import de `scripts/*.ts`,
 * ver docblock do topo deste arquivo: um import estático de `.ts` quebraria o
 * hook inteiro, silenciosamente, num Node sem type-stripping nativo). Manter
 * os dois em sincronia à mão; cada lado tem seu próprio arquivo de teste.
 */
export function stripQuotedSpans(command) {
  let result = "";
  let i = 0;
  const n = command.length;
  while (i < n) {
    const ch = command[i];
    if (ch === "'") {
      let j = i + 1;
      while (j < n && command[j] !== "'") j++;
      i = j + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < n && command[j] !== '"') {
        if (command[j] === "\\") j++;
        j++;
      }
      i = j + 1;
      continue;
    }
    result += ch;
    i++;
  }
  return result;
}

/**
 * Classifica `command` quanto a ser (ou não) um `gh pr create` REAL — só no
 * início da string ou depois de separador de comando (`&&`/`;`/`|`/`||`/
 * newline). Ver docstring de `stripQuotedSpans` acima para o porquê da
 * duplicação da lógica de parsing com `isGhPrMergeCommand`.
 *
 * **Finding do fleet review pós-#6298 (confiança alta, P2):** este espelho de
 * `isGhPrMergeCommand` reusava também o CONTRATO boolean dele — mas a
 * polaridade em que os dois são consumidos é OPOSTA. Em
 * `block-gh-pr-merge-subagent.mjs`, `false` no comando ausente implementa
 * fail-OPEN corretamente sozinho (nenhum bloqueio por falta de dado). Aqui, o
 * fail-safe correto é o INVERSO — comando ausente tem que continuar
 * permissivo (emitir a instrução) —, então antes desta mudança o call site
 * (`shouldEmitReviewInstruction`) precisava de um `typeof command ===
 * "string" &&` só pra não deixar esta função decidir sozinha sobre um dado
 * que ela não tinha. Um `false` sozinho não distinguia "sei que NÃO é `gh pr
 * create`" de "não sei, o campo não veio" — quem carregava essa distinção era
 * o call site, não o contrato da função; "simplificar" removendo o `typeof`
 * (parece redundante à primeira vista, já que a função trata non-string)
 * inverteria o fail-safe e reabriria o #6298.
 *
 * Por isso o retorno deixou de ser boolean: três estados explícitos,
 * `"create"` | `"not-create"` | `"unknown"` (comando ausente/não-string) — o
 * chamador trata `"unknown"` como permissivo SEM precisar checar `typeof`
 * primeiro (ver `resolveEmitDecision`/`shouldEmitReviewInstruction` abaixo).
 * `isGhPrMergeCommand` no hook irmão continua boolean de propósito (sua
 * polaridade de fail-open já está correta como boolean) — os dois NÃO são
 * mais contract-idênticos, só compartilham `stripQuotedSpans`/o regex de
 * âncora, que seguem sincronizados à mão como antes.
 */
export function isGhPrCreateCommand(command) {
  if (typeof command !== "string") return "unknown";
  const stripped = stripQuotedSpans(command);
  return /^\s*gh\s+pr\s+create\b|(?:&&|;|\|\||\||\n)\s*gh\s+pr\s+create\b/.test(stripped)
    ? "create"
    : "not-create";
}

/**
 * Regex só de DETECÇÃO (não de extração) de uma URL de PR com fragmento de
 * comentário/review — usado só por `resolveEmitDecision` pra distinguir a
 * razão (a) "não há URL de PR nenhuma" de (b) "há URL, mas é de
 * comentário/review", quando `extractCreatedPrUrl` já devolveu `null` pras
 * duas. Deliberadamente mais simples que o regex de extração (sem o guard
 * anti-backtracking `(?!\d)`): aqui só interessa SE existe, nunca o valor
 * exato capturado.
 */
const PR_URL_WITH_COMMENT_FRAGMENT_RE =
  /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+#(?:issuecomment-\d+|discussion_r\d+|pullrequestreview-\d+)/;

/**
 * Finding do fleet review pós-#6298 (confiança alta, P2): `shouldEmitReviewInstruction`
 * devolvia `null` pra três razões indistinguíveis — (a) não há URL de PR na
 * saída, (b) a URL é de comentário/review, (c) o comando não é `gh pr
 * create` — e o call site de produção (`if (prUrl) {...}` sem `else`) nunca
 * observava qual. Uma supressão CORRETA (b, comentário) e uma potencialmente
 * INCORRETA (c, edge case de comando não reconhecido classificando errado
 * uma PR genuína) produziam o mesmo silêncio. Isso importa porque a #6298
 * registra que a causa raiz na camada do harness nunca foi confirmada — é
 * exatamente esse tipo de silêncio que vai precisar ser diagnosticado nesse
 * cenário de novo.
 *
 * `resolveEmitDecision` é o núcleo decisório completo, com o motivo explícito
 * — `reason` é `"no_pr_url"` | `"comment_or_review_url"` |
 * `"not_gh_pr_create"` | `"ok"`. `shouldEmitReviewInstruction` (abaixo) segue
 * existindo como wrapper fino só com `.prUrl`, pra não quebrar quem só
 * precisa saber SE deve disparar.
 */
export function resolveEmitDecision(toolResponseText, command) {
  const prUrl = extractCreatedPrUrl(toolResponseText);
  if (!prUrl) {
    const text = typeof toolResponseText === "string" ? toolResponseText : "";
    const reason = PR_URL_WITH_COMMENT_FRAGMENT_RE.test(text) ? "comment_or_review_url" : "no_pr_url";
    return { prUrl: null, reason };
  }
  const commandState = isGhPrCreateCommand(command);
  if (commandState === "not-create") return { prUrl: null, reason: "not_gh_pr_create" };
  return { prUrl, reason: "ok" };
}

/**
 * Decisão pura combinando os dois fixes do #6298: existe uma URL de PR
 * genuinamente criada (fix 1) E, quando o comando está disponível no payload,
 * ele de fato é um `gh pr create` (fix 2)? Retorna a URL a usar, ou `null`
 * quando não deve disparar. Wrapper fino sobre `resolveEmitDecision` — ver lá
 * pro motivo da supressão, quando precisar dele.
 *
 * **Direção do fail-safe, deliberada:** este hook é `PostToolUse` e nunca
 * pode bloquear nada — só ADICIONA contexto. Errar para "não disparou" custa
 * uma PR sem review, o que é PIOR que um review a mais (o custo que motivou
 * a #6298). Por isso `command` ausente do payload (campo não populado —
 * formato de payload mais antigo, ou falha de extração) degrada para
 * PERMISSIVO via `isGhPrCreateCommand` resolvendo `"unknown"` (nunca
 * `"not-create"`): decide só pela URL, exatamente como o comportamento
 * pré-#6298. Só quando o comando está presente E resolve `"not-create"` é
 * que o fix 2 nega o disparo — nunca por ausência do campo.
 */
export function shouldEmitReviewInstruction(toolResponseText, command) {
  return resolveEmitDecision(toolResponseText, command).prUrl;
}

/**
 * Finding do fleet review pós-#6298 (confiança alta, P2, mesmo achado de
 * `resolveEmitDecision`): loga a RAZÃO de uma supressão em
 * `data/run-log.jsonl` (mesmo arquivo/formato de `logEffortDecision`,
 * message `review_instruction_suppressed`) — sem isto, os 3 motivos de
 * `shouldEmitReviewInstruction` devolver `null` continuavam indistinguíveis
 * do lado de fora, mesmo com `resolveEmitDecision` já os separando
 * internamente. Chamado pelo entrypoint CLI pra TODO `reason !== "ok"`, não
 * só pro caminho (c) `not_gh_pr_create` — que é o mecanismo NOVO desta PR e o
 * mais provável de ter edge case não coberto, mas os outros dois custam
 * quase nada a mais pra logar e fecham a mesma lacuna de observabilidade.
 *
 * Fail-soft, mesmo contrato de `logEffortDecision`: uma falha ao logar nunca
 * pode propagar nem bloquear o hook. `command` é truncado (500 chars) antes
 * de gravar — evita inflar `run-log.jsonl` com um `--body` de PR gigante.
 */
export function logSuppressedReviewInstruction(
  { reason, command },
  { repoRoot = resolveMainRepoRoot(), appendFn = appendFileSync, mkdirFn = mkdirSync } = {},
) {
  try {
    const event = {
      timestamp: new Date().toISOString(),
      edition: null,
      stage: null,
      agent: "code-review",
      level: "info",
      message: "review_instruction_suppressed",
      details: {
        reason,
        command: typeof command === "string" ? command.slice(0, 500) : null,
      },
    };
    const logPath = join(repoRoot, "data", "run-log.jsonl");
    mkdirFn(dirname(logPath), { recursive: true });
    appendFn(logPath, JSON.stringify(event) + "\n", "utf8");
  } catch {
    // Swallow everything, same contract as logEffortDecision above.
  }
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
      const command = payload.tool_input?.command;
      const { prUrl, reason: emitReason } = resolveEmitDecision(resp, command);
      if (prUrl) {
        // #6920: corrige "Fecha #N" (não reconhecido pelo GitHub) anexando
        // "Closes #N" ANTES do review — melhor esforço, nunca bloqueia o
        // resto do hook se falhar (fail-soft dentro de ensureCloseKeywords).
        ensureCloseKeywords(prUrl);
        // #5156: repassa o session_id deste hook (a sessão que rodou `gh pr create`)
        // pra resolveEffort — permite que isOvernightRoundActive discrimine
        // marker com session_id sem quebrar o caminho default (marker sem
        // session_id ignora o argumento).
        const { effort, warning, reason } = resolveEffort(prUrl, undefined, undefined, payload.session_id);
        logEffortDecision({ prUrl, effort, reason }); // #4252
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PostToolUse",
              additionalContext: buildReviewInstruction(prUrl, effort, warning),
            },
          }),
        );
      } else {
        // Fleet review pós-#6298 (finding #2): torna a supressão observável —
        // ver docstring de logSuppressedReviewInstruction acima.
        logSuppressedReviewInstruction({ reason: emitReason, command });
      }
    } catch {
      // Swallow everything: a hook that errors must not block the PR creation.
    }
  });
}
