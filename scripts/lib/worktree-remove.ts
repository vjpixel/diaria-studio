/**
 * scripts/lib/worktree-remove.ts (#8209)
 *
 * Remoção SEGURA de diretório de worktree que contém junctions (Windows) ou
 * symlinks (Linux/macOS) apontando pra fora dele — tipicamente `node_modules`
 * e `data`, criados pelo padrão documentado de bootstrap de worktree pra
 * evitar reinstalar dependências/duplicar a junction do OneDrive por
 * worktree.
 *
 * ## Causa raiz (#8209)
 *
 * `git worktree remove` (Windows) apaga os arquivos rastreados e a metadata
 * do worktree, mas **não remove o diretório que contém junctions** — sobra
 * uma "casca" sem `.git`, invisível a `git worktree list`
 * (`scripts/cleanup-merged-worktrees.ts` e `scripts/branch-cleanup.ts`
 * partem dessa lista, então nunca a veem). 53 cascas acumuladas em
 * `C:\Users\vjpix\Projects` medidas ao vivo em 17/09/2026 (Neo).
 *
 * ## Risco que este módulo existe pra evitar
 *
 * Apagar uma casca com ferramenta que SEGUE symlink/junction (`rm -rf`,
 * `Remove-Item -Recurse`, Explorer do Windows) pode apagar o CONTEÚDO do
 * alvo — `node_modules` do checkout principal, ou o `data/` do OneDrive.
 * `fs.rmSync`/`fs.rmdirSync`/`fs.unlinkSync` do Node, ao encontrar um
 * symlink/junction durante uma varredura, operam sobre o LINK em si (via
 * `lstat`, nunca `stat`) — nunca seguem pra dentro do alvo. Isso é o
 * contrato do Node (mesma semântica de `rm -rf` no POSIX: um `rm -rf` nunca
 * segue um symlink pra dentro dele, mesmo em modo recursivo) — mas este
 * módulo além disso remove os LINKS explicitamente primeiro (`removeLinkSafely`),
 * relata o que foi removido, e só então limpa o que sobrar, dando uma
 * segunda camada de segurança e visibilidade sobre o que aconteceu.
 *
 * ## Windows vs. Linux/macOS
 *
 * No Windows, uma *directory junction* aparece pro Node como
 * `lstat().isSymbolicLink() === true` — mesmo contrato de um symlink real.
 * `fs.rmdirSync(link)` remove a junction sem tocar o alvo (é o modo
 * documentado de remover junction no Windows — `fs.unlink` pode falhar com
 * `EPERM`/`EISDIR` numa junction, dependendo da versão do Node). Este
 * módulo tenta `unlinkSync` primeiro (caminho comum no Linux/macOS) e cai
 * pra `rmdirSync` se falhar — cobre os dois SOs com o mesmo código, sem
 * `process.platform` no meio da lógica (só symlinks são tratados; a
 * detecção via `lstat().isSymbolicLink()` já é o discriminador correto nos
 * dois SOs).
 */

import { existsSync, lstatSync, readdirSync, rmSync, rmdirSync, statSync, unlinkSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { isMainModule } from "./cli-args.ts";
import { listAllProcesses, listProcessesStrict, type ProcessInfo } from "./list-processes.ts";
import type { OrphanRescueFn } from "./orphan-rescue.ts";

/** `true` só quando `path` existe e é um symlink (Linux/macOS) ou junction (Windows) — nunca segue o alvo. */
export function isSymlinkOrJunction(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Varre `root` recursivamente (bounded por `maxDepth`) e devolve todo
 * caminho que é symlink/junction — NUNCA desce pra dentro de um
 * symlink/junction encontrado (só lista o próprio link, não o que ele
 * aponta). Cobre `node_modules`/`data` na raiz do worktree E nested (ex:
 * `workers/{pkg}/node_modules`), sem depender de enumerar nomes/profundidade
 * fixos.
 */
export function findLinksUnder(root: string, maxDepth = 4): string[] {
  const found: string[] = [];

  function walk(dir: string, depth: number): void {
    if (depth > maxDepth) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (isSymlinkOrJunction(full)) {
        found.push(full);
        continue; // nunca segue pra dentro do link
      }
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      }
    }
  }

  walk(root, 0);
  return found;
}

