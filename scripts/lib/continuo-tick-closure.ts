/**
 * continuo-tick-closure.ts (#7130)
 *
 * O contínuo mediu (#6908, rodada 02/09) que 2 de 3 ticks longos produziram
 * trabalho real e não fecharam o laço: sem claim, sem commit, sem PR — a
 * árvore de trabalho ficou suja no checkout COMPARTILHADO (#6952: 498 linhas
 * nunca commitadas). O guard existente (#6922, `session-registry.ts end`)
 * só protege quando o tick chega a chamar `end` — o modo de falha medido é
 * justamente o tick não chegar lá (processo morto, budget estourado, crash).
 *
 * Este módulo implementa a "direção 3" da issue (#7130) de forma mecânica,
 * não em prosa: em vez de confiar que o PRÓXIMO tick vai lembrar de checar
 * `git status` antes de mexer em qualquer coisa, `rescueOrphanedWork`
 * detecta árvore suja no checkout compartilhado e a MOVE pra uma branch
 * dedicada (commit local, nunca descartado) — preservando o trabalho e
 * limpando a árvore antes que outra sessão rode `git add -A`/`git commit`
 * e publique o trabalho alheio na PR errada (o efeito colateral citado
 * na issue de origem).
 *
 * Chamado a partir do Passo 0 de `.claude/skills/diaria-continuo/SKILL.md`
 * e do passo 1 (§1) de `hermes/skills/hermes-diaria-continuo/SKILL.md`,
 * SEMPRE antes de `scripts/sync-code.ts` (que também mexe em stash — rodar
 * a recuperação primeiro evita que um `git stash` do sync misture o
 * trabalho órfão com o dele; ver `scripts/rescue-continuo-orphaned-work.ts`
 * pro CLI wrapper).
 *
 * Só cuida do checkout COMPARTILHADO — nunca roda dentro de um worktree de
 * subagente (`.claude/worktrees/agent-*`), que tem ciclo de vida próprio e
 * não é lido pela `sync-code.ts`/pelo loop do contínuo.
 *
 * Design DI (mesmo padrão de `scripts/lib/git-sync.ts`, #2699): todo comando
 * `git` passa por um `spawn` injetável — testável sem tocar git real.
 */

import { randomBytes } from "node:crypto";
import type { GitSpawnFn as SpawnFn, SpawnResult } from "./spawn-types.ts";
import { createFileLock, defaultSpawn as gitDefaultSpawn, type SyncLock } from "./git-sync.ts";

export type { SpawnFn, SpawnResult, SyncLock };

/** Reusa o spawner de produção de `git-sync.ts` (mesmo `cwd: REPO_ROOT`,
 * #2699 item 1 — nunca `process.cwd()`). */
export const defaultSpawn: SpawnFn = gitDefaultSpawn;

/** `true` quando `git status --porcelain` reporta QUALQUER path (staged,
 * unstaged ou untracked) — puro, sem I/O. */
export function hasUncommittedWork(porcelain: string): boolean {
  return porcelain.trim().length > 0;
}

export interface RescueBranchPlan {
  branchName: string;
  commitMessage: string;
}

/** Discriminador curto (`<pid>-<4 hex aleatórios>`) para desempatar branches
 * de rescue no mesmo segundo — ver docstring de `planRescueBranch`. */
function randomDiscriminator(): string {
  return `${process.pid}-${randomBytes(2).toString("hex")}`;
}

