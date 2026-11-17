/**
 * stale-highlight.ts (#13313)
 *
 * DESTAQUE que é notícia velha e passa por todos os dedups. Caso real 261117:
 *   - D2 "OpenAI corta pela metade o preço do GPT-6": URL
 *     `openai.com/index/introducing-gpt-6-sol-and-luna/`, já publicada no D2
 *     de 260923 (55 dias antes). A janela do dedup por URL é de 30 dias
 *     (`DEDUP_URL_WINDOW_DAYS`), então ninguém acusou. A página não tem data:
 *     `01-approved.json` trazia `date: 2026-11-14` com `date_unverified: true`,
 *     e o texto da fonte dizia "Update on September 29, 2026".
 *   - D3 "Agentes da OpenAI invadiram sistemas em testes": URL nova (G1), mas o
 *     fato (agentes da OpenAI invadem a Hugging Face e o sistema de saúde da
 *     Austrália) já tinha saído em 260925, 260928 e 261006, todos fora da
 *     janela de 30 dias do `fact-recurrence`/`study-source-recurrence`.
 *
 * Três sinais, todos warning-only (o editor decide no gate 4):
 *   1. `findStaleHighlightRepeats` — destaque × itens publicados nas últimas
 *      `STALE_HIGHLIGHT_WINDOW_DAYS` (84, ~12 semanas):
 *        a. mesma URL canônica publicada há mais de `DEDUP_URL_WINDOW_DAYS`
 *           (até 30 dias o `no-duplicate-urls-vs-past-editions` já acusa);
 *        b. mesmo incidente, também só acima de 30 dias: termo de incidente
 *           (invasão, vazamento, golpe…) na manchete do destaque, o mesmo
 *           grupo de termo no item passado e >= 2 entidades em comum, ao
 *           menos uma que não seja empresa de IA/produto dela.
 *      Até 30 dias, `fact-recurrence`, `story-twice-in-edition` e o dedup
 *      por URL já cobrem; repetir o aviso só somaria ruído.
 *   2. `findSourceStaleDates` — data de atualização/publicação declarada no
 *      texto da fonte ("Update on September 29, 2026", "Atualizado em
 *      29/09/2026") mais de `STALE_SOURCE_DATE_MAX_DAYS` dias antes da edição.
 *   3. destaque com `date_unverified: true` em `01-approved.json` (a invariante
 *      lê o arquivo; aqui só a mensagem).
 *
 * Pura, sem I/O: quem lê os arquivos é `invariant-checks/stage-4.ts`.
 */
import { editionDaysBefore } from "./event-dedup.ts";
import { DEDUP_URL_WINDOW_DAYS } from "./past-editions-extract.ts";
import { STORY_TWICE_EXCLUDED_SECTION_RE, type StoryItem, type PastStoryItem } from "./story-twice-in-edition.ts";
import { canonicalize } from "./url-utils.ts";

/** Janela (dias) da comparação de destaques com o passado: ~12 semanas. */
export const STALE_HIGHLIGHT_WINDOW_DAYS = 84;

/** Data declarada na fonte mais antiga que isto (dias antes da edição) gera aviso. */
export const STALE_SOURCE_DATE_MAX_DAYS = 30;

/** Mínimo de entidades em comum para o sinal de mesmo incidente. */
export const STALE_INCIDENT_MIN_SHARED = 2;

export interface StaleHighlightWarning {
  kind: "url" | "incident";
  item_label: string;
  item_title: string;
  item_url: string;
  /** Edição passada mais recente que casou (AAMMDD). */
  matched_edition: string;
  matched_label: string;
  matched_title: string;
  matched_url: string;
  /** Dias entre a edição passada mais recente que casou e a corrente. */
  days: number;
  /** Edições passadas (AAMMDD, ascendente) que casaram — "5ª cobertura". */
  matched_editions: string[];
  /** `url` ou `incidente: invasao; entidades: openai, australia`. */
  signal: string;
}

const normalize = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/**
 * Grupos de termo de incidente (texto normalizado, sem acento). Os dois lados
 * precisam ter um termo do MESMO grupo: "invadiram" × "vazamento" não casa.
 * Mais largo que o `incident()` do `fact-recurrence` (#11083), que não tem
 * "invadir/invasão" — foi esse o termo do caso 261117.
 */