/** Remove só o LINK (`unlinkSync`, fallback `rmdirSync` pra junction Windows) — nunca o alvo apontado. */
export function removeLinkSafely(linkPath: string): { removed: boolean; error?: string } {
  if (!isSymlinkOrJunction(linkPath)) {
    return { removed: false, error: "não é symlink/junction — recusado por segurança" };
  }
  try {
    unlinkSync(linkPath);
    return { removed: true };
  } catch {
    try {
      rmdirSync(linkPath);
      return { removed: true };
    } catch (e2) {
      return { removed: false, error: (e2 as Error).message };
    }
  }
}

/** Escapa caracteres especiais de regex — usado só por `commandReferencesPath`
 * pra montar o boundary check abaixo com o path do worktree como literal. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * #8661: `true` quando `proc.cmd` (cmdline completo, ver
 * `scripts/lib/list-processes.ts`) contém `worktreePath`, com boundary
 * depois do path — a checagem que `removeWorktreeSafe` roda ANTES de
 * `git worktree remove --force`, pra não deixar um processo (tipicamente
 * `node --test-isolation=process`, mas a checagem não é restrita a esse
 * padrão — QUALQUER processo com o path na cmdline conta) sobreviver à
 * remoção como um neto órfão `PPID=1` (mecanismo completo: issue #8661).
 *
 * **Boundary depois do path** (achado do fleet review da PR #8692,
 * médio): substring PURO faria `agent-1` casar dentro de `agent-10` — dois
 * worktrees legítimos e distintos onde um é prefixo textual do outro. O
 * caractere IMEDIATAMENTE após o match precisa ser algo que não continua
 * um nome de diretório (`/`, `\`, espaço, `=`, aspas, ou fim da string) —
 * nunca um caractere alfanumérico/`-`/`_`. Continua substring (não
 * tokenização) pelo mesmo motivo de antes: cmdline real observado ao vivo
 * tem o worktree embutido num argumento maior (`--experimental-loader=
 * {worktree}/...`), então exigir um TOKEN inteiro perderia esses casos —
 * só o fim do path precisa ser delimitado, o início não.
 */
export function commandReferencesPath(cmd: string, worktreePath: string): boolean {
  // #14335: no Windows a cmdline traz o path com `\` (`--require C:\...\tsx\
  // preflight.cjs`) e o `git worktree list` com `/`; as duas pontas viram `/`
  // antes da comparação. Path com letra de drive compara sem caixa (NTFS).
  const normCmd = cmd.replace(/\\/g, "/");
  const normPath = worktreePath.replace(/\\/g, "/").replace(/\/+$/, "");
  const flags = /^[A-Za-z]:\//.test(normPath) ? "i" : "";
  const boundaryRe = new RegExp(`${escapeRegExp(normPath)}(?![A-Za-z0-9_-])`, flags);
  return boundaryRe.test(normCmd);
}

/**
 * #14335: conjunto de chaves para excluir caminhos já registrados no `git
 * worktree list` (`C:/...`) de uma varredura que monta caminhos com `join`
 * (`C:\...` no Windows). Puro.
 */
export function buildExcludedPathKeys(paths: Iterable<string>): Set<string> {
  return new Set([...paths].map(normalizePathKey));
}

/** #14335: `true` se `candidate` está no conjunto de `buildExcludedPathKeys`, qualquer que seja o separador ou a caixa da letra de drive. */
export function isExcludedPath(candidate: string, excludedKeys: ReadonlySet<string>): boolean {
  return excludedKeys.has(normalizePathKey(candidate));
}

/** #14335: chave de comparação de path — `/` como separador, sem `/` final, minúsculo quando tem letra de drive. */
export function normalizePathKey(path: string): string {
  const p = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[A-Za-z]:\//.test(p) ? p.toLowerCase() : p;
}

/**
 * #8661: processos vivos (do snapshot `processes`, default a máquina real
 * via `listAllProcesses()`) cujo cmdline referencia `worktreePath` — usado
 * por `removeWorktreeSafe` (`scripts/cleanup-merged-worktrees.ts`) pra
 * decidir se é seguro chamar `git worktree remove --force` agora, ou se é
 * melhor pular esta remoção neste ciclo (o processo ainda pode terminar
 * sozinho; a próxima rodada de limpeza tenta de novo). `[]` sempre que a
 * plataforma não é suportada por `listAllProcesses` (Windows — ver
 * docstring de lá) ou quando genuinamente não há processo vivo apontando
 * pro path. O guard real de `cleanup-merged-worktrees.ts` passa o snapshot de
 * `listProcessesForWorktreeGuard()`, que desde o #14335 cobre o Windows.
 */
export function findLiveProcessesInPath(
  worktreePath: string,
  processes: readonly ProcessInfo[] = listAllProcesses(),
): ProcessInfo[] {
  return processes.filter((proc) => commandReferencesPath(proc.cmd, worktreePath));
}