/** Nome de branch a partir de um timestamp ISO (granularidade de segundo) +
 * um discriminador curto — dedicado (`continuo/rescue-*`), nunca reusa
 * `continuo/fix-*`/`continuo/batch-*` (item 2 de
 * `context/overnight-dispatch-rules.md`) porque esta branch não corresponde
 * a nenhuma issue conhecida — é o próprio propósito dela: um achado, não uma
 * unidade de trabalho planejada.
 *
 * O discriminador (`<pid>-<4 hex aleatórios>`) existe porque o timestamp
 * sozinho só tem granularidade de SEGUNDO (#7130 review, finding 2) — dois
 * resgates no mesmo segundo (ex: a sessão interativa e o cron do hermes
 * acordando quase juntos, sobretudo agora que `rescueOrphanedWork` serializa
 * via lock e o 2º resgate roda logo em seguida ao 1º liberar) colidiriam em
 * `git checkout -b` (`already exists`) sem ele. PID sozinho não bastaria —
 * processos diferentes podem reciclar o mesmo PID entre chamadas; o sufixo
 * aleatório fecha essa lacuna sem exigir estado compartilhado. O nome
 * continua ORDENÁVEL por tempo (o timestamp ainda é o prefixo) — o
 * discriminador só desempata quando o segundo colide, nunca embaralha a
 * ordem cronológica de dois resgates em segundos diferentes. */
export function planRescueBranch(nowIso: string, discriminator: string = randomDiscriminator()): RescueBranchPlan {
  const stamp = nowIso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const branchName = `continuo/rescue-${stamp}-${discriminator}`;
  const commitMessage =
    `chore(#7130): recupera trabalho órfão de tick do contínuo interrompido\n\n` +
    `Commit automático de \`rescue-continuo-orphaned-work.ts\` — a árvore de ` +
    `trabalho do checkout compartilhado estava suja sem PR aberto nem status ` +
    `terminal registrado para o tick que a produziu (ver #7130). Preservado ` +
    `numa branch dedicada para triagem manual; NÃO mergear sem revisão humana ` +
    `— a origem exata (qual issue, qual tick) é desconhecida por construção.`;
  return { branchName, commitMessage };
}

export type RescueOutcome =
  | { outcome: "clean"; message: string }
  | { outcome: "rescued"; branch: string; message: string; checkoutBackFailed: boolean }
  | { outcome: "rescue_failed"; message: string }
  | { outcome: "conflict_markers_found"; message: string; files: string[] };

/**
 * Extrai (puro, sem I/O) os caminhos de arquivo únicos de um stdout de
 * `git grep -n` (formato `path:line:conteúdo`) — usado por
 * `detectConflictMarkers` para reportar QUAIS arquivos carregam marcador de
 * conflito, sem depender de reprocessar o grep. Corta na primeira ocorrência
 * de `:` — path com `:` literal no nome (raro, praticamente inédito neste
 * repo) sairia truncado, aceito como limitação desta rede de segurança
 * (#8639): o objetivo é nomear o(s) arquivo(s) suspeitos pra investigação
 * manual, não parsear `git grep` de forma bulletproof contra qualquer nome
 * de arquivo adversarial.
 */
export function parseConflictMarkerFiles(grepStdout: string): string[] {
  const files = new Set<string>();
  for (const line of grepStdout.split("\n")) {
    if (!line.trim()) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    files.add(line.slice(0, idx));
  }
  return [...files].sort();
}

/**
 * #8639: detecta marcador de conflito de merge LITERAL (`<<<<<<<`/`>>>>>>>`
 * no início de linha) em qualquer arquivo da árvore suja — tracked
 * modificado OU untracked (`--untracked`, sem o quê um placeholder novo com
 * marcador escaparia). Rede de segurança independente da causa raiz exata:
 * o incidente de origem (#8639, commit 3d54dcf20) veio de um `git stash pop`
 * conflitante deixando `<<<<<<< Updated upstream` / `>>>>>>> Stashed
 * changes` em `scripts/lib/diaria-subscribers-db.ts` — mas esta checagem
 * pega QUALQUER origem de marcador (stash pop, merge malsucedido, cherry-
 * pick, edição manual acidental), não só aquele caminho específico.
 *
 * Usa só `<<<<<<<`/`>>>>>>>` como sinal (nunca `=======` sozinho) — um
 * `=======` isolado é comum em markdown (sublinhado de título nível 1
 * setext) e sozinho daria falso positivo; exigir as DUAS âncoras do
 * conflito no mesmo arquivo é o mesmo critério que `git-sync.ts` (#6668)
 * já usa via `findUnmergedPaths`/status porcelain, só que aqui é detecção
 * por CONTEÚDO (necessária porque, neste ponto, `git status --porcelain`
 * já não distingue mais "arquivo com marcador" de "arquivo modificado
 * normal" — o `stash pop` conflitante já terminou, os arquivos já estão
 * `M`/`??` como qualquer outra mudança).
 *
 * Fail-open na ausência de sinal, mesmo espírito de `findUnmergedPaths`
 * (`git-sync.ts`, #6668): se o `git grep` falhar por qualquer motivo que
 * não seja "sem match" (status 0 = achou, 1 = não achou — convenção padrão
 * de grep), trata como "nenhum marcador confirmado" e deixa o rescue
 * prosseguir — o objetivo desta rede de segurança é pegar o caso concreto
 * medido no #8639, não travar o rescue inteiro por uma falha não-relacionada
 * do próprio `git grep`.
 */
