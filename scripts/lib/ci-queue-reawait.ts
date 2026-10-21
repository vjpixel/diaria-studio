#!/usr/bin/env -S npx tsx
/**
 * scripts/lib/ci-queue-reawait.ts (#10699 item 1)
 *
 * Contador PERSISTIDO do teto de reaguardos de CI em fila (#10671). O
 * `wait-pr-checks.sh` sai com exit 7 quando os checks ficaram na fila de
 * runner do GitHub até o teto absoluto do helper (#10578): não é CI vermelho,
 * o coordenador reaguarda. O teto de 3 reaguardos consecutivos por PR existia
 * só no texto das skills: depois de uma compaction ou retomada, o coordenador
 * perde a conta e a espera volta a ser ilimitada. Este módulo grava a conta em
 * `plan.json` → `ci_queue_reawaits: { "<pr>": n }`.
 *
 * Uso (após CADA saída do `wait-pr-checks.sh`, standalone):
 *   npx tsx scripts/lib/ci-queue-reawait.ts --plan data/overnight/{AAMMDD}/plan.json --pr N --exit RC
 *
 * Saída: JSON `{ pr, exit, queue_reawaits, action }`, com `action`:
 *   - `reawait`  → exit 7 dentro do teto: chamar o helper de novo (CLI exit 0);
 *   - `give-up`  → exit 7 depois do 3º reaguardo: emitir `ci_timeout` com
 *                  `"last_status": "queued"`, PR em draft sem fixer (CLI exit 3);
 *   - `proceed`  → qualquer exit ≠ 7: contador zerado, seguir o fluxo normal
 *                  daquele exit (CLI exit 0).
 * Erro de leitura/escrita do plano → CLI exit 2 (nunca vira `reawait` mudo).
 */
import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "./atomic-write.ts";
import { isMainModule, parseArgs } from "./cli-args.ts";

/** Exit do `wait-pr-checks.sh` pra "ainda em fila de runner" (#10578). */
export const QUEUE_EXIT_CODE = 7;

/** Reaguardos consecutivos permitidos por PR antes de desistir (#10671). */
export const MAX_QUEUE_REAWAITS = 3;

export type ReawaitAction = "reawait" | "give-up" | "proceed";

export interface ReawaitDecision {
  pr: number;
  exit: number;
  queue_reawaits: number;
  action: ReawaitAction;
}

/** Mapa persistido em `plan.json`. Chave = número da PR em string. */
export type ReawaitCounters = Record<string, number>;

/**
 * Decisão pura: dado o contador atual e o exit do helper, devolve a ação e o
 * novo mapa (sem mutar o de entrada). Exit ≠ 7 zera (remove) a entrada da PR.
 */
export function decideQueueReawait(
  counters: ReawaitCounters,
  pr: number,
  exitCode: number,
  max: number = MAX_QUEUE_REAWAITS,
): { decision: ReawaitDecision; counters: ReawaitCounters } {
  const key = String(pr);
  const next: ReawaitCounters = { ...counters };
  if (exitCode !== QUEUE_EXIT_CODE) {
    delete next[key];
    return { decision: { pr, exit: exitCode, queue_reawaits: 0, action: "proceed" }, counters: next };
  }
  const current = Number.isInteger(counters[key]) && counters[key] > 0 ? counters[key] : 0;
  if (current >= max) {
    next[key] = current;
    return { decision: { pr, exit: exitCode, queue_reawaits: current, action: "give-up" }, counters: next };
  }
  next[key] = current + 1;
  return { decision: { pr, exit: exitCode, queue_reawaits: current + 1, action: "reawait" }, counters: next };
}

/** Lê o plano, aplica a decisão e grava de volta (atômico). Lança em erro de I/O ou JSON. */
export function applyQueueReawait(planPath: string, pr: number, exitCode: number): ReawaitDecision {
  if (!existsSync(planPath)) throw new Error(`plano não encontrado: ${planPath}`);
  const plan = JSON.parse(readFileSync(planPath, "utf8")) as Record<string, unknown>;
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) {
    throw new Error(`plano não é um objeto JSON: ${planPath}`);
  }
  const raw = plan.ci_queue_reawaits;
  const counters: ReawaitCounters =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as ReawaitCounters) : {};
  const { decision, counters: next } = decideQueueReawait(counters, pr, exitCode);
  plan.ci_queue_reawaits = next;
  writeFileAtomic(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  return decision;
}

function main(): void {
  const { values } = parseArgs(process.argv.slice(2));
  const pr = Number(values.pr);
  const exitCode = Number(values.exit);
  if (!values.plan || !Number.isInteger(pr) || pr <= 0 || values.exit === undefined || !Number.isInteger(exitCode)) {
    console.error("Uso: npx tsx scripts/lib/ci-queue-reawait.ts --plan <plan.json> --pr N --exit RC");
    process.exitCode = 2;
    return;
  }
  try {
    const decision = applyQueueReawait(values.plan, pr, exitCode);
    console.log(JSON.stringify(decision));
    if (decision.action === "give-up") process.exitCode = 3;
  } catch (e) {
    console.error(`[ci-queue-reawait] erro: ${(e as Error).message}`);
    process.exitCode = 2;
  }
}

if (isMainModule(import.meta.url)) main();
