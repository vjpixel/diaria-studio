/**
 * scripts/lib/sync-conflict-copy.ts (#12357, épica #12353)
 *
 * Reconhece as cópias de conflito que os DOIS clientes de sync de `data/`
 * deixam no disco, enquanto a transição OneDrive → Google Drive durar
 * (cutover na #12359):
 *
 *   - OneDrive (`abraunegg/onedrive`): `{stem}-{máquina}-safeBackup-NNNN.{ext}`
 *     (`overnight-300-abc-300-safeBackup-0001.json`). O sufixo entra ANTES da
 *     extensão.
 *   - rclone bisync com `--conflict-loser num` (o que o
 *     `scripts/systemd/gdrive-bisync.sh` usa): `{nome-inteiro}.conflictN`. O
 *     sufixo entra DEPOIS do nome completo, extensão incluída, e N cresce a
 *     cada conflito novo do mesmo arquivo. Medido com o rclone v1.75.2 do
 *     `300` em 08/11/2026, num `rclone bisync` entre dois diretórios locais
 *     com o mesmo arquivo alterado dos dois lados:
 *     `sessions/s-123.json` → `sessions/s-123.json.conflict1`, e um 2º
 *     conflito no mesmo arquivo → `s-123.json.conflict2`; `noext` →
 *     `noext.conflict1`; `arch.tar.gz` → `arch.tar.gz.conflict1`. Com
 *     `--conflict-resolve newer` o vencedor fica com o nome original e só o
 *     perdedor ganha o sufixo (nos dois lados); sem ele, as duas versões
 *     ganham sufixo e o original some. O texto `conflict` é o default de
 *     `--conflict-suffix`, que o script não muda.
 *
 * Consequência que mudou código: `.json.conflict1` não termina em `.json`,
 * então toda listagem por extensão (a do `session-registry`, por exemplo)
 * simplesmente não via a cópia: nem a unia ao registro real (perdendo a claim
 * que só sobreviveu nela), nem a recolhia no GC.
 *
 * **Liberação seguida de conflito (review da #12357).** Com
 * `--conflict-resolve newer` o perdedor é SEMPRE a versão de mtime mais
 * antigo. Se uma sessão solta uma claim (`unclaimIssue`, real fica `[1]`) e
 * depois o bisync acha conflito com uma versão anterior do mesmo arquivo
 * (`[1, 2]`), a `.conflict1` nasce carregando a claim já solta — e nasce
 * DEPOIS do unclaim, então o write-path do #6567 (que limpa as cópias que
 * existem no momento do unclaim) não a alcança. O que acontece com ela é o
 * mesmo que com a `-safeBackup-` do OneDrive, sem regra nova:
 *   - read-path (`readEffectiveSessionRecord`, `listActiveSessions`): a união
 *     fail-safe do #6130 a mostra reivindicada enquanto a cópia existir — o
 *     erro tolerado é o falso-positivo (issue parece presa), nunca o
 *     falso-negativo (duas sessões na mesma issue);
 *   - `reconcileClaims`: NÃO a devolve ao real — o `claimed_issues_at` da
 *     cópia é anterior ao heartbeat do real, a evidência de soltura
 *     deliberada do #6698;
 *   - `planSafeBackupCleanup`: pela mesma decisão, a cópia é `removable`, e
 *     o cleanup encerra o falso-positivo.
 * Sem `claimed_issues_at` (claim anterior ao #6436) não há evidência, e a
 * claim volta pelo `reconcileClaims` — mesmo trade-off documentado no #6698.
 * Travado por `test/sync-conflict-copy-12357.test.ts`.
 */

import { copyFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

/** `.conflictN` no FIM do nome (rclone bisync, `--conflict-loser num`). */
export const RCLONE_CONFLICT_SUFFIX_RE = /\.conflict(\d+)$/;

/** Marcador da cópia de conflito do OneDrive. */
export const ONEDRIVE_SAFE_BACKUP_MARKER = "-safeBackup-";

export function isOnedriveSafeBackupName(name: string): boolean {
  return name.includes(ONEDRIVE_SAFE_BACKUP_MARKER);
}

export function isRcloneConflictName(name: string): boolean {
  return RCLONE_CONFLICT_SUFFIX_RE.test(name);
}

/** Cópia de conflito de qualquer um dos dois clientes. */
export function isSyncConflictCopyName(name: string): boolean {
  return isOnedriveSafeBackupName(name) || isRcloneConflictName(name);
}

/** Nome do arquivo original de uma cópia `.conflictN` do rclone
 * (`s.json.conflict2` → `s.json`). `null` se o nome não tem o sufixo. */
export function rcloneConflictOriginalName(name: string): string | null {
  const m = RCLONE_CONFLICT_SUFFIX_RE.exec(name);
  if (!m) return null;
  const original = name.slice(0, m.index);
  return original.length > 0 ? original : null;
}

/**
 * A cópia de conflito `copy` pertence ao arquivo real `{stem}{ext}`?
 *
 * - OneDrive: o nome da cópia começa com `{stem}-` (o cliente intercala
 *   `-{máquina}-safeBackup-NNNN` antes da extensão). É a regra que o
 *   `session-registry` sempre usou; quando mais de um stem real é prefixo,
 *   quem chama desempata pelo mais longo.
 * - rclone: o nome original da cópia é exatamente `{stem}{ext}`.
 */
export function conflictCopyBelongsToStem(copy: string, stem: string, ext: string): boolean {
  if (isRcloneConflictName(copy)) return rcloneConflictOriginalName(copy) === `${stem}${ext}`;
  if (isOnedriveSafeBackupName(copy)) return copy.startsWith(`${stem}-`);
  return false;
}

// ---------------------------------------------------------------------------
// Arquivo de trabalho que sumiu no sync (#13404)
// ---------------------------------------------------------------------------
//
// Sem `--conflict-resolve newer`, o bisync renomeia as DUAS versões de um
// arquivo alterado dos dois lados entre duas rodadas, e o nome original some
// (montagem da 261116: `blocks.json` virou `blocks.json.conflict1..4` e todo
// comando parou com "ausente"). Os helpers abaixo acham as cópias de um
// arquivo ausente para a mensagem de erro apontar a mais recente e o comando
// de restauração. Escolher a cópia é julgamento (o editor confere), então
// restaurar só acontece por pedido explícito (`restoreMissingFromConflictCopies`).

/** Uma cópia de conflito do arquivo `{dir}/{nome}`. `seq` é o `N` do rclone ou o `NNNN` do OneDrive. */
export interface SyncConflictCopy {
  path: string;
  name: string;
  seq: number;
  mtimeMs: number;
}

/** O que os helpers leem e escrevem no disco (injetável nos testes). */
export interface ConflictCopyFs {
  readdir(dir: string): string[];
  mtimeMs(path: string): number;
  exists(path: string): boolean;
  copy(from: string, to: string): void;
}

export const NODE_CONFLICT_COPY_FS: ConflictCopyFs = {
  readdir: (dir) => readdirSync(dir),
  mtimeMs: (p) => statSync(p).mtimeMs,
  exists: (p) => existsSync(p),
  copy: (from, to) => copyFileSync(from, to),
};

function conflictSeq(name: string): number {
  const r = RCLONE_CONFLICT_SUFFIX_RE.exec(name);
  if (r) return Number(r[1]);
  const o = /-safeBackup-(\d+)/.exec(name);
  return o ? Number(o[1]) : 0;
}

/**
 * As cópias de conflito (rclone ou OneDrive) de `filePath` no mesmo
 * diretório, a mais recente primeiro (mtime; no empate, o maior N, a mesma
 * ordem de `findPlanSafeBackups`). Diretório ilegível = nenhuma.
 */
export function conflictCopiesOf(filePath: string, fs: ConflictCopyFs = NODE_CONFLICT_COPY_FS): SyncConflictCopy[] {
  const base = basename(filePath);
  const ext = extname(base);
  const stem = base.slice(0, base.length - ext.length);
  let names: string[];
  try {
    names = fs.readdir(dirname(filePath));
  } catch {
    return [];
  }
  const out: SyncConflictCopy[] = [];
  for (const name of names) {
    if (!conflictCopyBelongsToStem(name, stem, ext)) continue;
    const path = join(dirname(filePath), name);
    let mtimeMs: number;
    try {
      mtimeMs = fs.mtimeMs(path);
    } catch {
      continue;
    }
    out.push({ path, name, seq: conflictSeq(name), mtimeMs });
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs || b.seq - a.seq);
}

/** Aspas simples: o mesmo comando roda no Git Bash e no PowerShell (lá `cp` é alias de `Copy-Item`). */
const shQuote = (p: string) => `'${p.replace(/'/g, "'\\''")}'`;

/** O comando que restaura a cópia `copy` como `filePath`. */
export function conflictRestoreCommand(copy: string, filePath: string): string {
  return `cp ${shQuote(copy)} ${shQuote(filePath)}`;
}

/**
 * Linhas que explicam um arquivo ausente com cópias de conflito ao lado
 * (#13404): a mais recente, as outras e o comando de restauração. Vazio sem
 * cópia. Nunca restaura: quem escolhe a cópia é o editor.
 */
export function missingFileConflictHint(filePath: string, copies: readonly SyncConflictCopy[]): string[] {
  if (!copies.length) return [];
  const [latest, ...rest] = copies;
  const others = rest.length ? `; as outras: ${rest.map((c) => c.name).join(", ")}` : "";
  return [
    `o sync de data/ deixou ${copies.length} cópia(s) de conflito no lugar (#13404); a mais recente é ${latest.name} (modificada em ${new Date(latest.mtimeMs).toISOString()})${others}`,
    `conferir e restaurar: ${conflictRestoreCommand(latest.path, filePath)}`,
  ];
}

export interface ConflictRestore {
  /** O arquivo recriado. */
  restored: string;
  /** A cópia (a mais recente) que voltou para o nome original. */
  from: string;
  /** As cópias que ficaram de fora, para conferência. */
  others: string[];
}

/**
 * Para cada arquivo de `dir` que só existe como cópia `.conflictN` do rclone,
 * copia a mais recente de volta para o nome original (#13404). O original
 * presente nunca é tocado, e as cópias ficam no disco como evidência. Só roda
 * por pedido explícito de quem chama.
 */
export function restoreMissingFromConflictCopies(dir: string, fs: ConflictCopyFs = NODE_CONFLICT_COPY_FS): ConflictRestore[] {
  let names: string[];
  try {
    names = fs.readdir(dir);
  } catch {
    return [];
  }
  const originals = new Set<string>();
  for (const name of names) {
    const original = rcloneConflictOriginalName(name);
    if (original) originals.add(original);
  }
  const out: ConflictRestore[] = [];
  for (const original of [...originals].sort()) {
    const target = join(dir, original);
    if (fs.exists(target)) continue;
    const copies = conflictCopiesOf(target, fs).filter((c) => isRcloneConflictName(c.name));
    if (!copies.length) continue;
    fs.copy(copies[0].path, target);
    out.push({ restored: target, from: copies[0].path, others: copies.slice(1).map((c) => c.path) });
  }
  return out;
}
