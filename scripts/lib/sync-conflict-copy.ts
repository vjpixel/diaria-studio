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

import { copyFileSync, existsSync, readdirSync, statSync, utimesSync } from "node:fs";
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
// O bisync do `300` já roda com `--conflict-resolve newer`, e mesmo assim o
// `newer` nem sempre decide: na montagem da 261116 o log de 17/11/2026, 13:47
// UTC, traz `sizes differ` e em seguida Path1 → `blocks.json.conflict1` e
// Path2 → `blocks.json.conflict2`, as DUAS versões renomeadas e o nome
// original sumido (o mesmo se repetiu até `.conflict4`, e todo comando parou
// com "ausente"). Os helpers abaixo acham as cópias de um arquivo ausente para
// a mensagem de erro apontar a mais nova e o comando de restauração. Quando os
// mtimes empatam, a escolha é arbitrária e a mensagem diz isso, sem chamar
// nenhuma de "mais recente". Escolher é julgamento (o editor confere), então
// restaurar só acontece por pedido explícito e nomeado (`restoreFromConflictCopy`).

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
  // Preserva o mtime da cópia: a prévia e o SRT se comparam por mtime com o plano (#12579).
  copy: (from, to) => {
    copyFileSync(from, to);
    const st = statSync(from);
    utimesSync(to, st.atime, st.mtime);
  },
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

/**
 * A escolha entre as cópias de um arquivo (#13404). É a ÚNICA lista que a
 * mensagem de erro e a restauração leem, para a mensagem nunca mostrar uma
 * cópia e a restauração copiar outra.
 *   - `none`: nenhuma cópia ao lado;
 *   - `newest`: uma cópia tem o mtime estritamente maior que as outras;
 *   - `tie`: as mais novas empatam no mtime, e a escolha entre elas seria
 *     arbitrária (nunca restaurada sozinha, nunca chamada de "mais recente").
 */
export type ConflictChoice =
  | { kind: "none" }
  | { kind: "newest"; chosen: SyncConflictCopy; copies: SyncConflictCopy[] }
  | { kind: "tie"; tied: SyncConflictCopy[]; copies: SyncConflictCopy[] };

export function chooseConflictCopy(filePath: string, fs: ConflictCopyFs = NODE_CONFLICT_COPY_FS): ConflictChoice {
  const copies = conflictCopiesOf(filePath, fs);
  if (!copies.length) return { kind: "none" };
  const tied = copies.filter((c) => c.mtimeMs === copies[0].mtimeMs);
  if (tied.length > 1) return { kind: "tie", tied, copies };
  return { kind: "newest", chosen: copies[0], copies };
}

/** O horário em BRT (UTC-3, sem horário de verão desde 2019), com o offset explícito. */
export function brtStamp(ms: number): string {
  return `${new Date(ms - 3 * 3600_000).toISOString().slice(0, 19).replace("T", " ")} BRT (UTC-3)`;
}

/**
 * O comando de Git Bash que restaura a cópia `copy` como `filePath`, entre
 * aspas simples. `null` quando algum dos caminhos tem aspa simples: aí o
 * comando não é gerado (escapar no Git Bash e no PowerShell é diferente, e um
 * comando errado sobrescreveria o arquivo errado).
 */
export function conflictRestoreCommand(copy: string, filePath: string): string | null {
  if (copy.includes("'") || filePath.includes("'")) return null;
  return `cp '${copy}' '${filePath}'`;
}

/**
 * Linhas que explicam um arquivo ausente com cópias de conflito ao lado
 * (#13404): a cópia mais nova, as outras e o comando de restauração (Git
 * Bash). `restoreFlag` (ex.: `--restore-conflict blocks.json`) entra só
 * quando há uma mais nova de fato, a mesma que a flag restauraria. No empate,
 * a mensagem diz que a escolha é arbitrária e não sugere comando nem flag.
 * Vazio sem cópia. Nunca restaura.
 */
export function missingFileConflictHint(filePath: string, choice: ConflictChoice, restoreFlag?: string): string[] {
  if (choice.kind === "none") return [];
  const n = choice.copies.length;
  if (choice.kind === "tie") {
    return [
      `o sync de data/ deixou ${n} cópia(s) de conflito no lugar (#13404); ${choice.tied.map((c) => c.name).join(", ")} têm o mesmo horário (${brtStamp(choice.tied[0].mtimeMs)}), então a escolha entre elas é arbitrária: conferir o conteúdo e copiar à mão a certa para ${basename(filePath)}`,
    ];
  }
  const rest = choice.copies.filter((c) => c !== choice.chosen);
  const others = rest.length ? `; as outras: ${rest.map((c) => c.name).join(", ")}` : "";
  const cmd = conflictRestoreCommand(choice.chosen.path, filePath);
  return [
    `o sync de data/ deixou ${n} cópia(s) de conflito no lugar (#13404); a mais nova é ${choice.chosen.name} (modificada em ${brtStamp(choice.chosen.mtimeMs)})${others}`,
    cmd ? `conferir e restaurar (Git Bash): ${cmd}` : `conferir e copiar à mão ${choice.chosen.name} para ${basename(filePath)} (caminho com aspa simples: comando não gerado)`,
    ...(restoreFlag ? [`ou rodar o comando de novo com ${restoreFlag} (copia ${choice.chosen.name} de volta, com [premissa])`] : []),
  ];
}

export type ConflictRestoreResult =
  | { status: "restored"; from: string; others: string[] }
  | { status: "present" }
  | { status: "no-copy" }
  | { status: "tie"; tied: string[] };

/**
 * Restaura UM arquivo nomeado a partir da cópia que `chooseConflictCopy`
 * aponta (#13404). Original presente nunca é sobrescrito (`present`), empate
 * não restaura (`tie`), e as cópias ficam no disco como evidência. Só roda
 * por pedido explícito de quem chama: varrer o diretório ressuscitaria cópias
 * velhas de arquivos que o pipeline apagou de propósito.
 */
export function restoreFromConflictCopy(filePath: string, fs: ConflictCopyFs = NODE_CONFLICT_COPY_FS): ConflictRestoreResult {
  if (fs.exists(filePath)) return { status: "present" };
  const choice = chooseConflictCopy(filePath, fs);
  if (choice.kind === "none") return { status: "no-copy" };
  if (choice.kind === "tie") return { status: "tie", tied: choice.tied.map((c) => c.path) };
  fs.copy(choice.chosen.path, filePath);
  return { status: "restored", from: choice.chosen.path, others: choice.copies.filter((c) => c !== choice.chosen).map((c) => c.path) };
}
