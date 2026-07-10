/**
 * lint-checks/no-trailing-ellipsis.ts (#2881)
 *
 * Backstop for `sanitizeTrailingEllipsis` (`scripts/lib/sanitize-description-
 * ellipsis.ts`), which runs at enrich time (Stage 1). Some descriptions
 * escape sanitization entirely — e.g. editor-curated text pasted straight
 * into `02-reviewed.md` after the gate, or a source snippet ingested via a
 * path that doesn't go through `enrich-inbox-articles.ts`. This lint flags
 * (WARN-ONLY, doesn't block the Stage 4 gate) any secondary item
 * (LANÇAMENTOS / RADAR / USE MELHOR / legacy PESQUISAS / OUTRAS NOTÍCIAS)
 * whose description still ends in `…`/`...` — the trailing ellipsis leaks
 * through as if OUR pipeline had cut the sentence mid-way (#2881 sintoma:
 * edição 260703).
 *
 * Two description shapes are checked, mirroring
 * `checkSecondaryItemsHaveSummary`:
 *   - title-only line + description on the NEXT non-empty line;
 *   - canonical USE MELHOR inline shape: `**[Título](URL)** Descrição...`.
 *
 * Only the TRAILING ellipsis is in scope — `…`/`...` used mid-sentence
 * (legitimate) is never flagged — see the sibling `mid-sentence-ellipsis.ts`
 * (#3196) for that backstop instead.
 *
 * #3196: before checking for a trailing ellipsis, a trailing "(N min)"
 * reading-time suffix (USE MELHOR) is stripped first via
 * `stripTrailingTimeSuffix` — otherwise a description like "Então... (5 min)"
 * "ends" in "(5 min)", not "…", and the ellipsis escapes detection.
 *
 * Exit via CLI (`lint-newsletter-md.ts --check no-trailing-ellipsis`):
 *   always 0 (WARN-ONLY, mirrors title-publisher-suffix / title-trailing-
 *   period — #2715) — matches are surfaced as ⚠️, never block the gate.
 */

import { sectionHeaderRegex } from "../section-naming.ts";
import { INLINE_LINK_ONLY_RE, URL_WITH_BALANCED_PARENS_RE_PART } from "./section-item-format.ts";
// Fonte única da regex de reticência final (#2881 self-review) — evita drift
// entre o sanitizador do enrich e este backstop de gate.
import { TRAILING_ELLIPSIS_RE } from "../sanitize-description-ellipsis.ts";

// Seções cujos itens têm descrição (mesmo escopo de checkSecondaryItemsHaveSummary).
const TARGET_SECTION_RE = sectionHeaderRegex(
  String.raw`LAN[ÇC]AMENTOS?|RADAR|USE\s+MELHOR|PESQUISAS?|OUTRAS?\s+NOT[ÍI]CIAS?`,
  { capture: "none", flags: "u" },
);

// Qualquer header de seção (inclusive VÍDEOS / É IA? / ERRO INTENCIONAL /
// SORTEIO / PARA ENCERRAR) — encerra o scan da seção alvo. #2918 bug 2: antes
// faltavam esses últimos 4 headers reais de toda edição (context/templates/
// newsletter.md) — se um `---` fosse removido numa edição manual no Drive,
// `currentSection` ficava "preso" em RADAR e a prosa de encerramento virava
// falso-positivo com label errado.
const ANY_SECTION_HEADER_RE = sectionHeaderRegex(
  String.raw`LAN[ÇC]AMENTOS?|RADAR|USE\s+MELHOR|V[ÍI]DEOS?|PESQUISAS?|OUTRAS?\s+NOT[ÍI]CIAS?|[ÉE]\s+IA\?|ERRO INTENCIONAL|SORTEIO|PARA ENCERRAR`,
  { capture: "none", flags: "u" },
);

/**
 * Trailing "(N min)"-style reading-time suffix (USE MELHOR, #2372/#2396/#2450)
 * — auto-injected by `injectAutoTimeEstimate` in `stitch-newsletter.ts`, or
 * written by the editor as the canonical parenthetical form. When present it
 * sits AFTER any ellipsis inherited from the source's own truncated
 * meta-description — "Então... (5 min)" — so a naive end-of-string check on
 * the raw description "ends" in "(5 min)", not "…", and the ellipsis escapes
 * detection (#3196, edição 260709, item USE MELHOR TikTok). Strip it before
 * testing for a trailing ellipsis.
 *
 * Kept narrow (parenthetical shape only) since that's the canonical Stage-4
 * shape — mirrors `USE_MELHOR_TEMPO_RE` (use-melhor-tempo.ts). The dash form
 * (`— 5 min`) is normalized to parens upstream by `normalizeDashToParens`
 * (stitch-newsletter.ts) before Stage 4, so it's out of scope here.
 */
