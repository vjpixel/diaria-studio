/**
 * lint-checks/mid-sentence-ellipsis.ts (#3196)
 *
 * Backstop for outlet meta-description truncation landing in the MIDDLE of a
 * secondary item's description, not just at the end (`no-trailing-ellipsis`,
 * #2881, already covers the trailing case). Some outlets truncate their OWN
 * meta-description with an ellipsis surrounded by real words on both sides —
 * that reads as if OUR pipeline had cut the sentence, when it's the source's
 * own truncation. Reported incident (#3196, edição 260709, item RADAR G1):
 *
 *   "Um advogado de Salvador foi condenado ... de inteligência artificial
 *    (IA) usadas pelo tribunal"
 *
 * WARN-ONLY (mirrors the #2715 rationale used by title-publisher-suffix /
 * title-trailing-period / no-trailing-ellipsis): this is a broad heuristic
 * with no allowlist, so it necessarily also flags a LEGITIMATE stylistic
 * mid-sentence ellipsis (e.g. "Os pesquisadores esperavam um resultado… e
 * tiveram uma surpresa completamente diferente." — the exact shape
 * `no-trailing-ellipsis`'s own test suite treats as OK to NOT flag). That's
 * by design: this check is a wider net for the editor to eyeball, never a
 * gate-blocker — the false-positive cost is low, the false-negative cost
 * (unflagged truncation reaching subscribers) is the bug this closes.
 *
 * Algorithm: strip a trailing "(N min)" time-suffix (USE MELHOR reading-time
 * estimate) and any genuine TRAILING ellipsis (already covered by the sibling
 * check) from the description, then look for any remaining ellipsis
 * occurrence — by construction, anything left over sits in the middle of the
 * sentence, not at the very end.
 */

import { sectionHeaderRegex } from "../section-naming.ts";
import { INLINE_LINK_ONLY_RE, URL_WITH_BALANCED_PARENS_RE_PART } from "./section-item-format.ts";
import { TRAILING_ELLIPSIS_RE } from "../sanitize-description-ellipsis.ts";
import { stripTrailingTimeSuffix } from "./no-trailing-ellipsis.ts"; // #3196: shared w/ fix #2

// Seções cujos itens têm descrição (mesmo escopo de checkSecondaryItemsHaveSummary /
// checkNoTrailingEllipsis).
const TARGET_SECTION_RE = sectionHeaderRegex(
  String.raw`LAN[ÇC]AMENTOS?|RADAR|USE\s+MELHOR|PESQUISAS?|OUTRAS?\s+NOT[ÍI]CIAS?`,
  { capture: "none", flags: "u" },
);

// Qualquer header de seção real — encerra o scan da seção alvo (mesmo
// conjunto de headers de no-trailing-ellipsis.ts, #2918 bug 2).
const ANY_SECTION_HEADER_RE = sectionHeaderRegex(
  String.raw`LAN[ÇC]AMENTOS?|RADAR|USE\s+MELHOR|V[ÍI]DEOS?|PESQUISAS?|OUTRAS?\s+NOT[ÍI]CIAS?|[ÉE]\s+IA\?|ERRO INTENCIONAL|SORTEIO|PARA ENCERRAR`,
  { capture: "none", flags: "u" },
);

// Formato canônico USE MELHOR: link + descrição na MESMA linha.
const INLINE_LINK_WITH_TEXT_RE = new RegExp(
  String.raw`^\s*\*{0,2}\s*\[([^\]]+)\]\(${URL_WITH_BALANCED_PARENS_RE_PART}\)\*{0,2}\s+(\S.*)$`,
);

/** Any ellipsis run — 2+ ASCII dots or the unicode ellipsis char. */
const ANY_ELLIPSIS_RE = /(?:\.{2,}|…)/u;

export interface MidSentenceEllipsisError {
  section: string;
  /** Linha da descrição (ou do item inline) que contém a reticência no meio. */
  line: number;
  /** Trecho do título do item, para contexto. */
  titleExcerpt: string;
  /** Trecho da descrição (até 100 chars), para contexto. */
  descriptionExcerpt: string;
}

export interface MidSentenceEllipsisReport {
  ok: boolean;
  errors: MidSentenceEllipsisError[];
}

/**
 * Returns true if `description` — after stripping a trailing "(N min)"
 * suffix and any genuine trailing ellipsis — still contains an ellipsis,
 * i.e. one used in the middle of the sentence.
 */
function hasMidSentenceEllipsis(description: string): boolean {
  let text = stripTrailingTimeSuffix(description).trimEnd();
  const trailingMatch = text.match(TRAILING_ELLIPSIS_RE);
  if (trailingMatch && trailingMatch.index !== undefined) {
    text = text.slice(0, trailingMatch.index);
  }
  return ANY_ELLIPSIS_RE.test(text);
}

/**
 * Varre `md` e retorna um erro para cada item de seção secundária cuja
 * descrição contém `…`/`...` no MEIO da frase (não só no fim).
 */
export function checkMidSentenceEllipsis(md: string): MidSentenceEllipsisReport {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const errors: MidSentenceEllipsisError[] = [];

  let currentSection: string | null = null;
  let pendingTitle: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();

    if (TARGET_SECTION_RE.test(t)) {
      currentSection = t.replace(/^\*\*/, "").replace(/\*\*$/, "").trim();
      pendingTitle = null;
      continue;
    }

    if (ANY_SECTION_HEADER_RE.test(t)) {
      currentSection = null;
      pendingTitle = null;
      continue;
    }

    if (t === "---") {
      currentSection = null;
      pendingTitle = null;
      continue;
    }

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
      if (hasMidSentenceEllipsis(description)) {
        errors.push({
          section: currentSection,
          line: i + 1,
          titleExcerpt: inlineMatch[1].slice(0, 80),
          descriptionExcerpt: description.slice(0, 100),
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
      if (hasMidSentenceEllipsis(t)) {
        errors.push({
          section: currentSection,
          line: i + 1,
          titleExcerpt: pendingTitle.slice(0, 80),
          descriptionExcerpt: t.slice(0, 100),
        });
      }
      pendingTitle = null;
    }
  }

  return { ok: errors.length === 0, errors };
}
