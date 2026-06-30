#!/usr/bin/env node
/**
 * stripe-coupon-usage.ts (#2717)
 *
 * Consulta a Stripe API para ver o uso dos cupons de desconto NEWS50 e NEWS25.
 * Read-only: apenas GET requests. Nunca escreve nem publica nada.
 *
 * Uso:
 *   npx tsx scripts/stripe-coupon-usage.ts
 *
 * Env:
 *   STRIPE_API_KEY  chave restrita (read-only: Coupons, Customers, Invoices,
 *                   Subscriptions, Charges = Read). Valor em .env.local.
 *
 * Output:
 *   data/stripe-coupon-usage-YYYY-MM-DD.csv  (gitignored via data/)
 *   Resumo por cupom no stdout.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";

const __dir = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dir, "..");

const TARGET_CODES = ["NEWS50", "NEWS25"] as const;
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

  // Group promo codes by code string → Set of coupon ids (dedupe per code)
  const codeToCouponIds = new Map<string, Set<string>>();
  for (const pc of codes) {
    if (!codeToCouponIds.has(pc.code)) codeToCouponIds.set(pc.code, new Set());
    codeToCouponIds.get(pc.code)!.add(pc.promotion.coupon);
  }

  // Reverse: coupon id → code string (for fast subscription matching)
  const couponIdToCode = new Map<string, string>();
  for (const [code, ids] of codeToCouponIds) {
    for (const id of ids) couponIdToCode.set(id, code);
  }

  // Initialize report per code
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

  // Match subscriptions → codes; dedupe by (subId, code) to avoid double rows
  const seen = new Set<string>();

  for (const sub of subscriptions) {
    for (const discount of sub.discounts ?? []) {
      // Resolve coupon id: new API (source.coupon) takes precedence over legacy (coupon string)
      const discCouponId =
        discount.source?.coupon ??
        (typeof discount.coupon === "string" ? discount.coupon : undefined);
      if (!discCouponId) continue;

      const code = couponIdToCode.get(discCouponId);
      if (!code) continue; // not one of our target coupons

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
          // Best-effort projected total for repeating discount (one period's amount × N months).
          // For annual plans this over-counts; for monthly plans it's exact.
          // TODO: compute realized discount from paid invoices for higher accuracy (#2717 follow-up)
          discountValueCents = Math.round(
            (planAmount * coupon.percent_off * coupon.duration_in_months) / 100,
          );
        }
      }

      // trialing/no-paid-invoice → realized revenue = 0; discount_value_cents reflects projection
      // TODO: fetch invoices to distinguish realized vs projected revenue (#2717 follow-up)

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

  // Finalize per-code totals
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
// Stripe fetch helpers (native fetch, Node 24, no SDK)
// ---------------------------------------------------------------------------

async function stripeGet<T>(path: string, apiKey: string): Promise<T> {
  const res = await fetch(`${STRIPE_BASE}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Stripe GET ${path} → ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

async function stripeListAll<T>(basePath: string, apiKey: string): Promise<T[]> {
  const items: T[] = [];
  let lastId: string | undefined;
  const sep = basePath.includes("?") ? "&" : "?";

  while (true) {
    const cursor = lastId ? `&starting_after=${lastId}` : "";
    const page = await stripeGet<{ data: T[]; has_more: boolean }>(
      `${basePath}${sep}limit=100${cursor}`,
      apiKey,
    );
    items.push(...page.data);
    if (!page.has_more || page.data.length === 0) break;
    lastId = (page.data[page.data.length - 1] as { id: string }).id;
  }

  return items;
}

async function fetchAll(apiKey: string): Promise<{
  codes: PromoCodeRaw[];
  coupons: CouponRaw[];
  subscriptions: SubscriptionRaw[];
  customers: CustomerRaw[];
}> {
  // 1. Fetch promo codes for each target code string
  const codes: PromoCodeRaw[] = [];
  for (const code of TARGET_CODES) {
    const list = await stripeListAll<PromoCodeRaw>(
      `/promotion_codes?code=${encodeURIComponent(code)}`,
      apiKey,
    );
    codes.push(...list);
  }

  // 2. Collect unique coupon ids and fetch each coupon
  const couponIds = new Set<string>(codes.map((pc) => pc.promotion.coupon));
  const coupons: CouponRaw[] = [];
  for (const id of couponIds) {
    coupons.push(await stripeGet<CouponRaw>(`/coupons/${id}`, apiKey));
  }

  // 3. Fetch all subscriptions with discounts expanded
  const subscriptions = await stripeListAll<SubscriptionRaw>(
    "/subscriptions?status=all&expand[]=data.discounts",
    apiKey,
  );

  // 4. Fetch emails only for customers with matched subscriptions
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
    customers.push(await stripeGet<CustomerRaw>(`/customers/${id}`, apiKey));
  }

  return { codes, coupons, subscriptions, customers };
}

// ---------------------------------------------------------------------------
// CSV + print helpers
// ---------------------------------------------------------------------------

function fmtBRL(cents: number): string {
  const abs = Math.abs(cents);
  return `R$${Math.floor(abs / 100)},${String(abs % 100).padStart(2, "0")}`;
}

function toCSV(rows: RedemptionRow[]): string {
  const header =
    "coupon_code,coupon_id,percent_off,duration,customer,customer_email,subscription,status,created,plan_amount_cents,currency,interval,discount_value_cents";
  const lines = rows.map((r) =>
    [
      r.coupon_code,
      r.coupon_id,
      r.percent_off ?? "",
      r.duration,
      r.customer,
      r.customer_email,
      r.subscription,
      r.status,
      r.created,
      r.plan_amount_cents,
      r.currency,
      r.interval,
      r.discount_value_cents,
    ].join(","),
  );
  return [header, ...lines].join("\n");
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  loadProjectEnv();

  const apiKey = process.env.STRIPE_API_KEY;
  if (!apiKey) {
    console.error(
      "Erro: STRIPE_API_KEY não definida.\n" +
        "Defina a chave restrita (read-only) em .env.local — ver .env.example.",
    );
    process.exit(1);
  }

  console.log("Buscando dados na Stripe API…");
  const data = await fetchAll(apiKey);
  const report = aggregateCouponUsage(data);

  console.log("\n=== Uso de Cupons ===\n");
  for (const code of TARGET_CODES) {
    const entry = report[code];
    if (!entry) {
      console.log(`${code}: nenhum promotion_code encontrado.`);
      continue;
    }
    console.log(`${code} (coupon: ${entry.couponIds.join(", ")})`);
    console.log(`  Resgates (times_redeemed): ${entry.timesRedeemed}`);
    console.log(`  Assinaturas encontradas:   ${entry.rowCount}`);
    console.log(`  Desconto total projetado:  ${fmtBRL(entry.totalProjectedDiscountCents)}`);
    for (const r of entry.redemptions) {
      const trial = r.status === "trialing" ? " [pending/trial]" : "";
      console.log(
        `    ${r.subscription}  ${r.customer_email || r.customer}  ` +
          `${r.status}${trial}  plan=${fmtBRL(r.plan_amount_cents)}/${r.interval}  ` +
          `desconto=${fmtBRL(r.discount_value_cents)}`,
      );
    }
    console.log();
  }

  const allRows = TARGET_CODES.flatMap((c) => report[c]?.redemptions ?? []);
  if (allRows.length === 0) {
    console.log("Nenhuma assinatura com esses cupons encontrada.");
    return;
  }

  const date = new Date().toISOString().slice(0, 10);
  const outDir = resolve(PROJECT_ROOT, "data");
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, `stripe-coupon-usage-${date}.csv`);
  writeFileSync(outPath, toCSV(allRows), "utf8");
  console.log(`CSV salvo em: ${outPath}`);
}

// Only run when invoked directly (not when imported by tests)
const isMain =
  process.argv[1] != null &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
