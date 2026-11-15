/**
 * scripts/lib/video-pauta.ts (#13090, item 1)
 *
 * Pauta PERENE de vídeo (tutorial, explicador, comparativo) a partir da
 * demanda de busca do Google Keyword Planner (#8366). Lê o que os pulls já
 * gravaram em `data/seo/` — nunca chama a API —, classifica cada termo por
 * INTENÇÃO, junta as variantes do mesmo assunto num TEMA ("como criar imagens
 * com ia" e "como fazer foto com inteligência artificial" são o mesmo vídeo) e
 * ranqueia os temas por volume e competição.
 *
 * Duas fontes de entrada, ambas opcionais:
 *  - `video-keywords-{data}.json`: pull com as sementes próprias de vídeo
 *    (`seed/video-keywords.csv`: "como usar X", "o que é X", "X vs Y");
 *  - `google-keywords-{data}.json`: o pull mensal de sempre (`seed/keywords.csv`).
 * As duas têm o mesmo formato (`google-keyword-pull.ts`); o relatório usa o
 * `kept` (já sem ruído de marca, `partitionIdeas`) e lista à parte as sementes
 * que o pull tirou da tabela por contaminação de marca.
 *
 * Premissas de ranking (registradas aqui porque não vêm de nenhuma regra
 * editorial anterior):
 *  - A demanda de um tema é o MAIOR volume entre as variantes, não a soma: o
 *    Keyword Planner devolve o mesmo número para variantes quase idênticas
 *    (2.900 para "imagens" e "imagem"), e somar contaria a mesma busca duas
 *    vezes. A soma aparece só como coluna informativa.
 *  - A competição do Keyword Planner é a de ANUNCIANTES no Google, não a
 *    dificuldade de ranquear no YouTube. Serve como sinal fraco de saturação,
 *    por isso só desconta o volume (`COMPETITION_FACTOR`), nunca exclui o tema.
 *
 * Puro — sem I/O. O I/O (achar e ler os JSON) fica no CLI
 * `scripts/video-pauta-report.ts`.
 */

import type { KeywordIdea, SeedContamination } from "./google-keyword-planner.ts";

export type VideoIntent = "comparativo" | "explicador" | "tutorial" | "lista" | "outro";

/** Ordem das seções do relatório (e de prioridade da classificação). */
export const VIDEO_INTENTS: readonly VideoIntent[] = ["tutorial", "explicador", "comparativo", "lista", "outro"];

export const INTENT_LABEL: Record<VideoIntent, string> = {
  tutorial: "Tutorial (como usar / como fazer)",
  explicador: "Explicador (o que é / como funciona)",
  comparativo: "Comparativo (X vs Y / qual é melhor)",
  lista: "Lista (melhores / ferramentas / cursos)",
  outro: "Outros (sem formato de vídeo claro)",
};

/** Desconto de volume por competição de anunciantes (ver premissa no topo). */
export const COMPETITION_FACTOR: Record<string, number> = { LOW: 1, MEDIUM: 0.75, HIGH: 0.5 };
const UNKNOWN_COMPETITION_FACTOR = 0.6;

export function normalizeTerm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Classifica a intenção de busca. A ordem importa: "chatgpt ou gemini qual é
 * melhor" é comparativo antes de ser lista; "como funciona o chatgpt" é
 * explicador, não tutorial (os dois começam com "como").
 */
export function classifyIntent(keyword: string): VideoIntent {
  const q = ` ${normalizeTerm(keyword)} `;
  if (/ (vs|versus|x) /.test(q) || / diferenca entre /.test(q) || / comparacao /.test(q)) return "comparativo";
  // "X ou Y" no começo do termo ("chatgpt ou gemini") ou com "qual/melhor" em
  // qualquer posição; "ou" solto no meio de uma frase longa não é comparação.
  if (/^ \S+ ou \S+ /.test(q) || (/ ou /.test(q) && / (qual|melhor) /.test(q))) return "comparativo";
  if (/ o que (e|sao|significa) /.test(q) || / como (\S+ ){0,3}funcion/.test(q) || / (para|pra) que serve /.test(q) || / significado /.test(q)) {
    return "explicador";
  }
  if (/ (qual|quais) (e |sao )?(a |as |o |os )?melhor(es)? /.test(q) || / melhor(es)? /.test(q) || / (ferramentas?|cursos?) /.test(q)) {
    return "lista";
  }
  if (/ como (usar|fazer|criar|gerar|colocar|escrever|montar|ganhar|aprender|transformar|editar) /.test(q) || / (tutorial|passo a passo) /.test(q)) {
    return "tutorial";
  }
  if (/ como .+ (com|na|no|pela|pelo) (ia|inteligencia artificial|chatgpt) /.test(q)) return "tutorial";
  return "outro";
}

