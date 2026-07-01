/**
 * lint-checks/callout-placement.ts (#1972 — Opção B, defesa)
 *
 * Detecta um callout (📣/📚/🎉 bold-wrapped — Clarice, livros, sorteio) colado
 * DENTRO de uma seção de DESTAQUE, em vez de isolado entre dois `---`.
 *
 * Por que importa: `parseDestaques` fatia o reviewed.md em `^---$`. Um callout
 * colado antes do `---` de fechamento do D1 cai na seção do D1 e é absorvido
 * pelo corpo/why do destaque (render quebrado + duplicado — visto na 260609).
 *
 * O render já é robusto a isso (de-dup determinístico em
 * `stripMidCalloutFromD1`, Opção A), mas este lint sinaliza a fonte do problema
 * pro editor reposicionar o bloco — o callout deve ser sua PRÓPRIA seção,
 * isolada entre o `---` que fecha o D1 e o `---` que abre o D2:
 *
 *   ...corpo do D1...
 *
 *   ---
 *
 *   **📣 Callout...**
 *
 *   ---
 *
 *   **DESTAQUE 2 | ...**
 *
 * O introCallout (🎉/📣 ANTES do 1º DESTAQUE, na região de intro) é legítimo e
 * NÃO é sinalizado — só callouts dentro de uma seção que já contém um header
 * `DESTAQUE N | ...`.
 */

export interface CalloutPlacementMatch {
  line: number;
  context: string;
}

export interface CalloutPlacementResult {
  ok: boolean;
  matches: CalloutPlacementMatch[];
}

// Separador casado na linha BRUTA (sem trim), espelhando `parseDestaques`
// (`raw.split(/^---$/m)`) e `parseSections` no render. Estrito de propósito: um
// `--- ` (espaço final) ou ` ---` (indentado) NÃO splita pra aqueles parsers, então
// o callout seguinte É absorvido no D1 — o lint precisa ser tão estrito quanto o
// splitter que protege, senão vira falso-negativo (passa, mas o render quebra).
const SEPARATOR_RE = /^---$/;
const DESTAQUE_HEADER_RE = /^(?:\*\*)?DESTAQUE\s+[123]\s*\|/;
const CALLOUT_OPEN_RE = /^\*\*\s*(?:📚|📣|🎉)/u;

export function lintCalloutPlacement(md: string): CalloutPlacementResult {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const matches: CalloutPlacementMatch[] = [];
  let sectionHasDestaque = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // Separador: linha bruta (sem trim) pra bater com /^---$/m do parseDestaques.
    if (SEPARATOR_RE.test(raw)) {
      sectionHasDestaque = false;
      continue;
    }
    const t = raw.trim();
    if (DESTAQUE_HEADER_RE.test(t)) {
      sectionHasDestaque = true;
      continue;
    }
    if (sectionHasDestaque && CALLOUT_OPEN_RE.test(t)) {
      matches.push({ line: i + 1, context: t.slice(0, 80) });
    }
  }
  return { ok: matches.length === 0, matches };
}

// ---------------------------------------------------------------------------
// #2729 — ≥2 blocos de callout-marker (🎉/📣) empilhados na região de intro
// ---------------------------------------------------------------------------

/**
 * #2729: `extractIntroCallout` (`scripts/lib/newsletter-parse.ts`, tornado
 * greedy pelo #2727 pra permitir sub-linhas `**bold**` dentro do box de
 * início de mês) assume que a região de intro (tudo antes do 1º
 * `**DESTAQUE`) contém NO MÁXIMO 1 bloco `**(🎉|📣) …**` — o regex greedy
 * casa do PRIMEIRO abertura até o ÚLTIMO `**` de fim de linha na região.
 *
 * Se o editor colar 2 blocos empilhados (ex: um 📣 patrocinado acima do 🎉 de
 * campeões/sorteio — `inject-champions-callout.ts` já tem lógica de
 * precedência que PULA a auto-injeção quando já existe um callout, mas isso
 * não impede colagem manual de 2 blocos pelo editor no Drive), o greedy funde
 * os dois num só bloco: os `**` internos (fechamento do 1º bloco + abertura
 * do 2º) vazam como texto literal no meio do parágrafo renderizado, e o
 * separador "Divulgação" do bloco 📣 patrocinado se perde.
 *
 * Este check erra (`ok: false`) quando encontra ≥2 linhas
 * `^\*\*\s*(🎉|📣)` na região de intro (antes do 1º `**DESTAQUE`) —
 * independente de midCallouts (📚/📣/🎉 entre destaques, cobertos por
 * `lintCalloutPlacement`/`locateMidCallout`, semântica diferente).
 */
export interface StackedIntroCalloutResult {
  ok: boolean;
  count: number;
  lines: number[];
}

const INTRO_CALLOUT_OPEN_RE = /^\*\*\s*(?:🎉|📣)/u;
const DESTAQUE_MARKER_RE = /^\*\*DESTAQUE/;

export function lintStackedIntroCallouts(md: string): StackedIntroCalloutResult {
  const normalized = md.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const matchLines: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    // Região de intro = tudo ANTES da 1ª linha `**DESTAQUE` — para assim que
    // encontrar o 1º destaque, espelhando `extractIntroCallout`
    // (`text.split(/^\*\*DESTAQUE/m)[0]`).
    if (DESTAQUE_MARKER_RE.test(lines[i])) break;
    if (INTRO_CALLOUT_OPEN_RE.test(lines[i].trim())) {
      matchLines.push(i + 1);
    }
  }
  return { ok: matchLines.length < 2, count: matchLines.length, lines: matchLines };
}