export function detectConflictMarkers(spawn: SpawnFn): { found: boolean; files: string[] } {
  const res = spawn("git", [
    "grep",
    "-I",
    "-n",
    "-e",
    "^<<<<<<< ",
    "-e",
    "^>>>>>>> ",
    "--untracked",
    "--",
    ".",
  ]);
  if (res.status !== 0) {
    return { found: false, files: [] };
  }
  return { found: true, files: parseConflictMarkerFiles(res.stdout) };
}

/**
 * Verifica o checkout compartilhado e, se sujo, recupera o trabalho numa
 * branch dedicada. Idempotente/seguro em árvore limpa (`outcome: "clean"`,
 * nenhum comando além do `git status` é executado). Nunca lança — qualquer
 * falha de comando git vira `"rescue_failed"` com a mensagem do stderr, sem
 * tentar mais nada depois (fail loud, não fail silencioso: quem chama este
 * módulo trata `rescue_failed` como bloqueio, não como warning ignorável —
 * ver docstring de `scripts/rescue-continuo-orphaned-work.ts`).
 *
 * PREMISSA DE QUANDO ISTO RODA (#7130 review, finding 3 — não corrigido em
 * código, só documentado): este módulo assume que só é chamado em fronteiras
 * VERDADEIRAS de reentrada do loop contínuo — o Passo 0/§1 das duas skills
 * que o consomem (ver cabeçalho do arquivo), nunca no MEIO de um tick com
 * trabalho legítimo ainda não commitado. É uma premissa razoável e
 * consistente com o guard já existente (`session-registry.ts end` recusando
 * árvore dirty, #6922), mas NÃO é verificada mecanicamente aqui — este
 * módulo não tem como distinguir "árvore suja porque um tick anterior
 * morreu" de "árvore suja porque ESTE tick, ainda rodando, está no meio de
 * escrever algo". Se um caminho futuro (ex: um passo condicional mal
 * ordenado numa versão futura da skill) chamar `rescueOrphanedWork` no meio
 * de um tick, ele trataria esse trabalho em progresso legítimo como "órfão"
 * e o moveria para uma branch de rescue — dessincronizando o próprio tick
 * que ainda está rodando (ele continuaria operando como se seus arquivos
 * ainda estivessem no working tree, quando na verdade foram movidos para
 * `continuo/rescue-*` e a árvore voltou pra `master` debaixo dele). O lock
 * (ver `lock` abaixo) protege contra DUAS sessões correndo o rescue ao mesmo
 * tempo — não protege contra uma ÚNICA sessão chamando isto cedo demais
 * dentro do próprio tick; essa proteção teria que vir de quem decide QUANDO
 * chamar esta função (as skills), não daqui.
 *
 * @param lock Serializa a sequência status→checkout→add→commit entre
 *   processos concorrentes (#7130 review, finding 1) — reusa o MESMO
 *   mecanismo de `scripts/lib/git-sync.ts` (`resolveSharedLockPath`/
 *   `createFileLock`, compartilhado entre todos os worktrees do mesmo
 *   repositório físico) em vez de inventar um lock novo, porque o risco é
 *   idêntico ao que motivou aquele lock: duas sessões continuo-like (a
 *   interativa `/diaria-continuo` e o cron do hermes no 300) podem
 *   reentrar quase juntas no mesmo checkout compartilhado. Se o lock não for
 *   adquirido, o resgate degrada explicitamente para `"rescue_failed"` — fail
 *   loud, nunca corre a sequência mesmo assim, nunca falha em silêncio (o
 *   trabalho sujo permanece intacto no disco para a próxima tentativa).
 */