const STOPWORDS = new Set([
  "o", "a", "os", "as", "um", "uma", "de", "da", "do", "das", "dos", "com", "no", "na", "nos", "nas",
  "e", "em", "para", "pra", "por", "pela", "pelo", "que", "se", "ao", "como", "qual", "quais", "sao",
  "vs", "versus", "x", "ou", "melhor", "melhores", "significa", "serve",
]);

/** Sinônimos que não mudam o vídeo: "fazer/criar/gerar imagem/foto" é um tema só. */
const SYNONYMS: Record<string, string> = {
  fazer: "criar", faz: "criar", cria: "criar", gerar: "criar", gera: "criar", foto: "imagem", fotos: "imagem", imagens: "imagem",
  gpt: "chatgpt", gratis: "gratuita", gratuito: "gratuita", gratuitos: "gratuita", gratuitas: "gratuita",
};

/**
 * Chave do tema: termo normalizado, "inteligência artificial" → "ia",
 * "chat gpt" → "chatgpt", sem stopwords nem palavras de intenção, sinônimos
 * resolvidos, plural simples tirado e tokens ordenados. Junta variantes de
 * ordem ("chatgpt como funciona" / "como funciona o chatgpt") e de flexão.
 */
export function topicKey(keyword: string): string {
  const q = normalizeTerm(keyword)
    .replace(/\binteligencia artificial\b/g, "ia")
    .replace(/\bchat gpt\b/g, "chatgpt")
    .replace(/\bai\b/g, "ia");
  const tokens = new Set<string>();
  for (const raw of q.split(" ")) {
    if (!raw || STOPWORDS.has(raw)) continue;
    let t = SYNONYMS[raw] ?? raw;
    if (t.length > 4 && t.endsWith("s") && !t.endsWith("ss")) t = t.slice(0, -1);
    t = SYNONYMS[t] ?? t;
    tokens.add(t);
  }
  return [...tokens].sort().join(" ");
}

export interface PautaTopic {
  intent: VideoIntent;
  key: string;
  /** Variante de maior volume — o título-semente do vídeo. */
  lead: string;
  /** Maior volume entre as variantes (`null` se nenhuma veio com volume). */
  volume: number | null;
  /** Soma dos volumes das variantes — informativa, conta a mesma busca mais de uma vez. */
  volumeSum: number;
  /** Competição da variante líder. */
  competition: string;
  /** `volume × COMPETITION_FACTOR[competição]`; ordena o ranking. */
  score: number;
  variants: KeywordIdea[];
}

function competitionFactor(c: string): number {
  return COMPETITION_FACTOR[c] ?? UNKNOWN_COMPETITION_FACTOR;
}

/** Junta ideias de vários pulls: 1 linha por termo normalizado, mantendo a de maior volume. */
export function mergeIdeaSources(sources: readonly (readonly KeywordIdea[])[]): KeywordIdea[] {
  const byTerm = new Map<string, KeywordIdea>();
  for (const list of sources) {
    for (const idea of list) {
      if (!idea || typeof idea.keyword !== "string" || !idea.keyword.trim()) continue;
      const k = normalizeTerm(idea.keyword);
      const prev = byTerm.get(k);
      if (!prev || (idea.avgMonthlySearches ?? -1) > (prev.avgMonthlySearches ?? -1)) byTerm.set(k, idea);
    }
  }
  return [...byTerm.values()];
}

