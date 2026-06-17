#!/usr/bin/env npx tsx
/**
 * overnight-statusline.ts (#2184, #2250, #2255)
 *
 * Barra de progresso horizontal para a statusLine do Claude Code.
 * Suporta três modos, com precedência definida:
 *
 *   1. Edição em curso (PRIORIDADE ALTA — #2250):
 *      "{branch}  edição 260615  [██████░░░░░░] 3/7  Imagens"
 *      Encerrada: "{branch}  edição 260615  [████████████] 7/7  Agendamento"
 *
 *   2. Rodada /diaria-overnight (FALLBACK quando não há edição ativa):
 *      "{branch}  [████████░░░░] 67%  (4/6)"
 *      Encerrada: "{branch}  [████████████] 100%  (N/N)"  (barra em 100%, sempre visível)
 *
 *   3. IDLE — barra SEMPRE presente mesmo sem edição nem overnight (#2255):
 *      Com edição passada: "{branch}  [████████████] Diar.ia · 260617 · pronto"
 *      Sem edição alguma:  "{branch}  [████████████] Diar.ia · sem rodada ativa"
 *
 * Precedência: edição em curso > overnight > idle. A barra é SEMPRE presente —
 * nunca retorna string vazia para o statusLine.
 *
 * Critério de "rodada encerrada" overnight: TODAS as entradas de `issues` têm status
 * terminal (`mergeada` | `draft-ci-vermelho` | `pulada`). Quando encerrada,
 * mostra 100% e permanece visível — NÃO oculta (#2246, requisito do editor).
 *
 * Critério de "edição encerrada" (#2250): todos os stages têm status terminal
 * (`done` | `failed`). Quando encerrada, mostra N/N (7/7) e permanece visível
 * (espelhando #2246). A barra de overnight volta ao display quando a edição encerra.
 *
 * Degrada graciosamente:
 *   - stage-status.json ausente/malformado → ignora (fallback overnight)
 *   - rows ausente/vazio                   → ignora (fallback overnight)
 *   - plan.json ausente                    → idle bar (fora de rodada overnight)
 *   - plan.json malformado                 → idle bar (sem throw)
 *   - total de issues = 0                  → idle bar
 *   - qualquer read failure                → idle bar, nunca string vazia
 *
 * Uso (Claude Code statusLine):
 *   npx tsx scripts/overnight-statusline.ts
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import type { StageStatusDoc, StageStatus } from "./update-stage-status.ts";
import { STAGE_LABELS, STAGES, loadDoc } from "./update-stage-status.ts";

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
  /** Origem da issue no plano: initial, mid-round, finding-depth-1, finding-depth-2, etc. */
  source?: string;
  [key: string]: unknown;
}

export interface Plan {
  issues: PlanIssue[];
  /**
   * Nível atual da cadeia de re-entrada de findings.
   * 0 = fila principal, 1 = mini-rodada 1, 2 = mini-rodada 2.
   * Ausente em plan.json legado → tratar como 0.
   */
  findings_depth?: number;
  /**
   * Estado do review consolidado do nível atual.
   * null/ausente = review não iniciado/concluído neste nível.
   * "done (depth N)" = review concluído no nível N.
   * "skipped: <motivo> (depth N)" = review pulado no nível N.
   * Legado: "done" (sem depth) → tratar como concluído no nível corrente.
   */
  review?: string | null;
  [key: string]: unknown;
}

// ─── constantes ───────────────────────────────────────────────────────────────

// Qualquer status fora deste Set é considerado não-terminal por exclusão (open-world contract).
// Fix #2246 pt1: sufixo [a-z]? (zero ou UMA letra) para casar rodadas suplementares (260613b, 260613c, …).
// Single-letter suffix garante ordenação lexicográfica correta: 260613c > 260613b > 260613 > 260611.
// Dois sufixos (260613aa) mis-ordenariam lexicograficamente — não são gerados pelo pipeline.
export const OVERNIGHT_DIR_RE = /^\d{6}[a-z]?$/;
const TERMINAL_STATUSES = new Set<IssueStatus>(["mergeada", "draft-ci-vermelho", "pulada"]);
const BAR_WIDTH = 12;

