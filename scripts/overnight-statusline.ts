#!/usr/bin/env npx tsx
/**
 * overnight-statusline.ts (#2184)
 *
 * Barra de progresso horizontal da rodada /diaria-overnight para a
 * statusLine do Claude Code.
 *
 * Saída:
 *   Fora de rodada:   "{branch}"
 *   Durante rodada:   "{branch}  [████████░░░░] 67%  (4/6)"
 *   Rodada encerrada: "{branch}"  (barra escondida — silent)
 *
 * Critério de "rodada encerrada": TODAS as entradas de `issues` têm status
 * terminal (`mergeada` | `draft-ci-vermelho` | `pulada`). Quando 0 issues
 * elegíveis restam, a barra desaparece para não poluir uma session já concluída.
 *
 * Degrada graciosamente:
 *   - plan.json ausente   → string vazia (fora de rodada)
 *   - plan.json malformado → string vazia (sem throw)
 *   - rodada encerrada    → string vazia (100% = barra ocultada)
 *   - total de issues = 0 → string vazia
 *
 * Uso (Claude Code statusLine):
 *   npx tsx scripts/overnight-statusline.ts
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// ─── tipos ────────────────────────────────────────────────────────────────────

export interface PlanIssue {
  status: string;
  [key: string]: unknown;
}

export interface Plan {
  issues: PlanIssue[];
  [key: string]: unknown;
}

// ─── constantes ───────────────────────────────────────────────────────────────

const TERMINAL_STATUSES = new Set(["mergeada", "draft-ci-vermelho", "pulada"]);
const BAR_WIDTH = 12;

// ─── função pura testável ─────────────────────────────────────────────────────

/**
 * Renderiza a barra de progresso da rodada /diaria-overnight.
 *
 * @param plan  Objeto do plan.json (ou null/undefined se ausente/malformado)
 * @returns     String da barra, ou "" quando barra deve ser ocultada.
 *
 * Retorna "" quando:
 *   - plan é null/undefined
 *   - plan.issues é ausente ou não-array
 *   - issues.length === 0
 *   - todas as issues têm status terminal (rodada encerrada)
 */
export function renderOvernightBar(plan: Plan | null | undefined): string {
  // Degrada graciosamente: plan ausente ou malformado
  if (!plan) return "";
  if (!Array.isArray(plan.issues)) return "";
  const issues = plan.issues;
  if (issues.length === 0) return "";

  const total = issues.length;
  const done = issues.filter((i) => TERMINAL_STATUSES.has(String(i?.status ?? ""))).length;

  // Rodada encerrada: todas terminais → barra oculta
  if (done >= total) return "";

  const pct = Math.round((done / total) * 100);
  const filled = Math.round((done / total) * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;

  const bar = "█".repeat(filled) + "░".repeat(empty);
  return `[${bar}] ${pct}%  (${done}/${total})`;
}

// ─── helpers internos ─────────────────────────────────────────────────────────

/** Retorna o AAMMDD de hoje em horário local (data da rodada, que pode cruzar meia-noite). */
function todayAAMMDD(): string {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

/** Lê e parseia o plan.json de hoje. Retorna null em qualquer erro. */
function readTodayPlan(cwd: string): Plan | null {
  try {
    const aammdd = todayAAMMDD();
    const planPath = join(cwd, "data", "overnight", aammdd, "plan.json");
    if (!existsSync(planPath)) return null;
    const raw = readFileSync(planPath, "utf8");
    return JSON.parse(raw) as Plan;
  } catch {
    return null;
  }
}

/** Retorna o branch git atual (ex: "master"), ou "" em caso de erro. */
function currentBranch(cwd: string): string {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

// ─── CLI (entrypoint) ─────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cwd = process.cwd();
  const branch = currentBranch(cwd);
  const plan = readTodayPlan(cwd);
  const bar = renderOvernightBar(plan);

  // Default minimal: branch sempre presente; barra aparece só durante rodada.
  // Fora de rodada (ou encerrada): só o branch — nunca string vazia total.
  const prefix = branch || "";
  const output = bar ? `${prefix}  ${bar}` : prefix;
  process.stdout.write(output + "\n");
}
