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
 * Três sinais, todos conservadores (o limiar é deliberadamente alto pra evitar
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
 *       agente A" vs "OpenAI lança agente B" não pode casar. Vale sem limite
 *       de tempo, por isso o léxico de (B) NÃO ganhou os termos do (C) (#8666
 *       review: "violação" em HACK fazia "processada por violação de direitos
 *       autorais" casar com "processada por violação de patentes").
 *   (C) #8666: MESMA EMPRESA + 1 CONCEITO FORTE compartilhado, SÓ em janela
 *       curta (intra-edição ou ≤2 dias ÚTEIS seg–sex — a edição anterior e a
 *       de antes dela, `STRONG_CONCEPT_MAX_DISTANCE_DAYS`; #9565: sexta →
 *       segunda conta 1, não 3).
 *       Conceito forte = evento raro e específico (invasão SOFRIDA/realizada,
 *       vazamento de DADOS), em que a mesma empresa sofrer DOIS desses em 48h
 *       é muito menos provável que a mesma história reaparecer em outro
 *       veículo/idioma. Caso real: D1 de 260922 ("OpenAI foi invadida por
 *       hackers...") repetiu o D1 de 260921 ("Claude ajudou a invadir a
 *       OpenAI...") — só 1 conceito em comum, (B) não casava. Como (C) REMOVE
 *       artigo, o léxico forte é estreito (na dúvida, fica fora) e os DOIS
 *       lados precisam expressar o conceito por um termo forte — ver
 *       `strongEventConcepts`. Fora do forte: `hack`/`hacks`/`hacking`/
 *       `hacker` puros ("5 ChatGPT hacks", "growth hacking", "reward
 *       hacking"), `invade`/`invadem` figurativos ("Gemini invade o Android"),
 *       `ataque`/`attack`, `violação`, `breach` sem "data", e vazamento sem
 *       pista de dados ("OpenAI vaza detalhes do GPT-6"). Sem informação de
 *       distância (`opts.distanceDays` ausente) (C) nunca dispara: o default
 *       segue conservador (≥2 conceitos).
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
// LEAK/HACK de (B): idênticos ao léxico anterior ao #8666, menos `breach`
// fora de "data breach" (filtrado em `conceptTokens` — "breach of contract"
// não é invasão). (B) vale sem limite de tempo, então nenhum termo novo entra
// aqui: só pode REMOVER casamento que existia, nunca criar um (#8666 review).
addConcept("LEAK", ["vazamento", "vaza", "vazou", "vazados", "leak", "leaks", "leaked"]);
addConcept("HACK", ["invasao", "invadiu", "invade", "hack", "hacked", "hacks", "hacker", "hackers", "ataque", "attack", "attacks", "breach", "furar"]);
addConcept("GOVT", ["governo", "governos", "government", "governments"]);
addConcept("ROGUE", ["rogue", "desobedece", "desobedecia", "mentia", "misbehavior", "misaligned", "desalinhado"]);
addConcept("IPO", ["ipo", "prospecto", "prospectus"]);
addConcept("FUNDING", ["rodada", "investimento", "funding", "raises", "raised", "capta", "captou", "valuation", "avaliacao"]);
addConcept("FINE", ["multa", "multada", "fined", "fine", "penalty"]);

/**
 * #8666: "hack" coloquial — "growth hack", "life hack", "productivity hack"
 * — não é invasão. Token anterior a "hack(s)" nesta lista anula o termo.
 */
const COLLOQUIAL_HACK_PREFIX = new Set(["growth", "life", "productivity", "produtividade", "career", "carreira", "study", "estudo"]);

/** `breach` só conta como invasão colado em "data" ("data breach", "breached data"). */
const BREACH_TOKENS = new Set(["breach", "breached", "breaches"]);

/** Tokens normalizados em ORDEM (o sinal C precisa da vizinhança). */
function orderedTokens(title: string): string[] {
  return rawWords(stripVehicle(title)).map(norm);
}

function adjacentTo(toks: string[], i: number, word: string): boolean {
  return toks[i - 1] === word || toks[i + 1] === word;
}

/** Tokens de conceito, sem o "hack" coloquial e sem `breach` fora de "data breach". */
function conceptTokens(title: string): string[] {
  const toks = orderedTokens(title);
  return toks.filter((t, i) => {
    if ((t === "hack" || t === "hacks") && i > 0 && COLLOQUIAL_HACK_PREFIX.has(toks[i - 1])) return false;
    if (BREACH_TOKENS.has(t) && !adjacentTo(toks, i, "data")) return false;
    return true;
  });
}

export function eventConcepts(title: string): Set<string> {
  const out = new Set<string>();
  for (const t of conceptTokens(title)) {
    const c = CONCEPT_LEXICON[t];
    if (c) out.add(c);
  }
  return out;
}

/**
 * #8666: léxico FORTE de HACK do sinal (C) — só formas que significam invasão
 * SOFRIDA ou REALIZADA. Fora de propósito: `hack`/`hacks`/`hacking`/`hacker`/
 * `hackers` puros (coloquial: "5 ChatGPT hacks", "growth hacking", "reward
 * hacking"), `ataque`/`attack` (amplo: "OpenAI ataca Google"), `violação`
 * (jurídico: "violação de patentes") e qualquer forma de `invadir` sem
 * contexto (figurativo: "Gemini invade o Android", "ChatGPT invadiu as
 * escolas" — #9615 estendeu ao pretérito/particípio).
 */
const STRONG_HACK_TOKENS = new Set([
  "hacked", "hackeada", "hackeado", "hackeadas", "hackeados", "hackearam", "hackeou",
  // `invadiu`/`invadiram`/`invadida(s)`/`invadido(s)` saíram daqui no #9615 —
  // o pretérito é tão figurativo quanto o presente ("ChatGPT invadiu as
  // escolas") e agora passa pelo caminho contextual (`CONTEXTUAL_INVADE_TOKENS`).
  "invasao", "invasoes", "ciberataque", "cyberattack",
  "intrusion", "intrusao",
  // Plurais `ciberataques`/`cyberattacks` ficam FORA de propósito (re-review
  // #9560): no plural o termo é quase sempre genérico/defensivo ("evitar
  // ciberataques", "risco de ciberataques autônomos"), não um incidente.
]);

/**
 * #8666 (re-review #9560): palavra defensiva/de risco nos 1–3 tokens ANTES do
 * termo forte anula o termo — "proteção contra vazamento de dados", "defend
 * against cyberattacks", "risco de ciberataque" falam de prevenção/ameaça, não
 * de um incidente. "após" NÃO é defensivo ("após vazamento de dados internos"
 * é incidente real).
 */
const DEFENSIVE_CUES = new Set([
  "evitar", "evita", "evitam", "contra", "protecao", "proteger", "protege", "protegem",
  "defender", "defende", "defend", "defends", "defending", "defense", "defence", "against",
  "prevent", "prevents", "prevenir", "previne", "prevencao", "risco", "riscos", "risk", "risks",
  "alerta", "alertas", "alerts", "warns", "warning", "ameaca", "ameacas", "threat", "threats",
]);

function defensiveBefore(toks: string[], i: number): boolean {
  return toks.slice(Math.max(0, i - 3), i).some((x) => DEFENSIVE_CUES.has(x));
}

/**
 * #8666: formas de "invadir" ambíguas (literal × figurativo). Só contam como
 * forte com CONTEXTO de segurança perto do verbo (3 tokens):
 *   - objeto de segurança inequívoco DEPOIS ("invadir contas", "invade
 *     servidores") ou, no particípio, ANTES ("contas invadidas", #9615); ou
 *   - agente de segurança em qualquer lado ("invadida por hackers", #9615); ou
 *   - "ajudou/ajuda/ajudar a invadir" + EMPRESA ("Claude ajudou a invadir a
 *     OpenAI" — o caso real de 260921, cúmplice de invasão).
 * Escolhas documentadas (re-review #9560): "ajuda a invadir o mercado" não
 * conta (sem empresa/objeto depois); "para invadir" sozinho não basta;
 * `sistema(s)`, `banco(s)` e `rede(s)` ficaram fora dos objetos por serem
 * ambíguos ("invadir sistemas de saúde", "bancos de dados", "redes sociais").
 * Título com outro termo forte já conta por ele.
 */
const CONTEXTUAL_INVADE_TOKENS = new Set([
  "invadir", "invade", "invadem", "invadirem",
  // #9615: pretérito e particípio também são ambíguos ("ChatGPT invadiu as
  // escolas", "salas de aula invadidas pela IA").
  "invadiu", "invadiram", "invadida", "invadido", "invadidas", "invadidos",
]);
/**
 * #9615: particípio = voz passiva — o objeto invadido vem ANTES ("contas da
 * OpenAI foram invadidas"), então para estas formas o objeto de segurança
 * também vale nos 4 tokens anteriores (cabe "{objeto} da {empresa} foram").
 */
const PARTICIPLE_INVADE_TOKENS = new Set(["invadida", "invadido", "invadidas", "invadidos"]);
/**
 * #9615: AGENTE de segurança a até 3 tokens do verbo (qualquer lado) torna a
 * invasão literal — "OpenAI foi invadida por hackers", "Hackers invadiram a
 * Microsoft". `hacker(s)` sozinho não é forte (coloquial), mas colado a
 * "invadir" é inequívoco.
 */
const INVADE_SECURITY_AGENTS = new Set([
  "hacker", "hackers", "criminosos", "cibercriminosos", "invasores", "atacantes",
  "attackers", "ransomware", "malware",
]);
const INVADE_HELP_VERBS = new Set(["ajudou", "ajuda", "ajudar", "ajudam", "ajudaram", "ajudando"]);
const INVADE_SECURITY_OBJECTS = new Set([
  "conta", "contas", "servidor", "servidores",
  "computador", "computadores", "dispositivo", "dispositivos", "celular", "celulares",
  "email", "emails",
]);

/**
 * #8666: vazamento só é forte com pista de DADOS/segurança no mesmo título —
 * "OpenAI vaza detalhes do GPT-6" (vazamento de produto) não é. "data" (EN)
 * só vale perto de um termo INGLÊS de vazamento ("data leak", "leaked user
 * data"): em PT "data" é DATA DE CALENDÁRIO ("vaza data de lançamento").
 */
const STRONG_LEAK_TOKENS = new Set([
  "vazamento", "vazamentos", "vaza", "vazam", "vazou", "vazaram", "vazados", "vazadas", "leak", "leaks", "leaked",
]);
const ENGLISH_LEAK_TOKENS = new Set(["leak", "leaks", "leaked"]);
const LEAK_DATA_CUES = new Set([
  "dados", "credenciais", "senha", "senhas", "credentials", "password", "passwords",
]);
/**
 * #9615: `usuário(s)`/`user(s)` só é pista de dados como POSSUIDOR ("dados de
 * usuários", "senhas de usuários", "users' data" via `data`) — com
 * "de/dos/das/of" logo antes. "vaza recurso do Gemini para usuários beta" é
 * vazamento de PRODUTO.
 */
const LEAK_USER_CUES = new Set(["usuario", "usuarios", "user", "users"]);
const LEAK_USER_POSSESSIVE = new Set(["de", "dos", "das", "of"]);
/**
 * #9615: a pista de dados precisa estar a até 4 tokens do termo de vazamento
 * (qualquer lado) — antes, qualquer posição do título acendia a pista.
 */
const LEAK_CUE_WINDOW = 4;

function leakCueAt(toks: string[], j: number): boolean {
  const x = toks[j];
  if (LEAK_DATA_CUES.has(x)) return true;
  return LEAK_USER_CUES.has(x) && LEAK_USER_POSSESSIVE.has(toks[j - 1] ?? "");
}

/**
 * Conceitos FORTES (#8666) expressos no título — habilitam o sinal (C).
 * HACK: termo de `STRONG_HACK_TOKENS`, "data breach", ou "invadir" com
 * contexto de segurança. LEAK: termo de vazamento + pista de dados na
 * vizinhança (`LEAK_CUE_WINDOW` tokens, #9615).
 */
export function strongEventConcepts(title: string): Set<string> {
  const toks = orderedTokens(title);
  const out = new Set<string>();
  let leak = false;
  toks.forEach((t, i) => {
    const defensive = defensiveBefore(toks, i);
    if (STRONG_HACK_TOKENS.has(t)) {
      if (!defensive) out.add("HACK");
    } else if (BREACH_TOKENS.has(t) && adjacentTo(toks, i, "data")) {
      if (!defensive) out.add("HACK");
    } else if (CONTEXTUAL_INVADE_TOKENS.has(t) && !defensive) {
      const after = toks.slice(i + 1, i + 4);
      const before = toks.slice(Math.max(0, i - 3), i);
      const helped = toks[i - 1] === "a" && INVADE_HELP_VERBS.has(toks[i - 2] ?? "");
      const object =
        after.some((x) => INVADE_SECURITY_OBJECTS.has(x)) ||
        (PARTICIPLE_INVADE_TOKENS.has(t) &&
          toks.slice(Math.max(0, i - 4), i).some((x) => INVADE_SECURITY_OBJECTS.has(x)));
      const agent = [...before, ...after].some((x) => INVADE_SECURITY_AGENTS.has(x));
      const company = after.some((x) => Object.hasOwn(EVENT_COMPANY_ALIASES, x));
      if (object || agent || (helped && company)) out.add("HACK");
    }
    if (STRONG_LEAK_TOKENS.has(t) && !defensive) {
      // #9615: pistas só na vizinhança do termo de vazamento. "data" só vale
      // perto de termo INGLÊS ("data leak", "leaked user data") — em PT "vaza
      // data de lançamento" é data de calendário.
      const english = ENGLISH_LEAK_TOKENS.has(t);
      for (let j = Math.max(0, i - LEAK_CUE_WINDOW); j <= Math.min(toks.length - 1, i + LEAK_CUE_WINDOW); j++) {
        if (j === i) continue;
        if (leakCueAt(toks, j) || (english && toks[j] === "data")) leak = true;
      }
    }
  });
  if (leak) out.add("LEAK");
  return out;
}

/**
 * #8666: distância máxima entre os dois títulos para o sinal (C) — 0 = mesma
 * edição, 1 = edição anterior, 2 = a de antes dela. #9565: a unidade é DIA
 * ÚTIL (seg–sex, `editionBusinessDaysBefore`), não dia de calendário — a
 * diar.ia.br sai seg–sex, então sexta → segunda = 1 (eram 3 e o (C) não
 * pegava a história de sexta repetida na segunda). Feriados não são
 * descontados: após um feriado a janela encolhe em 1 edição (conservador).
 */
export const STRONG_CONCEPT_MAX_DISTANCE_DAYS = 2;

export interface SameEventOptions {
  /**
   * Distância em dias ÚTEIS (seg–sex, #9565) entre as edições dos dois
   * títulos (0 = intra-edição) — ver `editionBusinessDaysBefore`.
   * Ausente = desconhecida → o sinal (C) não dispara (conservador).
   */
  distanceDays?: number;
}

/** #8666: opções para comparar dois títulos da MESMA edição (habilita o sinal C). */
export const SAME_EDITION: Readonly<SameEventOptions> = Object.freeze({ distanceDays: 0 });

/** Mínimo de conceitos de evento compartilhados no sinal (B). */
export const EVENT_CONCEPT_MIN_SHARED = 2;

export interface EventMatch {
  /**
   * Sinal que casou: `distinctive_name` (A1/A2), `event_concepts` (B) ou
   * `strong_concept` (C, #8666 — só com `opts.distanceDays` ≤
   * `STRONG_CONCEPT_MAX_DISTANCE_DAYS`).
   */
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
 * suficiente (default seguro: na dúvida, NÃO remove). Sinais A1/A2/B valem
 * sempre; o (C) (#8666, mesma empresa + 1 conceito forte) só com
 * `opts.distanceDays` conhecido e ≤ `STRONG_CONCEPT_MAX_DISTANCE_DAYS` —
 * use `SAME_EDITION` para dois títulos da mesma edição.
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
 * REMOVÍVEL (A1/B/C) a qualquer match fraco (A2) — #9328: devolver o 1º match
 * deixava um A2 anterior esconder um A1 posterior, e o Pass-1f só marcava.
 * Sem match removível, devolve o 1º fraco. #8666: entrada como objeto
 * `{ title, distanceDays }` repassa a distância a `sameEvent` (habilita C);
 * string pura = distância desconhecida (C desligado).
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

/** AAMMDD → epoch ms (UTC), ou undefined se inválida (inclusive data que "rola", ex: 260231). */
function aammddToMs(x: string): number | undefined {
  const m = /^(\d{2})(\d{2})(\d{2})$/.exec(x);
  if (!m) return undefined;
  const y = 2000 + Number(m[1]);
  const mo = Number(m[2]) - 1;
  const day = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo, day));
  if (dt.getUTCMonth() !== mo || dt.getUTCDate() !== day) return undefined;
  return dt.getTime();
}

/**
 * #8666: quantos dias `past` está ANTES de `current` (positivo = passado,
 * 0 = mesma data, negativo = futuro), ou undefined se alguma for inválida.
 */
export function editionDaysBefore(past: string, current: string): number | undefined {
  const mp = aammddToMs(past);
  const mc = aammddToMs(current);
  if (mp === undefined || mc === undefined) return undefined;
  return Math.round((mc - mp) / 86_400_000);
}

/**
 * #9565: quantos dias ÚTEIS (seg–sex) `past` está antes de `current` — conta
 * os dias de semana em (past, current]. Sexta → segunda = 1, quinta → segunda
 * = 2, sexta → sexta seguinte = 5. Edição estritamente anterior nunca vale 0
 * (piso 1, ex: edição especial de sábado → domingo), pra não virar
 * "intra-edição". Mesma data = 0; futuro = valor negativo (dias de
 * calendário, só o sinal importa); undefined se alguma data for inválida.
 * Feriados não são descontados.
 */
export function editionBusinessDaysBefore(past: string, current: string): number | undefined {
  const d = editionDaysBefore(past, current);
  if (d === undefined || d <= 0) return d;
  const startDow = new Date(aammddToMs(past)!).getUTCDay(); // 0 = domingo
  let count = Math.floor(d / 7) * 5;
  for (let i = 1; i <= d % 7; i++) {
    const dow = (startDow + i) % 7;
    if (dow !== 0 && dow !== 6) count++;
  }
  return Math.max(1, count);
}

/** #8666: distância em dias entre duas datas AAMMDD (≥0, sem sinal), ou undefined se alguma for inválida. */
export function editionDistanceDays(a: string, b: string): number | undefined {
  const d = editionDaysBefore(a, b);
  return d === undefined ? undefined : Math.abs(d);
}

/**
 * #8666: título → menor distância em dias ÚTEIS (#9565,
 * `editionBusinessDaysBefore`) até `currentAammdd`, a partir de
 * pares (título, AAMMDD da edição). Título em mais de uma edição fica com a
 * mais próxima. `currentAammdd` ausente/inválido → mapa vazio (sinal C off).
 *
 * Só edições ESTRITAMENTE anteriores à corrente entram: a própria edição
 * corrente (self-match num re-run, quando ela já está em past-editions.md) e
 * edições MAIS NOVAS que ela (re-run de uma edição antiga) ficam fora — com
 * distância absoluta elas virariam "passado ≤2 dias" e o sinal (C) removeria
 * artigos contra o futuro.
 */
export function minDistanceByTitle(
  dated: ReadonlyArray<{ title: string; aammdd: string }>,
  currentAammdd: string | null | undefined,
): Map<string, number> {
  const out = new Map<string, number>();
  if (!currentAammdd) return out;
  for (const { title, aammdd } of dated) {
    const d = editionBusinessDaysBefore(aammdd, currentAammdd);
    if (d === undefined || d <= 0) continue;
    const prev = out.get(title);
    if (prev === undefined || d < prev) out.set(title, d);
  }
  return out;
}
