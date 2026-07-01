/**
 * stripe-coupons.ts — lib compartilhada entre o CLI (#2717) e o Worker (#2718).
 *
 * Design: sem imports node:* — apenas fetch nativo + plain JS.
 * Seguro para bundle Cloudflare Workers e para Node 24+ sem flags.
 *
 * Exports públicos:
 *   TARGET_CODES          — cupons monitorados (NEWS50, NEWS25)
 *   aggregateCouponUsage  — agrega dados brutos em CouponUsageReport
 *   fetchCouponUsage      — faz os GETs na Stripe API (fetchImpl injetável p/ testes)
 *   tipos                 — PromoCodeRaw, CouponRaw, ... CouponUsageReport
 */

export const TARGET_CODES = ["NEWS50", "NEWS25"] as const;

const STRIPE_BASE = "https://api.stripe.com/v1";

// #2743: comissão de afiliado. O editor recebe 40% de cada pagamento que o
// cliente faz nos 12 primeiros meses desde o resgate do cupom. O que importa
// não é o desconto projetado, e sim o REALIZADO (pago) e a comissão sobre ele.
export const COMMISSION_RATE = 0.4;
export const COMMISSION_WINDOW_MONTHS = 12;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PromoCodeRaw {
  id: string;
  object: "promotion_code";
  active: boolean;
  code: string;
  created: number;
  promotion: { coupon: string; type: string };
  max_redemptions: number | null;
  times_redeemed: number;
  restrictions: { first_time_transaction: boolean; minimum_amount: number | null };
}

export interface CouponRaw {
  id: string;
  object: "coupon";
  amount_off: number | null;
  percent_off: number | null;
  currency: string | null;
  duration: "once" | "repeating" | "forever";
  duration_in_months: number | null;
  name: string;
  times_redeemed: number;
  valid: boolean;
  max_redemptions: number | null;
}

export interface DiscountRaw {
  id: string;
  object: "discount";
  customer: string;
  promotion_code: string | null;
  /** New Stripe API: coupon id lives here */
  source?: { coupon: string; type: string };
  /** Legacy fallback: older API surfaces coupon id as string */
  coupon?: string;
  start: number;
  end: number | null;
  subscription: string;
}

export interface SubscriptionRaw {
  id: string;
  object: "subscription";
  customer: string;
  status: string;
  created: number;
  start_date: number;
  items: {
    data: Array<{
      price: {
        unit_amount: number;
        currency: string;
        recurring: { interval: string };
      };
    }>;
  };
  discounts: DiscountRaw[];
}

export interface CustomerRaw {
  id: string;
  email: string | null;
}

/** #2743: cobrança Stripe (payment). Só os campos usados p/ somar o realizado. */
export interface ChargeRaw {
  id: string;
  object: "charge";
  customer: string | null;
  amount: number;
  amount_captured?: number;
  amount_refunded?: number;
  created: number;
  status: string; // "succeeded" | "pending" | "failed"
  paid: boolean;
}

export interface RedemptionRow {
  coupon_code: string;
  coupon_id: string;
  percent_off: number | null;
  duration: string;
  customer: string;
  customer_email: string;
  subscription: string;
  status: string;
  created: number;
  plan_amount_cents: number;
  currency: string;
  interval: string;
  discount_value_cents: number;
  // #2743: realizado (net de refunds) do cliente na janela de 12m desde o resgate,
  // e a comissão de 40% sobre ele. OPCIONAIS: o KV populado antes do #2743 não os
  // tem (backward-compat); o render usa `?? 0`. aggregateCouponUsage sempre os seta.
  paid_cents?: number;
  commission_cents?: number;
}

export interface CouponCodeReport {
  couponIds: string[];
  timesRedeemed: number;
  rowCount: number;
  totalProjectedDiscountCents: number;
  // #2743: totais realizados do cupom (soma das redemptions). Opcionais — ver acima.
  totalPaidCents?: number;
  totalCommissionCents?: number;
  redemptions: RedemptionRow[];
}

// ---------------------------------------------------------------------------
// #2743 — comissão sobre o realizado (funções puras, testáveis)
// ---------------------------------------------------------------------------

/**
 * Fim da janela de comissão: `created` + COMMISSION_WINDOW_MONTHS meses (epoch s).
 * Usa aritmética de calendário (não 12×30 dias) — 12 meses reais.
 */