export function rescueOrphanedWork(
  spawn: SpawnFn,
  nowIso: string = new Date().toISOString(),
  lock: SyncLock = createFileLock(undefined, spawn),
): RescueOutcome {
  if (!lock.acquire()) {
    return {
      outcome: "rescue_failed",
      message:
        `lock '${lock.path}' já está em uso por outro processo — outra sessão continuo-like (a ` +
        `interativa /diaria-continuo ou o cron do hermes no 300) pode estar reentrando no mesmo ` +
        `checkout compartilhado agora. Recuperação de trabalho órfão ADIADA: nunca corre ` +
        `status→checkout→add→commit concorrente com outro processo (mesma classe de risco que motivou ` +
        `o lock de scripts/lib/git-sync.ts, #7130 review finding 1). Trabalho, se sujo, permanece ` +
        `intacto no disco — tentar novamente no próximo tick.`,
    };
  }

  try {
    const statusRes = spawn("git", ["status", "--porcelain"]);
    if (statusRes.status !== 0) {
      return { outcome: "rescue_failed", message: `git status --porcelain falhou: ${statusRes.stderr.trim()}` };
    }
    if (!hasUncommittedWork(statusRes.stdout)) {
      return { outcome: "clean", message: "checkout compartilhado limpo — nada a recuperar." };
    }

    // #8639: antes de mover QUALQUER coisa pra uma branch de rescue, garante
    // que nenhum arquivo sujo carrega marcador de conflito de merge literal
    // — sinal de um `git stash pop` conflitante (git-sync.ts, #6668) que a
    // árvore ainda não teve chance de resolver. Rodar ANTES do
    // `git checkout -b`: se achar marcador, aborta sem criar branch nenhuma
    // e sem tocar em mais nada — a árvore fica exatamente como estava, pra
    // investigação/resolução manual, em vez de herdar uma decisão de merge
    // às cegas dentro de um commit automático.
    const conflictCheck = detectConflictMarkers(spawn);
    if (conflictCheck.found) {
      return {
        outcome: "conflict_markers_found",
        files: conflictCheck.files,
        message:
          `RESGATE ABORTADO (#8639): ${conflictCheck.files.length} arquivo(s) na árvore suja carregam ` +
          `marcador(es) de conflito de merge literal (<<<<<<< / >>>>>>>) — provável sobra de um ` +
          `'git stash pop' conflitante (git-sync.ts, #6668) que a árvore ainda não teve chance de resolver. ` +
          `Commitar isso às cegas puxaria marcadores de conflito pro histórico do repo (incidente de origem: ` +
          `commit 3d54dcf20, #8639). Resolver manualmente antes de rodar o rescue de novo: ` +
          `${conflictCheck.files.join(", ")}.`,
      };
    }

    const plan = planRescueBranch(nowIso);

    const branchRes = spawn("git", ["checkout", "-b", plan.branchName]);
    if (branchRes.status !== 0) {
      return {
        outcome: "rescue_failed",
        message:
          `git checkout -b ${plan.branchName} falhou (${branchRes.stderr.trim()}) — trabalho AINDA sujo no ` +
          `checkout compartilhado, sem recuperação. Investigar manualmente antes de qualquer git add/commit.`,
      };
    }

    const addRes = spawn("git", ["add", "-A"]);
    if (addRes.status !== 0) {
      return {
        outcome: "rescue_failed",
        message:
          `git add -A falhou (${addRes.stderr.trim()}) na branch ${plan.branchName} — trabalho parcialmente ` +
          `movido, investigar manualmente ('git status', 'git checkout master' só depois de resolver).`,
      };
    }

    const commitRes = spawn("git", ["commit", "-m", plan.commitMessage]);
    if (commitRes.status !== 0) {
      return {
        outcome: "rescue_failed",
        message:
          `git commit falhou (${commitRes.stderr.trim()}) na branch ${plan.branchName} — trabalho staged mas ` +
          `NÃO commitado, investigar manualmente antes de trocar de branch.`,
      };
    }

    const backRes = spawn("git", ["checkout", "master"]);
    const checkoutBackFailed = backRes.status !== 0;

    return {
      outcome: "rescued",
      branch: plan.branchName,
      checkoutBackFailed,
      message: checkoutBackFailed
        ? `Trabalho órfão recuperado e commitado em ${plan.branchName}, MAS 'git checkout master' pós-rescue ` +
          `falhou (${backRes.stderr.trim()}) — o checkout compartilhado ainda está na branch de rescue; trocar ` +
          `manualmente antes de qualquer outra sessão continuar. Push + 'gh pr create' seguem necessários.`
        : `Trabalho órfão recuperado e commitado em ${plan.branchName}. Checkout compartilhado limpo (voltou pra ` +
          `master). Push + 'gh pr create' seguem necessários (ou rode o CLI com --push) para o trabalho virar PR ` +
          `triável em vez de só uma branch local.`,
    };
  } finally {
    lock.release();
  }
}