const INCIDENT_GROUPS: Array<[string, RegExp]> = [
  ["invasao", /\b(invad\w*|invas[aoõ]\w*|hack\w*|breach\w*)\b/],
  ["vazamento", /\b(vazament\w*|vazou|vazaram|vazad\w*|leak\w*)\b/],
  ["ataque", /\b(ataque\w*|ciberataque\w*|cyberattack\w*|ransomware)\b/],
  ["golpe", /\b(golpe\w*|golpista\w*|fraude\w*|scam\w*|phishing)\b/],
  ["deepfake", /\bdeepfakes?\b/],
  ["vulnerabilidade", /\b(vulnerab\w*|cve-\d+)\b/],
];

function incidentGroups(text: string): Set<string> {
  const t = normalize(text);
  return new Set(INCIDENT_GROUPS.filter(([, re]) => re.test(t)).map(([g]) => g));
}

/**
 * Palavras que não identificam um fato: genéricas de IA, geografia ampla
 * (Brasil e EUA atravessam 12 semanas de pauta) e palavras que só aparecem
 * capitalizadas por abrir frase/título.
 */
const ENTITY_STOP = new Set([
  "ia", "ai", "ias", "the", "eua", "usa", "brasil", "estados unidos", "europa", "uniao europeia", "mundo",
  "por que", "por", "que", "isso", "como", "para", "com", "uma", "um", "o", "a", "os", "as", "em", "no", "na",
  "nos", "nas", "de", "do", "da", "se", "segundo", "destaque", "importa", "agentes", "agente", "modelo",
  "modelos", "empresa", "empresas", "governo", "estudo", "pesquisa", "pesquisadores", "centenas", "milhares",
  "api", "apis", "pro", "plus", "max", "app", "apps", "llm", "llms", "ceo", "ceos",
]);

/**
 * Empresa de IA e os produtos dela contam como UMA entidade (o "fornecedor"):
 * "Claude" + "Anthropic" ou "ChatGPT" + "OpenAI" em comum não são 2 sinais,
 * são o mesmo. Medido no acervo (73 edições, ago-nov/2026): sem esse colapso,
 * metade dos avisos vinha só de pares fornecedor+produto ("Claude Cowork chega
 * ao painel do Chrome" × "Hackers usam Claude e Grok contra bancos").
 * Chave = 1ª palavra da entidade normalizada.
 */
const VENDOR_OF: Record<string, string> = {
  openai: "openai", chatgpt: "openai", gpt: "openai", codex: "openai", sora: "openai", altman: "openai",
  anthropic: "anthropic", claude: "anthropic", amodei: "anthropic",
  google: "google", gemini: "google", deepmind: "google", alphabet: "google", pichai: "google",
  meta: "meta", llama: "meta", zuckerberg: "meta", facebook: "meta", instagram: "meta", whatsapp: "meta",
  microsoft: "microsoft", copilot: "microsoft", xai: "xai", grok: "xai", musk: "xai",
  apple: "apple", siri: "apple", amazon: "amazon", alexa: "amazon", nvidia: "nvidia", mistral: "mistral",
};

function entityKey(e: string): { key: string; vendor: boolean } {
  const first = e.split(/[\s-]/)[0];
  const vendor = VENDOR_OF[first];
  return vendor ? { key: `vendor:${vendor}`, vendor: true } : { key: e, vendor: false };
}

/**
 * Entidades do texto: sequências de palavras capitalizadas (Hugging Face,
 * Austrália, OpenAI, GPT-6). A palavra que abre frase só conta se tiver
 * maiúscula interna ou dígito (OpenAI, GPT-6) ou se aparecer capitalizada no
 * meio de alguma frase do mesmo texto: "Agentes da OpenAI…" não vira entidade
 * "agentes", mas "Austrália" no começo de uma frase e no meio de outra vira.
 */
export function extractStaleEntities(text: string): Set<string> {
  const initial = new Set<string>();
  const inner = new Set<string>();
  const strong = (raw: string) => /\d/.test(raw) || /\p{Lu}/u.test(raw.slice(1).replace(/\s.*/, ""));
  for (const seg of text.split(/(?<=[.!?:;])\s+|\n+/)) {
    const start = seg.search(/[\p{L}\p{N}]/u);
    for (const m of seg.matchAll(/(?<![\p{L}\p{N}])\p{Lu}[\p{L}\p{N}-]{2,}(?:\s+\p{Lu}[\p{L}\p{N}-]{1,})*/gu)) {
      const key = normalize(m[0]);
      if (ENTITY_STOP.has(key)) continue;
      if (m.index === start && !strong(m[0])) initial.add(key);
      else inner.add(key);
    }
  }
  const out = new Set(inner);
  for (const k of initial) if (inner.has(k)) out.add(k);
  return out;
}