/** Regex for edition AAMMDD directories (exactly 6 digits, no suffixes). */
const EDITION_DIR_RE = /^\d{6}$/;

/** Stage statuses considered terminal for edition progress (#2250). */
const STAGE_TERMINAL_STATUSES = new Set<StageStatus>(["done", "failed"]);

/** Total number of stages (0–6) in an edition — derived from STAGES to stay in sync. */
const TOTAL_STAGES = STAGES.length;

/**
 * IDLE bar default label — shown when there is NO active edition AND no overnight round.
 * (#2255) This is the "rescued product decision" — the editor confirmed the bar should
 * ALWAYS be present but did not specify idle content. The default below is pending
 * editor confirmation (flagged in PR body).
 *
 * To customize idle appearance: change IDLE_BAR_NO_EDITION_LABEL or renderIdleBar().
 * The bar is always full (12 × █) in idle mode — signals "nada em andamento, sistema OK".
 */
const IDLE_BAR_NO_EDITION_LABEL = "Diar.ia · sem rodada ativa";
/** Prefix for idle bar when a past edition exists: "Diar.ia · {AAMMDD} · pronto". */
const IDLE_BAR_EDITION_PREFIX = "Diar.ia";
const IDLE_BAR_EDITION_SUFFIX = "pronto";

// ─── função pura testável ─────────────────────────────────────────────────────

/**
 * Retorna o rótulo do ciclo/fase atual da rodada overnight.
 *
 * Determinístico (sem Date.now()) — derivado exclusivamente de `plan.json`.
 *
 * Lógica:
 *   1. Lê `findings_depth` (default 0 se ausente — legado).
 *   2. Filtra as issues "relevantes para o depth atual":
 *        - depth 0 → issues sem source "finding-depth-*" (initial, mid-round, ausente)
 *        - depth N → issues com source "finding-depth-N"
 *   3. Se TODAS as issues relevantes estão em status terminal E o review no depth
 *      atual ainda não foi concluído → estamos em review consolidado:
 *        depth 0 → "review 1.5", depth 1 → "review 1.5b", depth 2 → "review 1.5c"
 *   4. Caso contrário → fila ou mini-rodada:
 *        depth 0 → "fila principal", depth N ≥ 1 → "mini-rodada N"
 *
 * "Review concluído no depth N" = `plan.review` contém `"done (depth N)"`,
 * `"skipped: ... (depth N)"`, ou (legado) `"done"` (sem depth — tratado como
 * concluído no nível corrente).
 *
 * Robustez:
 *   - plan null/undefined → "fila principal" (nunca throw)
 *   - findings_depth ausente → tratar como 0 ("fila principal")
 *   - issues vazia → "fila principal" (sem issues relevantes a verificar)
 *   - issues sem campo source → contam no grupo "depth 0" (initial sem source)
 *
 * @param plan  Objeto do plan.json (ou null/undefined se ausente/malformado)
 * @returns     Rótulo do ciclo atual ("fila principal" | "mini-rodada N" | "review 1.5x")
 */
