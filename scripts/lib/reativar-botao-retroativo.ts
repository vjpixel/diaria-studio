/**
 * scripts/lib/reativar-botao-retroativo.ts (#9663 item 3)
 *
 * Reclassificação retroativa `self_confirmed_kit` → `self_confirmed_kit_botao`
 * pros contatos cujo clique no botão da reativação Brevo não ficou registrado
 * no Kit porque o custom field `confirmou_via` não existia (#9663 — o Kit
 * descarta em silêncio chave de `fields` desconhecida).
 *
 * O Kit não tem como devolver esse dado: o valor nunca foi gravado. A fonte
 * substituta é a Brevo — `GET /v3/contacts/{email}/campaignStats` traz, por
 * campanha, os links clicados com `eventTime`. Um contato `self_confirmed_kit`
 * que clicou num link do worker `reativar` ANTES (ou no instante) da promoção
 * confirmou pelo botão.
 *
 * Puro: seleção de candidatos, detecção do clique e aplicação no store. O I/O
 * (GET na Brevo, leitura/escrita do store) fica no CLI
 * `scripts/reclassify-reativar-botao-retroativo.ts`.
 */
import type { BrevoDiariaContact, BrevoDiariaStore } from "./brevo-diaria-store.ts";

/** Host do worker `reativar` (só `workers_dev`, sem domínio de marca). */
export const REATIVAR_LINK_HOST = "reativar.diaria.workers.dev";

/** Janela máxima de `campaignStats` aceita pela Brevo (dias). */
export const BREVO_CAMPAIGN_STATS_MAX_DAYS = 90;

/** Formato relevante de `GET /v3/contacts/{email}/campaignStats`. */
export interface BrevoContactCampaignStats {
  clicked?: Array<{
    campaignId?: number;
    links?: Array<{ url?: string; eventTime?: string; count?: number }>;
  }>;
}

/** Puro — a URL é um link do worker `reativar`? Compara host, não substring. */
export function isReativarLink(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).hostname.toLowerCase() === REATIVAR_LINK_HOST;
  } catch {
    return false;
  }
}

/**
 * Puro — o clique mais antigo num link `reativar` com `eventTime` ≤ `notAfter`
 * (ISO). `null` se nenhum. Clique sem `eventTime` legível é descartado: sem
 * hora não dá pra afirmar que ele veio antes da promoção.
 */
export function findReativarClickBefore(
  stats: BrevoContactCampaignStats | null | undefined,
  notAfter: string,
): { url: string; eventTime: string; campaignId?: number } | null {
  const limit = Date.parse(notAfter);
  if (Number.isNaN(limit)) return null;
  let best: { url: string; eventTime: string; campaignId?: number; t: number } | null = null;
  for (const c of stats?.clicked ?? []) {
    for (const l of c?.links ?? []) {
      if (!isReativarLink(l?.url)) continue;
      const t = Date.parse(l?.eventTime ?? "");
      if (Number.isNaN(t) || t > limit) continue;
      if (!best || t < best.t) best = { url: l.url!, eventTime: l.eventTime!, campaignId: c.campaignId, t };
    }
  }
  if (!best) return null;
  const { t: _t, ...rest } = best;
  return rest;
}

/**
 * Puro — contatos elegíveis: `promoted_beehiiv` + `self_confirmed_kit` com
 * `promoted_at` ≥ `since` (ISO/AAAA-MM-DD). Fora da janela de 90 dias da
 * Brevo o `campaignStats` não responde — `since` é limitado por quem chama.
 */
export function selectRetroCandidates(store: BrevoDiariaStore, since: string): BrevoDiariaContact[] {
  const sinceT = Date.parse(since);
  return store.contacts.filter((c) => {
    if (c.status !== "promoted_beehiiv" || c.resolution_reason !== "self_confirmed_kit") return false;
    const t = Date.parse(c.promoted_at ?? "");
    return !Number.isNaN(t) && (Number.isNaN(sinceT) || t >= sinceT);
  });
}

/** Puro — janela `startDate`/`endDate` (AAAA-MM-DD) do `campaignStats` pra um contato. */
export function campaignStatsWindow(
  addedAt: string | undefined,
  promotedAt: string,
): { startDate: string; endDate: string } {
  const end = new Date(promotedAt);
  const minStart = new Date(end.getTime() - (BREVO_CAMPAIGN_STATS_MAX_DAYS - 1) * 86_400_000);
  const added = addedAt ? new Date(addedAt) : null;
  const start = added && !Number.isNaN(added.getTime()) && added > minStart ? added : minStart;
  return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
}

/**
 * Puro — aplica a reclassificação. Só toca contatos ainda em
 * `promoted_beehiiv`/`self_confirmed_kit` (idempotente: rodar 2× não muda
 * nada na 2ª). Marca `reconciled_at` (quando a auditoria foi corrigida —
 * distinto de `promoted_at`). NÃO grava `confirmou_via`: esse campo espelha o
 * custom field do Kit, que continua vazio pra esses contatos.
 */
export function applyRetroBotaoReclassification(
  store: BrevoDiariaStore,
  emails: Iterable<string>,
  now: string = new Date().toISOString(),
): { store: BrevoDiariaStore; changed: number } {
  const set = new Set([...emails].map((e) => e.trim().toLowerCase()));
  let changed = 0;
  const contacts = store.contacts.map((c) => {
    if (!set.has(c.email.trim().toLowerCase())) return c;
    if (c.status !== "promoted_beehiiv" || c.resolution_reason !== "self_confirmed_kit") return c;
    changed++;
    return { ...c, resolution_reason: "self_confirmed_kit_botao" as const, reconciled_at: now };
  });
  return { store: { contacts }, changed };
}
