/**
 * destaque-upgrade.ts (#12193) — "upgrade" de URL repetida a destaque.
 *
 * Regra do editor (04/11/2026): URL já publicada em seção NÃO-destaque
 * (RADAR, USE MELHOR, LANÇAMENTOS...) dentro da janela de dedup pode voltar
 * como DESTAQUE. URL que já foi destaque continua bloqueada, e a URL repetida
 * nunca volta para uma seção normal: ou vira destaque, ou sai.
 *
 * Camadas (todas usam o campo `DESTAQUE_ONLY_FIELD` no artigo, ou o mesmo
 * conjunto de URLs elegíveis):
 *   1. `dedup.ts` Pass 1 mantém a URL elegível marcada com o campo, em vez de
 *      removê-la (elegibilidade: `extractDestaqueUpgradeEligibleUrls`).
 *   2. `finalize-stage1.ts` (#1068 phase 2) já tira dos buckets toda URL
 *      past-secondary que o scorer não escolheu como highlight.
 *   3. `apply-gate-edits.ts` tira dos buckets do `01-approved.json` o item
 *      marcado que não ficou entre os destaques aprovados
 *      (`dropDestaqueOnlyFromBuckets`).
 *   4. Gate 4: `no-duplicate-urls-vs-past-editions` não acusa o destaque
 *      promovido; `editor-destaque-request` avisa quando um link que o editor
 *      pediu como destaque ficou de fora (`findEditorDestaqueRequestIssues`).
 *
 * Módulo puro (só `url-utils`), importado por `past-editions-extract.ts`.
 */

import { canonicalize } from "./url-utils.ts";

/** Campo gravado pelo dedup no artigo promovível: a nota com a origem. */
export const DESTAQUE_ONLY_FIELD = "dedup_destaque_only";

/** Campo gravado por `inject-inbox-urls.ts` quando o editor pede destaque. */
export const DESTAQUE_REQUEST_FIELD = "editor_destaque_request";

/**
 * Pure: URLs elegíveis à promoção. `urlDates` = URL canônica → datas
 * (YYYY-MM-DD) em que saiu; `destaquesFor(date)` = destaques canônicos da
 * edição daquela data, ou `undefined` quando não dá para saber (sem pasta
 * local, sem destaques legíveis). Elegível só quando TODAS as datas têm
 * destaques conhecidos e a URL não está em nenhum deles.
 */
export function computeDestaqueUpgradeEligible(
  urlDates: Map<string, string[]>,
  destaquesFor: (isoDate: string) => Set<string> | undefined,
): Set<string> {
  const eligible = new Set<string>();
  for (const [url, dates] of urlDates) {
    if (dates.length === 0) continue;
    let ok = true;
    for (const date of dates) {
      const destaques = destaquesFor(date);
      if (!destaques || destaques.has(url)) {
        ok = false;
        break;
      }
    }
    if (ok) eligible.add(url);
  }
  return eligible;
}

/**
 * Pure: o texto do e-mail do editor (assunto + corpo) pede destaque?
 * Devolve o slot pedido (`"d1"`, `"d2"`, `"d3"`) ou `"destaque"` quando o
 * pedido não cita posição; `null` sem pedido. URLs são removidas antes do
 * teste (um path `/d1/` não é pedido).
 */
export function detectDestaqueRequest(text: string): string | null {
  if (!text) return null;
  const clean = text.replace(/https?:\/\/\S+/gi, " ").toLowerCase();
  const slot = clean.match(/\bd([123])\b/);
  if (slot) return `d${slot[1]}`;
  if (/\bdestaques?\b/.test(clean)) return "destaque";
  return null;
}

type Bucketed = { url: string; [key: string]: unknown };

/**
 * Pure: remove dos buckets de pool o artigo marcado com `DESTAQUE_ONLY_FIELD`
 * cuja URL não está em `highlightUrls`. Muta `buckets` e devolve o que saiu.
 */
