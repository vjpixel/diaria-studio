/**
 * scripts/lib/kit-frio-engagement-cache.ts (#11294 item 1)
 *
 * Cache POR BROADCAST do engajamento (entregues/aberturas/cliques) que o
 * `scripts/sync-kit-frio.ts` relê do Kit a cada Etapa 5. Sem ele, cada rodada
 * faz 3 leituras paginadas de `/v4/subscribers/filter` por diária dos últimos
 * ~92 dias (mais as semanais de frio), espaçadas pelo pacer de 750ms: minutos
 * por rodada.
 *
 * ## Por que não reusa `kit-engagement-cache.ts` (#10514)
 *
 * Aquele cache guarda UM agregado por e-mail (contagens), suficiente pro
 * Passo 3c. O frio precisa das listas por broadcast com a data de envio:
 * último sinal por pessoa (`buildLastSignalIndex`), entregas por pessoa
 * (`buildDeliveryIndex`), sequência de semanais sem sinal
 * (`buildSemanalFrioSilentStreaks`) e taxa de abertura no Gmail por broadcast
 * (vigia). Por isso aqui o cache é por broadcast, com os e-mails internados
 * numa tabela única (o mesmo e-mail aparece em dezenas de broadcasts).
 *
 * ## Quando um broadcast congela
 *
 * Mesma regra do #10514 + #10787: lido com o envio a >= `KIT_ENGAGEMENT_FREEZE_DAYS`
 * dias, E indexado pelo filtro do Kit (entregues > 0 e alguma abertura ou
 * clique). Um broadcast lido vazio nunca congela: congelado com dado vazio,
 * nunca mais seria relido.
 *
 * ## Tamanho
 *
 * O cache é reconstruído a cada rodada só com os broadcasts que a rodada
 * pediu (diárias da janela + semanais de frio enviadas): diária que sai da
 * janela sai do cache.
 *
 * ## Fail-soft
 *
 * Cache ausente, ilegível ou de outra versão ⇒ descartado, a rodada relê tudo
 * (comportamento anterior). Falha de escrita só gera aviso no caller.
 *
 * ## Risco aceito (o mesmo do #10514)
 *
 * Abertura ou clique que chegue depois de 7 dias do envio num broadcast já
 * congelado não é visto. O frio olha 30/90 dias de sinal; quem lê de verdade
 * abre os broadcasts recentes, que seguem relidos ao vivo.
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeEmail } from "./brevo-diaria-store.ts";
import { KIT_ENGAGEMENT_FREEZE_DAYS } from "./kit-engagement-cache.ts";
import { BREVO_DIARIA_MATURATION_HOURS } from "./shared/brevo-diaria-score.ts";
import type { BroadcastEngagement } from "./kit-sem-abertura.ts";

export const KIT_FRIO_ENGAGEMENT_CACHE_VERSION = 1;

/** Em `data/` (gitignored, sincronizado), ao lado do log e da pausa do frio. */
export const DEFAULT_KIT_FRIO_ENGAGEMENT_CACHE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
  "data/kit-frio/engagement-cache.json",
);

export interface KitFrioEngagementCache {
  version: typeof KIT_FRIO_ENGAGEMENT_CACHE_VERSION;
  /** Tabela de e-mails normalizados; os broadcasts guardam índices nela. */
  emails: string[];
  /** id do broadcast → índices em `emails` de entregues (`d`), aberturas (`o`) e cliques (`c`). */
  broadcasts: Record<string, { d: number[]; o: number[]; c: number[] }>;
}

/** Pura — valida o JSON lido do disco. Qualquer desvio ⇒ `null` (cache descartado). */
export function parseKitFrioEngagementCache(raw: unknown): KitFrioEngagementCache | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as { version?: unknown; emails?: unknown; broadcasts?: unknown };
  if (c.version !== KIT_FRIO_ENGAGEMENT_CACHE_VERSION) return null;
  if (!Array.isArray(c.emails) || !c.emails.every((e) => typeof e === "string" && e.length > 0)) return null;
  if (!c.broadcasts || typeof c.broadcasts !== "object" || Array.isArray(c.broadcasts)) return null;
  const n = c.emails.length;
  const isIdxList = (v: unknown) => Array.isArray(v) && v.every((i) => Number.isInteger(i) && (i as number) >= 0 && (i as number) < n);
  for (const [id, b] of Object.entries(c.broadcasts as Record<string, unknown>)) {
    if (!/^[1-9]\d*$/.test(id)) return null;
    if (!b || typeof b !== "object") return null;
    const e = b as { d?: unknown; o?: unknown; c?: unknown };
    if (!isIdxList(e.d) || !isIdxList(e.o) || !isIdxList(e.c)) return null;
  }
  return c as KitFrioEngagementCache;
}

/** Pura — o engajamento congelado de um broadcast, ou `null` se não está no cache. */
export function cachedBroadcastEngagement(cache: KitFrioEngagementCache | null, broadcastId: number): BroadcastEngagement | null {
  const b = cache?.broadcasts[String(broadcastId)];
  if (!cache || !b) return null;
  const pick = (idx: number[]) => idx.map((i) => cache.emails[i]!);
  return { broadcastId, delivered: pick(b.d), opens: pick(b.o), clicks: pick(b.c) };
}

/**
 * Pura — o engajamento lido agora pode congelar? Envio a >= 7 dias (e >= a
 * maturação) E indexado pelo filtro do Kit (#10787: entregues > 0 e alguma
 * abertura ou clique).
 */
export function isFreezableEngagement(e: BroadcastEngagement, sentAt: string, nowMs: number): boolean {
  const sentMs = Date.parse(sentAt);
  if (!Number.isFinite(sentMs)) return false;
  const freezeMs = Math.max(KIT_ENGAGEMENT_FREEZE_DAYS * 24, BREVO_DIARIA_MATURATION_HOURS) * 3600 * 1000;
  if (nowMs - sentMs < freezeMs) return false;
  return e.delivered.length > 0 && (e.opens.length > 0 || e.clicks.length > 0);
}

/** Pura — monta o cache a partir dos broadcasts congelados (e-mails normalizados e internados, ordem estável). */
export function buildKitFrioEngagementCache(frozen: readonly BroadcastEngagement[]): KitFrioEngagementCache {
  const all = new Set<string>();
  for (const b of frozen) for (const list of [b.delivered, b.opens, b.clicks]) for (const e of list) all.add(normalizeEmail(e));
  const emails = [...all].sort();
  const index = new Map(emails.map((e, i) => [e, i]));
  const idx = (list: readonly string[]) => [...new Set(list.map((e) => index.get(normalizeEmail(e))!))].sort((x, y) => x - y);
  const broadcasts: KitFrioEngagementCache["broadcasts"] = {};
  for (const b of [...frozen].sort((x, y) => x.broadcastId - y.broadcastId)) {
    broadcasts[String(b.broadcastId)] = { d: idx(b.delivered), o: idx(b.opens), c: idx(b.clicks) };
  }
  return { version: KIT_FRIO_ENGAGEMENT_CACHE_VERSION, emails, broadcasts };
}
