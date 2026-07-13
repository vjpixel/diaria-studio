/**
 * git-sync.ts (#2686)
 *
 * Helper testável para sincronizar o checkout local com origin/master no início
 * de cada edição (`/diaria-edicao`). Garante que o pipeline rode sempre com a
 * versão mais recente do código (rodadas overnight/develop mergeiam muito).
 *
 * Comportamento:
 *   1. Se não estiver em master → tenta `git checkout master` antes do sync.
 *      Se checkout falhar → warn + retorna sem forçar (fail-soft).
 *   2. `git fetch origin` — fail-soft (offline, credencial, etc.) → warn + retorna.
 *   3. Se working tree suja → stash → merge --ff-only origin/master → stash pop
 *      (reversível). Se stash falhar E nenhum stash tiver sido criado → warn +
 *      retorna sem tocar o tree ("stash_failed"). Se stash pop falhar (conflito
 *      de merge) → warn + stash preservado.
 *   3a. #3411: `git stash --include-untracked` não é atômico — cria o(s) commit(s)
 *      de stash e SÓ DEPOIS remove os arquivos não-rastreados (clean-equivalente).
 *      Se essa remoção falhar parcialmente (ex: Permission denied), o comando sai
 *      não-zero MESMO com o stash já criado — "working tree não tocada" seria
 *      falso nesse caso. Detectado comparando `refs/stash` antes/depois; se um
 *      stash foi criado apesar do exit não-zero, tenta `git stash pop` automático
 *      ("stash_partial_failure" se recuperar; "stash_partial_failure_unrecovered"
 *      com stash preservado se o pop também falhar — nunca faz `git stash drop`).
 *   3b. #3423: a detecção do 3a comparando `refs/stash` antes/depois é uma TOCTOU
 *      race quando 2 chamadas de `syncCode()` rodam concorrentemente contra o
 *      MESMO checkout — `refs/stash` é uma ref escalar única por repositório
 *      (inclusive entre worktrees do mesmo repo), então o processo A pode ler
 *      `stashRefAfter` como o stash que o processo B acabou de criar (não o seu
 *      próprio) e popar as mudanças de B. Não dá pra desambiguar isso de forma
 *      confiável só inspecionando `git stash` (nenhum comando devolve um ID
 *      específico da invocação; a mensagem do stash é idêntica entre processos
 *      no mesmo branch/commit). Fix: serializar toda a operação de sync com um
 *      lock de arquivo (`.diaria-sync.lock`, `fs.mkdirSync` atômico) — elimina a
 *      race na origem em vez de tentar resolvê-la depois do fato. Uma segunda
 *      chamada concorrente detecta o lock e retorna "sync_in_progress" (fail-soft)
 *      SEM tocar em stash/merge.
 *   3c. #3430: o próprio lock do 3b tinha 3 gaps confirmados por review
 *      adversarial (4 finders independentes) — endurecido nesta revisão:
 *        (i) `LOCK_STALE_MS` (10min fixo) era matematicamente MENOR que o pior
 *            caso real (8 spawns git sequenciais × até 120s cada = 16min) —
 *            agora derivado de `MAX_SEQUENTIAL_GIT_SPAWNS` × `GIT_TIMEOUT_MS`
 *            com margem documentada (ver `LOCK_STALE_MS` abaixo).
 *        (ii) a reivindicação de lock morto (`rmdirSync`+`mkdirSync`, 2 syscalls
 *            separadas) permitia 2 processos "vencerem" simultaneamente — agora
 *            via `renameSync` atômico + verificação de identidade por mtime
 *            pós-rename (rollback se não bater) + token de propriedade
 *            verificado em `release()`. Ver `createFileLock()`.
 *        (iii) o path do lock era resolvido a partir de `import.meta.url`
 *            (localização FÍSICA do arquivo, que difere por `git worktree`) —
 *            agora resolvido via `git rev-parse --git-common-dir`, o mesmo
 *            `.git` real compartilhado entre TODOS os worktrees do repo. Ver
 *            `resolveSharedLockPath()`.
 *   4. Se working tree limpa → merge --ff-only origin/master direto.
 *      Se ff-only falhar (divergência) → warn + retorna (nunca força merge).
 *   5. Falha de fetch OU ff_failed OU stash_pop_failed OU stash_partial_failure
 *      (ou sua variante _unrecovered) OU sync_in_progress NÃO bloqueiam a
 *      edição — retornam status de warn e a skill continua.
 *
 * Nota: usa `git merge --ff-only origin/master` (não `git pull`) após o fetch
 * explícito do passo 2 — evita um segundo fetch implícito (rede = única
 * superfície de falha) e roda offline-friendly contra o ref já buscado.
 *
 * Idempotente: re-rodar não tem efeito colateral se já atualizado.
 *
 * @see .claude/skills/diaria-edicao/SKILL.md — invocado no Passo 0.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { GitSpawnFn, SpawnResult } from "./spawn-types.ts";

export type { SpawnResult } from "./spawn-types.ts";

/**
 * Tipo do spawner injetável. Produção usa spawnSync; testes usam mock.
 * Alias local de back-compat — o tipo canônico é `GitSpawnFn` em
 * `scripts/lib/spawn-types.ts` (#2699 — evita colisão com o `SpawnFn` de
 * 3 args de `scripts/check-pr-bugfix.ts`).
 */
