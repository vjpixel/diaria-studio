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

import { existsSync, lstatSync, readdirSync, rmSync, rmdirSync, unlinkSync, type Dirent } from "node:fs";
import { join } from "node:path";

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
  const husks: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = join(baseDir, entry.name);
    if (excludePaths.has(full)) continue;
    if (isHuskDirectory(full)) husks.push(full);
  }
  return husks;
}
