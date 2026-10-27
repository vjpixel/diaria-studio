/**
 * card-title-wrap.ts (#11329, item 4)
 *
 * Quebra do título no card 4x5 (`04-d{N}-4x5.jpg`) e o critério "o título do
 * destaque cabe no card" (`dailyCardTitleFits`), sem `sharp` nem I/O. Saiu de
 * `gen-social-card-4x5.ts` porque o lint de título (`lint-checks/title-limits.ts`,
 * #11254) e o painel de revisão do Studio importavam o gerador inteiro só por
 * esta função, e com ele o `sharp`. O gerador importa daqui e re-exporta,
 * então o critério continua sendo um só: o que o lint aprova, o gerador aceita.
 *
 * @pure
 */

import { DAILY_CAROUSEL_BODY_SIZE } from "./daily-carousel-body-size.ts";

/** Largura do card 4x5 (px). Fonte única: `gen-social-card-4x5.ts` importa daqui. */
export const CARD_4X5_WIDTH = 1080;
/** Margem lateral do card 4x5 (px). Fonte única: `gen-social-card-4x5.ts` importa daqui. */
export const CARD_4X5_PAD = 72;

/**
 * Quebra o título em linhas que caibam na largura útil. Estimativa por
 * caractere (0.52 * font-size) — mesma heurística de largura usada nos outros
 * geradores de card do repo; sem medição real de glifo, o clamp de font-size
 * abaixo é o que garante que não estoura.
 *
 * Wrap guloso (empurra o máximo de palavras pra 1ª linha) só decide QUANTAS
 * linhas o título precisa — esse é o mínimo possível (greedy first-fit é
 * ótimo em contagem de linhas, prova por troca). A partir daí,
 * `balanceLines` (#4575) busca, entre todas as formas de distribuir as MESMAS
 * palavras nesse mesmo número de linhas, a que deixa as linhas mais parecidas
 * em comprimento — corrige o caso clássico do wrap guloso (1ª linha quase
 * cheia, última com uma palavra órfã).
 */
export function wrapTitle(title: string, maxCharsPerLine: number): string[] {
  const words = title.split(/\s+/).filter(Boolean);
  const greedy = greedyWrapLines(words, maxCharsPerLine);
  if (greedy.length < 2) return greedy;
  return balanceLines(words, maxCharsPerLine, greedy.length) ?? greedy;
}

