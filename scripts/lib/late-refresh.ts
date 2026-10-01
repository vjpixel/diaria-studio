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

// ---------------------------------------------------------------------------
// Fontes
// ---------------------------------------------------------------------------

export interface LateRefreshFeed {
  lab: string;
  name: string;
  url: string;
  method: "rss" | "sitemap";
  /** Só sitemap: mantém só entradas cujo path começa com este prefixo (o sitemap lista o site inteiro). */
  pathPrefix?: string;
}

/**
 * Feeds oficiais verificados ao vivo em 2026-10-01 (HTTP 200 + parse ok).
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
];

/**
 * Laboratórios da lista da #9370 SEM feed máquina-legível (sondado em
 * 2026-10-01: Meta `ai.meta.com/blog/rss/` 400, xAI `rss.xml` 404 e sitemap
 * 403, Mistral `news/rss.xml` 404, DeepSeek sitemap só de docs, Qwen sitemap
 * serve HTML). Ficam cobertos só indiretamente pelas newsletters — reportado
 * no output em vez de omitido em silêncio.
 */
export const LATE_REFRESH_UNCOVERED_LABS: readonly string[] = ["Meta", "xAI", "Mistral", "DeepSeek", "Qwen"];

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
 * Regra determinística (sugestão, nunca aplicada sozinha):
 * - Lançamento oficial de modelo versionado (o sabor que o editor aprovou 92%
 *   das vezes, #9359) → candidato a destaque, substituindo o D de MENOR score
 *   do pipeline. Destaque `manual` (escolha do editor) e o ÚNICO destaque de
 *   impacto negativo (regra #3916) nunca são sugeridos para sair.
 * - Post em host oficial que ANUNCIA algo ("Introducing X" ou verbo de
 *   lançamento no título) → LANÇAMENTOS (link oficial, #160).
 * - Resto (case de cliente, ensaio, imprensa) → RADAR.
 */
export function suggestSubstitution(article: { url: string; title: string }, highlights: readonly HighlightLike[]): SubstitutionSuggestion {
  const signal = detectFrontierLaunch(article);
  if (signal?.route === "official" && signal.strength === "model") {
    const negatives = highlights.filter(isNegative).length;
    const replaceable = highlights
      .map((h, i) => ({ h, d: `D${h.rank ?? i + 1}` }))
      .filter(({ h }) => h.bucket !== "manual" && typeof h.score === "number")
      .filter(({ h }) => !(isNegative(h) && negatives <= 1))
      .sort((a, b) => (a.h.score as number) - (b.h.score as number));
    if (replaceable.length > 0) {
      const { h, d } = replaceable[0];
      return {
        target: "destaque",
        slot: d,
        reason: `lançamento oficial de ${signal.matched} — ${d} tem o menor score do pipeline (${h.score})`,
      };
    }
    return { target: "destaque", slot: "?", reason: `lançamento oficial de ${signal.matched} — todos os destaques são manuais/protegidos, editor escolhe` };
  }
  const official = frontierLabOfUrl(article.url) !== undefined;
  if (signal?.route === "official" || (official && hasLaunchVerb(article.title) !== undefined)) {
    return { target: "pool", slot: "LANÇAMENTOS", reason: "anúncio em host oficial do laboratório" };
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
  feeds: Array<{ name: string; lab: string; ok: boolean; items_after_cutoff: number; error?: string }>;
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
  if (r.candidates.length === 0 && r.newsletters.length === 0) {
    lines.push("✅ Nada novo nas fontes oficiais nem nas newsletters desde a pesquisa.");
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
  if (failed.length > 0) notes.push(`feeds com falha: ${failed.map((f) => f.name).join(", ")}`);
  if (r.newsletter_error) notes.push(`newsletters indisponíveis: ${r.newsletter_error}`);
  if (r.uncovered_labs.length > 0) notes.push(`sem feed oficial (só via newsletter): ${r.uncovered_labs.join(", ")}`);
  if (notes.length > 0) lines.push(`ℹ️ ${notes.join(" · ")}`);
  return lines.join("\n");
}
