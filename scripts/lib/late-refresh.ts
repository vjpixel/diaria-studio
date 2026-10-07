/**
 * late-refresh.ts (#9370)
 *
 * Miolo PURO do "refresh tardio" pré-gate-4: lista o que saiu DEPOIS da
 * pesquisa do Stage 1 (fontes oficiais de laboratório de fronteira +
 * newsletters que chegaram depois da captura do Stage 0), já deduplicado
 * contra a edição atual e as anteriores, com uma SUGESTÃO de substituição.
 *
 * Nunca altera a edição: o resultado vira um bloco informativo no resumo do
 * gate 4 e o editor decide (inclusão manual segue o fluxo §4d.1/§4d.1b).
 *
 * Por que existe (medição da #9370 sobre #9365): 6 das 51 inclusões manuais
 * (260828 → 261001) eram notícias publicadas entre a pesquisa (~19–22h) e o
 * gate 4 (~23h–02h) — Opus 5.5, GPT-6 Sol, Dots, Muse, "Pace the frontier",
 * Claude Cowork — e 5 delas viraram destaque.
 *
 * I/O (fetch de feed, Gmail, leitura de arquivos) mora no CLI
 * `scripts/late-refresh-candidates.ts`; aqui só decisões determinísticas.
 */

import { canonicalize, extractUrls } from "./url-utils.ts";
import { FLAGSHIP_MODEL_RE, detectFrontierLaunch, frontierLabOfUrl } from "./frontier-signals.ts";
import { hasLaunchVerb } from "./launch-detect.ts";
import { lancamentoDomains, lancamentoPatterns } from "./official-domains.ts";

// ---------------------------------------------------------------------------
// Fontes
// ---------------------------------------------------------------------------

interface LateRefreshFeedBase {
  lab: string;
  name: string;
  url: string;
}

export interface RssFeed extends LateRefreshFeedBase {
  method: "rss";
}

export interface SitemapFeed extends LateRefreshFeedBase {
  method: "sitemap";
  /** Mantém só entradas cujo path começa com este prefixo (o sitemap lista o site inteiro). */
  pathPrefix?: string;
}

/** Atom oficial de releases de UM repo (`/{org}/{repo}/releases.atom`), #9424. */
export interface GithubReleasesFeed extends LateRefreshFeedBase {
  method: "github-releases";
  /**
   * A tag (último segmento de `/releases/tag/{tag}`) precisa casar — filtro de
   * ruído (nightly, preview, rc, alpha, sub-pacote de SDK, bump de patch). O
   * Atom não expõe o flag `prerelease`; a tag é o que sobra.
   */
  tagPattern: RegExp;
}

/**
 * Repositórios públicos da org criados depois do corte, pela API REST oficial
 * do GitHub (`/orgs/{org}/repos?sort=created`), #9424 — é como os labs abertos
 * lançam MODELO (repo novo por modelo; repo de pesos não publica release).
 * `url` é sempre derivada de `org` (`githubNewReposFeed`), nunca escrita à mão.
 */
export interface GithubNewReposFeed extends LateRefreshFeedBase {
  method: "github-new-repos";
  /** Login da org no GitHub. */
  org: string;
}

export type LateRefreshFeed = RssFeed | SitemapFeed | GithubReleasesFeed | GithubNewReposFeed;

/**
 * Tag semver ESTÁVEL de minor/major com prefixo `v` (`v1.20.0`, `v0.25.0`) —
 * corta patch, nightly, preview, rc, alpha, beta. Repo com prefixo próprio
 * na tag (deepseek-harness: `dsh-v…`) declara o padrão dele.
 */
const STABLE_MINOR_TAG = /^v\d+\.\d+\.0$/;

/**
 * `type=sources` = só repos que NÃO são fork (a API já exclui; o filtro de
 * `fork` em `parseGithubNewRepos` fica como defesa). Fonte única da URL.
 */
export function githubNewReposUrl(org: string): string {
  return `https://api.github.com/orgs/${org}/repos?sort=created&direction=desc&per_page=30&type=sources`;
}

function githubNewReposFeed(lab: string, name: string, org: string): GithubNewReposFeed {
  return { lab, name, org, url: githubNewReposUrl(org), method: "github-new-repos" };
}

/**
 * Feeds oficiais verificados ao vivo em 2026-10-01 (HTTP 200 + parse ok);
 * Mistral e Meta em 2026-10-02; os do GitHub (xAI, DeepSeek, Qwen) em
 * 2026-10-07 (#9424, `docs/late-refresh-github-feeds.md`).
 * Anthropic não publica RSS — o sitemap tem `lastmod` por página, filtrado
 * por prefixo de path pra não listar landing/solutions/localizações.
 */
