#!/usr/bin/env npx tsx
/**
 * sweep-continuo-orphan-sessions.ts (#10002)
 *
 * Encerra registros `data/sessions/continuo-{tag}-hermes-cron-{job}-*.json`
 * deixados por ticks do contínuo que falharam cedo e nunca chamaram `end`.
 * Achado ao vivo em 10/10/2026: 35 arquivos acumulados numa madrugada em que
 * todo tick morria no 1º passo (cota do provider esgotada, #10001) — o
 * wrapper `register-continuo-tick.sh` registra a sessão ANTES de invocar o
 * modelo (#8740), e quem encerra é o próprio tick, no fim. Tick que morre
 * não encerra.
 *
 * Quem chama: `hermes/scripts/register-continuo-tick.sh`, no início de cada
 * tick, antes de registrar a sessão nova — o tick seguinte limpa o anterior.
 *
 * Critério (todos obrigatórios — na dúvida, mantém):
 *   1. `kind === "continuo"` e `machineTag` da máquina local (nunca encerra
 *      registro de outra máquina);
 *   2. `sessionId` do MESMO job do cron (`hermes-cron-{job}-…`) e diferente
 *      da sessão atual (`--exclude`);
 *   3. `claimed_issues` vazio — encerrar nunca libera uma claim;
 *   4. heartbeat mais recente (`lastHeartbeat ?? startedAt`) mais velho que
 *      `SOFT_STALE_MS` (90min) — mesma janela em que o registry já marca a
 *      sessão `stale`. Um tick vivo que ainda bate heartbeat nunca entra.
 *      Timestamp ilegível ou no futuro → mantém.
 * Cópias de conflito (`-safeBackup-`) ficam com o GC (`session-registry.ts
 * gc`), que já sabe tratá-las; o encerramento usa `endSession`, que carimba
 * `endedAt` nelas.
 *
 * Exit code 0 sempre que conseguiu rodar (fail-soft: o chamador é o wrapper
 * do cron, que não pode travar o tick por causa de limpeza de ruído).
 *
 * Uso:
 *   npx tsx scripts/sweep-continuo-orphan-sessions.ts --job 5d791ef6fc2c --exclude <session-id> [--dry-run]
 *
 * @see test/sweep-continuo-orphan-sessions.test.ts
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/cli-args.ts";
import {
  SOFT_STALE_MS,
  endSession,
  machineTag,
  sessionsDir,
  type SessionRecord,
} from "./lib/session-registry.ts";

export interface SweepCandidate {
  sessionId: string;
  action: "end" | "keep";
  reason: string;
}

export interface SweepOptions {
  jobId: string;
  localTag: string;
  now: number;
  /** Sessão do tick corrente — nunca encerrada. */
  excludeSessionId?: string;
}

/** Decisão PURA (sem I/O) sobre registros já lidos. Só olha registros do
 *  kind `continuo` do job pedido; o resto nem aparece no resultado. */
export function planContinuoOrphanSweep(
  records: readonly SessionRecord[],
  opts: SweepOptions,
): SweepCandidate[] {
  const prefix = `hermes-cron-${opts.jobId}-`;
  const out: SweepCandidate[] = [];
  for (const r of records) {
    if (r.kind !== "continuo" || typeof r.sessionId !== "string" || !r.sessionId.startsWith(prefix)) continue;
    const keep = (reason: string) => out.push({ sessionId: r.sessionId, action: "keep", reason });
    if (r.sessionId === opts.excludeSessionId) {
      keep("sessão do tick corrente");
      continue;
    }
    if (r.machineTag !== opts.localTag) {
      keep(`registro de outra máquina (${r.machineTag})`);
      continue;
    }
    const claims = Array.isArray(r.claimed_issues) ? r.claimed_issues : [];
    if (claims.length > 0) {
      keep(`tem claimed_issues (#${claims.join(", #")}) — encerrar liberaria claim`);
      continue;
    }
    const hb = Date.parse(r.lastHeartbeat ?? r.startedAt ?? "");
    if (!Number.isFinite(hb)) {
      keep("timestamp ilegível");
      continue;
    }
    const ageMs = opts.now - hb;
    if (ageMs < 0) {
      keep("heartbeat no futuro (clock skew)");
      continue;
    }
    if (ageMs <= SOFT_STALE_MS) {
      keep(`heartbeat recente (${Math.round(ageMs / 60_000)}min ≤ ${SOFT_STALE_MS / 60_000}min)`);
      continue;
    }
    out.push({
      sessionId: r.sessionId,
      action: "end",
      reason: `tick sem end: heartbeat há ${Math.round(ageMs / 60_000)}min, sem claimed_issues`,
    });
  }
  return out;
}

/** Lê os registros reais (sem `-safeBackup-`) do kind `continuo`. Arquivo
 *  ilegível é pulado — nunca encerrado sem ser entendido. */
export function readContinuoRecords(repoRoot: string): SessionRecord[] {
  const dir = sessionsDir(repoRoot);
  if (!existsSync(dir)) return [];
  const records: SessionRecord[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.startsWith("continuo-") || !name.endsWith(".json") || name.includes("-safeBackup-")) continue;
    try {
      const r = JSON.parse(readFileSync(join(dir, name), "utf8")) as SessionRecord;
      if (r && typeof r === "object" && typeof r.sessionId === "string") records.push(r);
    } catch {
      // ilegível: fica com o GC, que também nunca remove o que não entende
    }
  }
  return records;
}

export function sweepContinuoOrphanSessions(
  repoRoot: string,
  opts: Omit<SweepOptions, "localTag" | "now"> & { localTag?: string; now?: number; dryRun?: boolean },
): { ended: string[]; plan: SweepCandidate[]; errors: string[] } {
  const localTag = opts.localTag ?? machineTag();
  const plan = planContinuoOrphanSweep(readContinuoRecords(repoRoot), {
    jobId: opts.jobId,
    excludeSessionId: opts.excludeSessionId,
    localTag,
    now: opts.now ?? Date.now(),
  });
  const ended: string[] = [];
  const errors: string[] = [];
  if (opts.dryRun) return { ended, plan, errors };
  for (const c of plan) {
    if (c.action !== "end") continue;
    try {
      if (endSession(repoRoot, "continuo", c.sessionId, localTag)) ended.push(c.sessionId);
    } catch (e) {
      errors.push(`${c.sessionId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { ended, plan, errors };
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  const arg = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const jobId = arg("--job");
  if (!jobId) {
    console.error("sweep-continuo-orphan-sessions: --job é obrigatório");
    process.exitCode = 1;
  } else {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const r = sweepContinuoOrphanSessions(repoRoot, {
      jobId,
      excludeSessionId: arg("--exclude"),
      dryRun: argv.includes("--dry-run"),
    });
    const toEnd = r.plan.filter((c) => c.action === "end").length;
    console.log(
      `sweep-continuo-orphan-sessions: ${r.ended.length} encerrada(s) de ${toEnd} candidata(s)` +
        (argv.includes("--dry-run") ? " (dry-run)" : "") +
        (r.errors.length ? `; ${r.errors.length} erro(s): ${r.errors.join("; ")}` : ""),
    );
  }
}
