/**
 * lib/stage1-funnel.ts (#9372)
 *
 * Registro confiável do que o Stage 1 fez numa edição — gravado UMA vez, no
 * write do sentinel do Stage 1 (`pipeline-sentinel.ts write --step 1`, que
 * roda depois do gate 1 aplicado), e nunca regravado.
 *
 * Dois artefatos, ambos imutáveis (write-once — rerun/resume é no-op):
 *
 * 1. `_internal/01-approved.gate1.json` — cópia byte a byte do
 *    `01-approved.json` no fim do gate 1. O `01-approved.json` é REESCRITO
 *    depois, no Stage 4 (troca de destaque, `*.pre-d3swap.json` etc.), então
 *    quem o lê como "estado pós-gate 1" vê inclusões feitas horas depois (a
 *    análise de 01/10/2026, #9365, contou 46 de 51 inclusões como "presentes
 *    na pipeline"; eram 21). `readGate1Approved` é o leitor canônico.
 *
 * 2. `_internal/stage1-funnel.json` — manifesto do funil: pra cada URL que
 *    entrou no Stage 1, a etapa em que saiu e o motivo (dedup com o
 *    `dedup_note`, janela de data com o `detail`, cluster com o representante,
 *    cap, ranking com o score, gate 1). Derivado dos `tmp-*.json` NO MOMENTO
 *    do fim do Stage 1 — depois disso um resume/retry que sobrescreva um
 *    `tmp-*` não muda mais o registro.
 *
 * Honestidade sobre o que o manifesto NÃO resolve: ele lê os `tmp-*` como
 * estão no fim do Stage 1. Se uma etapa do próprio Stage 1 rodou de novo no
 * meio (retry), as contagens podem não fechar entre etapas vizinhas — o
 * manifesto não esconde isso: arquivo mais novo que a etapa SEGUINTE vira
 * `stale_order` (excluído das transições, com warning), e URL que aparece no
 * meio do funil sem ter passado pela etapa anterior conta em
 * `entered_mid_funnel` por etapa. Etapa ausente fica `present: false` e a
 * saída que "pula" por ela vira `ambiguous: true`.
 *
 * Puro + IO separado: `buildStage1Funnel` recebe os JSONs já lidos (testável
 * sem disco); `buildStage1FunnelFromDisk`/`captureStage1Records` fazem o IO.
 */

import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalize } from "./url-utils.ts";

export const GATE1_SNAPSHOT_FILE = "_internal/01-approved.gate1.json";
export const FUNNEL_MANIFEST_FILE = "_internal/stage1-funnel.json";
export const FUNNEL_SCHEMA_VERSION = 1;

const POOL_BUCKETS = ["lancamento", "radar", "use_melhor", "video"] as const;

/** Uma etapa do funil, na ordem real de execução do playbook do Stage 1. */
export interface FunnelStageDef {
  id: string;
  /** Relativo ao diretório da edição. */
  file: string;
  /** Rótulo humano da etapa, usado como motivo genérico de saída. */
  label: string;
}

/**
 * Ordem do `orchestrator-stage-1-research.md` (1i verify → 1j expand → 1l
 * dedup → 1m categorize → 1n cluster → 1o janela → 1p1 datas → 1q.1 cap do
 * split → 1q.3 merge → 1s finalize → 1u post-select → 1v render → gate).
 * `tmp-kept.json` é cópia do `kept[]` do dedup e fica de fora.
 */
export const FUNNEL_STAGES: readonly FunnelStageDef[] = [
  { id: "collected", file: "_internal/tmp-articles-raw.json", label: "coleta (pesquisa/RSS/inbox)" },
  { id: "verify", file: "_internal/tmp-articles-post-verify.json", label: "verificação de acessibilidade" },
  { id: "aggregator_expand", file: "_internal/tmp-articles-expanded.json", label: "expansão de agregadores do inbox" },
  { id: "dedup", file: "_internal/tmp-dedup-output.json", label: "dedup" },
  { id: "categorize", file: "_internal/tmp-categorized.json", label: "categorização" },
  { id: "cluster", file: "_internal/tmp-clustered.json", label: "topic clustering" },
  { id: "date_window", file: "_internal/tmp-filtered.json", label: "filtro de janela de data" },
  { id: "date_review", file: "_internal/tmp-dates-reviewed.json", label: "revisão de datas" },
  { id: "scoring_pool", file: "_internal/tmp-scoring-pool.json", label: "cap do pool de scoring" },
  { id: "scored", file: "_internal/tmp-allscored.json", label: "pontuação (merge dos chunks)" },
  { id: "finalize", file: "_internal/tmp-finalized.json", label: "finalize (corte por score/cap de seção)" },
  { id: "post_select", file: "_internal/01-categorized.json", label: "mínimos/dedup intra/evergreen (pós-seleção)" },
  { id: "gate1", file: "_internal/01-approved.json", label: "gate 1 do editor" },
];