export const TRAILING_TIME_SUFFIX_RE = /\s*\(\s*~?\s*\d+\s*min\b[^)]*\)\s*$/iu;

/** Strips a trailing "(N min)" reading-time suffix, if present. @pure */
export function stripTrailingTimeSuffix(text: string): string {
  return text.replace(TRAILING_TIME_SUFFIX_RE, "");
}

// Formato canônico USE MELHOR: link + descrição na MESMA linha.
// Grupo 1 = título, grupo 2 = descrição.
// #2918 bug 3: URL exclui só `)` do grupo — uma URL com parênteses balanceados
// (ex: Wikipedia `..._(disambiguation)`) não casava e o item passava batido
// sem checar a descrição. Reusa URL_WITH_BALANCED_PARENS_RE_PART (mesmo
// pattern de INLINE_LINK_ONLY_RE / section-item-format.ts) pra tolerar 1
// nível de parênteses balanceados no path.
const INLINE_LINK_WITH_TEXT_RE = new RegExp(
  String.raw`^\s*\*{0,2}\s*\[([^\]]+)\]\(${URL_WITH_BALANCED_PARENS_RE_PART}\)\*{0,2}\s+(\S.*)$`,
);

export interface NoTrailingEllipsisError {
  section: string;
  /** Linha da descrição (ou do item inline) que termina em reticências. */
  line: number;
  /** Trecho do título do item, para contexto. */
  titleExcerpt: string;
  /** Trecho final da descrição que disparou o flag. */
  descriptionExcerpt: string;
}

export interface NoTrailingEllipsisReport {
  ok: boolean;
  errors: NoTrailingEllipsisError[];
}

/**
 * Varre `md` e retorna um erro para cada item de seção secundária cuja
 * descrição termina em `…`/`...`.
 */
export function checkNoTrailingEllipsis(md: string): NoTrailingEllipsisReport {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const errors: NoTrailingEllipsisError[] = [];

  let currentSection: string | null = null;
  let pendingTitle: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();

    // Detectar seção alvo
    if (TARGET_SECTION_RE.test(t)) {
      currentSection = t.replace(/^\*\*/, "").replace(/\*\*$/, "").trim();
      pendingTitle = null;
      continue;
    }

    // Qualquer outro header de seção encerra a seção alvo
    if (ANY_SECTION_HEADER_RE.test(t)) {
      currentSection = null;
      pendingTitle = null;
      continue;
    }

    // Separador `---` encerra seção
    if (t === "---") {
      currentSection = null;
      pendingTitle = null;
      continue;
    }

    // Seção DESTAQUE também encerra
    if (/^(?:\*\*)?DESTAQUE\s+\d+/.test(t)) {
      currentSection = null;
      pendingTitle = null;
      continue;
    }

    if (!currentSection) continue;

    // Formato inline (USE MELHOR canônico): link + descrição na mesma linha.
    const inlineMatch = raw.match(INLINE_LINK_WITH_TEXT_RE);
    if (inlineMatch) {
      const description = inlineMatch[2].trim();
      if (TRAILING_ELLIPSIS_RE.test(stripTrailingTimeSuffix(description))) {
        errors.push({
          section: currentSection,
          line: i + 1,
          titleExcerpt: inlineMatch[1].slice(0, 80),
          descriptionExcerpt: description.slice(-40),
        });
      }
      pendingTitle = null;
      continue;
    }

    // Título sozinho na linha — guarda pra checar a próxima linha não-vazia
    // como descrição.
    if (INLINE_LINK_ONLY_RE.test(raw)) {
      pendingTitle = t;
      continue;
    }

    // Primeira linha não-vazia após um título pendente = descrição.
    if (pendingTitle && t !== "") {
      if (TRAILING_ELLIPSIS_RE.test(stripTrailingTimeSuffix(t))) {
        errors.push({
          section: currentSection,
          line: i + 1,
          titleExcerpt: pendingTitle.slice(0, 80),
          descriptionExcerpt: t.slice(-40),
        });
      }
      pendingTitle = null;
    }
  }

  return { ok: errors.length === 0, errors };
}
