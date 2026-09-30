/**
 * same-fact-check.ts (#9100)
 *
 * Gatilho determinístico de "MESMO FATO" — produto + número de versão em
 * comum com um destaque (D1/D2/D3) das últimas edições.
 *
 * Caso real (#9100, 260929 → 260930): o D2 de 260929 foi "Claude Sonnet 5.5"
 * (anthropic.com); em 260930 o D3 candidato foi "Quase um Opus por uma fração
 * do preço: novo Claude Sonnet 5.5 chega 30% mais barato" (canaltech) e o
 * RADAR trazia "Anthropic launches Claude Sonnet 5.5 with 30% cost
 * reduction..." (VentureBeat). URL diferente → dedup por URL passa limpo. O
 * passe de tema (`check-highlight-themes.ts`, gatilho cross-source #8951)
 * chegou a emitir um warning genérico "repete tema", mas misturado a dezenas
 * de warnings secundários ruidosos (mesma empresa + prefixo de palavra) — e o
 * RADAR VentureBeat nem foi comparado contra os DESTAQUES passados (o check
 * secundário compara só contra secundários passados).
 *
 * Sinal: um par `produto versão` (ex: "sonnet 5.5", "gpt 6.1", "gemma 4")
 * aparece no título do item corrente E no título de um destaque recente.
 * Versão explícita de produto é muito específica — lançamento de modelo é
 * exatamente o fato que outlets diferentes cobrem em dias seguidos — então
 * o sinal é de alta precisão e pode ser apresentado destacado.
 *
 * Premissa editorial (#9100): SINALIZA, nunca bloqueia/demove. Um follow-up
 * legítimo (ex: benchmark independente do Sonnet 5.5 dias depois) ainda é
 * decisão do editor no gate.
 */

import { canonicalize } from "./url-utils.ts";

export interface SameFactPastDestaque {
  title: string;
  aammdd: string;
  url?: string;
}

export interface SameFactItem {
  /** "highlight" (candidato a destaque) ou o bucket secundário ("radar", ...). */
  kind: string;
  title: string;
  url: string;
  rank?: number;
}

export interface SameFactWarning {
  kind: string;
  rank?: number;
  item_title: string;
  item_url: string;
  matched_edition: string;
  matched_title: string;
  matched_url?: string;
  /** Pares produto+versão em comum, normalizados (ex: ["sonnet 5.5"]). */
  shared_products: string[];
}

/**
 * Palavras que antecedem número mas não são produto (evita "Top 10",
 * "Windows"-like genéricos não entram aqui — só o ruído comum de manchete).
 */
const NON_PRODUCT_WORDS = new Set([
  "top", "the", "de", "do", "da", "em", "and", "e", "of", "in", "on", "at",
  "por", "para", "com", "with", "for", "to", "até", "ate", "mais", "than",
  "cerca", "over", "under", "up", "by", "após", "apos", "after", "about",
  "day", "dia", "dias", "days", "week", "semana", "ano", "year", "anos",
  "years", "mês", "mes", "month", "months", "hour", "hours", "horas",
  "version", "versão", "versao", "v", "vol", "parte", "part", "fase", "phase",
  "série", "serie", "series", "season", "temporada", "nº", "no", "number",
  "número", "numero", "página", "pagina", "page", "chapter", "capítulo",
  "us", "usd", "r", "brl", "eur", "cop", "q", "h", "x",
]);

/**
 * Extrai pares `produto versão` normalizados de um título.
 *
 * Aceita "Sonnet 5.5", "GPT-6.1", "Gemma 4", "Llama 4.1", "o3"-like não
 * (sem separador não há como distinguir de palavra comum). Exige:
 *   - palavra do produto com inicial maiúscula ou toda em maiúsculas
 *     (nome próprio) e ≥2 letras;
 *   - versão numérica curta (1-2 dígitos, opcional `.d+`) que NÃO seja
 *     seguida de `%`, unidade monetária ou mais dígitos (anos, cifras).
 */
export function extractVersionedProducts(title: string): Set<string> {
  const out = new Set<string>();
  const re = /(?<![\p{L}\p{N}])(\p{Lu}[\p{L}]+|\p{Lu}{2,})[\s-](\d{1,2}(?:[.,]\d{1,2})?)(?![\p{N}%]|[.,]\d|\s?(?:mil|bi|mi|bilh|milh|billion|million|k\b))/gu;
  for (const m of title.matchAll(re)) {
    const word = m[1].toLowerCase();
    if (NON_PRODUCT_WORDS.has(word)) continue;
    if (word.length < 2) continue;
    const version = m[2].replace(",", ".");
    out.add(`${word} ${version}`);
  }
  return out;
}

/**
 * Compara cada item corrente contra os destaques passados. Retorna no máximo
 * 1 warning por item (o destaque mais recente que casa). Pula o par quando a
 * URL canônica é a mesma (isso é trabalho do dedup por URL, não daqui).
 */
export function findSameFactMatches(
  items: SameFactItem[],
  pastDestaques: SameFactPastDestaque[],
): SameFactWarning[] {
  const past = pastDestaques
    .map((p) => ({ ...p, products: extractVersionedProducts(p.title) }))
    .filter((p) => p.products.size > 0)
    // mais recente primeiro (AAMMDD ordena lexicograficamente)
    .sort((a, b) => b.aammdd.localeCompare(a.aammdd));

  const warnings: SameFactWarning[] = [];
  for (const item of items) {
    const products = extractVersionedProducts(item.title);
    if (products.size === 0) continue;
    const itemUrl = item.url ? canonicalize(item.url) : "";
    for (const p of past) {
      if (itemUrl && p.url && canonicalize(p.url) === itemUrl) continue;
      const shared = [...products].filter((x) => p.products.has(x));
      if (shared.length === 0) continue;
      warnings.push({
        kind: item.kind,
        ...(item.rank !== undefined ? { rank: item.rank } : {}),
        item_title: item.title,
        item_url: item.url,
        matched_edition: p.aammdd,
        matched_title: p.title,
        ...(p.url ? { matched_url: p.url } : {}),
        shared_products: shared.sort(),
      });
      break;
    }
  }
  return warnings;
}