/** Entrada de uma etapa: conteúdo parseado (ou `null` = ausente) + mtime. */
export interface FunnelStageInput {
  json: unknown | null;
  mtimeMs: number | null;
}

export interface FunnelStageSummary {
  id: string;
  file: string;
  present: boolean;
  /** Arquivo mais novo que a etapa SEGUINTE presente — reescrito depois (rerun/etapa posterior); excluído das transições. */
  stale_order: boolean;
  count: number | null;
  /** URLs presentes aqui que não estavam na etapa anterior usada (rerun parcial, inbox tardio, troca de URL). */
  entered_mid_funnel: number;
}

export interface FunnelItem {
  url: string;
  title: string;
  /** Última etapa (usada) em que a URL estava presente. */
  last_stage: string;
  /** `approved` = chegou ao `01-approved.json` do gate 1. */
  outcome: "approved" | "dropped";
  /** Etapa em que saiu (a próxima etapa usada depois de `last_stage`), ou `null` se aprovada. */
  exit_stage: string | null;
  reason: string | null;
  /** Score do merge quando a URL foi pontuada. */
  score: number | null;
  /** `true` quando há etapa ausente/stale entre `last_stage` e `exit_stage`: o ponto exato de saída é incerto. */
  ambiguous: boolean;
}

/**
 * Quem gravou: `pipeline-sentinel-step-1` (registro, fim do Stage 1) ou
 * `backfill` (reconstrução posterior por `scripts/build-stage1-funnel.ts` —
 * os `tmp-*` podem já ter sido sobrescritos e o gate 1 vem do arquivo vivo).
 */
export type FunnelTrigger = "pipeline-sentinel-step-1" | "backfill";

export interface Stage1FunnelManifest {
  schema_version: number;
  edition: string;
  generated_at: string;
  trigger: FunnelTrigger;
  /** `true` quando o gate 1 veio do snapshot congelado `01-approved.gate1.json`. */
  gate1_frozen: boolean;
  stages: FunnelStageSummary[];
  items: FunnelItem[];
  totals: { urls: number; approved: number; dropped: number; ambiguous: number; by_exit_stage: Record<string, number> };
  warnings: string[];
}

type Extracted = { urls: Map<string, { url: string; title: string }>; reasons: Map<string, string>; scores: Map<string, number> };

function asObj(v: unknown): Record<string, any> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : null;
}

function addItem(out: Extracted, item: any, key: (u: string) => string): void {
  const url = item?.article?.url ?? item?.url;
  if (typeof url !== "string" || url === "") return;
  const title = item?.article?.title ?? item?.title;
  const k = key(url);
  if (!out.urls.has(k)) out.urls.set(k, { url, title: typeof title === "string" ? title : "" });
}

function addBuckets(out: Extracted, obj: Record<string, any> | null, key: (u: string) => string, withHighlights: boolean): void {
  if (!obj) return;
  const buckets: string[] = withHighlights ? ["highlights", "runners_up", ...POOL_BUCKETS] : [...POOL_BUCKETS];
  for (const b of buckets) for (const item of Array.isArray(obj[b]) ? obj[b] : []) addItem(out, item, key);
}

