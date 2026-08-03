/**
 * brevo-stats.ts — parsing puro de um contato Brevo v3 → colunas Brevo do store
 * de usuários da Clarice (#2647 follow-up). Sem I/O: a parte testável do sync.
 *
 * A Brevo expõe, por contato (GET /contacts/{id}), `statistics` com arrays de
 * eventos por campanha — `messagesSent`, `opened`, `clicked`, `hardBounces`,
 * `softBounces`, `unsubscriptions`, `complaints`. Contamos campanhas (length do
 * array) e extraímos o evento mais recente (last_*_at). O agregado de campanha
 * vem zerado num quirk da Brevo, mas os eventos per-contato sobrevivem — por isso
 * o GET individual (mesma razão de `fetchBrevoEngagement` no antigo
 * clarice-build-waves.ts, removido em #2844/260702).
 */

export interface BrevoColumns {
  email: string;
  email_blacklisted: 0 | 1;
  unsubscribed: 0 | 1;
  hard_bounced: 0 | 1;
  complained: 0 | 1;
  opens_count: number;
  clicks_count: number;
  sends_count: number;
  soft_bounce_count: number;
  last_open_at: string | null;
  last_click_at: string | null;
  last_sent_at: string | null;
  recency_quartil: string | null;
  brevo_list_ids: string; // JSON array
  brevo_created_at: string | null;
  brevo_modified_at: string | null;
}

/** Campos de timestamp que a Brevo usa em entradas de evento (variam por categoria). */
const TIME_FIELDS = ["eventTime", "messageSentTime", "date", "time"];

/**
 * Normaliza coleções de eventos da Brevo. Aceita array (formato observado) E
 * objeto keyed-por-campanha (`{ "123": {...} }`) → Object.values, pra não zerar
 * a contagem se a Brevo devolver o formato object em alguma resposta.
 */
function asArray(v: unknown): any[] {
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object") return Object.values(v as object);
  return [];
}

/** Valor cru de timestamp (ISO string ou epoch) do 1º campo de TIME_FIELDS presente, ou undefined. */
function rawTimeField(obj: Record<string, unknown>): string | number | undefined {
  for (const f of TIME_FIELDS) {
    const v = obj[f];
    // aceita ISO string OU epoch numérico (alguns endpoints devolvem millis)
    if (typeof v === "string" && v) return v;
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

/**
 * Timestamps candidatos de UMA entrada de evento. Na maioria das categorias
 * (`opened`, `messagesSent`, ...) o timestamp mora no nível da própria entrada.
 * Em `clicked`, a Brevo v3 aninha o timestamp dentro de `links[]` — a entrada
 * em si só tem `campaignId` + `links` (#4429):
 *
 *   "clicked": [{ "campaignId": 21, "links": [{ "count": 2, "eventTime": "..." }] }]
 *
 * Por isso: se a própria entrada não tem timestamp, descemos em `links[]` e
 * coletamos o timestamp de cada link (o caller pega o mais recente de todos).
 */
function timestampsOf(entry: Record<string, unknown>): Array<string | number> {
  const own = rawTimeField(entry);
  if (own !== undefined) return [own];

  const links = asArray(entry.links);
  const nested: Array<string | number> = [];
  for (const link of links) {
    if (!link || typeof link !== "object") continue;
    const t = rawTimeField(link as Record<string, unknown>);
    if (t !== undefined) nested.push(t);
  }
  return nested;
}

/** ISO do evento mais recente do array, ou null se vazio/sem timestamp parseável. */
export function latestEventTime(events: unknown): string | null {
  const arr = asArray(events);
  let bestMs = -Infinity;
  let best: string | null = null;
  for (const e of arr) {
    if (!e || typeof e !== "object") continue;
    for (const raw of timestampsOf(e as Record<string, unknown>)) {
      const ms = typeof raw === "number" ? raw : new Date(raw).getTime();
      if (Number.isFinite(ms) && ms > bestMs) {
        bestMs = ms;
        best = new Date(ms).toISOString();
      }
    }
  }
  return best;
}

/**
 * Timestamp (epoch ms) de UMA entrada de evento (`messagesSent`/`opened`/...),
 * ou `null` se nenhum campo de tempo reconhecido está presente (#4476 —
 * janela de maturação de 48h da avaliação de supressão do canal Brevo próprio,
 * `scripts/evaluate-brevo-diaria.ts`). Reusa a mesma heurística de campo de
 * `latestEventTime` (`timestampsOf`/`rawTimeField`, `TIME_FIELDS` acima) —
 * pega o mais recente entre os candidatos da própria entrada (ou, se aninhado
 * como em `clicked`, de `links[]`). Não duplica a lista de campos de tempo:
 * único ponto de verdade pra "que campo é timestamp" nas 2 chamadoras
 * (parseBrevoContact aqui, computeMatureCountsFromBrevoStatistics lá).
 */
export function eventTimestampMs(entry: unknown): number | null {
  if (!entry || typeof entry !== "object") return null;
  let bestMs = -Infinity;
  for (const raw of timestampsOf(entry as Record<string, unknown>)) {
    const ms = typeof raw === "number" ? raw : new Date(raw).getTime();
    if (Number.isFinite(ms) && ms > bestMs) bestMs = ms;
  }
  return Number.isFinite(bestMs) ? bestMs : null;
}

/**
 * Parseia um contato Brevo v3 completo (identidade + statistics) nas colunas
 * Brevo do store. Tolerante a campos ausentes: contato sem `statistics` vira
 * tudo-zero (não lança).
 *
 * `unsubscribed` é OR de `emailBlacklisted`, evento de unsubscription e
 * `listUnsubscribed` não-vazio — qualquer sinal de descadastro suprime.
 */
export function parseBrevoContact(contact: Record<string, any>): BrevoColumns {
  const stats = (contact?.statistics ?? {}) as Record<string, unknown>;
  const attrs = (contact?.attributes ?? {}) as Record<string, unknown>;

  const hardBounces = asArray(stats.hardBounces).length;
  const softBounces = asArray(stats.softBounces).length;
  const complaints = asArray(stats.complaints).length;
  const unsubs = asArray(stats.unsubscriptions).length;
  const opens = asArray(stats.opened).length;
  const clicks = asArray(stats.clicked).length;
  const sent = asArray(stats.messagesSent).length;

  const blacklisted = !!contact?.emailBlacklisted;
  const listUnsubscribed = asArray(contact?.listUnsubscribed).length > 0;

  const recency = attrs.RECENCY_QUARTIL;

  return {
    email: String(contact?.email ?? "").trim().toLowerCase(),
    email_blacklisted: blacklisted ? 1 : 0,
    unsubscribed: blacklisted || unsubs > 0 || listUnsubscribed ? 1 : 0,
    hard_bounced: hardBounces > 0 ? 1 : 0,
    complained: complaints > 0 ? 1 : 0,
    opens_count: opens,
    clicks_count: clicks,
    sends_count: sent,
    soft_bounce_count: softBounces,
    last_open_at: latestEventTime(stats.opened),
    last_click_at: latestEventTime(stats.clicked),
    last_sent_at: latestEventTime(stats.messagesSent),
    recency_quartil:
      recency == null || recency === "" ? null : String(recency),
    brevo_list_ids: JSON.stringify(asArray(contact?.listIds)),
    brevo_created_at: contact?.createdAt ?? null,
    brevo_modified_at: contact?.modifiedAt ?? null,
  };
}
