/**
 * lint-checks/destaque-title-walk.ts (#2693 item 1)
 *
 * Parser compartilhado para percorrer um bloco DESTAQUE e coletar as linhas
 * candidatas a título, extraído para eliminar a duplicação entre
 * `countTitlesPerHighlight` (titles-per-highlight.ts) e `extractAllTitles`
 * (title-normalization.ts) — os dois andavam com lógica de "walk + break"
 * quase idêntica, mantida sincronizada só por comentário ("mesmo critério
 * do parseDestaques").
 *
 * `title-length.ts` continua com parser PRÓPRIO (não migrado aqui) — ele é
 * deliberadamente mais permissivo (não usa `looksLikeTitleOption`, não
 * quebra a coleta ao encontrar corpo, só pula linhas óbvias de corpo) porque
 * precisa capturar títulos malformados de 60+ chars que `looksLikeTitleOption`
 * rejeitaria como corpo. Ver docstring de `title-length.ts`.
 *
 * Contrato: dado o índice da linha de header (`HIGHLIGHT_HEADER_RE` já
 * validado pelo chamador) e a `category` extraída do header, percorre as
 * linhas seguintes até o primeiro terminator:
 *   - linha de URL (`URL_LINE_RE`)
 *   - "Por que isso importa:" (`WHY_MATTERS_LINE_RE`)
 *   - próximo header DESTAQUE (`HIGHLIGHT_HEADER_RE`)
 *   - section break `---` (`SECTION_BREAK_LINE_RE`)
 *   - header de seção secundária que NÃO seja a própria categoria
 *     (`SECTION_HEADER_LINE_RE && t !== category`)
 *   - (só quando `isTitleCandidate` é fornecido) linha plain-text que não
 *     parece título — encerra a coleta em vez de virar título.
 *
 * ## Decisão consciente (#2778): `t !== category` também vale para `extractAllTitles`
 *
 * Este guard existia SÓ em `countTitlesPerHighlight` (titles-per-highlight.ts)
 * antes do #2693 consolidar os dois walkers aqui. `extractAllTitles`
 * (title-normalization.ts) tinha sua própria cópia do walk sem essa exceção —
 * a consolidação em #2693 fez `extractAllTitles` herdar o guard como efeito
 * colateral da extração, não como decisão deliberada.
 *
 * Avaliado no #2778: manter a exceção em `extractAllTitles` é o comportamento
 * CORRETO, e a decisão é ficar assim. Motivo: sem o guard, uma linha de corpo
 * que por acaso repete o nome da categoria do destaque (ex: destaque
 * categorizado como "LANÇAMENTOS" com uma linha solta "LANÇAMENTOS" no corpo,
 * antes do terminador real — URL ou "Por que isso importa:") seria
 * erroneamente tratada como header de seção secundária e encerraria a coleta
 * PREMATURAMENTE. Isso faria `extractAllTitles` (e por extensão
 * `checkTitlePublisherSuffix`/`checkTitleTrailingPeriod`) parar de enxergar
 * qualquer título real que viesse DEPOIS dessa linha solta — um falso-negativo
 * silencioso nos lints de título (#2664/#2672). Ver regressão em
 * `test/title-normalization.test.ts` ("category do destaque == seção
 * secundária real").
 *
 * Cada linha não-vazia que não bate nenhum terminator vira um título:
 *   - inline link (`[título](url)`) → título = texto do link.
 *   - plain-text (formato legado) → título = linha inteira, só se
 *     `isTitleCandidate(linha)` retornar true (quando fornecido).
 */

import { parseInlineLink } from "../inline-link.ts";
import {
  HIGHLIGHT_HEADER_RE,
  URL_LINE_RE,
  SECTION_BREAK_LINE_RE,
  SECTION_HEADER_LINE_RE,
  WHY_MATTERS_LINE_RE,
} from "./highlight-parsing.ts";

export interface DestaqueTitleLine {
  /** Título extraído (texto do inline link, ou a linha plain-text inteira). */
  title: string;
  /** Número de linha no markdown original (1-based). */
  line: number;
}

export interface DestaqueTitleWalkResult {
  titles: DestaqueTitleLine[];
  /** Índice (0-based, em `lines`) da linha que terminou a coleta — o chamador retoma daqui. */
  nextIndex: number;
}

/**
 * Percorre o corpo de um bloco DESTAQUE a partir de `startIndex` (a linha
 * IMEDIATAMENTE após o header) e coleta títulos.
 *
 * @param lines - Todas as linhas do markdown (já split por "\n").
 * @param startIndex - Índice (0-based) da 1ª linha após o header DESTAQUE.
 * @param category - Categoria extraída do header (grupo 2 de `HIGHLIGHT_HEADER_RE`),
 *   usada para não quebrar a coleta caso uma linha de corpo repita o texto da categoria.
 * @param isTitleCandidate - Filtro para linhas plain-text (formato legado, sem
 *   inline link): retorna `false` para encerrar a coleta (linha de corpo).
 *   Inline links NUNCA passam por este filtro (sempre viram título).
 */
export function walkDestaqueTitles(
  lines: string[],
  startIndex: number,
  category: string,
  isTitleCandidate: (line: string) => boolean,
): DestaqueTitleWalkResult {
  const titles: DestaqueTitleLine[] = [];
  let j = startIndex;
  while (j < lines.length) {
    const t = lines[j].trim();
    if (t === "") {
      j++;
      continue;
    }
    // Inline link — sempre título, sem passar por isTitleCandidate.
    const inline = parseInlineLink(t);
    if (inline) {
      titles.push({ title: inline.title, line: j + 1 });
      j++;
      continue;
    }
    if (URL_LINE_RE.test(t)) break;
    if (WHY_MATTERS_LINE_RE.test(t)) break;
    if (HIGHLIGHT_HEADER_RE.test(t)) break;
    if (SECTION_BREAK_LINE_RE.test(t)) break;
    if (SECTION_HEADER_LINE_RE.test(t) && t !== category) break;
    // Linha plain-text (formato legado, sem inline link): só é candidata a
    // título se PARECER título — corpo encerra a coleta.
    if (!isTitleCandidate(t)) break;
    titles.push({ title: t, line: j + 1 });
    j++;
  }
  return { titles, nextIndex: j };
}
