/**
 * scripts/lib/social-feed-reconcile.ts (#13009, #13008) — miolo PURO da
 * reconciliação pós-disparo dos posts sociais contra o FEED da própria conta.
 *
 * **O problema.** Instagram, Threads e LinkedIn saem pela fila do Worker
 * `diaria-linkedin-cron`, que descarta o id devolvido pelo `media_publish`. O
 * registro da edição (`06-social-published.json`) fica com `url: null` para
 * sempre, e o reconciliador do Worker (`verify-social-worker-dispatch.ts`)
 * só sabe dizer "saiu da fila sem cair na DLQ". Em 261023 isso virou
 * `published` "com alta confiança" no Instagram para um post que nunca
 * apareceu no feed (#13008): sumir da fila não prova disparo.
 *
 * **O que este módulo decide.** Para cada entrada de IG/Threads/LinkedIn ainda
 * sem link (`scheduled`, ou `published` sem `url`), procura no feed da conta
 * o post correspondente e devolve uma de três ações:
 *
 *   - `matched`: achou. Grava `url` (permalink), `published_at` (o horário do
 *     feed, não o da reconciliação) e `status: "published"`.
 *   - `absent`: o horário passou há mais de `graceHours`, o feed lido cobre a
 *     janela e nada nele corresponde. Vira `status: "failed"` com
 *     `failure_reason` começando por `absent_from_feed:` — o check 0l do
 *     Stage 0 (`prev-social-status.ts`) passa a listar o post.
 *   - `none`: sem conclusão (ainda cedo, feed não cobre a janela, leitura
 *     falhou, ou mais de um candidato sem texto para desempatar). Nada muda.
 *
 * **Como casa.** Com o texto do post (`03-social.md`) e o texto do item do
 * feed, casa por sobreposição de tokens (≥ `minTokenOverlap`) dentro de uma
 * janela larga em volta do horário agendado. Sem texto em algum dos lados,
 * casa só pelo horário numa janela curta, e recusa quando há dois candidatos
 * nela (ambíguo): um Reels das 09:00 nunca pode "confirmar" o post das 07:00.
 * Cada item do feed casa com no máximo uma entrada (atribuição gulosa pelo
 * melhor par). No Instagram, item `REELS` só casa com entrada de Reels.
 *
 * Nunca rebaixa um post COM `url` e nunca toca Facebook/Twitter (têm
 * reconciliador próprio, `verify-facebook-posts.ts`/`verify-twitter-posts.ts`).
 */

import { resolveSubtype, type PostEntry } from "./social-published-store.ts";

/** Canais que este reconciliador sabe ler no feed. */
export const FEED_RECONCILABLE_PLATFORMS = ["instagram", "threads", "linkedin"] as const;
export type FeedPlatform = (typeof FEED_RECONCILABLE_PLATFORMS)[number];

export function isFeedPlatform(p: string): p is FeedPlatform {
  return (FEED_RECONCILABLE_PLATFORMS as readonly string[]).includes(p);
}

/** Item normalizado do feed de uma conta. */
export interface FeedItem {
  id: string;
  permalink: string;
  /** ISO 8601. */
  timestamp: string;
  text?: string | null;
  /** Instagram: `FEED` | `REELS` | `STORY` (ausente nos outros canais). */
  productType?: string | null;
}

/** Feed lido de um canal. `coveredSince` = o item mais antigo que a leitura alcançou (ISO). */
export interface FeedRead {
  items: FeedItem[];
  /** Até onde a leitura garantidamente chegou para trás. `null` = nada lido. */
  coveredSince: string | null;
  /** Leitura falhou: o canal inteiro fica `none`, nunca `absent`. */
  error: string | null;
}