export function dropDestaqueOnlyFromBuckets(
  buckets: Record<string, Bucketed[] | undefined>,
  highlightUrls: Iterable<string>,
): Array<{ url: string; bucket: string; note: string }> {
  const keep = new Set<string>();
  for (const u of highlightUrls) keep.add(canonicalize(u));
  const dropped: Array<{ url: string; bucket: string; note: string }> = [];
  for (const [bucket, items] of Object.entries(buckets)) {
    if (!Array.isArray(items)) continue;
    const kept: Bucketed[] = [];
    for (const item of items) {
      const note = item?.[DESTAQUE_ONLY_FIELD];
      if (typeof note === "string" && note && !keep.has(canonicalize(item.url))) {
        dropped.push({ url: item.url, bucket, note });
        continue;
      }
      kept.push(item);
    }
    buckets[bucket] = kept;
  }
  return dropped;
}

export interface DestaqueRequest {
  url: string;
  /** `"d1"`/`"d2"`/`"d3"` ou `"destaque"`. */
  request: string;
  title?: string;
}

export interface FunnelItemLite {
  url: string;
  outcome?: string;
  exit_stage?: string | null;
  reason?: string | null;
}

export interface DestaqueRequestIssue {
  url: string;
  request: string;
  title?: string;
  /** Posição em que saiu (1-based) quando virou destaque em outra posição. */
  position?: number;
  reason: string;
}

/**
 * Pure: compara os pedidos de destaque do editor com os destaques aprovados.
 * Pedido atendido (destaque na posição pedida, ou em qualquer posição quando
 * o pedido não cita uma) não gera nada. Os demais saem com o motivo: posição
 * diferente, seção do pool em que ficou, ou o motivo do funil do Stage 1.
 */
export function findEditorDestaqueRequestIssues(
  requests: DestaqueRequest[],
  highlightUrls: string[],
  funnelItems: FunnelItemLite[],
  approvedBuckets: Record<string, Array<{ url: string }> | undefined>,
): DestaqueRequestIssue[] {
  const highlightCanon = highlightUrls.map((u) => canonicalize(u));
  const funnelByUrl = new Map<string, FunnelItemLite>();
  for (const item of funnelItems) {
    if (item && typeof item.url === "string") funnelByUrl.set(canonicalize(item.url), item);
  }
  const issues: DestaqueRequestIssue[] = [];
  const seen = new Set<string>();
  for (const req of requests) {
    const canon = canonicalize(req.url);
    if (seen.has(canon)) continue;
    seen.add(canon);
    const pos = highlightCanon.indexOf(canon);
    if (pos >= 0) {
      const wanted = /^d([123])$/.exec(req.request);
      if (!wanted || Number(wanted[1]) === pos + 1) continue;
      issues.push({
        ...req,
        position: pos + 1,
        reason: `pedido como ${req.request.toUpperCase()}, saiu como D${pos + 1}`,
      });
      continue;
    }
    let bucketHit: string | undefined;
    for (const [bucket, items] of Object.entries(approvedBuckets)) {
      if (Array.isArray(items) && items.some((a) => a && typeof a.url === "string" && canonicalize(a.url) === canon)) {
        bucketHit = bucket;
        break;
      }
    }
    if (bucketHit) {
      issues.push({ ...req, reason: `ficou no pool (seção ${bucketHit}), não entre os destaques` });
      continue;
    }
    const funnel = funnelByUrl.get(canon);
    if (funnel && funnel.outcome !== "approved" && (funnel.reason || funnel.exit_stage)) {
      const where = funnel.exit_stage ? `barrado em ${funnel.exit_stage}` : "barrado";
      issues.push({ ...req, reason: `${where}: ${funnel.reason ?? "(sem motivo registrado)"}` });
      continue;
    }
    issues.push({ ...req, reason: "fora da edição; motivo não registrado no funil do Stage 1 (stage1-funnel.json)" });
  }
  return issues;
}
