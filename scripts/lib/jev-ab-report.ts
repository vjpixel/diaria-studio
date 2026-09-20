/**
 * jev-ab-report.ts (#8421) — lógica pura do relatório A/B `/diaria-edicao`
 * (braço A, sem `_internal/.jev-profile.json`) vs `/diaria-edicao-jev`
 * (braço B). Sem I/O. Arquivo corrompido nunca vira braço A por default:
 * a edição fica de fora (braço "unknown") com warning. Métrica ausente vira
 * `null` + aviso, nunca 0.
 *
 * O braço B DECIDE de fato (env=all força jev.shadow:false, decisão do
 * editor). A faixa 0,70-0,85 de Jaccard do dedup NÃO foi calibrada (a
 * medição #8417 só cobriu [0,35, 0,70)). O relatório avisa quando o marcador
 * diz B mas os artefatos das features mostram shadow ou não mostram o env.
 */

export type Tri<T> = { state: "absent" } | { state: "corrupt" } | { state: "ok"; value: T };

export interface EditionRaw {
  edition: string;
  /** false = diretório da edição inexistente. */
  exists: boolean;
  profile: Tri<unknown>;
  editorRequests: Tri<{ rows: unknown[]; invalidLines: number }>;
  stageRows: Tri<unknown>;
  /** `_internal/dedup-grayzone-jev.json` (artefato da feature), se houver. */
  dedupArtifact?: Tri<unknown>;
}

export type Arm = "A" | "B" | "unknown";

export interface EditionMetrics {
  edition: string;
  arm: Arm;
  gate4Corrections: number | null;
  gateWaitMinutes: number | null;
  tokens: number | null;
  stage1WallMinutes: number | null;
}

export const METRIC_KEYS = ["gate4Corrections", "gateWaitMinutes", "tokens", "stage1WallMinutes"] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];

export interface ArmSummary {
  arm: "A" | "B";
  editions: number;
  mean: Record<MetricKey, number | null>;
  n: Record<MetricKey, number>;
}

