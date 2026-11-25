/** #13885: consenso por história, sobre todo o intake, sem alterar a seleção. */
import { senderKey } from "./newsletter-senders.ts";
import { senderDisplayName } from "./newsletter-multi-cited.ts";
import { sameStorySignal } from "./story-grouping.ts";
import { titleSimilarity } from "./title-similarity.ts";
import { isNonDescriptiveTitle } from "./placeholder-title-guard.ts";
import { categorizeWithRule, isArticleAIRelevant } from "./launch-heuristics.ts";
import { isNonAITopic } from "./ai-relevance.ts";
import { CONFIG } from "./config.ts";

export interface ConsensusLink {
  url: string; title: string; score: number | null; newsletter: string; destino: string;
  in_pool: boolean | null; fetch_error?: string;
}
type Item = Record<string, unknown>;
export interface NewsletterConsensus {
  title: string; url: string; urls: string[]; count: number; newsletters: string[];
  score: number | null; destino: string; the_news: boolean; score_warning?: string;
  /** Nenhum membro do grupo tem título descritivo: `title` é só o rótulo de exibição. */
  title_pending?: boolean;
}
const outside = "fora da edição";
/**
 * Review da PR #13917: título de página genérica ("Home", "Home | Marca", "Início")
 * não descreve matéria nenhuma e juntava anthropic.com com deasylabs.com.
 */
const GENERIC_TITLE_RE = /^(home(\s*page)?|homepage|in[íi]cio|p[áa]gina inicial|welcome|bem[- ]vind[oa]s?|blog|news|not[íi]cias|index|untitled|sem t[íi]tulo)$/i;
function isGenericTitle(title: string): boolean {
  const t = title.trim();
  if (GENERIC_TITLE_RE.test(t)) return true;
  // "Home | Marca", "Marca - Home": um dos lados do separador é genérico.
  return t.split(/\s+[|–—-]\s+/).some((part) => GENERIC_TITLE_RE.test(part.trim()));
}
export const realTitle = (title: string) => !!title && !isNonDescriptiveTitle(title) && !isGenericTitle(title);
/** Para juntar URLs DIFERENTES o título precisa de corpo: 1-2 palavras ("Anthropic", "GPT-Live Model") só juntam pela URL. */
const MIN_MATCH_WORDS = 3;
const matchableTitle = (title: string) => realTitle(title) && title.trim().split(/\s+/).length >= MIN_MATCH_WORDS;
/** Raiz de site (anthropic.com/, deasylabs.com/?x=1) não é matéria: só junta pela própria URL. */
function isRootUrl(url: string): boolean {
  try { return /^\/?$/.test(new URL(url).pathname); } catch { return false; }
}
/**
 * Rótulo próprio do título — "Crossfade: ...", "GitHub - Illyism/seo-skills: ..." —
 * quando curto (≤5 palavras). Dois títulos com rótulos diferentes, nenhum citado
 * no outro, falam de coisas diferentes mesmo que citem as mesmas ferramentas
 * (review da PR #13917: Crossfade × seo-skills por "Claude Code, Cursor, Codex").
 */
function titleHead(title: string): string | null {
  const head = title.split(":")[0].replace(/^github\s*-\s*/i, "").trim();
  return head !== title.trim() && head.split(/\s+/).length <= 5 ? head.toLowerCase() : null;
}
function headsConflict(a: string, b: string): boolean {
  const ha = titleHead(a), hb = titleHead(b);
  return !!ha && !!hb && ha !== hb && !b.toLowerCase().includes(ha) && !a.toLowerCase().includes(hb);
}
function sameTitle(a: string, b: string): boolean {
  if (!matchableTitle(a) || !matchableTitle(b) || headsConflict(a, b)) return false;
  return titleSimilarity(a, b) >= CONFIG.dedup.titleThreshold || sameStorySignal(a, b) !== null;
}
/** Rótulo da coluna Assunto sem título real: domínio + caminho, nunca o placeholder `(newsletter:...)`. */
export function pendingTitleLabel(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/$/, "");
    return `título pendente (${u.hostname.replace(/^www\./, "")}${path.length > 60 ? path.slice(0, 60) + "…" : path})`;
  } catch { return "título pendente"; }
}
const DAY_MS = 86_400_000;
/**
 * Janela (dias) entre datas de URLs diferentes ainda tratadas como o mesmo evento.
 * #13921: era 2 e separava anúncio (17/11) da cobertura do mesmo fato (20/11); 4 cobre
 * esse atraso e ainda separa o caso que motivou a janela (Jensen Huang, 17/11 × 23/11).
 */
