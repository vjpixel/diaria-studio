/**
 * apply-stage2-caps.ts (#358, #907, #1240, #1629)
 *
 * Helper puro pra aplicar os caps editoriais de Stage 2 no `01-approved.json`
 * antes de passar pro writer agent. Caps atualizados pra refletir buckets
 * pós-#1629 (radar substituiu pesquisa + noticias):
 *
 *   | Bucket          | Cap                                              |
 *   |-----------------|--------------------------------------------------|
 *   | Destaques       | sem corte (sempre 3 após gate Stage 1)           |
 *   | Lançamentos     | ≤ 5                                              |
 *   | Radar           | max(5, 12 − destaques − lançamentos_final)       |
 *
 * Antes (#358 original): lancamento ≤5 + pesquisa ≤3 + outras notícias
 * max(2, 12-d-l-p). Após #1629 a soma efetiva é mantida: lancamento ≤5 +
 * radar ≤ 5 = ~10 + 3 destaques = 13 worst case, batendo o alvo de ~12.
 *
 * O orchestrator-stage-2.md documentava os caps como spec, mas nem
 * orchestrator nem writer tinham enforcement. Editor (Pixel) detectou em
 * 260507: writer publicou 9 itens de Outras Notícias quando cap esperado
 * era 4. Esse helper agora é chamado antes do dispatch do writer + lint
 * pós-writer valida que o output respeitou.
 *
 * #1240 (2026-05-14): além de aplicar caps, agora REMOVE URLs de
 * `highlights[]` dos buckets antes de truncar. Sem isso, um artigo
 * promovido a destaque (ex: Claude for Small Business como D2) também
 * aparecia em LANÇAMENTOS — o leitor via o mesmo artigo 2× na edição.
 * Slot liberado é preenchido pelo próximo de score mais alto no bucket.
 */

import { canonicalize } from "./url-utils.ts";

export interface StageArticle {
  url?: string;
  title?: string;
  score?: number;
  [key: string]: unknown;
}

/**
 * Highlight no Stage 2 (#1445) — pode vir em 2 shapes:
 *
 * 1. **Nested** (produção, output do scorer):
 *    `{ rank, score, bucket, reason, article: { url, title, ... } }`
 *
 * 2. **Flat** (testes legacy, fixtures pre-scorer e edge cases):
 *    `{ url, title, score, ... }` opcionalmente com `{ rank, reason, bucket }`.
 *
 * O helper `highlightUrl()` abstrai a leitura. Antes do #1445, o código fazia
 * cast `as { url?: unknown; article?: { url?: unknown } }` pra evitar mismatch
 * — agora o tipo declara ambos os formatos como possíveis e o helper é
 * type-safe.
 */
export interface ScoredHighlight {
  rank?: number;
  score?: number;
  bucket?: string;
  reason?: string;
  /** Nested shape (scorer output): article carrega url e metadata. */
  article?: StageArticle;
  /** Flat shape (legacy/tests): url no topo. */
  url?: string;
  title?: string;
  [key: string]: unknown;
}

/**
 * Runner-up no Stage 2 (#1445). Schema similar a ScoredHighlight mas sem
 * `rank` obrigatório (runners-up são scored mas não ranqueados oficialmente).
 */
export interface ScoredRunnerUp {
  score?: number;
  reason?: string;
  bucket?: string;
  article?: StageArticle;
  url?: string;
  title?: string;
  [key: string]: unknown;
}

/**
 * Pure (#1445): lê a URL de um highlight ou runner-up, abstraindo o shape.
 * Prefere `article.url` (nested, formato canônico do scorer); fallback pra
 * `url` no topo (flat, formato legado).
 */
export function highlightUrl(h: ScoredHighlight | ScoredRunnerUp): string | undefined {
  if (h.article && typeof h.article.url === "string") return h.article.url;
  if (typeof h.url === "string") return h.url;
  return undefined;
}

export interface ApprovedJson {
  highlights?: ScoredHighlight[];
  runners_up?: ScoredRunnerUp[];
  lancamento?: StageArticle[];
  // #1629: buckets renomeados (pesquisa+noticias→radar, tutorial→use_melhor)
  radar?: StageArticle[];
  use_melhor?: StageArticle[];
  video?: StageArticle[];
  coverage?: unknown;
  [key: string]: unknown;
}

/**
 * Caps fixos definidos em #358 / #1629. Radar é função.
 */
export const STAGE_2_CAP_LANCAMENTOS = 5;
export const STAGE_2_TARGET_TOTAL = 12;
export const STAGE_2_MIN_RADAR = 5;
/**
 * VÍDEOS: máximo 2 por edição (#1693, editorial-rules.md:100). Cap fixo e
 * independente do alvo de 12 (VÍDEOS é seção opcional fora da soma
 * destaques+lançamentos+radar). USE MELHOR NÃO tem cap máximo documentado —
 * só mínimo 3 candidatos no pipeline (editorial-rules.md:143) e é curado
 * manualmente pelo editor (:175) — por isso não é validado aqui.
 */
export const STAGE_2_CAP_VIDEO = 2;

/**
 * Cap pra Radar dado contagem dos outros buckets já capados (#1629).
 *
 *   max(5, 12 - destaques - lançamentos)
 *
 * Antes da fusão (#1629), Pesquisas tinha cap 3 e Outras Notícias tinha
 * max(2, 12-d-l-p). Soma equivalente após fusão dá 5 mínimo.
 *
 * Exemplos:
 *   - dest=3, lanç=5 → max(5, 4) = 5
 *   - dest=3, lanç=2 → max(5, 7) = 7
 *   - dest=3, lanç=0 → max(5, 9) = 9
 */
