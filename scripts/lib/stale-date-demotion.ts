/**
 * stale-date-demotion.ts (#13341, resíduo da #13313)
 *
 * Destaque com `date_unverified: true` chegava ao gate 4 sem data conhecida:
 * a página não traz data estruturada (JSON-LD, og, `<time>`), o pipeline
 * atribui a data da coleta e o item passa pela janela de data como se fosse
 * de ontem. Caso 261117: D2 da OpenAI com `date: 2026-11-14` e "Update on
 * September 29, 2026" no texto da página. O gate 4 já avisa
 * (`highlight-date-unverified`, `highlight-source-stale-date`); isto antecipa
 * a decisão para o Stage 1, antes do gate 1 e da escrita.
 *
 * Critério (o mesmo do aviso do gate 4, `findSourceStaleDate`): a data de
 * publicação/atualização DECLARADA no texto da página, a mais recente delas.
 * Mais de `STALE_SOURCE_DATE_MAX_DAYS` (30) dias antes da edição → o candidato
 * sai do top-3. Rebaixamento de SELEÇÃO, não de existência: o item segue em
 * `highlights` (rank 4+) e no bucket dele, e o editor pode promovê-lo de volta
 * no gate 1.
 *
 * #13662: o mesmo rebaixamento vale para o top-3 que repete notícia publicada
 * há 31-84 dias (`staleRepeatHits`, critério do `stale-highlight-repeat` do
 * gate 4). Caso 261119: D2 do Fantástico de 16/11 sobre os agentes da OpenAI
 * na Hugging Face, caso de julho coberto em 260928; só o aviso do gate 4
 * acusava, depois da escrita e das imagens.
 *
 * Fora daqui: a busca da 1ª cobertura na imprensa (custo de busca por
 * candidato, a medir antes). Sem data declarada, o item fica como está, com o
 * ⚠️ do `01-categorized.md` e o aviso do gate 4.
 *
 * Puro: quem lê o corpo da página é `scripts/demote-stale-date-highlights.ts`.
 */
import { DESTAQUE_REQUEST_FIELD } from "./destaque-upgrade.ts";
import { hasNegativeImpactTag, type HighlightLike } from "./negative-impact-promotion.ts";
import { findStaleHighlightRepeats, vendorHintsFromUrl, type SourceDateHit } from "./stale-highlight.ts";
import type { PastStoryItem, StoryItem } from "./story-twice-in-edition.ts";

export interface StaleDateHighlight extends HighlightLike {
  rank?: number;
}

/**
 * Repetição de notícia já publicada há 31-84 dias (#13662): o mesmo sinal do
 * `stale-highlight-repeat` do gate 4 (`findStaleHighlightRepeats`), antecipado
 * para o Stage 1.
 */
export interface StaleRepeat {
  kind: "url" | "incident";
  matched_edition: string;
  matched_title: string;
  signal: string;
}

/**
 * Motivo do rebaixamento. Sem `repeat`: data declarada na fonte (`iso` = a
 * data, `text` = o trecho). Com `repeat`: notícia repetida (`iso` = data da
 * edição passada, `text` = o sinal, `days` = distância até ela).
 */
export interface StaleHit extends SourceDateHit {
  repeat?: StaleRepeat;
}

export interface StaleDateDemotion {
  url: string;
  title: string;
  bucket?: string;
  from_rank: number;
  to_rank: number;
  declared_iso: string;
  declared_text: string;
  days: number;
  /** Quem subiu para a vaga (título do novo top-3 que não estava antes). */
  replaced_by?: string;
  /** #13662: presente quando o motivo é notícia repetida, não data da fonte. */
  repeat?: StaleRepeat;
}

export interface StaleDateKept {
  url: string;
  title: string;
  rank: number;
  reason: string;
  declared_iso: string;
  days: number;
  repeat?: StaleRepeat;
}

export interface StaleDateDemotionResult<H extends StaleDateHighlight> {
  highlights: H[];
  demoted: StaleDateDemotion[];
  kept: StaleDateKept[];
}

export function urlOf(h: StaleDateHighlight): string {
  const u = h.url ?? h.article?.url;
  return typeof u === "string" ? u : "";
}

function titleOf(h: StaleDateHighlight): string {
  const t = (h.article as { title?: unknown } | undefined)?.title ?? (h as { title?: unknown }).title;
  return typeof t === "string" ? t : "";
}

function art(h: StaleDateHighlight): Record<string, unknown> {
  return (h.article ?? h) as Record<string, unknown>;
}

/** Ordenados por rank (o rank ausente conta como 0, igual aos outros rebaixamentos). */
function byRank<H extends StaleDateHighlight>(highlights: H[]): H[] {
  return [...highlights].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
}

/**
 * Os candidatos que este passo examina: top-N por rank com
 * `date_unverified: true`. Só esses: quem tem data verificada já passou pela
 * janela de data com a data certa.
 */
export function staleDateCandidates<H extends StaleDateHighlight>(highlights: H[], topN = 3): H[] {
  return byRank(highlights)
    .slice(0, topN)
    .filter((h) => art(h).date_unverified === true && urlOf(h) !== "");
}

