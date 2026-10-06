/**
 * gate4-highlight-changes.ts (#9693)
 *
 * Funções PURAS que respondem, por edição, "o que o editor mudou nos
 * destaques no gate 4" separando quatro coisas que o sinal `title-choice` do
 * auto-reporter mistura:
 *
 * | Classe | Critério |
 * |---|---|
 * | `item-trocado` | a URL do destaque final não era destaque na saída da pipeline |
 * | `reordenado` | mesma URL, outra posição (D3 → D1) |
 * | `titulo` | mesma URL, título diferente — `outra-opcao` (uma das 3 opções do writer) ou `reescrito` (texto novo) |
 * | `categoria` | mesma URL, rótulo do cabeçalho diferente (`PESQUISA` → `PRODUTO`) |
 * | `mantido` | nada disso |
 *
 * **Casamento sempre por URL, nunca por posição** (decisão do editor na
 * #9693, lição #8412/#9642/#9647). O detector que alimenta o auto-reporter
 * (`derive-editor-requests.ts`) compara `destaque-1` com `destaque-1`: um D3
 * promovido a D1 vira "title-choice" em D1 E em D3 sem que nenhum título
 * tenha mudado. Aqui o par vem de `matchDestaquesByUrl` (#9647), o mesmo
 * casamento usado pela métrica `edition-manual-edits.ts`.
 *
 * Os critérios não são excludentes (um destaque mantido pode ter título E
 * categoria trocados): cada destaque carrega as flags, e `primaryClass`
 * escolhe uma só pra contagem, na precedência item > reordenado > título >
 * categoria > mantido.
 *
 * Seções do pool (RADAR, LANÇAMENTOS, USE MELHOR…) entram em
 * `classifyPoolSection`: item movido de/para outra seção (categoria), item
 * incluído (troca de item), título trocado na mesma URL, corte.
 */

import {
  destaqueUrlKey,
  extractDestaques,
  extractNewsletterItems,
  isCorrectedUrl,
  isPoolSection,
  matchDestaquesByUrl,
  type DestaqueEntry,
  type NewsletterItem,
} from "./manual-edit-diff.ts";

// ---------------------------------------------------------------------------
// Categoria do cabeçalho
// ---------------------------------------------------------------------------

