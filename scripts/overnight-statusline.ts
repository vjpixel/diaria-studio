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
 *   Rodada encerrada: "{branch}  [████████████] 100%  (N/N)"  (barra em 100%, sempre visível)
 *
 * Critério de "rodada encerrada": TODAS as entradas de `issues` têm status
 * terminal (`mergeada` | `draft-ci-vermelho` | `pulada`). Quando encerrada,
 * mostra 100% e permanece visível — NÃO oculta (#2246, requisito do editor).
 *
 * Degrada graciosamente:
 *   - plan.json ausente    → string vazia (fora de rodada)
 *   - plan.json malformado → string vazia (sem throw)
 *   - total de issues = 0  → string vazia
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
// Fix #2246 pt1: sufixo [a-z]* para casar rodadas suplementares (260613b, 260613c, …).
// Ordenação lexicográfica garante 260613c > 260613b > 260613 > 260611 (sort desc = mais recente primeiro).
export const OVERNIGHT_DIR_RE = /^\d{6}[a-z]*$/;
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
 *
 * Fix #2246 pt3: quando done >= total (rodada encerrada), mostra 100% e permanece
 * visível — NÃO retorna "" (requisito do editor: barra fica em 100% ao encerrar).
 */
export function renderOvernightBar(plan: Plan | null | undefined): string {
  // Degrada graciosamente: plan ausente ou malformado
  if (!plan) return "";
  if (!Array.isArray(plan.issues)) return "";
  const issues = plan.issues;
  if (issues.length === 0) return "";

  const total = issues.length;
  const done = issues.filter((i) => TERMINAL_STATUSES.has(String(i?.status ?? "") as IssueStatus)).length;

  // Rodada encerrada: todas terminais → barra cheia 100% visível (#2246 pt3)
  if (done >= total) {
    const bar = "█".repeat(BAR_WIDTH);
    return `[${bar}] 100%  (${done}/${total})`;
  }

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
 * Encontra a rodada corrente escaneando data/overnight/{AAMMDD[a-z]*}/plan.json.
 *
 * Fix #2246 pt2: retorna o plan do dir MAIS RECENTE que casa OVERNIGHT_DIR_RE e
 * tem issues.length > 0 — independentemente de a rodada estar em progresso ou
 * encerrada. O conceito anterior de "primeiro com não-terminal" causava o bug:
 * um plan antigo (260611) com status legado não-terminal sequestrava o bar
 * durante/após rodadas suplementares (260613b, 260613c) que a regex não casava.
 *
 * Novo contrato:
 *   - Mais-recente por nome de dir (sort lexicográfico desc, cobre sufixos a–z)
 *   - Deve ter issues.length > 0 (plan vazio é ignorado — não é rodada real)
 *   - Não importa se a rodada está em progresso ou encerrada; renderOvernightBar
 *     decide como exibir (100% quando encerrada, % parcial quando em progresso)
 *
 * Isso é determinístico e não depende do relógio — corrige #2184/Finding 1 e
 * o bug de sequestro por plan antigo (#2246).
 */
function readTodayPlan(cwd: string): Plan | null {
  try {
    const overnightDir = join(cwd, "data", "overnight");
    if (!existsSync(overnightDir)) return null;

    const entries = readdirSync(overnightDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && OVERNIGHT_DIR_RE.test(e.name))
      .map((e) => e.name)
      .sort()
      .reverse(); // most recent first (lexicographic: 260613c > 260613b > 260613 > 260611)

    if (entries.length === 0) return null;

    // Fix #2246 pt2: return the most-recent dir with a parseable plan that has issues.
    // Do NOT skip to older dirs just because the most-recent run is already terminal.
    for (const dirName of entries) {
      const planPath = join(overnightDir, dirName, "plan.json");
      const plan = readPlanFromDir(planPath);
      if (!plan) continue;
      if (!Array.isArray(plan.issues) || plan.issues.length === 0) continue;
      // First entry that passes → this is the current/latest run
      return plan;
    }

    return null;
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
