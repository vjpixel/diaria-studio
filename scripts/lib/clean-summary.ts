/**
 * clean-summary.ts (#1493)
 *
 * Utility to clean scraped meta descriptions that concatenate unrelated
 * sentences (common with og:description / meta description tags that
 * include site taglines, cookie notices, etc.).
 *
 * Also strips arXiv abstract prefixes and truncates to a max length.
 */

import { truncateAtBoundary } from "./truncate-at-boundary.ts";
import { stripG1ReportCta } from "./sanitize-description-boilerplate.ts"; // #9401

const MAX_SUMMARY_LENGTH = 200;

/**
 * Named HTML entity map — PT-BR accented chars + common typographic entities.
 * Finding #4: catch-all was deleting accented PT-BR characters (&eacute; → é etc).
 */
const NAMED_ENTITIES: Record<string, string> = {
  // basics
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  // typographic
  hellip: "…",
  mdash: "—",
  ndash: "–",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  // latin-1 PT-BR accented (lowercase)
  aacute: "á",
  agrave: "à",
  acirc: "â",
  atilde: "ã",
  auml: "ä",
  eacute: "é",
  egrave: "è",
  ecirc: "ê",
  euml: "ë",
  iacute: "í",
  igrave: "ì",
  icirc: "î",
  iuml: "ï",
  oacute: "ó",
  ograve: "ò",
  ocirc: "ô",
  otilde: "õ",
  ouml: "ö",
  uacute: "ú",
  ugrave: "ù",
  ucirc: "û",
  uuml: "ü",
  ccedil: "ç",
  ntilde: "ñ",
  // latin-1 accented (uppercase)
  Aacute: "Á",
  Agrave: "À",
  Acirc: "Â",
  Atilde: "Ã",
  Auml: "Ä",
  Eacute: "É",
  Egrave: "È",
  Ecirc: "Ê",
  Euml: "Ë",
  Iacute: "Í",
  Igrave: "Ì",
  Icirc: "Î",
  Iuml: "Ï",
  Oacute: "Ó",
  Ograve: "Ò",
  Ocirc: "Ô",
  Otilde: "Õ",
  Ouml: "Ö",
  Uacute: "Ú",
  Ugrave: "Ù",
  Ucirc: "Û",
  Uuml: "Ü",
  Ccedil: "Ç",
  Ntilde: "Ñ",
};

/**
 * Decode a single HTML entity reference (numeric decimal, hex, or named).
 * Returns the decoded character, or empty string for invalid/unsafe code points.
 * Finding #1: RangeError on invalid code points (>0x10FFFF or surrogates).
 * Finding #6: hex entities (&#x41;) were not decoded.
 * Finding #4: named PT-BR entities were deleted instead of decoded.
 */
function decodeEntity(entity: string): string {
  if (entity.startsWith("#x") || entity.startsWith("#X")) {
    // Finding #6: hex numeric entity &#x41; etc.
    const cp = parseInt(entity.slice(2), 16);
    return safeFromCodePoint(cp);
  }
  if (entity.startsWith("#")) {
    // Decimal numeric entity &#65; etc.
    const cp = parseInt(entity.slice(1), 10);
    return safeFromCodePoint(cp);
  }
  // Named entity — look up in our map; unknown → empty (don't crash).
  return NAMED_ENTITIES[entity] ?? "";
}

/**
 * Convert a Unicode code point to a character, guarding against:
 * - Code points > 0x10FFFF (RangeError in String.fromCodePoint)
 * - Lone surrogates (0xD800–0xDFFF)
 * Returns empty string for invalid code points (Finding #1).
 */
function safeFromCodePoint(cp: number): string {
  if (!Number.isInteger(cp) || cp < 0 || cp > 0x10FFFF) return "";
  // Lone surrogates are technically in range but invalid in JS strings/DOM.
  if (cp >= 0xD800 && cp <= 0xDFFF) return "";
  try {
    return String.fromCodePoint(cp);
  } catch {
    return "";
  }
}

/**
 * Decodifica entidades HTML (nomeadas da tabela acima, decimais e hex) sem
 * mexer em tags. Reusado pelo theme-fact do dedup (#9646), que tokeniza
 * title/summary crus de feed — `&ccedil;` não pode virar o token "ccedil".
 */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (_, ref) => decodeEntity(ref));
}

