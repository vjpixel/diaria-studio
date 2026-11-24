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
}
const outside = "fora da edição";
const realTitle = (title: string) => !!title && !isNonDescriptiveTitle(title);
function sameTitle(a: string, b: string): boolean {
  return realTitle(a) && realTitle(b) &&
    (titleSimilarity(a, b) >= CONFIG.dedup.titleThreshold || sameStorySignal(a, b) !== null);
}
/** Reusa categoria + filtro temático do pool, inclusive a denylist de assuntos não IA. */
export function consensusAIRelevant(item: Item & {url: string; title: string}): boolean {
  const article = {...item, summary: typeof item.summary === "string" ? item.summary : ""};
  const {category} = categorizeWithRule(article);
  return category === "noticias" ? isArticleAIRelevant(article) : !isNonAITopic(article);
}

export function buildNewsletterConsensus(links: ConsensusLink[], metadata: Item[], final: Item[], removals: Item[],
  keyOf: (url: string) => string): NewsletterConsensus[] {
  const byUrl = new Map<string, Item>();
  for (const item of metadata) for (const alias of [item.url, item.original_url, item.resolvedFrom]) {
    if (typeof alias === "string") byUrl.set(keyOf(alias), {...byUrl.get(keyOf(alias)), ...item});
  }
  const enriched = links.map((l) => {
    const meta = byUrl.get(keyOf(l.url));
    return {...l, summary: meta?.summary,
      title: realTitle(l.title) ? l.title : typeof meta?.title === "string" ? meta.title : l.title};
  });
  // Mesmo single-linkage do Pass 2b do dedup. Unir TODOS os grupos correspondentes
  // evita perder cobertura quando uma terceira URL conecta duas coberturas anteriores.
  const groups: typeof enriched[] = [];
  for (const link of enriched) {
    const matches = groups.filter((g) => g.some((m) => keyOf(m.url) === keyOf(link.url) || sameTitle(m.title, link.title)));
    const group = [link, ...matches.flat()];
    for (const match of matches) groups.splice(groups.indexOf(match), 1);
    groups.push(group);
  }
  return groups.flatMap((group) => {
    const senders = new Map(group.map((l) => [senderKey(l.newsletter), senderDisplayName(l.newsletter)]));
    const theNews = group.some((l) => ["created@thenewscc.com.br", "newsletter@thenewscc.com.br"].includes(senderKey(l.newsletter)) && consensusAIRelevant({...l, summary: l.summary}));
    if (senders.size < 2 && !theNews) return [];
    const best = [...group].sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity) || Number(realTitle(b.title)) - Number(realTitle(a.title)) || a.url.localeCompare(b.url))[0];
    const matches = (item: Item) => typeof item.url === "string" && group.some((l) =>
      keyOf(item.url as string) === keyOf(l.url) || (typeof item.title === "string" && sameTitle(l.title, item.title)));
    const destinations = final.filter(matches).map((item) => String(item.destination ?? "seção"));
    if (!destinations.length) destinations.push(...group.filter((l) => l.destino !== outside).map((l) => l.destino));
    const reasons = removals.filter(matches).map((item) => String(item.reason ?? item.dedup_note ?? item.match_type ?? "dedup"));
    const reason = reasons.length ? [...new Set(reasons)].join("; ") : group.some((l) => l.in_pool === true)
      ? "não selecionado após scoring (corte por score/seleção; motivo específico não registrado)"
      : "removido antes do pool; motivo não registrado";
    return [{title: realTitle(best.title) ? best.title : group.find((l) => realTitle(l.title))?.title ?? best.title, url: best.url, urls: [...new Set(group.map((l) => l.url))].sort(),
      count: senders.size, newsletters: [...senders.values()].sort(), score: best.score,
      destino: destinations.length ? [...new Set(destinations)].join(", ") : `${outside}: ${reason}`,
      the_news: theNews, score_warning: group.find((l) => l.fetch_error)?.fetch_error}];
  }).sort((a, b) => b.count - a.count || (b.score ?? -Infinity) - (a.score ?? -Infinity) || a.url.localeCompare(b.url));
}
const cell = (s: unknown) => String(s).replace(/[\r\n|]/g, " ");
export function renderNewsletterConsensus(items: NewsletterConsensus[]): string[] {
  return ["## Consenso de assuntos das newsletters (informativo, não bloqueia)",
    "| Assunto | Nº | Newsletters | Score do melhor link | Onde está | URL |", "| --- | --- | --- | --- | --- | --- |",
    ...items.map((i) => `| ${cell(i.title)} | ${i.count} | ${cell(i.newsletters.join(", "))}${i.the_news ? " (IA no The News)" : ""} | ${i.score ?? (i.score_warning ? `FALHA FETCH: ${cell(i.score_warning)}` : "PENDENTE — pontuar com scorer")} | ${cell(i.destino)} | ${cell(i.url)} |`),
    ...(!items.length ? ["Nenhum assunto de 2+ newsletters ou de IA do The News identificado."] : []), ""];
}
