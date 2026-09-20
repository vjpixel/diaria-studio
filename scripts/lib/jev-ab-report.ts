/**
 * jev-ab-report.ts (#8421) — lógica pura do relatório A/B `/diaria-edicao`
 * (braço A, sem `_internal/.jev-profile.json`) vs `/diaria-edicao-jev`
 * (braço B). Sem I/O: o CLI (`scripts/jev-ab-report.ts`) lê os arquivos e
 * entrega `EditionRaw`. Métrica ausente vira `null` + aviso, nunca 0.
 */

export interface StageRowLite {
  stage: number;
  duration_ms?: number;
  pipeline_ms?: number;
  tokens_in?: number;
  tokens_out?: number;
}

export interface EditionRaw {
  edition: string;
  /** Conteúdo parseado de `.jev-profile.json`; `null` = arquivo ausente (braço A). */
  profile: { features?: string[] } | null;
  /** Linhas de `editor-requests.jsonl` parseadas; `null` = arquivo ausente. */
  editorRequests: Array<{ stage?: number }> | null;
  /** `rows` de `stage-status.json`; `null` = arquivo ausente. */
  stageRows: StageRowLite[] | null;
}

export type Arm = "A" | "B";

export interface EditionMetrics {
  edition: string;
  arm: Arm;
  gate4Corrections: number | null;
  touchMinutes: number | null;
  tokens: number | null;
  stage1WallMinutes: number | null;
}

export const METRIC_KEYS = ["gate4Corrections", "touchMinutes", "tokens", "stage1WallMinutes"] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];

export interface ArmSummary {
  arm: Arm;
  editions: number;
  /** Média por métrica sobre as edições que a têm; `null` se nenhuma tem. */
  mean: Record<MetricKey, number | null>;
  /** Quantas edições contribuíram para cada média. */
  n: Record<MetricKey, number>;
}

export interface AbReport {
  arms: { A: ArmSummary; B: ArmSummary };
  perEdition: EditionMetrics[];
  warnings: string[];
}

export function armOf(e: EditionRaw): Arm {
  return e.profile ? "B" : "A";
}

export function computeMetrics(e: EditionRaw): { m: EditionMetrics; warnings: string[] } {
  const warnings: string[] = [];
  const rows = e.stageRows;

  // Correções no gate 4: entradas de editor-requests com stage === 4.
  const gate4 = e.editorRequests ? e.editorRequests.filter((r) => r.stage === 4).length : null;
  if (gate4 === null) warnings.push(`${e.edition}: sem editor-requests.jsonl — correções do gate 4 indisponíveis`);

  // Minutos de toque: espera de gate = duration_ms - pipeline_ms (start→end
  // menos start→gate_at), somada nas linhas que têm os dois campos.
  let touchMs: number | null = null;
  if (rows) {
    for (const r of rows) {
      if (typeof r.duration_ms === "number" && typeof r.pipeline_ms === "number") {
        touchMs = (touchMs ?? 0) + Math.max(0, r.duration_ms - r.pipeline_ms);
      }
    }
  }
  if (touchMs === null) warnings.push(`${e.edition}: sem duration_ms/pipeline_ms em stage-status.json — minutos de toque indisponíveis`);

  let tokens: number | null = null;
  if (rows) {
    for (const r of rows) {
      if (typeof r.tokens_in === "number" || typeof r.tokens_out === "number") {
        tokens = (tokens ?? 0) + (r.tokens_in ?? 0) + (r.tokens_out ?? 0);
      }
    }
  }
  if (tokens === null) warnings.push(`${e.edition}: sem tokens em stage-status.json (capture-stage-usage não rodou?) — tokens indisponíveis`);

  const s1 = rows?.find((r) => r.stage === 1);
  const s1ms = s1 ? (s1.pipeline_ms ?? s1.duration_ms) : undefined;
  if (typeof s1ms !== "number") warnings.push(`${e.edition}: Stage 1 sem duração — wall-clock indisponível`);

  return {
    m: {
      edition: e.edition,
      arm: armOf(e),
      gate4Corrections: gate4,
      touchMinutes: touchMs === null ? null : touchMs / 60000,
      tokens,
      stage1WallMinutes: typeof s1ms === "number" ? s1ms / 60000 : null,
    },
    warnings,
  };
}

function summarize(arm: Arm, ms: EditionMetrics[]): ArmSummary {
  const mean = {} as Record<MetricKey, number | null>;
  const n = {} as Record<MetricKey, number>;
  for (const k of METRIC_KEYS) {
    const vals = ms.map((m) => m[k]).filter((v): v is number => typeof v === "number");
    n[k] = vals.length;
    mean[k] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }
  return { arm, editions: ms.length, mean, n };
}

export function buildAbReport(editions: EditionRaw[]): AbReport {
  const warnings: string[] = [];
  const perEdition: EditionMetrics[] = [];
  for (const e of editions) {
    const { m, warnings: w } = computeMetrics(e);
    perEdition.push(m);
    warnings.push(...w);
  }
  const A = perEdition.filter((m) => m.arm === "A");
  const B = perEdition.filter((m) => m.arm === "B");
  if (A.length < 5 || B.length < 5) {
    warnings.push(`amostra abaixo do critério da #8421 (>=5 edições por braço): A=${A.length}, B=${B.length}`);
  }
  return { arms: { A: summarize("A", A), B: summarize("B", B) }, perEdition, warnings };
}

const fmt = (v: number | null): string => (v === null ? "n/d" : v.toFixed(1));

export function renderAbReport(r: AbReport): string {
  const lines = [
    "# Relatório A/B: /diaria-edicao (A) vs /diaria-edicao-jev (B)",
    "",
    "| Métrica | A (média, n) | B (média, n) |",
    "|---|---|---|",
  ];
  const labels: Record<MetricKey, string> = {
    gate4Corrections: "Correções do editor no gate 4",
    touchMinutes: "Minutos de toque (espera de gate)",
    tokens: "Tokens (in+out, todos os stages)",
    stage1WallMinutes: "Wall-clock Stage 1 (min)",
  };
  for (const k of METRIC_KEYS) {
    lines.push(
      `| ${labels[k]} | ${fmt(r.arms.A.mean[k])} (n=${r.arms.A.n[k]}) | ${fmt(r.arms.B.mean[k])} (n=${r.arms.B.n[k]}) |`,
    );
  }
  lines.push("", `Edições: A=${r.arms.A.editions}, B=${r.arms.B.editions}`);
  if (r.warnings.length) lines.push("", "## Avisos", ...r.warnings.map((w) => `- ${w}`));
  return lines.join("\n") + "\n";
}
