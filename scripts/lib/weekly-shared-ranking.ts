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
 * Com `--no-gates` o `clicked` sai com a sugestão (depois do #8817, que agora
 * vem antes do desempate editorial; não é idêntico ao automático da retro
 * isolada) e o LinkedIn não é colado.
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

import { createHash } from "node:crypto";
import { byRateDescThenTitle, editorialTiebreakScore } from "./weekly-social-click-rank.ts";
import {
  applyPendingPicks,
  computeHeadlineCap,
  dedupeCandidatesByUrl,
  fillSlotsWithNoiseRule,
  toRankedCandidate,
  type WeeklyRankedCandidate,
} from "./weekly-linkedin-select.ts";
import { clickCountsForUrl, normalizeUrl, uniqueOpensOf, type ClickWindowPost } from "./weekly-linkedin-clicks.ts";
import { extractWeeklyCandidates } from "./weekly-linkedin-parse.ts";

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
  /** `editor` = escolha gravada em `picks` (`--pick` ou `--confirm-suggestions`); `suggestion` = ainda só sugestão. */
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
 * do `--picks` do LinkedIn, `applyPendingPicks`). Aceitar a sugestão no gate
 * é gravá-la como `picks` (`--confirm-suggestions` do CLI), então ela é
 * revalidada contra o grupo a cada re-rodada. Sem `picks`, o empate fica
 * `resolution: "suggestion"` e `urls` traz a sugestão para a prévia.
 */
