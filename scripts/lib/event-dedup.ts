/**
 * lib/event-dedup.ts (#9249)
 *
 * Dedup por TEMA/EVENTO entre dois títulos — complementa os passes por URL,
 * Levenshtein e Jaccard do `dedup.ts`/`dedup-intra-edition.ts`, que deixam
 * passar matérias diferentes sobre o mesmo fato quando o vocabulário diverge
 * (PT vs EN, ângulo distinto). Casos reais da edição 261001 (gate 4):
 *
 *   1. RADAR "OpenAI launches Dots, always-on AI agent coworkers..." (VentureBeat)
 *      — "Dots" já era D2 de 260930 ("Introducing Dots").
 *   2. RADAR "OpenAI Pauses Training Its Most Powerful Models After Rogue
 *      Agents Target Government" (Wired) — já coberto em 260929 ("OpenAI
 *      cancelou treino após agente furar a rede").
 *   3. RADAR "Após meses de atrasos, Google anuncia Argon, seu principal modelo
 *      de IA" (CNN) — duplicava o D1 da própria edição ("Gemini 4 Argon: ...").
 *
 * Dois sinais, ambos conservadores (o limiar é deliberadamente alto pra evitar
 * falso positivo — duas histórias DIFERENTES da mesma empresa nunca casam só
 * pela empresa):
 *
 *   (A) NOME PRÓPRIO DISTINTIVO compartilhado (codinome de produto/modelo como
 *       "Dots", "Argon") + empresa compatível. "Distintivo" = palavra
 *       capitalizada no MEIO de um título em caixa de frase (não a 1ª palavra,
 *       não título em Title Case inglês, onde toda palavra é maiúscula),
 *       ≥3 letras, fora da stoplist de empresas/termos genéricos. Empresa
 *       compatível = mesma empresa (aliases de produto resolvidos: Gemini →
 *       google, ChatGPT → openai...) OU um dos lados sem empresa nenhuma.
 *   (B) MESMA EMPRESA + ≥2 CONCEITOS DE EVENTO compartilhados, num léxico
 *       bilíngue PT/EN pequeno e específico (pausa/cancela, treino, processo,
 *       aquisição, demissão, vazamento...). Conceitos genéricos ("lança",
 *       "agente", "modelo") ficam FORA do léxico de propósito — "OpenAI lança
 *       agente A" vs "OpenAI lança agente B" não pode casar.
 *   (C) #8666: MESMA EMPRESA + 1 CONCEITO FORTE compartilhado, SÓ em janela
 *       curta (intra-edição ou ≤2 dias — `STRONG_CONCEPT_MAX_DISTANCE_DAYS`).
 *       Conceito forte = evento raro e específico (invasão/hack, vazamento),
 *       em que a mesma empresa sofrer DOIS desses em 48h é muito menos
 *       provável que a mesma história reaparecer em outro veículo/idioma. Caso
 *       real: D1 de 260922 ("OpenAI foi invadida por hackers...") repetiu o
 *       D1 de 260921 ("Claude ajudou a invadir a OpenAI...") — só 1 conceito
 *       em comum, (B) não casava. O conceito só conta como forte quando os
 *       DOIS lados o expressam por um termo forte (`invadir`, `hacked`,
 *       `breach`, `vazamento`...) — `ataque`/`attack` mapeiam pro mesmo
 *       conceito em (B), mas são amplos demais ("OpenAI ataca Google") pra
 *       decidir sozinhos. Sem informação de distância (`opts.distanceDays`
 *       ausente) (C) nunca dispara: o default segue conservador (≥2
 *       conceitos). "growth hack"/"life hack" não contam; "hackathon" é outro
 *       token e nunca entra no léxico.
 *
 * Puro, sem I/O.
 */

