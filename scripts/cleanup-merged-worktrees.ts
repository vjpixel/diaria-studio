/**
 * scripts/cleanup-merged-worktrees.ts (#4335, follow-up do #4326)
 *
 * `.claude/worktrees/` acumula worktrees órfãos ao longo do tempo — sessões
 * overnight/develop que usam `isolation: "worktree"` (praticamente todas) e,
 * por algum motivo (crash, mini-rodada que não chegou no passo de cleanup do
 * SKILL.md, sessão interrompida), não removeram o worktree após o merge do
 * PR. O #4326 (fechado 260729c) encontrou 47 acumulados, removeu 31 manualmente
 * — só os com PR mergeada CONFIRMADA via `gh pr list --head {branch} --state
 * merged` (achado do #4326: `git worktree prune`/`git branch --merged` não
 * servem aqui — os merges do repo são sempre squash [#636], então o commit da
 * branch nunca aparece como ancestral de master via `git branch --merged`, e
 * `prunable` do `git worktree list` só marca um worktree cujo DIRETÓRIO já
 * sumiu do disco, nunca um que ainda existe mas cuja branch já foi mergeada).
 *
 * Este script automatiza a mesma checagem: lista os worktrees sob
 * `.claude/worktrees/`, resolve a branch de cada um, confere via `gh pr list
 * --head {branch} --state merged` se existe PR mergeada pra essa branch, e
 * remove (`git worktree remove --force`) os confirmados.
 *
 * **Extensão #5418 — worktrees órfãos além do caso "branch mergeada".** A
 * varredura acima cobre só worktrees com branch nomeada E PR já mergeada
 * confirmada via `gh`. Dois casos ficam de fora, achados numa auditoria de
 * disco (2,3 GB acumulados na máquina Neo, #5418):
 *
 * 1. **Detached HEAD** — worktree sem branch associada (`branch: null` no
 *    porcelain) nunca tem uma branch pra consultar no GitHub, então nunca
 *    entra em `selectMergedForRemoval`.
 * 2. **Branch local já deletada** — worktree cujo registro em
 *    `.git/worktrees/` ainda aponta pra um nome de branch, mas o ref local
 *    (`refs/heads/{branch}`) já não existe (ex: branch deletada manualmente,
 *    ou apagada remotamente e o `git fetch --prune` local levou o ref junto).
 *    `gh pr list --head {branch}` não confirma "mergeada" nesse caso (a
 *    branch já não existe pra ninguém dar merge) — fica preso pra sempre.
 *
 * `selectOrphanedForStaleRemoval` cobre os dois: um worktree é "órfão" quando
 * `branch === null` OU o ref local não existe mais (`branchExistsLocally`
 * retorna false), e só entra na remoção se além disso estiver **stale** —
 * mtime do diretório do worktree mais velho que `ORPHAN_STALE_THRESHOLD_MS`
 * (7 dias, mesmo piso usado em outros guards de staleness do repo). O motivo
 * de não remover um órfão imediatamente (sem o gate de idade) é dar folga a
 * um worktree que acabou de ser criado em detached HEAD por algum fluxo
 * legítimo (ex: `EnterWorktree` isolado) antes de checkout de branch — 7 dias
 * é folga generosa pra qualquer rodada overnight/develop real (que tipicamente
 * fecha no mesmo dia, por política "1 PR aberto por vez").
 *
 * **Decisão deliberada de escopo (documentada no PR #5418, não repetir a
 * pergunta em rodada futura): staleness-based removal NUNCA se aplica a um
 * worktree com branch local ainda existente e sem PR mergeada confirmada** —
 * só ao caso órfão (detached ou branch já deletada) acima. Um worktree com
 * branch viva mas PR ainda aberto pode ser trabalho genuinamente bloqueado
 * (categoria "bloqueada" do overnight/develop) esperando desbloqueio externo
 * por mais de 7 dias — apagar o worktree nesse caso destruiria progresso não
 * commitado ainda ou dificultaria retomar a branch. Isso mantém o convite do
 * item 3 óbvio da issue ("NÃO remover worktree de sessão viva") estendido
 * também a "não remover trabalho não confirmado como morto".
 *
 * Invocado no fim de `/diaria-overnight` e `/diaria-develop` (Fase 2, ver
 * SKILL.md de cada skill) — **FAIL-SOFT por design**: qualquer erro (gh
 * indisponível, permissão negada num diretório, rate limit) NUNCA deve
 * travar o encerramento da sessão. Cada worktree é tratado independentemente
 * — falha num não impede a checagem/remoção dos demais.
 *
 * **Guard de sessão compartilhada (#5156 item 9, redesenhado no #7045).**
 * `.claude/worktrees/` pode ter worktrees vivos de OUTRA sessão
 * `/diaria-overnight`/`/diaria-develop`/`/diaria-continuo` (ou interativa
 * comum) rodando em paralelo (mesma máquina) — um `git worktree remove
 * --force` disparado no meio dessa outra sessão remove um diretório que ela
 * ainda está usando. Antes de varrer, o script consulta
 * `scripts/lib/session-registry.ts` (`listActiveSessions`) e exclui, POR
 * WORKTREE (não a varredura inteira), qualquer worktree cujo nome aparece em
 * `touched_paths`/`dirty_paths` de alguma sessão ATIVA e não-stale — os
 * demais (mergeados, órfãos-stale) seguem avaliados normalmente. **Antes do
 * #7045 o skip era da varredura INTEIRA sempre que existia ≥1 coordenadora
 * ativa** — com o contínuo rodando quase 24/7, isso tornava o script um
 * no-op quase incondicional (achado ao vivo: 51 worktrees acumulados, 28
 * com PR já mergeada, nunca limpos). Ver `selectInUseWorktreeNames`/
 * `filterOutInUseWorktrees` pra lógica pura. O skip da varredura INTEIRA
 * continua existindo só como fallback pro caso do registro de sessões estar
 * ILEGÍVEL (`shouldSkipEntireScanForUnreadableRegistry`) — sem saber quais
 * sessões estão ativas, ser conservador com tudo é o lado certo do
 * fail-soft. `--confirm-shared` prossegue mesmo nesse caso (uso em contexto
 * onde o chamador já confirmou que é seguro). Registro de sessão é **opt-in**
 * (rollout novo, #5156) — nenhuma sessão registrada (diretório vazio) =
 * `inUseNames` vazio, nenhum worktree excluído por uso, comportamento
 * idêntico ao pré-#5156 pra esse guard específico.
 *
 * **#7044 — a implementação do guard (`shouldSkipForSharedSession` +
 * `listActiveSessionsSafe`) migrou pra `scripts/lib/shared-session-guard.ts`**,
 * generalizada pra ser reusada também por `scripts/branch-cleanup.ts` (que
 * remove o MESMO tipo de recurso no MESMO checkout compartilhado e não
 * consultava `session-registry.ts` — P0 do review da PR #7044). Este arquivo
 * mantém `shouldSkipForSharedSession` re-exportado com o mesmo nome/contrato
 * pra não quebrar `test/session-beacon-blast-radius.test.ts` e
 * `test/cleanup-merged-worktrees.test.ts`.
 *
 * Uso:
 *   npx tsx scripts/cleanup-merged-worktrees.ts [--dry-run] [--root <repoRoot>]
 *       [--confirm-shared] [--session-id <id>]
 *
 * `--session-id` (#7304) é injetado por `.claude/hooks/inject-session-id.mjs`
 * e faz a sessão chamadora não se contar como "outra sessão ativa" ao decidir
 * quais worktrees estão em uso — sem ele, cada rodada preserva os próprios
 * worktrees e só limpa os da rodada anterior.
 *
 * Lógica pura (testável sem git/gh reais):
 *   - parseWorktreePorcelain(output) — parseia `git worktree list --porcelain`.
 *   - filterUnderWorktreesDir(entries, worktreesDir) — só os sob
 *     `.claude/worktrees/` (nunca o worktree principal do repo).
 *   - selectMergedForRemoval(entries, isMerged) — dado um checker injetável
 *     `(branch) => boolean`, retorna só os confirmados como mergeados.
 *   - filterOutDirtyWorktrees(entries, isDirty) — #7304: tira os que têm
 *     trabalho não-commitado. "Branch mergeada" não implica "worktree
 *     descartável", e a remoção é `--force`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgsWithTrueDefault as parseArgs, isMainModule } from "./lib/cli-args.ts";
import { listActiveSessions, type SessionRecord } from "./lib/session-registry.ts";
// #7044 + #7048: a extração pro módulo compartilhado vale pro guard PURO
// (`shouldSkipForSharedSession`, re-exportado abaixo e reusado por
// `scripts/branch-cleanup.ts`), mas NÃO pro `listActiveSessionsSafe` — o #7048
// passou a precisar distinguir "registro ILEGÍVEL" de "nenhuma sessão ativa"
// (`ActiveSessionsProbe` abaixo), distinção que a versão compartilhada não
// expressa (ela devolve `[]` nos dois casos). `branch-cleanup.ts` continua
// usando a compartilhada; este arquivo tem a própria, mais rica.
//
// `isCoordinatorKind` saiu dos imports junto: era usado só pela implementação
// LOCAL de `shouldSkipForSharedSession`, que o #7044 substituiu pelo
// re-export.

export interface WorktreeEntry {
  /** Path absoluto do worktree (normalizado com `/`). */
  path: string;
  /** Nome da branch (sem `refs/heads/`), ou `null` se detached/bare. */
  branch: string | null;
  /**
   * `true` se `git worktree list --porcelain` emitiu uma linha `locked` pra
   * este worktree (#7048, review do PR #7048). `git worktree lock` — usado
   * pelo harness pra pinar um worktree a um agent ativo, ex: `locked claude
   * agent {nome} (pid {pid})` — é o sinal MAIS DIRETO de "em uso" que existe:
   * não depende do registro em `data/sessions/` ter sido escrito ainda (um
   * agent recém-despachado que ainda não gravou `touched_paths` teria o
   * worktree elegível a remoção pelo critério de `selectInUseWorktreeNames`
   * sozinho). Um worktree `locked` NUNCA é removido, independente de
   * `touched_paths`/`dirty_paths` — ver `filterOutLockedWorktrees`.
   */
  locked: boolean;
}