/** Extrai URLs (+ motivos de remoção/score quando o arquivo os registra) de uma etapa. */
function extractStage(id: string, json: unknown, key: (u: string) => string): Extracted {
  const out: Extracted = { urls: new Map(), reasons: new Map(), scores: new Map() };
  const obj = asObj(json);
  switch (id) {
    case "collected":
    case "verify":
      for (const item of Array.isArray(json) ? json : []) addItem(out, item, key);
      break;
    case "aggregator_expand":
      for (const item of Array.isArray(obj?.articles) ? obj!.articles : Array.isArray(json) ? (json as any[]) : []) addItem(out, item, key);
      break;
    case "dedup":
      for (const item of Array.isArray(obj?.kept) ? obj!.kept : []) addItem(out, item, key);
      for (const r of Array.isArray(obj?.removed) ? obj!.removed : []) {
        if (typeof r?.url === "string") out.reasons.set(key(r.url), `dedup: ${r.dedup_note ?? "sem nota"}`);
      }
      break;
    case "categorize":
    case "post_select":
    case "gate1":
      addBuckets(out, obj, key, true);
      break;
    case "cluster":
      addBuckets(out, obj, key, false);
      for (const c of Array.isArray(obj?.clusters) ? obj!.clusters : []) {
        if (typeof c?.top_url !== "string") continue;
        for (const m of Array.isArray(c?.member_urls) ? c.member_urls : []) {
          if (typeof m === "string" && key(m) !== key(c.top_url)) out.reasons.set(key(m), `cluster: mesmo evento que ${c.top_url}`);
        }
      }
      break;
    case "date_window":
      addBuckets(out, asObj(obj?.kept), key, false);
      for (const r of Array.isArray(obj?.removed) ? obj!.removed : []) {
        if (typeof r?.url === "string") out.reasons.set(key(r.url), `janela de data: ${r.detail ?? r.reason ?? "fora da janela"}`);
      }
      break;
    case "date_review":
      addBuckets(out, asObj(obj?.categorized), key, false);
      for (const r of Array.isArray(obj?.stats?.removals) ? obj!.stats.removals : []) {
        if (typeof r?.url === "string") out.reasons.set(key(r.url), `revisão de datas: ${r.detail ?? r.reason ?? "removido"}`);
      }
      break;
    case "scoring_pool":
      addBuckets(out, asObj(obj?.categorized), key, false);
      break;
    case "scored":
      for (const r of Array.isArray(obj?.all_scored) ? obj!.all_scored : []) {
        addItem(out, r, key);
        if (typeof r?.url === "string" && typeof r?.score === "number") out.scores.set(key(r.url), r.score);
      }
      break;
    case "finalize":
      addBuckets(out, obj, key, true);
      break;
  }
  return out;
}

/** Tolerância de mtime pra `stale_order` — escritas da mesma etapa no mesmo segundo não contam. */
const STALE_ORDER_TOLERANCE_MS = 1000;

/**
 * Monta o manifesto a partir das entradas já lidas (puro). `inputs[i]`
 * corresponde a `FUNNEL_STAGES[i]`; `gate1` deve ser o 01-approved DO GATE 1
 * (snapshot congelado quando existir).
 */