export type SpawnFn = GitSpawnFn;

/**
 * Raiz do repo, resolvida a partir da localização deste arquivo (não de
 * `process.cwd()`) — #2699 item 1. Sem isso, `defaultSpawn` roda `git` no
 * CWD do processo; se `/diaria-edicao` for invocado de dentro de um worktree
 * (`.claude/worktrees/agent-*`), o sync miraria o worktree, não o checkout
 * principal. `scripts/lib/git-sync.ts` está 2 níveis abaixo da raiz.
 *
 * IMPORTANTE (#3430): isso continua correto para o CWD usado nos comandos git
 * de `defaultSpawn` (stash/merge/checkout devem rodar no checkout FÍSICO que
 * de fato invocou `syncCode()`, não redirecionar magicamente pra outro
 * worktree). O que mudou em #3430 é só o path do LOCK em si (ver
 * `resolveSharedLockPath()`), que precisa ser compartilhado entre worktrees
 * mesmo que `REPO_ROOT` — corretamente — não seja.
 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Status da operação de sync. */
export type GitSyncOutcome =
  | "synced"              // pull --ff-only bem-sucedido em tree limpa
  | "synced_stashed"      // stash → pull --ff-only → stash pop OK
  | "already_up_to_date"  // já na versão mais recente (tree limpa ou suja)
  | "fetch_failed"        // git fetch falhou (offline / auth) — warn, segue
  | "ff_failed"           // pull --ff-only falhou (divergência) — warn, segue
  | "stash_failed"        // stash falhou E nenhum stash foi criado — tree não tocada — warn, segue
  | "stash_partial_failure"             // stash saiu não-zero MAS criou um stash (#3411); recuperado via pop automático — warn, segue
  | "stash_partial_failure_unrecovered" // idem, mas o pop automático TAMBÉM falhou — stash preservado p/ investigação manual — warn, segue
  | "stash_pop_failed"    // pull OK mas stash pop teve conflito — warn, stash preservado
  | "checkout_failed"     // não estava em master e checkout master falhou — warn, segue
  | "sync_in_progress";   // #3423: outro syncCode() já está rodando neste checkout — warn, segue sem tocar git

/** Resultado completo do sync. */
export interface GitSyncResult {
  outcome: GitSyncOutcome;
  message: string;
  branch_before: string;
  warnings: string[];
  /** true quando a edição pode continuar normalmente (sempre true — fail-soft). */
  proceed: true;
}

/**
 * Timeout por comando git (#2686 review — angle H). Sem isso, um git que trava
 * esperando passphrase de SSH ou credencial bloquearia o processo indefinidamente,
 * derrotando o fail-soft. 120s cobre fetch/pull em conexões lentas com folga.
 */
export const GIT_TIMEOUT_MS = 120_000;

/**
 * Lock de sync (#3423, endurecido em #3430). Interface injetável — produção usa
 * `createFileLock()` (fs real); testes usam um double em memória para não
 * depender do disco nem interferir entre casos de teste sequenciais.
 */
export interface SyncLock {
  /** Path do lock, só para diagnóstico nas mensagens de warning. */
  readonly path: string;
  /**
   * Tenta adquirir o lock. `true` = adquirido (chamador é dono exclusivo até
   * `release()`); `false` = já havia um lock ATIVO de outro processo (ou erro
   * inesperado ao adquirir — tratado como "não consegui", fail-soft).
   */
  acquire(): boolean;
  /** Libera o lock. Idempotente — seguro chamar mesmo sem ter adquirido. */
  release(): void;
}

/**
 * Subconjunto de `node:fs` usado por `createFileLock()` — injetável só para
 * testes (#3430). Produção usa o módulo `fs` real (importado no topo deste
 * arquivo); testes de race usam um double em memória que intercepta
 * `renameSync`/`mkdirSync` pra simular 2 processos disputando a mesma
 * reivindicação de lock morto sem precisar de 2 processos de verdade.
 */
export interface LockFs {
  mkdirSync(path: string): void;
  rmSync(path: string, opts: { recursive: boolean; force: boolean }): void;
  statSync(path: string): { mtimeMs: number };
  renameSync(oldPath: string, newPath: string): void;
  writeFileSync(path: string, data: string): void;
  readFileSync(path: string, encoding: "utf8"): string;
}

/**
 * Comandos git sequenciais que `syncCodeLocked()` pode rodar numa única
 * chamada, contados explicitamente (não estimados) no caminho MAIS LONGO
 * (dirty tree, branch != master): rev-parse HEAD(1) + checkout master(1,
 * condicional) + fetch(1) + status(1) + rev-parse verify refs/stash ANTES(1)
 * + stash --include-untracked(1) + merge --ff-only(1) + stash pop(1) = 8.
 *
 * `LOCK_STALE_MS` abaixo deriva desse número em vez de um valor redondo
 * chutado — #3430 gap 1 encontrou o valor antigo (10min fixo) matematicamente
 * MENOR que 8 × `GIT_TIMEOUT_MS` (16min no pior caso teórico).
 */