export const LATE_REFRESH_FEEDS: readonly LateRefreshFeed[] = [
  { lab: "Anthropic", name: "Anthropic News", url: "https://www.anthropic.com/sitemap.xml", method: "sitemap", pathPrefix: "/news/" },
  { lab: "Anthropic", name: "Claude Blog", url: "https://claude.com/sitemap.xml", method: "sitemap", pathPrefix: "/blog/" },
  { lab: "OpenAI", name: "OpenAI News", url: "https://openai.com/news/rss.xml", method: "rss" },
  { lab: "Google", name: "Google AI Blog", url: "https://blog.google/technology/ai/rss/", method: "rss" },
  { lab: "Google DeepMind", name: "DeepMind Blog", url: "https://deepmind.google/blog/rss.xml", method: "rss" },
  { lab: "Microsoft AI", name: "Microsoft AI", url: "https://microsoft.ai/feed/", method: "rss" },
  { lab: "Mistral", name: "Mistral Blog", url: "https://mistral.ai/news/rss", method: "rss" },
  { lab: "Meta", name: "Meta Newsroom (tag AI)", url: "https://about.fb.com/news/tag/ai/feed/", method: "rss" },
  // #9424 (decisão do editor 07/10/2026: GitHub oficial da org, nunca scraping).
  // Sondado ao vivo em 07/10/2026: repo de PESOS de modelo (Qwen3, Qwen3.8,
  // Qwen-Image-2.1, grok-1) não publica release, e DeepSeek-V3 quase não
  // publica (uma release, 06/2025) — o lançamento de modelo aparece como REPO
  // NOVO da org. Release só existe nos repos de ferramenta/SDK, com muito
  // nightly/rc — daí o `tagPattern` estável.
  githubNewReposFeed("Qwen", "Qwen GitHub (repos novos)", "QwenLM"),
  { lab: "Qwen", name: "Qwen Code (releases)", url: "https://github.com/QwenLM/qwen-code/releases.atom", method: "github-releases", tagPattern: STABLE_MINOR_TAG },
  githubNewReposFeed("DeepSeek", "DeepSeek GitHub (repos novos)", "deepseek-ai"),
  { lab: "DeepSeek", name: "DeepSeek Harness (releases)", url: "https://github.com/deepseek-ai/deepseek-harness/releases.atom", method: "github-releases", tagPattern: /^dsh-v\d+\.\d+\.0$/ },
  githubNewReposFeed("xAI", "xAI GitHub (repos novos)", "xai-org"),
  { lab: "xAI", name: "xAI SDK Python (releases)", url: "https://github.com/xai-org/xai-sdk-python/releases.atom", method: "github-releases", tagPattern: STABLE_MINOR_TAG },
];

/**
 * Laboratórios da lista da #9370 SEM feed máquina-legível CONFIGURADO.
 * Histórico: em 2026-10-01 Meta, xAI, DeepSeek, Qwen e Mistral não tinham
 * feed; em 2026-10-02 (#9424) Mistral ganhou `mistral.ai/news/rss` e Meta o
 * feed da tag AI do Newsroom; em 2026-10-07 (#9424) xAI, DeepSeek e Qwen
 * passaram a ser lidos pelo GitHub oficial da org (repos novos + releases).
 * Lista vazia hoje. O relatório soma a ela, em runtime, todo lab cujos feeds
 * falharam TODOS na rodada (`uncoveredLabsAtRuntime`).
 */
export const LATE_REFRESH_UNCOVERED_LABS: readonly string[] = [];

/**
 * Labs sem cobertura NESTA rodada: os sem feed configurado + os que tiveram
 * todos os feeds com falha. Sem rodada de feeds (`--skip-feeds`), só a lista
 * estática. Ordem estável, sem duplicata. @pure
 */
export function uncoveredLabsAtRuntime(
  feeds: ReadonlyArray<{ lab: string; ok: boolean }>,
  staticUncovered: readonly string[] = LATE_REFRESH_UNCOVERED_LABS,
): string[] {
  const okByLab = new Map<string, boolean>();
  for (const f of feeds) okByLab.set(f.lab, (okByLab.get(f.lab) ?? false) || f.ok);
  const down = [...okByLab].filter(([, ok]) => !ok).map(([lab]) => lab);
  return [...new Set([...staticUncovered, ...down])];
}

// ---------------------------------------------------------------------------
// GitHub (#9424)
// ---------------------------------------------------------------------------