/**
 * Parseia a saída de `git worktree list --porcelain`. Blocos separados por
 * linha em branco; cada bloco tem `worktree <path>`, opcionalmente `HEAD
 * <sha>`, um de `branch refs/heads/<nome>` / `detached` / `bare`, e
 * opcionalmente `locked` (sem razão) ou `locked <razão>` (#7048 — ex: `locked
 * claude agent {nome} (pid {pid})`, emitida pelo harness pra worktree pinado
 * a um agent ativo).
 */
export function parseWorktreePorcelain(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let currentPath: string | null = null;
  let currentBranch: string | null = null;
  let currentLocked = false;

  const flush = () => {
    if (currentPath !== null) {
      entries.push({ path: currentPath, branch: currentBranch, locked: currentLocked });
    }
    currentPath = null;
    currentBranch = null;
    currentLocked = false;
  };

  for (const rawLine of output.split("\n")) {
    const line = rawLine.trimEnd();
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) {
      // Uma nova entrada "worktree" antes de uma linha em branco (não deveria
      // acontecer no formato real, mas defensivo): fecha a anterior primeiro.
      if (currentPath !== null) flush();
      currentPath = line.slice("worktree ".length).trim().replace(/\\/g, "/");
    } else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim();
      currentBranch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    } else if (line === "locked" || line.startsWith("locked ")) {
      currentLocked = true;
    }
    // "HEAD <sha>", "detached", "bare", "prunable[...]" — ignorados (branch
    // fica null se nunca setado).
  }
  flush();

  return entries;
}

