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
