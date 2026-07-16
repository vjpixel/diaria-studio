/**
 * studio-state.ts (#3555)
 *
 * Camada de leitura PURA (sem I/O de rede) que monta o snapshot de estado
 * consumido por `GET /api/state`. Reusa os helpers canônicos já existentes
 * na pipeline em vez de duplicar lógica — ambos de
 * `scripts/lib/find-current-edition.ts`:
 *   - `enumerateEditionDirs` — enumera edições no disco nos 2 layouts
 *     possíveis (flat/nested, #2463).
 *   - `findEditionsInProgress` — mesma detecção de "gate pendente" usada
 *     pelas skills `/diaria-4-revisao` e `/diaria-6-agendamento` quando o
 *     editor omite AAMMDD (#583): stage 4/6 com prereqs prontos e output do
 *     stage ainda ausente = gate pendente.
 *   - `scripts/update-stage-status.ts` (`loadDoc`, `STAGE_LABELS`) — doc
 *     canônico de timing/custo por stage que a própria pipeline já mantém
 *     incrementalmente (`_internal/stage-status.json`) — fonte mais rica que
 *     reimplementar sentinel-scanning manual sobre `pipeline-state.ts`.
 *
 * Mantido 100% read-only por design (#3555 é a fatia fundação/read-only da
 * EPIC #3554) — nenhuma função aqui escreve em disco.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, relative } from "node:path";
import { enumerateEditionDirs, findEditionsInProgress } from "../lib/find-current-edition.ts";
import { loadDoc, STAGE_LABELS, type StageStatusDoc } from "../update-stage-status.ts";

export type CurrentStage = number | "done" | "unknown";

export interface StudioEditionSummary {
  edition: string;
  editionDir: string; // relativo a rootDir, com "/" mesmo no Windows
  currentStage: CurrentStage;
  stageLabel: string;
  gatesPending: number[]; // subconjunto de [4, 6]
  hasStageStatus: boolean;
}

export interface PlanSummary {
  sessionId: string; // AAMMDD do diretório
  path: string; // relativo a rootDir
  startedAt: string | null;
  totalIssues: number;
  counts: Record<string, number>; // status -> contagem
}

export interface StudioState {
  generatedAt: string;
  rootDir: string;
  currentEdition: string | null;
  editions: StudioEditionSummary[];
  gatesPending: Array<{ edition: string; stage: number }>;
  overnight: PlanSummary | null;
  develop: PlanSummary | null;
}

const AAMMDD_RE = /^\d{6}$/;

/** Determina o estágio-corrente de uma edição a partir do StageStatusDoc:
 * primeiro stage 1-6 que não está `done`. Se todos estão `done`, "done".
 */
export function currentStageFromDoc(doc: StageStatusDoc): CurrentStage {
  const relevant = doc.rows.filter((r) => r.stage >= 1 && r.stage <= 6);
  if (relevant.length === 0) return "unknown";
  const pending = relevant
    .slice()
    .sort((a, b) => a.stage - b.stage)
    .find((r) => r.status !== "done");
  return pending ? pending.stage : "done";
}

function toRelative(rootDir: string, absPath: string): string {
  return relative(rootDir, absPath).split("\\").join("/");
}

/** Rótulo humano de um `CurrentStage` — compartilhado por `studio-state.ts`
 * e `studio-edition-detail.ts` pra não duplicar o mapeamento. */
export function stageLabelFor(stage: CurrentStage): string {
  if (stage === "done") return "Concluída";
  if (stage === "unknown") return "Desconhecido";
  return STAGE_LABELS[stage] ?? "Desconhecido";
}

/**
 * Enumera as edições no disco (mais recente primeiro), cada uma com seu
 * estágio corrente resolvido via `stage-status.json` quando presente.
 * `limit` (default 15) evita payload gigante em instalações com meses de
 * histórico — cobre confortavelmente o que a UI da timeline precisa mostrar.
 */