/** Mantém só os worktrees cujo path está sob `worktreesDir` (nunca o worktree principal do repo). */
export function filterUnderWorktreesDir(entries: WorktreeEntry[], worktreesDir: string): WorktreeEntry[] {
  const normalizedDir = worktreesDir.replace(/\\/g, "/").replace(/\/+$/, "");
  return entries.filter((e) => e.path.startsWith(normalizedDir + "/"));
}

/**
 * Seleciona, dentre os worktrees candidatos, os que devem ser removidos —
 * branch não-nula E `isMerged(branch)` retorna true. `isMerged` é injetável
 * pra testar a lógica de seleção sem chamar `gh` de verdade.
 */
export function selectMergedForRemoval(
  entries: WorktreeEntry[],
  isMerged: (branch: string) => boolean,
): WorktreeEntry[] {
  return entries.filter((e) => e.branch !== null && isMerged(e.branch));
}

/** 7 dias — piso de staleness pra worktree órfão (detached ou branch local já deletada). */
export const ORPHAN_STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Seleciona, dentre os worktrees candidatos que NÃO já foram selecionados por
 * `selectMergedForRemoval`, os que são "órfãos e velhos" (#5418):
 *   - órfão = `branch === null` (detached HEAD) OU `branchExistsLocally(branch)`
 *     retorna false (branch local já foi deletada, mas o worktree ainda
 *     referencia o nome antigo);
 *   - velho = `getMtimeMs(path)` mais antigo que `nowMs - thresholdMs`.
 *
 * `getMtimeMs` retornando `null` (stat falhou — diretório sumiu, permissão
 * negada) nunca conta como stale — fail-soft, mesmo princípio de
 * `checkBranchMergedViaGh` (nunca assume o pior caso na ausência de dado).
 * Worktrees com branch local ainda viva (mesmo sem PR mergeada confirmada)
 * NUNCA entram aqui — ver docblock do topo do arquivo, "Decisão deliberada
 * de escopo".
 */
export function selectOrphanedForStaleRemoval(
  entries: WorktreeEntry[],
  alreadySelected: WorktreeEntry[],
  branchExistsLocally: (branch: string) => boolean,
  getMtimeMs: (path: string) => number | null,
  nowMs: number,
  thresholdMs: number = ORPHAN_STALE_THRESHOLD_MS,
): WorktreeEntry[] {
  const alreadyPaths = new Set(alreadySelected.map((e) => e.path));
  return entries.filter((e) => {
    if (alreadyPaths.has(e.path)) return false;
    const isOrphaned = e.branch === null || !branchExistsLocally(e.branch);
    if (!isOrphaned) return false;
    const mtimeMs = getMtimeMs(e.path);
    if (mtimeMs === null) return false;
    return nowMs - mtimeMs > thresholdMs;
  });
}

// ─── I/O real (fail-soft) ────────────────────────────────────────────────

const GH_TIMEOUT_MS = 10_000;

/**
 * `gh pr list --head {branch} --state merged` — retorna true só se a chamada
 * teve sucesso E encontrou ≥1 PR mergeada. Qualquer falha (gh ausente,
 * timeout, rate limit, JSON inesperado) retorna **false** (fail-soft: never
 * assume merged on error — o pior caso de um falso-negativo aqui é só "não
 * limpou este worktree agora", nunca uma remoção indevida).
 */
export function checkBranchMergedViaGh(branch: string, cwd: string): boolean {
  try {
    const result = spawnSync(
      "gh",
      ["pr", "list", "--head", branch, "--state", "merged", "--json", "number", "--limit", "1"],
      { cwd, encoding: "utf8", timeout: GH_TIMEOUT_MS },
    );
    if (result.status !== 0) return false;
    const parsed = JSON.parse(result.stdout ?? "[]") as unknown[];
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
}

/**
 * `git rev-parse --verify --quiet refs/heads/{branch}` — true só se o ref
 * local ainda existe. Fail-soft: qualquer erro (git ausente, timeout) retorna
 * **true** (nunca assume "branch deletada" na ausência de dado — o pior caso
 * de um falso-positivo aqui é só "não limpou este worktree órfão agora",
 * nunca uma remoção indevida de branch ainda viva).
 */
export function checkBranchExistsLocally(branch: string, cwd: string): boolean {
  try {
    const result = spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
      cwd,
      encoding: "utf8",
      timeout: GH_TIMEOUT_MS,
    });
    return result.status === 0;
  } catch {
    return true;
  }
}