function greedyWrapLines(words: string[], maxCharsPerLine: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const candidate = cur ? `${cur} ${w}` : w;
    if (candidate.length > maxCharsPerLine && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = candidate;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Uma palavra sozinha nunca é cortada/descartada, mesmo estourando o limite — mesma regra do wrap guloso. */
function isValidSegment(wordCount: number, segmentLen: number, maxCharsPerLine: number): boolean {
  return wordCount === 1 || segmentLen <= maxCharsPerLine;
}

/** [maior-menor, soma dos quadrados da folga em relação à média] — comparado lexicograficamente (menor é melhor). */
function balanceCost(lines: string[]): [number, number] {
  const lens = lines.map((l) => l.length);
  const max = Math.max(...lens);
  const min = Math.min(...lens);
  const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
  const sumSq = lens.reduce((a, l) => a + (l - mean) ** 2, 0);
  return [max - min, sumSq];
}

function costLess(a: [number, number], b: [number, number]): boolean {
  return a[0] !== b[0] ? a[0] < b[0] : a[1] < b[1];
}

/**
 * Busca, por força bruta, a distribuição das `words` em exatamente `lineCount`
 * linhas contíguas que minimiza `balanceCost` — sem nunca violar
 * `maxCharsPerLine` (exceto o caso degenerado de palavra única maior que o
 * limite, que `isValidSegment` permite). Viável porque `lineCount` e o número
 * de palavras são pequenos com títulos editoriais (o título do destaque cabe
 * em até 3 linhas do card, `dailyCardTitleFits`, e o do D1 tem ≤70 chars,
 * #11254); o guard de `words.length` é só defensivo pra input fora desse
 * regime.
 *
 * O espaço de busca sempre contém a própria partição gulosa (ela é composta
 * só de segmentos válidos por construção), então o resultado nunca é pior que
 * o guloso — na pior das hipóteses, empata.
 */
function balanceLines(words: string[], maxCharsPerLine: number, lineCount: number): string[] | null {
  if (lineCount < 2 || words.length < lineCount) return null;
  // Guard defensivo: título editorial cabe em até 3 linhas do card (~10-15
  // palavras em português, #11254); 24 dá margem generosa mantendo o pior caso da busca na casa
  // de poucos ms mesmo com palavras curtas adversariais (medido: ~8ms com 28
  // palavras curtas vs. ~550ms com 40 — a busca cresce combinatorialmente com
  // o nº de palavras). Acima do guard, cai pro resultado guloso sem tentar
  // balancear.
  if (words.length > 24) return null;

  let best: string[] | null = null;
  let bestCost: [number, number] | null = null;

  const segmentStr = (start: number, end: number): string => words.slice(start, end).join(" ");

  function search(startIdx: number, linesLeft: number, acc: string[]): void {
    if (linesLeft === 1) {
      const wordsLeft = words.length - startIdx;
      if (wordsLeft < 1) return;
      const seg = segmentStr(startIdx, words.length);
      if (!isValidSegment(wordsLeft, seg.length, maxCharsPerLine)) return;
      const lines = [...acc, seg];
      const cost = balanceCost(lines);
      if (!bestCost || costLess(cost, bestCost)) {
        bestCost = cost;
        best = lines;
      }
      return;
    }
    // Precisa sobrar ao menos 1 palavra por linha restante.
    const maxLen = words.length - startIdx - (linesLeft - 1);
    for (let len = 1; len <= maxLen; len++) {
      const seg = segmentStr(startIdx, startIdx + len);
      if (isValidSegment(len, seg.length, maxCharsPerLine)) {
        search(startIdx + len, linesLeft - 1, [...acc, seg]);
      } else if (len >= 2) {
        // Comprimento só cresce com `len` — uma vez estourado (segmento com
        // 2+ palavras), qualquer `len` maior também estoura. Corta a busca.
        break;
      }
    }
  }

  search(0, lineCount, []);
  return best;
}

/**
 * Constantes de largura média de glifo pro título do overlay — CALIBRADAS
 * PRO PESO 700 (bold, achado ao vivo 260914: ver comentário de
 * `font-weight="700"` em `buildOverlaySvg`). Bold renderiza ~12% mais largo
 * que regular no Georgia; usar o divisor/multiplicador de regular (26 /
 * 0.52) aqui subestimava a largura real e deixava título de 1 linha vazar
 * pra fora do card (edição 260915, D3: "Freelancers que usam IA ganham
 * mais" wrapado em 1 linha por caber nos 26px/char de regular, mas
 * estourando em bold). Únicas 2 constantes que `overlayFittingFontSize` e
 * `buildOverlaySvg` usam pra wrap/tamanho — mantidas em sync aqui de
 * propósito, mesma lição do #5330 (não duplicar em cópia separada).
 */
export const OVERLAY_CHARS_PER_LINE_DIVISOR = 29;
export const OVERLAY_WIDTH_FIT_RATIO = 0.58;

/**
 * Parâmetros do carrossel SEMANAL (#8480): quebra mais cedo e razão de largura
 * mais conservadora, porque o rasterizador cai numa serif mais larga que Georgia
 * quando ela não está instalada e título longo cortava a 62px (achado 260919).
 * Só o semanal passa isto; o card diário segue nas constantes acima.
 */
export const WEEKLY_OVERLAY_WRAP = { divisor: 41, ratio: 0.66 } as const;
export type OverlayWrap = { readonly divisor: number; readonly ratio: number };

/**
 * Quebra de título do overlay (#8589). Card semanal (`wrap` explícito): inalterado.
 * Card diário: a regra de quebra (divisor 29, ~33 chars) deixa passar título de
 * 1 linha que estoura a largura no piso de 62px (~26 chars). Se a quebra normal
 * estoura, tenta o limite que cabe a 62px (balanceando em até 3 linhas); se nem
 * assim cabe, retorna `fits: false` (política #6078: reescrever, nunca cortar).
 */
export function overlayWrapLines(
  title: string,
  availableWidth: number,
  wrap?: OverlayWrap,
): { lines: string[]; fits: boolean } {
  const w = wrap ?? { divisor: OVERLAY_CHARS_PER_LINE_DIVISOR, ratio: OVERLAY_WIDTH_FIT_RATIO };
  const lines = wrapTitle(title, Math.floor(availableWidth / w.divisor));
  if (wrap) return { lines, fits: true };
  const fitsAt = (ls: string[]) => ls.every((l) => l.length * DAILY_CAROUSEL_BODY_SIZE * w.ratio <= availableWidth);
  if (fitsAt(lines)) return { lines, fits: true };
  const tight = wrapTitle(title, Math.floor(availableWidth / (DAILY_CAROUSEL_BODY_SIZE * w.ratio)));
  return tight.length <= 3 && fitsAt(tight) ? { lines: tight, fits: true } : { lines, fits: false };
}

/**
 * Pure (#11254): o título do destaque cabe no card 4x5 DIÁRIO (`04-d{N}-4x5.jpg`)
 * — largura útil `CARD_4X5_WIDTH - 2*CARD_4X5_PAD`, piso de `DAILY_CAROUSEL_BODY_SIZE` (62px), até 3
 * linhas. Fonte ÚNICA do critério: o `main()` de `gen-social-card-4x5.ts` aborta com ele
 * antes de renderizar, e o lint `title-card-4x5` (`lint-checks/title-limits.ts`)
 * reprova o mesmo título já no Stage 2, antes de existir imagem.
 */
export function dailyCardTitleFits(title: string): boolean {
  return overlayWrapLines(title, CARD_4X5_WIDTH - CARD_4X5_PAD * 2).fits;
}
