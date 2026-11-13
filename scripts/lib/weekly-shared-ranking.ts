/**
 * weekly-shared-ranking.ts (#13022)
 *
 * Seleção ÚNICA compartilhada do pacote semanal (`/diaria-pacote-semanal`):
 * um ranking por clique da semana alimenta o carrossel `clicked` da retro
 * (5 itens, D1/D2/D3/RADAR) e as manchetes do LinkedIn semanal (3 itens, só
 * destaques, #8029). Cada produto aplica o seu filtro sobre o MESMO ranking, e
 * uma troca feita no gate vale nos dois produtos quando o item novo é
 * elegível nos dois. Núcleo puro (sem disco, sem rede); o CLI é
 * `scripts/weekly-shared-selection.ts`.
 *
 * ## Métrica e regra de empate (decisão do #13022)
 *
 * **Métrica:** a taxa de clique verificado já comum às duas skills —
 * `(unique_verified_clicks + web.total_unique_clicked) / unique_opens` da
 * edição de origem (`toRankedCandidate` dos dois lados calcula igual), com a
 * mesma exclusão comercial/própria (`weekly-social-click-rank.ts`). Nada muda
 * no número de cada candidato.
 *
 * **Regra de empate:** a do LinkedIn (`fillSlotsWithNoiseRule`,
 * `weekly-linkedin-select.ts`), aplicada aos DOIS recortes:
 *   - fora da banda de ruído de 1 clique, a taxa decide;
 *   - banda que cabe nas vagas restantes: todos entram;
 *   - banda maior que as vagas: diversidade de DIA decide sozinha quando os
 *     candidatos de dia ainda sem item cabem exatamente nas vagas (#8817);
 *   - senão a banda vira `pending` e a decisão é do editor no gate (#5109).
 *
 * Por que a do LinkedIn e não a da retro (desempate editorial automático por
 * ângulo Brasil > implicação profissional > categoria, com a preferência do
 * #10378 por quem ficou fora do highlights): a regra do LinkedIn é a única
 * das duas que o editor decidiu explicitamente depois de ver a automática
 * errar (#5109, ciclo 26w32: a banda engoliu 6 candidatos e o CTOR virou
 * critério terciário), e a issue manda preservar #5109 e #8817. Como o pacote
 * tem um gate consolidado, levar o empate do `clicked` ao editor não custa
 * uma parada a mais. O desempate editorial da retro continua existindo como
 * SUGESTÃO pré-marcada (`suggested`) para cada empate pendente, inclusive a
 * preferência do #10378 no `clicked`; o editor confirma ou troca no gate.
 * Com `--no-gates` o `clicked` sai com a sugestão (equivale ao comportamento
 * automático de hoje) e o LinkedIn não é colado.
 *
 * O que muda em cada produto, comparado às skills isoladas:
 *   - `clicked`: empate maior que as vagas deixa de ser resolvido sozinho
 *     pelo desempate editorial; a diversidade de dia (#8817) passa a valer
 *     antes dele.
 *   - LinkedIn: nada na regra. Muda só a origem da lista (o ranking
 *     compartilhado, com trocas do gate propagadas do `clicked`).
 *
 * As skills isoladas (`/diaria-retro-semanal`, `/diaria-linkedin-semanal`)
 * seguem com a seleção própria: este módulo só entra quando o script recebe
 * `--shared-selection`.
 *
 * ## Cliques de sexta imaturos (premissa do #13022)
 *
 * O ranking NÃO normaliza por idade do dado de clique. `clickAgeReport`
 * mede, por edição, quantas horas de clique ela tem no momento da seleção, e
 * o gate mostra isso com aviso para a edição com menos de
 * `IMMATURE_CLICK_HOURS` (a sexta, quando o pacote roda sexta ou sábado).
 * O editor pode mudar essa premissa depois (normalizar ou excluir a sexta).
 */

import { byRateDescThenTitle, editorialTiebreakScore } from "./weekly-social-click-rank.ts";
import {
  applyPendingPicks,
  computeHeadlineCap,
  dedupeCandidatesByUrl,
  fillSlotsWithNoiseRule,
  type WeeklyRankedCandidate,
} from "./weekly-linkedin-select.ts";
import { normalizeUrl } from "./weekly-linkedin-clicks.ts";

export type SharedProduct = "clicked" | "linkedin";
export const SHARED_PRODUCTS: readonly SharedProduct[] = ["clicked", "linkedin"];