export interface RemoveWorktreeDirResult {
  /** Links (symlink/junction) removidos explicitamente antes da limpeza do resto. */
  removedLinks: string[];
  /** Erros (link que não pôde ser removido, ou falha na limpeza final) — nunca lança. */
  errors: string[];
  /** `true` se `dirPath` não existe mais ao final (sucesso completo). */
  dirRemoved: boolean;
}

/**
 * Remove `dirPath` (diretório de worktree ou casca) de forma segura: (1)
 * localiza e remove todo symlink/junction primeiro, individualmente,
 * relatando cada um; (2) limpa o que sobrar via `fs.rmSync` recursivo
 * (seguro contra symlink por contrato do Node — ver docstring do módulo);
 * (3) confirma que o diretório sumiu. Nunca lança — falha vira entrada em
 * `errors`, chamador decide o que fazer.
 */
export function removeWorktreeDirSafely(dirPath: string): RemoveWorktreeDirResult {
  if (!existsSync(dirPath)) {
    return { removedLinks: [], errors: [], dirRemoved: true };
  }

  const links = findLinksUnder(dirPath);
  const removedLinks: string[] = [];
  const errors: string[] = [];

  for (const link of links) {
    const result = removeLinkSafely(link);
    if (result.removed) {
      removedLinks.push(link);
    } else {
      errors.push(`${link}: ${result.error}`);
    }
  }

  try {
    rmSync(dirPath, { recursive: true, force: true });
  } catch (e) {
    errors.push(`rmSync ${dirPath}: ${(e as Error).message}`);
  }

  return { removedLinks, errors, dirRemoved: !existsSync(dirPath) };
}

/**
 * `true` quando `dirPath` "parece uma casca de worktree removido" (#8209):
 * sem `.git` (arquivo OU diretório — um worktree de verdade tem um arquivo
 * `.git` apontando pra `main/.git/worktrees/{nome}`; o checkout principal
 * tem um diretório `.git`), e todo conteúdo não-link é só diretório (nunca
 * um arquivo real) — ou seja, o único conteúdo restante são as junctions/
 * symlinks + diretórios vazios que sobraram do bootstrap. Um diretório com
 * qualquer arquivo real (ex: o caso `review-fix-6048` citado na issue, cópia
 * do repo sem git) NUNCA é husk — só REPORTA, nunca apaga.
 */
export function isHuskDirectory(dirPath: string): boolean {
  if (!existsSync(dirPath)) return false;
  if (existsSync(join(dirPath, ".git"))) return false;

  function walk(dir: string, depth: number): boolean {
    if (depth > 8) return true; // bounded — nunca deveria chegar aqui numa casca real
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return true;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (isSymlinkOrJunction(full)) continue; // link é esperado numa casca
      if (entry.isDirectory()) {
        if (!walk(full, depth + 1)) return false;
        continue;
      }
      return false; // arquivo real (não-link, não-diretório) — NÃO é casca
    }
    return true;
  }

  return walk(dirPath, 0);
}

/**
 * Lista subdiretórios imediatos de `baseDir` que são cascas (#8209) — sem
 * `.git`, conteúdo só diretórios/links — EXCLUINDO qualquer caminho em
 * `excludePaths` (tipicamente os worktrees ainda registrados em
 * `git worktree list`, pra nunca tratar um worktree VIVO como casca por um
 * `.git` momentaneamente ilegível). Fail-soft: diretório ilegível é
 * ignorado, nunca lança.
 */
export function findWorktreeHusks(baseDir: string, excludePaths: ReadonlySet<string> = new Set()): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const excluded = buildExcludedPathKeys(excludePaths);
  const husks: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = join(baseDir, entry.name);
    // #14335: `git worktree list` dá `C:/...` e o `join` dá `C:\...` — comparar normalizado.
    if (isExcludedPath(full, excluded)) continue;
    if (isHuskDirectory(full)) husks.push(full);
  }
  return husks;
}

/**
 * #14335: idade mínima (mtime do diretório) para tratar uma pasta sob
 * `.claude/worktrees/` como sobra de remoção parcial. Folga contra corrida
 * com um `git worktree add` em andamento, que cria o diretório antes de o
 * registro aparecer no `git worktree list`.
 */
export const PARTIAL_REMOVAL_ORPHAN_MIN_IDLE_MS = 30 * 60 * 1000;