export const MAX_SEQUENTIAL_GIT_SPAWNS = 8;

/**
 * Lock morto (processo dono crashou sem `release()`) é considerado stale após
 * esse intervalo e liberado automaticamente na próxima tentativa de acquire.
 *
 * #3430 gap 1: o valor antigo (10min fixo; o comentário afirmava "bem acima
 * do pior caso realista") não sustentava a aritmética — `MAX_SEQUENTIAL_GIT_SPAWNS`
 * (8) × até `GIT_TIMEOUT_MS` (120s) cada = até 16min no pior caso teórico,
 * ACIMA dos 10min antigos. Um sync legítimo-mas-lento (ex: contenção de I/O
 * do OneDrive documentada no CLAUDE.md pra junctions de `data/` — o próprio
 * checkout do repo pode compartilhar o mesmo disco) podia ter o lock roubado
 * por um processo concorrente antes de terminar, reproduzindo a exata race
 * que o lock foi criado pra eliminar (#3423).
 *
 * Novo valor: 2× o pior caso teórico + 2min de buffer fixo — margem generosa
 * e DERIVADA (não um número redondo chutado de novo), cobrindo jitter de
 * scheduling do SO e a diferença entre "GIT_TIMEOUT_MS é um teto por comando"
 * vs. "8 comandos consecutivos raspando o teto" (pior caso real, não o caso
 * comum).
 *
 * Trade-off aceito conscientemente (documentado no PR #3430): nenhum valor
 * FINITO elimina 100% a janela teórica — só um heartbeat (renovar o mtime do
 * lock periodicamente durante o trabalho) eliminaria por completo, e isso foi
 * avaliado como desproporcional pra este mecanismo (mais um subsistema com
 * seu próprio potencial de bug novo, exatamente o padrão que #3430 pede pra
 * não repetir). Em vez disso, a reivindicação do lock morto agora é
 * estruturalmente segura mesmo se a janela for cruzada — ver `acquire()`
 * abaixo (reivindicação via `renameSync` atômico + verificação de identidade
 * por mtime, gap 2) — então mesmo o cenário residual (staleness bater
 * durante um sync legítimo-mas-lento) resulta, no pior caso, em dois syncs
 * concorrentes (já fail-soft por design) em vez de corrupção do stash.
 */
export const LOCK_STALE_MS = MAX_SEQUENTIAL_GIT_SPAWNS * GIT_TIMEOUT_MS * 2 + 2 * 60_000;

/** Nome do arquivo interno que guarda o token de propriedade do lock (#3430 gap 2). */
const OWNER_TOKEN_FILE = "owner.json";

function writeOwnerToken(lockDirPath: string, token: string, fsImpl: LockFs): void {
  try {
    fsImpl.writeFileSync(
      resolve(lockDirPath, OWNER_TOKEN_FILE),
      JSON.stringify({ pid: process.pid, token, acquiredAt: Date.now() }),
    );
  } catch {
    // Best-effort (#3430) — falha ao escrever o token NÃO invalida o lock em
    // si (`mkdirSync` já teve sucesso, provando posse ao nível do FS de forma
    // atômica); só significa que a checagem extra de posse em `release()`
    // degrada pro comportamento pré-#3430 (remove incondicionalmente) para
    // ESTA aquisição especificamente.
  }
}

function readOwnerToken(lockDirPath: string, fsImpl: LockFs): string | null {
  try {
    const raw = fsImpl.readFileSync(resolve(lockDirPath, OWNER_TOKEN_FILE), "utf8");
    const parsed = JSON.parse(raw) as { token?: unknown };
    return typeof parsed.token === "string" ? parsed.token : null;
  } catch {
    return null;
  }
}