/** Vagas do carrossel `clicked` — mesmo número de `WEEKLY_EXPECTED_ITEMS` (`publish-weekly-social.ts`). */
export const CLICKED_SLOTS = 5;

/** Abaixo disto o dado de clique da edição é "imaturo" e o gate avisa (#13022). */
export const IMMATURE_CLICK_HOURS = 48;

export class SharedSelectionError extends Error {}

/**
 * Pure: o candidato é elegível para o produto?
 *   - `linkedin`: só destaque (#8029).
 *   - `clicked`: destaque ou RADAR (#4513; USE MELHOR fora desde o #5319,
 *     LANÇAMENTOS/VÍDEOS nunca entraram) — o mesmo pool de
 *     `extractInstagramCandidates`.
 * Link comercial/afiliado/próprio nunca é elegível.
 */
export function isEligibleFor(product: SharedProduct, c: WeeklyRankedCandidate): boolean {
  if (c.excluded) return false;
  if (product === "linkedin") return c.kind === "destaque";
  return c.kind === "destaque" || c.section === "radar";
}

export interface SharedRanking {
  /** Elegíveis para pelo menos um produto, ordenados por taxa (desempate estável por título). */
  ranked: WeeklyRankedCandidate[];
  /** Excluídos por comercial/afiliado/próprio — auditoria. */
  excluded: WeeklyRankedCandidate[];
}

/** Pure: o ranking único da semana. */
export function buildSharedRanking(candidates: WeeklyRankedCandidate[]): SharedRanking {
  const deduped = dedupeCandidatesByUrl(candidates);
  return {
    ranked: deduped
      .filter((c) => SHARED_PRODUCTS.some((p) => isEligibleFor(p, c)))
      .sort(byRateDescThenTitle),
    excluded: deduped.filter((c) => c.excluded),
  };
}

export interface PendingTie {
  /** URLs do grupo empatado, na ordem do ranking. */
  group: string[];
  /** Vagas que o grupo disputa. */
  slots: number;
  /** Sugestão pré-marcada (desempate editorial; no `clicked` com a preferência do #10378). */
  suggested: string[];
  /** `editor` = escolha confirmada (`--pick` ou `--confirm-suggestions`); `suggestion` = ainda só sugestão. */
  resolution: "editor" | "suggestion";
}

export interface ProductSelection {
  product: SharedProduct;
  slots: number;
  /** Ordem final do produto: decididos pela regra + escolha/sugestão do empate, já com as trocas do gate. */
  urls: string[];
  pending: PendingTie | null;
  /** `true` quando alguma troca do gate mexeu neste produto (a ordem deixa de ser só a do clique). */
  manual: boolean;
  warnings: string[];
}

/** URLs dos D1 da semana (o carrossel highlights) — usado na sugestão do #10378. */
export function highlightD1Urls(candidates: WeeklyRankedCandidate[]): Set<string> {
  return new Set(
    candidates
      .filter((c) => !c.excluded && c.kind === "destaque" && c.destaqueN === 1)
      .map((c) => normalizeUrl(c.url)),
  );
}

/**
 * Pure: sugestão para um empate pendente — preenche as vagas uma a uma pelo
 * maior `editorialTiebreakScore` (o critério que a retro usava sozinho), com
 * a diversidade de categoria recalculada a cada escolha.
 */
export function suggestTieFill(
  group: WeeklyRankedCandidate[],
  slots: number,
  alreadySelected: WeeklyRankedCandidate[],
  isInHighlights?: (c: WeeklyRankedCandidate) => boolean,
): WeeklyRankedCandidate[] {
  const categories = new Set(alreadySelected.map((c) => c.category.toUpperCase()));
  let remaining = [...group];
  const out: WeeklyRankedCandidate[] = [];
  while (out.length < slots && remaining.length > 0) {
    const best = remaining
      .map((c) => ({ c, score: editorialTiebreakScore(c, categories, isInHighlights) }))
      .sort((x, y) => y.score - x.score || byRateDescThenTitle(x.c, y.c))[0].c;
    out.push(best);
    categories.add(best.category.toUpperCase());
    remaining = remaining.filter((c) => c !== best);
  }
  return out;
}