export interface PushOutcome {
  ok: boolean;
  message: string;
}

/** Best-effort: publica a branch de rescue (`git push -u origin {branch}`).
 * Falha aqui NUNCA descarta o commit local já feito por `rescueOrphanedWork`
 * — o trabalho continua seguro na branch, só não está no remoto ainda. */
export function pushRescueBranch(spawn: SpawnFn, branch: string): PushOutcome {
  const pushRes = spawn("git", ["push", "-u", "origin", branch]);
  if (pushRes.status !== 0) {
    return { ok: false, message: `git push falhou (${pushRes.stderr.trim()}) — branch ${branch} só existe local.` };
  }
  return { ok: true, message: `branch ${branch} publicada em origin.` };
}

// ---------------------------------------------------------------------------
// #8588 — guard irmão de `rescueOrphanedWork`: commit(s) DIRETO em `master`
// no checkout compartilhado, sem branch própria.
// ---------------------------------------------------------------------------
//
// `rescueOrphanedWork` acima só detecta árvore SUJA (working tree com
// mudanças não commitadas). A rodada overnight 260921 (#8588) mediu uma
// falha IRMÃ: uma sessão `continuo` chegou a COMMITAR de verdade — 2 vezes —
// direto em `master` no checkout compartilhado (nunca criou/trocou pra uma
// branch `continuo/fix-*` própria antes do commit), deixando `master` local
// à frente de `origin/master` sem PR nenhuma por trás.
//
// Por que isto é sempre anômalo neste repo (nunca falso-positivo esperado):
// TODO merge legítimo acontece via `gh pr merge --squash` no GitHub — o
// checkout LOCAL só recebe esses commits de volta via `sync-code.ts`/`git
// pull` a partir de `origin/master`. Não existe fluxo no repo (auditado:
// `scripts/publish-edition-site-page.ts` e `scripts/lib/memory-sync.ts` são
// os únicos outros `git commit` em `scripts/`, e os dois usam uma branch
// PRÓPRIA — `checkout -B`/outro repositório — nunca `master` local) que
// produza um commit local em `master` ainda não presente em
// `origin/master`. Se isso acontece, é sempre a classe de bug do #8588:
// alguma sessão commitou sem ter saído de `master`.
//
// Mecanismo (mesma forma de `rescueOrphanedWork`): quando o HEAD atual é
// `master`, a árvore está limpa (pré-condição do chamador — este guard não
// decide entre "sujo" e "commit órfão", só constata "há algo a mais em
// `master` que não devia estar aqui" depois que a árvore já está limpa) e
// `origin/master..HEAD` não está vazio, os commits excedentes são movidos
// pra uma branch `continuo/rescue-master-*` dedicada (preservando o
// trabalho, mesmo padrão de `planRescueBranch`) e `master` local é resetado
// de volta pra `origin/master` — nunca DESCARTA um commit, só o realoca pra
// uma branch que pode virar PR pra triagem manual.