export const CONSENSUS_DATE_WINDOW_DAYS = 4;
/** Data da matéria: metadado do pool, senão a data no caminho da URL (/2026/11/17/, 2026-11-20). */
export function storyDate(url: string, meta?: Item): number | null {
  for (const key of ["date", "published_date", "published_at", "publishedAt"]) {
    const v = meta?.[key];
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) { const t = Date.parse(v.slice(0, 10)); if (Number.isFinite(t)) return t; }
  }
  let path = "";
  try { path = new URL(url).pathname; } catch { return null; }
  const m = path.match(/(?:^|\/|\D)(20\d\d)[/-](\d\d)[/-](\d\d)(?=\/|-|\.|$|\D)/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  // #13921: Date.UTC normaliza dia inválido (/2026/11/45/ viraria 15/12); só aceita data que volta igual.
  const back = new Date(t);
  return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d ? t : null;
}
/** Reusa categoria + filtro temático do pool, inclusive a denylist de assuntos não IA. */
export function consensusAIRelevant(item: Item & {url: string; title: string}): boolean {
  const article = {...item, summary: typeof item.summary === "string" ? item.summary : ""};
  const {category} = categorizeWithRule(article);
  return category === "noticias" ? isArticleAIRelevant(article) : !isNonAITopic(article);
}

/**
 * `alwaysSenders`: chaves (`senderKey`) dos remetentes aprovados com `consensus_ai_always`
 * no registro (`seed/newsletter-senders.json`, hoje o The News). Identifica pelo endereço,
 * nunca pelo nome de exibição; o endereço mora no registro, não no código.
 */
export function buildNewsletterConsensus(links: ConsensusLink[], metadata: Item[], final: Item[], removals: Item[],
  keyOf: (url: string) => string, alwaysSenders: ReadonlySet<string> = new Set()): NewsletterConsensus[] {
  const byUrl = new Map<string, Item>();
  for (const item of metadata) for (const alias of [item.url, item.original_url, item.resolvedFrom]) {
    if (typeof alias === "string") byUrl.set(keyOf(alias), {...byUrl.get(keyOf(alias)), ...item});
  }
  const enriched = links.map((l) => {
    const meta = byUrl.get(keyOf(l.url));
    return {...l, summary: meta?.summary, date: storyDate(l.url, meta),
      title: realTitle(l.title) ? l.title : typeof meta?.title === "string" ? meta.title : l.title};
  });
  type Link = typeof enriched[number];
  // 1) Mesma URL é sempre o mesmo assunto.
  const units = new Map<string, Link[]>();
  for (const link of enriched) units.set(keyOf(link.url), [...(units.get(keyOf(link.url)) ?? []), link]);
  const unitTitle = (u: Link[]) => u.find((l) => realTitle(l.title))?.title ?? u[0].title;
  const unitSenders = (u: Link[]) => new Set(u.map((l) => senderKey(l.newsletter))).size;
  // 2) URLs diferentes só se juntam casando com o REPRESENTANTE do grupo (a unidade
  // mais citada), nunca com qualquer membro: single-linkage encadeava assuntos
  // intermediários (review da PR #13917). Ordem determinística, mais citada primeiro.
  const ordered = [...units.values()].sort((a, b) => unitSenders(b) - unitSenders(a) ||
    Number(matchableTitle(unitTitle(b))) - Number(matchableTitle(unitTitle(a))) || keyOf(a[0].url).localeCompare(keyOf(b[0].url)));
  type Cluster = {rep: string; units: Link[][]};
  /** Agrupa por representante: cada unidade só entra casando com o `rep` (1ª unidade) de um grupo. */
  const clusterByRep = (list: Link[][]): Cluster[] => {
    const out: Cluster[] = [];
    for (const unit of list) {
      const title = unitTitle(unit);
      const target = isRootUrl(unit[0].url) ? undefined : out.find((c) => !isRootUrl(c.units[0][0].url) && sameTitle(c.rep, title));
      if (target) target.units.push(unit); else out.push({rep: title, units: [unit]});
    }
    return out;
  };
  const clusters = clusterByRep(ordered);
  // 3) Desempate por data: matérias com data a mais de CONSENSUS_DATE_WINDOW_DAYS da data
  // dominante do grupo são outro evento da mesma empresa (Jensen Huang sai em 17/11,
  // volta em 23/11) e saem do grupo; sem data, ficam.
  const groups: Link[][] = [];
  const pending = [...clusters];
  while (pending.length) {
    const cluster = pending.shift()!;
    const dated = cluster.units.filter((u) => u[0].date !== null);
    const near = (a: number, b: number) => Math.abs(a - b) <= CONSENSUS_DATE_WINDOW_DAYS * DAY_MS;
    const weight = (d: number) => new Set(dated.filter((u) => near(u[0].date!, d)).flatMap((u) => u.map((l) => senderKey(l.newsletter)))).size;
    const anchor = dated.map((u) => u[0].date!).sort((a, b) => weight(b) - weight(a) || b - a)[0];
    const outliers = anchor === undefined ? [] : cluster.units.filter((u) => u[0].date !== null && !near(u[0].date, anchor));
    const kept = cluster.units.filter((u) => !outliers.includes(u));
    // #13921: se o representante saiu pela data, os que ficaram só estavam juntos por
    // casarem com ele; reagrupam entre si contra um representante novo (mesma ordem).
    if (outliers.includes(cluster.units[0])) pending.unshift(...clusterByRep(kept));
    else groups.push(kept.flat());
    // Os expulsos reagrupam entre si (podem formar o seu próprio assunto).
    for (const unit of outliers) {
      const title = unitTitle(unit);
      const target = pending.find((c) => c.units.every((u) => outliers.includes(u)) && sameTitle(c.rep, title));
      if (target) target.units.push(unit); else pending.push({rep: title, units: [unit]});
    }
  }
  return groups.flatMap((group) => {
    const senders = new Map(group.map((l) => [senderKey(l.newsletter), senderDisplayName(l.newsletter)]));
    const theNews = group.some((l) => alwaysSenders.has(senderKey(l.newsletter)) && consensusAIRelevant({...l, summary: l.summary}));
    if (senders.size < 2 && !theNews) return [];
    const best = [...group].sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity) || Number(realTitle(b.title)) - Number(realTitle(a.title)) || a.url.localeCompare(b.url))[0];
    const repTitle = group.find((l) => realTitle(l.title))?.title ?? "";
    // URL de qualquer membro, ou título casando com o representante (nunca com qualquer membro).
    const matches = (item: Item) => typeof item.url === "string" && (group.some((l) => keyOf(item.url as string) === keyOf(l.url)) ||
      (typeof item.title === "string" && !isRootUrl(item.url) && sameTitle(repTitle, item.title)));
    const destinations = final.filter(matches).map((item) => String(item.destination ?? "seção"));
    if (!destinations.length) destinations.push(...group.filter((l) => l.destino !== outside).map((l) => l.destino));
    const reasons = removals.filter(matches).map((item) => String(item.reason ?? item.dedup_note ?? item.match_type ?? "dedup"));
    const reason = reasons.length ? [...new Set(reasons)].join("; ") : group.some((l) => l.in_pool === true)
      ? "não selecionado após scoring (corte por score/seleção; motivo específico não registrado)"
      : "removido antes do pool; motivo não registrado";
    const shown = realTitle(best.title) ? best.title : repTitle;
    return [{title: shown || pendingTitleLabel(best.url), ...(shown ? {} : {title_pending: true}),
      url: best.url, urls: [...new Set(group.map((l) => l.url))].sort(),
      count: senders.size, newsletters: [...senders.values()].sort(), score: best.score,
      destino: destinations.length ? [...new Set(destinations)].join(", ") : `${outside}: ${reason}`,
      the_news: theNews, score_warning: group.find((l) => l.fetch_error)?.fetch_error}];
  }).sort((a, b) => b.count - a.count || (b.score ?? -Infinity) - (a.score ?? -Infinity) || a.url.localeCompare(b.url));
}
/**
 * Insumo do `scorer-chunk` (`newsletter-consensus-unscored.json`): os assuntos sem score.
 * Título só quando real — o rótulo "título pendente (...)" e o placeholder
 * `(newsletter:...)` nunca vão como `title` (o scorer pontuaria o placeholder).
 */