/**
 * Pure: recorte de um produto sobre o ranking compartilhado.
 *
 * `picks` resolve o empate pendente com a escolha do editor (mesma exatidão
 * do `--picks` do LinkedIn, `applyPendingPicks`); `confirmSuggestion` marca a
 * sugestão como aceita no gate. Sem nenhum dos dois, o empate fica
 * `resolution: "suggestion"` e `urls` traz a sugestão para a prévia.
 */
export function selectForProduct(
  ranking: SharedRanking,
  product: SharedProduct,
  slots: number,
  opts: { picks?: string[]; confirmSuggestion?: boolean; highlightUrls?: Set<string> } = {},
): ProductSelection {
  const pool = ranking.ranked.filter((c) => isEligibleFor(product, c));
  const { selected, pendingGroup, warnings } = fillSlotsWithNoiseRule(pool, slots);
  const tagged = warnings.map((w) => `[${product}] ${w.replace("no gate (Passo 3)", "no gate consolidado")}`);

  if (!pendingGroup) {
    if (opts.picks && opts.picks.length > 0) {
      throw new SharedSelectionError(
        `[${product}] há escolha de empate gravada (${opts.picks.join(", ")}), mas o ranking atual não tem empate pendente — rode com --reset-overrides.`,
      );
    }
    if (selected.length < slots) tagged.push(`[${product}] só ${selected.length}/${slots} item(ns) elegível(is) na semana.`);
    return { product, slots, urls: selected.map((c) => c.url), pending: null, manual: false, warnings: tagged };
  }

  const pendingSlots = slots - selected.length;
  const isInHighlights =
    product === "clicked" && opts.highlightUrls
      ? (c: WeeklyRankedCandidate) => opts.highlightUrls!.has(normalizeUrl(c.url))
      : undefined;
  const suggested = suggestTieFill(pendingGroup, pendingSlots, selected, isInHighlights);

  let fill: WeeklyRankedCandidate[] = suggested;
  let resolution: PendingTie["resolution"] = opts.confirmSuggestion ? "editor" : "suggestion";
  if (opts.picks && opts.picks.length > 0) {
    const applied = applyPendingPicks(selected, pendingGroup, pendingSlots, opts.picks);
    if (applied.error) throw new SharedSelectionError(`[${product}] escolha do empate inválida: ${applied.error}`);
    fill = applied.selected.slice(selected.length);
    resolution = "editor";
  }

  return {
    product,
    slots,
    urls: [...selected, ...fill].map((c) => c.url),
    pending: {
      group: pendingGroup.map((c) => c.url),
      slots: pendingSlots,
      suggested: suggested.map((c) => c.url),
      resolution,
    },
    manual: false,
    warnings: tagged,
  };
}

export interface SharedSwap {
  out: string;
  in: string;
}

export interface SwapOutcome {
  applied: SharedProduct[];
  skipped: { product: SharedProduct; reason: string }[];
}

/**
 * Pure: aplica uma troca do gate. Vale em todo produto que tem `out` na lista
 * e para o qual `in` é elegível (#13022, decisão 3); nos demais, o produto
 * fica como está e o motivo vai em `skipped`. Muta `selections` (cópias
 * locais do caller). Erro quando `in` não é candidato da semana, é
 * comercial/próprio, ou quando a troca não se aplica a produto nenhum.
 */
export function applySharedSwap(
  selections: Record<SharedProduct, ProductSelection>,
  ranking: SharedRanking,
  swap: SharedSwap,
): SwapOutcome {
  const outKey = normalizeUrl(swap.out);
  const inKey = normalizeUrl(swap.in);
  const incoming = ranking.ranked.find((c) => normalizeUrl(c.url) === inKey);
  if (!incoming) {
    const commercial = ranking.excluded.some((c) => normalizeUrl(c.url) === inKey);
    throw new SharedSelectionError(
      commercial
        ? `troca inválida: "${swap.in}" é link comercial/afiliado/próprio (mesma exclusão da seleção).`
        : `troca inválida: "${swap.in}" não é candidato elegível desta semana.`,
    );
  }
  const outcome: SwapOutcome = { applied: [], skipped: [] };
  for (const product of SHARED_PRODUCTS) {
    const sel = selections[product];
    const idx = sel.urls.findIndex((u) => normalizeUrl(u) === outKey);
    if (idx === -1) continue;
    if (!isEligibleFor(product, incoming)) {
      outcome.skipped.push({
        product,
        reason: product === "linkedin" ? "o item novo não é destaque (#8029)" : "o item novo não é destaque nem RADAR",
      });
      continue;
    }
    if (sel.urls.some((u) => normalizeUrl(u) === inKey)) {
      outcome.skipped.push({ product, reason: "o item novo já está na lista deste produto" });
      continue;
    }
    sel.urls[idx] = incoming.url;
    sel.manual = true;
    outcome.applied.push(product);
  }
  if (outcome.applied.length === 0) {
    const why = outcome.skipped.map((s) => `${s.product}: ${s.reason}`).join("; ");
    throw new SharedSelectionError(
      `troca "${swap.out}" → "${swap.in}" não se aplica a nenhum produto${why ? ` (${why})` : " (o item a sair não está em nenhuma lista)"}.`,
    );
  }
  return outcome;
}