export interface AbReport {
  arms: { A: ArmSummary; B: ArmSummary };
  perEdition: EditionMetrics[];
  excluded: string[];
  warnings: string[];
  /** Edições com pelo menos uma métrica utilizável. */
  usable: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Braço B exige profile==='all' E features não vazio (P1-2). */
export function armOf(e: EditionRaw): Arm {
  if (e.profile.state === "absent") return "A";
  if (e.profile.state === "corrupt") return "unknown";
  const p = e.profile.value;
  if (isObj(p) && p.profile === "all" && Array.isArray(p.features) && p.features.length > 0) return "B";
  return "unknown";
}

/** Avisos de coerência marcador × artefato (só braço B). */
function armBConsistency(e: EditionRaw): string[] {
  const w: string[] = [];
  const id = e.edition;
  const p = e.profile.state === "ok" && isObj(e.profile.value) ? e.profile.value : {};
  if (p.shadow === true) w.push(`${id}: marcador B com shadow efetivo=true — braço B sem decisão real do Jev`);
  const feats = Array.isArray(p.features) ? p.features : [];
  if (feats.includes("dedup_grayzone")) {
    const a = e.dedupArtifact;
    if (!a || a.state === "absent") {
      w.push(`${id}: marcador B mas sem dedup-grayzone-jev.json — não dá pra confirmar que a feature rodou com o perfil`);
    } else if (a.state === "corrupt" || !isObj(a.value)) {
      w.push(`${id}: dedup-grayzone-jev.json ilegível — não dá pra confirmar o env efetivo`);
    } else {
      if (a.value.profile_env !== "all") w.push(`${id}: marcador B mas o artefato do dedup não registra profile_env=all (edição retomada sem o perfil?)`);
      if (a.value.shadow === true) w.push(`${id}: marcador B mas o artefato do dedup mostra shadow — braço B sem decisão real`);
    }
  }
  // Marcador mais antigo que o Stage 1 (retomada com /diaria-edicao comum).
  const wa = typeof p.written_at === "string" ? Date.parse(p.written_at) : NaN;
  const s1 = stage1Start(e);
  if (Number.isFinite(wa) && s1 !== null && wa < s1 - 60_000) {
    // Só sinaliza quando o Stage 1 começou bem depois do marcador: pode ser retomada sem o perfil.
    w.push(`${id}: marcador anterior ao início do Stage 1 — se a edição foi retomada com /diaria-edicao comum, o perfil pode não ter valido`);
  }
  return w;
}

function stage1Start(e: EditionRaw): number | null {
  if (e.stageRows.state !== "ok" || !Array.isArray(e.stageRows.value)) return null;
  const s1 = e.stageRows.value.find((r) => isObj(r) && r.stage === 1);
  if (!isObj(s1) || typeof s1.start !== "string") return null;
  const t = Date.parse(s1.start);
  return Number.isFinite(t) ? t : null;
}

export function computeMetrics(e: EditionRaw): { m: EditionMetrics; warnings: string[] } {
  const w: string[] = [];
  const id = e.edition;
  const arm = armOf(e);

  if (e.profile.state === "corrupt") w.push(`${id}: .jev-profile.json corrompido — braço desconhecido, edição excluída`);
  else if (e.profile.state === "ok" && arm === "unknown")
    w.push(`${id}: .jev-profile.json inválido (exige profile "all" e features não vazio) — braço desconhecido, edição excluída`);
  if (arm === "B") w.push(...armBConsistency(e));

  let gate4: number | null = null;
  if (e.editorRequests.state === "corrupt") w.push(`${id}: editor-requests.jsonl ilegível — correções do gate 4 indisponíveis`);
  else if (e.editorRequests.state === "absent") w.push(`${id}: sem editor-requests.jsonl — correções do gate 4 indisponíveis`);
  else {
    const { rows, invalidLines } = e.editorRequests.value;
    if (invalidLines > 0) w.push(`${id}: editor-requests.jsonl com ${invalidLines} linha(s) inválida(s) ignorada(s)`);
    gate4 = rows.filter((r) => isObj(r) && r.stage === 4).length;
  }

  let touchMin: number | null = null;
  let tokens: number | null = null;
  let s1min: number | null = null;
  if (e.stageRows.state === "corrupt") w.push(`${id}: stage-status.json ilegível/corrompido — métricas de stage indisponíveis`);
  else if (e.stageRows.state === "absent") w.push(`${id}: sem stage-status.json — métricas de stage indisponíveis`);
  else if (!Array.isArray(e.stageRows.value)) w.push(`${id}: stage-status.json com formato inválido (rows não é array)`);
  else {
    const rows = e.stageRows.value.filter((r): r is Record<string, unknown> => isObj(r) && typeof r.stage === "number");
    let touchMs = 0, touchN = 0, tokN = 0, tok = 0;
    for (const r of rows) {
      if (num(r.duration_ms) && num(r.pipeline_ms)) {
        touchMs += Math.max(0, r.duration_ms - r.pipeline_ms);
        touchN++;
      }
      if (num(r.tokens_in) || num(r.tokens_out)) {
        tok += (num(r.tokens_in) ? r.tokens_in : 0) + (num(r.tokens_out) ? r.tokens_out : 0);
        tokN++;
      }
    }
    if (touchN > 0) {
      touchMin = touchMs / 60000;
      if (touchN < rows.length) w.push(`${id}: espera de gate parcial (${touchN}/${rows.length} stages com duração)`);
      if (touchMs === 0) w.push(`${id}: espera de gate = 0 (gates auto-aprovados por --no-gates?) — não é tempo de toque real`);
    } else w.push(`${id}: sem duration_ms/pipeline_ms — espera de gate indisponível`);
    if (tokN > 0) {
      tokens = tok;
      if (tokN < rows.length) w.push(`${id}: tokens parciais (${tokN}/${rows.length} stages com tokens)`);
    } else w.push(`${id}: sem tokens (capture-stage-usage não rodou?) — tokens indisponíveis`);
    // Wall-clock do Stage 1: pipeline_ms (start→gate_at). O fallback
    // duration_ms (start→end) INCLUI a espera do gate e infla a métrica.
    const s1 = rows.find((r) => r.stage === 1);
    let ms: number | null = null;
    if (s1) {
      if (num(s1.pipeline_ms)) ms = s1.pipeline_ms;
      else if (num(s1.duration_ms)) {
        ms = s1.duration_ms;
        w.push(`${id}: wall-clock do Stage 1 usa duration_ms (inclui espera de gate)`);
      }
    }
    if (ms === null) w.push(`${id}: Stage 1 sem duração — wall-clock indisponível`);
    else s1min = ms / 60000;
  }

  return {
    m: { edition: id, arm, gate4Corrections: gate4, gateWaitMinutes: touchMin, tokens, stage1WallMinutes: s1min },
    warnings: w,
  };
}

function summarize(arm: "A" | "B", ms: EditionMetrics[]): ArmSummary {
  const mean = {} as Record<MetricKey, number | null>;
  const n = {} as Record<MetricKey, number>;
  for (const k of METRIC_KEYS) {
    const vals = ms.map((m) => m[k]).filter((v): v is number => typeof v === "number");
    n[k] = vals.length;
    mean[k] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }
  return { arm, editions: ms.length, mean, n };
}

const hasData = (m: EditionMetrics) => METRIC_KEYS.some((k) => m[k] !== null);

export function buildAbReport(editions: EditionRaw[]): AbReport {
  const warnings: string[] = [];
  const excluded: string[] = [];
  const perEdition: EditionMetrics[] = [];
  const seen = new Set<string>();
  for (const e of editions) {
    if (seen.has(e.edition)) {
      warnings.push(`${e.edition}: id duplicado ignorado`);
      continue;
    }
    seen.add(e.edition);
    if (!e.exists) {
      excluded.push(e.edition);
      warnings.push(`${e.edition}: edição inexistente (diretório ausente) — excluída`);
      continue;
    }
    const { m, warnings: w } = computeMetrics(e);
    warnings.push(...w);
    if (m.arm === "unknown") {
      excluded.push(e.edition);
      continue;
    }
    if (!hasData(m)) {
      excluded.push(e.edition);
      warnings.push(`${e.edition}: sem nenhuma métrica utilizável — excluída da contagem`);
      continue;
    }
    perEdition.push(m);
  }
  const A = perEdition.filter((m) => m.arm === "A");
  const B = perEdition.filter((m) => m.arm === "B");
  if (A.length < 5 || B.length < 5) {
    warnings.push(`amostra abaixo do critério da #8421 (>=5 edições com dado por braço): A=${A.length}, B=${B.length}`);
  }
  return { arms: { A: summarize("A", A), B: summarize("B", B) }, perEdition, excluded, warnings, usable: perEdition.length };
}

const fmt = (v: number | null): string => (v === null ? "n/d" : v.toFixed(1));

export function renderAbReport(r: AbReport): string {
  const lines = [
    "# Relatório A/B: /diaria-edicao (A) vs /diaria-edicao-jev (B)",
    "",
    "Braço B: o Jev DECIDE de fato (env=all força shadow:false). A faixa 0,70-0,85 do dedup não foi calibrada.",
    "",
    "| Métrica | A (média, n) | B (média, n) |",
    "|---|---|---|",
  ];
  const labels: Record<MetricKey, string> = {
    gate4Corrections: "Correções do editor no gate 4",
    gateWaitMinutes: "Espera de gate (min) — proxy, não toque real",
    tokens: "Tokens (in+out, todos os stages)",
    stage1WallMinutes: "Wall-clock Stage 1 (min)",
  };
  for (const k of METRIC_KEYS) {
    lines.push(`| ${labels[k]} | ${fmt(r.arms.A.mean[k])} (n=${r.arms.A.n[k]}) | ${fmt(r.arms.B.mean[k])} (n=${r.arms.B.n[k]}) |`);
  }
  lines.push("", `Edições com dado: A=${r.arms.A.editions}, B=${r.arms.B.editions}. Excluídas: ${r.excluded.length ? r.excluded.join(", ") : "nenhuma"}`);
  if (r.warnings.length) lines.push("", "## Avisos", ...r.warnings.map((x) => `- ${x}`));
  return lines.join("\n") + "\n";
}
