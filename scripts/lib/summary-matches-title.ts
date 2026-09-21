/**
 * summary-matches-title.ts (#8594)
 *
 * Função pura que decide se o `summary` de um artigo tem relação com o
 * título/URL do MESMO artigo. Motivo: na edição 260921 um item do RADAR
 * (exame.com/.../clonagem-de-voz-e-identidade-como-os-golpes-com-ia-mudaram-no-brasil/)
 * saiu com o resumo de OUTRAS matérias (TypeSafe / CNN), trechos de um digest
 * separados por " · ". O `enrich-inbox-articles.ts` só PREENCHE summary vazio
 * (nunca sobrescreve), então o texto errado entrou a montante (pesquisa/RSS/
 * WebSearch) e nada validava título x summary até o gate.
 *
 * Heurística (só léxica, conservadora, evita falso positivo):
 *  - tokens significativos = minúsculas, sem acento, sem stopwords PT/EN,
 *    len >= 4 (ou número), comparados também por prefixo de 5 chars pra
 *    absorver plural/flexão;
 *  - casa se compartilha >= 2 tokens significativos OU >= 1 "entidade" do
 *    título (nome próprio no meio da frase, sigla, token com dígito, domínio
 *    da URL): título EN + summary PT passa quando há nome próprio/número comum;
 *  - summary multi-matéria (>= 3 trechos separados por " · ") é suspeito: só
 *    passa se o PRIMEIRO trecho casar sozinho;
 *  - pouca evidência (título ou summary com poucos tokens) => ok (não acusa).
 */

export interface SummaryMatchInput {
  title?: string | null;
  url?: string | null;
  summary?: string | null;
}

export type SummaryMatchReason =
  | "ok"
  | "no-summary"
  | "insufficient-evidence"
  | "no-overlap"
  | "multi-story-digest";

export interface SummaryMatchResult {
  ok: boolean;
  reason: SummaryMatchReason;
  /** Tokens/entidades em comum (debug + mensagem de lint). */
  shared: string[];
}

const STOPWORDS = new Set(
  (
    "para como mais sobre entre depois antes ainda quando onde qual quais essa esse esta este isso isto " +
    "pelo pela pelos pelas dele dela deles delas seu sua seus suas uma uns umas nao sao foi foram sera serao " +
    "tem tinha temos pode podem poder deve devem fazer feito faz vai vao ser estao estava " +
    "muito muitos muita muitas tambem apenas mesmo mesma cada todo toda todos todas outro outra outros outras " +
    "novo nova novos novas segundo porque " +
    "that this with from have has had will would could should about into over after before than then " +
    "they them their there here what which when where while been being were was are and the for but not " +
    "your you our its also more most some such only just like new"
  ).split(/\s+/),
);

/** Genéricos do domínio de IA/imprensa: não provam relação sozinhos. */
const GENERIC = new Set(
  "inteligencia artificial noticia noticias news brasil brasileiro brasileira modelo modelos empresa empresas".split(" "),
);

function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function stem(t: string): string {
  return t.length >= 6 ? t.slice(0, 5) : t;
}

function rawWords(text: string): string[] {
  return text.match(/[\p{L}\p{N}][\p{L}\p{N}.\-]*[\p{L}\p{N}]|[\p{L}\p{N}]/gu) ?? [];
}

function significantTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of rawWords(text)) {
    const f = fold(w).replace(/[.\-]+$/g, "");
    if (!f) continue;
    if (/^\d{1,4}$/.test(f)) continue; // ano/id curto não é evidência (#8594)
    const isNum = /\d/.test(f);
    if (!isNum && (f.length < 4 || STOPWORDS.has(f) || GENERIC.has(f))) continue;
    out.add(f);
    if (f.includes("-")) {
      for (const part of f.split("-")) {
        if (part.length >= 4 && !STOPWORDS.has(part) && !GENERIC.has(part) && !/^\d+$/.test(part)) out.add(part);
      }
    }
  }
  return out;
}

function urlWords(url: string): { slug: string; host: string } {
  try {
    const u = new URL(url);
    const parts = u.hostname.replace(/^www\./, "").split(".");
    const host =
      parts.length >= 3 && parts[parts.length - 2].length <= 3
        ? parts[parts.length - 3]
        : parts[Math.max(0, parts.length - 2)];
    const lastSeg = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() ?? "");
    const noExt = lastSeg.replace(/\.(?:g?html?|php|aspx?|amp)$/i, "");
    return { slug: noExt.replace(/[-_]+/g, " "), host: host ?? "" };
  } catch {
    return { slug: "", host: "" };
  }
}