/** Nome de branch de rescue ESPECÍFICO pra este guard (`continuo/rescue-
 * master-*`, nunca `continuo/rescue-*` sem sufixo) — deliberadamente
 * distinguível de `planRescueBranch` (árvore suja) na listagem de branches/
 * PRs, porque a origem do achado é diferente (commit já existia vs. diff
 * nunca commitado) e a triagem humana se beneficia de saber qual caso é.
 * Mesmo discriminador (`<pid>-<hex>`) pela mesma razão de colisão de
 * segundo documentada em `planRescueBranch`. */
export function planMasterCommitRescueBranch(
  nowIso: string,
  discriminator: string = randomDiscriminator(),
): RescueBranchPlan {
  const stamp = nowIso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const branchName = `continuo/rescue-master-${stamp}-${discriminator}`;
  const commitMessage =
    `chore(#8588): recupera commit(s) órfão(s) achados direto em master\n\n` +
    `Gerado por 'git branch' automático de rescueOrphanedMasterCommits() — o checkout ` +
    `compartilhado tinha commit(s) locais em master à frente de origin/master, fora do ` +
    `fluxo normal (todo merge legítimo é squash via PR no GitHub, nunca commit local ` +
    `direto). NÃO mergear sem revisão humana — a origem exata (qual issue, qual tick) é ` +
    `desconhecida por construção; ver #8588.`;
  return { branchName, commitMessage };
}

export type MasterCommitRescueOutcome =
  | { outcome: "clean"; message: string }
  | { outcome: "not-applicable"; message: string }
  | { outcome: "rescued"; branch: string; commitShas: string[]; message: string; resetFailed: boolean }
  | { outcome: "rescue_failed"; message: string }
  | { outcome: "fetch_failed"; message: string };

/**
 * Detecta e recupera commits locais em `master` que nunca foram publicados
 * via PR — a classe de bug medida ao vivo no #8588 (sessão `continuo`
 * commitando direto em `master` no checkout compartilhado, 2x na mesma
 * rodada, sem branch própria).
 *
 * PRÉ-CONDIÇÃO do chamador (mesmo padrão de `rescueOrphanedWork`, ver o
 * comentário "PREMISSA DE QUANDO ISTO RODA" acima): chamar isto DEPOIS de
 * `rescueOrphanedWork` já ter deixado a árvore limpa (outcome "clean" ou
 * "rescued" com `checkoutBackFailed: false`) — este guard verifica a
 * limpeza da árvore como defesa extra (nunca confia cegamente no chamador),
 * mas não SABE distinguir "árvore suja de um tick em andamento" de "árvore
 * suja de um tick morto": essa distinção já é resolvida por quem chama
 * `rescueOrphanedWork` primeiro.
 *
 * `outcome: "not-applicable"` quando o HEAD atual não é `master` — este
 * guard é especificamente sobre o branch protegido; um commit numa branch
 * `continuo/fix-*` normal (ainda sem PR aberto) é fluxo de trabalho comum,
 * não uma anomalia, e é coberto por outro mecanismo (`check-branch-issue-
 * consistency.ts`), não por este.
 */
