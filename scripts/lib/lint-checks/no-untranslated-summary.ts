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

import { INLINE_LINK_ONLY_RE } from "./section-item-format.ts";
import { looksEnglish } from "../lang-detect.ts";
// #3242: state machine de boundary-parsing extraída pro walker compartilhado
// — ver secondary-item-walker.ts para o histórico de duplicação (#2545,
// #2881, #3196) que motivou a extração. O Check 1 abaixo (marcador literal
// catch-all) NÃO usa o walker — ver comentário em `checkTraduzirLiteral`.
import {
  forEachSecondaryItem,
  TARGET_SECTION_RE,
  ANY_SECTION_HEADER_RE,
  DESTAQUE_HEADER_RE,
  SAME_LINE_ITEM_RE,
  type SecondaryItemFound,
} from "./secondary-item-walker.ts";

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
 * Check 1 (incondicional, qualquer linha do documento): marcador literal
 * `[TRADUZIR]` sobrevivendo até o gate. Checado independente do parsing
 * estrutural de seção, pra que um formato não reconhecido pelo walker
 * (`forEachSecondaryItem`) ainda não escape (#3196 catch-all).
 *
 * NÃO usa `forEachSecondaryItem` — dispara em QUALQUER linha (mesmo fora de
 * uma seção-alvo reconhecida ou de um shape estrutural reconhecido), não
 * "por item", então mantém seu próprio rastreio mínimo de
 * `currentSection`/`pendingTitle` (só pra rotular o erro com contexto —
 * mesmas regras de boundary do walker, importadas daqui pra não duplicar as
 * regexes de header).
 */
function checkTraduzirLiteral(md: string): UntranslatedSummaryError[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const errors: UntranslatedSummaryError[] = [];

  let currentSection: string | null = null;
  let pendingTitle: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();

    if (raw.includes(TRADUZIR_LITERAL)) {
      // Prefer the real title when this line matches the canonical inline
      // shape (`**[Título](URL)** [TRADUZIR] texto...`) — Check 2 extracts
      // it the same way via o walker, mas Check 1 roda numa passada
      // separada e cairia num `pendingTitle` stale/vazio pra esse shape.
      const literalInlineMatch = raw.match(SAME_LINE_ITEM_RE);
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

    if (DESTAQUE_HEADER_RE.test(t)) {
      currentSection = null;
      pendingTitle = null;
      continue;
    }

    if (!currentSection) {
      pendingTitle = null;
      continue;
    }

    const inlineMatch = raw.match(SAME_LINE_ITEM_RE);
    if (inlineMatch) {
      pendingTitle = null;
      continue;
    }

    if (INLINE_LINK_ONLY_RE.test(raw)) {
      pendingTitle = t;
      continue;
    }

    if (pendingTitle && t !== "") {
      pendingTitle = null;
    }
  }

  return errors;
}

/**
 * Varre `md` e retorna um erro para cada item de seção secundária cuja
 * descrição (a) carrega o marcador literal `[TRADUZIR]`, ou (b) parece
 * inglês pela heurística de stopwords, mesmo sem o marcador.
 */
export function checkNoUntranslatedSummary(md: string): UntranslatedSummaryReport {
  const errors: UntranslatedSummaryError[] = checkTraduzirLiteral(md);

  // Check 2: heurística EN nos formatos estruturados reconhecidos (via
  // walker compartilhado). Pula item cuja descrição já carrega o marcador
  // literal — Check 1 acima já cobriu, evita erro duplicado/ruidoso pro
  // mesmo item.
  forEachSecondaryItem(md, {
    onFound: (item: SecondaryItemFound) => {
      if (item.description.includes(TRADUZIR_LITERAL)) return;
      if (looksEnglish(item.description, { minWords: 4 })) {
        errors.push({
          section: item.section,
          line: item.descriptionLine,
          reason: "en_heuristic",
          titleExcerpt: item.title.slice(0, 80),
          descriptionExcerpt: item.description.slice(0, 80),
        });
      }
    },
  });

  // #3242 code-review (5 finders independentes convergiram no mesmo achado,
  // 1 com fuzz diferencial 30k docs): Check 1 e Check 2 rodam como 2 passadas
  // separadas (documento pré-refactor rodava as duas juntas num único loop,
  // então `errors` saía implicitamente ordenado por linha). Sort estável
  // restaura a ordem de documento — sem isso, com os 2 tipos de erro no
  // mesmo doc, todo traduzir_prefix vem antes de todo en_heuristic
  // independente da posição real, mudando a ordem que o editor vê no gate
  // (`lint-newsletter-md.ts` imprime `result.errors` na ordem do array).
  errors.sort((a, b) => a.line - b.line);

  return { ok: errors.length === 0, errors };
}