/**
 * #14335: pastas de `baseDir` (o `.claude/worktrees/` do repo) que sobraram
 * de um `git worktree remove` interrompido no meio: sem `.git`, fora do `git
 * worktree list` (`excludePaths`), com arquivo real dentro (as só-links são
 * cascas do #8209, `findWorktreeHusks`) e paradas há pelo menos `minIdleMs`.
 *
 * O caso que originou: no Windows, um processo vivo com DLL carregada de
 * dentro do worktree (teste pendurado com `sharp`) faz o `git` falhar com
 * "Invalid argument" na primeira entrada que não consegue apagar. O git apaga
 * na ordem do readdir (alfabética no NTFS) e para no primeiro erro, então o `.git` já se foi e o
 * worktree já saiu do registro, mas tudo depois de `node_modules/@img` fica.
 * Nenhuma outra varredura vê essa pasta: não é mais worktree e não é casca.
 *
 * Só olha `.claude/worktrees/`, que é diretório do harness para worktrees:
 * pasta sem `.git` ali não é checkout de ninguém. Fail-soft, nunca lança.
 */
export function findPartialRemovalOrphans(
  baseDir: string,
  excludePaths: ReadonlySet<string> = new Set(),
  opts: { nowMs?: number; minIdleMs?: number; getMtimeMs?: (path: string) => number | null } = {},
): string[] {
  const nowMs = opts.nowMs ?? Date.now();
  const minIdleMs = opts.minIdleMs ?? PARTIAL_REMOVAL_ORPHAN_MIN_IDLE_MS;
  const getMtimeMs =
    opts.getMtimeMs ??
    ((p: string) => {
      try {
        return statSync(p).mtimeMs;
      } catch {
        return null;
      }
    });
  let entries: Dirent[];
  try {
    entries = readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const excluded = buildExcludedPathKeys(excludePaths);
  const orphans: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = join(baseDir, entry.name);
    if (isExcludedPath(full, excluded)) continue;
    if (existsSync(join(full, ".git"))) continue;
    if (isHuskDirectory(full)) continue;
    const mtime = getMtimeMs(full);
    if (mtime === null || nowMs - mtime < minIdleMs) continue;
    orphans.push(full);
  }
  return orphans;
}

/** #14335: dependências da limpeza de uma pasta de remoção parcial. */
export interface PartialRemovalOpts {
  /**
   * Snapshot de processos, tirado na hora (nunca reaproveitado de uma checagem
   * anterior ao `git worktree remove`). Default: `listProcessesStrict()`, que
   * cobre o Windows e LANÇA quando não consegue listar; lançar preserva a pasta.
   */
  getLiveProcesses?: () => readonly ProcessInfo[];
  /** Resgate do que não está no repositório (`makeOrphanRescuer` em `orphan-rescue.ts`). Sem ele nada é apagado. */
  rescue?: OrphanRescueFn;
  /** Remoção do diretório. Default: `removeWorktreeDirSafely`. Injetável só para teste. */
  removeDir?: (path: string) => { dirRemoved: boolean; errors: string[] };
}

/**
 * #14335: apaga uma pasta que o git deixou pela metade, nesta ordem: (1)
 * processo vivo referenciando o caminho → preserva, com os PIDs no erro
 * (matar não é papel daqui, #8661); não conseguir listar processos também
 * preserva; (2) resgate → se falhar, preserva; (3) `removeWorktreeDirSafely`
 * (links primeiro). Nunca lança.
 */
export function cleanupPartialRemovalLeftover(
  path: string,
  opts: PartialRemovalOpts & { rescue: OrphanRescueFn },
): { ok: true; rescueDir: string | null } | { ok: false; error: string } {
  let live: ProcessInfo[];
  try {
    live = findLiveProcessesInPath(path, (opts.getLiveProcesses ?? listProcessesStrict)());
  } catch (e) {
    return { ok: false, error: `não deu para listar processos (${(e as Error).message}), pasta preservada` };
  }
  if (live.length > 0) {
    const detail = live.map((p) => `PID ${p.pid} (${p.cmd.slice(0, 120)})`).join("; ");
    return { ok: false, error: `${live.length} processo(s) vivo(s) ainda referenciam a pasta, preservada para a próxima rodada: ${detail}` };
  }
  const rescued = opts.rescue(path);
  if (!rescued.ok) return { ok: false, error: rescued.error };
  const cleanup = (opts.removeDir ?? removeWorktreeDirSafely)(path);
  if (cleanup.dirRemoved) return { ok: true, rescueDir: rescued.rescueDir };
  const detail = cleanup.errors.join("; ") || "sem detalhe de erro";
  return {
    ok: false,
    error: `a limpeza pelo sistema de arquivos falhou: ${detail}${rescued.rescueDir ? ` (resgate em ${rescued.rescueDir})` : ""}`,
  };
}