/** `{org}/{repo}` e tag de uma URL `github.com/{org}/{repo}/releases/tag/{tag}`; `null` fora desse formato. */
export function parseGithubReleaseUrl(url: string): { repo: string; tag: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.hostname.toLowerCase().replace(/^www\./, "") !== "github.com") return null;
  const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/releases\/tag\/([^/]+)\/?$/);
  if (!m) return null;
  try {
    return { repo: `${m[1]}/${m[2]}`, tag: decodeURIComponent(m[3]) };
  } catch {
    // `%` solto na tag (URIError) — não dá pra saber a tag, então não é release legível.
    return null;
  }
}

/**
 * Releases de um Atom do GitHub que são LANÇAMENTO: tag casa `tagPattern`
 * (sem padrão = todas). Título ganha o repo na frente — "Release v0.25.0"
 * sozinho não diz de quem é; título vazio vira a tag. Entrada fora de
 * `/releases/tag/` sai. @pure
 */
export function filterGithubReleases(articles: readonly LateArticle[], tagPattern: RegExp | undefined): LateArticle[] {
  const out: LateArticle[] = [];
  for (const a of articles) {
    const rel = parseGithubReleaseUrl(a.url);
    if (!rel) continue;
    if (tagPattern && !tagPattern.test(rel.tag)) continue;
    const title = a.title.trim();
    out.push({ ...a, title: title.toLowerCase().includes(rel.repo.toLowerCase()) ? title : `${rel.repo}: ${title || rel.tag}` });
  }
  return out;
}

/**
 * Descrição em que a própria org declara o repo interno. Calibrado em
 * 07/10/2026 contra os 2 casos reais de 30/09/2026 (`dsh-libreoffice-kit`,
 * `dsh-node-addon-require-builtin`: "An internal component used by DeepSeek Harness").
 */
const INTERNAL_REPO_RE = /\binternal (?:component|tool|use|library)\b/i;

interface GithubRepoJson {
  name?: unknown;
  full_name?: unknown;
  html_url?: unknown;
  description?: unknown;
  created_at?: unknown;
  fork?: unknown;
  archived?: unknown;
  private?: unknown;
}

/**
 * Resposta de `GET /orgs/{org}/repos` → artigos (data = `created_at`). Fork,
 * arquivado, privado, repo interno e entrada sem nome/URL/data saem — fork da
 * org (vllm, zed-extensions) não é lançamento dela. O corte por data é do
 * `filterLateArticles`. Corpo que NÃO é array lança — o caso é um 200 com
 * objeto (o fetch já tratou o status ≠ 2xx antes): sem lista não dá pra dizer
 * "nada novo", então o chamador registra feed com falha. @pure
 */
export function parseGithubNewRepos(json: unknown, feed: Pick<LateRefreshFeed, "lab" | "name">): LateArticle[] {
  if (!Array.isArray(json)) {
    const msg = typeof (json as { message?: unknown })?.message === "string" ? (json as { message: string }).message : "resposta não é lista";
    throw new Error(`GitHub API: ${msg}`);
  }
  const out: LateArticle[] = [];
  for (const r of json as GithubRepoJson[]) {
    if (r?.fork === true || r?.archived === true || r?.private === true) continue;
    if (typeof r?.html_url !== "string" || typeof r?.created_at !== "string") continue;
    const full = typeof r.full_name === "string" && r.full_name ? r.full_name : typeof r.name === "string" ? r.name : "";
    if (!full) continue;
    const desc = typeof r.description === "string" ? r.description.trim() : "";
    if (INTERNAL_REPO_RE.test(desc)) continue;
    const shortDesc = desc.length > 140 ? `${desc.slice(0, 137).trimEnd()}...` : desc;
    out.push({
      url: r.html_url,
      title: `Novo repositório ${full}${shortDesc ? `: ${shortDesc}` : ""}`,
      published_at: r.created_at,
      summary: desc,
      lab: feed.lab,
      source: feed.name,
    });
  }
  return out;
}

/** Resultado do pós-processamento de um feed: artigos + contagens pra detectar mudança de formato. */
export interface FeedProcessed {
  articles: LateArticle[];
  /** Entradas brutas devolvidas pela fonte (antes de qualquer filtro). */
  raw_entries: number;
  /** Entradas que sobraram depois do filtro do método (tag, fork, interno…), antes do corte por data. */
  after_filter: number;
  /**
   * `true` quando havia entradas brutas e NENHUMA foi reconhecida no formato
   * esperado (release sem `/releases/tag/`, repo sem nome/URL/data). Filtro
   * de tag que zera tudo por só haver nightly NÃO conta — é o filtro
   * funcionando (deepseek-harness só publica alpha/rc hoje).
   */
  format_suspect: boolean;
}