export function buildStage1Funnel(
  edition: string,
  inputs: readonly FunnelStageInput[],
  opts: { now?: Date; trigger?: FunnelTrigger; gate1Frozen?: boolean } = {},
): Stage1FunnelManifest {
  const now = opts.now ?? new Date();
  if (inputs.length !== FUNNEL_STAGES.length) {
    throw new Error(`buildStage1Funnel: esperava ${FUNNEL_STAGES.length} entradas (uma por FUNNEL_STAGES), recebeu ${inputs.length}`);
  }
  const warnings: string[] = [];

  // Troca de URL na verificação (shortener resolvido, #317): `resolvedFrom`
  // aponta a URL antiga — a mesma notícia não pode "sair" na coleta e
  // "entrar" de novo na verificação.
  const alias = new Map<string, string>();
  for (const inp of inputs) {
    const arr = Array.isArray(inp.json) ? inp.json : Array.isArray(asObj(inp.json)?.articles) ? asObj(inp.json)!.articles : [];
    for (const a of arr) {
      if (typeof a?.resolvedFrom === "string" && typeof a?.url === "string") alias.set(canonicalize(a.resolvedFrom), canonicalize(a.url));
    }
  }
  const key = (u: string): string => {
    const c = canonicalize(u);
    return alias.get(c) ?? c;
  };

  const extracted = FUNNEL_STAGES.map((s, i) => (inputs[i].json === null ? null : extractStage(s.id, inputs[i].json, key)));

  // stale_order: arquivo mais novo que a próxima etapa presente = reescrito
  // depois dela (ex.: `tmp-categorized.json` regravado pelo pós-seleção).
  // `gate1` nunca é stale (é a referência final).
  const stale = FUNNEL_STAGES.map(() => false);
  for (let i = 0; i < FUNNEL_STAGES.length - 1; i++) {
    const m = inputs[i].mtimeMs;
    if (extracted[i] === null || m === null) continue;
    let j = i + 1;
    while (j < FUNNEL_STAGES.length && extracted[j] === null) j++;
    if (j >= FUNNEL_STAGES.length) continue;
    const next = inputs[j].mtimeMs;
    if (next !== null && m - next > STALE_ORDER_TOLERANCE_MS) {
      stale[i] = true;
      warnings.push(
        `${FUNNEL_STAGES[i].file} é mais novo que ${FUNNEL_STAGES[j].file} (etapa seguinte) — reescrito depois (rerun ou etapa posterior); excluído das transições do funil.`,
      );
    }
  }

  const used = FUNNEL_STAGES.map((_, i) => extracted[i] !== null && !stale[i]);
  for (let i = 0; i < FUNNEL_STAGES.length; i++) {
    if (extracted[i] === null) warnings.push(`${FUNNEL_STAGES[i].file} ausente — saídas que passam por essa etapa ficam ambíguas.`);
  }

  // Resumo por etapa + entradas no meio do funil.
  const stages: FunnelStageSummary[] = [];
  let prevUsed: Extracted | null = null;
  for (let i = 0; i < FUNNEL_STAGES.length; i++) {
    const ex = extracted[i];
    let enteredMid = 0;
    if (ex && used[i] && prevUsed) {
      for (const k of ex.urls.keys()) if (!prevUsed.urls.has(k)) enteredMid++;
    }
    stages.push({
      id: FUNNEL_STAGES[i].id,
      file: FUNNEL_STAGES[i].file,
      present: ex !== null,
      stale_order: stale[i],
      count: ex ? ex.urls.size : null,
      entered_mid_funnel: enteredMid,
    });
    if (ex && used[i]) prevUsed = ex;
  }

  // Universo: toda URL que apareceu em qualquer etapa usada.
  const universe = new Map<string, { url: string; title: string }>();
  const scores = new Map<string, number>();
  for (let i = 0; i < FUNNEL_STAGES.length; i++) {
    const ex = extracted[i];
    if (!ex || !used[i]) continue;
    for (const [k, v] of ex.urls) {
      const cur = universe.get(k);
      if (!cur) universe.set(k, { ...v });
      else {
        // URL exibida = a da etapa mais adiantada (pós-`resolvedFrom`, pós-normalização).
        cur.url = v.url;
        if (!cur.title && v.title) cur.title = v.title;
      }
    }
    for (const [k, s] of ex.scores) scores.set(k, s);
  }

  const gateIdx = FUNNEL_STAGES.length - 1;
  const items: FunnelItem[] = [];
  for (const [k, meta] of universe) {
    let last = -1;
    for (let i = 0; i < FUNNEL_STAGES.length; i++) if (used[i] && extracted[i]!.urls.has(k)) last = i;
    const score = scores.get(k) ?? null;
    if (last === gateIdx) {
      items.push({ url: meta.url, title: meta.title, last_stage: FUNNEL_STAGES[last].id, outcome: "approved", exit_stage: null, reason: null, score, ambiguous: false });
      continue;
    }
    let exit = last + 1;
    let ambiguous = false;
    while (exit < FUNNEL_STAGES.length && !used[exit]) {
      ambiguous = true;
      exit++;
    }
    if (exit >= FUNNEL_STAGES.length) {
      // Só acontece se o gate1 estiver ausente — sem referência final.
      items.push({ url: meta.url, title: meta.title, last_stage: FUNNEL_STAGES[last].id, outcome: "dropped", exit_stage: null, reason: "referência final (01-approved) ausente", score, ambiguous: true });
      continue;
    }
    const exitDef = FUNNEL_STAGES[exit];
    let reason = extracted[exit]!.reasons.get(k) ?? null;
    if (!reason) {
      if (exitDef.id === "gate1") reason = "cortado no gate 1 do editor";
      else if ((exitDef.id === "finalize" || exitDef.id === "post_select") && score !== null) reason = `${exitDef.label} — score ${score}`;
      else reason = exitDef.label;
    }
    items.push({ url: meta.url, title: meta.title, last_stage: FUNNEL_STAGES[last].id, outcome: "dropped", exit_stage: exitDef.id, reason, score, ambiguous });
  }
  items.sort((a, b) => a.url.localeCompare(b.url));

  const byExit: Record<string, number> = {};
  for (const it of items) if (it.exit_stage) byExit[it.exit_stage] = (byExit[it.exit_stage] ?? 0) + 1;
  const approved = items.filter((i) => i.outcome === "approved").length;
  return {
    schema_version: FUNNEL_SCHEMA_VERSION,
    edition,
    generated_at: now.toISOString(),
    trigger: opts.trigger ?? "backfill",
    gate1_frozen: opts.gate1Frozen ?? false,
    stages,
    items,
    totals: {
      urls: items.length,
      approved,
      dropped: items.length - approved,
      ambiguous: items.filter((i) => i.ambiguous).length,
      by_exit_stage: byExit,
    },
    warnings,
  };
}

