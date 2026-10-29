/**
 * beehiiv-active-subscriptions.ts (#11225)
 *
 * Leitura paginada dos assinantes `active` da Beehiiv, extraída de
 * `scripts/reconcile-beehiiv-kit.ts` quando aquele CLI foi aposentado
 * (#11225: a Beehiiv virou só arquivo histórico; o guard de pré-switchover
 * do #6269 já tinha cumprido o papel em 04/09/2026, "só na Beehiiv: 0").
 *
 * A função continua com 3 consumidores vivos, por isso mora aqui e não foi
 * apagada junto com o CLI: `reconcile-send-audiences.ts` (ramo legado
 * `backend = "beehiiv"`), `audit-kit-diaria-exclusivity.ts` e
 * `kit-gmail-warmup-ramp.ts`.
 */

import { beehiivApiBase } from "./beehiiv-config.ts";
import { parseRetryAfterSecs } from "./brevo-client.ts";
import { hasMorePages } from "../sync-cursos-subscribers-kv.ts";

const PER_PAGE = 100;

interface BeehiivSubscriptionApi {
  email: string;
}

interface Page<T> {
  data?: T[];
  total_results?: number;
  limit?: number;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Pure: quanto esperar (ms) antes de retentar um 429, a partir do header
 * `Retry-After` real da resposta (#6311). `parseRetryAfterSecs` devolve
 * `null` tanto pra header ausente quanto pra forma não-numérica (data HTTP
 * RFC 7231 incluída); os dois caem no mesmo default seguro de 60s. Header
 * numérico é respeitado, com piso de 30s (nunca menos, mesmo se a API
 * mandar `Retry-After: 1`).
 */
export function computeRetryWaitMs(headers: Headers): number {
  const retryAfterSecs = parseRetryAfterSecs(headers);
  return retryAfterSecs != null ? Math.max(retryAfterSecs * 1000, 30_000) : 60_000;
}

/**
 * I/O: pagina `GET /subscriptions?status=active`, drenando por
 * `total_results` (não `total_pages` — #1897, mesma disciplina de
 * `backup-beehiiv.ts`). Falha loud em qualquer `!res.ok` ou truncamento:
 * uma leitura parcial nunca pode virar "conjunto completo" em silêncio.
 */
export async function fetchActiveBeehiivEmails(apiKey: string, publicationId: string): Promise<string[]> {
  const out: string[] = [];
  let page = 1;
  let more = true;
  let totalResults: number | null = null;
  while (more) {
    const res = await fetch(
      `${beehiivApiBase()}/publications/${publicationId}/subscriptions?status=active&per_page=${PER_PAGE}&page=${page}`,
      { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } },
    );
    if (res.status === 429) {
      await res.body?.cancel().catch(() => {});
      await sleep(computeRetryWaitMs(res.headers));
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`Beehiiv API ${res.status} em /subscriptions (página ${page})`);
    }
    const body = (await res.json()) as Page<BeehiivSubscriptionApi>;
    const got = body.data ?? [];
    for (const s of got) out.push(s.email);
    if (body.total_results != null) totalResults = body.total_results;
    more = hasMorePages({
      collected: out.length,
      gotLength: got.length,
      totalResults: body.total_results,
      effectiveLimit: body.limit,
      requestedPerPage: PER_PAGE,
    });
    page++;
  }
  if (totalResults != null && totalResults > 0 && out.length < totalResults) {
    throw new Error(
      `paginação de /subscriptions terminou cedo: coletado ${out.length} de ${totalResults} reportado pela API`,
    );
  }
  return out;
}
