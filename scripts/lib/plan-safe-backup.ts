/**
 * plan-safe-backup.ts (#10579)
 *
 * Recuperação de `plan.json` de rodada (overnight/develop/continuo) quando o
 * OneDrive o substitui por uma cópia de conflito `plan-{máquina}-safeBackup-{NNNN}.json`.
 *
 * ## O incidente (rodada 261019d)
 *
 * No meio da Fase 1, `data/overnight/261019d/plan.json` sumiu e no lugar
 * apareceu `plan-300-safeBackup-0001.json` — o OneDrive resolve conflito de
 * sync renomeando a versão local. Todo leitor do plano trata "arquivo
 * ausente" como "rodada não existe": o resolver de path (`createFsPlanProbe`)
 * devolveria `mode: "fresh"` e o coordenador reescreveria um plano novo por
 * cima do estado vivo (`resume_state`, ondas, timestamps de dispatch); o
 * watchdog deixaria de ver a rodada. Só não houve perda porque o coordenador
 * notou e copiou o backup à mão.
 *
 * ## Contrato de `recoverPlanFromSafeBackup(planPath)`
 *
 * - **Sem backup no diretório** → `status: "clean"`, nada muda.
 * - **`plan.json` ausente + ≥1 backup JSON válido** → copia o backup mais
 *   recente (maior mtime; empate → maior `NNNN`) para `plan.json` (escrita
 *   atômica), preservando o mtime do backup no arquivo restaurado (senão uma
 *   rodada abandonada pareceria ativa pro watchdog, que mede atividade por
 *   mtime). O backup NÃO é apagado — fica como evidência/auditoria.
 *   `status: "restored"`.
 * - **`plan.json` ausente + só backups ilegíveis** → `status: "unrecoverable"`,
 *   nada escrito (nunca promove JSON truncado a plano vivo).
 * - **`plan.json` presente + backups ao lado** → `status: "backup-alongside"`,
 *   só aviso: o backup pode carregar estado divergente que o plano vivo não
 *   tem, e escolher entre os dois sem saber qual é o mais completo é
 *   julgamento — fica para o coordenador (merge manual), nunca sobrescrita
 *   automática.
 *
 * Fail-soft: erro de I/O ao listar o diretório → `clean` (o leitor segue com
 * o comportamento de antes, que já trata ausência).
 */

import { existsSync, readdirSync, readFileSync, statSync, utimesSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { writeFileAtomic } from "./atomic-write.ts";

/** `plan-300-safeBackup-0001.json` → captura o número da cópia. Aceita
 * qualquer nome de máquina (inclusive com hífen) entre `plan-` e `-safeBackup-`. */
const PLAN_SAFE_BACKUP_RE = /^plan-.+-safeBackup-(\d+)\.json$/;

export function isPlanSafeBackupName(name: string): boolean {
  return PLAN_SAFE_BACKUP_RE.test(name);
}

export interface PlanSafeBackupFile {
  path: string;
  name: string;
  seq: number;
  mtimeMs: number;
}

/** Lista os `plan-*-safeBackup-*.json` de `dir`, mais recente primeiro. */
export function findPlanSafeBackups(dir: string): PlanSafeBackupFile[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: PlanSafeBackupFile[] = [];
  for (const name of names) {
    const m = PLAN_SAFE_BACKUP_RE.exec(name);
    if (!m) continue;
    const path = join(dir, name);
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    out.push({ path, name, seq: Number(m[1]), mtimeMs });
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs || b.seq - a.seq);
}

export type PlanSafeBackupRecovery =
  | { status: "clean" }
  | { status: "restored"; from: string; backups: string[] }
  | { status: "unrecoverable"; backups: string[] }
  | { status: "backup-alongside"; backups: string[] };

function isValidPlanJson(path: string): string | null {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return raw;
  } catch {
    return null;
  }
}

/**
 * Detecta cópias de conflito do OneDrive ao lado de `planPath` e, se o plano
 * vivo sumiu, restaura a mais recente. Ver contrato no docblock do módulo.
 * Só age quando o basename é `plan.json`.
 */
export function recoverPlanFromSafeBackup(planPath: string): PlanSafeBackupRecovery {
  if (basename(planPath) !== "plan.json") return { status: "clean" };
  const backups = findPlanSafeBackups(dirname(planPath));
  if (backups.length === 0) return { status: "clean" };
  const backupPaths = backups.map((b) => b.path);

  if (existsSync(planPath)) return { status: "backup-alongside", backups: backupPaths };

  for (const b of backups) {
    const raw = isValidPlanJson(b.path);
    if (raw === null) continue;
    try {
      writeFileAtomic(planPath, raw);
    } catch {
      return { status: "unrecoverable", backups: backupPaths };
    }
    try {
      const mtime = new Date(b.mtimeMs);
      utimesSync(planPath, mtime, mtime);
    } catch {
      // mtime é refinamento (watchdog); o conteúdo já foi restaurado.
    }
    return { status: "restored", from: b.path, backups: backupPaths };
  }
  return { status: "unrecoverable", backups: backupPaths };
}

/** Mensagem humana (stderr) para os status que exigem atenção; `null` em `clean`. */
export function describePlanSafeBackupRecovery(planPath: string, r: PlanSafeBackupRecovery): string | null {
  switch (r.status) {
    case "clean":
      return null;
    case "restored":
      return (
        `[plan-safe-backup] ${planPath} tinha sumido (conflito OneDrive) — restaurado de ${r.from}. ` +
        `Backup mantido; confira se as últimas escritas da rodada (dispatch, ondas) estão no plano (#10579).`
      );
    case "unrecoverable":
      return (
        `[plan-safe-backup] ${planPath} ausente e nenhuma cópia de conflito pôde ser restaurada (JSON inválido ou falha de escrita) ` +
        `(${r.backups.join(", ")}) — nada restaurado; recuperar à mão (#10579).`
      );
    case "backup-alongside":
      return (
        `[plan-safe-backup] cópia(s) de conflito OneDrive ao lado de ${planPath}: ${r.backups.join(", ")} — ` +
        `o plano vivo foi mantido; compare e mescle à mão se o backup tiver estado mais novo (#10579).`
      );
  }
}

/** Atalho para leitores: recupera e imprime o aviso em stderr. */
export function recoverPlanFromSafeBackupWithWarning(planPath: string): PlanSafeBackupRecovery {
  const r = recoverPlanFromSafeBackup(planPath);
  const msg = describePlanSafeBackupRecovery(planPath, r);
  if (msg) console.error(msg);
  return r;
}
