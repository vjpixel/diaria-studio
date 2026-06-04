/**
 * lint-checks/titles-per-highlight.ts (#1737 item 2 — extraído de lint-newsletter-md.ts)
 *
 * Conta linhas de título por bloco DESTAQUE (#178, atualizado em #245).
 *
 * Espera que cada bloco DESTAQUE tenha exatamente 1 título antes do gate
 * de Stage 2 ser aprovado. Writer produz 3 opções; editor deve podar
 * pra 1 antes de prosseguir pro Stage 3.
 *
 * **Formato pós-#245** (double newlines entre cada elemento):
 *
 *   DESTAQUE N | CATEGORIA
 *
 *   <opção 1>
 *
 *   <opção 2>      ← removidas pelo editor pré-Stage 3
 *
 *   <opção 3>
 *
 *   <URL>
 *
 *   <parágrafo 1>
 *
 * Algoritmo: após o header, pula linhas em branco e coleta linhas
 * não-vazias e não-URL como títulos. Para no primeiro de:
 *   - Linha de URL (terminator canônico — URL vem logo após títulos por #172)
 *   - Próximo header DESTAQUE
 *   - Header de seção secundária (LANÇAMENTOS/etc.)
 *   - Section break `---`
 *
 * Compatível com formato pré-#245 (single newline) — a ausência de blank
 * line entre título e URL ainda funciona porque a URL termina o bloco.
 */

import { looksLikeTitleOption } from "../title-heuristic.ts";
import { parseInlineLink } from "../inline-link.ts"; // #599
import {
  HIGHLIGHT_HEADER_RE,
  URL_LINE_RE,
  SECTION_BREAK_LINE_RE,
  SECTION_HEADER_LINE_RE,
  WHY_MATTERS_LINE_RE,
} from "./highlight-parsing.ts";

export interface TitleCheckResult {
  destaque: number;
  category: string;
  title_count: number;
  titles: string[];
  status: "ok" | "needs_pruning";
}

export interface TitleCheckReport {
  ok: boolean;
  destaques: TitleCheckResult[];
  errors: string[];
}

export function countTitlesPerHighlight(md: string): TitleCheckReport {
  const lines = md.split("\n");
  const destaques: TitleCheckResult[] = [];
  const errors: string[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(HIGHLIGHT_HEADER_RE);
    if (!m) {
      i++;
      continue;
    }
    const destaqueNum = parseInt(m[1], 10);
    const category = m[2].trim();
    // Coletar títulos: pula blanks, para em URL/header/section break/marker.
    // Heurística adicional (#245): linha que parece body (longa OU termina
    // com ponto) também encerra — protege legacy onde URL fica no fim do
    // bloco e o título não tem URL imediatamente abaixo.
    const titles: string[] = [];
    let j = i + 1;
    while (j < lines.length) {
      const t = lines[j].trim();
      // Pula linhas em branco (blank line entre elementos no formato #245)
      if (t === "") {
        j++;
        continue;
      }
      // #599 — formato inline `[título](URL)`: extrai título do link.
      // No formato inline, o título inteiro pode passar de 60 chars (limite
      // do looksLikeTitleOption); precisa tratar antes do filtro legacy.
      const inline = parseInlineLink(t);
      if (inline) {
        titles.push(inline.title);
        j++;
        continue;
      }
      // URL é o terminator canônico (URL imediatamente após títulos por #172)
      if (URL_LINE_RE.test(t)) break;
      // "Por que isso importa:" termina o título block (legacy URL-no-fim)
      if (WHY_MATTERS_LINE_RE.test(t)) break;
      // Outro DESTAQUE (raro — destaque sem URL/body)
      if (HIGHLIGHT_HEADER_RE.test(t)) break;
      // Section break ou cabeçalho de seção secundária
      if (SECTION_BREAK_LINE_RE.test(t)) break;
      if (SECTION_HEADER_LINE_RE.test(t) && t !== category) break;
      // Heurística #259: aceita título curto terminando em `?`, `!`, `...`
      // ou palavras; rejeita ponto único final (= body). Mesmo critério do
      // parseDestaques (extract-destaques.ts).
      if (!looksLikeTitleOption(t)) break;
      titles.push(t);
      j++;
    }
    destaques.push({
      destaque: destaqueNum,
      category,
      title_count: titles.length,
      titles,
      status: titles.length === 1 ? "ok" : "needs_pruning",
    });
    if (titles.length !== 1) {
      errors.push(
        `DESTAQUE ${destaqueNum} (${category}): ${titles.length} título(s) — esperado 1. ${
          titles.length > 1
            ? "Delete os excedentes antes de prosseguir."
            : "Adicione 1 título."
        }`,
      );
    }
    i = j;
  }

  // Garantir que houve 3 destaques
  if (destaques.length !== 3) {
    errors.push(
      `Esperado 3 destaques (DESTAQUE 1/2/3); encontrei ${destaques.length}.`,
    );
  }

  return { ok: errors.length === 0, destaques, errors };
}