export function consensusUnscoredArticles(consensus: NewsletterConsensus[], metadata: Item[], keyOf: (url: string) => string): Item[] {
  return consensus.filter((g) => g.score === null).map((g) => {
    const {title: metaTitle, ...meta} = metadata.find((i) => typeof i.url === "string" && keyOf(i.url) === keyOf(g.url)) ?? {};
    const title = !g.title_pending ? g.title : typeof metaTitle === "string" && realTitle(metaTitle) ? metaTitle : undefined;
    return {...meta, url: g.url, ...(title ? {title} : {title_unresolved: true}), flag: "newsletter_extracted"};
  });
}
const cell = (s: unknown) => String(s).replace(/[\r\n|]/g, " ");
export function renderNewsletterConsensus(items: NewsletterConsensus[]): string[] {
  return ["## Consenso de assuntos das newsletters (informativo, não bloqueia)",
    "| Assunto | Nº | Newsletters | Score do melhor link | Onde está | URL |", "| --- | --- | --- | --- | --- | --- |",
    ...items.map((i) => `| ${cell(i.title)} | ${i.count} | ${cell(i.newsletters.join(", "))}${i.the_news ? " (IA no The News)" : ""} | ${i.score ?? (i.score_warning ? `FALHA FETCH: ${cell(i.score_warning)}` : "PENDENTE — pontuar com scorer")} | ${cell(i.destino)} | ${cell(i.url)} |`),
    ...(!items.length ? ["Nenhum assunto de 2+ newsletters ou de IA do The News identificado."] : []), ""];
}
