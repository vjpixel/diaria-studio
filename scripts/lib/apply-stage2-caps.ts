/**
 * apply-stage2-caps.ts (#358, #907)
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
 */

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

export interface CapReport {
  before: { lancamento: number; pesquisa: number; noticias: number };
  after: { lancamento: number; pesquisa: number; noticias: number };
  caps: { lancamento: number; pesquisa: number; noticias: number };
  truncated: { lancamento: number; pesquisa: number; noticias: number };
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

  const lCap = STAGE_2_CAP_LANCAMENTOS;
  const pCap = STAGE_2_CAP_PESQUISAS;
  const lFinal = Math.min(lOriginal, lCap);
  const pFinal = Math.min(pOriginal, pCap);
  const nCap = capOutrasNoticias(dest, lFinal, pFinal);
  const nFinal = Math.min(nOriginal, nCap);

  const out: ApprovedJson = {
    ...approved,
    lancamento: (approved.lancamento ?? []).slice(0, lFinal),
    pesquisa: (approved.pesquisa ?? []).slice(0, pFinal),
    noticias: (approved.noticias ?? []).slice(0, nFinal),
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
        lancamento: lOriginal - lFinal,
        pesquisa: pOriginal - pFinal,
        noticias: nOriginal - nFinal,
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
  // Outras: cap usa contagens REAIS (capadas) dos outros buckets
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