export function cycleLabel(plan: Plan | null | undefined): string {
  // Legado / ausente → fila principal
  if (!plan) return "fila principal";

  const depth = typeof plan.findings_depth === "number" ? plan.findings_depth : 0;
  const issues = Array.isArray(plan.issues) ? plan.issues : [];

  // Filtra issues relevantes para o depth atual.
  // depth 0: issues sem source "finding-depth-*" (initial, mid-round, ou sem campo source)
  // depth N: issues com source "finding-depth-N"
  const relevantIssues =
    depth === 0
      ? issues.filter((i) => {
          const src = typeof i?.source === "string" ? i.source : "";
          return !src.startsWith("finding-depth-");
        })
      : issues.filter((i) => {
          const src = typeof i?.source === "string" ? i.source : "";
          return src === `finding-depth-${depth}`;
        });

  // Verifica se o review do depth atual já foi concluído.
  // "done (depth N)" | "skipped: ... (depth N)" | legacy "done" (sem depth).
  const reviewValue = plan.review ?? null;
  const reviewDone =
    (depth === 0 && reviewValue === "done") // legado: somente depth 0
    || (typeof reviewValue === "string" && (
      reviewValue === `done (depth ${depth})`
      || reviewValue.startsWith(`skipped:`) && reviewValue.endsWith(`(depth ${depth})`)
    ));

  // Verifica se TODAS as issues relevantes estão em status terminal.
  // issues vazia → allTerminal = false (bucket não-esgotado → permanece na fase ativa)
  const allTerminal =
    relevantIssues.length > 0
    && relevantIssues.every((i) =>
        TERMINAL_STATUSES.has(String(i?.status ?? "") as IssueStatus)
      );

  // Se fila do depth esgotada E review ainda não concluído → estamos no review consolidado.
  if (allTerminal && !reviewDone) {
    if (depth === 0) return "review 1.5";
    if (depth === 1) return "review 1.5b";
    if (depth === 2) return "review 1.5c";
    // depth > 2 não documentado, mas retorna graciosamente
    return `review 1.5${"bcdefghijklmnopqrstuvwxyz"[depth - 1] ?? "?"}`;
  }

  // Fila ativa (não esgotada ou review já concluído).
  if (depth === 0) return "fila principal";
  return `mini-rodada ${depth}`;
}

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

  // Rótulo do ciclo/fase atual (#2298) — determinístico, sem relógio.
  const label = cycleLabel(plan);

  // Rodada encerrada: todas terminais → barra cheia 100% visível (#2246 pt3)
  if (done >= total) {
    const bar = "█".repeat(BAR_WIDTH);
    return `[${bar}] 100%  (${done}/${total})  · ${label}`;
  }

  // Fix #3: use Math.floor instead of Math.round to avoid showing 100% when not all done
  const pct = Math.floor((done / total) * 100);
  const filled = Math.floor((done / total) * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;

  const bar = "█".repeat(filled) + "░".repeat(empty);
  return `[${bar}] ${pct}%  (${done}/${total})  · ${label}`;
}

// ─── helpers internos ─────────────────────────────────────────────────────────

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
export function readTodayPlan(cwd: string): Plan | null {
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

// ─── edição em curso (#2250) ──────────────────────────────────────────────────

/**
 * Renderiza a barra de progresso de uma edição em curso (#2250).
 *
 * @param doc  Documento stage-status.json (ou null/undefined se ausente/malformado)
 * @returns    String da barra, ou "" quando deve ser ocultada.
 *
 * Retorna "" quando:
 *   - doc é null/undefined
 *   - doc.rows é ausente ou não-array
 *   - rows.length === 0
 *
 * Quando todos os stages são terminais (done/failed), mostra N/N e permanece
 * visível (espelhando #2246: barra encerrada é visível, não oculta).
 *
 * Formato: "edição AAMMDD  [██████░░░░░░] 3/7  Imagens"
 * Encerrada: "edição AAMMDD  [████████████] 7/7  Agendamento"
 */
export function renderEditionBar(doc: StageStatusDoc | null | undefined): string {
  if (!doc) return "";
  if (!Array.isArray(doc.rows)) return "";
  if (doc.rows.length === 0) return "";

  const rows = doc.rows;
  const total = TOTAL_STAGES; // always STAGES.length (stages 0–6)
  const done = rows.filter((r) => STAGE_TERMINAL_STATUSES.has(r?.status as StageStatus)).length;

  const editionId = doc.edition ?? "?";

  // All stages terminal → show N/N (encerrada, visível — mirrors #2246)
  // Guard placed early so label logic below only runs for in-progress editions.
  if (done >= total) {
    const bar = "█".repeat(BAR_WIDTH);
    // Pick the label by highest stage number (not array position) to handle out-of-order rows.
    const lastStageRow = rows.reduce(
      (max, r) => (r.stage > (max?.stage ?? -1) ? r : max),
      rows[0],
    );
    const lastLabel = STAGE_LABELS[lastStageRow?.stage ?? (TOTAL_STAGES - 1)] ?? "Agendamento";
    return `edição ${editionId}  [${bar}] ${total}/${total}  ${lastLabel}`;
  }

  // Find the current running stage for label display (in-progress path only).
  // Priority: first "running" stage; fallback: last "done/failed" stage (by scan); fallback: stage 0 label.
  const runningRow = rows.find((r) => r?.status === "running");
  // Scan from end without allocating a copy (findLast polyfill — tsconfig targets ES2022).
  let lastDoneRow: typeof rows[0] | undefined;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (STAGE_TERMINAL_STATUSES.has(rows[i].status)) { lastDoneRow = rows[i]; break; }
  }
  const displayRow = runningRow ?? lastDoneRow ?? rows[0];
  const stageLabel = STAGE_LABELS[displayRow?.stage ?? 0] ?? `Stage ${displayRow?.stage ?? 0}`;

  const filled = Math.floor((done / total) * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);

  return `edição ${editionId}  [${bar}] ${done}/${total}  ${stageLabel}`;
}

