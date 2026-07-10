/**
 * lint-checks/no-untranslated-summary.ts (#3196)
 *
 * `translate-summaries.ts` (Stage 1) only does deterministic cleanup
 * (strip/truncate) — it does NOT translate. `stitch-newsletter.ts` injects a
 * literal `[TRADUZIR] ` prefix on secondary-item (LANÇAMENTOS/RADAR/USE
 * MELHOR) descriptions detected as English (`looksEnglish`), and actual
 * translation depends entirely on the humanizer (LLM) catching the item in
 * the secondary sections. Until this lint, nothing deterministic failed when
 * a `[TRADUZIR]` marker (or a clearly-English summary the humanizer skipped
 * without even the marker) survived all the way to `02-reviewed.md`.
 *
 * Reported incidents (#3196, edição 260709):
 *   "[TRADUZIR] OpenAI Academy and the Walton Family Foundation..." (USE MELHOR)
 *   "[TRADUZIR] LangChain and NVIDIA launch the NemoClaw..." (USE MELHOR)
 *   "[TRADUZIR] OpenAI previews GPT-5.6 Sol..." (RADAR)
 *
 * GATE-BLOCKING (exit 1 via CLI) — mirrors `secondary-items-have-summary`
 * (#2545): an untranslated item is not publishable, same tier as a missing
 * description.
 *
 * Two independent checks, either one is sufficient to flag a line:
 *   1. Literal `[TRADUZIR]` marker — checked on EVERY line, regardless of
 *      section-boundary parsing, so a shape this module's section walker
 *      doesn't recognize structurally still can't slip past the gate.
 *   2. EN-language heuristic (`looksEnglish`, en/pt stopword ratio — the same
 *      canonical helper `stitch-newsletter.ts` itself uses to decide whether
 *      to inject the `[TRADUZIR]` marker in the first place, #1790) applied
 *      to descriptions in the recognized secondary-item shapes. This catches
 *      the case where the humanizer stripped the `[TRADUZIR]` marker but left
 *      the underlying English text untranslated.
 */

import { sectionHeaderRegex } from "../section-naming.ts";
import { INLINE_LINK_ONLY_RE, URL_WITH_BALANCED_PARENS_RE_PART } from "./section-item-format.ts";
import { looksEnglish } from "../lang-detect.ts";

const TARGET_SECTION_RE = sectionHeaderRegex(
  String.raw`LAN[ÇC]AMENTOS?|RADAR|USE\s+MELHOR|PESQUISAS?|OUTRAS?\s+NOT[ÍI]CIAS?`,
  { capture: "none", flags: "u" },
);

const ANY_SECTION_HEADER_RE = sectionHeaderRegex(
  String.raw`LAN[ÇC]AMENTOS?|RADAR|USE\s+MELHOR|V[ÍI]DEOS?|PESQUISAS?|OUTRAS?\s+NOT[ÍI]CIAS?|[ÉE]\s+IA\?|ERRO INTENCIONAL|SORTEIO|PARA ENCERRAR`,
  { capture: "none", flags: "u" },
);

// Formato canônico USE MELHOR: link + descrição na MESMA linha.
const INLINE_LINK_WITH_TEXT_RE = new RegExp(
  String.raw`^\s*\*{0,2}\s*\[([^\]]+)\]\(${URL_WITH_BALANCED_PARENS_RE_PART}\)\*{0,2}\s+(\S.*)$`,
);

const TRADUZIR_LITERAL = "[TRADUZIR]";

export type UntranslatedSummaryReason = "traduzir_prefix" | "en_heuristic";

export interface UntranslatedSummaryError {
  section: string;
  line: number;
  reason: UntranslatedSummaryReason;
  titleExcerpt: string;
  descriptionExcerpt: string;
}

export interface UntranslatedSummaryReport {
  ok: boolean;
  errors: UntranslatedSummaryError[];
}

/**
 * Varre `md` e retorna um erro para cada item de seção secundária cuja
 * descrição (a) carrega o marcador literal `[TRADUZIR]`, ou (b) parece
 * inglês pela heurística de stopwords, mesmo sem o marcador.
 */
export function checkNoUntranslatedSummary(md: string): UntranslatedSummaryReport {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const errors: UntranslatedSummaryError[] = [];

  let currentSection: string | null = null;
  let pendingTitle: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();

    // Check 1 (incondicional, qualquer linha): marcador literal [TRADUZIR]
    // sobrevivendo até o gate. Checado independente do parsing estrutural de
    // seção abaixo, pra que um formato não reconhecido pelo walker ainda não
    // escape (#3196).
    if (raw.includes(TRADUZIR_LITERAL)) {
      // Prefer the real title when this line matches the canonical inline
      // shape (`**[Título](URL)** [TRADUZIR] texto...`) — Check 2 below
      // extracts it the same way, but Check 1 fires first and would
      // otherwise fall back to a stale/empty `pendingTitle` for this shape.
      const literalInlineMatch = raw.match(INLINE_LINK_WITH_TEXT_RE);
      errors.push({
        section: currentSection ?? "unknown",
        line: i + 1,
        reason: "traduzir_prefix",
        titleExcerpt: (literalInlineMatch?.[1] ?? pendingTitle ?? "").slice(0, 80),
        descriptionExcerpt: (literalInlineMatch?.[2] ?? t).trim().slice(0, 80),
      });
    }

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

    if (!currentSection) {
      pendingTitle = null;
      continue;
    }

    // Check 2: heurística EN nos formatos estruturados reconhecidos. Pula se
    // a linha já disparou o Check 1 acima (evita erro duplicado/ruidoso pro
    // mesmo item).
    const inlineMatch = raw.match(INLINE_LINK_WITH_TEXT_RE);
    if (inlineMatch) {
      const desc = inlineMatch[2].trim();
      if (!desc.includes(TRADUZIR_LITERAL) && looksEnglish(desc, { minWords: 4 })) {
        errors.push({
          section: currentSection,
          line: i + 1,
          reason: "en_heuristic",
          titleExcerpt: inlineMatch[1].slice(0, 80),
          descriptionExcerpt: desc.slice(0, 80),
        });
      }
      pendingTitle = null;
      continue;
    }

    if (INLINE_LINK_ONLY_RE.test(raw)) {
      pendingTitle = t;
      continue;
    }

    if (pendingTitle && t !== "") {
      if (!t.includes(TRADUZIR_LITERAL) && looksEnglish(t, { minWords: 4 })) {
        errors.push({
          section: currentSection,
          line: i + 1,
          reason: "en_heuristic",
          titleExcerpt: pendingTitle.slice(0, 80),
          descriptionExcerpt: t.slice(0, 80),
        });
      }
      pendingTitle = null;
    }
  }

  return { ok: errors.length === 0, errors };
}
