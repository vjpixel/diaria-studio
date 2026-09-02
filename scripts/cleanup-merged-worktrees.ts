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
 * Uso:
 *   npx tsx scripts/cleanup-merged-worktrees.ts [--dry-run] [--root <repoRoot>] [--confirm-shared]
 *
 * Lógica pura (testável sem git/gh reais):
 *   - parseWorktreePorcelain(output) — parseia `git worktree list --porcelain`.
 *   - filterUnderWorktreesDir(entries, worktreesDir) — só os sob
 *     `.claude/worktrees/` (nunca o worktree principal do repo).
 *   - selectMergedForRemoval(entries, isMerged) — dado um checker injetável
 *     `(branch) => boolean`, retorna só os confirmados como mergeados.
 */
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgsWithTrueDefault as parseArgs, isMainModule } from "./lib/cli-args.ts";
import { isCoordinatorKind, listActiveSessions, type SessionRecord } from "./lib/session-registry.ts";

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

/**
 * Decide se a varredura destrutiva deve ser pulada por segurança (#5156 item
 * 9) — pura, testável sem tocar `data/sessions/` real. Pula quando existe
 * ≥1 sessão COORDENADORA ativa registrada E `confirmShared` não foi passado.
 * Registro vazio (nenhuma outra sessão rodando) nunca pula — comportamento
 * idêntico ao pré-#5156.
 *
 * **#6168 — só sessão COORDENADORA conta.** Antes desta issue a checagem era
 * "qualquer sessão ativa", o que estava certo enquanto só as 3 skills se
 * registravam. Com o beacon (`.claude/hooks/session-beacon.mjs`) registrando
 * TODA sessão interativa automaticamente, "qualquer sessão ativa" passaria a
 * ser verdade praticamente sempre — o guard viraria um `return true`
 * permanente e a limpeza de worktree nunca mais rodaria, em silêncio. É o
 * item 1 do blast radius que a Parte B da issue nomeia explicitamente.
 *
 * O que o guard protege é worktree em uso por um IMPLEMENTADOR despachado —
 * e só coordenadora despacha implementador. Uma sessão interativa não abre
 * worktree em `.claude/worktrees/` por conta própria; quando ela abre um à
 * mão, quem o remove é ela mesma.
 *
 * **#6706 — só conta sessão coordenadora NÃO-stale.** Antes desta mudança,
 * o filtro considerava qualquer registro `SessionRecord` cujo `kind` fosse
 * coordenador, ignorando o campo computado `stale` que `listActiveSessions`
 * já popula (heartbeat morto há mais de `SOFT_STALE_MS`/90min, ver
 * `scripts/lib/session-registry.ts`). Como o campo `pid` gravado no registro
 * nunca corresponde ao processo real da sessão neste harness (achado #6294,
 * reconfirmado pelo #6706 — nenhum PID de registro é resolvível em `/proc`
 * mesmo pra sessão genuinamente viva), `stale` é o ÚNICO sinal de liveness
 * prático disponível aqui; sem filtrar por ele, uma sessão overnight/develop
 * morta há 20h (dentro do teto absoluto de 24h que `listActiveSessions` usa
 * pra decidir se inclui o registro na lista, mas muito além da janela de
 * liveness de 90min) contava como "ativa" pra sempre — achado ao vivo: este
 * script recusou rodar reportando 15 sessões "ativas" quando só 2 estavam de
 * fato vivas. `s.stale` pode ser `undefined` num `SessionRecord` cru fora de
 * `listActiveSessions` (nunca persistido em disco) — `!s.stale` trata
 * `undefined` como "não-stale", preservando o comportamento de quem passar
 * uma lista sem essa checagem computada (nenhum call site real faz isso hoje;
 * `listActiveSessionsSafe` sempre passa por `listActiveSessions`).
 */
export function shouldSkipForSharedSession(activeSessions: SessionRecord[], confirmShared: boolean): boolean {
  const coordinators = activeSessions.filter((s) => isCoordinatorKind(s.kind) && !s.stale);
  return coordinators.length > 0 && !confirmShared;
}

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
 * normalmente mesmo com o contínuo ativo. Isso também fecha o item "ignorar
 * a própria sessão" sem precisar que o chamador saiba o próprio
 * `session_id` (que — confirmado contra a doc oficial no docblock do topo
 * de `session-registry.ts` — não existe como env var acessível à sessão
 * rodando): o worktree que a PRÓPRIA rodada dispatchou e já terminou de
 * revisar não aparece mais nos `touched_paths` recentes de ninguém "em uso"
 * de verdade no sentido que importa aqui — trabalho ainda em progresso,
 * não histórico de leitura.
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
 */
export function selectInUseWorktreeNames(activeSessions: SessionRecord[]): Set<string> {
  const names = new Set<string>();
  for (const s of activeSessions) {
    if (s.stale) continue;
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
    const inUseNames = selectInUseWorktreeNames(probe.sessions);

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
    const toRemove = [...mergedRemoval, ...orphanedStaleRemoval];

    console.log(
      `[cleanup-merged-worktrees] ${candidates.length} worktree(s) encontrados, ` +
        `${mergedRemoval.length} com PR mergeada confirmada, ` +
        `${orphanedStaleRemoval.length} órfão(s) parado(s) há mais de 7 dias (#5418).`,
    );

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
