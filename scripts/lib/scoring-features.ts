/**
 * scripts/lib/scoring-features.ts (#7975, Camada 1 da #7972)
 *
 * Extrai, de forma determinística e read-only, as features numéricas/
 * booleanas de cada candidato do pool pós-categorização — a base sobre a
 * qual a calibração de score (Fase 2, #7976) vai aprender pesos a partir
 * das correções do editor. Este módulo NÃO decide nada e NÃO afeta o score
 * real: é só extração de features do estado já produzido pelo pipeline
 * (`01-categorized.json`/`01-approved.json`).
 *
 * Fonte de cada campo, verificada contra dados reais de edição (260911):
 * - `bonuses_applied` já vem no JSON com as strings exatas que o scorer
 *   (`.claude/agents/scorer.md`/`scorer-chunk.md`) grava, ex:
 *   ["impact_routine:+10", "impact_routine_br:+5", "hands_on:+8"] — os
 *   booleanos abaixo são derivados checando o PREFIXO de cada entrada
 *   (nunca ":true", que é o formato do sinal de ENTRADA em
 *   `audience_affinity.matched`, não o de saída do scorer).
 * - `cluster_sources`, `negative_impact`, `category`, `discovered_source`,
 *   `flag` já existem no item categorizado (ver `scripts/lib/cluster-sources.ts`
 *   e `scripts/lib/launch-heuristics.ts`).
 *
 * Exclusão explícita de features NÃO-calibráveis (#7972 Camada 1): listadas
 * em `NON_CALIBRATABLE_FEATURES` — nunca podem entrar como coeficiente de
 * regressão em `calibrate-scoring-weights.ts` (Fase 2), só como variável de
 * estratificação em relatórios. `negative_impact` é o requisito editorial
 * de impacto negativo obrigatório (#3916/#3918) — aprender a evitá-lo via
 * peso otimizado seria o próprio Goodhart que o design da #7972 identificou
 * como risco G-1/I-1. `bucket` é a variável de SAÍDA que a calibração de
 * Track A/B tenta prever, nunca um input.
 */

import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export type ArticleOrigin = "cadastrada" | "discovery" | "editor_submitted" | "newsletter_extracted" | "unknown";

export interface ScoringFeatureRow {
  url: string;
  /** Bucket de origem no `01-categorized.json`: highlights/runners_up/lancamento/radar/use_melhor/video. */
  bucket: string;
  title: string;
  score: number | null;
  score_base: number | null;

  // --- já existentes no pipeline, só persistidas aqui (ver docstring) ---
  primary_source: boolean;
  hands_on: boolean;
  academy: boolean;
  howto_br: boolean;
  howto_br_source: boolean;
  cluster_sources_count: number;
  negative_impact: boolean;
  category: string | null;
  origin: ArticleOrigin;

  // --- novas (#7975) ---
  /** Horas entre `published_at`/`date` do artigo e a data da edição (AAMMDD). `null` se nenhuma das duas datas parsear. */
  recency_hours: number | null;
  /** Hostname (sem `www.`) extraído da URL. `null` se a URL não parsear. */
  domain: string | null;
  title_char_count: number;
  /** Domínio bate com `lancamentoDomains()`/`lancamentoPatterns()` (`scripts/lib/official-domains.ts`) — condição necessária de #160, não suficiente. */
  has_official_link: boolean;

  // --- explicitamente NÃO implementadas nesta fase (#7975) — sempre null,
  // nunca fabricadas. Precisam de infraestrutura adicional listada no
  // comentário de cada uma; ver issue #7975 para o que falta. ---
  /** TODO(#7975 follow-up): precisa de dedup histórico contra `data/past-editions.md`/cache de URLs publicadas. */
  novelty_vs_past_editions: null;
  /** TODO(#7975 follow-up): precisa de CTR por domínio agregado de `data/link-ctr-table.csv`, janela de 30 dias. */
  source_reputation_ctr_30d: null;
  /** TODO(#7975 follow-up): mesma fonte que a de 30d, janela de 90 dias. */
  source_reputation_ctr_90d: null;

  // --- proveniência (#7972 Camada 1, mitigações C-3/S-8) ---
  /** Data em que esta linha foi calculada (ISO), não a data da edição — protege contra silenciosamente reprocessar com definição de feature diferente. */
  feature_available_since: string;
  /** SHA do último commit que tocou `launch-heuristics.ts` no momento da extração — `null` se `git` não estiver disponível (fail-soft, nunca bloqueia). */
  launch_heuristics_sha: string | null;
}

/**
 * Nunca calibráveis — ver docstring do módulo. Tipado como
 * `keyof ScoringFeatureRow` (não `Set<string>` solto) de propósito: renomear
 * ou remover um destes campos em `ScoringFeatureRow` agora vira erro de
 * COMPILAÇÃO aqui, não um gap silencioso que só apareceria quando a Fase 2
 * (#7976) já estivesse consumindo o campo errado — achado de review do #7975.
 */