export interface GitRemovalResult {
  ok: boolean;
  error?: string;
  /**
   * #14335: só na saída de `resolveWorktreeRemoval`. `"partial-cleaned"` = o
   * git parou no meio e a sobra foi resgatada e apagada aqui; `rescueDir` é o
   * destino do resgate (ausente quando não havia nada fora do repositório).
   * O chamador loga os dois.
   */
  outcome?: "removed" | "partial-cleaned";
  rescueDir?: string;
}

/**
 * Aplica a limpeza segura em cima do resultado de um `git worktree remove
 * --force` já executado pelo chamador. Helper único de
 * `cleanup-merged-worktrees.ts`, `branch-cleanup.ts` e `merge-train-live.ts`.
 * Não chama `git`; com `opts` injetado (processos, resgate, remoção), é
 * testável com diretório temporário real.
 *
 * - **git ok e a pasta sobrou (#8209):** casca com junction/symlink. Roda
 *   `removeWorktreeDirSafely` (links primeiro, nunca seguindo o alvo).
 * - **git falhou com o `.git` ainda na pasta:** o git recusou antes de
 *   começar (lock, path em uso, motivo alheio). Nada é tocado; o erro do git
 *   volta intacto.
 * - **git falhou e o `.git` já não existe (#14335):** remoção parcial. O
 *   `git worktree remove` apaga na ordem do readdir (alfabética no NTFS),
 *   para no primeiro arquivo que não consegue apagar e desregistra o
 *   worktree mesmo assim; nenhum chamador volta a essa pasta. Roda
 *   `cleanupPartialRemovalLeftover`: processo vivo (ou não conseguir listar)
 *   preserva, o resgate do que não está no repositório vem antes de apagar.
 *   Sem `opts.rescue` a pasta nunca é apagada aqui: fica para a varredura de
 *   órfãos de `cleanup-merged-worktrees.ts`, que resgata.
 */
export function resolveWorktreeRemoval(
  gitResult: GitRemovalResult,
  path: string,
  opts: PartialRemovalOpts = {},
): GitRemovalResult {
  if (!gitResult.ok) {
    if (!existsSync(path) || existsSync(join(path, ".git"))) return gitResult;
    const prefix =
      `${gitResult.error ?? "git worktree remove falhou"} — o git já tinha apagado o .git e desregistrado o worktree ` +
      `(remoção parcial, #14335)`;
    if (!opts.rescue) {
      return { ok: false, error: `${prefix}; a pasta fica para a varredura de órfãos do cleanup-merged-worktrees, que resgata antes de apagar` };
    }
    const leftover = cleanupPartialRemovalLeftover(path, { ...opts, rescue: opts.rescue });
    if (!leftover.ok) return { ok: false, error: `${prefix}; ${leftover.error}` };
    return leftover.rescueDir ? { ok: true, outcome: "partial-cleaned", rescueDir: leftover.rescueDir } : { ok: true, outcome: "partial-cleaned" };
  }
  if (!existsSync(path)) return { ok: true, outcome: "removed" };

  const cleanup = removeWorktreeDirSafely(path);
  if (cleanup.dirRemoved) {
    return { ok: true, outcome: "removed" };
  }

  const detail = cleanup.errors.join("; ") || "diretório sobreviveu à limpeza pós-remove, sem detalhe de erro";
  return { ok: false, error: `git worktree remove reportou sucesso mas sobrou uma casca (#8209): ${detail}` };
}

/**
 * CLI standalone (#8209): `npx tsx scripts/lib/worktree-remove.ts <path>`
 * remove `path` com segurança (links primeiro, nunca seguindo pro alvo) e
 * sai 0 se o diretório deixou de existir, 1 caso contrário — pra scripts
 * shell, que não têm runtime Node/TS pra chamar `removeWorktreeDirSafely`
 * diretamente. O único consumidor (`dispatch-glm-lane-unit.sh`) virou lápide
 * no #10431 e saiu no #14059; o CLI fica como utilitário avulso.
 */
if (isMainModule(import.meta.url)) {
  const target = process.argv[2];
  if (!target) {
    console.error("uso: npx tsx scripts/lib/worktree-remove.ts <path>");
    process.exit(1);
  }
  const result = removeWorktreeDirSafely(target);
  console.log(JSON.stringify(result));
  process.exit(result.dirRemoved ? 0 : 1);
}
