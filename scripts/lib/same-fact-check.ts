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
 * decisão do editor no gate. Exceção #9386: em `--no-gates` (sem gate 1 para
 * o editor agir) itens de RADAR/LANÇAMENTOS com MESMO FATO são removidos do
 * `01-approved.json` (`removeSameFactSecondary`) e listados no gate 4.
 * Destaques continuam só com aviso.
 */

import { canonicalize } from "./url-utils.ts";

export interface SameFactPastDestaque {
  title: string;
  aammdd: string;
  url?: string;
  /**
   * #9386: bucket de origem do item passado. Ausente/"highlight" = destaque
   * (D1/D2/D3). Itens secundários passados (radar/lancamento/...) também
   * entram na comparação desde o #9386 — o mesmo fato saído como RADAR ontem
   * escapava porque só destaques eram comparados.
   */
  bucket?: string;
  /**
   * #9595: resumo do destaque passado. Usado só pelo sinal de NÚMEROS
   * (`findSameFactNumberMatches`) — a mesma história de outro veículo repete
   * as cifras centrais ("554 deepfakes", "Lula 379, Flávio 190") mesmo com
   * manchete e URL diferentes.
   */
  summary?: string;
}

export interface SameFactItem {
  /** "highlight" (candidato a destaque) ou o bucket secundário ("radar", ...). */
  kind: string;
  title: string;
  url: string;
  rank?: number;
  /**
   * #9386: resumo do item corrente. Manchete de outro veículo frequentemente
   * omite a versão ("OpenAI cancela lançamento de novo modelo de IA...") que
   * o resumo traz ("...GPT-6.1 Astra..."). Produtos do resumo também casam.
   */
  summary?: string;
  /**
   * #9595: texto factual extra do item corrente (ex: `summary_rejected` — o
   * resumo original guardado quando o refetch o substituiu por um trecho
   * truncado/mojibake). Só alimenta o sinal de NÚMEROS.
   */
  fact_text?: string;
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
  /** #9386: bucket do item passado ("highlight" = destaque). */
  matched_bucket: string;
  /**
   * #9386: onde o produto apareceu no item corrente — "title" ou "summary".
   * #9595: "numbers" = mesmo fato detectado por cifras centrais em comum
   * (`shared_numbers`), sem produto+versão (`shared_products` vazio). Nunca
   * remove nada (`removeSameFactSecondary` só age em "title").
   */
  evidence: "title" | "summary" | "numbers";
  /** #9595: cifras distintivas em comum (normalizadas, sem separador). */
  shared_numbers?: string[];
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
 * Palavras capitalizadas que seguem uma versão mas NÃO são nome de variante
 * ("Claude Sonnet 5.5 On AWS", "GPT-6.1 Chega ao Brasil").
 */
const NON_VARIANT_WORDS = new Set([
  "on", "in", "is", "and", "for", "the", "with", "to", "at", "now", "vs",
  "chega", "é", "e", "no", "na", "em", "de", "do", "da", "com", "para", "já",
  "ja", "ganha", "lança", "lanca", "launches", "arrives", "beats", "supera",
]);

/**
 * #9386: variante nomeada logo após a versão — "GPT-6.1 Astra" → astra,
 * "GPT-6.1 Sol" → sol. Usada só para DESCARTAR um match quando os dois lados
 * nomeiam variantes diferentes do mesmo `produto versão` (Sol ≠ Astra: fatos
 * distintos). Variante ausente num dos lados não descarta nada.
 */
export function extractProductVariants(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /(?<![\p{L}\p{N}])(\p{Lu}[\p{L}]+|\p{Lu}{2,})[\s-](\d{1,2}(?:[.,]\d{1,2})?)\s(\p{Lu}[\p{L}]+)/gu;
  for (const m of text.matchAll(re)) {
    const variant = m[3].toLowerCase();
    if (NON_VARIANT_WORDS.has(variant)) continue;
    const key = `${m[1].toLowerCase()} ${m[2].replace(",", ".")}`;
    if (!out.has(key)) out.set(key, variant);
  }
  return out;
}

function variantsConflict(product: string, a: Map<string, string>, b: Map<string, string>): boolean {
  const va = a.get(product);
  const vb = b.get(product);
  return va !== undefined && vb !== undefined && va !== vb;
}

/**
 * Compara cada item corrente contra os destaques passados. Retorna no máximo
 * 1 warning por item: o passado mais recente que casa pelo TÍTULO; só sem
 * nenhum, o mais recente que casa pelo resumo (#9514). Pula o par quando a
 * URL canônica é a mesma (isso é trabalho do dedup por URL, não daqui).
 */
export function findSameFactMatches(
  items: SameFactItem[],
  pastDestaques: SameFactPastDestaque[],
): SameFactWarning[] {
  const past = pastDestaques
    .map((p) => ({ ...p, products: extractVersionedProducts(p.title), variants: extractProductVariants(p.title) }))
    .filter((p) => p.products.size > 0)
    // mais recente primeiro (AAMMDD ordena lexicograficamente); destaque antes
    // de secundário na mesma edição.
    .sort((a, b) => b.aammdd.localeCompare(a.aammdd) || bucketRank(a.bucket) - bucketRank(b.bucket));

  const warnings: SameFactWarning[] = [];
  for (const item of items) {
    const titleProducts = extractVersionedProducts(item.title);
    const summary = item.summary ?? "";
    // Só versão com ponto ("gpt 6.1", "sonnet 5.5") vale no resumo: menção de
    // família ("GPT-6", "Gemini 4") é contexto comum em corpo de matéria e
    // gera falso positivo (caso real 261002: Verge sobre Dots citando "GPT-6
    // Astra" casava com RADAR passado sobre outro fato do GPT-6 Astra).
    const summaryProducts = new Set(
      [...(summary ? extractVersionedProducts(summary) : [])].filter((p) => p.includes(".")),
    );
    if (titleProducts.size === 0 && summaryProducts.size === 0) continue;
    const itemVariants = extractProductVariants(`${item.title}\n${summary}`);
    const itemUrl = item.url ? canonicalize(item.url) : "";
    const candidates = past.filter((p) => !(itemUrl && p.url && canonicalize(p.url) === itemUrl));
    const matches = (p: (typeof past)[number], set: Set<string>) =>
      [...set].filter((x) => p.products.has(x) && !variantsConflict(x, itemVariants, p.variants));
    // #9514: duas passadas — match por título em QUALQUER passado vence match
    // por resumo num passado mais novo. Senão a evidência dependeria da ordem
    // de iteração, e um match forte (título) ficaria escondido atrás de um
    // fraco (resumo), escapando de removeSameFactSecondary.
    let found: { p: (typeof past)[number]; shared: string[]; evidence: "title" | "summary" } | null = null;
    for (const [set, evidence] of [[titleProducts, "title"], [summaryProducts, "summary"]] as const) {
      for (const p of candidates) {
        const shared = matches(p, set);
        if (shared.length > 0) {
          found = { p, shared, evidence };
          break;
        }
      }
      if (found) break;
    }
    if (found) {
      const { p, shared, evidence } = found;
      warnings.push({
        kind: item.kind,
        ...(item.rank !== undefined ? { rank: item.rank } : {}),
        item_title: item.title,
        item_url: item.url,
        matched_edition: p.aammdd,
        matched_title: p.title,
        ...(p.url ? { matched_url: p.url } : {}),
        shared_products: shared.sort(),
        matched_bucket: p.bucket ?? "highlight",
        evidence,
      });
    }
  }
  return warnings;
}

function bucketRank(bucket: string | undefined): number {
  return bucket === undefined || bucket === "highlight" ? 0 : 1;
}

/** Buckets secundários elegíveis para remoção automática (#9386). */
export const SAME_FACT_REMOVABLE_KINDS = new Set(["radar", "lancamento"]);

export interface SameFactRemoval {
  bucket: string;
  title: string;
  url: string;
  matched_edition: string;
  matched_title: string;
  matched_bucket: string;
  shared_products: string[];
  evidence: "title" | "summary" | "numbers";
}

/**
 * #9386: em `--no-gates`, remove do pool secundário (RADAR/LANÇAMENTOS) do
 * `01-approved.json` os itens com warning de MESMO FATO (casados por URL
 * contra o bucket final) — só evidência por título e nunca `editor_submitted`
 * (#9456). Destaques (e use_melhor/video) nunca são removidos — continuam só com aviso. Pura: não
 * muta `approved`; devolve a cópia filtrada + as remoções (para o gate 4).
 */
export function removeSameFactSecondary(
  approved: Record<string, unknown>,
  warnings: SameFactWarning[],
): { approved: Record<string, unknown>; removed: SameFactRemoval[] } {
  // Indexa por URL independente do `kind` do warning: um candidato a
  // destaque (rank 4-6 do categorized) que o --auto rebaixou para RADAR no
  // approved também sai. Quem decide o que é removível é o bucket FINAL.
  const byUrl = new Map<string, SameFactWarning>();
  for (const w of warnings) {
    if (!w || typeof w.item_url !== "string" || !w.item_url) continue;
    byUrl.set(canonicalize(w.item_url), w);
  }
  const out: Record<string, unknown> = { ...approved };
  const removed: SameFactRemoval[] = [];
  if (byUrl.size === 0) return { approved: out, removed };
  for (const bucket of SAME_FACT_REMOVABLE_KINDS) {
    const arr = approved[bucket];
    if (!Array.isArray(arr)) continue;
    out[bucket] = arr.filter((it) => {
      if (it === null || typeof it !== "object") return true;
      const rec = it as { url?: unknown; title?: unknown; article?: { url?: unknown; title?: unknown } };
      const url = rec.article?.url ?? rec.url;
      if (typeof url !== "string" || !url) return true;
      const w = byUrl.get(canonicalize(url));
      if (!w) return true;
      // #9456: só evidência por TÍTULO remove sozinha — versão citada no
      // resumo é contexto comum ("supera o GPT-6.1") e fica só como aviso.
      if (w.evidence !== "title") return true;
      // #9456: submissão do editor nunca é removida automaticamente (#4192, #5080).
      if ((it as { flag?: unknown }).flag === "editor_submitted") return true;
      // #9100: destaque rebaixado por MESMO FATO fica no pool — rebaixar
      // nunca é descartar (decisão do editor de 05/10/2026).
      if ((it as { same_fact_demoted?: unknown }).same_fact_demoted) return true;
      const title = rec.article?.title ?? rec.title;
      removed.push({
        bucket,
        title: typeof title === "string" ? title : w.item_title,
        url,
        matched_edition: w.matched_edition,
        matched_title: w.matched_title,
        matched_bucket: w.matched_bucket,
        shared_products: w.shared_products,
        evidence: w.evidence,
      });
      return false;
    });
  }
  return { approved: out, removed };
}

// ---------------------------------------------------------------------------
// #9595: MESMO FATO por cifras centrais (a mesma história de outro veículo)
// ---------------------------------------------------------------------------

/**
 * Mínimo de cifras distintivas em comum para sinalizar MESMO FATO (#9595).
 * 2 e não 1: uma cifra isolada coincide por acaso (ex: "128" mil tokens em
 * dois lançamentos diferentes); duas cifras não-redondas iguais entre um
 * candidato e um destaque recente é a assinatura de um mesmo levantamento.
 */
export const SAME_FACT_MIN_SHARED_NUMBERS = 2;

/**
 * Extrai as cifras "distintivas" de um texto (#9595): inteiros ≥ 100 que não
 * sejam ano (1900–2100), número redondo (múltiplo de 100), percentual nem
 * parte decimal/versão ("5.5"). Separador de milhar ("1.234", "1,234") é
 * normalizado ("1234"). Premissa: cifra redonda/pequena é ruído de manchete
 * ("100 milhões", "top 10"); a cifra de um levantamento (554, 920, 379) é o
 * que outros veículos copiam literalmente ao recontar a mesma história.
 */
export function extractFactNumbers(text: string): Set<string> {
  const out = new Set<string>();
  const re = /(?<![\p{L}\p{N}.,])(\d{1,3}(?:[.,]\d{3})+|\d+)(?![\p{N}]|[.,]\d|\s?%)/gu;
  for (const m of text.matchAll(re)) {
    const digits = m[1].replace(/[.,]/g, "");
    const n = Number(digits);
    if (!Number.isFinite(n) || n < 100) continue;
    if (n >= 1900 && n <= 2100) continue; // ano
    if (n % 100 === 0) continue; // redondo
    out.add(String(n));
  }
  return out;
}

/**
 * #9595: MESMO FATO por cifras — candidato a destaque × destaque recente que
 * compartilham ≥ `SAME_FACT_MIN_SHARED_NUMBERS` cifras distintivas no
 * título+resumo (+ `fact_text`). Caso real: D1 de 261005 (bra1, "554
 * deepfakes... Lula em 379, Flávio Bolsonaro em 190") repetia o D1 de 261002
 * (Agência Lupa/VigIA, "920 posts... Lula 379... 190 de Bolsonaro") — URL,
 * título e veículo diferentes, nenhum produto+versão, dedup limpo.
 *
 * Só destaques passados (`bucket` ausente/"highlight") entram: a premissa da
 * issue é "a mesma história virar destaque de novo". 1 warning por item (o
 * destaque passado mais recente que casa). Mesma URL canônica é pulada
 * (trabalho do dedup por URL). Evidence "numbers" — só aviso, nunca remoção.
 */
export function findSameFactNumberMatches(
  items: SameFactItem[],
  pastDestaques: SameFactPastDestaque[],
): SameFactWarning[] {
  const past = pastDestaques
    .filter((p) => p.bucket === undefined || p.bucket === "highlight")
    .map((p) => ({ ...p, numbers: extractFactNumbers(`${p.title}\n${p.summary ?? ""}`) }))
    .filter((p) => p.numbers.size >= SAME_FACT_MIN_SHARED_NUMBERS)
    .sort((a, b) => b.aammdd.localeCompare(a.aammdd));
  const warnings: SameFactWarning[] = [];
  if (past.length === 0) return warnings;
  for (const item of items) {
    const numbers = extractFactNumbers(`${item.title}\n${item.summary ?? ""}\n${item.fact_text ?? ""}`);
    if (numbers.size < SAME_FACT_MIN_SHARED_NUMBERS) continue;
    const itemUrl = item.url ? canonicalize(item.url) : "";
    for (const p of past) {
      if (itemUrl && p.url && canonicalize(p.url) === itemUrl) continue;
      const shared = [...numbers].filter((x) => p.numbers.has(x));
      if (shared.length < SAME_FACT_MIN_SHARED_NUMBERS) continue;
      warnings.push({
        kind: item.kind,
        ...(item.rank !== undefined ? { rank: item.rank } : {}),
        item_title: item.title,
        item_url: item.url,
        matched_edition: p.aammdd,
        matched_title: p.title,
        ...(p.url ? { matched_url: p.url } : {}),
        shared_products: [],
        matched_bucket: "highlight",
        evidence: "numbers",
        shared_numbers: shared.sort((a, b) => Number(a) - Number(b)),
      });
      break;
    }
  }
  return warnings;
}

/**
 * #9595: linhas de aviso para o relatório do Stage 1 em `--no-gates` (sem
 * gate 1, o 🚨 MESMO FATO dos DESTAQUES só aparecia no gate 4). Recebe o JSON
 * cru de `01-highlight-theme-check.json` e de `01-approved.json`; devolve uma
 * linha por warning cujo `item_url` ainda é destaque no approved. Pura e
 * fail-soft: shape inesperada → lista vazia.
 */
export function formatHighlightSameFactNotes(themeCheck: unknown, approved: unknown): string[] {
  if (!themeCheck || typeof themeCheck !== "object" || !approved || typeof approved !== "object") return [];
  const warnings = (themeCheck as { same_fact_warnings?: unknown }).same_fact_warnings;
  const highlights = (approved as { highlights?: unknown }).highlights;
  if (!Array.isArray(warnings) || !Array.isArray(highlights)) return [];
  const pos = new Map<string, number>();
  highlights.forEach((h, i) => {
    if (!h || typeof h !== "object") return;
    const rec = h as { url?: unknown; article?: { url?: unknown }; same_fact_demoted?: unknown };
    // #9100: rebaixado já sai como ⬇️ (01-same-fact-demoted.json) — sem 🚨 duplicado.
    if (rec.same_fact_demoted) return;
    const url = rec.article?.url ?? rec.url;
    if (typeof url === "string" && url) pos.set(canonicalize(url), i + 1);
  });
  const out: string[] = [];
  const seen = new Set<string>();
  for (const w of warnings) {
    if (!w || typeof w !== "object") continue;
    const ww = w as Partial<SameFactWarning>;
    if (typeof ww.item_url !== "string" || !ww.item_url) continue;
    const key = canonicalize(ww.item_url);
    const d = pos.get(key);
    if (d === undefined || seen.has(key)) continue;
    seen.add(key);
    const why = ww.evidence === "numbers"
      ? `cifras: ${(ww.shared_numbers ?? []).join(", ")}`
      : `produto: ${(ww.shared_products ?? []).join(", ")}`;
    out.push(
      `🚨 MESMO FATO — D${d} "${ww.item_title ?? ""}" repete o destaque de ${ww.matched_edition ?? "?"} "${ww.matched_title ?? ""}" (${why}). Trocar o destaque no gate 4 se não for follow-up.`,
    );
  }
  return out;
}
