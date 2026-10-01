/**
 * lib/calibration-labels.ts (#9373)
 *
 * Fonte única do RÓTULO de verdade da autocalibração de score (#7972,
 * Track B): "o editor manteve este candidato?". Consumido por
 * `calibration-power-report.ts`, `shadow-validation-report.ts`,
 * `calibrate-scoring-weights.ts` e `analyze-destaque-overrides.ts`.
 *
 * ## Por que existe (#9373)
 *
 * O rótulo antigo era "a URL sobreviveu de `01-categorized.json` para
 * `01-approved.json`" — o gate do **Stage 1**. Só que a curadoria do pool não
 * acontece mais ali: o editor aprova quase tudo no Stage 1 e corta, inclui e
 * move no **Stage 4** (`02-reviewed.md`). Medido em 01/10/2026
 * (`shadow-validation-report.ts --weights 340ec6d9d3e9b0f1`): em 9 edições,
 * `kept` = 100% do pool em 6 delas, AUC calculada sobre 1 a 4 descartes por
 * edição — ruído. A leitura "o score prediz pior que o acaso o que o editor
 * mantém" (AUC 0,364, comentário de 11/09 na #7972) se apoiava nesse rótulo.
 *
 * ## Rótulos
 *
 * - `stage4` (padrão): desfecho no gate 4. Só vale para edição com o gate 4
 *   aprovado (`.step-4-done.json`); antes disso o `02-reviewed.md` ainda é
 *   rascunho. O desfecho detalhado (`Stage4Outcome`) separa:
 *   - `published` — a pipeline entregou no rascunho e o editor manteve;
 *   - `cut_by_editor` — a pipeline entregou e o editor cortou;
 *   - `editor_included` — a pipeline NÃO entregou e o editor incluiu à mão
 *     (positivo forte);
 *   - `not_delivered` — nem entregue, nem incluído.
 *   Rótulo binário: `published`/`editor_included` → `true`, `cut_by_editor`
 *   → `false`, `not_delivered` → `null` (SEM sinal do editor — fica fora do
 *   conjunto rotulado). Excluir `not_delivered` é deliberado: o que a
 *   pipeline deixou de entregar foi decidido pelo próprio score (writer pega
 *   o topo do pool); rotular isso como "descartado" faria a AUC medir a
 *   pipeline contra ela mesma, não o editor. "Presente" = qualquer link no
 *   markdown (destaque, seção, "Aprofunde:"), por URL canônica.
 *   "Entregue" = presente na saída da pipeline do Stage 2: o snapshot
 *   `stage2-post-gate` quando o baseline é confiável (#9356, carimbo +
 *   captura junto do sentinel), senão o último `_internal/02-*.md` da
 *   pipeline (`resolvePipelineOutput`, mesmo critério do #9360).
 * - `stage1` (legado, pra comparação): `kept` = URL em qualquer bucket do
 *   `01-approved.json` DO GATE 1 — o snapshot congelado
 *   `01-approved.gate1.json` quando existe (#9372), senão o arquivo vivo, que
 *   o Stage 4 reescreve.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalize } from "./url-utils.ts";
import { extractAllLinkUrls, resolvePipelineOutput } from "./editor-rejected-items.ts";
import { STAGE2_BASELINE_LABEL, SNAPSHOT_DIR, assessStage2BaselineOnDisk } from "./editor-request-snapshots.ts";
import { readGate1Approved } from "./stage1-funnel.ts";

export type CalibrationLabelSource = "stage1" | "stage4";
export const CALIBRATION_LABEL_SOURCES: readonly CalibrationLabelSource[] = ["stage1", "stage4"];
export const DEFAULT_LABEL_SOURCE: CalibrationLabelSource = "stage4";

export function parseLabelSource(raw: string | undefined): CalibrationLabelSource {
  if (raw === undefined) return DEFAULT_LABEL_SOURCE;
  if ((CALIBRATION_LABEL_SOURCES as readonly string[]).includes(raw)) return raw as CalibrationLabelSource;
  throw new Error(`--label inválido: "${raw}" (use ${CALIBRATION_LABEL_SOURCES.join("|")})`);
}

/** URLs presentes em QUALQUER bucket de um `01-approved.json` (highlights incluído, via `article.url`/`url`). */
export function keptUrlsFromApproved(json: any): Set<string> {
  const urls = new Set<string>();
  const buckets = ["highlights", "runners_up", "lancamento", "radar", "use_melhor", "video"];
  for (const bucket of buckets) {
    for (const item of json?.[bucket] ?? []) {
      const url = item?.article?.url ?? item?.url;
      if (typeof url === "string" && url !== "") urls.add(url);
    }
  }
  return urls;
}

export type Stage4Outcome = "published" | "cut_by_editor" | "editor_included" | "not_delivered";