/** Entidades do texto já colapsadas por fornecedor (chave → rótulo legível). */
function entityKeys(text: string): Map<string, { label: string; vendor: boolean }> {
  const out = new Map<string, { label: string; vendor: boolean }>();
  for (const e of extractStaleEntities(text)) {
    const { key, vendor } = entityKey(e);
    if (!out.has(key)) out.set(key, { label: vendor ? key.slice("vendor:".length) : e, vendor });
  }
  return out;
}

function itemText(it: StoryItem): string {
  return `${it.title}\n${it.summary ?? ""}`;
}

/**
 * Compara cada destaque com os itens publicados (destaques e pool, fora das
 * seções de formato deliberado) nas últimas `windowDays`. No máximo 1 aviso
 * por destaque; URL vence incidente. `past` pode trazer itens mais antigos ou
 * da própria edição: os dois ficam de fora pela data.
 */
export function findStaleHighlightRepeats(
  highlights: StoryItem[],
  past: PastStoryItem[],
  edition: string,
  opts: { windowDays?: number; minDays?: number; minShared?: number } = {},
): StaleHighlightWarning[] {
  const windowDays = opts.windowDays ?? STALE_HIGHLIGHT_WINDOW_DAYS;
  const minDays = opts.minDays ?? DEDUP_URL_WINDOW_DAYS;
  const minShared = opts.minShared ?? STALE_INCIDENT_MIN_SHARED;
  const inWindow = past
    .map((p) => ({ p, days: editionDaysBefore(p.aammdd, edition) }))
    .filter((x): x is { p: PastStoryItem; days: number } =>
      x.days !== undefined && x.days > 0 && x.days <= windowDays && !STORY_TWICE_EXCLUDED_SECTION_RE.test(x.p.label));
  const out: StaleHighlightWarning[] = [];
  for (const h of highlights) {
    const canon = canonicalize(h.url);
    const byUrl = inWindow.filter((x) => x.days > minDays && canonicalize(x.p.url) === canon);
    if (byUrl.length > 0) {
      out.push(build("url", h, byUrl, "url"));
      continue;
    }
    // O incidente precisa estar na MANCHETE do destaque: termo de incidente só
    // no corpo ("contra-ataque", "risco de vazamento") não faz a história ser
    // sobre um incidente.
    const groups = incidentGroups(h.title);
    if (groups.size === 0) continue;
    const keys = entityKeys(itemText(h));
    const byIncident = inWindow
      .filter((x) => x.days > minDays)
      .map((x) => {
        const text = itemText(x.p);
        const sharedGroups = [...incidentGroups(text)].filter((g) => groups.has(g));
        if (sharedGroups.length === 0) return undefined;
        const pastKeys = entityKeys(text);
        const shared = [...keys.entries()].filter(([k]) => pastKeys.has(k));
        // >= minShared entidades distintas, e ao menos 1 que não seja fornecedor:
        // "OpenAI" + "Austrália" casa; "OpenAI" + "ChatGPT" é 1 entidade só.
        if (shared.length < minShared || shared.every(([, v]) => v.vendor)) return undefined;
        return { ...x, signal: `incidente: ${sharedGroups.join(", ")}; entidades: ${shared.map(([, v]) => v.label).join(", ")}` };
      })
      .filter((x): x is { p: PastStoryItem; days: number; signal: string } => x !== undefined);
    if (byIncident.length > 0) {
      const latest = byIncident.reduce((a, b) => (a.days <= b.days ? a : b));
      out.push(build("incident", h, byIncident, latest.signal));
    }
  }
  return out;
}

function build(
  kind: StaleHighlightWarning["kind"],
  h: StoryItem,
  matches: Array<{ p: PastStoryItem; days: number }>,
  signal: string,
): StaleHighlightWarning {
  const latest = matches.reduce((a, b) => (a.days <= b.days ? a : b));
  return {
    kind,
    item_label: h.label,
    item_title: h.title,
    item_url: h.url,
    matched_edition: latest.p.aammdd,
    matched_label: latest.p.label,
    matched_title: latest.p.title,
    matched_url: latest.p.url,
    days: latest.days,
    matched_editions: [...new Set(matches.map((m) => m.p.aammdd))].sort(),
    signal,
  };
}