/**
 * stripHtml — remove HTML tags de um campo de texto livre antes do stitch (#2151).
 *
 * Regras:
 * - `<a href="X">Y</a>` completo → preserva o texto interno Y (link semântico mantido como texto).
 * - `<a href=...` truncada (tag sem fechar) → strippe limpo, sem `<` solto.
 * - Block elements (<p>, <br>, <div>, <li>, <tr>, <h1>-<h6>) → inserem espaço antes do strip
 *   so sentence boundaries are preserved (Finding #5).
 * - Qualquer outra tag → remove silenciosamente.
 * - Decodifica entities (named, decimal, hex) → caracteres Unicode (Findings #1/#4/#6).
 * - Colapsa whitespace em excesso incluindo \n\r (Finding #7).
 *
 * Aplicado na entrada de cleanSummary — garante que HTML cru upstream (AI extraction
 * imprecisa, truncamento em word-boundary de tag) nunca propague para o stitch.
 */
export function stripHtml(text: string): string {
  if (!text) return text;

  // Finding #2: Double-decode problem — strip tags BEFORE decoding entities.
  // Order: replace complete anchors → block tags → strip all tags → decode entities.
  // This prevents &amp;lt; → &lt; → < (double-decode bypassing the tag strip).

  // 1. Substituir tags <a href="...">texto</a> completas → preserva texto interno.
  let out = text.replace(/<a\s[^>]*>([\s\S]*?)<\/a>/gi, "$1");

  // 2. Finding #5: block/inline-block elements → insert space before removing, so
  //    sentence boundaries don't collapse ("</p><p>" → " " not "").
  out = out.replace(/<\/?(p|div|li|td|th|tr|br|h[1-6]|blockquote|pre|ul|ol|header|footer|section|article|nav|aside|figure|figcaption)\b[^>]*>/gi, " ");

  // 3. Finding #3 (CENTRAL BUG OF #2151): strip ALL remaining tags, including
  //    malformed/truncated tags that appear in the MIDDLE of the string.
  //    The original code used /<[^>]*$/g which only caught fragments at the END.
  //    Strategy: remove any well-formed tag first, then remove any remaining `<`
  //    up to the next `>` or end-of-string to catch mid-string truncated tags.
  out = out.replace(/<[^>]*>/g, "");       // well-formed tags (with closing >)
  out = out.replace(/<[^>]*/g, "");        // Finding #3 fix: truncated tag anywhere (no closing >)

  // 4. Finding #1, #4, #6: decode HTML entities AFTER stripping tags.
  //    - Named entities: mapped to Unicode (PT-BR accents preserved, not deleted).
  //    - Decimal numeric &#N;: safe code point conversion (RangeError guarded).
  //    - Hex numeric &#xN;: now also decoded (was silently passed through before).
  out = decodeHtmlEntities(out);

  // 5. Finding #7: collapse ALL whitespace (including \n, \r, \t, multiple spaces).
  //    Original only collapsed [ \t]{2,} — newlines from multi-line og:descriptions
  //    were left embedded in the output.
  //    Using \s+ (not \s{2,}) to collapse even a single \n/\r to a space.
  out = out.replace(/\s+/g, " ").trim();

  return out;
}

/**
 * PT-BR + EN stopwords — excluded when comparing sentence relevance to title.
 */
const STOPWORDS = new Set([
  // PT-BR
  "a", "o", "e", "de", "do", "da", "dos", "das", "em", "no", "na", "nos",
  "nas", "um", "uma", "uns", "umas", "para", "por", "com", "que", "se",
  "ou", "ao", "aos", "mais", "como", "é", "são", "foi", "ser", "ter",
  "está", "os", "as", "não", "mas",
  // EN
  "the", "a", "an", "and", "or", "of", "in", "on", "at", "to", "for",
  "is", "it", "be", "as", "by", "has", "was", "are", "its", "this",
  "that", "with", "from", "have", "been", "were", "will", "can",
]);

/**
 * arXiv prefix pattern:
 * "arXiv:XXXX.XXXXXvN Announce Type: new/cross Abstract: "
 * or variants like "arXiv:XXXX.XXXXX [cs.AI] ..."
 */
const ARXIV_PREFIX_RE =
  /^arXiv:\d{4}\.\d{4,5}(?:v\d+)?\s*(?:\[[\w.]+\]\s*)?(?:Announce Type:\s*\w+\s*)?(?:Abstract:\s*)?/i;

/**
 * Extract significant (non-stopword) words from a string, lowercased.
 */
function significantWords(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-záàâãéèêíïóôõúüç]+/gi) ?? [];
  return new Set(words.filter((w) => w.length > 2 && !STOPWORDS.has(w)));
}

/**
 * Split text into sentences. Splits on ". " followed by uppercase, or
 * at period-end-of-string. Keeps the period with the sentence.
 */