export function capRadar(
  destaques: number,
  lancamentos: number,
): number {
  return Math.max(
    STAGE_2_MIN_RADAR,
    STAGE_2_TARGET_TOTAL - destaques - lancamentos,
  );
}

export interface CapReport {
  before: { lancamento: number; radar: number };
  after: { lancamento: number; radar: number };
  caps: { lancamento: number; radar: number };
  truncated: { lancamento: number; radar: number };
  /** #1240: artigos removidos de cada bucket por já estarem em highlights[]. */
  removed_overlap: { lancamento: number; radar: number };
}

/**
 * #1240: remove de `bucket` todos artigos cuja URL canonicalizada bate
 * com alguma URL em `highlightUrlsCanon`. Retorna { kept, removed }.
 */
function dedupAgainstHighlights(
  bucket: StageArticle[] | undefined,
  highlightUrlsCanon: Set<string>,
): { kept: StageArticle[]; removed: number } {
  if (!bucket || bucket.length === 0) return { kept: [], removed: 0 };
  if (highlightUrlsCanon.size === 0) return { kept: [...bucket], removed: 0 };
  const kept: StageArticle[] = [];
  let removed = 0;
  for (const a of bucket) {
    const url = typeof a.url === "string" ? a.url : "";
    if (url && highlightUrlsCanon.has(canonicalize(url))) {
      removed++;
      continue;
    }
    kept.push(a);
  }
  return { kept, removed };
}

/**
 * Aplica caps de Stage 2 no JSON approved. **Não muta** o input — devolve
 * cópia com buckets truncados.
 *
 * Estratégia de truncate: preserva ordem original (assumida ser por score
 * descendente — o gate Stage 1 já rankeou). Trunca via `slice(0, cap)`.
 *
 * Highlights, runners_up, tutorial, video, coverage: preservados intactos.
 */
export function applyStage2Caps(
  approved: ApprovedJson,
): { approved: ApprovedJson; report: CapReport } {
  const dest = approved.highlights?.length ?? 0;
  const lOriginal = approved.lancamento?.length ?? 0;
  const rOriginal = approved.radar?.length ?? 0;

  // #1240: build set de URLs já em highlights (canonicalizadas) pra
  // remover overlap dos buckets ANTES de truncar.
  const highlightUrlsCanon = new Set<string>();
  for (const h of approved.highlights ?? []) {
    const url = highlightUrl(h);
    if (url) highlightUrlsCanon.add(canonicalize(url));
  }

  if ((approved.highlights?.length ?? 0) > 0 && highlightUrlsCanon.size === 0) {
    console.warn(
      "[apply-stage2-caps] WARN: highlights presentes mas nenhuma URL extraída — " +
        "shape mudou? Esperado `article.url` (nested) ou `url` (flat).",
    );
  }
  const lDeduped = dedupAgainstHighlights(approved.lancamento, highlightUrlsCanon);
  const rDeduped = dedupAgainstHighlights(approved.radar, highlightUrlsCanon);

  const lCap = STAGE_2_CAP_LANCAMENTOS;
  const lFinal = Math.min(lDeduped.kept.length, lCap);
  const rCap = capRadar(dest, lFinal);
  const rFinal = Math.min(rDeduped.kept.length, rCap);

  const out: ApprovedJson = {
    ...approved,
    lancamento: lDeduped.kept.slice(0, lFinal),
    radar: rDeduped.kept.slice(0, rFinal),
  };

  return {
    approved: out,
    report: {
      before: {
        lancamento: lOriginal,
        radar: rOriginal,
      },
      after: {
        lancamento: lFinal,
        radar: rFinal,
      },
      caps: { lancamento: lCap, radar: rCap },
      truncated: {
        lancamento: lDeduped.kept.length - lFinal,
        radar: rDeduped.kept.length - rFinal,
      },
      removed_overlap: {
        lancamento: lDeduped.removed,
        radar: rDeduped.removed,
      },
    },
  };
}

/**
 * Pure: dado um approved JSON, retorna se algum bucket está acima do cap.
 * Útil pra validators pós-writer (lint section-counts).
 */
export function checkStage2Caps(
  approved: ApprovedJson,
): {
  ok: boolean;
  violations: string[];
  expectedCaps: { lancamento: number; radar: number; video: number };
} {
  const dest = approved.highlights?.length ?? 0;
  const lCap = STAGE_2_CAP_LANCAMENTOS;
  const lCount = approved.lancamento?.length ?? 0;
  const rCap = capRadar(dest, Math.min(lCount, lCap));
  const rCount = approved.radar?.length ?? 0;
  // #1693: VÍDEOS ≤ 2 (cap documentado). USE MELHOR não tem cap máximo → não valida.
  const vCap = STAGE_2_CAP_VIDEO;
  const vCount = approved.video?.length ?? 0;

  const violations: string[] = [];
  if (lCount > lCap) violations.push(`LANÇAMENTOS: ${lCount} > cap ${lCap}`);
  if (rCount > rCap) violations.push(`RADAR: ${rCount} > cap ${rCap}`);
  if (vCount > vCap) violations.push(`VÍDEOS: ${vCount} > cap ${vCap}`);
  return {
    ok: violations.length === 0,
    violations,
    expectedCaps: { lancamento: lCap, radar: rCap, video: vCap },
  };
}