export const NON_CALIBRATABLE_FEATURES: ReadonlySet<keyof ScoringFeatureRow> = new Set<keyof ScoringFeatureRow>([
  "negative_impact",
  "bucket",
]);

interface RawArticle {
  url?: unknown;
  title?: unknown;
  score?: unknown;
  score_base?: unknown;
  bonuses_applied?: unknown;
  cluster_sources?: unknown;
  negative_impact?: unknown;
  category?: unknown;
  discovered_source?: unknown;
  flag?: unknown;
  published_at?: unknown;
  date?: unknown;
  [key: string]: unknown;
}

/** Buckets do `01-categorized.json`/`01-approved.json` que viram linhas do feature store. `runners_up` inclui de propósito — são candidatos reais que o LLM viu e não escolheu, sinal negativo útil pra calibração. */
export const FEATURE_STORE_BUCKETS: readonly string[] = [
  "highlights",
  "runners_up",
  "lancamento",
  "radar",
  "use_melhor",
  "video",
];

function hasBonusPrefix(bonusesApplied: unknown, prefix: string): boolean {
  if (!Array.isArray(bonusesApplied)) return false;
  return bonusesApplied.some((b) => typeof b === "string" && b.startsWith(`${prefix}:`));
}

function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * `discovered_source` só é gravado `true` por `discovery-searcher`
 * (`scripts/fetch-websearch-batch.ts:176`) — em nenhum lugar do pipeline
 * ele é gravado `false` explicitamente; fontes cadastradas (source-
 * researcher, a maioria do pool) chegam com o campo simplesmente AUSENTE
 * (`undefined`), não `false`. Achado ao vivo contra edição real 260911
 * (#7975, revisão de PR): a versão anterior desta função tratava só
 * `=== false` como "cadastrada", então praticamente todo o pool virava
 * `"unknown"` — sem sinal nenhum, já que o schema real nunca usa `false`.
 * `!== true` (cobre `false` E `undefined`) é o teste correto.
 */
function extractOrigin(a: RawArticle): ArticleOrigin {
  const flag = typeof a.flag === "string" ? a.flag : "";
  if (flag === "editor_submitted") return "editor_submitted";
  if (flag === "newsletter_extracted") return "newsletter_extracted";
  if (a.discovered_source === true) return "discovery";
  if (a.discovered_source === false || a.discovered_source === undefined) return "cadastrada";
  return "unknown";
}

/**
 * Calcula horas entre a data do artigo (`published_at` ISO, com fallback
 * pra `date` YYYY-MM-DD) e a data de referência da edição (meio-dia UTC do
 * AAMMDD, pra evitar viés de fuso na borda do dia). `null` se nenhuma das
 * duas datas do artigo parsear — nunca lança, nunca fabrica um valor.
 */
export function computeRecencyHours(a: RawArticle, editionDate: Date): number | null {
  const raw = typeof a.published_at === "string" && a.published_at ? a.published_at : a.date;
  if (typeof raw !== "string" || raw === "") return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  const diffMs = editionDate.getTime() - parsed.getTime();
  return Math.round((diffMs / (1000 * 60 * 60)) * 10) / 10;
}

/** `AAMMDD` → meio-dia UTC daquele dia (2000+AA-MM-DD). `null` se o formato não bater. */
export function editionDateFromAammdd(aammdd: string): Date | null {
  const m = /^(\d{2})(\d{2})(\d{2})$/.exec(aammdd);
  if (!m) return null;
  const [, yy, mm, dd] = m;
  const d = new Date(Date.UTC(2000 + Number(yy), Number(mm) - 1, Number(dd), 12, 0, 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

let officialDomainsCache: { domains: Set<string>; patterns: RegExp[] } | null = null;
async function loadOfficialDomains(): Promise<{ domains: Set<string>; patterns: RegExp[] }> {
  if (officialDomainsCache) return officialDomainsCache;
  const mod = await import("./official-domains.ts");
  officialDomainsCache = { domains: mod.lancamentoDomains(), patterns: mod.lancamentoPatterns() };
  return officialDomainsCache;
}

function hasOfficialLink(url: string, domains: Set<string>, patterns: RegExp[]): boolean {
  let host: string;
  let hostPath: string;
  try {
    const u = new URL(url);
    host = u.hostname.replace(/^www\./, "");
    hostPath = `${host}${u.pathname}`;
  } catch {
    return false;
  }
  if (domains.has(host)) return true;
  return patterns.some((re) => re.test(hostPath));
}

/**
 * SHA do commit mais recente que tocou `scripts/lib/launch-heuristics.ts`,
 * cacheado por processo (chamado 1x por edição inteira, não por artigo).
 * `null` em qualquer falha — `git` ausente, não é repo, etc. Nunca lança.
 */
let launchHeuristicsShaCache: string | null | undefined;
export function launchHeuristicsSha(): string | null {
  if (launchHeuristicsShaCache !== undefined) return launchHeuristicsShaCache;
  try {
    const out = execFileSync("git", ["log", "-1", "--format=%H", "--", "scripts/lib/launch-heuristics.ts"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    launchHeuristicsShaCache = out || null;
  } catch (err) {
    // Fail-soft intencional (git ausente é caso normal em alguns ambientes)
    // — mas 1 warn por PROCESSO (cacheado, nunca por artigo) evita que um
    // timeout/erro de permissão real fique indistinguível de "sem git" por
    // meses (achado de review do #7975: o campo existe pra detectar drift
    // de definição de feature, então perder o sinal em silêncio mina o
    // próprio propósito dele).
    console.warn(`[scoring-features] launchHeuristicsSha: git indisponível (${err instanceof Error ? err.message : String(err)}) — launch_heuristics_sha será null.`);
    launchHeuristicsShaCache = null;
  }
  return launchHeuristicsShaCache;
}

/**
 * Extrai as `ScoringFeatureRow` de um `01-categorized.json`/`01-approved.json`
 * já parseado. `editionDate` vem de `editionDateFromAammdd` (ou outra fonte,
 * em teste) — passada explicitamente em vez de `new Date()` interno, pra a
 * extração ser determinística e testável sem mock de relógio.
 */
export async function extractScoringFeatures(
  categorizedJson: Record<string, unknown>,
  editionDate: Date | null,
): Promise<ScoringFeatureRow[]> {
  const { domains, patterns } = await loadOfficialDomains();
  const sha = launchHeuristicsSha();
  const now = new Date().toISOString();
  const rows: ScoringFeatureRow[] = [];
  const seenUrls = new Set<string>();

  for (const bucket of FEATURE_STORE_BUCKETS) {
    const arr = categorizedJson[bucket];
    // Chave ausente (bucket vazio naquela edição) é normal, silencioso.
    // Chave PRESENTE mas não-array é sinal de schema drift do categorizer —
    // sem este warn, todo o bucket vira silenciosamente 0 linhas pra sempre
    // (achado de review do #7975).
    if (arr !== undefined && !Array.isArray(arr)) {
      console.warn(`[scoring-features] bucket "${bucket}" presente mas não é array (typeof ${typeof arr}) — pulando, possível schema drift do categorizer.`);
    }
    if (!Array.isArray(arr)) continue;
    for (const raw of arr) {
      const a = raw as RawArticle;
      // highlights guarda o artigo em `.article` (ver classifyApprovedDiff em
      // derive-editor-requests.ts) — mesma indireção, mesmo shape.
      const article: RawArticle = (a?.article as RawArticle) ?? a;
      const url = typeof article?.url === "string" ? article.url : typeof a?.url === "string" ? a.url : null;
      if (!url || seenUrls.has(url)) continue;
      seenUrls.add(url);

      const title = typeof article?.title === "string" ? article.title : typeof a?.title === "string" ? a.title : url;
      const clusterSources = Array.isArray(article?.cluster_sources ?? a?.cluster_sources)
        ? ((article?.cluster_sources ?? a?.cluster_sources) as unknown[])
        : [];
      const bonuses = article?.bonuses_applied ?? a?.bonuses_applied;

      rows.push({
        url,
        bucket,
        title,
        score: typeof (article?.score ?? a?.score) === "number" ? ((article?.score ?? a?.score) as number) : null,
        score_base:
          typeof (article?.score_base ?? a?.score_base) === "number" ? ((article?.score_base ?? a?.score_base) as number) : null,
        primary_source: hasBonusPrefix(bonuses, "primary_source"),
        hands_on: hasBonusPrefix(bonuses, "hands_on"),
        academy: hasBonusPrefix(bonuses, "academy"),
        // hasBonusPrefix casa pelo prefixo "howto_br:" (com dois-pontos) — não
        // colide com "howto_br_source:+3" (que tem "_source" antes do ":").
        howto_br: hasBonusPrefix(bonuses, "howto_br"),
        howto_br_source: hasBonusPrefix(bonuses, "howto_br_source"),
        cluster_sources_count: clusterSources.length,
        negative_impact: (article?.negative_impact ?? a?.negative_impact) === true,
        category: typeof (article?.category ?? a?.category) === "string" ? ((article?.category ?? a?.category) as string) : null,
        origin: extractOrigin(article?.flag !== undefined || article?.discovered_source !== undefined ? article : a),
        recency_hours: editionDate ? computeRecencyHours(article?.published_at !== undefined || article?.date !== undefined ? article : a, editionDate) : null,
        domain: extractDomain(url),
        title_char_count: title.length,
        has_official_link: hasOfficialLink(url, domains, patterns),
        novelty_vs_past_editions: null,
        source_reputation_ctr_30d: null,
        source_reputation_ctr_90d: null,
        feature_available_since: now,
        launch_heuristics_sha: sha,
      });
    }
  }

  return rows;
}
