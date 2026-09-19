/**
 * scripts/lib/google-keyword-planner.ts (#8366)
 *
 * Miolo do pull de demanda de busca do Google Ads Keyword Planner
 * (`customers/{cid}:generateKeywordIdeas`) — única fonte gratuita de volume de
 * busca do Google (~97% do mercado BR), que GSC (só o que já aparecemos) e
 * Bing WMT (fatia pequena, subestima ordem de grandeza) não dão.
 *
 * Transporte: reusa `postGoogleAdsWithLoginRetry` de `google-ads-ingest.ts` —
 * com `login-customer-id` = MCC o endpoint devolve 403 USER_PERMISSION_DENIED
 * e com a própria conta anunciante, 200 (#5237); nunca montar headers à mão.
 *
 * Duas armadilhas de leitura, ambas tratadas aqui:
 *  - Volume é a média dos últimos 12 meses e, em conta de baixo gasto, às
 *    vezes vem em faixa larga — `avgMonthlySearches` é repassado como veio.
 *  - Volume de MARCA não é demanda pelo nosso assunto: `gemini` = 30,4 mi/mês
 *    mas as sugestões vizinhas são `cdj gemini`/`gemini dj` (equipamento de
 *    DJ). `filterRelevantIdeas` descarta ideia sem marcador de IA que não
 *    seja a própria semente, e `flagContaminatedSeeds` sinaliza a semente
 *    cuja vizinhança é majoritariamente ruído — o volume dela não serve de
 *    peso pra nada sem revisão humana. O `raw` é sempre preservado no JSON.
 *
 * Puro — sem I/O de disco nem de rede além do `fetchImpl` injetado.
 */

import {
  DEFAULT_API_VERSION,
  postGoogleAdsWithLoginRetry,
  type FetchLike,
  type GoogleAdsAuthConfig,
} from "./google-ads-ingest.ts";

/** `languageConstants/1014` = português; `geoTargetConstants/2076` = Brasil. */
export const KEYWORD_PLANNER_LANGUAGE = "languageConstants/1014";
export const KEYWORD_PLANNER_GEO = "geoTargetConstants/2076";
/** A API aceita até 20 sementes por `keywordSeed`. */
export const KEYWORD_PLANNER_MAX_SEEDS = 20;

export interface KeywordIdea {
  keyword: string;
  /** Média mensal (12 meses) de buscas no Google; `null` se o Google não devolveu. */
  avgMonthlySearches: number | null;
  /** `LOW` | `MEDIUM` | `HIGH` | `UNSPECIFIED` | `UNKNOWN`. */
  competition: string;
  competitionIndex: number | null;
  lowBidBrl: number | null;
  highBidBrl: number | null;
}

export function buildKeywordIdeasBody(seeds: string[]): Record<string, unknown> {
  return {
    keywordSeed: { keywords: seeds.slice(0, KEYWORD_PLANNER_MAX_SEEDS) },
    language: KEYWORD_PLANNER_LANGUAGE,
    geoTargetConstants: [KEYWORD_PLANNER_GEO],
    keywordPlanNetwork: "GOOGLE_SEARCH",
    includeAdultKeywords: false,
  };
}