export interface FeedReconcileOptions {
  /** Janela curta (só horário): de `scheduled - beforeMin` até `scheduled + tightAfterMin`. */
  beforeMin: number;
  tightAfterMin: number;
  /** Janela larga (com texto confirmando). */
  wideAfterMin: number;
  /** Só declara ausência depois de `scheduled + graceHours`. */
  graceHours: number;
  /** Sobreposição mínima de tokens para o texto confirmar o casamento. */
  minTokenOverlap: number;
}

export const DEFAULT_FEED_RECONCILE_OPTIONS: FeedReconcileOptions = {
  beforeMin: 15,
  // O Worker re-tenta a cada tick do cron até MAX_RETRIES (5): 90 min cobre o
  // atraso de retry sem alcançar o slot seguinte (os slots da edição ficam
  // 2-4h afastados, e o Reels do dia sai em horário próprio).
  tightAfterMin: 90,
  wideAfterMin: 240,
  graceHours: 6,
  minTokenOverlap: 0.35,
};

export type FeedDecision =
  | { action: "matched"; item: FeedItem; by: "text" | "time" }
  | { action: "absent"; reason: string }
  | { action: "none"; reason: string };

/**
 * Entrada que precisa de link: canal do feed, post principal (comentário do
 * LinkedIn não é post do feed), sem `url`, `scheduled` ou `published`.
 */
export function needsFeedReconcile(entry: PostEntry): boolean {
  if (!isFeedPlatform(entry.platform)) return false;
  if (resolveSubtype(entry) !== "main") return false;
  if (typeof entry.url === "string" && entry.url.trim()) return false;
  return entry.status === "scheduled" || entry.status === "published";
}

/** `+0000` → `+00:00` (formato da Graph API) para o `Date.parse`. */
export function parseFeedTime(ts: string | null | undefined): number {
  if (!ts) return NaN;
  return Date.parse(ts.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
}

/** Tokens de conteúdo: minúsculas, sem acento, palavras de 4+ letras/dígitos, sem URL. */
export function contentTokens(text: string | null | undefined): Set<string> {
  if (!text) return new Set();
  const plain = text
    .replace(/https?:\/\/\S+/g, " ")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
  return new Set(plain.match(/[\p{L}\p{N}]{4,}/gu) ?? []);
}

/** |A∩B| / min(|A|,|B|); 0 se algum lado vazio. */
export function tokenOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / Math.min(a.size, b.size);
}

function isReelsEntry(entry: PostEntry): boolean {
  return entry.format === "reels" || entry.media_type === "REELS" || entry.destaque === "reels";
}

interface Candidate {
  entryIdx: number;
  itemIdx: number;
  by: "text" | "time";
  /** Menor é melhor: texto vence horário; dentro do mesmo tipo, maior overlap e menor |delta|. */
  rank: [number, number, number];
}

/**
 * Decide, para todas as entradas de UM canal, o que fazer — atribuição
 * gulosa um-para-um entre entradas e itens do feed.
 *
 * `texts[i]` é o texto da entrada `entries[i]` (ou `null`).
 */