export interface Stage4Reference {
  /** URLs canônicas de TODOS os links da saída da pipeline (rascunho entregue ao editor). */
  delivered: Set<string>;
  /** URLs canônicas de TODOS os links do `02-reviewed.md` final. */
  published: Set<string>;
  /** De onde veio a referência "entregue". */
  reference: "stage2-snapshot" | "pipeline-output";
}

/** Pure: referência a partir dos dois markdowns. */
export function stage4ReferenceFromMarkdown(
  pipelineMd: string,
  finalMd: string,
  reference: Stage4Reference["reference"],
): Stage4Reference {
  return { delivered: extractAllLinkUrls(pipelineMd), published: extractAllLinkUrls(finalMd), reference };
}

/** Pure: desfecho de uma URL no Stage 4. */
export function classifyStage4Outcome(url: string, ref: Stage4Reference): Stage4Outcome {
  const c = canonicalize(url);
  const delivered = ref.delivered.has(c);
  const published = ref.published.has(c);
  if (delivered) return published ? "published" : "cut_by_editor";
  return published ? "editor_included" : "not_delivered";
}

export type LoadResult<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * Referência do Stage 4 de uma edição em disco. Exige o gate 4 aprovado
 * (`.step-4-done.json`) e o `02-reviewed.md` final; "entregue" vem do
 * snapshot `stage2-post-gate` se confiável, senão da saída da pipeline.
 */
export function loadStage4Reference(editionDir: string): LoadResult<Stage4Reference> {
  if (!existsSync(resolve(editionDir, "_internal", ".step-4-done.json"))) {
    return { ok: false, reason: "gate 4 não aprovado (.step-4-done.json ausente) — 02-reviewed.md ainda não é o final" };
  }
  const finalPath = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(finalPath)) return { ok: false, reason: "02-reviewed.md ausente" };
  try {
    const finalMd = readFileSync(finalPath, "utf8");
    const snapPath = resolve(editionDir, SNAPSHOT_DIR, STAGE2_BASELINE_LABEL, "02-reviewed.md");
    if (existsSync(snapPath) && assessStage2BaselineOnDisk(editionDir).status === "ok") {
      return { ok: true, value: stage4ReferenceFromMarkdown(readFileSync(snapPath, "utf8"), finalMd, "stage2-snapshot") };
    }
    const pipelinePath = resolvePipelineOutput(editionDir);
    if (!pipelinePath) return { ok: false, reason: "sem saída da pipeline do Stage 2 (snapshot stage2-post-gate ou _internal/02-*.md)" };
    return { ok: true, value: stage4ReferenceFromMarkdown(readFileSync(pipelinePath, "utf8"), finalMd, "pipeline-output") };
  } catch (err) {
    return { ok: false, reason: `erro de leitura/I-O: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Pure: rótulo binário do desfecho (`null` = sem sinal do editor, fora do conjunto rotulado). */
export function stage4OutcomeToKept(outcome: Stage4Outcome): boolean | null {
  if (outcome === "published" || outcome === "editor_included") return true;
  if (outcome === "cut_by_editor") return false;
  return null;
}

export interface KeptLabeler {
  source: CalibrationLabelSource;
  /** `true`/`false` = rótulo; `null` = linha sem sinal do editor (stage4 `not_delivered`) — excluir da amostra. stage1 nunca devolve `null`. */
  label(url: string): boolean | null;
  /** stage4: desfecho detalhado; stage1: sempre `null`. */
  stage4Outcome(url: string): Stage4Outcome | null;
  /** stage1: `true` quando lido do snapshot congelado do gate 1. stage4: `null`. */
  gate1Frozen: boolean | null;
  stage4Reference: Stage4Reference["reference"] | null;
}

/** Rotulador de `kept` de uma edição pela fonte escolhida. */
export function loadKeptLabeler(editionDir: string, source: CalibrationLabelSource): LoadResult<KeptLabeler> {
  if (source === "stage1") {
    const approved = readGate1Approved(editionDir);
    if (!approved) return { ok: false, reason: "01-approved.json (nem 01-approved.gate1.json) ausente ou malformado — impossível derivar kept" };
    const kept = keptUrlsFromApproved(approved.json);
    return {
      ok: true,
      value: { source, label: (u) => kept.has(u), stage4Outcome: () => null, gate1Frozen: approved.frozen, stage4Reference: null },
    };
  }
  const ref = loadStage4Reference(editionDir);
  if (!ref.ok) return ref;
  const r = ref.value;
  return {
    ok: true,
    value: {
      source,
      label: (u) => stage4OutcomeToKept(classifyStage4Outcome(u, r)),
      stage4Outcome: (u) => classifyStage4Outcome(u, r),
      gate1Frozen: null,
      stage4Reference: r.reference,
    },
  };
}