export function rescueOrphanedMasterCommits(
  spawn: SpawnFn,
  nowIso: string = new Date().toISOString(),
  lock: SyncLock = createFileLock(undefined, spawn),
): MasterCommitRescueOutcome {
  if (!lock.acquire()) {
    return {
      outcome: "rescue_failed",
      message:
        `lock '${lock.path}' já está em uso por outro processo — outra sessão continuo-like pode estar ` +
        `reentrando no mesmo checkout compartilhado agora. Recuperação de commit(s) órfão(s) em master ` +
        `ADIADA (mesma disciplina de rescueOrphanedWork, #8588): nunca corre branch→reset concorrente com ` +
        `outro processo. master permanece intocado — tentar novamente no próximo tick.`,
    };
  }

  try {
    const branchRes = spawn("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (branchRes.status !== 0) {
      return { outcome: "rescue_failed", message: `git rev-parse --abbrev-ref HEAD falhou: ${branchRes.stderr.trim()}` };
    }
    const currentBranch = branchRes.stdout.trim();
    if (currentBranch !== "master") {
      return {
        outcome: "not-applicable",
        message: `HEAD atual é '${currentBranch}', não 'master' — fora de escopo deste guard (#8588).`,
      };
    }

    const statusRes = spawn("git", ["status", "--porcelain"]);
    if (statusRes.status !== 0) {
      return { outcome: "rescue_failed", message: `git status --porcelain falhou: ${statusRes.stderr.trim()}` };
    }
    if (hasUncommittedWork(statusRes.stdout)) {
      return {
        outcome: "rescue_failed",
        message:
          `árvore suja em master — pré-condição violada (este guard espera rodar DEPOIS de ` +
          `rescueOrphanedWork já ter limpado a árvore). Não avançando: rode rescueOrphanedWork primeiro.`,
      };
    }

    const fetchRes = spawn("git", ["fetch", "origin", "master"]);
    if (fetchRes.status !== 0) {
      return {
        outcome: "fetch_failed",
        message:
          `git fetch origin master falhou (${fetchRes.stderr.trim()}) — não dá pra comparar master local contra ` +
          `origin/master com segurança (a ref local pode estar velha). Fail-soft: nada foi tocado, tentar de ` +
          `novo no próximo tick.`,
      };
    }

    const revListRes = spawn("git", ["rev-list", "origin/master..HEAD"]);
    if (revListRes.status !== 0) {
      return { outcome: "rescue_failed", message: `git rev-list origin/master..HEAD falhou: ${revListRes.stderr.trim()}` };
    }
    const commitShas = revListRes.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (commitShas.length === 0) {
      return { outcome: "clean", message: "master local já está em paridade com origin/master — nada a recuperar." };
    }

    const plan = planMasterCommitRescueBranch(nowIso);
    const branchCreateRes = spawn("git", ["branch", plan.branchName]);
    if (branchCreateRes.status !== 0) {
      return {
        outcome: "rescue_failed",
        message:
          `git branch ${plan.branchName} falhou (${branchCreateRes.stderr.trim()}) — commit(s) ainda em master ` +
          `local, sem recuperação. master NÃO foi resetado (a branch de rescue precisa existir primeiro).`,
      };
    }

    const resetRes = spawn("git", ["reset", "--hard", "origin/master"]);
    const resetFailed = resetRes.status !== 0;

    return {
      outcome: "rescued",
      branch: plan.branchName,
      commitShas,
      resetFailed,
      message: resetFailed
        ? `Commit(s) preservado(s) em ${plan.branchName} (${commitShas.length} commit(s)), MAS 'git reset --hard ` +
          `origin/master' falhou (${resetRes.stderr.trim()}) — master local AINDA carrega os commits duplicados. ` +
          `Resolver manualmente antes de qualquer outra sessão continuar.`
        : `Commit(s) órfão(s) em master (${commitShas.length}) recuperado(s) em ${plan.branchName}; master local ` +
          `resetado pra paridade com origin/master. Push + 'gh pr create' seguem necessários (ou rode o CLI com ` +
          `--push) para o trabalho virar PR triável em vez de só uma branch local.`,
    };
  } finally {
    lock.release();
  }
}