export function decideFeedReconcile(
  entries: PostEntry[],
  texts: Array<string | null>,
  feed: FeedRead,
  now: Date,
  opts: FeedReconcileOptions = DEFAULT_FEED_RECONCILE_OPTIONS,
): FeedDecision[] {
  const decisions: FeedDecision[] = entries.map(() => ({ action: "none", reason: "não avaliada" }));
  if (feed.error) {
    return entries.map(() => ({ action: "none", reason: `leitura do feed falhou: ${feed.error}` }));
  }

  const items = feed.items.map((it) => ({ it, ms: parseFeedTime(it.timestamp), tokens: contentTokens(it.text) }));
  const candidates: Candidate[] = [];
  const ambiguous = new Set<number>();
  const invalidSchedule = new Set<number>();
  const textMismatchInWindow = new Set<number>();

  entries.forEach((entry, ei) => {
    const sched = Date.parse(entry.scheduled_at ?? "");
    if (!Number.isFinite(sched)) {
      invalidSchedule.add(ei);
      decisions[ei] = { action: "none", reason: "scheduled_at ausente ou ilegível" };
      return;
    }
    const entryTokens = contentTokens(texts[ei]);
    const wantReels = isReelsEntry(entry);
    const lo = sched - opts.beforeMin * 60_000;
    const tightHi = sched + opts.tightAfterMin * 60_000;
    const wideHi = sched + opts.wideAfterMin * 60_000;
    const timeOnly: Candidate[] = [];

    items.forEach(({ it, ms, tokens }, ii) => {
      if (!Number.isFinite(ms) || ms < lo || ms > wideHi) return;
      const isReelsItem = (it.productType ?? "").toUpperCase() === "REELS";
      if (entry.platform === "instagram" && isReelsItem !== wantReels) return;
      const delta = Math.abs(ms - sched);
      if (entryTokens.size > 0 && tokens.size > 0) {
        const ov = tokenOverlap(entryTokens, tokens);
        if (ov >= opts.minTokenOverlap) candidates.push({ entryIdx: ei, itemIdx: ii, by: "text", rank: [0, -ov, delta] });
        // Item no horário com texto diferente: pode ser o post com a legenda
        // reescrita depois do disparo. Não casa, mas também não prova ausência.
        else if (ms <= tightHi) textMismatchInWindow.add(ei);
        return;
      }
      if (ms <= tightHi) timeOnly.push({ entryIdx: ei, itemIdx: ii, by: "time", rank: [1, 0, delta] });
    });

    // Sem texto para desempatar, dois itens na janela curta = ambíguo.
    if (timeOnly.length > 1) ambiguous.add(ei);
    else candidates.push(...timeOnly);
  });

  candidates.sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.rank[2] - b.rank[2]);
  const usedEntries = new Set<number>();
  const usedItems = new Set<number>();
  for (const c of candidates) {
    if (usedEntries.has(c.entryIdx) || usedItems.has(c.itemIdx)) continue;
    usedEntries.add(c.entryIdx);
    usedItems.add(c.itemIdx);
    decisions[c.entryIdx] = { action: "matched", item: items[c.itemIdx].it, by: c.by };
  }

  const covered = parseFeedTime(feed.coveredSince);
  entries.forEach((entry, ei) => {
    if (usedEntries.has(ei)) return;
    if (invalidSchedule.has(ei)) return;
    if (ambiguous.has(ei)) {
      decisions[ei] = { action: "none", reason: "mais de um item do feed no horário e sem texto para desempatar" };
      return;
    }
    if (textMismatchInWindow.has(ei)) {
      decisions[ei] = { action: "none", reason: "há post no feed no horário, mas o texto não corresponde: conferir à mão" };
      return;
    }
    const sched = Date.parse(entry.scheduled_at ?? "");
    if (now.getTime() < sched + opts.graceHours * 3_600_000) {
      decisions[ei] = { action: "none", reason: `menos de ${opts.graceHours}h desde o horário agendado` };
      return;
    }
    if (!Number.isFinite(covered) || covered > sched - opts.beforeMin * 60_000) {
      decisions[ei] = { action: "none", reason: "a leitura do feed não alcançou o horário agendado" };
      return;
    }
    decisions[ei] = {
      action: "absent",
      reason:
        `nenhum post do feed entre ${opts.beforeMin} min antes e ${opts.wideAfterMin} min depois de ` +
        `${entry.scheduled_at} corresponde a este registro`,
    };
  });

  return decisions;
}