/**
 * Lê e parseia stage-status.json de um diretório de edição.
 * Falls back to the legacy stage-status.md via loadDoc() for pre-#1216 editions.
 * Retorna null em qualquer erro ou se o formato for inválido.
 */
function readStageStatusFromDir(editionDir: string): StageStatusDoc | null {
  try {
    const jsonPath = join(editionDir, "_internal", "stage-status.json");
    const editionId = editionDir.split(/[/\\]/).pop() ?? "";

    // Fast path: JSON sidecar exists — parse directly.
    if (existsSync(jsonPath)) {
      try {
        const parsed = JSON.parse(readFileSync(jsonPath, "utf8")) as StageStatusDoc;
        // Finding #9: use typeof instead of falsy check so edition:'' is not rejected.
        if (typeof parsed.edition !== "string" || !Array.isArray(parsed.rows)) return null;
        return parsed;
      } catch {
        // corrupted JSON — fall through to loadDoc MD fallback
      }
    }

    // Finding #4: MD fallback for pre-#1216 editions (no stage-status.json).
    // loadDoc never throws and returns makeInitialDoc if neither JSON nor MD exist.
    const legacyMdPath = join(editionDir, "stage-status.md");
    if (!existsSync(legacyMdPath)) return null; // neither JSON nor MD — truly absent
    const doc = loadDoc(editionDir, editionId);
    // loadDoc returns makeInitialDoc (all-pending) when MD is unreadable — treat as null.
    if (typeof doc.edition !== "string" || !Array.isArray(doc.rows) || doc.rows.length === 0) {
      return null;
    }
    return doc;
  } catch {
    return null;
  }
}

/**
 * Detecta a edição EM CURSO mais recente escaneando data/editions/{AAMMDD}/_internal/stage-status.json.
 *
 * Contrato determinístico (espelha readTodayPlan):
 *   - Sort lexicográfico desc (mais recente primeiro — AAMMDD: 260615 > 260614)
 *   - "Em curso" = tem ao menos 1 stage `running` ou `done/failed` mas NÃO todos terminais.
 *     Uma edição onde todos stages são `done/failed` é ENCERRADA e retorna null — isso
 *     faz a overnight bar retomar o display (contrato docblock ln 27: "A barra de overnight
 *     volta ao display quando a edição encerra"). (Fix Finding #1.)
 *   - Edição all-pending (--init mas não rodando) também é ignorada — não é "em curso".
 *   - Retorna null se não houver edição alguma em curso.
 *
 * Nenhuma dependência de Date.now() / relógio — 100% determinístico.
 *
 * @param cwd  Raiz do projeto (cwd)
 * @returns    StageStatusDoc da edição mais recente EM CURSO (não encerrada, não all-pending), ou null.
 */