/**
 * #13662: top-N que repete notícia publicada há 31-84 dias, pelo mesmo
 * critério do `stale-highlight-repeat` do gate 4 (mesma URL, ou mesmo
 * incidente com >= 2 entidades em comum). Examina todo o top-N, com ou sem
 * data verificada: o caso 261119 tinha data certa (reportagem do Fantástico
 * de 16/11) sobre um caso de julho já coberto em setembro e outubro.
 *
 * O texto do Stage 1 é título + resumo da fonte, mais os fornecedores citados
 * no slug da URL (`vendorHintsFromUrl`). `past` = itens publicados
 * (`readPastStoryItems` com janela por data); itens fora de 31-84 dias são
 * ignorados por `findStaleHighlightRepeats`.
 */
export function staleRepeatHits<H extends StaleDateHighlight>(
  highlights: H[],
  past: PastStoryItem[],
  edition: string,
  topN = 3,
): Map<string, StaleHit> {
  const items: StoryItem[] = byRank(highlights)
    .slice(0, topN)
    .filter((h) => urlOf(h) !== "")
    .map((h, i) => {
      const summary = (art(h).summary as unknown) ?? "";
      const hints = vendorHintsFromUrl(urlOf(h));
      return {
        label: `D${i + 1}`,
        title: titleOf(h),
        url: urlOf(h),
        summary: [typeof summary === "string" ? summary : "", ...hints].filter(Boolean).join("\n"),
      };
    });
  const out = new Map<string, StaleHit>();
  for (const w of findStaleHighlightRepeats(items, past, edition)) {
    const e = w.matched_edition;
    out.set(w.item_url, {
      iso: `20${e.slice(0, 2)}-${e.slice(2, 4)}-${e.slice(4, 6)}`,
      text: w.signal,
      days: w.days,
      repeat: { kind: w.kind, matched_edition: e, matched_title: w.matched_title, signal: w.signal },
    });
  }
  return out;
}

/**
 * Pedido do editor fica onde está: submissão dele (`flag: editor_submitted`,
 * `editor_destaque_request`) ou item que a janela de data já poupou
 * (`date_window_spared`). Mesmo precedente do `filter-date-window.ts` (#4656).
 *
 * `editor_destaque_request` guarda o slot pedido (`"d1"`/`"d2"`/`"d3"`, ou
 * `"destaque"` sem posição; `inject-inbox-urls.ts`, `reserved-destaques.ts`),
 * nunca `true`: conta qualquer string não vazia, como o invariante
 * `editor-destaque-request` do Stage 4 (#13497).
 */
function editorProtected(h: StaleDateHighlight): boolean {
  const a = art(h);
  const request = a[DESTAQUE_REQUEST_FIELD];
  return (
    a.flag === "editor_submitted" ||
    (typeof request === "string" && request.trim() !== "") ||
    a.date_window_spared === true
  );
}

/** Já rebaixado por outro passo (#9100, #10795, #9462): nunca sobe por causa deste. */
function blocked(h: StaleDateHighlight): boolean {
  const present = (v: unknown) => v !== undefined && v !== null;
  return present(h.same_fact_demoted) || present(h.negative_promotion_excluded) || present(h.generic_study_demoted);
}

/**
 * Tira do top-N os destaques cuja data declarada mais recente é velha
 * (`stale`: URL → data, montado pelo caller com `findSourceStaleDate`). Ordem
 * nova: os demais na ordem original, depois os velhos, depois os já
 * rebaixados por outro passo. Ranks renumerados.
 *
 * Invariantes (as mesmas de `demoteGenericStudyHighlights`, #9462):
 *  - #3916: se o top-N tinha destaque de impacto negativo e o novo não tem, o
 *    melhor negativo não-velho sobe para a última vaga; sem um, o velho
 *    negativo fica (só aviso, `kept`).
 *  - Com menos de N candidatos não-velhos, os velhos completam o top-N
 *    (`kept`): a edição nunca fica com menos destaques por causa deste passo.
 *  - Pedido do editor nunca sai (`kept`).
 *  - Só reordena itens que já estão na edição: nenhuma URL entra nem sai, a
 *    contagem por domínio (#5735) não muda.
 *
 * Puro: não muta `highlights`.
 */
