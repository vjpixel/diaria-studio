/**
 * story-continuation.ts (#11897)
 *
 * DESTAQUE da edição que é CONTINUAÇÃO de uma história que a diar.ia.br já
 * publicou nos últimos `STORY_CONTINUATION_WINDOW_DAYS` dias, com URL nova e
 * fato novo. Caso real 261103: o D1 ("Só o Claude Opus 5.5 supera a IA aberta
 * da Mistral no teste às cegas", mistral.ai/news/mistral-large-4-oss/) conta a
 * abertura dos pesos do Mistral Large 4, cujo anúncio já tinha saído no D3 de
 * 261007 (mistral.ai/news/mistral-large-4/). Nenhum check acusou: a URL é nova,
 * o título não cita o produto (só o concorrente), o fato não repete e o
 * `story-twice-in-edition` só olha as últimas 3 edições.
 *
 * Diferente dos vizinhos, que pedem CORTE (`story-twice-in-edition`,
 * `study-source-recurrence`, #11763): continuação com fato novo é legítima. O
 * aviso é informativo, para o texto poder citar a edição anterior ou não
 * repetir o contexto já dado. Nunca bloqueia nem remove nada.
 *
 * Heurística determinística, sem LLM. Um destaque casa um item passado
 * (destaque ou pool, fora das seções de formato deliberado) por um de dois
 * sinais:
 *   1. produto+versão (`extractVersionedProducts`, o mesmo extrator do MESMO
 *      FATO #9100) que é o ASSUNTO do destaque — o 1º citado no lead (1ª
 *      frase do texto), nunca o do título, que costuma citar o concorrente
 *      ("Só o Claude Opus 5.5 supera…") — contra o 1º produto do título ou do
 *      lead do item passado. Licença ("Apache 2.0") não conta.
 *      Variantes nomeadas diferentes ("GPT-6.1 Sol" × "GPT-6.1 Astra") não
 *      casam;
 *   2. URL que continua a outra no mesmo host: o último segmento de um path é
 *      o do outro mais um sufixo (`mistral-large-4` → `mistral-large-4-oss`).
 *
 * Pura, sem I/O: quem lê os arquivos é a invariante `story-continuation`
 * (`invariant-checks/stage-4.ts`).
 */
import { extractVersionedProducts, extractProductVariants } from "./same-fact-check.ts";
import { STORY_TWICE_EXCLUDED_SECTION_RE, type StoryItem, type PastStoryItem } from "./story-twice-in-edition.ts";
import { canonicalize } from "./url-utils.ts";

/** Janela (dias) de edições passadas consideradas (mesma do #11763). */
export const STORY_CONTINUATION_WINDOW_DAYS = 30;

export interface StoryContinuationWarning {
  item_label: string;
  item_title: string;
  item_url: string;
  matched_edition: string;
  matched_label: string;
  matched_title: string;
  matched_url: string;
  /** `produto: large 4` ou `url: mistral-large-4 → mistral-large-4-oss`. */
  signal: string;
}

/** Segmento de slug mínimo para o sinal de URL (evita `news`, `blog`, `p`). */
const MIN_SLUG_LEN = 8;

/**
 * 1ª frase do texto do item, sem as linhas de link (o bloco do destaque traz a
 * manchete como `**[título](url)**`) e sem marcação.
 */
