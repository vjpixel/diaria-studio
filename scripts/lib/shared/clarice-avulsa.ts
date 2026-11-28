/**
 * clarice-avulsa.ts (#14339) — campanhas AVULSAS da Brevo da Clarice.
 *
 * Campanha avulsa é a que sai fora da maquinaria de ondas
 * (`clarice-envio-run.ts` / `clarice-schedule-group.ts`): lista montada à mão,
 * nome fora dos padrões `Clarice News {AAMM-MM} — X`, `Clarice {AAMM} grupo:{key}`
 * e `Diar.ia Mensal {AAMM}`. A 1ª foi a Black Friday 2026 (cupom NEWS65), em
 * duas partes: #438 (lista 431, score > 0, 27/11) e #439 (lista 432,
 * score ≤ 0, 28/11).
 *
 * Decisão do editor (briefing overnight 261128): categoria "avulsa" SEPARADA,
 * nunca atribuída a um ciclo (`2611-12`) nem a uma onda. Consequências:
 *
 *   - FORA dos agregados de ciclo/onda do dashboard (Resumo A/B/C, ondas
 *     `grupo:`, open rate por dia da semana que alimenta o plano semanal).
 *     Os parsers de ciclo já devolvem `null` pro nome avulso; este módulo dá
 *     o nome à categoria pra que ela não caia em "não classificada".
 *   - DENTRO do volume do ciclo de COBRANÇA Brevo (consome créditos do plano
 *     igual a qualquer envio), dos guardrails/alarmes (que já avaliam toda
 *     campanha `sent`, sem filtro de nome), do sunset/`priority_points` (o
 *     sync é por contato e não olha o nome da campanha) e da recência: quem
 *     recebeu a avulsa fica fora das ondas regulares por
 *     `cooldownDays` (`excludeAvulsaCooldown`).
 *
 * Nova campanha avulsa: registrar em `CLARICE_AVULSA_CAMPAIGNS` (id + listas
 * + data de envio BRT). O nome começando por "Clarice avulsa" ou
 * "Clarice Black Friday" também é reconhecido, mas só o registro arma o
 * cooldown (o cooldown precisa da data e das listas).
 *
 * Sem imports `node:*` — o Worker `brevo-dashboard` importa este módulo.
 */

export interface ClariceAvulsaCampaign {
  /** id da campanha na Brevo da Clarice. */
  id: number;
  /** Listas de destinatários (`recipients.lists`). */
  listIds: readonly number[];
  /** Data de envio, `YYYY-MM-DD` em BRT. */
  sentDate: string;
  /** Rótulo curto pra log/nota do dashboard. */
  label: string;
  /** Cupom da oferta, quando houver (rastreio em `stripe-coupons.ts`). */
  coupon?: string;
  /**
   * Dias, contados a partir de `sentDate`, em que quem recebeu esta campanha
   * fica fora das ondas regulares. Premissa do #14339: 7 dias, o intervalo
   * mínimo entre dois e-mails pra mesma pessoa; o mês-calendário do #7234 não
   * cobre a avulsa de fim de mês (27/11 → onda de 01/12 passaria).
   */
  cooldownDays: number;
}

export const CLARICE_AVULSA_CAMPAIGNS: readonly ClariceAvulsaCampaign[] = [
  {
    id: 438,
    listIds: [431],
    sentDate: "2026-11-27",
    label: "Black Friday 2026 (NEWS65), score > 0",
    coupon: "NEWS65",
    cooldownDays: 7,
  },
  {
    id: 439,
    listIds: [432],
    sentDate: "2026-11-28",
    label: "Black Friday 2026 (NEWS65), score ≤ 0",
    coupon: "NEWS65",
    cooldownDays: 7,
  },
];

const AVULSA_NAME_RE = /^Clarice (avulsa|Black Friday)\b/i;

/**
 * A campanha é avulsa? Registro por id vence; sem id (ou id fora do
 * registro), cai no padrão de nome. Pura.
 */
export function isClariceAvulsaCampaign(
  campaign: { id?: number | null; name?: string | null },
  registry: readonly ClariceAvulsaCampaign[] = CLARICE_AVULSA_CAMPAIGNS,
): boolean {
  if (typeof campaign.id === "number" && registry.some((a) => a.id === campaign.id)) return true;
  return AVULSA_NAME_RE.test((campaign.name ?? "").trim());
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 00:00 BRT (UTC−3, sem horário de verão desde 2019) de um `YYYY-MM-DD`. */
function brtMidnightMs(ymd: string): number {
  if (!YMD_RE.test(ymd)) return NaN;
  return Date.parse(`${ymd}T03:00:00.000Z`);
}

/** `YYYY-MM-DD` em BRT de um instante. */
export function brtDateOf(now: Date): string {
  return new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * Avulsas cujo cooldown cobre `refDate` (`YYYY-MM-DD` BRT, a data em que a
 * onda SAI): `sentDate <= refDate < sentDate + cooldownDays`. Uma avulsa com
 * data futura em relação à onda não conta (ainda não saiu). Pura.
 */
export function activeAvulsaCooldowns(
  refDate: string,
  registry: readonly ClariceAvulsaCampaign[] = CLARICE_AVULSA_CAMPAIGNS,
): ClariceAvulsaCampaign[] {
  const refMs = brtMidnightMs(refDate);
  if (!Number.isFinite(refMs)) {
    throw new Error(`activeAvulsaCooldowns: data inválida "${refDate}" — esperado YYYY-MM-DD.`);
  }
  return registry.filter((a) => {
    const startMs = brtMidnightMs(a.sentDate);
    if (!Number.isFinite(startMs)) return false;
    return refMs >= startMs && refMs < startMs + a.cooldownDays * DAY_MS;
  });
}

function parseListIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
  } catch {
    return [];
  }
}

export interface AvulsaCooldownResult<T> {
  kept: T[];
  excluded: number;
  active: ClariceAvulsaCampaign[];
}

/**
 * Tira do universo de uma onda regular quem recebeu uma avulsa ainda em
 * cooldown na data da onda. Dois sinais do store, qualquer um basta:
 *
 *   1. `last_sent_at >= 00:00 BRT da sentDate` da avulsa (o sync por contato
 *      grava o último envio de QUALQUER campanha, inclusive a avulsa);
 *   2. `brevo_list_ids` contém uma lista da avulsa (cobre quem o sync
 *      incremental ainda não revisitou com o `last_sent_at` novo).
 *
 * Os dois dependem do store sincronizado, como o filtro de recência do
 * #4719 (mesma pré-condição). Sem avulsa ativa, devolve a cópia intacta.
 * Pura.
 */
export function excludeAvulsaCooldown<
  T extends { last_sent_at?: string | null; brevo_list_ids?: string | null },
>(
  rows: readonly T[],
  refDate: string,
  registry: readonly ClariceAvulsaCampaign[] = CLARICE_AVULSA_CAMPAIGNS,
): AvulsaCooldownResult<T> {
  const active = activeAvulsaCooldowns(refDate, registry);
  if (active.length === 0) return { kept: rows.slice(), excluded: 0, active };
  const earliestStartMs = Math.min(...active.map((a) => brtMidnightMs(a.sentDate)));
  const lists = new Set(active.flatMap((a) => a.listIds.map(String)));
  const kept = rows.filter((r) => {
    if (r.last_sent_at) {
      const ms = Date.parse(r.last_sent_at);
      if (Number.isFinite(ms) && ms >= earliestStartMs) return false;
    }
    return !parseListIds(r.brevo_list_ids).some((id) => lists.has(id));
  });
  return { kept, excluded: rows.length - kept.length, active };
}