export interface SharedOverrides {
  picks: Partial<Record<SharedProduct, string[]>>;
  swaps: SharedSwap[];
  /** Sugestões dos empates aceitas pelo editor no gate (aprovação do pacote). */
  confirmedSuggestions: SharedProduct[];
}

export const EMPTY_OVERRIDES: SharedOverrides = { picks: {}, swaps: [], confirmedSuggestions: [] };

export interface SharedSelectionCore {
  ranking: SharedRanking;
  clicked: ProductSelection;
  linkedin: ProductSelection;
  swapLog: { swap: SharedSwap; outcome: SwapOutcome }[];
}

/**
 * Pure: monta a seleção dos dois produtos e reaplica as decisões do editor
 * (escolhas de empate, sugestões aceitas e trocas, nesta ordem). `editionsFound`
 * define o teto de manchetes do LinkedIn (`computeHeadlineCap`, semana curta).
 */
export function buildSharedSelection(input: {
  candidates: WeeklyRankedCandidate[];
  editionsFound: number;
  overrides?: SharedOverrides;
}): SharedSelectionCore {
  const overrides = input.overrides ?? EMPTY_OVERRIDES;
  const ranking = buildSharedRanking(input.candidates);
  const highlightUrls = highlightD1Urls(input.candidates);
  const clicked = selectForProduct(ranking, "clicked", CLICKED_SLOTS, {
    picks: overrides.picks.clicked,
    confirmSuggestion: overrides.confirmedSuggestions.includes("clicked"),
    highlightUrls,
  });
  const linkedin = selectForProduct(ranking, "linkedin", computeHeadlineCap(input.editionsFound), {
    picks: overrides.picks.linkedin,
    confirmSuggestion: overrides.confirmedSuggestions.includes("linkedin"),
  });
  const selections = { clicked, linkedin };
  const swapLog = overrides.swaps.map((swap) => ({ swap, outcome: applySharedSwap(selections, ranking, swap) }));
  return { ranking, clicked, linkedin, swapLog };
}

export interface ClickAgeRow {
  editionDate: string;
  /** ISO do envio, ou `null` sem post no cache. */
  sentAt: string | null;
  /** Horas de clique no momento da seleção, ou `null` sem post. */
  hours: number | null;
  immature: boolean;
}

/**
 * Pure: idade do dado de clique por edição (#13022, decisão 4: aceitar e
 * avisar no gate). `sentEpochByDate` = `publish_date` (epoch s) do post que
 * venceu a data no cache (`matchPostsToWindow`).
 */
export function clickAgeReport(
  contentWindow: string[],
  sentEpochByDate: Map<string, number>,
  now: Date,
): { rows: ClickAgeRow[]; warnings: string[] } {
  const rows: ClickAgeRow[] = contentWindow.map((editionDate) => {
    const epoch = sentEpochByDate.get(editionDate);
    if (epoch == null) return { editionDate, sentAt: null, hours: null, immature: false };
    const hours = Math.max(0, Math.round(((now.getTime() - epoch * 1000) / 3_600_000) * 10) / 10);
    return { editionDate, sentAt: new Date(epoch * 1000).toISOString(), hours, immature: hours < IMMATURE_CLICK_HOURS };
  });
  const warnings = rows
    .filter((r) => r.immature)
    .map(
      (r) =>
        `Edição ${r.editionDate} tem só ${r.hours}h de clique (enviada ${r.sentAt}) — o ranking não normaliza por idade (premissa #13022), então os itens dela tendem a perder posição no clicked e no LinkedIn.`,
    );
  return { rows, warnings };
}
