/**
 * lint-checks/title-length.ts (#1737 item 2 — extraído de lint-newsletter-md.ts)
 *
 * Mede cada título de destaque contra o ALVO DE ESCRITA de 52 caracteres
 * (#701) — o número que os prompts do writer usam como margem.
 *
 * Desde o #11254 (decisão do editor no briefing 261027d) este NÃO é mais o
 * limite do título: os limites reais são dois checks distintos em
 * `title-limits.ts` (card 4x5 em até 3 linhas a 62px; assunto do e-mail,
 * D1 ≤70) e são eles que `--check title-length` roda. `checkTitleLengths`
 * segue exportado só para medir o writer contra o alvo (grader do eval de
 * prompt #8143, backtest de destilação) — nenhum gate o consulta.
 *
 * Não reusa `countTitlesPerHighlight` porque essa função usa `looksLikeTitleOption`
 * que rejeita linhas >60 chars (= body) — exatamente os candidatos que
 * precisamos pegar aqui (título mal-formado pelo writer LLM com 60+ chars).
 *
 * Parser próprio mais permissivo: após cada DESTAQUE header, coleta toda
 * linha não-vazia, não-URL, que não termine com ponto único (= body óbvio),
 * até a primeira URL ou próximo header. Não impõe limite superior — quanto
 * maior o título errado, mais importante é pegar.
 */

import { parseInlineLink } from "../inline-link.ts"; // #599
import {
  HIGHLIGHT_HEADER_RE,
  URL_LINE_RE,
  SECTION_BREAK_LINE_RE,
  SECTION_HEADER_LINE_RE,
  WHY_MATTERS_LINE_RE,
} from "./highlight-parsing.ts";

export interface TitleLengthError {
  destaque: number;
  category: string;
  title: string;
  length: number;
  max: number;
}

export interface TitleLengthReport {
  ok: boolean;
  errors: TitleLengthError[];
}

export const MAX_TITLE_LENGTH = 52;

/**
 * Conta grafemas (caracteres visíveis) em vez de code units UTF-16.
 * Evita falsos positivos em títulos com emojis de bandeira (ex: 🇧🇷 = 1
 * grafema mas 4 code units). Usa Intl.Segmenter (Node 16+). (#801)
 */
export function graphemeLength(str: string): number {
  return [...new Intl.Segmenter().segment(str)].length;
}

export interface DestaqueTitleCandidate {
  destaque: number;
  category: string;
  title: string;
}

/**
 * Coleta os candidatos a título de cada DESTAQUE (as 3 opções pré-gate, ou o
 * título único pós-poda), com o parser permissivo descrito no topo do módulo.
 * Compartilhado por `checkTitleLengths` (alvo de escrita, 52) e pelos dois
 * checks de limite real de `title-limits.ts` (#11254: card 4x5 + assunto).
 */
export function collectDestaqueTitleCandidates(md: string): DestaqueTitleCandidate[] {
  // #5084: normaliza CRLF→LF antes do split — sem isso, uma linha com \r
  // sobrando no fim quebra HIGHLIGHT_HEADER_RE (que usa `$` sem /m, exigindo
  // fim de string exato; `.` não casa \r).
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: DestaqueTitleCandidate[] = [];

  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(HIGHLIGHT_HEADER_RE);
    if (!m) {
      i++;
      continue;
    }
    const destaqueNum = parseInt(m[1], 10);
    const category = m[2].trim();
    let j = i + 1;
    while (j < lines.length) {
      const t = lines[j].trim();
      if (t === "") { j++; continue; }
      // #599 — formato inline: extrai título do link e mede só o texto.
      const inline = parseInlineLink(t);
      if (inline) {
        out.push({ destaque: destaqueNum, category, title: inline.title });
        j++;
        continue;
      }
      if (URL_LINE_RE.test(t)) break;
      if (HIGHLIGHT_HEADER_RE.test(t)) break;
      if (SECTION_BREAK_LINE_RE.test(t)) break;
      if (SECTION_HEADER_LINE_RE.test(t) && t !== category) break;
      if (WHY_MATTERS_LINE_RE.test(t)) break;
      // Body óbvio: termina em ponto único (não ellipsis). Pula sem flag.
      if (/\.\s*$/.test(t) && !/\.{3,}\s*$/.test(t)) {
        j++;
        continue;
      }
      // Candidato a título legacy (sem inline link) — linha inteira
      out.push({ destaque: destaqueNum, category, title: t });
      j++;
    }
    i = j;
  }
  return out;
}

export function checkTitleLengths(md: string): TitleLengthReport {
  const errors: TitleLengthError[] = [];
  for (const c of collectDestaqueTitleCandidates(md)) {
    const gLen = graphemeLength(c.title);
    if (gLen > MAX_TITLE_LENGTH) {
      errors.push({ ...c, length: gLen, max: MAX_TITLE_LENGTH });
    }
  }
  return { ok: errors.length === 0, errors };
}
