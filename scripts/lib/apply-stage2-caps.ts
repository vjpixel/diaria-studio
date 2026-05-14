/**
 * apply-stage2-caps.ts (#358, #907, #1240)
 *
 * Helper puro pra aplicar os caps editoriais de Stage 2 no `01-approved.json`
 * antes de passar pro writer agent. Caps definidos em #358:
 *
 *   | Bucket          | Cap                                                       |
 *   |-----------------|-----------------------------------------------------------|
 *   | Destaques       | sem corte (sempre 3 após gate Stage 1)                    |
 *   | Lançamentos     | ≤ 5                                                       |
 *   | Pesquisas       | ≤ 3                                                       |
 *   | Outras Notícias | max(2, 12 − destaques − lançamentos_final − pesquisas)    |
 *
 * Composição alvo: 12 artigos editoriais por edição (3 destaques + 5
 * lançamentos + 3 pesquisas + 4 outras = 15 worst case; mais comum
 * 3+2+3+4 = 12 quando nem todos os buckets têm cap cheio).
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

export interface ApprovedJson {
  highlights?: StageArticle[];
  runners_up?: StageArticle[];
  lancamento?: StageArticle[];
  pesquisa?: StageArticle[];
  noticias?: StageArticle[];
  tutorial?: StageArticle[];
  video?: StageArticle[];
  coverage?: unknown;
  [key: string]: unknown;
}

/**
 * Caps fixos definidos em #358. Outras notícias é função.
 */
export const STAGE_2_CAP_LANCAMENTOS = 5;
export const STAGE_2_CAP_PESQUISAS = 3;
export const STAGE_2_TARGET_TOTAL = 12;
export const STAGE_2_MIN_OUTRAS = 2;

/**
 * Cap pra Outras Notícias dado contagem dos outros buckets já capados.
 *
 *   max(2, 12 - destaques - lançamentos - pesquisas)
 *
 * Exemplos:
 *   - dest=3, lanç=5, pesq=3 → max(2, 1) = 2
 *   - dest=3, lanç=2, pesq=3 → max(2, 4) = 4
 *   - dest=3, lanç=0, pesq=0 → max(2, 9) = 9
 */
export function capOutrasNoticias(
  destaques: number,
  lancamentos: number,
  pesquisas: number,
): number {
  return Math.max(
    STAGE_2_MIN_OUTRAS,
    STAGE_2_TARGET_TOTAL - destaques - lancamentos - pesquisas,
  );
}

/**
 * Pure (#1071): conta quantos highlights vêm de um bucket específico.
 * Highlights podem ser promovidos de qualquer bucket pelo scorer; saber
 * quantos vieram de "noticias" permite o cap ajustar pra compensar.
 *
 * Aceita shape com `bucket` direto (legacy) ou `article.bucket` (caso
 * scorer aninhar). Retorna 0 quando bucket ausente.
 */
export function destaquesFromBucket(
  highlights: StageArticle[] | undefined,
  bucket: string,
): number {
  if (!highlights) return 0;
  return highlights.filter((h) => {
    const b = (h as { bucket?: string }).bucket
      ?? ((h as { article?: { bucket?: string } }).article?.bucket);
    return b === bucket;
  }).length;
}

export interface CapReport {
  before: { lancamento: number; pesquisa: number; noticias: number };
  after: { lancamento: number; pesquisa: number; noticias: number };
  caps: { lancamento: number; pesquisa: number; noticias: number };
  truncated: { lancamento: number; pesquisa: number; noticias: number };
  /** #1240: artigos removidos de cada bucket por já estarem em highlights[]. */
  removed_overlap: { lancamento: number; pesquisa: number; noticias: number };
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
  const pOriginal = approved.pesquisa?.length ?? 0;
  const nOriginal = approved.noticias?.length ?? 0;

  // #1240: build set de URLs já em highlights (canonicalizadas) pra
  // remover overlap dos buckets ANTES de truncar.
  const highlightUrlsCanon = new Set<string>();
  for (const h of approved.highlights ?? []) {
    const url = typeof h.url === "string" ? h.url : "";
    if (url) highlightUrlsCanon.add(canonicalize(url));
  }
  const lDeduped = dedupAgainstHighlights(approved.lancamento, highlightUrlsCanon);
  const pDeduped = dedupAgainstHighlights(approved.pesquisa, highlightUrlsCanon);
  const nDeduped = dedupAgainstHighlights(approved.noticias, highlightUrlsCanon);

  const lCap = STAGE_2_CAP_LANCAMENTOS;
  const pCap = STAGE_2_CAP_PESQUISAS;
  const lFinal = Math.min(lDeduped.kept.length, lCap);
  const pFinal = Math.min(pDeduped.kept.length, pCap);
  // #1240: com dedup contra highlights aplicado antes do cap, não precisa mais
  // do `+ destFromNoticias` (#1071) — não há duplicatas pro writer dropar.
  const nCap = capOutrasNoticias(dest, lFinal, pFinal);
  const nFinal = Math.min(nDeduped.kept.length, nCap);

  const out: ApprovedJson = {
    ...approved,
    lancamento: lDeduped.kept.slice(0, lFinal),
    pesquisa: pDeduped.kept.slice(0, pFinal),
    noticias: nDeduped.kept.slice(0, nFinal),
  };

  return {
    approved: out,
    report: {
      before: {
        lancamento: lOriginal,
        pesquisa: pOriginal,
        noticias: nOriginal,
      },
      after: {
        lancamento: lFinal,
        pesquisa: pFinal,
        noticias: nFinal,
      },
      caps: { lancamento: lCap, pesquisa: pCap, noticias: nCap },
      truncated: {
        lancamento: lDeduped.kept.length - lFinal,
        pesquisa: pDeduped.kept.length - pFinal,
        noticias: nDeduped.kept.length - nFinal,
      },
      removed_overlap: {
        lancamento: lDeduped.removed,
        pesquisa: pDeduped.removed,
        noticias: nDeduped.removed,
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
): { ok: boolean; violations: string[]; expectedCaps: { lancamento: number; pesquisa: number; noticias: number } } {
  const dest = approved.highlights?.length ?? 0;
  const lCap = STAGE_2_CAP_LANCAMENTOS;
  const pCap = STAGE_2_CAP_PESQUISAS;
  const lCount = approved.lancamento?.length ?? 0;
  const pCount = approved.pesquisa?.length ?? 0;
  // Outras: cap usa contagens REAIS (capadas) dos outros buckets.
  // #1240: com dedup contra highlights aplicado em applyStage2Caps, cap não
  // precisa mais inflar pra compensar (#1071) — writer nunca vê duplicatas.
  const nCap = capOutrasNoticias(dest, Math.min(lCount, lCap), Math.min(pCount, pCap));
  const nCount = approved.noticias?.length ?? 0;

  const violations: string[] = [];
  if (lCount > lCap) violations.push(`LANÇAMENTOS: ${lCount} > cap ${lCap}`);
  if (pCount > pCap) violations.push(`PESQUISAS: ${pCount} > cap ${pCap}`);
  if (nCount > nCap) violations.push(`OUTRAS NOTÍCIAS: ${nCount} > cap ${nCap}`);
  return {
    ok: violations.length === 0,
    violations,
    expectedCaps: { lancamento: lCap, pesquisa: pCap, noticias: nCap },
  };
}
