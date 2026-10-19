/**
 * scripts/lib/kit-engagement-cache.ts (#10514)
 *
 * Cache do engajamento (entregues/aberturas/cliques) dos broadcasts da diária
 * que o Passo 3c (`scripts/sync-kit-sem-abertura-to-brevo.ts`) relê do Kit.
 * Sem ele, cada rodada faz 3 leituras paginadas de `/v4/subscribers/filter`
 * por broadcast do registro inteiro, e o registro cresce uma edição por dia.
 *
 * ## Por que cache e não janela dos últimos N broadcasts
 *
 * Uma janela muda o critério: quem abriu um broadcast fora da janela e nenhum
 * dentro dela passaria a ser movido (hoje é excluído como `abriu`). O cache
 * preserva a seleção exatamente, desde que o engajamento de um broadcast não
 * mude depois de `KIT_ENGAGEMENT_FREEZE_DAYS` dias do envio.
 *
 * ## Como funciona
 *
 * - O cache guarda UM agregado por e-mail (`[envios maduros, aberturas,
 *   cliques]`) sobre um conjunto de broadcasts "congelados" (`frozen_ids`).
 *   Agregado e não listas por broadcast: o tamanho fica limitado pelo nº de
 *   e-mails distintos, não pelo histórico.
 * - Um broadcast só congela se foi LIDO com o envio a >= 7 dias (o dado
 *   gravado já é o de depois da maturação). Os mais novos são relidos toda
 *   rodada. Requests por rodada ≈ broadcasts dos últimos 7 dias (+ os que
 *   acabaram de cruzar os 7 dias), nunca o histórico inteiro.
 * - `buildEngagementIndex` é aditivo por broadcast (cada broadcast conta no
 *   máximo 1 por eixo por pessoa), então agregado congelado + índice dos
 *   relidos = índice do registro inteiro.
 *
 * ## Fail-soft
 *
 * Cache ausente, ilegível, de outra versão, ou com um id congelado que não
 * está mais entre os enviados do registro ⇒ descartado inteiro (não dá pra
 * subtrair um broadcast do agregado) e a rodada relê tudo, como antes do
 * cache. Falha de escrita só gera aviso.
 *
 * ## Risco aceito
 *
 * Abertura ou clique que chegue depois de 7 dias do envio num broadcast já
 * congelado não é visto. Quem lê de verdade abre outros broadcasts recentes,
 * que são relidos ao vivo; e a mudança é reversível (o movido segue
 * recebendo a edição pela Brevo).
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeEmail } from "./brevo-diaria-store.ts";
import { BREVO_DIARIA_MATURATION_HOURS } from "./shared/brevo-diaria-score.ts";
import { buildEngagementIndex, type BroadcastEngagement, type DiariaBroadcastRecord, type SubscriberEngagement } from "./kit-sem-abertura.ts";

/** Idade mínima (desde o envio) pra o engajamento de um broadcast ser congelado. */
export const KIT_ENGAGEMENT_FREEZE_DAYS = 7;

export const KIT_ENGAGEMENT_CACHE_VERSION = 1;

/** Em `data/` (gitignored, sincronizado), ao lado do store da Brevo diária. */
export const DEFAULT_KIT_ENGAGEMENT_CACHE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
  "data/brevo-diaria/kit-engagement-cache.json",
);

export interface KitEngagementCache {
  version: typeof KIT_ENGAGEMENT_CACHE_VERSION;
  /** Broadcasts cujo engajamento está somado em `subscribers`. */
  frozen_ids: number[];
  /** e-mail normalizado → `[envios maduros, aberturas, cliques]`. */
  subscribers: Record<string, [number, number, number]>;
}

const isCount = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;

/** Pura — valida o JSON lido do disco. Qualquer desvio ⇒ `null` (cache descartado). */
export function parseKitEngagementCache(raw: unknown): KitEngagementCache | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as { version?: unknown; frozen_ids?: unknown; subscribers?: unknown };
  if (c.version !== KIT_ENGAGEMENT_CACHE_VERSION) return null;
  if (!Array.isArray(c.frozen_ids) || !c.frozen_ids.every((id) => Number.isInteger(id) && (id as number) > 0)) return null;
  if (new Set(c.frozen_ids).size !== c.frozen_ids.length) return null;
  if (!c.subscribers || typeof c.subscribers !== "object" || Array.isArray(c.subscribers)) return null;
  for (const v of Object.values(c.subscribers as Record<string, unknown>)) {
    if (!Array.isArray(v) || v.length !== 3 || !v.every(isCount)) return null;
  }
  return c as KitEngagementCache;
}