function num(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function micros(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : n / 1_000_000;
}

/** `results[].keywordIdeaMetrics` → linhas planas. Tolerante a campo ausente
 *  (int64 vem como string em JSON; métrica ausente vira `null`, nunca 0). */
export function parseKeywordIdeas(payload: unknown): KeywordIdea[] {
  const results = (payload as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return [];
  const out: KeywordIdea[] = [];
  for (const r of results) {
    const row = r as { text?: unknown; keywordIdeaMetrics?: Record<string, unknown> };
    if (typeof row.text !== "string" || !row.text) continue;
    const m = row.keywordIdeaMetrics ?? {};
    out.push({
      keyword: row.text,
      avgMonthlySearches: num(m.avgMonthlySearches),
      competition: typeof m.competition === "string" ? m.competition : "UNKNOWN",
      competitionIndex: num(m.competitionIndex),
      lowBidBrl: micros(m.lowTopOfPageBidMicros),
      highBidBrl: micros(m.highTopOfPageBidMicros),
    });
  }
  return out;
}

function norm(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
}

/** Marcadores de assunto IA que NÃO são nome de marca ambíguo — `gemini` e
 *  `claude` ficam de fora de propósito (Gemini = DJ Pioneer, Claude = nome
 *  próprio): só provam relação com IA quando acompanhados de um destes. */
const STRONG_AI_MARKERS: readonly string[] = [
  "intelig", "artificial", "chatgpt", "gpt", "llm", "openai", "anthropic",
  "prompt", "chatbot", "deepfake", "machine learning", "aprendizado de maquina",
  "rede neural", "algoritm", "copilot", "deepseek", "midjourney",
];

export function isStrongAiTerm(text: string): boolean {
  const q = norm(text);
  return /\b(ia|ai)\b/.test(q) || STRONG_AI_MARKERS.some((m) => q.includes(m));
}

export interface FilteredIdeas {
  kept: KeywordIdea[];
  discarded: KeywordIdea[];
}

/** Mantém a própria semente (o editor a escolheu) e toda ideia com marcador
 *  forte de IA; o resto é ruído de marca/vizinhança e vai pra `discarded`. */
export function filterRelevantIdeas(ideas: KeywordIdea[], seeds: string[]): FilteredIdeas {
  const seedSet = new Set(seeds.map(norm));
  const kept: KeywordIdea[] = [];
  const discarded: KeywordIdea[] = [];
  for (const idea of ideas) {
    if (seedSet.has(norm(idea.keyword)) || isStrongAiTerm(idea.keyword)) kept.push(idea);
    else discarded.push(idea);
  }
  return { kept, discarded };
}

export interface SeedContamination {
  seed: string;
  volume: number | null;
  discardedNeighbours: string[];
}

/** Semente sem marcador de IA cujas ideias vizinhas (que compartilham token
 *  com ela) foram majoritariamente descartáveis (>=50% e pelo menos 2) tem
 *  volume bruto de marca, não de demanda — sinalizar. */
export function flagContaminatedSeeds(ideas: KeywordIdea[], seeds: string[]): SeedContamination[] {
  const out: SeedContamination[] = [];
  for (const seed of seeds) {
    if (isStrongAiTerm(seed)) continue;
    const s = norm(seed);
    const seedTokens = s.split(/\s+/);
    const own = ideas.find((i) => norm(i.keyword) === s);
    const neighbours = ideas.filter(
      (i) => norm(i.keyword) !== s && norm(i.keyword).split(/\s+/).some((t) => t.length > 2 && seedTokens.includes(t)),
    );
    const bad = neighbours.filter((i) => !isStrongAiTerm(i.keyword));
    if (bad.length >= 2 && bad.length * 2 >= neighbours.length) {
      out.push({ seed, volume: own?.avgMonthlySearches ?? null, discardedNeighbours: bad.slice(0, 5).map((i) => i.keyword) });
    }
  }
  return out;
}

/** Composição usada pelo CLI: aplica o filtro de relevância e tira da tabela de
 *  demanda a semente de marca contaminada (ela vira só aviso + `discarded`). */
export function partitionIdeas(ideas: KeywordIdea[], seeds: string[]): {
  kept: KeywordIdea[];
  discarded: KeywordIdea[];
  contaminated: SeedContamination[];
} {
  const filtered = filterRelevantIdeas(ideas, seeds);
  const contaminated = flagContaminatedSeeds(ideas, seeds);
  const bad = new Set(contaminated.map((c) => norm(c.seed)));
  return {
    kept: filtered.kept.filter((i) => !bad.has(norm(i.keyword))),
    discarded: [...filtered.discarded, ...filtered.kept.filter((i) => bad.has(norm(i.keyword)))],
    contaminated,
  };
}

const COMPETITION_RANK: Record<string, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

/** Ordena por volume desc e, em empate, competição asc (mais fácil primeiro). */
export function sortIdeas(ideas: KeywordIdea[]): KeywordIdea[] {
  return [...ideas].sort((a, b) => {
    const dv = (b.avgMonthlySearches ?? -1) - (a.avgMonthlySearches ?? -1);
    if (dv !== 0) return dv;
    return (COMPETITION_RANK[a.competition] ?? 3) - (COMPETITION_RANK[b.competition] ?? 3);
  });
}

export function renderKeywordReport(args: {
  date: string;
  seeds: string[];
  kept: KeywordIdea[];
  discarded: KeywordIdea[];
  contaminated: SeedContamination[];
}): string {
  const fmt = (n: number | null) => (n === null ? "—" : n.toLocaleString("pt-BR"));
  const lines: string[] = [
    `# Google Keyword Planner — demanda de busca (${args.date})`,
    "",
    `Sementes: ${args.seeds.join(", ")}. Brasil / pt. Volume = média mensal dos últimos 12 meses (conta de baixo gasto pode vir em faixa larga).`,
    "",
  ];
  if (args.contaminated.length) {
    lines.push("## Volume de marca contaminado — não usar como demanda", "");
    for (const c of args.contaminated) {
      lines.push(`- **${c.seed}** (${fmt(c.volume)}/mês) — vizinhas sem relação com IA: ${c.discardedNeighbours.join(", ")}`);
    }
    lines.push("");
  }
  lines.push("## Ideias relevantes", "", "| volume/mês | competição | índice | lance BRL | termo |", "|---:|---|---:|---|---|");
  for (const i of sortIdeas(args.kept)) {
    const money = (n: number | null) => (n === null ? "—" : n.toFixed(2));
    const bid = i.lowBidBrl === null && i.highBidBrl === null ? "—" : `${money(i.lowBidBrl)}–${money(i.highBidBrl)}`;
    lines.push(`| ${fmt(i.avgMonthlySearches)} | ${i.competition} | ${i.competitionIndex ?? "—"} | ${bid} | ${i.keyword} |`);
  }
  lines.push("", `Descartadas por não terem marcador de IA (ruído de marca/vizinhança): ${args.discarded.length}. Lista completa no JSON.`, "");
  return lines.join("\n");
}

export type KeywordPlannerResult =
  | { ok: true; raw: unknown; ideas: KeywordIdea[] }
  | { ok: false; error: string };

/** Divide as sementes em lotes de no máximo `KEYWORD_PLANNER_MAX_SEEDS`. */
export function chunkSeeds(seeds: string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < seeds.length; i += KEYWORD_PLANNER_MAX_SEEDS) out.push(seeds.slice(i, i + KEYWORD_PLANNER_MAX_SEEDS));
  return out;
}

/** Junta ideias de vários lotes, mantendo a 1ª ocorrência de cada termo. */
export function dedupeIdeas(ideas: KeywordIdea[]): KeywordIdea[] {
  const seen = new Set<string>();
  return ideas.filter((i) => {
    const k = norm(i.keyword);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Chama `generateKeywordIdeas`. Nunca lança. */
export async function fetchKeywordIdeas(
  fetchImpl: FetchLike,
  auth: GoogleAdsAuthConfig,
  accessToken: string,
  seeds: string[],
): Promise<KeywordPlannerResult> {
  const customerId = auth.customerId.replace(/[^0-9]/g, "");
  const url = `https://googleads.googleapis.com/${auth.apiVersion ?? DEFAULT_API_VERSION}/customers/${customerId}:generateKeywordIdeas`;
  const attempt = await postGoogleAdsWithLoginRetry(fetchImpl, auth, accessToken, url, JSON.stringify(buildKeywordIdeasBody(seeds)), "generateKeywordIdeas");
  if ("networkError" in attempt) return { ok: false, error: attempt.networkError };
  const { res, text } = attempt;
  if (!res.ok) return { ok: false, error: `generateKeywordIdeas respondeu HTTP ${res.status}: ${text.slice(0, 600)}` };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: `generateKeywordIdeas respondeu corpo não-JSON (HTTP ${res.status})` };
  }
  const ideas = parseKeywordIdeas(raw);
  // 200 sem nenhuma ideia é resposta anômala (schema mudou / payload de erro
  // com 200): falhar alto em vez de gravar relatório vazio e parecer saudável.
  if (ideas.length === 0) return { ok: false, error: `generateKeywordIdeas respondeu 200 sem ideias: ${text.slice(0, 300)}` };
  return { ok: true, raw, ideas };
}
