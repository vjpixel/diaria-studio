/**
 * arxiv-id.ts (#717 hypothesis #4)
 *
 * Parser determinístico de URLs do arXiv. Extrai o YYMM do paper ID — sem
 * precisar fetchar a página, dá pra saber o mês de submissão da versão 1.
 *
 * Usado por `verify-dates.ts` pra skipar fetches de papers cuja data é
 * claramente fora da janela editorial. arxiv RSS retorna ~200 papers/dia,
 * `verify-dates` corrigia data de ~216 mas ~202 caíam fora da janela depois
 * (#717 mediu 260506). Skipar essas é ~3min de fetch evitado por edição.
 *
 * Formato moderno (2007+): `arxiv.org/abs/YYMM.NNNNN[vN]`
 * Exemplo: `arxiv.org/abs/2603.15988v2` → year=26, month=3, id=2603.15988
 *
 * Formato antigo (<2007, ex: `cs/0610068`) NÃO é coberto — pipeline editorial
 * só lida com papers recentes, então fora do escopo.
 */

const ARXIV_HOST_RE = /^(?:www\.)?arxiv\.org$/i;
// Path: /abs/YYMM.NNNNN, /pdf/YYMM.NNNNN, /html/YYMM.NNNNN, com optional vN.
// .pdf extension trailing também aceito (alguns links usam /pdf/2603.15988.pdf).
const ARXIV_ID_PATH_RE = /^\/(?:abs|pdf|html)\/(\d{4})\.(\d{4,5})(?:v(\d+))?(?:\.pdf)?$/i;

export interface ArxivId {
  /** Year as 2-digit number (07-99). 26 = 2026, 99 = 1999/2099 (ambiguous, see note). */
  year: number;
  /** Month 1-12. */
  month: number;
  /** Full ID as string (`YYMM.NNNNN`), no version suffix. */
  id: string;
  /** Version suffix if present in the URL, otherwise null. */
  version: number | null;
}

/**
 * Parse uma URL arXiv. Retorna null se não for arXiv ou se o path não bate
 * no formato moderno.
 *
 * Ambiguidade YY → YYYY: 2007-2024 vs 2107-2124. Resolvida assumindo
 * 2000-2099. Pra arXiv real isso vai estar correto até 2099.
 */
export function parseArxivId(url: string): ArxivId | null {
  if (typeof url !== "string" || url.length === 0) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (!ARXIV_HOST_RE.test(parsed.hostname)) return null;

  const m = ARXIV_ID_PATH_RE.exec(parsed.pathname);
  if (!m) return null;

  const yymm = m[1];
  const numId = m[2];
  const version = m[3] ? parseInt(m[3], 10) : null;

  const year = parseInt(yymm.slice(0, 2), 10);
  const month = parseInt(yymm.slice(2, 4), 10);

  // Validação básica: month 1-12. arXiv nunca emitiu mês inválido mas
  // defensive caso URL malformada bata no regex.
  if (month < 1 || month > 12) return null;

  return {
    year,
    month,
    id: `${yymm}.${numId}`,
    version,
  };
}

/**
 * Converte YY de 2 dígitos pro ano completo. Assume 2000-2099 (arXiv moderno
 * começou em 2007, então YY=00..06 não existem em prática).
 */
export function expandYear(yy: number): number {
  return 2000 + yy;
}

/**
 * Devolve a data sentinel pra um arxiv ID (primeiro dia do mês indicado pelo
 * ID). Usado quando precisamos de uma data ISO mas só temos precisão de mês.
 *
 * Convenção: YYYY-MM-15 (meio do mês) — escolha que não favorece nem o início
 * nem o fim da janela editorial. Pra cutoff filter funciona pra qualquer
 * janela que não seja o próprio mês do paper.
 */
export function arxivIdSentinelDate(arxiv: ArxivId): string {
  const year = expandYear(arxiv.year);
  const mm = arxiv.month.toString().padStart(2, "0");
  return `${year}-${mm}-15`;
}

/**
 * Decide se o paper arxiv é "claramente fora da janela" — i.e., o mês de
 * submissão é estritamente anterior ao mês do `cutoffIso` por uma margem de
 * `marginMonths` (default 1).
 *
 * Conservador: só retorna true quando temos certeza. Casos borderline
 * (papers no mesmo mês ou mês adjacente do cutoff) retornam false → caller
 * deve fetchar pra pegar precisão de dia.
 *
 * @param arxiv  Resultado de parseArxivId
 * @param cutoffIso  Data ISO (YYYY-MM-DD) — papers anteriores ao mês desta data
 *                   são candidatos a skip
 * @param marginMonths  Quantos meses antes do cutoff também consideramos "borderline"
 *                      (default 1). Subir o margin = menos skips, mais precisão.
 */
export function isClearlyBeforeCutoff(
  arxiv: ArxivId,
  cutoffIso: string,
  marginMonths = 1,
): boolean {
  const cutoffMatch = /^(\d{4})-(\d{2})-/.exec(cutoffIso);
  if (!cutoffMatch) return false;
  const cutoffYear = parseInt(cutoffMatch[1], 10);
  const cutoffMonth = parseInt(cutoffMatch[2], 10);
  const arxivYear = expandYear(arxiv.year);

  // Compara em "meses absolutos" pra lidar com viradas de ano.
  const arxivAbs = arxivYear * 12 + arxiv.month;
  const cutoffAbs = cutoffYear * 12 + cutoffMonth;

  return arxivAbs < cutoffAbs - marginMonths;
}