/** Entidades do título: sigla, token com dígito, nome próprio fora do início da frase. */
function titleEntities(title: string): Set<string> {
  const out = new Set<string>();
  const words = rawWords(title);
  words.forEach((w, i) => {
    const f = fold(w);
    if (f.length < 2 || STOPWORDS.has(f) || f === "ia" || f === "ai") return; // "IA" é o tema do produto, não entidade
    const hasDigit = /\d/.test(w);
    const allCaps = w.length >= 2 && w === w.toUpperCase() && /\p{L}/u.test(w);
    const capMid = i > 0 && /^\p{Lu}/u.test(w) && f.length >= 3;
    const camel = /\p{Ll}\p{Lu}/u.test(w); // OpenAI, xAI, iPhone
    if ((hasDigit && !/^\d{1,4}$/.test(w)) || allCaps || capMid || camel) out.add(f);
  });
  return out;
}

function tokensOverlap(a: Set<string>, bText: string): string[] {
  const bTokens = significantTokens(bText);
  const bStems = new Set([...bTokens].map(stem));
  const bFolded = fold(bText);
  const shared: string[] = [];
  for (const t of a) {
    if (t.length < 4) {
      // sigla/nome curto (AWS, CNN, GPT, xAI): palavra inteira, com fronteira
      const esc = t.replace(/[^\p{L}\p{N}]/gu, (c) => "\\" + c);
      const re = new RegExp("(?<![\\p{L}\\p{N}])" + esc + "(?![\\p{L}\\p{N}])", "u");
      if (re.test(bFolded)) shared.push(t);
    } else if (bTokens.has(t) || bStems.has(stem(t)) || bFolded.includes(t)) shared.push(t);
  }
  return shared;
}

const SEP_RE = /\s[·|–]\s/;
const MIN_SEGMENT_CHARS = 20;

function matchText(
  title: string,
  url: string,
  text: string,
): { ok: boolean; shared: string[]; enough: boolean } {
  const { slug, host } = urlWords(url);
  const refTokens = significantTokens(`${title} ${slug}`);
  const textTokens = significantTokens(text);
  if (refTokens.size < 2 || textTokens.size < 5) return { ok: true, shared: [], enough: false };

  const shared = tokensOverlap(refTokens, text);
  const entities = titleEntities(title);
  // menção só ao veículo/host ("Segundo a Exame") não é evidência (#8594)
  const h = fold(host);
  const notHost = (t: string) => t !== h;
  const sharedNoHost = shared.filter(notHost);
  const sharedEntities = tokensOverlap(entities, text).filter(notHost);
  const all = [...new Set([...sharedNoHost, ...sharedEntities])];
  return { ok: sharedNoHost.length >= 2 || sharedEntities.length >= 1, shared: all, enough: true };
}

export function summaryMatchesArticle(input: SummaryMatchInput): SummaryMatchResult {
  const summary = (input.summary ?? "").trim();
  const title = (input.title ?? "").trim();
  const url = (input.url ?? "").trim();
  if (!summary) return { ok: true, reason: "no-summary", shared: [] };

  const parts = summary.split(SEP_RE).map((s) => s.trim());
  const longParts = parts.filter((s) => s.length >= MIN_SEGMENT_CHARS);
  if (parts.length >= 3 && longParts.length >= 2) {
    // digest de várias matérias: o primeiro trecho precisa casar sozinho
    const first = matchText(title, url, longParts[0]);
    if (!first.enough) return { ok: true, reason: "insufficient-evidence", shared: [] };
    return first.ok
      ? { ok: true, reason: "ok", shared: first.shared }
      : { ok: false, reason: "multi-story-digest", shared: [] };
  }

  const r = matchText(title, url, summary);
  if (!r.enough) return { ok: true, reason: "insufficient-evidence", shared: [] };
  return r.ok
    ? { ok: true, reason: "ok", shared: r.shared }
    : { ok: false, reason: "no-overlap", shared: [] };
}

export type DiscardReason = "multi-story-digest" | "matches-other-article";

export interface DiscardDecision {
  discard: boolean;
  reason?: DiscardReason;
  /** URL do outro artigo do lote com que o summary casa (matches-other-article). */
  otherUrl?: string;
}

/**
 * Decide se o summary deve ser DESCARTADO (#8594). Só com evidência POSITIVA
 * de troca: (a) digest multi-matéria cujo 1º trecho não casa com o item, ou
 * (b) summary sem relação com o próprio item mas que casa claramente com
 * OUTRO título/URL do mesmo lote. `no-overlap` simples NUNCA descarta —
 * paráfrase legítima ("A empresa apresentou um novo modelo…") não tem
 * sobreposição léxica; isso só vira warn no lint.
 */
export function shouldDiscardSummary(
  article: SummaryMatchInput,
  batch: SummaryMatchInput[] = [],
): DiscardDecision {
  const own = summaryMatchesArticle(article);
  if (own.ok) return { discard: false };
  if (own.reason === "multi-story-digest") return { discard: true, reason: "multi-story-digest" };
  const summary = (article.summary ?? "").trim();
  for (const other of batch) {
    if (!other.url || other.url === article.url) continue;
    const m = matchText((other.title ?? "").trim(), other.url, summary);
    if (m.enough && m.ok && m.shared.length >= 2) {
      return { discard: true, reason: "matches-other-article", otherUrl: other.url };
    }
  }
  return { discard: false };
}