/** Aplica a decisão à entrada. `null` = sem mudança. */
export function applyFeedDecision(entry: PostEntry, decision: FeedDecision, now: Date): PostEntry | null {
  if (decision.action === "none") return null;
  if (decision.action === "matched") {
    const it = decision.item;
    const ms = parseFeedTime(it.timestamp);
    return {
      ...entry,
      status: "published",
      url: it.permalink,
      published_at: Number.isFinite(ms) ? new Date(ms).toISOString() : entry.published_at,
      platform_post_id: it.id,
      failure_reason: undefined,
      feed_verified_at: now.toISOString(),
      verification_note:
        `confirmed_in_feed: post encontrado no feed da conta (${decision.by === "text" ? "texto e horário" : "só horário"}), ` +
        `reconcile-social-permalinks.ts (#13009).`,
    };
  }
  return {
    ...entry,
    status: "failed",
    previous_status: entry.status,
    failure_reason: `absent_from_feed: ${decision.reason}`,
    feed_verified_at: now.toISOString(),
    verification_note:
      `absent_from_feed: o registro dizia "${entry.status}"` +
      (typeof entry.verification_note === "string" && entry.verification_note
        ? ` (${entry.verification_note.split(":")[0]})`
        : "") +
      `, mas o post não está no feed da conta (#13008). Conferir o perfil antes de republicar.`,
  };
}

export interface FeedReconcileSummary {
  matched: number;
  absent: Array<{ platform: string; destaque: string; scheduled_at: string | null; previous_status: string }>;
  undecided: number;
}

/**
 * Reconcilia a lista inteira de posts de uma edição. `feeds` por canal;
 * canal sem feed lido fica intocado. `textFor` devolve o texto do post (ou `null`).
 */
export function reconcilePostsAgainstFeeds(
  posts: PostEntry[],
  feeds: Partial<Record<FeedPlatform, FeedRead>>,
  textFor: (entry: PostEntry) => string | null,
  now: Date,
  opts: FeedReconcileOptions = DEFAULT_FEED_RECONCILE_OPTIONS,
): { posts: PostEntry[]; summary: FeedReconcileSummary } {
  const out = [...posts];
  const summary: FeedReconcileSummary = { matched: 0, absent: [], undecided: 0 };
  for (const platform of FEED_RECONCILABLE_PLATFORMS) {
    const feed = feeds[platform];
    if (!feed) continue;
    const idxs = posts.map((p, i) => (p.platform === platform && needsFeedReconcile(p) ? i : -1)).filter((i) => i >= 0);
    if (idxs.length === 0) continue;
    const entries = idxs.map((i) => posts[i]);
    const decisions = decideFeedReconcile(entries, entries.map(textFor), feed, now, opts);
    decisions.forEach((d, k) => {
      const updated = applyFeedDecision(entries[k], d, now);
      if (!updated) {
        summary.undecided++;
        return;
      }
      out[idxs[k]] = updated;
      if (d.action === "matched") summary.matched++;
      else
        summary.absent.push({
          platform,
          destaque: entries[k].destaque,
          scheduled_at: entries[k].scheduled_at,
          previous_status: entries[k].status,
        });
    });
  }
  return { posts: out, summary };
}

/** Linha de alarme para o terminal/relatório do Stage 0. `null` quando nada sumiu. */
export function formatAbsentAlarm(summary: FeedReconcileSummary): string | null {
  if (summary.absent.length === 0) return null;
  const parts = summary.absent.map((a) => `${a.platform}/${a.destaque} (${a.scheduled_at ?? "?"}, registro dizia ${a.previous_status})`);
  return `ALARME (#13008): ${summary.absent.length} post(s) agendado(s) não estão no feed da conta: ${parts.join(", ")}.`;
}

/** Mais antigo horário agendado entre as entradas que precisam de link (para o `since` da leitura). */
export function earliestPendingSchedule(posts: PostEntry[], platform: FeedPlatform): string | null {
  let min = Infinity;
  for (const p of posts) {
    if (p.platform !== platform || !needsFeedReconcile(p)) continue;
    const ms = Date.parse(p.scheduled_at ?? "");
    if (Number.isFinite(ms) && ms < min) min = ms;
  }
  return Number.isFinite(min) ? new Date(min).toISOString() : null;
}