/**
 * Resolve o path do lock compartilhado entre TODOS os worktrees do mesmo
 * repositório físico (#3430 gap 3).
 *
 * `REPO_ROOT` (raiz calculada a partir de `import.meta.url` — a localização
 * FÍSICA deste arquivo) difere por worktree: num `git worktree`, o arquivo
 * `scripts/lib/git-sync.ts` é uma cópia física separada em
 * `.claude/worktrees/agent-XXX/scripts/lib/git-sync.ts`, então 2 invocações de
 * `syncCode()` em worktrees diferentes do MESMO repo resolviam (antes do
 * #3430) o lock pra paths DIFERENTES e não-conflitantes — mesmo competindo
 * pela mesma `refs/stash` (ref única por repositório, compartilhada entre
 * worktrees — motivação original do #3423).
 *
 * `git rev-parse --path-format=absolute --git-common-dir` é o comando git
 * canônico pra isso: resolve pro MESMO diretório `.git` físico
 * independentemente de rodar a partir do checkout principal ou de um
 * worktree vinculado (verificado empiricamente durante esta correção — rodar
 * esse comando tanto da raiz do repo principal quanto de dentro de
 * `.claude/worktrees/agent-*` retorna o EXATO mesmo path absoluto).
 *
 * IMPORTANTE — a sugestão original da issue #3430 era `git rev-parse
 * --show-toplevel`. Isso NÃO resolve o gap: `--show-toplevel` devolve o
 * diretório de trabalho do PRÓPRIO worktree (equivalente ao `REPO_ROOT`
 * atual, físico), reproduzindo exatamente a mesma fragmentação por worktree
 * que este fix precisa fechar — confirmado empiricamente durante esta
 * correção (valores DIFERENTES entre o checkout principal e um worktree
 * vinculado do mesmo repo). `--git-common-dir` é o comando correto porque
 * aponta pro `.git` REAL compartilhado, não pro toplevel de cada working
 * copy — desviamos da sugestão literal da issue por esse motivo.
 *
 * O lock vive DENTRO do `.git` comum retornado por esse comando — sempre um
 * diretório real (nunca o arquivo `.git` de um worktree vinculado, que só
 * existe no toplevel de CADA worktree individual, não no common dir
 * compartilhado) — e nunca aparece em `git status`/`git stash` (tudo sob
 * `.git/` é implicitamente ignorado pelo git, sem depender de `.gitignore`).
 *
 * Fail-soft: se o comando git falhar (não é um repositório, git indisponível,
 * versão de git anterior a 2.31 sem suporte a `--path-format`), cai de volta
 * pro comportamento pré-#3430 (`REPO_ROOT/.diaria-sync.lock`) — ainda correto
 * pro caso comum de um único checkout, só reintroduzindo o gap de
 * worktree-sharing (aceitável dado que a alternativa seria lançar exceção no
 * meio de um mecanismo que é fail-soft por design inteiro).
 */
export function resolveSharedLockPath(spawn: SpawnFn = defaultSpawn): string {
  const res = spawn("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (res.status === 0 && res.stdout.trim()) {
    return resolve(res.stdout.trim(), "diaria-sync.lock");
  }
  return resolve(REPO_ROOT, ".diaria-sync.lock");
}

/**
 * Lock de arquivo real (#3423, endurecido em #3430). Usa um DIRETÓRIO (não
 * arquivo) como marcador — `fs.mkdirSync` é atômico em POSIX e Windows (falha
 * com EEXIST se já existe), ao contrário de checar-depois-criar com arquivos
 * comuns.
 *
 * @param lockPath Path do diretório-lock. Default (#3430): resolvido via
 *   `resolveSharedLockPath()` — compartilhado entre TODOS os worktrees do
 *   mesmo repositório físico (gap 3), não mais `REPO_ROOT` (que diferia por
 *   worktree).
 * @param spawn Spawner usado SÓ pra resolver o `lockPath` default via git
 *   (ignorado se `lockPath` for passado explicitamente). Injetável para testes.
 * @param fsImpl Subconjunto de `node:fs` usado pelas operações do lock.
 *   Injetável para testes de race (#3430) — produção usa o `fs` real.
 */