/**
 * Pós-processamento puro de um feed já baixado. `payload` = artigos do parser
 * RSS/Atom (rss, sitemap, github-releases) ou o JSON cru da API (github-new-repos).
 * Lança no mesmo caso de `parseGithubNewRepos`. @pure
 */
export function postProcessFeedArticles(feed: LateRefreshFeed, payload: unknown): FeedProcessed {
  if (feed.method === "github-new-repos") {
    const articles = parseGithubNewRepos(payload, feed);
    const raw = (payload as unknown[]).length;
    const recognized = (payload as GithubRepoJson[]).filter(
      (r) => typeof r?.html_url === "string" && typeof r?.created_at === "string" && (typeof r?.full_name === "string" || typeof r?.name === "string"),
    ).length;
    return { articles, raw_entries: raw, after_filter: articles.length, format_suspect: raw > 0 && recognized === 0 };
  }
  const arts = (Array.isArray(payload) ? payload : []) as LateArticle[];
  if (feed.method === "github-releases") {
    const articles = filterGithubReleases(arts, feed.tagPattern);
    const recognized = arts.filter((a) => parseGithubReleaseUrl(a.url) !== null).length;
    return { articles, raw_entries: arts.length, after_filter: articles.length, format_suspect: arts.length > 0 && recognized === 0 };
  }
  return { articles: arts, raw_entries: arts.length, after_filter: arts.length, format_suspect: false };
}

/**
 * Erro acionável de HTTP do GitHub. 403/429 com `x-ratelimit-remaining: 0`
 * vira "rate limit, reset HH:MM BRT"; 404 diz o que não existe; resto leva o
 * `message` do corpo quando houver. @pure
 */
export function githubHttpError(
  status: number,
  headers: { get(name: string): string | null },
  body: string,
  method: "github-releases" | "github-new-repos",
): string {
  if (status === 404) return `HTTP 404 (${method === "github-new-repos" ? "org não encontrada" : "repo não encontrado"})`;
  let message = "";
  try {
    const j = JSON.parse(body) as { message?: unknown };
    if (typeof j?.message === "string") message = j.message;
  } catch {
    // corpo não-JSON (Atom/HTML de erro) — segue sem message.
  }
  const remaining = headers.get("x-ratelimit-remaining");
  const reset = Number(headers.get("x-ratelimit-reset"));
  if ((status === 403 || status === 429) && (remaining === "0" || /rate limit/i.test(message))) {
    if (Number.isFinite(reset) && reset > 0) {
      const d = new Date(reset * 1000 - 3 * 3600_000);
      return `HTTP ${status} (rate limit, reset ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} BRT)`;
    }
    return `HTTP ${status} (rate limit)`;
  }
  return message ? `HTTP ${status} (${message.slice(0, 120)})` : `HTTP ${status}`;
}

