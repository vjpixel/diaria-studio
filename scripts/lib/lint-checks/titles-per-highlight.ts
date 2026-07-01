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
import { HIGHLIGHT_HEADER_RE } from "./highlight-parsing.ts";
import { walkDestaqueTitles } from "./destaque-title-walk.ts"; // #2693 item 1 — parser compartilhado

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
    // Coletar títulos via parser compartilhado (#2693 item 1 — antes duplicado
    // aqui e em extractAllTitles/title-normalization.ts). Heurística #259:
    // `looksLikeTitleOption` aceita título curto terminando em `?`, `!`, `...`
    // ou palavras; rejeita ponto único final (= body). Mesmo critério do
    // parseDestaques (extract-destaques.ts).
    const { titles: titleLines, nextIndex } = walkDestaqueTitles(
      lines,
      i + 1,
      category,
      looksLikeTitleOption,
    );
    const titles = titleLines.map((t) => t.title);
    const j = nextIndex;
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

  // #2316: aceita 2–3 destaques (editorial legítimo: editor demove D3 para Radar).
  if (destaques.length < 2 || destaques.length > 3) {
    errors.push(
      `Esperado 2–3 destaques (DESTAQUE 1/2 ou 1/2/3); encontrei ${destaques.length}.`,
    );
  }

  return { ok: errors.length === 0, destaques, errors };
}
