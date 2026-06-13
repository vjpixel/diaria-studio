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

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// ─── tipos ────────────────────────────────────────────────────────────────────

/**
 * Todos os valores válidos de `status` em plan.json.
 * Fonte canônica: `.claude/skills/diaria-overnight/SKILL.md` (tabela de status possíveis).
 * Não-terminais: elegivel, precisa-resposta, bloqueada-externa, not-this-week, fora-do-escopo.
 * Terminais: mergeada, draft-ci-vermelho, pulada.
 */
export type IssueStatus =
  | "elegivel"
  | "precisa-resposta"
  | "bloqueada-externa"
  | "not-this-week"
  | "fora-do-escopo"
  | "mergeada"
  | "draft-ci-vermelho"
  | "pulada";

export interface PlanIssue {
  status: IssueStatus;
  [key: string]: unknown;
}

export interface Plan {
  issues: PlanIssue[];
  [key: string]: unknown;
}

// ─── constantes ───────────────────────────────────────────────────────────────

// Qualquer status fora deste Set é considerado não-terminal por exclusão (open-world contract).
export const OVERNIGHT_DIR_RE = /^\d{6}$/;
const TERMINAL_STATUSES = new Set<IssueStatus>(["mergeada", "draft-ci-vermelho", "pulada"]);
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
  const done = issues.filter((i) => TERMINAL_STATUSES.has(String(i?.status ?? "") as IssueStatus)).length;

  // Rodada encerrada: todas terminais → barra oculta
  if (done >= total) return "";

  // Fix #3: use Math.floor instead of Math.round to avoid showing 100% when not all done
  const pct = Math.floor((done / total) * 100);
  const filled = Math.floor((done / total) * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;

  const bar = "█".repeat(filled) + "░".repeat(empty);
  return `[${bar}] ${pct}%  (${done}/${total})`;
}

// ─── helpers internos ─────────────────────────────────────────────────────────

/**
 * Verifica se um plan tem pelo menos uma issue com status não-terminal.
 * Contrato open-world: qualquer status que NÃO esteja em TERMINAL_STATUSES
 * é considerado não-terminal — a lista de terminais é fechada (mergeada,
 * draft-ci-vermelho, pulada), todos os demais são não-terminais por exclusão.
 */
function hasNonTerminalIssue(plan: Plan): boolean {
  if (!Array.isArray(plan.issues)) return false;
  return plan.issues.some((i) => !TERMINAL_STATUSES.has(String(i?.status ?? "") as IssueStatus));
}

/**
 * Lê e parseia o plan.json de um diretório de rodada. Retorna null em qualquer erro.
 */
function readPlanFromDir(planPath: string): Plan | null {
  try {
    if (!existsSync(planPath)) return null;
    const raw = readFileSync(planPath, "utf8");
    return JSON.parse(raw) as Plan;
  } catch {
    return null;
  }
}

/**
 * Encontra a rodada ativa escaneando data/overnight/{AAMMDD}/plan.json.
 * A rodada ativa é a que tem ao menos uma issue com status não-terminal.
 * - Se múltiplas tiverem unidades não-terminais → retorna a mais recente por nome do dir.
 * - Se nenhuma tiver unidades não-terminais → retorna a mais recente por nome do dir (ou null).
 * Isso é determinístico e não depende do relógio — corrige o bug do live clock (#2184/Finding 1).
 */
function readTodayPlan(cwd: string): Plan | null {
  try {
    const overnightDir = join(cwd, "data", "overnight");
    if (!existsSync(overnightDir)) return null;

    const entries = readdirSync(overnightDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && OVERNIGHT_DIR_RE.test(e.name))
      .map((e) => e.name)
      .sort()
      .reverse(); // most recent first

    if (entries.length === 0) return null;

    // Single-pass scan: track (a) first active run (non-terminal issue) and
    // (b) most-recent parseable plan as fallback — each plan.json is read ONCE.
    let activePlan: Plan | null = null;
    let fallbackPlan: Plan | null = null;

    for (const dirName of entries) {
      const planPath = join(overnightDir, dirName, "plan.json");
      const plan = readPlanFromDir(planPath);
      if (!plan) continue;

      // Track most-recent parseable plan as fallback (entries sorted desc)
      if (fallbackPlan === null) fallbackPlan = plan;

      // Track first active run (has at least one non-terminal issue)
      if (activePlan === null && Array.isArray(plan.issues) && plan.issues.length > 0 && hasNonTerminalIssue(plan)) {
        activePlan = plan;
      }

      // Early exit: already found both — no need to continue
      if (activePlan !== null && fallbackPlan !== null) break;
    }

    return activePlan ?? fallbackPlan;
  } catch {
    return null;
  }
}

/**
 * Retorna o branch git atual (ex: "master"), ou "" em caso de erro ou detached HEAD.
 *
 * Edge cases:
 *   - detached HEAD → git rev-parse retorna "HEAD" → normalizado para "".
 *   - repo sem commits (zero-commit) → git rev-parse exits 128 → catch retorna "".
 *     (Comportamento intencional: statusline sem prefixo de branch, sem crash.)
 *   - sem repo git / erro de timeout → catch retorna "".
 */
function currentBranch(cwd: string): string {
  try {
    // git rev-parse retorna "HEAD" em detached HEAD, nome do branch em caso normal.
    // Em repo sem commits, exits 128 → catch retorna "" (ver JSDoc acima).
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
    // "HEAD" → detached; "" → sem git; ambos → sem prefixo na barra.
    if (branch === "HEAD" || branch === "") return "";
    return branch;
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

  // Fix #4: only include separator when branch is non-empty
  const output = bar
    ? branch
      ? `${branch}  ${bar}`
      : bar
    : branch;
  process.stdout.write(output + "\n");
}
