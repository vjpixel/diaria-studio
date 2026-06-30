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
}

export interface CouponCodeReport {
  couponIds: string[];
  timesRedeemed: number;
  rowCount: number;
  totalProjectedDiscountCents: number;
  redemptions: RedemptionRow[];
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
}): CouponUsageReport {
  const { codes, coupons, subscriptions, customers } = input;

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
  for (const id of matchedCustomerIds) {
    customers.push(await stripeGet<CustomerRaw>(`/customers/${id}`, apiKey, fetchImpl));
  }

  return aggregateCouponUsage({ codes, coupons, subscriptions, customers });
}