/** Rótulo do cabeçalho `**DESTAQUE N | 🔬 PESQUISA**` → `PESQUISA`, por posição. */
export function extractDestaqueCategories(md: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const raw of md.replace(/\r\n/g, "\n").split("\n")) {
    const bold = raw.trim().match(/^\*\*(.+)\*\*$/);
    if (!bold) continue;
    const m = bold[1].match(/DESTAQUE\s+(\d+)\s*\|\s*(.+)$/);
    if (!m) continue;
    const label = m[2].replace(/^[^\p{L}\p{N}]+/u, "").trim().toUpperCase();
    if (!out.has(Number(m[1]))) out.set(Number(m[1]), label);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Destaques
// ---------------------------------------------------------------------------

export type TitleChange = "outra-opcao" | "reescrito";

export type SwapOrigin =
  /** URL estava no pool da saída da pipeline (promovido de RADAR etc.). */
  | { kind: "pool"; section: string }
  /** Mesmo título de um destaque da pipeline que saiu — mesma pauta, outra fonte. */
  | { kind: "mesma-pauta"; from_position: number; from_url: string }
  /** Fora da newsletter entregue, mas entre os candidatos pontuados da pipeline (Stage 1). */
  | { kind: "candidato-pontuado" }
  /** URL que não estava em lugar nenhum da saída da pipeline. */
  | { kind: "fora-da-saida" };

export interface HighlightRecord {
  position: number;
  url: string;
  title: string;
  category: string | null;
  /** Destaque da pipeline casado por URL; `null` quando o item foi trocado. */
  pipeline: { position: number; url: string; title: string; category: string | null } | null;
  item_swapped: boolean;
  origin: SwapOrigin | null;
  reordered: boolean;
  title_change: TitleChange | null;
  category_change: { from: string | null; to: string | null } | null;
}

export type HighlightClass = "item-trocado" | "reordenado" | "titulo" | "categoria" | "mantido";

export function primaryClass(r: HighlightRecord): HighlightClass {
  if (r.item_swapped) return "item-trocado";
  if (r.reordered) return "reordenado";
  if (r.title_change) return "titulo";
  if (r.category_change) return "categoria";
  return "mantido";
}

/** Destino de um destaque da pipeline que saiu dos destaques. */
export interface DroppedHighlight {
  position: number;
  url: string;
  title: string;
  /** `rebaixado` = foi pro pool (seção indicada); `mesma-pauta` = substituído pela mesma pauta com outra URL. */
  fate: { kind: "rebaixado"; section: string } | { kind: "mesma-pauta"; to_position: number } | { kind: "cortado" };
}

export interface TitlePickLike {
  chosen: string;
  alternatives?: readonly string[];
}

export interface HighlightComparison {
  highlights: HighlightRecord[];
  dropped: DroppedHighlight[];
}

const normTitle = (t: string): string => t.replace(/\s+/g, " ").trim().toLowerCase();

const sameUrl = (a: string, b: string): boolean => destaqueUrlKey(a) === destaqueUrlKey(b) || isCorrectedUrl(a, b);

/**
 * Opções de título que a pipeline gerou pra um destaque: as linhas de título
 * do próprio baseline, as do texto do writer com as 3 opções (`optionSources`,
 * casado por URL) e o `chosen` + `alternatives` do `title-picker` cujo
 * conjunto contém o título do baseline. Pura.
 */
export function pipelineTitleOptions(
  entry: DestaqueEntry,
  optionSources: readonly DestaqueEntry[],
  picks: readonly TitlePickLike[],
): Set<string> {
  const out = new Set<string>(entry.titleOptions.map(normTitle));
  for (const o of optionSources) {
    if (sameUrl(o.url, entry.url)) for (const t of o.titleOptions) out.add(normTitle(t));
  }
  for (const p of picks) {
    const all = [p.chosen, ...(p.alternatives ?? [])].map(normTitle);
    if (all.some((t) => out.has(t))) for (const t of all) out.add(t);
  }
  return out;
}

/**
 * Compara os destaques entregues ao gate 4 (`baselineMd`) com os aprovados
 * (`finalMd`), por URL. `optionSources`/`picks` dão as 3 opções de título
 * (sem elas, todo título diferente vira `reescrito`). Pura.
 */
export function compareHighlights(
  baselineMd: string,
  finalMd: string,
  optionSources: readonly DestaqueEntry[] = [],
  picks: readonly TitlePickLike[] = [],
  /** URLs dos candidatos pontuados no Stage 1 (`01-categorized.json`, `tmp-allscored.json`). */
  candidateUrls: readonly string[] = [],
): HighlightComparison {
  const pipeline = extractDestaques(baselineMd);
  const final = extractDestaques(finalMd);
  const pipeCats = extractDestaqueCategories(baselineMd);
  const finalCats = extractDestaqueCategories(finalMd);
  const match = matchDestaquesByUrl(pipeline, final);
  const basePool = extractNewsletterItems(baselineMd).filter((it) => isPoolSection(it.section));
  const finalPool = extractNewsletterItems(finalMd).filter((it) => isPoolSection(it.section));
  const keptPipeline = new Set([...match.pipelineEntryOf.values()]);
  const droppedPipeline = pipeline.filter((p) => !keptPipeline.has(p));
  const samePautaUsed = new Map<DestaqueEntry, number>();

  const highlights: HighlightRecord[] = [...final]
    .sort((a, b) => a.position - b.position)
    .map((d) => {
      const category = finalCats.get(d.position) ?? null;
      const p = match.pipelineEntryOf.get(d.position);
      if (!p) {
        let origin: SwapOrigin;
        const pool = basePool.find((it) => sameUrl(it.url, d.url));
        const twin = droppedPipeline.find(
          (x) => !samePautaUsed.has(x) && pipelineTitleOptions(x, optionSources, picks).has(normTitle(d.title)),
        );
        if (pool) origin = { kind: "pool", section: pool.section };
        else if (twin) {
          samePautaUsed.set(twin, d.position);
          origin = { kind: "mesma-pauta", from_position: twin.position, from_url: twin.url };
        } else if (candidateUrls.some((u) => sameUrl(u, d.url))) origin = { kind: "candidato-pontuado" };
        else origin = { kind: "fora-da-saida" };
        return {
          position: d.position,
          url: d.url,
          title: d.title,
          category,
          pipeline: null,
          item_swapped: true,
          origin,
          reordered: false,
          title_change: null,
          category_change: null,
        };
      }
      const pipeCategory = pipeCats.get(p.position) ?? null;
      let title_change: TitleChange | null = null;
      if (normTitle(p.title) !== normTitle(d.title)) {
        title_change = pipelineTitleOptions(p, optionSources, picks).has(normTitle(d.title)) ? "outra-opcao" : "reescrito";
      }
      return {
        position: d.position,
        url: d.url,
        title: d.title,
        category,
        pipeline: { position: p.position, url: p.url, title: p.title, category: pipeCategory },
        item_swapped: false,
        origin: null,
        reordered: p.position !== d.position,
        title_change,
        category_change: pipeCategory !== category ? { from: pipeCategory, to: category } : null,
      };
    });

  const dropped: DroppedHighlight[] = droppedPipeline.map((p) => {
    const twinOf = samePautaUsed.get(p);
    if (twinOf !== undefined) return { position: p.position, url: p.url, title: p.title, fate: { kind: "mesma-pauta", to_position: twinOf } };
    const pool = finalPool.find((it) => sameUrl(it.url, p.url));
    if (pool) return { position: p.position, url: p.url, title: p.title, fate: { kind: "rebaixado", section: pool.section } };
    return { position: p.position, url: p.url, title: p.title, fate: { kind: "cortado" } };
  });

  return { highlights, dropped };
}

// ---------------------------------------------------------------------------
// Seções do pool
// ---------------------------------------------------------------------------

export interface PoolSectionChanges {
  section: string;
  /** Item que estava em OUTRA seção (ou era destaque) na saída da pipeline. */
  moved_in: Array<{ url: string; title: string; from: string }>;
  /** Item da seção que foi pra outra seção (ou virou destaque). */
  moved_out: Array<{ url: string; title: string; to: string }>;
  /** Item que não estava em lugar nenhum da saída da pipeline. */
  included: Array<{ url: string; title: string }>;
  /** Item da seção que sumiu da edição. */
  cut: Array<{ url: string; title: string }>;
  /** Mesma URL, mesma seção, título diferente. */
  retitled: Array<{ url: string; from: string; to: string }>;
}

export type PoolClass = "item-trocado" | "categoria" | "titulo" | "corte" | "mantido";

export function primaryPoolClass(c: PoolSectionChanges): PoolClass {
  if (c.included.length > 0) return "item-trocado";
  if (c.moved_in.length > 0 || c.moved_out.length > 0) return "categoria";
  if (c.retitled.length > 0) return "titulo";
  if (c.cut.length > 0) return "corte";
  return "mantido";
}

/** Slug da seção pro alvo do `editor-requests.jsonl` (`LANÇAMENTOS` → `lancamentos`, `USE MELHOR` → `use-melhor`). */
export function sectionSlug(section: string): string {
  return section
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-");
}

/** Mudanças de UMA seção do pool, casando itens por URL. `section` = nome (`sectionHeaderName`). Pura. */
export function classifyPoolSection(baselineMd: string, finalMd: string, section: string): PoolSectionChanges {
  const base = extractNewsletterItems(baselineMd);
  const fin = extractNewsletterItems(finalMd);
  const find = (list: NewsletterItem[], url: string) => list.find((it) => sameUrl(it.url, url));
  const out: PoolSectionChanges = { section, moved_in: [], moved_out: [], included: [], cut: [], retitled: [] };
  for (const it of fin.filter((x) => x.section === section)) {
    const before = find(base, it.url);
    if (!before) out.included.push({ url: it.url, title: it.title });
    else if (before.section !== section) out.moved_in.push({ url: it.url, title: it.title, from: before.section });
    else if (normTitle(before.title) !== normTitle(it.title)) out.retitled.push({ url: it.url, from: before.title, to: it.title });
  }
  for (const it of base.filter((x) => x.section === section)) {
    const after = find(fin, it.url);
    if (!after) out.cut.push({ url: it.url, title: it.title });
    else if (after.section !== section) out.moved_out.push({ url: it.url, title: it.title, to: after.section });
  }
  return out;
}

/**
 * Nome da seção (do baseline ou do final) cujo slug é `slug`, ou `null`.
 * Singular/plural indiferente: o detector grava `lancamentos` mesmo quando o
 * cabeçalho da edição é `LANÇAMENTO` (261002).
 */
export function findSectionBySlug(baselineMd: string, finalMd: string, slug: string): string | null {
  const stem = (s: string) => s.replace(/s$/, "");
  const names = new Set([...extractNewsletterItems(baselineMd), ...extractNewsletterItems(finalMd)].map((it) => it.section));
  for (const n of names) if (isPoolSection(n) && stem(sectionSlug(n)) === stem(slug)) return n;
  return null;
}

// ---------------------------------------------------------------------------
// Reconciliação com o sinal do auto-reporter
// ---------------------------------------------------------------------------

export interface ReporterEvent {
  edition: string;
  /** Alvo do `editor-requests.jsonl`: `d1`..`d3` ou slug da seção. */
  target: string;
}

export type EventClass = HighlightClass | PoolClass | "destaque-ausente" | "secao-ausente";

export interface ReconciledEvent extends ReporterEvent {
  class: EventClass;
  /** Todas as dimensões que mudaram (não só a primária). */
  dimensions: Array<"item" | "posicao" | "titulo" | "categoria" | "corte">;
  detail: string;
}

/** Reclassifica UM evento `title-choice` (casado por posição) pela comparação por URL. Pura. */
export function reconcileEvent(
  ev: ReporterEvent,
  cmp: HighlightComparison,
  baselineMd: string,
  finalMd: string,
): ReconciledEvent {
  const dm = ev.target.match(/^d(\d+)$/);
  if (dm) {
    const r = cmp.highlights.find((h) => h.position === Number(dm[1]));
    if (!r) return { ...ev, class: "destaque-ausente", dimensions: [], detail: `sem D${dm[1]} no aprovado` };
    const dims: ReconciledEvent["dimensions"] = [];
    if (r.item_swapped) dims.push("item");
    if (r.reordered) dims.push("posicao");
    if (r.title_change) dims.push("titulo");
    if (r.category_change) dims.push("categoria");
    return { ...ev, class: primaryClass(r), dimensions: dims, detail: describeHighlight(r) };
  }
  const section = findSectionBySlug(baselineMd, finalMd, ev.target);
  if (!section) return { ...ev, class: "secao-ausente", dimensions: [], detail: `seção "${ev.target}" não encontrada` };
  const c = classifyPoolSection(baselineMd, finalMd, section);
  const dims: ReconciledEvent["dimensions"] = [];
  if (c.included.length) dims.push("item");
  if (c.moved_in.length || c.moved_out.length) dims.push("categoria");
  if (c.retitled.length) dims.push("titulo");
  if (c.cut.length) dims.push("corte");
  return { ...ev, class: primaryPoolClass(c), dimensions: dims, detail: describePool(c) };
}

export function describeHighlight(r: HighlightRecord): string {
  if (r.item_swapped) {
    const o = r.origin!;
    const from =
      o.kind === "pool"
        ? `promovido de ${o.section}`
        : o.kind === "mesma-pauta"
          ? `mesma pauta do D${o.from_position}, outra URL`
          : o.kind === "candidato-pontuado"
            ? "fora da newsletter entregue, mas entre os candidatos pontuados do Stage 1"
            : "URL fora da saída da pipeline";
    return `D${r.position} "${r.title}" — item trocado (${from})`;
  }
  const parts: string[] = [];
  if (r.reordered) parts.push(`era D${r.pipeline!.position}`);
  if (r.title_change) parts.push(`título ${r.title_change === "outra-opcao" ? "trocado por outra das 3 opções" : "reescrito"}: "${r.pipeline!.title}" → "${r.title}"`);
  if (r.category_change) parts.push(`categoria ${r.category_change.from ?? "?"} → ${r.category_change.to ?? "?"}`);
  return `D${r.position} "${r.title}" — ${parts.length ? parts.join("; ") : "mantido"}`;
}

export function describePool(c: PoolSectionChanges): string {
  const parts: string[] = [];
  if (c.included.length) parts.push(`${c.included.length} incluído(s)`);
  if (c.moved_in.length) parts.push(`${c.moved_in.length} entrou(aram) de ${[...new Set(c.moved_in.map((m) => m.from))].join("/")}`);
  if (c.moved_out.length) parts.push(`${c.moved_out.length} saiu(íram) para ${[...new Set(c.moved_out.map((m) => m.to))].join("/")}`);
  if (c.retitled.length) parts.push(`${c.retitled.length} título(s) trocado(s)`);
  if (c.cut.length) parts.push(`${c.cut.length} cortado(s)`);
  return `${c.section}: ${parts.length ? parts.join(", ") : "sem mudança"}`;
}