export function leadSentence(summary: string | undefined): string {
  if (!summary) return "";
  const para = summary
    .split(/\n\s*\n/)
    .map((p) =>
      p
        .split("\n")
        .filter((l) => !/\[[^\]]*\]\(https?:\/\/[^)]*\)/.test(l))
        .join(" ")
        .replace(/[*_`]/g, "")
        .trim(),
    )
    .find((p) => p.length > 0);
  if (!para) return "";
  return para.split(/(?<=[.!?])\s+(?=\p{Lu})/u)[0];
}

/**
 * Licença com versão ("Apache 2.0", "GPL 3") não é assunto de história: no
 * acervo, "sob licença Apache 2.0" no lead casava dois lançamentos abertos sem
 * relação (261005 Aleph Alpha × 260921 Bonsai 2).
 */
const NON_SUBJECT_WORDS = new Set(["apache", "gpl", "lgpl", "agpl", "mit", "bsd", "cc", "mpl", "licença", "licenca", "license"]);

/**
 * Produto+versão que é o ASSUNTO do texto: o 1º citado. O lead e o título
 * costumam nomear concorrentes depois do sujeito ("A Mistral lançou o Large 4
 * … que o Claude Opus 5.5 e o GPT-6 Astra recusam"); medido no acervo
 * (42 edições, 260901–261103), aceitar qualquer produto citado dava 13 avisos,
 * quase todos por concorrente mencionado; com o 1º produto do lead (e sem
 * licença), 6, todos continuações reais (GPT-6 Astra, Gemini 3.8 Live,
 * Gemini 4 Argon, Mistral Large 4).
 */
function firstProduct(text: string): { product: string; variant?: string } | null {
  const variants = extractProductVariants(text);
  for (const product of extractVersionedProducts(text)) {
    if (NON_SUBJECT_WORDS.has(product.split(" ")[0])) continue;
    return { product, variant: variants.get(product) };
  }
  return null;
}

/**
 * Assunto do destaque: 1º produto do LEAD, nunca do título. O título do
 * destaque é escrito para o clique e muitas vezes nomeia o concorrente, não o
 * sujeito (261103: "Só o Claude Opus 5.5 supera a IA aberta da Mistral…";
 * 260916: "DeepSeek quase iguala GPT-6 Astra…"). Lead sem produto = sem sinal
 * de produto (o de URL ainda vale).
 */
function subjectProducts(it: StoryItem): Array<{ product: string; variant?: string }> {
  const p = firstProduct(leadSentence(it.summary));
  return p ? [p] : [];
}

/** Assunto do item passado: 1º produto do título e 1º do lead. */
function pastSubjectProducts(it: StoryItem): Array<{ product: string; variant?: string }> {
  return [firstProduct(it.title), firstProduct(leadSentence(it.summary))].filter(
    (p): p is { product: string; variant?: string } => p !== null,
  );
}

function hostAndSlug(url: string): { host: string; slug: string } | null {
  try {
    const u = new URL(url);
    const segs = u.pathname.split("/").filter(Boolean);
    const slug = (segs[segs.length - 1] ?? "").toLowerCase().replace(/\.html?$/, "");
    return { host: u.hostname.toLowerCase().replace(/^www\./, ""), slug };
  } catch {
    return null;
  }
}

/** O slug de uma URL continua o da outra no mesmo host? Devolve o par ou null. */
export function slugContinuation(a: string, b: string): string | null {
  const x = hostAndSlug(a);
  const y = hostAndSlug(b);
  if (!x || !y || x.host !== y.host || x.slug === y.slug) return null;
  const [short, long] = x.slug.length < y.slug.length ? [x.slug, y.slug] : [y.slug, x.slug];
  if (short.length < MIN_SLUG_LEN || !short.includes("-")) return null;
  return long.startsWith(`${short}-`) ? `${y.slug} → ${x.slug}` : null;
}

function sharedProduct(
  mine: Array<{ product: string; variant?: string }>,
  theirs: Array<{ product: string; variant?: string }>,
): string | null {
  for (const a of mine) {
    for (const b of theirs) {
      if (a.product !== b.product) continue;
      if (a.variant !== undefined && b.variant !== undefined && a.variant !== b.variant) continue;
      return `produto: ${a.product}`;
    }
  }
  return null;
}

/**
 * Para cada destaque, o item passado MAIS RECENTE que conta a mesma história
 * (no máximo 1 aviso por destaque). Mesma URL canônica fica de fora (é caso do
 * dedup por URL).
 */
export function findStoryContinuations(
  highlights: StoryItem[],
  past: PastStoryItem[],
): StoryContinuationWarning[] {
  const candidates = past
    .filter((p) => p.highlight || !STORY_TWICE_EXCLUDED_SECTION_RE.test(p.label))
    .map((p) => ({ p, products: pastSubjectProducts(p) }))
    .sort((a, b) => b.p.aammdd.localeCompare(a.p.aammdd));
  const out: StoryContinuationWarning[] = [];
  for (const h of highlights) {
    const key = canonicalize(h.url);
    const subject = subjectProducts(h);
    for (const { p, products } of candidates) {
      if (canonicalize(p.url) === key) continue;
      const slug = slugContinuation(h.url, p.url);
      const signal = sharedProduct(subject, products) ?? (slug ? `url: ${slug}` : null);
      if (!signal) continue;
      out.push({
        item_label: h.label, item_title: h.title, item_url: h.url,
        matched_edition: p.aammdd, matched_label: p.label, matched_title: p.title, matched_url: p.url,
        signal,
      });
      break;
    }
  }
  return out;
}

/** Linha informativa do gate 4 (não pede corte). */
export function formatStoryContinuationWarning(w: StoryContinuationWarning): string {
  return `ℹ️ Destaque continua história publicada em ${w.matched_edition}: [${w.item_label}] “${w.item_title}” (${w.item_url}) segue ${w.matched_label} “${w.matched_title}” (${w.matched_url}; sinal: ${w.signal}). Fato novo é legítimo: no texto, citar a edição anterior ou não repetir o contexto já dado.`;
}