export function createFileLock(
  lockPath?: string,
  spawn: SpawnFn = defaultSpawn,
  fsImpl: LockFs = fs,
): SyncLock {
  const path = lockPath ?? resolveSharedLockPath(spawn);
  // Token da aquisição ATUAL desta instância de SyncLock — `null` até
  // `acquire()` suceder. `release()` só remove o diretório quando o token
  // gravado em disco bate com este (#3430 gap 2) — nunca remove um lock que
  // não foi ele quem criou.
  let heldToken: string | null = null;

  return {
    path,
    acquire(): boolean {
      const myToken = randomUUID();
      try {
        fsImpl.mkdirSync(path);
        writeOwnerToken(path, myToken, fsImpl);
        heldToken = myToken;
        return true;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") {
          // Erro inesperado (permissão, disco cheio, ENOTDIR, etc.) — tratar
          // como "não consegui adquirir" em vez de propagar. O módulo inteiro
          // é fail-soft; uma falha de lock nunca deve virar exceção não-tratada.
          return false;
        }

        // Lock já existe — pode ser (a) outro processo genuinamente em
        // andamento, ou (b) um lock morto de um processo que crashou sem
        // `release()`. Staleness por mtime distingue os dois casos.
        let observedMtimeMs: number;
        try {
          observedMtimeMs = fsImpl.statSync(path).mtimeMs;
        } catch {
          // Lock sumiu entre o EEXIST e o stat (outro processo liberou
          // concorrentemente) — tenta adquirir de novo, uma única vez.
          try {
            fsImpl.mkdirSync(path);
            writeOwnerToken(path, myToken, fsImpl);
            heldToken = myToken;
            return true;
          } catch {
            return false;
          }
        }

        if (Date.now() - observedMtimeMs <= LOCK_STALE_MS) {
          return false; // lock ativo — outro processo genuinamente sincronizando
        }

        // Lock stale — reivindica via RENAME atômico (#3430 gap 2), não mais
        // `rmdirSync`+`mkdirSync` separados. `renameSync` é uma ÚNICA syscall
        // atômica: só quem vence a corrida de renomear o path original
        // consegue — quem perder recebe ENOENT determinístico (o path de
        // origem já não existe mais pra ele), nunca um "sucesso silencioso"
        // que destrua o lock que o vencedor acabou de criar. Isso fecha o
        // bug original do gap 2: `rmdirSync`+`mkdirSync` eram 2 syscalls
        // separadas SEM verificação de identidade entre elas, então o
        // `rmdirSync` de um processo B podia remover o `mkdirSync`
        // recém-criado do processo A sem levantar erro nenhum (ambos "achavam"
        // que tinham reivindicado o MESMO lock morto original).
        const staleClaimPath = `${path}.stale-${process.pid}-${Date.now()}-${randomUUID()}`;
        try {
          fsImpl.renameSync(path, staleClaimPath);
        } catch {
          // Perdemos a corrida de reivindicação (outro processo já renomeou
          // este exato lock morto primeiro), ou outro erro inesperado. De
          // qualquer forma, NÃO fomos nós quem reivindicou. Desiste nesta
          // rodada (fail-soft) — próxima chamada de `syncCode()` tenta de novo.
          return false;
        }

        // Verificação de identidade PÓS-rename (fecha a janela residual: e se
        // outro processo já tivesse reivindicado E recriado um lock FRESCO no
        // instante exato entre nosso `statSync` acima e este `renameSync`?
        // `renameSync` move atomicamente o que ESTIVER no path no momento —
        // não distingue "o lock morto original" de "um lock fresco de outro
        // dono" só por endereço. Comparamos o mtime do que de fato movemos
        // contra o mtime que observamos ANTES de decidir reivindicar: se não
        // bater, renomeamos o lock ERRADO — devolve pro lugar e desiste,
        // preservando o lock do dono real).
        let claimedMtimeMs: number;
        try {
          claimedMtimeMs = fsImpl.statSync(staleClaimPath).mtimeMs;
        } catch {
          // Não deveria acontecer (acabamos de renomear pra cá) — fail-soft.
          return false;
        }
        if (claimedMtimeMs !== observedMtimeMs) {
          try {
            fsImpl.renameSync(staleClaimPath, path);
          } catch {
            // Se nem a devolução for possível, o pior caso é o path original
            // ficar temporariamente ausente até o dono real notar — nunca
            // corrompemos o lock dele (não o descartamos, não criamos um
            // segundo lock concorrente).
          }
          return false;
        }

        // Identidade confirmada — reivindicamos de fato o lock morto
        // ORIGINAL (mtime bate). Descarta (best-effort — se falhar, fica
        // órfão mas inofensivo: não bloqueia ninguém, só ocupa espaço em disco).
        try {
          fsImpl.rmSync(staleClaimPath, { recursive: true, force: true });
        } catch {
          /* órfão inofensivo, ver comentário acima */
        }

        try {
          fsImpl.mkdirSync(path);
          writeOwnerToken(path, myToken, fsImpl);
          heldToken = myToken;
          return true;
        } catch {
          // Um 3º processo (não participante da corrida de reivindicação)
          // criou um lock fresco no instante entre nosso rename vencedor e
          // este `mkdirSync` — colisão normal (idêntica ao EEXIST comum no
          // topo desta função), desiste nesta rodada.
          return false;
        }
      }
    },
    release(): void {
      if (heldToken === null) {
        // Nunca adquirimos nesta instância — idempotente, não faz nada
        // (comportamento pré-#3430 preservado).
        return;
      }

      // #3430 gap 2: só remove se o token em disco bater com o que ESTA
      // instância gravou ao adquirir. `null` (owner.json ilegível — ex:
      // `writeOwnerToken` falhou ao gravar, ou lock criado por código
      // legado/teste sem token) não é evidência POSITIVA de dono diferente —
      // remove mesmo assim (fail-open, preserva o comportamento idempotente
      // pré-#3430). Um token DIFERENTE É evidência clara: outro processo já
      // reivindicou este lock (staleness bateu enquanto ainda trabalhávamos,
      // ver trade-off documentado em `LOCK_STALE_MS`) — nunca remover o lock
      // do dono atual; nosso `release()` vira no-op.
      const onDiskToken = readOwnerToken(path, fsImpl);
      if (onDiskToken !== null && onDiskToken !== heldToken) {
        heldToken = null;
        return;
      }

      try {
        fsImpl.rmSync(path, { recursive: true, force: true });
      } catch {
        // Idempotente — já liberado, nunca adquirido nesta chamada, ou
        // removido externamente. Nunca lança.
      }
      heldToken = null;
    },
  };
}

/**
 * Spawner de produção. `cwd: REPO_ROOT` explícito (#2699 item 1) — nunca
 * confiar em `process.cwd()` como único sinal de onde rodar o `git`.
 */
export function defaultSpawn(cmd: string, args: string[]): SpawnResult {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: GIT_TIMEOUT_MS, cwd: REPO_ROOT });
  return {
    status: r.status,
    stdout: (r.stdout as string | null) ?? "",
    stderr: (r.stderr as string | null) ?? "",
  };
}

