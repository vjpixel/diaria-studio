/**
 * newsletter-capture-yield.ts (#9368)
 *
 * Guard "newsletters capturadas > 0 e artigos gravados = 0". Em 260921 o
 * Stage 0 capturou 11 threads de newsletter e o
 * `captured-newsletter-articles.json` da edição ficou `[]` — todas já
 * estavam marcadas no cursor global por uma execução anterior. O sinal
 * existia nos dois arquivos do `_internal/` mas ninguém o comparava, então a
 * edição inteira saiu sem nenhum link de newsletter sem aviso.
 *
 * Usado por `stage-0-run.ts` (0b-bis, logo após `capture-newsletter-urls.ts`)
 * e por `stage-1-run.ts` (§1h, linha no relatório do Stage 1). Sempre
 * `error` no run-log — nunca warning silencioso.
 *
 * Pura: recebe o conteúdo bruto dos dois arquivos (ou `null` se ausentes).
 */

export interface CaptureYield {
  /** Nº de threads em `captured-newsletters.json` (null = ausente/ilegível). */
  threads: number | null;
  /** Nº de artigos em `captured-newsletter-articles.json` (null = ausente/ilegível). */
  articles: number | null;
  /** true quando há threads capturadas e nenhum artigo gravado. */
  empty: boolean;
}

function countArray(raw: string | null, counts?: (entry: { sender?: string }) => boolean): number | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return counts ? parsed.filter((e) => e && typeof e === "object" && counts(e)).length : parsed.length;
  } catch {
    return null;
  }
}

/**
 * `countsThread` (#12188): só conta as threads que podiam gerar artigo — as de
 * remetente aprovado. Thread de sender só do config (não aprovado) é filtrada
 * pela captura por decisão, e contá-la daria falso "0 artigos".
 */
export function evaluateCaptureYield(
  threadsRaw: string | null,
  articlesRaw: string | null,
  countsThread?: (thread: { sender?: string }) => boolean,
): CaptureYield {
  const threads = countArray(threadsRaw, countsThread);
  const articles = countArray(articlesRaw);
  // Artigos ausentes/ilegíveis com threads > 0 também é "zero gravado".
  const empty = (threads ?? 0) > 0 && (articles ?? 0) === 0;
  return { threads, articles, empty };
}

export const CAPTURE_EMPTY_MESSAGE =
  "newsletters capturadas mas 0 artigos gravados em captured-newsletter-articles.json — a edição fica sem links de newsletter (#9368)";