export function commissionWindowEnd(createdEpochSec: number): number {
  const end = new Date(createdEpochSec * 1000);
  end.setUTCMonth(end.getUTCMonth() + COMMISSION_WINDOW_MONTHS);
  return Math.floor(end.getTime() / 1000);
}

/**
 * Soma o valor PAGO (net de refunds) por um cliente na janela [created, created+12m).
 * Considera só charges `succeeded` + `paid`. `amount_captured` (fallback `amount`)
 * menos `amount_refunded`. Atribuição por cliente (granularidade "por e-mail").
 */
export function computePaidCents(
  charges: ChargeRaw[],
  customerId: string,
  createdEpochSec: number,
): number {
  const windowEnd = commissionWindowEnd(createdEpochSec);
  let paid = 0;
  for (const c of charges) {
    if (c.customer !== customerId) continue;
    if (c.status !== "succeeded" || !c.paid) continue;
    if (c.created < createdEpochSec || c.created >= windowEnd) continue;
    const captured = c.amount_captured ?? c.amount;
    const net = captured - (c.amount_refunded ?? 0);
    if (net > 0) paid += net;
  }
  return paid;
}

/** Comissão de 40% sobre o valor pago (arredondada ao centavo). */
export function commissionCents(paidCents: number): number {
  return Math.round(paidCents * COMMISSION_RATE);
}

export type CouponUsageReport = Record<string, CouponCodeReport>;

// ---------------------------------------------------------------------------
// Pure aggregation — no I/O, fully testable with fixtures
// ---------------------------------------------------------------------------

