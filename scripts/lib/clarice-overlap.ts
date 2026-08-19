/**
 * clarice-overlap.ts (#5697)
 *
 * Lógica PURA (sem I/O) de `scripts/clarice-audit-overlap.ts` — responde
 * "alguma lista Brevo alimentou mais de 1 campanha `sent` no período?", que é
 * o proxy barato pra "algum contato recebeu 2+ envios no período" já usado
 * pelo guard de campanhas comprometidas (`excludeCommittedToQueuedCampaigns`,
 * `scripts/lib/clarice-segment.ts`, #2994/#3682): no fluxo Clarice, cada
 * rodada de envio cria uma lista Brevo NOVA e dedicada (ver
 * `docs/scheduled-tasks-registry.md`/`clarice-import-waves.ts` — 1 lista por
 * `wN-*`/grupo), então a mesma lista alimentando 2 campanhas `sent`
 * distintas é sinal de reenvio, não de desenho normal.
 *
 * Separado de `scripts/clarice-audit-overlap.ts` (que só faz I/O: chama
 * `fetchCampaignsByStatus` uma vez e imprime) pra ficar testável sem mockar
 * `fetch`.
 */

import type { BrevoDraftCampaignRaw } from "./brevo-client.ts";

export interface OverlapCampaignRef {
  id?: number;
  name?: string;
  sentDate?: string | null;
}

export interface ListOverlap {
  /** id da lista Brevo (string — mesma forma serializada usada pelo resto do projeto). */
  listId: string;
  /** Campanhas `sent` que compartilham esta lista, mais de 1 por definição. */
  campaigns: OverlapCampaignRef[];
}

export interface OverlapFilterOpts {
  /** ISO date/datetime — só campanhas com `sentDate >= since` entram. */
  since?: string;
  /** ISO date/datetime — só campanhas com `sentDate <= until` entram. */
  until?: string;
}

/**
 * Agrupa campanhas `sent` por `recipients.lists`, filtra por período
 * opcional (`sentDate` — campanha sem `sentDate` é excluída quando um filtro
 * de período é pedido, já que não dá pra confirmar se está dentro da janela),
 * e devolve só as listas com >1 campanha (a sobreposição real). Determinístico
 * e puro — sem rede, sem relógio de sistema (o "agora" é responsabilidade de
 * quem chama, via `until`).
 */
export function findOverlappingListCampaigns(
  campaigns: BrevoDraftCampaignRaw[],
  opts: OverlapFilterOpts = {},
): ListOverlap[] {
  const hasWindow = opts.since != null || opts.until != null;
  const sinceMs = opts.since != null ? Date.parse(opts.since) : undefined;
  const untilMs = opts.until != null ? Date.parse(opts.until) : undefined;

  const filtered = campaigns.filter((c) => {
    if (!hasWindow) return true;
    if (!c.sentDate) return false;
    const t = Date.parse(c.sentDate);
    if (Number.isNaN(t)) return false;
    if (sinceMs != null && !Number.isNaN(sinceMs) && t < sinceMs) return false;
    if (untilMs != null && !Number.isNaN(untilMs) && t > untilMs) return false;
    return true;
  });

  const byList = new Map<string, OverlapCampaignRef[]>();
  for (const c of filtered) {
    for (const listId of c.recipients?.lists ?? []) {
      const key = String(listId);
      const arr = byList.get(key) ?? [];
      arr.push({ id: c.id, name: c.name, sentDate: c.sentDate });
      byList.set(key, arr);
    }
  }

  return [...byList.entries()]
    .filter(([, camps]) => camps.length > 1)
    .map(([listId, camps]) => ({ listId, campaigns: camps }));
}