/** Agrupa por (intenção, tema) e ranqueia por `score` desc; empate por volume e depois pelo termo. */
export function buildPautaTopics(ideas: readonly KeywordIdea[]): PautaTopic[] {
  const groups = new Map<string, { intent: VideoIntent; key: string; variants: KeywordIdea[] }>();
  for (const idea of ideas) {
    const intent = classifyIntent(idea.keyword);
    const key = topicKey(idea.keyword) || normalizeTerm(idea.keyword);
    const id = `${intent}|${key}`;
    const g = groups.get(id) ?? { intent, key, variants: [] };
    g.variants.push(idea);
    groups.set(id, g);
  }
  const topics: PautaTopic[] = [];
  for (const g of groups.values()) {
    const variants = [...g.variants].sort(
      (a, b) => (b.avgMonthlySearches ?? -1) - (a.avgMonthlySearches ?? -1) || a.keyword.localeCompare(b.keyword),
    );
    const lead = variants[0];
    const volume = lead.avgMonthlySearches;
    topics.push({
      intent: g.intent,
      key: g.key,
      lead: lead.keyword,
      volume,
      volumeSum: variants.reduce((s, v) => s + (v.avgMonthlySearches ?? 0), 0),
      competition: lead.competition,
      score: Math.round((volume ?? 0) * competitionFactor(lead.competition)),
      variants,
    });
  }
  return topics.sort(
    (a, b) => b.score - a.score || (b.volume ?? -1) - (a.volume ?? -1) || a.lead.localeCompare(b.lead),
  );
}

export function renderPautaReport(args: {
  date: string;
  sources: string[];
  topics: PautaTopic[];
  contaminated?: SeedContamination[];
  topPerIntent?: number;
  topOverall?: number;
}): string {
  const fmt = (n: number | null) => (n === null ? "—" : n.toLocaleString("pt-BR"));
  const perIntent = args.topPerIntent ?? 15;
  const overall = args.topOverall ?? 10;
  const videoTopics = args.topics.filter((t) => t.intent !== "outro");
  const lines: string[] = [
    `# Pauta perene de vídeo — demanda de busca do Google (${args.date})`,
    "",
    `Fontes: ${args.sources.length ? args.sources.join(", ") : "nenhuma"}. Brasil / pt. Volume = média mensal dos últimos 12 meses (Keyword Planner, #8366).`,
    "",
    "Como ler: cada linha é um TEMA (variantes do mesmo assunto juntas). Volume = maior volume entre as variantes; pontos = volume com desconto pela competição de anunciantes (LOW 1, MEDIUM 0,75, HIGH 0,5). A competição é do Google Ads, não do YouTube: sinal fraco de saturação.",
    "",
    `## Top ${overall} temas para vídeo`,
    "",
    "| # | formato | tema | volume/mês | competição | pontos |",
    "|---:|---|---|---:|---|---:|",
  ];
  videoTopics.slice(0, overall).forEach((t, i) => {
    lines.push(`| ${i + 1} | ${t.intent} | ${t.lead} | ${fmt(t.volume)} | ${t.competition} | ${fmt(t.score)} |`);
  });
  if (videoTopics.length === 0) lines.push("| — | — | nenhum tema com formato de vídeo | — | — | — |");
  lines.push("");

  for (const intent of VIDEO_INTENTS) {
    const list = args.topics.filter((t) => t.intent === intent);
    if (list.length === 0) continue;
    lines.push(`## ${INTENT_LABEL[intent]} — ${list.length} tema(s)`, "");
    lines.push("| # | tema | volume/mês | competição | pontos | variantes |", "|---:|---|---:|---|---:|---|");
    list.slice(0, perIntent).forEach((t, i) => {
      const others = t.variants.slice(1).map((v) => v.keyword);
      const shown = others.slice(0, 4).join("; ") + (others.length > 4 ? `; +${others.length - 4}` : "");
      lines.push(`| ${i + 1} | ${t.lead} | ${fmt(t.volume)} | ${t.competition} | ${fmt(t.score)} | ${shown || "—"} |`);
    });
    if (list.length > perIntent) lines.push("", `Mais ${list.length - perIntent} tema(s) neste formato no JSON.`);
    lines.push("");
  }

  if (args.contaminated?.length) {
    lines.push("## Sementes fora do ranking (volume de marca contaminado) — revisar à mão", "");
    for (const c of args.contaminated) {
      lines.push(`- ${c.seed} (${fmt(c.volume)}/mês): vizinhas sem relação com IA — ${c.discardedNeighbours.join(", ")}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