export function selectForProduct(
  ranking: SharedRanking,
  product: SharedProduct,
  slots: number,
  opts: { picks?: string[]; highlightUrls?: Set<string> } = {},
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
  let resolution: PendingTie["resolution"] = "suggestion";
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
  // Empate ainda só SUGERIDO: trocar um item do grupo deixaria a sugestão
  // apontando pra item que saiu sem o editor ter decidido o empate. Resolver
  // antes (`--pick` ou `--confirm-suggestions`). Com o empate já decidido
  // (`resolution: "editor"`), a troca é aplicada e o `pending` do produto em
  // que ela entrou é zerado abaixo: a lista final passou a ser escolha do
  // editor, não mais do empate (o replay reproduz isso: picks e depois swaps).
  const touchesGroup = (pending: PendingTie) => {
    const inGroup = pending.group.map(normalizeUrl);
    return inGroup.includes(outKey) || inGroup.includes(inKey);
  };
  for (const product of SHARED_PRODUCTS) {
    const pending = selections[product].pending;
    if (!pending || pending.resolution !== "suggestion") continue;
    const inGroup = pending.group.map(normalizeUrl);
    if (touchesGroup(pending)) {
      throw new SharedSelectionError(
        `troca inválida: "${inGroup.includes(outKey) ? swap.out : swap.in}" está no empate pendente do ${product} (#5109) — resolva o empate antes com --pick ${product} --urls ..., depois troque.`,
      );
    }
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
    if (sel.pending && touchesGroup(sel.pending)) sel.pending = null; // só chega aqui com resolution "editor"
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
}

export const EMPTY_OVERRIDES: SharedOverrides = { picks: {}, swaps: [] };

export interface SharedSelectionCore {
  ranking: SharedRanking;
  clicked: ProductSelection;
  linkedin: ProductSelection;
  swapLog: { swap: SharedSwap; outcome: SwapOutcome }[];
}

/**
 * Pure: monta a seleção dos dois produtos e reaplica as decisões do editor
 * (escolhas de empate e trocas, nesta ordem). `editionsFound`
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
    highlightUrls,
  });
  const linkedin = selectForProduct(ranking, "linkedin", computeHeadlineCap(input.editionsFound), {
    picks: overrides.picks.linkedin,
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

/** Linha mínima do ranking gravado que o aviso de taxa precisa. */
export interface RankingSnapshotRow {
  url: string;
  ratePct: number;
  eligible: Record<SharedProduct, boolean>;
}

/**
 * Pure (#13022, revisão da PR #13026): diferenças de DADO entre o ranking
 * gravado e o de agora — outro conjunto de edições, item elegível do produto
 * que sumiu ou mudou de taxa. Só AVISO: mudança de taxa fora da seleção é
 * normal (a sexta ainda acumulando clique) e não altera o que vai sair; quem
 * recusa é o replay (`replayDivergence`). `now.ranked` é deduplicado como o
 * arquivo (`dedupeCandidatesByUrl`: 1ª ocorrência, destaque vence seção),
 * senão uma URL repetida entre edições daria diferença permanente.
 * Compara a taxa arredondada a 2 casas, como é gravada.
 */
export function rankingDivergence(
  product: SharedProduct,
  file: { editionsFound: string[]; ranking: RankingSnapshotRow[] },
  now: { editionsFound: string[]; ranked: { url: string; ratePct: number; kind?: string }[] },
): string[] {
  const diffs: string[] = [];
  const a = [...file.editionsFound].sort().join(",");
  const b = [...now.editionsFound].sort().join(",");
  if (a !== b) diffs.push(`edições da janela mudaram (${a || "nenhuma"} → ${b || "nenhuma"})`);
  const byUrl = new Map<string, { ratePct: number; kind?: string }>();
  for (const c of now.ranked) {
    const key = normalizeUrl(c.url);
    const existing = byUrl.get(key);
    if (!existing || (existing.kind === "section" && c.kind === "destaque")) byUrl.set(key, c);
  }
  for (const row of file.ranking) {
    if (!row.eligible?.[product]) continue;
    const hit = byUrl.get(normalizeUrl(row.url));
    if (!hit) {
      diffs.push(`${row.url} não é mais candidato`);
      continue;
    }
    const r = Math.round(hit.ratePct * 100) / 100;
    if (r !== row.ratePct) diffs.push(`${row.url}: taxa ${row.ratePct}% → ${r}%`);
  }
  return diffs;
}

/**
 * Pure (revisão da PR #13026): refaz a seleção com os candidatos de AGORA e as
 * decisões gravadas no arquivo (`overrides`), e compara com a gravada
 * (`sameSelection`, mesma lógica do `--confirm-suggestions`). Devolve o motivo
 * quando a seleção mudou (ou quando uma decisão gravada deixou de valer), ou
 * `null` quando o replay dá a mesma seleção.
 */
export function replayDivergence(
  file: { overrides: SharedOverrides; clicked: ProductSelection; linkedin: ProductSelection },
  now: { candidates: WeeklyRankedCandidate[]; editionsFound: number },
): string | null {
  let replay: SharedSelectionCore;
  try {
    replay = buildSharedSelection({ candidates: now.candidates, editionsFound: now.editionsFound, overrides: file.overrides });
  } catch (e) {
    if (e instanceof SharedSelectionError) return `uma decisão gravada não vale mais: ${e.message}`;
    throw e;
  }
  if (sameSelection(replay, file)) return null;
  const changed = SHARED_PRODUCTS.filter(
    (p) => JSON.stringify(replay[p].urls) !== JSON.stringify(file[p].urls) || JSON.stringify(replay[p].pending) !== JSON.stringify(file[p].pending ?? null),
  ).map((p) => `${p}: gravada [${file[p].urls.join(", ")}], agora [${replay[p].urls.join(", ")}]`);
  return `a seleção recalculada agora não é a gravada (${changed.join("; ")})`;
}

/**
 * Pure: o que um consumidor (`publish-weekly-social.ts`,
 * `select-linkedin-weekly.ts`) precisa saber antes de usar o arquivo.
 *   - `blocking`: o replay mudou a seleção, ou as URLs não batem com o hash
 *     da aprovação — usar o arquivo publicaria o que o editor não viu.
 *   - `warnings`: o dado mudou sem mudar a seleção (`rankingDivergence`).
 *   - `pendingUnresolved`: empate do produto ainda só sugerido.
 * Quem decide se recusa é o consumidor (agendar recusa; prévia avisa).
 */
export function checkSharedFileForProduct(
  product: SharedProduct,
  file: {
    editionsFound: string[];
    ranking: RankingSnapshotRow[];
    overrides: SharedOverrides;
    approved?: { hash: string } | null;
    clicked: ProductSelection;
    linkedin: ProductSelection;
  },
  now: { editionsFound: string[]; candidates: WeeklyRankedCandidate[] },
): { blocking: string[]; warnings: string[]; pendingUnresolved: boolean } {
  const blocking: string[] = [];
  const replay = replayDivergence(file, { candidates: now.candidates, editionsFound: now.editionsFound.length });
  if (replay) blocking.push(replay);
  if (file.approved && file.approved.hash !== selectionHash(file)) {
    blocking.push("as URLs do arquivo não batem com o hash da aprovação do gate (arquivo editado depois de aprovado)");
  }
  const warnings = rankingDivergence(product, file, {
    editionsFound: now.editionsFound,
    ranked: now.candidates.filter((c) => isEligibleFor(product, c)),
  }).map((d) => `dado de clique mudou desde a seleção compartilhada, sem mudar a seleção: ${d}`);
  const pending = file[product].pending;
  return { blocking, warnings, pendingUnresolved: Boolean(pending && pending.resolution !== "editor") };
}

/**
 * Pure: candidatos da semana no formato do ranking compartilhado, a partir do
 * `02-reviewed.md` de cada edição e do post que venceu a data no cache
 * (`matchPostsToWindow`) — o mesmo cálculo do CLI e dos consumidores.
 */
export function buildSharedCandidates<P extends ClickWindowPost>(
  editions: { date: string; md: string }[],
  windowPosts: Map<string, P>,
): WeeklyRankedCandidate[] {
  return editions.flatMap((e) =>
    extractWeeklyCandidates(e.md, e.date).map((c) => {
      const post = windowPosts.get(c.editionDate);
      return toRankedCandidate(c, clickCountsForUrl(c.url, post?.stats?.clicks), uniqueOpensOf(post), windowPosts.has(c.editionDate));
    }),
  );
}

/** Pure: impressão digital da seleção aprovada (URLs dos dois produtos, na ordem). */
export function selectionHash(sel: { clicked: { urls: string[] }; linkedin: { urls: string[] } }): string {
  return createHash("sha256")
    .update(JSON.stringify({ clicked: sel.clicked.urls, linkedin: sel.linkedin.urls }))
    .digest("hex");
}

/** Pure: os recortes recalculados são os mesmos gravados (urls, grupo e sugestão de empate)? */
export function sameSelection(
  a: { clicked: ProductSelection; linkedin: ProductSelection },
  b: { clicked: ProductSelection; linkedin: ProductSelection },
): boolean {
  const key = (p: ProductSelection) =>
    JSON.stringify({ urls: p.urls, suggested: p.pending?.suggested ?? null, group: p.pending?.group ?? null });
  return SHARED_PRODUCTS.every((p) => key(a[p]) === key(b[p]));
}

/** Pure: valida o shape de `overrides` lido do disco. `null` = ok; string = o problema. */
export function validateOverrides(o: unknown): string | null {
  if (!o || typeof o !== "object") return "overrides ausente ou não é objeto";
  const { picks, swaps } = o as { picks?: unknown; swaps?: unknown };
  if (!picks || typeof picks !== "object" || Array.isArray(picks)) return "overrides.picks não é objeto";
  for (const [k, v] of Object.entries(picks)) {
    if (!SHARED_PRODUCTS.includes(k as SharedProduct)) return `overrides.picks.${k} não é produto (clicked/linkedin)`;
    if (!Array.isArray(v) || v.some((u) => typeof u !== "string")) return `overrides.picks.${k} não é lista de URLs`;
  }
  if (!Array.isArray(swaps)) return "overrides.swaps não é lista";
  for (const sw of swaps as unknown[]) {
    const x = sw as { out?: unknown; in?: unknown } | null;
    if (!x || typeof x.out !== "string" || typeof x.in !== "string") return "overrides.swaps tem entrada sem out/in";
  }
  return null;
}
