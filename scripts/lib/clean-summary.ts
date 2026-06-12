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

const MAX_SUMMARY_LENGTH = 200;

/**
 * stripHtml — remove HTML tags de um campo de texto livre antes do stitch (#2151).
 *
 * Regras:
 * - `<a href="X">Y</a>` completo → preserva o texto interno Y (link semântico mantido como texto).
 * - `<a href=...` truncada (tag sem fechar) → strippe limpo, sem `<` solto.
 * - Qualquer outra tag → remove silenciosamente.
 * - Decodifica entities comuns (&nbsp; → ' ', &amp; → '&', &lt; → '<', &gt; → '>').
 * - Colapsa espaços em excesso.
 *
 * Aplicado na entrada de cleanSummary — garante que HTML cru upstream (AI extraction
 * imprecisa, truncamento em word-boundary de tag) nunca propague para o stitch.
 */
export function stripHtml(text: string): string {
  if (!text) return text;

  // 1. Substituir tags <a href="...">texto</a> completas → preserva texto interno.
  let out = text.replace(/<a\s[^>]*>([\s\S]*?)<\/a>/gi, "$1");

  // 2. Remover quaisquer tags restantes (incluindo incompletas/truncadas como `<a href=...`).
  //    Usa dois passes: primeiro fecha tags bem-formadas residuais, depois limpa fragmentos.
  out = out.replace(/<[^>]*>/g, "");   // tags fechadas normais
  out = out.replace(/<[^>]*$/g, "");   // fragmento truncado sem `>` (ex: `<a href=...`)

  // 3. Decodificar HTML entities.
  out = out
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&[a-z]+;/gi, ""); // entities desconhecidas → remove

  // 4. Colapsar whitespace em excesso.
  out = out.replace(/[ \t]{2,}/g, " ").trim();

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
 * Cleans a summary by:
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
  const stripped = stripHtml(summary);
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