export function listEditionSummaries(
  rootDir: string,
  opts: { limit?: number; gate4?: string[]; gate6?: string[] } = {},
): StudioEditionSummary[] {
  const limit = opts.limit ?? 15;
  const editionsRoot = resolve(rootDir, "data", "editions");
  const dirs = enumerateEditionDirs(editionsRoot);
  const gate4 = new Set(opts.gate4 ?? findEditionsInProgress(4, rootDir));
  const gate6 = new Set(opts.gate6 ?? findEditionsInProgress(6, rootDir));

  const sorted = [...dirs.keys()].sort().reverse().slice(0, limit);

  return sorted.map((aammdd) => {
    const editionDirAbs = dirs.get(aammdd)!;
    const jsonPath = resolve(editionDirAbs, "_internal", "stage-status.json");
    const mdPath = resolve(editionDirAbs, "stage-status.md");
    const hasStageStatus = existsSync(jsonPath) || existsSync(mdPath);

    let currentStage: CurrentStage = "unknown";
    let stageLabel = "Desconhecido";
    if (hasStageStatus) {
      const doc = loadDoc(editionDirAbs, aammdd);
      currentStage = currentStageFromDoc(doc);
      stageLabel = stageLabelFor(currentStage);
    }

    const gatesPending: number[] = [];
    if (gate4.has(aammdd)) gatesPending.push(4);
    if (gate6.has(aammdd)) gatesPending.push(6);

    return {
      edition: aammdd,
      editionDir: toRelative(rootDir, editionDirAbs),
      currentStage,
      stageLabel,
      gatesPending,
      hasStageStatus,
    };
  });
}

/**
 * Escolhe a "edição corrente" a partir da lista de sumários: prioridade pra
 * qualquer edição com gate pendente (sinal mais forte de "precisa de
 * atenção agora"); senão a mais recente que ainda não está `done`; senão a
 * mais recente de todas (histórico, sem trabalho pendente); senão `null`.
 */
export function pickCurrentEdition(editions: StudioEditionSummary[]): string | null {
  if (editions.length === 0) return null;
  const withGate = editions.find((e) => e.gatesPending.length > 0);
  if (withGate) return withGate.edition;
  const inProgress = editions.find((e) => e.currentStage !== "done");
  if (inProgress) return inProgress.edition;
  return editions[0].edition;
}

/**
 * Acha o `plan.json` mais recente sob `data/{overnight|develop}/{AAMMDD}/plan.json`
 * — diretórios nomeados por data-rótulo da sessão (não necessariamente a data
 * de edição — ver CLAUDE.md `/diaria-develop`). Retorna null se não houver
 * nenhum.
 */
export function findLatestPlanPath(rootDir: string, kind: "overnight" | "develop"): string | null {
  const base = resolve(rootDir, "data", kind);
  if (!existsSync(base)) return null;
  let entries: string[];
  try {
    entries = readdirSync(base);
  } catch {
    return null;
  }
  const sessionDirs = entries
    .filter((e) => AAMMDD_RE.test(e))
    .filter((e) => {
      try {
        return statSync(resolve(base, e)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort()
    .reverse();
  for (const dir of sessionDirs) {
    const planPath = resolve(base, dir, "plan.json");
    if (existsSync(planPath)) return planPath;
  }
  return null;
}

/** Resume um `plan.json` (formato overnight/develop) em contagens por status.
 * Fail-soft: JSON corrompido/shape inesperado retorna null em vez de lançar
 * — este é um endpoint de leitura best-effort, nunca deve derrubar `/api/state`.
 */
export function summarizePlan(rootDir: string, planPathAbs: string): PlanSummary | null {
  try {
    const raw = JSON.parse(readFileSync(planPathAbs, "utf8")) as {
      started_at?: string;
      issues?: Array<{ status?: string }>;
    };
    const issues = Array.isArray(raw.issues) ? raw.issues : [];
    const counts: Record<string, number> = {};
    for (const issue of issues) {
      const status = typeof issue.status === "string" ? issue.status : "unknown";
      counts[status] = (counts[status] ?? 0) + 1;
    }
    // sessionId = nome do diretório pai de plan.json (AAMMDD da sessão).
    const sessionId = relative(rootDir, planPathAbs).split(/[\\/]/).slice(-2, -1)[0] ?? "unknown";
    return {
      sessionId,
      path: toRelative(rootDir, planPathAbs),
      startedAt: typeof raw.started_at === "string" ? raw.started_at : null,
      totalIssues: issues.length,
      counts,
    };
  } catch {
    return null;
  }
}

/** Monta o snapshot completo servido por `GET /api/state`. */
export function buildStudioState(
  rootDir: string,
  opts: { limit?: number; now?: () => Date } = {},
): StudioState {
  const now = opts.now ?? (() => new Date());
  const editions = listEditionSummaries(rootDir, { limit: opts.limit });
  const gatesPending = editions.flatMap((e) =>
    e.gatesPending.map((stage) => ({ edition: e.edition, stage })),
  );

  const overnightPath = findLatestPlanPath(rootDir, "overnight");
  const developPath = findLatestPlanPath(rootDir, "develop");

  return {
    generatedAt: now().toISOString(),
    rootDir,
    currentEdition: pickCurrentEdition(editions),
    editions,
    gatesPending,
    overnight: overnightPath ? summarizePlan(rootDir, overnightPath) : null,
    develop: developPath ? summarizePlan(rootDir, developPath) : null,
  };
}