export function demoteStaleDateHighlights<H extends StaleDateHighlight>(
  highlights: H[],
  stale: Map<string, StaleHit>,
  topN = 3,
): StaleDateDemotionResult<H> {
  const ordered = byRank(highlights);
  const topBefore = ordered.slice(0, topN);
  const staleOf = (h: H) => stale.get(urlOf(h));
  const protectedKept: StaleDateKept[] = [];
  const isStale = new Set<H>();
  topBefore.forEach((h, i) => {
    const hit = staleOf(h);
    if (!hit) return;
    if (editorProtected(h)) {
      protectedKept.push({
        url: urlOf(h),
        title: titleOf(h),
        rank: i + 1,
        reason: "pedido do editor (submissão ou destaque pedido) — mantido, só aviso",
        declared_iso: hit.iso,
        days: hit.days,
        ...(hit.repeat ? { repeat: hit.repeat } : {}),
      });
      return;
    }
    isStale.add(h);
  });
  if (isStale.size === 0) return { highlights: highlights.slice(), demoted: [], kept: protectedKept };

  const clean = ordered.filter((h) => !isStale.has(h) && !blocked(h));
  const old = ordered.filter((h) => isStale.has(h) && !blocked(h));
  const tail = ordered.filter((h) => blocked(h));
  let next = [...clean, ...old, ...tail];
  const keptNeg = new Set<H>();

  if (topBefore.some(hasNegativeImpactTag) && !next.slice(0, topN).some(hasNegativeImpactTag)) {
    const cleanNeg = clean.find((h, i) => i >= topN && hasNegativeImpactTag(h));
    if (cleanNeg) {
      const rest = next.filter((h) => h !== cleanNeg);
      next = [...rest.slice(0, topN - 1), cleanNeg, ...rest.slice(topN - 1)];
    } else {
      const negOld = topBefore.find((h) => isStale.has(h) && hasNegativeImpactTag(h));
      if (negOld) {
        const rest = next.filter((h) => h !== negOld);
        const at = Math.min(topBefore.indexOf(negOld), topN - 1);
        next = [...rest.slice(0, at), negOld, ...rest.slice(at)];
        keptNeg.add(negOld);
      }
    }
  }

  const newTop = next.slice(0, topN);
  const risers = newTop.filter((h) => !topBefore.includes(h));
  const newHighlights = next.map((h, i) => ({ ...h, rank: i + 1 }));
  const demoted: StaleDateDemotion[] = [];
  const kept: StaleDateKept[] = [...protectedKept];
  let riserIdx = 0;
  next.forEach((h, i) => {
    if (!isStale.has(h)) return;
    const hit = staleOf(h)!;
    const fromIdx = ordered.indexOf(h);
    if (i < topN) {
      kept.push({
        url: urlOf(h),
        title: titleOf(h),
        rank: i + 1,
        reason: keptNeg.has(h)
          ? "único destaque de impacto negativo sem substituto (#3916) — mantido, só aviso"
          : "candidatos com data recente insuficientes para completar o top-3 — mantido, só aviso",
        declared_iso: hit.iso,
        days: hit.days,
        ...(hit.repeat ? { repeat: hit.repeat } : {}),
      });
      return;
    }
    const riser = risers[riserIdx++];
    demoted.push({
      url: urlOf(h),
      title: titleOf(h),
      ...(typeof h.bucket === "string" ? { bucket: h.bucket } : {}),
      from_rank: fromIdx + 1,
      to_rank: i + 1,
      declared_iso: hit.iso,
      declared_text: hit.text,
      days: hit.days,
      ...(riser ? { replaced_by: titleOf(riser) } : {}),
      ...(hit.repeat ? { repeat: hit.repeat } : {}),
    });
    newHighlights[i] = hit.repeat
      ? { ...newHighlights[i], stale_repeat_demoted: { ...hit.repeat, days: hit.days } }
      : { ...newHighlights[i], stale_date_demoted: { declared_iso: hit.iso, days: hit.days } };
  });
  return { highlights: newHighlights as H[], demoted, kept };
}

/** Linha do relatório do Stage 1 para um rebaixamento. */
export function formatStaleDateNote(d: StaleDateDemotion): string {
  const riser = d.replaced_by ? `"${d.replaced_by}"` : "o próximo candidato";
  if (d.repeat) {
    return (
      `⬇️ NOTÍCIA REPETIDA — "${d.title}" rebaixado de D${d.from_rank} (ficou no pool${d.bucket ? `, ${d.bucket}` : ""}): ` +
      `conta de novo ${d.repeat.kind === "url" ? "a URL" : "o incidente"} de ${d.repeat.matched_edition} ` +
      `("${d.repeat.matched_title}", ${d.days} dias atrás; ${d.repeat.signal}); subiu ${riser}. Promova de volta se houver fato novo.`
    );
  }
  return (
    `⬇️ DATA VELHA NA FONTE — "${d.title}" rebaixado de D${d.from_rank} (ficou no pool${d.bucket ? `, ${d.bucket}` : ""}): ` +
    `sem data verificada e a página declara ${d.declared_iso}, ${d.days} dias antes da edição ("${d.declared_text}"); ` +
    `subiu ${riser}. Promova de volta se houver fato novo.`
  );
}

/** Linha do relatório para um velho que ficou no top-3. */
export function formatStaleDateKeptNote(k: StaleDateKept): string {
  if (k.repeat) {
    return `⚠️ NOTÍCIA REPETIDA — "${k.title}" (D${k.rank}) conta de novo o que saiu em ${k.repeat.matched_edition} ("${k.repeat.matched_title}", ${k.days} dias atrás); ${k.reason}.`;
  }
  return `⚠️ DATA VELHA NA FONTE — "${k.title}" (D${k.rank}) declara ${k.declared_iso}, ${k.days} dias antes da edição; ${k.reason}.`;
}