export function formatStaleHighlightWarning(w: StaleHighlightWarning): string {
  const count = w.matched_editions.length;
  const others = count > 1 ? ` (${count} edições na janela: ${w.matched_editions.join(", ")})` : "";
  if (w.kind === "url") {
    return `🚨 Destaque com notícia velha: [${w.item_label}] “${w.item_title}” (${w.item_url}) já saiu em ${w.matched_edition} ` +
      `(${w.matched_label} “${w.matched_title}”, ${w.days} dias atrás)${others}. A URL passa no dedup de ${DEDUP_URL_WINDOW_DAYS} dias, ` +
      `mas a notícia não é desta semana. Trocar o destaque no gate, salvo fato novo na própria página.`;
  }
  return `🚨 Destaque possivelmente repetido de ${w.days} dias atrás: [${w.item_label}] “${w.item_title}” (${w.item_url}) ` +
    `conta o mesmo incidente de ${w.matched_edition} ${w.matched_label} “${w.matched_title}” (${w.signal})${others}. ` +
    `Heurístico: cortar no gate se não houver fato novo.`;
}

// ---------------------------------------------------------------------------
// Data declarada no texto da fonte
// ---------------------------------------------------------------------------

const EN_MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8,
  september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const PT_MONTHS: Record<string, number> = {
  janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6, julho: 7, agosto: 8,
  setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
};

export interface SourceDateHit {
  /** Trecho que casou, como está na fonte. */
  text: string;
  /** AAAA-MM-DD. */
  iso: string;
  /** Dias antes da edição. */
  days: number;
}

/**
 * Datas de atualização/publicação DECLARADAS no texto da fonte, com o rótulo
 * junto ("Update on September 29, 2026", "Updated: Sep 29, 2026", "Published
 * September 22, 2026", "Atualizado em 29/09/2026", "Publicado em 22 de
 * setembro de 2026"). Data solta no meio do texto não conta: "em março de 2024
 * a empresa…" é contexto, não a idade da página.
 */
export function extractDeclaredSourceDates(text: string): Array<{ text: string; iso: string }> {
  const out: Array<{ text: string; iso: string }> = [];
  const push = (raw: string, y: number, m: number, d: number) => {
    if (!m || m < 1 || m > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return;
    out.push({ text: raw.trim(), iso: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` });
  };
  const EN_LABEL = String.raw`\b(?:updated?|published|posted|last\s+updated)(?:\s+(?:on|at))?\s*:?\s*`;
  for (const m of text.matchAll(new RegExp(EN_LABEL + String.raw`([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})`, "gi"))) {
    push(m[0], Number(m[3]), EN_MONTHS[m[1].toLowerCase()], Number(m[2]));
  }
  for (const m of text.matchAll(new RegExp(EN_LABEL + String.raw`(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})`, "gi"))) {
    push(m[0], Number(m[3]), EN_MONTHS[m[2].toLowerCase()], Number(m[1]));
  }
  for (const m of text.matchAll(new RegExp(EN_LABEL + String.raw`(\d{4})-(\d{2})-(\d{2})`, "gi"))) {
    push(m[0], Number(m[1]), Number(m[2]), Number(m[3]));
  }
  const PT_LABEL = String.raw`\b(?:atualizad[oa]|publicad[oa]|atualiza[cç][aã]o)(?:\s+(?:em|no\s+dia|de))?\s*:?\s*`;
  for (const m of text.matchAll(new RegExp(PT_LABEL + String.raw`(\d{1,2})/(\d{1,2})/(\d{4})`, "gi"))) {
    push(m[0], Number(m[3]), Number(m[2]), Number(m[1]));
  }
  for (const m of text.matchAll(new RegExp(PT_LABEL + String.raw`(\d{1,2})\s+de\s+([\p{L}]+)\s+de\s+(\d{4})`, "giu"))) {
    push(m[0], Number(m[3]), PT_MONTHS[normalize(m[2])], Number(m[1]));
  }
  return out;
}

/**
 * Datas declaradas na fonte mais de `maxDays` dias antes da edição. Data
 * POSTERIOR à edição ou dentro da janela não conta. Ordenadas da mais antiga
 * para a mais recente, sem repetir a mesma data.
 */
export function findSourceStaleDates(
  text: string,
  edition: string,
  maxDays: number = STALE_SOURCE_DATE_MAX_DAYS,
): SourceDateHit[] {
  const seen = new Set<string>();
  const hits: SourceDateHit[] = [];
  for (const d of extractDeclaredSourceDates(text)) {
    if (seen.has(d.iso)) continue;
    seen.add(d.iso);
    const aammdd = d.iso.slice(2, 4) + d.iso.slice(5, 7) + d.iso.slice(8, 10);
    const days = editionDaysBefore(aammdd, edition);
    if (days === undefined || days <= maxDays) continue;
    hits.push({ ...d, days });
  }
  return hits.sort((a, b) => a.iso.localeCompare(b.iso));
}
