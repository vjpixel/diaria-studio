/**
 * lint-checks/title-length.ts (#1737 item 2 — extraído de lint-newsletter-md.ts)
 *
 * Verifica que cada título de destaque cabe em ≤52 caracteres (#701).
 *
 * `editorial-rules.md` exige "Título: máximo 52 caracteres" — antes desse
 * check só self-validation do writer LLM pegava. `--check titles-per-highlight`
 * conta quantos, este conta a largura.
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
function graphemeLength(str: string): number {
  return [...new Intl.Segmenter().segment(str)].length;
}

export function checkTitleLengths(md: string): TitleLengthReport {
  const lines = md.split("\n");
  const errors: TitleLengthError[] = [];

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
        const gLen = graphemeLength(inline.title);
        if (gLen > MAX_TITLE_LENGTH) {
          errors.push({
            destaque: destaqueNum,
            category,
            title: inline.title,
            length: gLen,
            max: MAX_TITLE_LENGTH,
          });
        }
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
      // Candidato a título legacy (sem inline link) — valida linha inteira
      const gLen = graphemeLength(t);
      if (gLen > MAX_TITLE_LENGTH) {
        errors.push({
          destaque: destaqueNum,
          category,
          title: t,
          length: gLen,
          max: MAX_TITLE_LENGTH,
        });
      }
      j++;
    }
    i = j;
  }

  return { ok: errors.length === 0, errors };
}
