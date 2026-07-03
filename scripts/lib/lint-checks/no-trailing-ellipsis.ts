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
 * (legitimate) is never flagged.
 *
 * Exit via CLI (`lint-newsletter-md.ts --check no-trailing-ellipsis`):
 *   always 0 (WARN-ONLY, mirrors title-publisher-suffix / title-trailing-
 *   period — #2715) — matches are surfaced as ⚠️, never block the gate.
 */

import { sectionHeaderRegex } from "../section-naming.ts";
import { INLINE_LINK_ONLY_RE } from "./section-item-format.ts";

// Seções cujos itens têm descrição (mesmo escopo de checkSecondaryItemsHaveSummary).
const TARGET_SECTION_RE = sectionHeaderRegex(
  String.raw`LAN[ÇC]AMENTOS?|RADAR|USE\s+MELHOR|PESQUISAS?|OUTRAS?\s+NOT[ÍI]CIAS?`,
  { capture: "none", flags: "u" },
);

// Qualquer header de seção (inclusive VÍDEOS / É IA?) — encerra o scan da seção alvo.
const ANY_SECTION_HEADER_RE = sectionHeaderRegex(
  String.raw`LAN[ÇC]AMENTOS?|RADAR|USE\s+MELHOR|V[ÍI]DEOS?|PESQUISAS?|OUTRAS?\s+NOT[ÍI]CIAS?`,
  { capture: "none", flags: "u" },
);

// Formato canônico USE MELHOR: link + descrição na MESMA linha.
// Grupo 1 = título, grupo 2 = descrição.
const INLINE_LINK_WITH_TEXT_RE =
  /^\s*\*{0,2}\s*\[([^\]]+)\]\(https?:\/\/[^\s)]+\)\*{0,2}\s+(\S.*)$/;

// Reticências no FIM do texto: 2+ pontos ASCII ou reticências unicode (…),
// tolera espaço em branco à direita. Mesma convenção de #2664/#2672
// (`\.{2,}` = reticências, não ponto final residual).
const TRAILING_ELLIPSIS_RE = /(?:\.{2,}|…)\s*$/u;

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
      if (TRAILING_ELLIPSIS_RE.test(description)) {
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
      if (TRAILING_ELLIPSIS_RE.test(t)) {
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