function readStageInput(editionDir: string, rel: string, warnings: string[]): FunnelStageInput {
  const p = resolve(editionDir, rel);
  if (!existsSync(p)) return { json: null, mtimeMs: null };
  try {
    return { json: JSON.parse(readFileSync(p, "utf8")), mtimeMs: statSync(p).mtimeMs };
  } catch (e) {
    warnings.push(`${rel} ilegível (${e instanceof Error ? e.message : String(e)}) — tratado como ausente.`);
    return { json: null, mtimeMs: null };
  }
}

/**
 * Lê o `01-approved.json` DO GATE 1: o snapshot congelado quando existe,
 * senão o arquivo vivo (`frozen: false` — pode conter edições do Stage 4).
 * `null` se nenhum dos dois existe/parseia.
 */
export function readGate1Approved(editionDir: string): { json: any; frozen: boolean; path: string } | null {
  for (const [rel, frozen] of [[GATE1_SNAPSHOT_FILE, true], ["_internal/01-approved.json", false]] as const) {
    const p = resolve(editionDir, rel);
    if (!existsSync(p)) continue;
    try {
      return { json: JSON.parse(readFileSync(p, "utf8")), frozen, path: p };
    } catch {
      continue;
    }
  }
  return null;
}

/** IO: monta o manifesto lendo os arquivos da edição (gate1 = snapshot congelado quando existir). */
export function buildStage1FunnelFromDisk(
  editionDir: string,
  edition: string,
  opts: { now?: Date; trigger?: FunnelTrigger } = {},
): Stage1FunnelManifest {
  const readWarnings: string[] = [];
  const gate1Frozen = existsSync(resolve(editionDir, GATE1_SNAPSHOT_FILE));
  const inputs = FUNNEL_STAGES.map((s) => {
    if (s.id === "gate1" && gate1Frozen) return readStageInput(editionDir, GATE1_SNAPSHOT_FILE, readWarnings);
    return readStageInput(editionDir, s.file, readWarnings);
  });
  const manifest = buildStage1Funnel(edition, inputs, { now: opts.now, trigger: opts.trigger, gate1Frozen });
  if (!gate1Frozen) {
    readWarnings.push(
      `${GATE1_SNAPSHOT_FILE} ausente — gate 1 lido do 01-approved.json vivo, que o Stage 4 reescreve (manifesto pós-Stage 4 = reconstrução, não registro).`,
    );
  }
  manifest.warnings.unshift(...readWarnings);
  return manifest;
}

export type RecordOutcome = "created" | "exists" | "no-source";

export interface CaptureStage1Result {
  gate1_snapshot: RecordOutcome;
  funnel_manifest: RecordOutcome;
}

/**
 * Grava os dois registros do fim do Stage 1, write-once. Chamado pelo write
 * do sentinel do Stage 1. Ordem importa: o snapshot do gate 1 primeiro, pro
 * manifesto já ler a referência congelada.
 */
export function captureStage1Records(editionDir: string, edition: string, now: Date = new Date()): CaptureStage1Result {
  const approved = resolve(editionDir, "_internal", "01-approved.json");
  const snap = resolve(editionDir, GATE1_SNAPSHOT_FILE);
  let gate1: RecordOutcome;
  if (existsSync(snap)) gate1 = "exists";
  else if (!existsSync(approved)) gate1 = "no-source";
  else {
    copyFileSync(approved, snap);
    gate1 = "created";
  }

  const manifestPath = resolve(editionDir, FUNNEL_MANIFEST_FILE);
  let funnel: RecordOutcome;
  if (existsSync(manifestPath)) funnel = "exists";
  else if (!existsSync(resolve(editionDir, "_internal", "01-categorized.json"))) funnel = "no-source";
  else {
    const manifest = buildStage1FunnelFromDisk(editionDir, edition, { now, trigger: "pipeline-sentinel-step-1" });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    funnel = "created";
  }
  return { gate1_snapshot: gate1, funnel_manifest: funnel };
}
