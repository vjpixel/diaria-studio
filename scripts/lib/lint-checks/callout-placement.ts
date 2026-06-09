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

const SEPARATOR_RE = /^---$/;
const DESTAQUE_HEADER_RE = /^(?:\*\*)?DESTAQUE\s+[123]\s*\|/;
const CALLOUT_OPEN_RE = /^\*\*\s*(?:📚|📣|🎉)/u;

export function lintCalloutPlacement(md: string): CalloutPlacementResult {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const matches: CalloutPlacementMatch[] = [];
  let sectionHasDestaque = false;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (SEPARATOR_RE.test(t)) {
      sectionHasDestaque = false;
      continue;
    }
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
