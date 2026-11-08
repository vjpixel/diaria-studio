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
 */

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