/** Linha do relatório de um feed. `ok` = sem erro. @pure */
export function feedReportRow(
  feed: LateRefreshFeed,
  result: { processed?: FeedProcessed; error?: string },
  itemsAfterCutoff: number,
): LateRefreshReport["feeds"][number] {
  return {
    name: feed.name,
    lab: feed.lab,
    ok: !result.error,
    items_after_cutoff: itemsAfterCutoff,
    raw_entries: result.processed?.raw_entries ?? 0,
    after_filter: result.processed?.after_filter ?? 0,
    ...(result.processed?.format_suspect ? { format_suspect: true } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
}

/**
 * Entradas de sitemap modificadas depois do corte, no `pathPrefix` do feed,
 * MAIS NOVAS PRIMEIRO e só então limitadas a `cap` (a ordem do sitemap é
 * arbitrária — cortar antes de ordenar podia descartar justo a mais nova).
 */
export function selectSitemapEntries<T extends { loc: string; lastmod: string | null }>(
  entries: readonly T[],
  cutoffIso: string,
  pathPrefix: string | undefined,
  cap: number,
): T[] {
  const cutoff = new Date(cutoffIso).getTime();
  return entries
    .filter((e) => {
      if (!e.lastmod) return false;
      const t = new Date(e.lastmod).getTime();
      if (Number.isNaN(t) || t <= cutoff) return false;
      if (!pathPrefix) return true;
      try {
        return new URL(e.loc).pathname.startsWith(pathPrefix);
      } catch {
        return false;
      }
    })
    .sort((a, b) => new Date(b.lastmod as string).getTime() - new Date(a.lastmod as string).getTime())
    .slice(0, cap);
}

// ---------------------------------------------------------------------------
// Cutoff
// ---------------------------------------------------------------------------

export interface CutoffResolution {
  /** Início da pesquisa (Stage 1) — item publicado depois disso não podia estar no pool. */
  research_cutoff: string | null;
  /** Início do Stage 0 (captura de newsletters) — thread chegada depois disso ficou de fora. */
  newsletter_cutoff: string | null;
  origin: "stage-status" | "step-1-done" | "none";
}

interface StageRow {
  stage?: number;
  start?: string;
}

function validIso(s: unknown): string | null {
  if (typeof s !== "string" || !s) return null;
  return Number.isNaN(new Date(s).getTime()) ? null : new Date(s).toISOString();
}

/**
 * Resolve os cortes a partir de `_internal/stage-status.json` (rows[].start
 * por stage). Fallback: `.step-1-done.json` `completed_at` — mais TARDE que o
 * início real; o que saiu durante a pesquisa e ela já viu é removido pelo
 * dedup contra o pool (`01-categorized.json`), não pelo corte.
 */
export function resolveCutoffs(stageStatus: unknown, step1Done: unknown): CutoffResolution {
  const rows: StageRow[] = Array.isArray((stageStatus as { rows?: unknown })?.rows)
    ? ((stageStatus as { rows: StageRow[] }).rows)
    : [];
  const s1 = validIso(rows.find((r) => r?.stage === 1)?.start);
  const s0 = validIso(rows.find((r) => r?.stage === 0)?.start);
  if (s1) return { research_cutoff: s1, newsletter_cutoff: s0 ?? s1, origin: "stage-status" };
  const done = validIso((step1Done as { completed_at?: unknown })?.completed_at);
  if (done) return { research_cutoff: done, newsletter_cutoff: s0 ?? done, origin: "step-1-done" };
  return { research_cutoff: null, newsletter_cutoff: null, origin: "none" };
}

// ---------------------------------------------------------------------------
// Dedup
// ---------------------------------------------------------------------------

/** Todas as URLs de um texto qualquer (md, JSON serializado), canonicalizadas. */
export function canonicalUrlSet(...texts: string[]): Set<string> {
  const out = new Set<string>();
  for (const t of texts) {
    for (const u of extractUrls(t)) {
      try {
        out.add(canonicalize(u));
      } catch {
        // URL malformada no texto — irrelevante pro dedup.
      }
    }
  }
  return out;
}

function canon(url: string): string {
  try {
    return canonicalize(url);
  } catch {
    return url;
  }
}

export interface LateArticle {
  url: string;
  title: string;
  published_at: string | null;
  summary?: string;
  lab: string;
  source: string;
}

/**
 * Feeds de laboratório publicam `pubDate` ARREDONDADO (medido no RSS da
 * OpenAI em 2026-10-01: "Introducing dots" = 29/09 00:00 GMT, "Introducing
 * GPT-6.1 Sol" = 29/09 10:00 GMT — horas cheias, não o instante do anúncio).
 * Um corte estrito por data perderia exatamente esses itens. Data em hora
 * cheia (min=seg=0) é tratada como imprecisa: entra se cair até este tanto
 * ANTES do corte — e ainda precisa estar fora do pool e das edições
 * anteriores (o dedup é que separa "a pesquisa não viu" de "já vimos").
 */
export const IMPRECISE_DATE_LOOKBACK_MS = 24 * 3600_000;

/** `true` quando o timestamp está em hora cheia — sinal de data arredondada pelo feed. */
export function isImpreciseTimestamp(iso: string): boolean {
  const d = new Date(iso);
  return !Number.isNaN(d.getTime()) && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
}

export interface LateFilterResult {
  fresh: LateArticle[];
  /** Já está na edição (02-reviewed.md) ou no pool que a pesquisa viu. */
  already_in_edition: LateArticle[];
  /** Já saiu numa edição anterior (data/past-editions.md). */
  already_published: LateArticle[];
}

/**
 * Mantém só o publicado DEPOIS do corte (e até `nowIso`) e que passa no dedup.
 * Data em hora cheia ganha a folga de `IMPRECISE_DATE_LOOKBACK_MS`. Item sem
 * data é descartado (feed de laboratório sem data não diz se é tardio).
 */
export function filterLateArticles(
  articles: readonly LateArticle[],
  cutoffIso: string,
  inEdition: ReadonlySet<string>,
  published: ReadonlySet<string>,
  nowIso?: string,
): LateFilterResult {
  const cutoff = new Date(cutoffIso).getTime();
  // Teto `now`: replay (`--now`) não pode listar o que só saiu depois do gate.
  const ceiling = nowIso ? new Date(nowIso).getTime() : Infinity;
  const res: LateFilterResult = { fresh: [], already_in_edition: [], already_published: [] };
  const seen = new Set<string>();
  for (const a of articles) {
    const t = a.published_at ? new Date(a.published_at).getTime() : NaN;
    if (Number.isNaN(t) || t > ceiling) continue;
    const floor = isImpreciseTimestamp(a.published_at as string) ? cutoff - IMPRECISE_DATE_LOOKBACK_MS : cutoff;
    if (t <= floor) continue;
    const c = canon(a.url);
    if (seen.has(c)) continue;
    seen.add(c);
    if (inEdition.has(c)) res.already_in_edition.push(a);
    else if (published.has(c)) res.already_published.push(a);
    else res.fresh.push(a);
  }
  res.fresh.sort((x, y) => (y.published_at ?? "").localeCompare(x.published_at ?? ""));
  return res;
}

// ---------------------------------------------------------------------------
// Newsletters
// ---------------------------------------------------------------------------

export interface LateThreadInput {
  thread_id: string;
  sender: string;
  subject: string;
  date: string;
  /** URLs que o capture-newsletter-urls.ts extraiu/filtrou desta thread. */
  urls: string[];
}

export interface LateThreadSummary {
  sender: string;
  subject: string;
  date: string;
  new_urls: number;
  /** URLs novas em host oficial de laboratório de fronteira (as mais acionáveis). */
  lab_urls: string[];
  /** Assunto cita modelo-carro-chefe versionado ("GPT-6.1 Sol", "Claude Opus 5.5"). */
  mentions_flagship: boolean;
}

/**
 * Threads chegadas depois da captura do Stage 0 e ainda não capturadas, com
 * as URLs novas (fora da edição e das anteriores). Thread sem URL nova sai.
 */
export function summarizeLateThreads(
  threads: readonly LateThreadInput[],
  alreadyCapturedIds: ReadonlySet<string>,
  cutoffIso: string,
  inEdition: ReadonlySet<string>,
  published: ReadonlySet<string>,
  nowIso?: string,
): LateThreadSummary[] {
  const cutoff = new Date(cutoffIso).getTime();
  const ceiling = nowIso ? new Date(nowIso).getTime() : Infinity;
  const out: LateThreadSummary[] = [];
  for (const th of threads) {
    if (alreadyCapturedIds.has(th.thread_id)) continue;
    const t = new Date(th.date).getTime();
    if (Number.isNaN(t) || t <= cutoff || t > ceiling) continue;
    const fresh = [...new Set(th.urls.map(canon))].filter((u) => !inEdition.has(u) && !published.has(u));
    if (fresh.length === 0) continue;
    out.push({
      sender: th.sender.replace(/\s*<[^>]*>\s*$/, "").trim() || th.sender,
      subject: th.subject,
      date: new Date(t).toISOString(),
      new_urls: fresh.length,
      lab_urls: fresh.filter((u) => frontierLabOfUrl(u) !== undefined).slice(0, 3),
      mentions_flagship: FLAGSHIP_MODEL_RE.test(th.subject),
    });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

// ---------------------------------------------------------------------------
// Sugestão de substituição
// ---------------------------------------------------------------------------

export interface HighlightLike {
  rank?: number;
  score?: number | null;
  bucket?: string;
  url?: string;
  negative_impact?: boolean;
  article?: { url?: string; title?: string; negative_impact?: boolean };
}

export interface SubstitutionSuggestion {
  /** `destaque` = candidato a D; `pool` = entra numa seção secundária. */
  target: "destaque" | "pool";
  /** Ex.: "D3" ou "LANÇAMENTOS". */
  slot: string;
  reason: string;
}

function isNegative(h: HighlightLike): boolean {
  return h.negative_impact === true || h.article?.negative_impact === true;
}

/**
 * Destaques NA ORDEM ATUAL da edição. `currentOrder` = URLs de D1..D3 lidas de
 * `02-reviewed.md` (fonte autoritativa: o editor pode reordenar/trocar
 * destaques entre o Stage 1 e o gate, e o `rank` do `01-approved.json` fica
 * velho). Score/bucket/negativo vêm do approved casando por URL canônica;
 * destaque sem par no approved foi posto pelo editor → tratado como `manual`
 * (protegido). Sem `currentOrder` (02-reviewed ilegível) cai no `rank`.
 */
export function currentHighlights(
  highlights: readonly HighlightLike[],
  currentOrder?: readonly string[],
): Array<{ slot: string; h: HighlightLike }> {
  if (!currentOrder || currentOrder.length === 0) {
    return highlights.map((h, i) => ({ slot: `D${h.rank ?? i + 1}`, h }));
  }
  const byUrl = new Map<string, HighlightLike>();
  for (const h of highlights) {
    const u = h.url ?? h.article?.url;
    if (u) byUrl.set(canon(u), h);
  }
  return currentOrder.map((u, i) => ({
    slot: `D${i + 1}`,
    h: byUrl.get(canon(u)) ?? { url: u, score: null, bucket: "manual" },
  }));
}

/**
 * Regra determinística (sugestão, nunca aplicada sozinha):
 * - Lançamento oficial de modelo versionado (o sabor que o editor aprovou 92%
 *   das vezes, #9359) → candidato a destaque, substituindo o D de MENOR score
 *   do pipeline, na ordem ATUAL de `02-reviewed.md` (`currentOrder`).
 *   Destaque `manual` (escolha do editor) e o ÚNICO destaque de impacto
 *   negativo (regra #3916) nunca são sugeridos para sair.
 * - Post em host oficial que ANUNCIA algo ("Introducing X" ou verbo de
 *   lançamento no título) → LANÇAMENTOS (link oficial, #160).
 * - Resto (case de cliente, ensaio, imprensa) → RADAR.
 */
const OFFICIAL_LANCAMENTO_DOMAINS = lancamentoDomains();
const OFFICIAL_LANCAMENTO_PATTERNS = lancamentoPatterns();

/**
 * #9457: host oficial = laboratório de fronteira (`FRONTIER_LABS`) OU domínio
 * de `official-domains.ts` (about.fb.com, mistral.ai…). #9424: OU qualquer
 * `path_patterns` de `official-domains.ts` (vale para TODOS: /news/ da
 * Anthropic, /index/ da OpenAI, repo/release da org oficial no GitHub…) —
 * mesma regra do `isOfficialLancamentoUrl` do Stage 1, mais o subdomínio
 * que esta função já aceitava. Não mexe em `FRONTIER_LABS` para não alterar
 * o scorer-select (#9359). @pure
 */
export function isOfficialHost(url: string): boolean {
  if (frontierLabOfUrl(url) !== undefined) return true;
  let host: string;
  let full: string;
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase().replace(/^www\./, "");
    full = host + u.pathname;
  } catch {
    return false;
  }
  for (const d of OFFICIAL_LANCAMENTO_DOMAINS) {
    if (host === d || host.endsWith(`.${d}`)) return true;
  }
  return OFFICIAL_LANCAMENTO_PATTERNS.some((p) => p.test(full));
}

/**
 * URL do GitHub que casa o padrão oficial de uma org de lab (raiz de repo ou
 * release de tag estável). Só confere ORIGEM: não verifica se o repo é novo
 * (isso é o corte por data) nem a tag do feed (`tagPattern`, aplicado antes).
 * Repo/release da org é tratado como algo sendo lançado → LANÇAMENTOS.
 */
function isOfficialGithubLaunch(url: string): boolean {
  return /^https?:\/\/(?:www\.)?github\.com\//i.test(url) && isOfficialHost(url);
}

export function suggestSubstitution(
  article: { url: string; title: string },
  highlights: readonly HighlightLike[],
  currentOrder?: readonly string[],
): SubstitutionSuggestion {
  const signal = detectFrontierLaunch(article);
  if (signal?.route === "official" && signal.strength === "model") {
    const current = currentHighlights(highlights, currentOrder);
    const negatives = current.filter(({ h }) => isNegative(h)).length;
    const replaceable = current
      .filter(({ h }) => h.bucket !== "manual" && typeof h.score === "number")
      .filter(({ h }) => !(isNegative(h) && negatives <= 1))
      .sort((a, b) => (a.h.score as number) - (b.h.score as number));
    if (replaceable.length > 0) {
      const { h, slot } = replaceable[0];
      return {
        target: "destaque",
        slot,
        reason: `lançamento oficial de ${signal.matched} — ${slot} tem o menor score do pipeline (${h.score})`,
      };
    }
    return { target: "destaque", slot: "?", reason: `lançamento oficial de ${signal.matched} — todos os destaques são manuais/protegidos, editor escolhe` };
  }
  const official = isOfficialHost(article.url);
  // #9457: "Introducing X" também é anúncio em host oficial fora de FRONTIER_LABS.
  const announces = hasLaunchVerb(article.title) !== undefined || /^\s*introducing\b/i.test(article.title);
  if (signal?.route === "official" || (official && announces)) {
    return { target: "pool", slot: "LANÇAMENTOS", reason: "anúncio em host oficial do laboratório" };
  }
  // #9424: repo novo/release da org oficial no GitHub — link oficial (#160).
  if (isOfficialGithubLaunch(article.url)) {
    return { target: "pool", slot: "LANÇAMENTOS", reason: "repositório/release no GitHub oficial do laboratório" };
  }
  return { target: "pool", slot: "RADAR", reason: official ? "post oficial que não anuncia lançamento" : "fonte não oficial" };
}

// ---------------------------------------------------------------------------
// Relatório + bloco do gate
// ---------------------------------------------------------------------------

export interface LateCandidate extends LateArticle {
  suggestion: SubstitutionSuggestion;
}

export interface LateRefreshReport {
  generated_at: string;
  cutoffs: CutoffResolution;
  feeds: Array<{
    name: string;
    lab: string;
    ok: boolean;
    items_after_cutoff: number;
    /** Entradas brutas da fonte (#9424) — com `after_filter`, denuncia mudança de formato. */
    raw_entries?: number;
    /** Entradas depois do filtro do método, antes do corte por data (#9424). */
    after_filter?: number;
    /** Havia entradas e nenhuma no formato esperado (#9424). */
    format_suspect?: boolean;
    error?: string;
  }>;
  uncovered_labs: readonly string[];
  candidates: LateCandidate[];
  already_in_edition: number;
  already_published: number;
  newsletters: LateThreadSummary[];
  newsletter_error?: string;
  skipped_reason?: string;
}

function brt(iso: string | null): string {
  if (!iso) return "?";
  const d = new Date(new Date(iso).getTime() - 3 * 3600_000);
  return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/** Bloco texto puro (sem markdown) pro resumo do gate 4. Uma linha quando não há nada. */
export function formatLateRefreshBlock(r: LateRefreshReport): string {
  if (r.skipped_reason) return `⚠️ Refresh tardio indisponível: ${r.skipped_reason}`;
  const header = `Corte: pesquisa iniciada ${brt(r.cutoffs.research_cutoff)} BRT. Nada é alterado sozinho — inclusão é decisão sua (ajustar / §4d.1b).`;
  const failed = r.feeds.filter((f) => !f.ok);
  const lines: string[] = [header];
  const failedNames = failed.map((f) => f.name).join(", ");
  if (r.candidates.length === 0 && r.newsletters.length === 0) {
    // #9424: com feed falhando, "nada novo" vale só para quem respondeu.
    lines.push(
      failed.length > 0
        ? `✅ Nada novo nas fontes que responderam — ${failed.length} feed(s) com falha: ${failedNames}.`
        : "✅ Nada novo nas fontes oficiais nem nas newsletters desde a pesquisa.",
    );
  }
  for (const c of r.candidates) {
    lines.push(`🆕 [${c.lab}] ${c.title || "(sem título)"} — ${brt(c.published_at)} BRT`);
    lines.push(`   ${c.url}`);
    lines.push(`   → sugestão: ${c.suggestion.target === "destaque" ? `substituir ${c.suggestion.slot}` : `entrar em ${c.suggestion.slot}`} (${c.suggestion.reason})`);
  }
  for (const n of r.newsletters) {
    const flag = n.mentions_flagship ? "⚡ " : "";
    lines.push(`📨 ${flag}${n.sender}: "${n.subject}" — ${brt(n.date)} BRT, ${n.new_urls} link(s) novo(s)`);
    for (const u of n.lab_urls) lines.push(`   ${u}`);
  }
  const notes: string[] = [];
  if (r.already_in_edition + r.already_published > 0) {
    notes.push(`${r.already_in_edition} já na edição, ${r.already_published} já publicado(s) antes`);
  }
  // Já dito na linha do "nada novo" quando não há candidato — não repetir.
  if (failed.length > 0 && (r.candidates.length > 0 || r.newsletters.length > 0)) notes.push(`feeds com falha: ${failedNames}`);
  const suspect = r.feeds.filter((f) => f.ok && f.format_suspect);
  if (suspect.length > 0) {
    notes.push(`formato mudou? entradas recebidas mas nenhuma reconhecida em: ${suspect.map((f) => `${f.name} (${f.raw_entries ?? "?"} brutas, ${f.after_filter ?? 0} após filtro)`).join(", ")}`);
  }
  if (r.newsletter_error) notes.push(`newsletters indisponíveis: ${r.newsletter_error}`);
  if (r.uncovered_labs.length > 0) notes.push(`sem feed oficial (só via newsletter): ${r.uncovered_labs.join(", ")}`);
  if (notes.length > 0) lines.push(`ℹ️ ${notes.join(" · ")}`);
  return lines.join("\n");
}