function isAlreadyUpToDate(stdout: string): boolean {
  // git merge/pull imprime "Already up to date." (EN) ou "Já está atualizado." (PT).
  // Espaços literais (não wildcards) — evita falso-positivo em strings inesperadas.
  return /already up to date/i.test(stdout) || /j[aá] est[aá] atualizad/i.test(stdout);
}

/**
 * Sincroniza o checkout local com origin/master.
 *
 * @param spawn   Spawner injetável para testes (default: spawnSync real).
 * @param lock    Lock injetável para testes (default: `createFileLock()` real,
 *                resolvido via o MESMO `spawn` recebido — #3430 — pra que o
 *                path do lock use o mesmo spawner injetado em testes).
 *                #3423: serializa toda a chamada — se outro `syncCode()` já
 *                estiver rodando contra este checkout, retorna imediatamente
 *                sem tocar em stash/merge (evita a race TOCTOU no stash-recovery).
 */
export function syncCode(
  spawn: SpawnFn = defaultSpawn,
  lock: SyncLock = createFileLock(undefined, spawn),
): GitSyncResult {
  if (!lock.acquire()) {
    const msg =
      `[git-sync] WARN: outro processo já parece estar sincronizando este checkout ` +
      `(lock '${lock.path}' presente e ainda válido — #3423). Sync ignorado nesta ` +
      `rodada para evitar popar/aplicar o stash de um processo concorrente. ` +
      `Edição continua com o código local atual (pode estar levemente desatualizado ` +
      `se o outro sync ainda não terminou).`;
    return {
      outcome: "sync_in_progress",
      message: msg,
      branch_before: "unknown",
      warnings: [msg],
      proceed: true,
    };
  }

  try {
    return syncCodeLocked(spawn);
  } finally {
    lock.release();
  }
}

/**
 * Corpo real do sync, executado apenas com o lock (#3423) já adquirido pelo
 * chamador (`syncCode`). Extraído para função própria só para manter o
 * `try/finally` do lock enxuto — não é exportado nem chamado diretamente.
 */