/** Empresas (e aliases de produto → empresa). Chave/valor normalizados. */
export const EVENT_COMPANY_ALIASES: Record<string, string> = {
  openai: "openai", chatgpt: "openai", gpt: "openai", sora: "openai", codex: "openai",
  google: "google", gemini: "google", deepmind: "google", alphabet: "google", bard: "google",
  anthropic: "anthropic", claude: "anthropic",
  meta: "meta", llama: "meta", facebook: "meta", instagram: "meta", whatsapp: "meta",
  microsoft: "microsoft", copilot: "microsoft", bing: "microsoft",
  apple: "apple", siri: "apple",
  amazon: "amazon", aws: "amazon", alexa: "amazon",
  nvidia: "nvidia",
  xai: "xai", grok: "xai",
  deepseek: "deepseek", mistral: "mistral", alibaba: "alibaba", qwen: "alibaba",
  samsung: "samsung", ibm: "ibm", oracle: "oracle", amd: "amd", intel: "intel",
  tesla: "tesla", perplexity: "perplexity", huawei: "huawei", baidu: "baidu",
};

/**
 * Palavras capitalizadas que NÃO são distintivas mesmo no meio da frase:
 * empresas/produtos guarda-chuva (já tratados como empresa), siglas genéricas,
 * países/lugares e palavras PT/EN que aparecem capitalizadas por convenção.
 */
const NON_DISTINCTIVE = new Set<string>([
  ...Object.keys(EVENT_COMPANY_ALIASES),
  "ia", "ias", "ai", "ais", "agi", "api", "apis", "llm", "llms", "pc", "ceo", "cto", "ipo", "s", "eua", "us", "usa", "uk", "ue", "eu",
  "brasil", "brazil", "china", "europa", "europe", "india", "japao", "japan", "australia", "california",
  "pix", "sus", "stf", "governo", "government", "congresso", "congress", "senado", "senate", "casa", "branca", "white", "house",
  "trump", "biden", "lula", "musk", "altman", "amodei", "zuckerberg", "pichai", "nadella",
  "pro", "plus", "max", "ultra", "mini", "nano", "flash", "beta", "app", "apps",
  "ainews", "devday", "the", "and", "for", "our", "what", "they", "por", "los", "las", "new", "novo", "nova",
  "project", "projeto", "veja", "saiba", "entenda", "como", "inteligencia", "intelligence", "artificial",
  "empresas", "saude", "digital", "news", "blog", "world", "labs", "space", "spaces", "cloud", "america", "latina",
  "estados", "unidos", "york", "nueva", "github", "mcp", "agent", "agents", "agente", "agentes", "marketplace", "gateway", "act",
  // Linhas de produto contínuas: geram dezenas de histórias DIFERENTES por
  // mês ("Opus" tutorial vs "Opus" corte de preço) — não discriminam evento.
  "opus", "sonnet", "haiku", "code",
  // #9327: topônimos — título PT em caixa de frase capitaliza lugar no meio da
  // frase, e "Nvidia × Taiwan" casa matérias diferentes. Lugar nunca é evento.
  "taiwan", "coreia", "korea", "sul", "south", "norte", "north", "paulo", "sao", "rio", "janeiro", "minas", "gerais",
  "brasilia", "bahia", "parana", "curitiba", "recife", "fortaleza", "salvador", "manaus", "porto", "alegre", "belo", "horizonte",
  "pernambuco", "ceara", "santa", "catarina", "goias", "amazonia", "nordeste",
  "portugal", "lisboa", "espanha", "spain", "franca", "france", "paris", "alemanha", "germany", "berlim", "berlin",
  "italia", "italy", "reino", "unido", "kingdom", "londres", "london", "irlanda", "ireland", "holanda", "netherlands",
  "suica", "switzerland", "suecia", "sweden", "russia", "ucrania", "ukraine", "israel", "arabia", "saudita", "saudi",
  "emirados", "dubai", "qatar", "catar", "turquia", "singapura", "singapore", "indonesia", "vietna", "vietnam", "tailandia",
  "malasia", "filipinas", "coreano", "chines", "pequim", "beijing", "xangai", "shanghai", "shenzhen", "hong", "kong", "toquio", "tokyo",
  "canada", "mexico", "argentina", "chile", "colombia", "peru", "uruguai", "africa", "nigeria", "quenia", "egito",
  "asia", "oriente", "medio", "vale", "silicio", "silicon", "valley", "washington", "texas", "francisco", "seattle", "nova", "iorque",
  // #9327: plataformas/produtos guarda-chuva — aparecem em dezenas de
  // matérias diferentes por mês; compartilhá-los não indica mesmo evento.
  "youtube", "android", "chrome", "windows", "azure", "excel", "word", "outlook", "office", "teams", "pixel", "iphone", "ipad",
  "mac", "macos", "ios", "watch", "vision", "gmail", "maps", "drive", "docs", "workspace", "play", "store",
  "chatgpt", "linkedin", "tiktok", "twitter", "threads", "reddit", "wikipedia", "spotify", "netflix", "uber",
  "photoshop", "firefly", "slack", "notion", "zoom", "linux", "galaxy", "xbox", "playstation", "kindle", "prime", "echo",
]);