export function readCurrentEditionDoc(cwd: string): StageStatusDoc | null {
  try {
    const editionsDir = join(cwd, "data", "editions");
    if (!existsSync(editionsDir)) return null;

    const entries = readdirSync(editionsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && EDITION_DIR_RE.test(e.name))
      .map((e) => e.name)
      .sort()
      .reverse(); // most recent first (lexicographic desc: 260615 > 260614 > ...)

    if (entries.length === 0) return null;

    for (const dirName of entries) {
      const editionDir = join(editionsDir, dirName);
      const doc = readStageStatusFromDir(editionDir);
      if (!doc) continue;
      if (!Array.isArray(doc.rows) || doc.rows.length === 0) continue;
      // Skip all-pending editions (--init'd but not yet running).
      const hasStarted = doc.rows.some((r) => r.status !== "pending");
      if (!hasStarted) continue;
      // Finding #1: skip fully-encerrada editions — overnight bar must resume when edition ends.
      const isEncerrada = doc.rows.every((r) => STAGE_TERMINAL_STATUSES.has(r.status));
      if (isEncerrada) continue;
      // First in-progress edition → return it.
      return doc;
    }

    return null;
  } catch {
    return null;
  }
}

// ─── idle bar (#2255) ────────────────────────────────────────────────────────

/**
 * Renderiza a barra IDLE — mostrada quando não há edição ativa nem rodada overnight.
 * (#2255) Barra SEMPRE visível: nunca retorna string vazia.
 *
 * @param mostRecentEditionId  AAMMDD da edição mais recente no disco, ou null se nenhuma existe.
 * @returns  String da barra idle (nunca vazia).
 *
 * Formato com edição passada:  "[████████████] Diar.ia · 260617 · pronto"
 * Formato sem edição alguma:   "[████████████] Diar.ia · sem rodada ativa"
 *
 * A barra é sempre 100% cheia em modo idle — sinaliza "sistema OK, nada em andamento".
 * O label é um único bloco claramente comentado (constantes IDLE_BAR_*) — trivialmente
 * alterável pelo editor sem tocar na lógica.
 */
export function renderIdleBar(mostRecentEditionId: string | null): string {
  const fullBar = "█".repeat(BAR_WIDTH);
  const label = mostRecentEditionId
    ? `${IDLE_BAR_EDITION_PREFIX} · ${mostRecentEditionId} · ${IDLE_BAR_EDITION_SUFFIX}`
    : IDLE_BAR_NO_EDITION_LABEL;
  return `[${fullBar}] ${label}`;
}

/**
 * Encontra o AAMMDD da edição mais recente em data/editions/, independentemente de
 * estar em curso ou encerrada. Usado exclusivamente para o rótulo idle.
 *
 * Retorna null se o dir data/editions/ não existe ou não contém dirs AAMMDD válidos.
 * Nunca lança exceção.
 */
export function findMostRecentEditionId(cwd: string): string | null {
  try {
    const editionsDir = join(cwd, "data", "editions");
    if (!existsSync(editionsDir)) return null;

    const entries = readdirSync(editionsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && EDITION_DIR_RE.test(e.name))
      .map((e) => e.name)
      .sort()
      .reverse(); // most recent first (lexicographic desc)

    return entries[0] ?? null;
  } catch {
    return null;
  }
}

// ─── CLI (entrypoint) ─────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cwd = process.cwd();
  const branch = currentBranch(cwd);

  // Precedência (#2255): edição em curso > overnight > idle.
  // Barra SEMPRE presente — nunca retorna string vazia para o statusLine.

  // Source 1: Edition in progress (#2250).
  // readCurrentEditionDoc returns non-null only for IN-PROGRESS editions (started but not encerrada).
  // When edition is fully encerrada (all terminal), readCurrentEditionDoc returns null → overnight resumes.
  const editionDoc = readCurrentEditionDoc(cwd);
  const editionBar = renderEditionBar(editionDoc);

  // Source 2: Active/finished overnight round (only checked when no active edition bar).
  const overnightBar = editionBar ? "" : renderOvernightBar(readTodayPlan(cwd));

  // Source 3: Idle — always present (#2255). Shows most recent edition date if one exists.
  // renderIdleBar always returns a non-empty string — it is the guaranteed fallback.
  const bar = editionBar || overnightBar || renderIdleBar(findMostRecentEditionId(cwd));

  // Fix #4: only include separator when branch is non-empty
  const output = branch ? `${branch}  ${bar}` : bar;
  process.stdout.write(output + "\n");
}