function syncCodeLocked(spawn: SpawnFn): GitSyncResult {
  const warnings: string[] = [];

  // ── 1. Branch atual ────────────────────────────────────────────────────────
  const branchRes = spawn("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  // #2699 item 3: se o próprio `rev-parse` falhar (não-repo / HEAD órfão / git
  // indisponível), branchBefore cai em "unknown" só por ausência de stdout —
  // registrar isso explicitamente agora, senão o diagnóstico downstream (se o
  // checkout também falhar) aponta pra "branch inesperada" em vez da causa raiz.
  const branchRevParseFailed = branchRes.status !== 0;
  const branchBefore = branchRes.stdout.trim() || "unknown";
  if (branchRevParseFailed) {
    warnings.push(
      `[git-sync] WARN: git rev-parse --abbrev-ref HEAD falhou (exit ${branchRes.status}). ` +
        `Causa raiz provável: não é um repositório git, ou git indisponível no ambiente — não uma ` +
        `branch desconhecida. Stderr: ${branchRes.stderr.trim() || "(vazio)"}`,
    );
  }

  // ── 2. Se não estiver em master → checkout master ─────────────────────────
  if (branchBefore !== "master") {
    const w = `[git-sync] Branch atual: '${branchBefore}'. Tentando checkout master antes do sync.`;
    warnings.push(w);
    const checkoutRes = spawn("git", ["checkout", "master"]);
    if (checkoutRes.status !== 0) {
      const rootCauseNote = branchRevParseFailed
        ? ` Causa raiz provável: git indisponível ou não é um repositório git (git rev-parse já ` +
          `havia falhado acima) — não uma branch inesperada.`
        : "";
      const msg =
        `[git-sync] WARN: checkout master falhou (branch='${branchBefore}').${rootCauseNote} ` +
        `Sync ignorado — edição continua com código local. ` +
        `Stderr: ${checkoutRes.stderr.trim() || "(vazio)"}`;
      warnings.push(msg);
      return { outcome: "checkout_failed", message: msg, branch_before: branchBefore, warnings, proceed: true };
    }
    warnings.push("[git-sync] Switched to master.");
  }

  // ── 3. git fetch origin ────────────────────────────────────────────────────
  const fetchRes = spawn("git", ["fetch", "origin"]);
  if (fetchRes.status !== 0) {
    const msg =
      `[git-sync] WARN: git fetch origin falhou (offline ou erro de rede). ` +
      `Edição continua com código local. ` +
      `Stderr: ${fetchRes.stderr.trim() || "(vazio)"}`;
    warnings.push(msg);
    return { outcome: "fetch_failed", message: msg, branch_before: branchBefore, warnings, proceed: true };
  }

  // ── 4. Dirty check ────────────────────────────────────────────────────────
  // Se o próprio `git status` falhar (índice corrompido, .git/index.lock travado),
  // NÃO assumir tree limpa — isso pularia a proteção do stash e o ff poderia
  // mover o branch sob mudanças não-protegidas. Conservador: tratar como dirty
  // (força o caminho com stash, que protege ou aborta limpo via stash_failed).
  const statusRes = spawn("git", ["status", "--porcelain"]);
  if (statusRes.status !== 0) {
    warnings.push(
      `[git-sync] WARN: git status falhou (exit ${statusRes.status}). ` +
        `Tratando como dirty por segurança. Stderr: ${statusRes.stderr.trim() || "(vazio)"}`,
    );
  }
  const isDirty = statusRes.status !== 0 || statusRes.stdout.trim().length > 0;

  if (isDirty) {
    // ── 5a. Dirty tree: stash → merge --ff-only → stash pop ────────────────
    // #3411: captura o estado de `refs/stash` ANTES de rodar o stash. Motivo:
    // `git stash --include-untracked` NÃO é atômico — ele (1) cria o(s) commit(s)
    // de stash (index + working-tree + untracked-files) e SÓ DEPOIS (2) remove os
    // arquivos não-rastreados do working tree (clean-equivalente). Se o passo 2
    // falhar parcialmente (ex: "Permission denied" num diretório com handle aberto
    // por outro processo), o comando INTEIRO sai com exit não-zero mesmo com o
    // stash já criado e parte dos untracked já removida — reportar "working tree
    // não tocada" nesse caso é falso e pode esconder perda real de arquivos
    // (incidente real 260713). Comparar refs/stash antes/depois é a forma robusta
    // de distinguir "nada foi stashado" de "stash foi criado apesar do exit != 0".
    const stashRefBeforeRes = spawn("git", ["rev-parse", "--verify", "refs/stash"]);
    const stashRefBefore = stashRefBeforeRes.status === 0 ? stashRefBeforeRes.stdout.trim() : null;

    const stashRes = spawn("git", ["stash", "--include-untracked"]);
    if (stashRes.status !== 0) {
      const stashRefAfterRes = spawn("git", ["rev-parse", "--verify", "refs/stash"]);
      const stashRefAfter = stashRefAfterRes.status === 0 ? stashRefAfterRes.stdout.trim() : null;
      // Um novo stash foi criado apesar do exit não-zero se refs/stash mudou
      // (cobre tanto o caso "não existia stash antes" [before=null] quanto
      // "já existia um stash diferente antes").
      const stashWasCreatedDespiteFailure = stashRefAfter !== null && stashRefAfter !== stashRefBefore;

      if (stashWasCreatedDespiteFailure) {
        // O stash existe e é válido (o commit foi criado no passo 1 antes da
        // falha no passo 2) — tentar recuperar automaticamente via pop, reusando
        // a mesma lógica de tratamento de conflito do caminho de sucesso.
        const popRes = spawn("git", ["stash", "pop"]);
        if (popRes.status === 0) {
          const msg =
            `[git-sync] WARN: git stash --include-untracked saiu com erro (exit ${stashRes.status}) — ` +
            `provável falha parcial ao remover arquivos não-rastreados (ex: Permission denied em diretório ` +
            `com handle aberto por outro processo) — MAS um stash FOI criado (${stashRefAfter}) apesar do ` +
            `exit não-zero. Sync ignorado (nenhum merge tentado nesta rodada) — stash recuperado ` +
            `automaticamente via 'git stash pop' com sucesso, working tree restaurada. ` +
            `Stderr original do stash: ${stashRes.stderr.trim() || "(vazio)"}`;
          warnings.push(msg);
          return {
            outcome: "stash_partial_failure",
            message: msg,
            branch_before: branchBefore,
            warnings,
            proceed: true,
          };
        }

        // Pop também falhou (conflito ou outro erro) — NÃO descartar o stash;
        // preservado para investigação manual. Outcome DISTINTO de
        // "stash_pop_failed" (que implica pull/merge bem-sucedido) — aqui nenhum
        // merge foi sequer tentado, então reusar aquele outcome enganaria
        // qualquer consumidor que assume "pull OK" a partir dele. Warning
        // explicitamente mais urgente (prefixo ERROR), porque a causa raiz
        // envolve possível remoção não-recuperável de arquivos não-rastreados.
        const msg =
          `[git-sync] ERROR: git stash --include-untracked saiu com erro (exit ${stashRes.status}) E criou ` +
          `um stash (${stashRefAfter}) apesar disso — possível remoção NÃO-RECUPERÁVEL de arquivos não-` +
          `rastreados (#3411). A recuperação automática via 'git stash pop' TAMBÉM falhou (conflito ou ` +
          `outro erro) — stash NÃO foi descartado, preservado para investigação manual: ` +
          `'git stash show -p ${stashRefAfter}' ou 'git stash apply ${stashRefAfter}'. ` +
          `Stderr stash: ${stashRes.stderr.trim() || "(vazio)"} | Stderr pop: ${popRes.stderr.trim() || "(vazio)"}`;
        warnings.push(msg);
        return {
          outcome: "stash_partial_failure_unrecovered",
          message: msg,
          branch_before: branchBefore,
          warnings,
          proceed: true,
        };
      }

      const msg =
        `[git-sync] WARN: git stash falhou — sync ignorado, working tree não tocada ` +
        `(nenhum stash foi criado — refs/stash não mudou). ` +
        `Stderr: ${stashRes.stderr.trim() || "(vazio)"}`;
      warnings.push(msg);
      return { outcome: "stash_failed", message: msg, branch_before: branchBefore, warnings, proceed: true };
    }

    // Detecção locale-robusta de "nada foi guardado" (#2686 review — EN + PT-BR).
    // Dentro do branch isDirty, o esperado é que algo tenha sido guardado; só
    // pulamos o pop quando o git explicitamente diz que não havia nada (evita
    // `stash pop` numa pilha vazia, que falharia espuriamente).
    const stashedNothing =
      /no local changes to save/i.test(stashRes.stdout) ||
      /n(ã|a)o h(á|a) (mudan|altera)/i.test(stashRes.stdout);
    const stashedSomething = !stashedNothing;

    // ff-only via merge do ref já buscado no passo 3 — evita o re-fetch implícito
    // do `git pull` (segunda superfície de falha de rede) (#2686 review — angle H/I).
    const pullRes = spawn("git", ["merge", "--ff-only", "origin/master"]);

    // ── restaurar stash sempre (mesmo se o merge falhou) ──────────────────
    if (stashedSomething) {
      const popRes = spawn("git", ["stash", "pop"]);
      if (popRes.status !== 0) {
        // merge pode ter trazido mudanças conflitantes com o stash.
        // Se o merge TAMBÉM falhou, incluir o stderr dele — senão a mensagem
        // apontaria só pro conflito de stash e esconderia a divergência (#2686
        // review — angles A/B/G/J/C).
        const ffFailed = pullRes.status !== 0;
        const msg = ffFailed
          ? `[git-sync] WARN: ff (merge --ff-only) falhou (divergência) E git stash pop teve conflito. ` +
            `Stash preservado — use 'git stash show'. ` +
            `Stderr ff: ${pullRes.stderr.trim() || "(vazio)"} | Stderr pop: ${popRes.stderr.trim() || "(vazio)"}`
          : `[git-sync] WARN: git stash pop teve conflito. Stash preservado — ` +
            `use 'git stash show' para ver. Stderr: ${popRes.stderr.trim() || "(vazio)"}`;
        warnings.push(msg);
        const outcome = ffFailed ? "ff_failed" : "stash_pop_failed";
        return { outcome, message: msg, branch_before: branchBefore, warnings, proceed: true };
      }
    }

    if (pullRes.status !== 0) {
      const msg =
        `[git-sync] WARN: ff (merge --ff-only origin/master) falhou (divergência?). ` +
        `Working tree restaurada. Edição continua com código local. ` +
        `Stderr: ${pullRes.stderr.trim() || "(vazio)"}`;
      warnings.push(msg);
      return { outcome: "ff_failed", message: msg, branch_before: branchBefore, warnings, proceed: true };
    }

    const upToDate = isAlreadyUpToDate(pullRes.stdout);
    // #2716 item 5c: outcome "synced_stashed" só é correto quando algo de fato foi
    // stashado E despopado (stashedSomething). Quando `git stash` não tinha nada pra
    // guardar (working tree "dirty" só por `git status` ter falhado — ver comentário
    // acima do dirty check — ou por já estar em sync com o índice), `stashedSomething`
    // é false e o outcome deve refletir "synced" puro (nada foi stashado/restaurado),
    // senão o log confunde diagnóstico futuro (parece que houve stash quando não houve).
    const outcome = upToDate ? "already_up_to_date" : stashedSomething ? "synced_stashed" : "synced";
    return {
      outcome,
      message: upToDate
        ? "[git-sync] Código já estava atualizado (dirty tree restaurada)."
        : stashedSomething
          ? "[git-sync] Código sincronizado com origin/master (dirty tree restaurada via stash)."
          : "[git-sync] Código sincronizado com origin/master (nada foi stashado — stash não tinha mudanças a guardar).",
      branch_before: branchBefore,
      warnings,
      proceed: true,
    };
  } else {
    // ── 5b. Clean tree: merge --ff-only direto ────────────────────────────
    const pullRes = spawn("git", ["merge", "--ff-only", "origin/master"]);

    if (pullRes.status !== 0) {
      const msg =
        `[git-sync] WARN: ff (merge --ff-only origin/master) falhou (divergência ou conflito). ` +
        `Edição continua com código local. ` +
        `Stderr: ${pullRes.stderr.trim() || "(vazio)"}`;
      warnings.push(msg);
      return { outcome: "ff_failed", message: msg, branch_before: branchBefore, warnings, proceed: true };
    }

    const upToDate = isAlreadyUpToDate(pullRes.stdout);
    return {
      outcome: upToDate ? "already_up_to_date" : "synced",
      message: upToDate
        ? "[git-sync] Código já estava atualizado."
        : "[git-sync] Código sincronizado com origin/master.",
      branch_before: branchBefore,
      warnings,
      proceed: true,
    };
  }
}