export interface KitEngagementFetchPlan {
  /** Ids a reler do Kit nesta rodada, na ordem de `sentIds`. */
  toFetch: number[];
  /** Agregado do cache aproveitado (vazio se não há cache válido). */
  cachedIndex: Map<string, SubscriberEngagement>;
  /** Cache aproveitado (`null` = sem cache ou descartado). */
  cache: KitEngagementCache | null;
  /** Ids que, relidos agora, podem entrar no cache. */
  freezable: Set<number>;
  /** Por que o cache foi descartado, quando foi. */
  discarded?: string;
}

/**
 * Pura — decide o que reler. `cacheRaw` é o JSON cru (ou `null` se ausente);
 * `sentIds`/`records` vêm de `classifyDiariaBroadcasts` e do registro.
 */
export function planKitEngagementFetch(params: {
  records: readonly DiariaBroadcastRecord[];
  sentIds: readonly number[];
  nowMs: number;
  cacheRaw: unknown;
}): KitEngagementFetchPlan {
  const freezeMs = Math.max(KIT_ENGAGEMENT_FREEZE_DAYS * 24, BREVO_DIARIA_MATURATION_HOURS) * 60 * 60 * 1000;
  const sentAt = new Map(params.records.map((r) => [r.broadcastId, Date.parse(r.sentAt)]));
  const freezable = new Set(params.sentIds.filter((id) => params.nowMs - (sentAt.get(id) ?? Infinity) >= freezeMs));

  let cache: KitEngagementCache | null = null;
  let discarded: string | undefined;
  if (params.cacheRaw !== null && params.cacheRaw !== undefined) {
    cache = parseKitEngagementCache(params.cacheRaw);
    if (!cache) discarded = "formato inválido";
    else {
      // Congelado precisa seguir enviado E com >= 7 dias: um id que saiu do
      // registro (ou relógio que voltou) não pode ser subtraído do agregado.
      const stray = cache.frozen_ids.find((id) => !freezable.has(id));
      if (stray !== undefined) {
        discarded = `broadcast ${stray} congelado não está entre os enviados há >= ${KIT_ENGAGEMENT_FREEZE_DAYS} dias`;
        cache = null;
      }
    }
  }
  const cachedIndex = new Map<string, SubscriberEngagement>();
  if (cache) {
    for (const [email, [matureSends, opens, clicks]] of Object.entries(cache.subscribers)) {
      cachedIndex.set(email, { matureSends, opens, clicks });
    }
  }
  const frozen = new Set(cache?.frozen_ids ?? []);
  return { toFetch: params.sentIds.filter((id) => !frozen.has(id)), cachedIndex, cache, freezable, discarded };
}

/** Pura — soma dois índices por e-mail (não muta nenhum dos dois). */
export function mergeEngagementIndexes(
  a: ReadonlyMap<string, SubscriberEngagement>,
  b: ReadonlyMap<string, SubscriberEngagement>,
): Map<string, SubscriberEngagement> {
  const out = new Map<string, SubscriberEngagement>();
  for (const m of [a, b]) {
    for (const [email, e] of m) {
      const cur = out.get(email) ?? { matureSends: 0, opens: 0, clicks: 0 };
      out.set(email, { matureSends: cur.matureSends + e.matureSends, opens: cur.opens + e.opens, clicks: cur.clicks + e.clicks });
    }
  }
  return out;
}

/**
 * Pura — cache novo = cache aproveitado + os relidos que já podem congelar.
 * `null` quando nenhum relido congela (nada a gravar; um arquivo inválido
 * no disco segue descartado até o 1º congelamento o substituir).
 */
export function extendKitEngagementCache(
  plan: Pick<KitEngagementFetchPlan, "cache" | "cachedIndex" | "freezable">,
  fetched: readonly BroadcastEngagement[],
): KitEngagementCache | null {
  const toFreeze = fetched.filter((b) => plan.freezable.has(b.broadcastId));
  if (toFreeze.length === 0) return null;
  // Congelado tem >= 7 dias, logo é maduro: entregues contam como envio maduro.
  const added = buildEngagementIndex(toFreeze, new Set(toFreeze.map((b) => b.broadcastId)));
  const merged = mergeEngagementIndexes(plan.cachedIndex, added);
  const subscribers: Record<string, [number, number, number]> = {};
  for (const [email, e] of [...merged].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) {
    subscribers[normalizeEmail(email)] = [e.matureSends, e.opens, e.clicks];
  }
  const frozen_ids = [...new Set([...(plan.cache?.frozen_ids ?? []), ...toFreeze.map((b) => b.broadcastId)])].sort((x, y) => x - y);
  return { version: KIT_ENGAGEMENT_CACHE_VERSION, frozen_ids, subscribers };
}