/**
 * mtime (ms) do diretório do worktree, ou `null` se `stat` falhar (sumiu,
 * permissão negada) — fail-soft, nunca lança.
 */
export function getWorktreeMtimeMsSafe(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** `git worktree remove --force {path}` — nunca lança; retorna resultado pro caller logar. */
export function removeWorktreeSafe(path: string, cwd: string): { ok: boolean; error?: string } {
  try {
    const result = spawnSync("git", ["worktree", "remove", "--force", path], {
      cwd,
      encoding: "utf8",
      timeout: GH_TIMEOUT_MS,
    });
    if (result.status !== 0) {
      return { ok: false, error: (result.stderr || result.stdout || `exit ${result.status}`).trim() };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

function listWorktreesSafe(cwd: string): WorktreeEntry[] {
  try {
    const result = spawnSync("git", ["worktree", "list", "--porcelain"], {
      cwd,
      encoding: "utf8",
      timeout: GH_TIMEOUT_MS,
    });
    if (result.status !== 0) {
      console.warn(`[cleanup-merged-worktrees] git worktree list falhou (status ${result.status}): ${result.stderr?.trim()}`);
      return [];
    }
    return parseWorktreePorcelain(result.stdout ?? "");
  } catch (e) {
    console.warn(`[cleanup-merged-worktrees] git worktree list lançou: ${(e as Error).message}`);
    return [];
  }
}

/** #7044 — implementação e docstring completa migraram pra
 * `scripts/lib/shared-session-guard.ts` (reusada agora também por
 * `scripts/branch-cleanup.ts`); re-exportado com o mesmo nome/contrato pra
 * não quebrar `test/session-beacon-blast-radius.test.ts` e
 * `test/cleanup-merged-worktrees.test.ts`. */
export { shouldSkipForSharedSession } from "./lib/shared-session-guard.ts";

/**
 * #7045 — `shouldSkipForSharedSession` acima continua correto como FUNÇÃO
 * PURA (testada em `test/cleanup-merged-worktrees.test.ts` e
 * `test/session-beacon-blast-radius.test.ts`), mas `main()` PARA DE USÁ-LA
 * como gate primário: com o contínuo rodando quase 24/7 (uma coordenadora
 * NÃO-stale sempre presente em `data/sessions/`), o skip GLOBAL fazia a
 * varredura inteira nunca rodar de verdade — 51 worktrees acumulados, 28
 * com PR já mergeada (achado ao vivo #7045). E a própria sessão chamadora
 * conta a si mesma nesse cômputo: uma rodada que chama o cleanup no fim de
 * si mesma se auto-bloqueia, então o guard global era um `return` quase
 * incondicional, não uma proteção condicional.
 *
 * A partir daqui, `main()` pula por-WORKTREE (`selectInUseWorktreeNames` +
 * `filterOutInUseWorktrees` abaixo) em vez de pular a varredura toda: só o
 * worktree cujo caminho aparece em `touched_paths`/`dirty_paths` de alguma
 * sessão ATIVA (qualquer kind — não só coordenadora, um worktree aberto à
 * mão por uma sessão interativa também está "em uso") fica de fora da
 * remoção; todos os outros (mergeados, órfãos-stale) são avaliados
 * normalmente mesmo com o contínuo ativo.
 *
 * **O #7045 achou que isso também fechava o item "ignorar a própria sessão".
 * Não fechava (#7304).** O raciocínio era que o worktree já revisado pela
 * própria rodada "não aparece mais nos `touched_paths` recentes de ninguém"
 * — mas `touched_paths` é cumulativo pela vida do registro, não uma janela
 * recente, então tudo que a coordenadora tocou continua lá até ela encerrar.
 * Resultado medido: cada rodada preservava os próprios worktrees e limpava
 * só os da anterior. A exclusão explícita por `session_id` (parâmetro
 * `excludeSessionId`, alimentado pelo `--session-id` que o hook injeta)
 * é o que de fato fecha o item.
 *
 * `shouldSkipForSharedSession`/`isCoordinatorKind` continuam exportados e
 * usados apenas pelo fallback de registro ILEGÍVEL abaixo
 * (`shouldSkipEntireScanForUnreadableRegistry`) — o único caso em que ser
 * conservador com a varredura INTEIRA ainda é a escolha certa (checklist da
 * issue: "manter o skip global só como fallback pra registro ilegível").
 */

/**
 * Extrai o NOME do worktree (basename de `.claude/worktrees/{nome}/...`) de
 * uma lista de caminhos relativos — mesmo formato gravado em
 * `touched_paths`/`dirty_paths` pelo beacon (`.claude/hooks/session-beacon.mjs`).
 * Aceita `/` e `\` como separador (Windows).
 *
 * **Ancorado em `.claude/worktrees` (#7048, review do PR #7048).** O regex
 * anterior (`/[/\\]worktrees[/\\]([^/\\]+)/`) casava qualquer segmento
 * `worktrees/{algo}` em QUALQUER lugar do path — inclusive fora de
 * `.claude/`, ex: um repo secundário clonado em `some/other/worktrees/foo/`
 * dentro de um `touched_paths` legítimo teria seu `foo` tratado como nome de
 * worktree em `.claude/worktrees/`, potencialmente marcando um worktree
 * homônimo (mas não relacionado) como "em uso" — ou, na direção oposta,
 * nunca casando de fato o path real quando `.claude` viesse antes sem
 * `worktrees` logo depois. Ancorar em `\.claude[/\\]worktrees` garante que só
 * o diretório que este script de fato varre (`filterUnderWorktreesDir`)
 * alimenta o conjunto de exclusão.
 */
export function extractWorktreeNamesFromPaths(paths: string[]): Set<string> {
  const names = new Set<string>();
  const re = /(?:^|[/\\])\.claude[/\\]worktrees[/\\]([^/\\]+)/;
  for (const p of paths) {
    const m = re.exec(p);
    if (m) names.add(m[1]);
  }
  return names;
}

/**
 * Nomes de worktree (basename) EM USO por alguma sessão ATIVA e NÃO-stale —
 * união de `touched_paths`/`dirty_paths` de TODAS as sessões (qualquer
 * `kind`, não só coordenadora: um worktree aberto à mão por uma sessão
 * interativa via `EnterWorktree` também está em uso). Pura, testável sem
 * tocar `data/sessions/` real.
 *
 * **`excludeSessionId` — a própria sessão nunca se protege de si mesma
 * (#7304).** O beacon (`.claude/hooks/session-beacon.mjs`) não emite de
 * dentro de worktree vinculado, então quem grava `.claude/worktrees/{nome}/…`
 * em `touched_paths` é a COORDENADORA rodando no checkout principal: cada
 * Edit/Write dela nos worktrees que ela mesma dispatchou entra no próprio
 * registro. Sem esta exclusão, a rodada que chama o cleanup no fim de si
 * mesma preserva exatamente os worktrees que acabou de terminar de usar —
 * e quem limpa é a rodada SEGUINTE. Medido ao vivo na rodada 260902b: 23
 * removidos no passo 6 (todos de rodadas anteriores), 15 a mais 10min
 * depois, já com o registro encerrado (todos da própria rodada).
 *
 * O docblock de `shouldSkipForSharedSession` afirmava que dava pra dispensar
 * o `session_id` porque a sessão não sabe o próprio — isso vale pro processo,
 * mas não pro comando: `.claude/hooks/inject-session-id.mjs` injeta
 * `--session-id` nos alvos de `SESSION_ID_TARGETS`, e este script passou a
 * ser um deles. Quando a flag não vem (invocação manual fora do hook), o
 * parâmetro fica `undefined` e o comportamento é o anterior, byte a byte.
 */
export function selectInUseWorktreeNames(
  activeSessions: SessionRecord[],
  excludeSessionId?: string,
): Set<string> {
  const names = new Set<string>();
  for (const s of activeSessions) {
    if (s.stale) continue;
    if (excludeSessionId !== undefined && s.sessionId === excludeSessionId) continue;
    const paths = [...(s.touched_paths ?? []), ...(s.dirty_paths ?? [])];
    for (const name of extractWorktreeNamesFromPaths(paths)) names.add(name);
  }
  return names;
}

/** Basename do path do worktree (mesmo formato usado por `extractWorktreeNamesFromPaths`). */
export function worktreeNameFromPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = normalized.lastIndexOf("/");
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

/** Remove de `entries` os worktrees cujo nome está em `inUseNames` — pura. */
export function filterOutInUseWorktrees(entries: WorktreeEntry[], inUseNames: Set<string>): WorktreeEntry[] {
  return entries.filter((e) => !inUseNames.has(worktreeNameFromPath(e.path)));
}

/**
 * Remove de `entries` os worktrees com trabalho NÃO-COMMITADO (#7304) —
 * modificação rastreada ou arquivo untracked. Puro: `isDirty` é injetável.
 *
 * **Por que "branch mergeada" não implica "worktree descartável".** Até aqui
 * a elegibilidade olhava só o histórico (`selectMergedForRemoval` = branch
 * com PR mergeada; `selectOrphanedForStaleRemoval` = órfão + velho) e nunca
 * a working tree — e `removeWorktreeSafe` roda `git worktree remove
 * --force`, que descarta modificação e untracked sem perguntar. Um worktree
 * cuja branch já mergeou mas que ganhou trabalho novo por cima (o padrão de
 * quem continua editando depois do merge) era destruído em silêncio.
 *
 * Não é hipotético: no inventário do #7304, 2 dos 3 worktrees de branch
 * mergeada estavam sujos — um deles com 481 inserções não-commitadas e 3
 * arquivos untracked. Nenhum foi selecionado naquele momento só porque o
 * `gh` não achou PR mergeada pras branches; a proteção era acidental.
 *
 * Este guard é pré-requisito da self-exclusion de `selectInUseWorktreeNames`,
 * não um extra: ao parar de preservar os próprios worktrees, a rodada passa
 * a alcançar exatamente os worktrees recém-usados — os mais prováveis de
 * ter trabalho não-commitado em cima. Sem o guard, o fix do #7304 aumentaria
 * a chance de perda em vez de reduzir.
 *
 * Fail-soft na direção segura: `isDirty` retornando `null` (git falhou,
 * diretório sumiu) conta como SUJO e preserva — o custo de errar aqui é
 * assimétrico (não limpar agora é recuperável; apagar trabalho não é).
 */
export function filterOutDirtyWorktrees(
  entries: WorktreeEntry[],
  isDirty: (path: string) => boolean | null,
): { kept: WorktreeEntry[]; skipped: WorktreeEntry[] } {
  const kept: WorktreeEntry[] = [];
  const skipped: WorktreeEntry[] = [];
  for (const e of entries) {
    if (isDirty(e.path) === false) kept.push(e);
    else skipped.push(e);
  }
  return { kept, skipped };
}

/**
 * `git status --porcelain` no worktree — `true` se há qualquer modificação
 * rastreada ou arquivo untracked, `false` se limpo, `null` se o comando
 * falhou (tratado como sujo por `filterOutDirtyWorktrees`).
 *
 * **Diretório INEXISTENTE devolve `false`, não `null` (review do PR #7317).**
 * Worktree cujo diretório sumiu (apagado à mão, criação que abortou no meio)
 * mas cujos metadados o git ainda lista é um caso real — e é justamente o
 * que `selectOrphanedForStaleRemoval` existe pra limpar. Sem esta distinção,
 * o `spawnSync` falharia por `cwd` inválido, o `null` seria lido como "sujo"
 * e a entrada ficaria **impossível de limpar pra sempre** — o guard de
 * sujeira teria criado um vazamento novo justamente no caminho que ele não
 * precisa proteger: não há trabalho a preservar num diretório que não
 * existe. `null` fica reservado ao caso genuinamente ambíguo: o diretório
 * está lá e mesmo assim o git não conseguiu responder (repo corrompido,
 * permissão, timeout) — aí preservar é o certo.
 *
 * **Limite conhecido:** `git status --porcelain` no modo default não lista
 * arquivo ignorado por `.gitignore`. Trabalho real que viva só num caminho
 * ignorado não é detectado como sujo. Aceito: conteúdo ignorado não é
 * produto versionável, e incluir `--ignored` marcaria como sujo todo
 * worktree com `node_modules/`, o que na prática desligaria o cleanup.
 */
export function isWorktreeDirtySafe(path: string): boolean | null {
  try {
    if (!existsSync(path)) return false;
    const result = spawnSync("git", ["status", "--porcelain"], {
      cwd: path,
      encoding: "utf8",
      timeout: GH_TIMEOUT_MS,
    });
    if (result.status !== 0) return null;
    return (result.stdout ?? "").trim().length > 0;
  } catch {
    return null;
  }
}

/**
 * Remove de `entries` os worktrees marcados `locked` pelo git (#7048, review
 * do PR #7048) — nunca elegíveis a remoção, independente de
 * `touched_paths`/`dirty_paths`. `git worktree lock` é o sinal mais direto de
 * "em uso" disponível: cobre a janela entre um agent ser despachado e ele
 * escrever seu primeiro `touched_paths` no session-registry, janela em que
 * `selectInUseWorktreeNames` sozinho não protegeria o worktree.
 */
export function filterOutLockedWorktrees(entries: WorktreeEntry[]): WorktreeEntry[] {
  return entries.filter((e) => !e.locked);
}

/**
 * Único caso em que pular a varredura INTEIRA continua sendo a escolha
 * certa (#7045 checklist item 3): registro de sessões ILEGÍVEL (exceção não
 * prevista em `listActiveSessions`, distinto de "diretório vazio, nenhuma
 * sessão rodando" — esse caso normal nunca pula nada). Sem saber quais
 * sessões estão ativas, não dá pra calcular `selectInUseWorktreeNames` com
 * segurança — ser conservador aqui é o lado certo do fail-soft (nunca
 * remover worktree às cegas). `confirmShared` prossegue mesmo assim, uso em
 * contexto onde o chamador já confirmou que é seguro.
 */
export function shouldSkipEntireScanForUnreadableRegistry(registryReadable: boolean, confirmShared: boolean): boolean {
  return !registryReadable && !confirmShared;
}

interface ActiveSessionsProbe {
  sessions: SessionRecord[];
  /** `false` só quando `listActiveSessions` lançou — nunca quando o
   *  diretório está simplesmente vazio (isso é `sessions: []` normal). */
  readable: boolean;
}

function listActiveSessionsSafe(repoRoot: string): ActiveSessionsProbe {
  try {
    return { sessions: listActiveSessions(repoRoot), readable: true };
  } catch (e) {
    console.warn(
      `[cleanup-merged-worktrees] listActiveSessions lançou (registro ILEGÍVEL, tratando como indeterminado — fallback conservador): ${(e as Error).message}`,
    );
    return { sessions: [], readable: false };
  }
}

function main(): void {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = args.root ? resolve(String(args.root)) : ROOT;
  const dryRun = args["dry-run"] === "true";
  const confirmShared = args["confirm-shared"] === "true";
  // #7304: injetado por `.claude/hooks/inject-session-id.mjs`; ausente numa
  // invocação manual, e aí o comportamento é o de antes (nada é excluído).
  const ownSessionId = args["session-id"] ? String(args["session-id"]) : undefined;
  const worktreesDir = resolve(repoRoot, ".claude", "worktrees").replace(/\\/g, "/");

  // Fail-soft de topo: qualquer exceção não prevista aqui é logada como
  // warning e o script sai 0 — este step nunca deve travar o encerramento
  // da sessão overnight/develop que o invoca (#4335, requisito explícito).
  try {
    const probe = listActiveSessionsSafe(repoRoot);
    if (shouldSkipEntireScanForUnreadableRegistry(probe.readable, confirmShared)) {
      console.warn(
        "[cleanup-merged-worktrees] registro de sessões em data/sessions/ ilegível — pulando a varredura INTEIRA de " +
          ".claude/worktrees/ por segurança (fallback conservador, #7045): sem saber quais sessões estão ativas não " +
          "dá pra decidir com segurança quais worktrees estão em uso. Rode de novo com --confirm-shared se já " +
          "confirmou que é seguro prosseguir mesmo assim.",
      );
      return;
    }

    // #7045: pular por-WORKTREE (não a varredura inteira) — só o worktree
    // cujo caminho aparece em touched_paths/dirty_paths de alguma sessão
    // ATIVA e não-stale (qualquer kind) fica de fora da remoção. Ver docblock
    // de `shouldSkipForSharedSession` acima pro porquê do skip global
    // anterior ter virado um no-op quase incondicional com o contínuo ativo.
    // #7304: a própria sessão não se protege de si mesma — ver docblock de
    // `selectInUseWorktreeNames`.
    const inUseNames = selectInUseWorktreeNames(probe.sessions, ownSessionId);

    const all = listWorktreesSafe(repoRoot);
    const candidatesAll = filterUnderWorktreesDir(all, worktreesDir);
    const inUse = candidatesAll.filter((e) => inUseNames.has(worktreeNameFromPath(e.path)));
    // #7048: worktree `locked` (git worktree lock — pinado a um agent ativo)
    // é excluído independentemente de aparecer em `inUse` — cobre a janela
    // antes do primeiro `touched_paths` do agent chegar ao session-registry.
    const locked = candidatesAll.filter((e) => e.locked && !inUseNames.has(worktreeNameFromPath(e.path)));
    const candidates = filterOutLockedWorktrees(filterOutInUseWorktrees(candidatesAll, inUseNames));

    if (inUse.length > 0) {
      console.log(
        `[cleanup-merged-worktrees] ${inUse.length} worktree(s) em uso por sessão ativa — preservados sem checar ` +
          `merge/staleness (#7045): ${inUse.map((e) => worktreeNameFromPath(e.path)).join(", ")}.`,
      );
    }

    if (locked.length > 0) {
      console.log(
        `[cleanup-merged-worktrees] ${locked.length} worktree(s) locked pelo git (agent ativo, #7048) — ` +
          `preservados sem checar merge/staleness: ${locked.map((e) => worktreeNameFromPath(e.path)).join(", ")}.`,
      );
    }

    if (candidates.length === 0) {
      console.log("[cleanup-merged-worktrees] nenhum worktree elegível em .claude/worktrees/ — nada a fazer.");
      return;
    }

    const mergedRemoval = selectMergedForRemoval(candidates, (branch) => checkBranchMergedViaGh(branch, repoRoot));
    const orphanedStaleRemoval = selectOrphanedForStaleRemoval(
      candidates,
      mergedRemoval,
      (branch) => checkBranchExistsLocally(branch, repoRoot),
      getWorktreeMtimeMsSafe,
      Date.now(),
    );
    // #7304: último filtro, depois de toda a elegibilidade por histórico —
    // worktree com trabalho não-commitado nunca é removido, mesmo com branch
    // mergeada e mesmo órfão+stale. Ver docblock de `filterOutDirtyWorktrees`.
    const { kept: toRemove, skipped: dirtySkipped } = filterOutDirtyWorktrees(
      [...mergedRemoval, ...orphanedStaleRemoval],
      isWorktreeDirtySafe,
    );

    console.log(
      `[cleanup-merged-worktrees] ${candidates.length} worktree(s) encontrados, ` +
        `${mergedRemoval.length} com PR mergeada confirmada, ` +
        `${orphanedStaleRemoval.length} órfão(s) parado(s) há mais de 7 dias (#5418).`,
    );

    if (dirtySkipped.length > 0) {
      console.log(
        `[cleanup-merged-worktrees] ${dirtySkipped.length} worktree(s) elegível(is) PRESERVADO(s) por ter trabalho ` +
          `não-commitado (#7304) — commite ou descarte à mão antes de limpar: ` +
          `${dirtySkipped.map((e) => worktreeNameFromPath(e.path)).join(", ")}.`,
      );
    }

    let removed = 0;
    let failed = 0;
    for (const entry of toRemove) {
      const reason = mergedRemoval.includes(entry) ? "branch mergeada" : "órfão + stale (#5418)";
      if (dryRun) {
        console.log(`[cleanup-merged-worktrees] (dry-run) removeria: ${entry.path} (branch ${entry.branch}, motivo: ${reason})`);
        continue;
      }
      const result = removeWorktreeSafe(entry.path, repoRoot);
      if (result.ok) {
        removed++;
        console.log(`[cleanup-merged-worktrees] removido: ${entry.path} (branch ${entry.branch}, motivo: ${reason})`);
      } else {
        failed++;
        console.warn(`[cleanup-merged-worktrees] falha ao remover ${entry.path}: ${result.error}`);
      }
    }

    if (!dryRun) {
      console.log(`[cleanup-merged-worktrees] fim: ${removed} removido(s), ${failed} falha(s).`);
    }
  } catch (e) {
    console.warn(`[cleanup-merged-worktrees] erro inesperado, pulando cleanup (fail-soft): ${(e as Error).message}`);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