function splitSentences(text: string): string[] {
  // Split on ". " followed by an uppercase letter (sentence boundary heuristic)
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    // Find ". " followed by uppercase
    const match = remaining.match(/\.\s+(?=[A-ZÁÀÂÃÉÈÊÍÏÓÔÕÚÜÇ])/);
    if (match && match.index !== undefined) {
      parts.push(remaining.slice(0, match.index + 1).trim());
      remaining = remaining.slice(match.index + match[0].length);
    } else {
      parts.push(remaining.trim());
      break;
    }
  }
  return parts.filter((s) => s.length > 0);
}

/**
 * Rodapé que o WordPress anexa ao excerpt do RSS: "O post {título} apareceu
 * primeiro em {site}." / "The post {title} appeared first on {site}." (#9358 —
 * 6 itens de pool em 260801→261001 saíram com ele; como o rodapé repete o
 * título, o filtro de relevância por título do passo 3 abaixo o MANTÉM, então
 * precisa sair antes). Corta do "O post" até o fim.
 *
 * #9458: case-sensitive (o rodapé é sempre capitalizado), ancorado em início
 * de texto/frase e casando a ÚLTIMA ocorrência de "O post" antes do
 * "apareceu primeiro em" — com a flag `i`, um "o post" no meio do resumo
 * ("Segundo o post publicado...") cortava o texto inteiro.
 *
 * #9483: a âncora deixou de exigir pontuação antes do "O post" — basta não
 * estar colado a letra/dígito (`(?<![\p{L}\p{N}])`). O `stripHtml` colapsa
 * `</p><p>` em espaço, então um último parágrafo sem pontuação final
 * ("…com recursos O post Foo apareceu…") deixava o rodapé passar; idem
 * "excerpt…O post" (sem espaço) e "texto: O post". A proteção de
 * "Segundo o post…" continua vindo do case-sensitive + última ocorrência.
 */
const WORDPRESS_FOOTER_RE =
  /\s*(?<![\p{L}\p{N}])(?:O post|The post)\s(?:(?!(?:O|The) post\s)[\s\S])*?\b(?:apareceu primeiro em|appeared first on)\b[\s\S]*$/u;

/** Espaço antes de pontuação ("Meta , trouxe" / "medida ."). Não toca reticências. */
const SPACE_BEFORE_PUNCTUATION_RE = /(\S)[ \t]+([,;:!?]|\.(?!\.))(?=\s|$)/gu;

/**
 * Limpeza mecânica de ruído de feed no resumo (#9358): remove o rodapé do
 * WordPress e o espaço antes de pontuação. O que não dá pra consertar
 * mecanicamente (teaser, corte da fonte, boilerplate do YouTube) fica pro
 * guard `pool-summary-quality` (Stage 2), que manda reescrever. @pure
 */
export function stripFeedBoilerplate(text: string): string {
  if (!text) return text;
  // #9401: CTA do G1 ("🗒️ Tem alguma sugestão de reportagem? Envie para o g1 ·")
  // chega pelo summary do source-researcher, que nunca passa pelo enrich.
  return stripG1ReportCta(text)
    .replace(WORDPRESS_FOOTER_RE, "")
    .replace(SPACE_BEFORE_PUNCTUATION_RE, "$1$2")
    .trim();
}

/**
 * Cleans a summary by:
 * 0. Stripping HTML + feed boilerplate (WordPress footer, space before punctuation — #9358)
 * 1. Stripping arXiv prefix patterns
 * 2. Splitting into sentences
 * 3. Keeping only sentences topically related to the title
 * 4. Falling back to the first sentence if none match
 * 5. Truncating to MAX_SUMMARY_LENGTH chars
 */
export function cleanSummary(summary: string, title: string): string {
  if (!summary) return "";

  // Step 0: strip HTML antes de qualquer processamento (#2151 — HTML cru do upstream
  // nunca deve propagar para o markdown/stitch).
  const stripped = stripFeedBoilerplate(stripHtml(summary));
  if (!stripped) return "";

  // Step 1: strip arXiv prefix
  let cleaned = stripped.replace(ARXIV_PREFIX_RE, "").trim();
  if (!cleaned) return "";

  // Step 2: split into sentences
  const sentences = splitSentences(cleaned);
  if (sentences.length === 0) return "";

  // Step 3: keep sentences sharing significant words with the title
  const titleWords = significantWords(title);
  if (titleWords.size > 0) {
    const relevant = sentences.filter((s) => {
      const sWords = significantWords(s);
      for (const w of sWords) {
        if (titleWords.has(w)) return true;
      }
      return false;
    });

    cleaned = relevant.length > 0 ? relevant.join(" ") : sentences[0];
  } else {
    // Title has no significant words — keep first sentence
    cleaned = sentences[0];
  }

  // Step 5: truncate — usar word-boundary pra não cortar no meio de palavra (#2065)
  cleaned = truncateAtBoundary(cleaned, MAX_SUMMARY_LENGTH);

  return cleaned;
}