/** Palavra é início de frase (1ª do título ou logo após ":", ".", "?", "!", "—"). */
function sentenceInitialIndexes(title: string): Set<string> {
  const out = new Set<string>();
  const re = /(?:^|[:.?!—–|]\s*)([\p{L}\p{N}]+)/gu;
  for (const m of title.replace(/\[[^\]]*\]/g, " ").trim().matchAll(re)) out.add(m[1]);
  return out;
}

/** Remove sufixo de veículo (" - Saúde Digital News", " / claude.dev Blog"). */
function stripVehicle(title: string): string {
  return title
    .replace(/\s+[-/|]\s+[^-/|]{1,40}$/u, "")
    // "Astra-like performance" cita o produto por comparação, não é o evento.
    .replace(/[\p{L}\p{N}]+-(?:like|style)\b/gu, " ");
}

function norm(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** Divide em palavras preservando a caixa original. */
function rawWords(title: string): string[] {
  return title
    .replace(/\[[^\]]*\]/g, " ") // "[AINews]" e afins
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Set de tokens normalizados (minúsculos, sem acento) do título. */
export function eventTokens(title: string): Set<string> {
  return new Set(rawWords(stripVehicle(title)).map(norm));
}

/** Título em "Title Case" (inglês de manchete): maioria das palavras ≥4 letras capitalizada. */
function isTitleCase(words: string[]): boolean {
  const long = words.filter((w) => w.length >= 4 && /^\p{L}/u.test(w));
  if (long.length < 2) return true; // curto demais pra distinguir — trata como Title Case (conservador)
  const caps = long.filter((w) => /^\p{Lu}/u.test(w)).length;
  return caps / long.length > 0.6;
}

/**
 * Nomes próprios distintivos do título (normalizados). Vazio para títulos em
 * Title Case — ali capitalização não discrimina nada.
 */
export function distinctiveNames(title: string): Set<string> {
  const words = rawWords(stripVehicle(title));
  if (isTitleCase(words)) return new Set();
  return capitalizedNames(title);
}

/**
 * Palavras capitalizadas fora de início de frase e fora da stoplist, mesmo em
 * título Title Case (usado só no caminho estrito "capitalizado nos dois lados").
 */
export function capitalizedNames(title: string): Set<string> {
  const clean = stripVehicle(title);
  const initial = sentenceInitialIndexes(clean);
  const out = new Set<string>();
  for (const w of rawWords(clean)) {
    if (initial.has(w)) continue;
    if (!/^\p{Lu}/u.test(w)) continue;
    if (w.length < 3 || /^\d/.test(w)) continue;
    const n = norm(w);
    if (NON_DISTINCTIVE.has(n)) continue;
    out.add(n);
  }
  return out;
}

export function companiesIn(title: string): Set<string> {
  const out = new Set<string>();
  for (const t of eventTokens(title)) {
    const c = EVENT_COMPANY_ALIASES[t];
    if (c) out.add(c);
  }
  return out;
}

/**
 * Léxico bilíngue de conceitos de EVENTO específicos (token normalizado →
 * conceito). Genéricos (lançar, agente, modelo, IA) ficam fora de propósito.
 */
const CONCEPT_LEXICON: Record<string, string> = {};
function addConcept(concept: string, words: string[]): void {
  for (const w of words) CONCEPT_LEXICON[w] = concept;
}
addConcept("HALT", ["pausa", "pausar", "pausou", "pausam", "pauses", "paused", "pause", "pausing", "suspende", "suspendeu", "suspends", "suspended", "cancela", "cancelou", "cancelar", "cancels", "canceled", "cancelled", "halts", "halted", "halt", "interrompe", "interrompeu", "scraps", "scrapped", "abandona", "abandons"]);
addConcept("TRAIN", ["treino", "treinamento", "treinar", "treina", "training", "trains", "train"]);
addConcept("LAWSUIT", ["processo", "processa", "processada", "processado", "sued", "sues", "lawsuit"]);
addConcept("ACQUIRE", ["compra", "comprar", "comprou", "adquire", "adquiriu", "aquisicao", "acquires", "acquired", "acquisition", "acquiring", "buys", "bought"]);
addConcept("LAYOFF", ["demite", "demitiu", "demissoes", "demissao", "layoffs", "layoff", "lays", "fires", "fired", "cortes"]);
const STRONG_LEAK_WORDS = ["vazamento", "vazamentos", "vaza", "vazou", "vazados", "vazadas", "vazaram", "leak", "leaks", "leaked"];
addConcept("LEAK", STRONG_LEAK_WORDS);
addConcept("HACK", ["ataque", "attack", "attacks", "furar"]);
/**
 * #8666: termos FORTES de invasão/hack — os únicos que habilitam o sinal (C).
 * Mapeiam pro mesmo conceito HACK dos amplos acima, então valem em (B) também.
 */
const STRONG_HACK_WORDS = [
  "invasao", "invasoes", "invadir", "invadiu", "invade", "invadem", "invadida", "invadido", "invadidas", "invadidos",
  "hackear", "hackeou", "hackeada", "hackeado", "hackeadas", "hackeados", "hackeia",
  "hack", "hacked", "hacks", "hacker", "hackers", "hacking",
  "breach", "breached", "breaches", "violacao", "intrusion", "intrusao", "ciberataque", "cyberattack",
];
addConcept("HACK", STRONG_HACK_WORDS);
addConcept("GOVT", ["governo", "governos", "government", "governments"]);
addConcept("ROGUE", ["rogue", "desobedece", "desobedecia", "mentia", "misbehavior", "misaligned", "desalinhado"]);
addConcept("IPO", ["ipo", "prospecto", "prospectus"]);
addConcept("FUNDING", ["rodada", "investimento", "funding", "raises", "raised", "capta", "captou", "valuation", "avaliacao"]);
addConcept("FINE", ["multa", "multada", "fined", "fine", "penalty"]);

/** Termos fortes (token → conceito) que habilitam o sinal (C) (#8666). */
const STRONG_CONCEPT_WORDS: Record<string, string> = {};
for (const w of STRONG_HACK_WORDS) STRONG_CONCEPT_WORDS[w] = "HACK";
for (const w of STRONG_LEAK_WORDS) STRONG_CONCEPT_WORDS[w] = "LEAK";

/**
 * #8666: "hack" coloquial — "growth hack", "life hack", "productivity hack"
 * — não é invasão. Token anterior a "hack(s)" nesta lista anula o termo.
 */
const COLLOQUIAL_HACK_PREFIX = new Set(["growth", "life", "productivity", "produtividade", "career", "carreira", "study", "estudo"]);

/** Tokens de conceito em ORDEM (precisa da vizinhança), sem o "hack" coloquial. */
function conceptTokens(title: string): string[] {
  const toks = rawWords(stripVehicle(title)).map(norm);
  return toks.filter(
    (t, i) => !((t === "hack" || t === "hacks") && i > 0 && COLLOQUIAL_HACK_PREFIX.has(toks[i - 1])),
  );
}

export function eventConcepts(title: string): Set<string> {
  const out = new Set<string>();
  for (const t of conceptTokens(title)) {
    const c = CONCEPT_LEXICON[t];
    if (c) out.add(c);
  }
  return out;
}

/** Conceitos FORTES (#8666) expressos no título por um termo forte. */
export function strongEventConcepts(title: string): Set<string> {
  const out = new Set<string>();
  for (const t of conceptTokens(title)) {
    const c = STRONG_CONCEPT_WORDS[t];
    if (c) out.add(c);
  }
  return out;
}

/**
 * #8666: distância máxima (em dias) entre os dois títulos para o sinal (C)
 * — 0 = mesma edição, 1 = D-1, 2 = D-2.
 */
export const STRONG_CONCEPT_MAX_DISTANCE_DAYS = 2;

export interface SameEventOptions {
  /**
   * Distância em dias entre as edições dos dois títulos (0 = intra-edição).
   * Ausente = desconhecida → o sinal (C) não dispara (conservador).
   */
  distanceDays?: number;
}

/** Mínimo de conceitos de evento compartilhados no sinal (B). */
export const EVENT_CONCEPT_MIN_SHARED = 2;

export interface EventMatch {
  signal: "distinctive_name" | "event_concepts" | "strong_concept";
  shared: string[];
  /**
   * #9293: `false` = evidência fraca (sinal A2 — só um lado nomeia empresa).
   * Consumidores que REMOVEM item (dedup Pass-1f) devem só marcar quando
   * `removable === false`; palavras capitalizadas comuns ("Search", "Index",
   * "Studio") casam por A2 com matéria passada diferente.
   */
  removable: boolean;
}

/**
 * Decide se `a` e `b` cobrem o mesmo evento. `null` = não há evidência
 * suficiente (default seguro: na dúvida, NÃO remove).
 */
export function sameEvent(a: string, b: string, opts: SameEventOptions = {}): EventMatch | null {
  if (!a || !b) return null;
  const compA = companiesIn(a);
  const compB = companiesIn(b);
  const sharedCompanies = [...compA].filter((c) => compB.has(c));
  // (A1) mesma empresa + nome distintivo de um lado presente (qualquer caixa)
  // no outro — "Google anuncia Argon" vs "Gemini 4 Argon: ...".
  if (sharedCompanies.length > 0) {
    const tokA = eventTokens(a);
    const tokB = eventTokens(b);
    const names = new Set<string>();
    for (const n of distinctiveNames(a)) if (tokB.has(n)) names.add(n);
    for (const n of distinctiveNames(b)) if (tokA.has(n)) names.add(n);
    if (names.size > 0) return { signal: "distinctive_name", shared: [...names, ...sharedCompanies], removable: true };
  }

  // (A2) só UM lado nomeia empresa ("Introducing Dots" vs "OpenAI launches
  // Dots, ..."): exige o nome CAPITALIZADO nos dois títulos e distintivo
  // (caixa de frase) em pelo menos um. Dois títulos sem empresa nenhuma nunca
  // casam por aqui — eram o grosso do falso positivo na calibração.
  if (sharedCompanies.length === 0 && (compA.size === 0) !== (compB.size === 0)) {
    const capB = capitalizedNames(b);
    const distinct = new Set([...distinctiveNames(a), ...distinctiveNames(b)]);
    const names = [...capitalizedNames(a)].filter((n) => capB.has(n) && distinct.has(n));
    if (names.length > 0) return { signal: "distinctive_name", shared: names, removable: false };
  }

  // (B) mesma empresa + ≥2 conceitos de evento específicos.
  if (sharedCompanies.length > 0) {
    const cB = eventConcepts(b);
    const shared = [...eventConcepts(a)].filter((c) => cB.has(c));
    if (shared.length >= EVENT_CONCEPT_MIN_SHARED) {
      return { signal: "event_concepts", shared: [...sharedCompanies, ...shared], removable: true };
    }
  }

  // (C) #8666: mesma empresa + 1 conceito FORTE, só em janela curta conhecida.
  const d = opts.distanceDays;
  if (
    sharedCompanies.length > 0 &&
    typeof d === "number" && Number.isFinite(d) && d >= 0 && d <= STRONG_CONCEPT_MAX_DISTANCE_DAYS
  ) {
    const sB = strongEventConcepts(b);
    const strong = [...strongEventConcepts(a)].filter((c) => sB.has(c));
    if (strong.length > 0) {
      return { signal: "strong_concept", shared: [...sharedCompanies, ...strong], removable: true };
    }
  }
  return null;
}

/**
 * Título de `others` que cobre o mesmo evento que `title`. Prefere um match
 * REMOVÍVEL (A1/B) a qualquer match fraco (A2) — #9328: devolver o 1º match
 * deixava um A2 anterior esconder um A1 posterior, e o Pass-1f só marcava.
 * Sem match removível, devolve o 1º fraco.
 */
export function findSameEvent(
  title: string,
  others: ReadonlyArray<string | { title: string; distanceDays?: number }>,
): { title: string; match: EventMatch } | null {
  let weak: { title: string; match: EventMatch } | null = null;
  for (const entry of others) {
    // #8666: entrada com `distanceDays` habilita o sinal (C) para aquele título.
    const o = typeof entry === "string" ? entry : entry.title;
    const distanceDays = typeof entry === "string" ? undefined : entry.distanceDays;
    const m = sameEvent(title, o, { distanceDays });
    if (!m) continue;
    if (m.removable) return { title: o, match: m };
    weak ??= { title: o, match: m };
  }
  return weak;
}

/** #8666: distância em dias entre duas datas AAMMDD (≥0), ou undefined se alguma for inválida. */
export function editionDistanceDays(a: string, b: string): number | undefined {
  const toMs = (x: string): number | undefined => {
    const m = /^(\d{2})(\d{2})(\d{2})$/.exec(x);
    if (!m) return undefined;
    const y = 2000 + Number(m[1]);
    const mo = Number(m[2]) - 1;
    const day = Number(m[3]);
    const dt = new Date(Date.UTC(y, mo, day));
    // Rejeita data que rolou (ex: 260231 → 03/03).
    if (dt.getUTCMonth() !== mo || dt.getUTCDate() !== day) return undefined;
    return dt.getTime();
  };
  const ma = toMs(a);
  const mb = toMs(b);
  if (ma === undefined || mb === undefined) return undefined;
  return Math.round(Math.abs(ma - mb) / 86_400_000);
}

/**
 * #8666: título → menor distância em dias até `currentAammdd`, a partir de
 * pares (título, AAMMDD da edição). Título em mais de uma edição fica com a
 * mais próxima. `currentAammdd` ausente/inválido → mapa vazio (sinal C off).
 */
export function minDistanceByTitle(
  dated: ReadonlyArray<{ title: string; aammdd: string }>,
  currentAammdd: string | null | undefined,
): Map<string, number> {
  const out = new Map<string, number>();
  if (!currentAammdd) return out;
  for (const { title, aammdd } of dated) {
    const d = editionDistanceDays(aammdd, currentAammdd);
    if (d === undefined) continue;
    const prev = out.get(title);
    if (prev === undefined || d < prev) out.set(title, d);
  }
  return out;
}
