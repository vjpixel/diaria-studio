/**
 * lint-checks/destaque-category-noticias.ts (#8200)
 *
 * Backstop editorial pra categoria de destaque literal "NOTÍCIAS" — proibida
 * pelo #6083 (feedback do editor, 260825): "categoria nunca deve ser
 * 'notícias'" no header `**DESTAQUE N | {emoji} {CATEGORIA}**`. A regra já
 * existia em PROSA em `.claude/agents/orchestrator-stage-2.md` (o coordenador
 * deve derivar `category_label` de `highlights[N-1].article.category`,
 * refinando por TEMA quando a categoria interna for genérica — ex: MERCADO,
 * EDUCAÇÃO, REGULAÇÃO em vez do literal "NOTÍCIAS"), mas sem nenhum
 * lint/invariante mecânico barrando — duas edições seguidas (260916, 260917)
 * saíram com "NOTÍCIAS" no header apesar da instrução em prosa. Mesmo padrão
 * de `banned-lexicon.ts` (#7260): instrução em prosa ignorada silenciosamente
 * 2x seguidas é o caso que um guard mecânico resolve.
 *
 * GATE-BLOCKING: decisão do coordenador ao dispatchar #8200 — mesmo racional
 * do `banned-lexicon` (#7260), regra do editor (#6083) é categórica
 * ("nunca"), sem exceção legítima conhecida.
 *
 * ## Escopo
 *
 * Só o header de DESTAQUE (`**DESTAQUE N | ...**`) — nunca o corpo do texto,
 * onde "notícias" no sentido comum (ex: "essas notícias mostram que...") é
 * uso legítimo da palavra. Reusa `HIGHLIGHT_HEADER_RE`
 * (`lint-checks/highlight-parsing.ts`) pra extrair a categoria (grupo 2) de
 * cada linha de header de destaque — mesma fonte que `titles-per-highlight`/
 * `title-length` já usam, sem regex duplicada.
 */

import { HIGHLIGHT_HEADER_RE } from "./highlight-parsing.ts";

// Categoria "NOTÍCIAS" literal, com ou sem emoji/espaço na frente, case
// insensitive. `\p{Extended_Pictographic}` cobre qualquer emoji (mesmo
// raciocínio do SECTION_HEADER_LINE_RE em highlight-parsing.ts) — o emoji em
// si não é o problema, é o texto "NOTÍCIAS" sobrevivendo como categoria.
const NOTICIAS_CATEGORY_RE = /^(?:\p{Extended_Pictographic}️?\s*)?not[íi]cias?$/iu;

export interface DestaqueCategoryNoticiasError {
  line: number;
  destaqueNumber: number;
  category: string;
  excerpt: string;
}

export interface DestaqueCategoryNoticiasReport {
  ok: boolean;
  errors: DestaqueCategoryNoticiasError[];
}

/**
 * Varre `md` procurando headers `**DESTAQUE N | ...**` cuja categoria
 * (grupo 2 de `HIGHLIGHT_HEADER_RE`) seja literalmente "NOTÍCIAS" (com ou
 * sem emoji na frente). GATE-BLOCKING — ver docstring do módulo.
 */
export function checkDestaqueCategoryNoticias(md: string): DestaqueCategoryNoticiasReport {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const errors: DestaqueCategoryNoticiasError[] = [];

  lines.forEach((line, idx) => {
    const m = line.match(HIGHLIGHT_HEADER_RE);
    if (!m) return;
    const category = m[2].trim();
    if (NOTICIAS_CATEGORY_RE.test(category)) {
      errors.push({
        line: idx + 1,
        destaqueNumber: Number(m[1]),
        category,
        excerpt: line.trim().slice(0, 120),
      });
    }
  });

  return { ok: errors.length === 0, errors };
}