export function aggregateCouponUsage(input: {
  codes: PromoCodeRaw[];
  coupons: CouponRaw[];
  subscriptions: SubscriptionRaw[];
  customers: CustomerRaw[];
  charges?: ChargeRaw[]; // #2743: cobranças p/ computar o realizado + comissão
}): CouponUsageReport {
  const { codes, coupons, subscriptions, customers, charges = [] } = input;

  const couponById = new Map<string, CouponRaw>();
  for (const c of coupons) couponById.set(c.id, c);

  const emailById = new Map<string, string>();
  for (const c of customers) emailById.set(c.id, c.email ?? "");

  const codeToCouponIds = new Map<string, Set<string>>();
  for (const pc of codes) {
    if (!codeToCouponIds.has(pc.code)) codeToCouponIds.set(pc.code, new Set());
    codeToCouponIds.get(pc.code)!.add(pc.promotion.coupon);
  }

  const couponIdToCode = new Map<string, string>();
  for (const [code, ids] of codeToCouponIds) {
    for (const id of ids) couponIdToCode.set(id, code);
  }

  const report: CouponUsageReport = {};
  for (const [code, couponIds] of codeToCouponIds) {
    let timesRedeemed = 0;
    for (const cid of couponIds) {
      const c = couponById.get(cid);
      if (c) timesRedeemed += c.times_redeemed;
    }
    report[code] = {
      couponIds: [...couponIds],
      timesRedeemed,
      rowCount: 0,
      totalProjectedDiscountCents: 0,
      totalPaidCents: 0,
      totalCommissionCents: 0,
      redemptions: [],
    };
  }

  const seen = new Set<string>();

  for (const sub of subscriptions) {
    for (const discount of sub.discounts ?? []) {
      const discCouponId =
        discount.source?.coupon ??
        (typeof discount.coupon === "string" ? discount.coupon : undefined);
      if (!discCouponId) continue;

      const code = couponIdToCode.get(discCouponId);
      if (!code) continue;

      const dedupeKey = `${sub.id}:${code}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const coupon = couponById.get(discCouponId);
      if (!coupon) continue;

      const firstItem = sub.items.data[0];
      const planAmount = firstItem?.price.unit_amount ?? 0;
      const currency = firstItem?.price.currency ?? "unknown";
      const interval = firstItem?.price.recurring?.interval ?? "unknown";

      let discountValueCents = 0;
      if (coupon.amount_off != null) {
        discountValueCents = coupon.amount_off;
      } else if (coupon.percent_off != null) {
        if (coupon.duration === "once" || coupon.duration === "forever") {
          discountValueCents = Math.round((planAmount * coupon.percent_off) / 100);
        } else if (
          coupon.duration === "repeating" &&
          coupon.duration_in_months != null
        ) {
          discountValueCents = Math.round(
            (planAmount * coupon.percent_off * coupon.duration_in_months) / 100,
          );
        }
      }

      // #2743: realizado (net de refunds) do cliente na janela de 12m desde o
      // resgate + comissão de 40%. Atribuição por cliente (granularidade "por
      // e-mail" que o editor pediu).
      const paidCents = computePaidCents(charges, sub.customer, sub.created);

      report[code].redemptions.push({
        coupon_code: code,
        coupon_id: discCouponId,
        percent_off: coupon.percent_off,
        duration: coupon.duration,
        customer: sub.customer,
        customer_email: emailById.get(sub.customer) ?? "",
        subscription: sub.id,
        status: sub.status,
        created: sub.created,
        plan_amount_cents: planAmount,
        currency,
        interval,
        discount_value_cents: discountValueCents,
        paid_cents: paidCents,
        commission_cents: commissionCents(paidCents),
      });
    }
  }

  for (const code of Object.keys(report)) {
    const entry = report[code];
    entry.rowCount = entry.redemptions.length;
    entry.totalProjectedDiscountCents = entry.redemptions.reduce(
      (sum, r) => sum + r.discount_value_cents,
      0,
    );
    entry.totalPaidCents = entry.redemptions.reduce((sum, r) => sum + r.paid_cents, 0);
    entry.totalCommissionCents = entry.redemptions.reduce(
      (sum, r) => sum + r.commission_cents,
      0,
    );
  }

  return report;
}

// ---------------------------------------------------------------------------
// Portable Stripe fetch helpers — injetável pra testes e Worker-safe
// ---------------------------------------------------------------------------

async function stripeGet<T>(
  path: string,
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<T> {
  const res = await fetchImpl(`${STRIPE_BASE}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Stripe GET ${path} → ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

async function stripeListAll<T>(
  basePath: string,
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<T[]> {
  const items: T[] = [];
  let lastId: string | undefined;
  const sep = basePath.includes("?") ? "&" : "?";

  while (true) {
    const cursor = lastId ? `&starting_after=${lastId}` : "";
    const page = await stripeGet<{ data: T[]; has_more: boolean }>(
      `${basePath}${sep}limit=100${cursor}`,
      apiKey,
      fetchImpl,
    );
    items.push(...page.data);
    if (!page.has_more || page.data.length === 0) break;
    lastId = (page.data[page.data.length - 1] as { id: string }).id;
  }

  return items;
}

/**
 * Busca dados de cupons na Stripe API e retorna o relatório agregado.
 *
 * @param apiKey     Chave Stripe restrita (read-only: Coupons/Customers/Subscriptions/Charges).
 * @param fetchImpl  Implementação de fetch a usar (padrão: global fetch). Injetável para testes.
 */
export async function fetchCouponUsage(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CouponUsageReport> {
  const codes: PromoCodeRaw[] = [];
  for (const code of TARGET_CODES) {
    const list = await stripeListAll<PromoCodeRaw>(
      `/promotion_codes?code=${encodeURIComponent(code)}`,
      apiKey,
      fetchImpl,
    );
    codes.push(...list);
  }

  const couponIds = new Set<string>(codes.map((pc) => pc.promotion.coupon));
  const coupons: CouponRaw[] = [];
  for (const id of couponIds) {
    coupons.push(await stripeGet<CouponRaw>(`/coupons/${id}`, apiKey, fetchImpl));
  }

  const subscriptions = await stripeListAll<SubscriptionRaw>(
    "/subscriptions?status=all&expand[]=data.discounts",
    apiKey,
    fetchImpl,
  );

  const targetCouponIds = new Set(couponIds);
  const matchedCustomerIds = new Set<string>();
  for (const sub of subscriptions) {
    for (const d of sub.discounts ?? []) {
      const discId =
        d.source?.coupon ??
        (typeof d.coupon === "string" ? d.coupon : undefined);
      if (discId && targetCouponIds.has(discId)) {
        matchedCustomerIds.add(sub.customer);
        break;
      }
    }
  }

  const customers: CustomerRaw[] = [];
  const charges: ChargeRaw[] = [];
  for (const id of matchedCustomerIds) {
    customers.push(await stripeGet<CustomerRaw>(`/customers/${id}`, apiKey, fetchImpl));
    // #2743: cobranças do cliente p/ somar o realizado + comissão de 40%.
    // Read-only (Charges = Read na chave restrita). Paginado.
    const custCharges = await stripeListAll<ChargeRaw>(
      `/charges?customer=${encodeURIComponent(id)}`,
      apiKey,
      fetchImpl,
    );
    charges.push(...custCharges);
  }

  return aggregateCouponUsage({ codes, coupons, subscriptions, customers, charges });
}
