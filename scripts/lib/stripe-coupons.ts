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

/**
 * Referência a um coupon nas várias formas que a Stripe API retorna conforme a
 * versão: id string, objeto `{ coupon: "id" }` (wrapper promotion/source), ou o
 * próprio Coupon inline `{ id: "…" }`. `couponIdFrom` normaliza todas (#2750).
 */
export type CouponRef =
  | string
  | { coupon?: string | { id: string }; id?: string; [k: string]: unknown }
  | null
  | undefined;

export interface PromoCodeRaw {
  id: string;
  object: "promotion_code";
  active: boolean;
  code: string;
  created: number;
  /** API nova (via MCP): coupon id em `promotion.coupon` — tipado `CouponRef`
   *  (não `{coupon: string}`) porque `couponIdFrom` também aceita `coupon`
   *  como objeto aninhado `{id}` nesse wrapper, não só string. */
  promotion?: CouponRef;
  /** API clássica (REST default): o Coupon vem inline em `coupon`. */
  coupon?: CouponRef;
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
  // #2750: "desconhecido" — placeholder pra coupon 404'd/deletado (metadados
  // reais indisponíveis; NÃO é um valor real da Stripe).
  duration: "once" | "repeating" | "forever" | "desconhecido";
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
  /** API nova: coupon id em `source.coupon` — `CouponRef` pelo mesmo motivo
   *  do `promotion` acima (`coupon` pode vir aninhado como objeto). */
  source?: CouponRef;
  /** API clássica: `coupon` é o Coupon inline (objeto) ou um id string. */
  coupon?: CouponRef;
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
  /** #2749: fim do trial = data prevista do 1º pagamento (billing começa aqui). */
  trial_end?: number | null;
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
  // #2749: data do 1º pagamento. Se já houve cobrança na janela → data real
  // (forecast=false). Se ainda em trial/sem cobrança → data PREVISTA (fim do
  // trial), forecast=true (o render marca com "*"). OPCIONAIS (backward-compat KV).
  first_payment_epoch?: number;
  first_payment_is_forecast?: boolean;
  // #2758: lista de TODOS os pagamentos (net) na janela de 12m — não só o 1º.
  // Vazia se ainda não há cobrança (trial); nesse caso `first_payment_epoch`/
  // `first_payment_is_forecast` seguem carregando a previsão. OPCIONAL —
  // backward-compat com KV populado antes do #2758.
  payments?: PaymentEntry[];
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

/**
 * #2750: extrai o id do coupon de qualquer forma que a Stripe API retorne
 * conforme a versão — resiliente a mudança de shape:
 *   - `"cpn_123"`                      (id string direto)
 *   - `{ coupon: "cpn_123" }`          (wrapper promotion/source da API nova)
 *   - `{ coupon: { id: "cpn_123" } }`  (coupon aninhado como objeto)
 *   - `{ id: "cpn_123", object: "coupon", … }` (Coupon inline da API clássica)
 * Retorna `undefined` se não achar id. O bug do #2750: o REST default da conta
 * retorna o Coupon inline (`coupon` objeto), não `promotion.coupon` string.
 */
export function couponIdFrom(value: CouponRef): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value || undefined;
  // Cada checagem exige valor NÃO-vazio antes de aceitar — um campo vazio
  // ("" ou {} sem id) cai pro próximo fallback em vez de "achar" um id vazio.
  if (typeof value.coupon === "string" && value.coupon) return value.coupon;
  if (value.coupon && typeof value.coupon === "object" && value.coupon.id) {
    return value.coupon.id;
  }
  if (typeof value.id === "string" && value.id) return value.id;
  return undefined;
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
  const targetMonth = end.getUTCMonth() + COMMISSION_WINDOW_MONTHS;
  const expectedMonth = ((targetMonth % 12) + 12) % 12;
  end.setUTCMonth(targetMonth);
  // Overflow guard (#2743): se o dia-do-mês não existe no mês alvo (ex.: 29/fev
  // + 12m num ano não-bissexto → dia 29 não existe em fev/2025), setUTCMonth
  // transborda pro mês seguinte (mar/2025). Recuamos pro último dia do mês alvo
  // (setUTCDate(0) = último dia do mês anterior) pra manter 12 meses de
  // calendário exatos, sem estender a janela por 1 dia.
  if (end.getUTCMonth() !== expectedMonth) {
    end.setUTCDate(0);
  }
  return Math.floor(end.getTime() / 1000);
}

/**
 * Soma o valor PAGO (net de refunds) por um cliente na janela [created, created+12m).
 * Considera só charges `succeeded` + `paid`. `amount_captured` (fallback `amount`)
 * menos `amount_refunded`. Atribuição por cliente (granularidade "por e-mail").
 */
/**
 * #2743: valor líquido (net) retido de um charge — capturado (fallback `amount`)
 * menos reembolsos. `amount_captured > 0` (não `?? `) porque um `0` explícito num
 * charge succeeded+paid não deve zerar o pagamento (cai pro `amount`). Helper
 * compartilhado por computePaidCents e firstPaymentInfo pra manter a mesma noção
 * de "pagamento válido" (net > 0) nos dois (#2749).
 */
export function chargeNetCents(c: ChargeRaw): number {
  const captured =
    c.amount_captured != null && c.amount_captured > 0 ? c.amount_captured : c.amount;
  return captured - (c.amount_refunded ?? 0);
}

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
    const net = chargeNetCents(c);
    if (net > 0) paid += net;
  }
  return paid;
}

/** Comissão de 40% sobre o valor pago (arredondada ao centavo). */
export function commissionCents(paidCents: number): number {
  return Math.round(paidCents * COMMISSION_RATE);
}

/** #2758: um pagamento individual (net) dentro da janela de comissão. */
export interface PaymentEntry {
  epoch: number;
  amount_cents: number;
  // #2758: id do charge Stripe — permite deduplicar quando o MESMO charge
  // aparece na lista de payments de duas redemptions do mesmo cliente (ex.:
  // 2 assinaturas com cupom cujas janelas se sobrepõem). Sem isso, uma
  // agregação cross-redemption (ex.: total por mês) contaria o mesmo
  // pagamento 2×. Não é PII adicional (id opaco da Stripe, não um dado do
  // cliente).
  id: string;
}

/**
 * #2758: TODOS os pagamentos (net, succeeded+paid, net>0) de um cliente na
 * janela [windowStart, windowEnd), ordenados por data crescente. Substitui a
 * ideia de "só o 1º pagamento" (#2749) — relevante sobretudo pra planos
 * mensais, onde uma assinatura de 12m pode ter até 12 cobranças distintas.
 * Mesmos filtros de `computePaidCents`/`firstPaymentInfo` (customer, status,
 * janela, net>0) — a soma de `amount_cents` aqui é idêntica ao resultado de
 * `computePaidCents` para o mesmo cliente/janela.
 */
export function paymentsInWindow(
  charges: ChargeRaw[],
  customerId: string,
  windowStart: number,
  windowEnd: number,
): PaymentEntry[] {
  const out: PaymentEntry[] = [];
  for (const c of charges) {
    if (c.customer !== customerId) continue;
    if (c.status !== "succeeded" || !c.paid) continue;
    if (c.created < windowStart || c.created >= windowEnd) continue;
    const net = chargeNetCents(c);
    if (net > 0) out.push({ epoch: c.created, amount_cents: net, id: c.id });
  }
  out.sort((a, b) => a.epoch - b.epoch);
  return out;
}

/**
 * #2749: data do 1º pagamento na janela [windowStart, windowEnd).
 * Se há charge succeeded+paid → menor `created` entre eles (data real,
 * forecast=false). Senão → `forecastEpoch` (fim do trial = previsão do 1º
 * pagamento), forecast=true. O render marca a previsão com "*".
 */
export function firstPaymentInfo(
  charges: ChargeRaw[],
  customerId: string,
  windowStart: number,
  windowEnd: number,
  forecastEpoch: number,
): { epoch: number; isForecast: boolean } {
  const payments = paymentsInWindow(charges, customerId, windowStart, windowEnd);
  return payments.length > 0
    ? { epoch: payments[0].epoch, isForecast: false }
    : { epoch: forecastEpoch, isForecast: true };
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
    const pcCouponId = couponIdFrom(pc.promotion) ?? couponIdFrom(pc.coupon);
    if (pcCouponId) {
      codeToCouponIds.get(pc.code)!.add(pcCouponId);
    } else {
      // #2750: shape não reconhecido (nem promotion.coupon nem coupon inline) —
      // sem isso o code perde silenciosamente esse promotion_code do relatório.
      console.warn(`[coupon-usage] promotion_code ${pc.id} (${pc.code}): não achei o coupon id — shape não reconhecido.`);
    }
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
      const discCouponId = couponIdFrom(discount.source) ?? couponIdFrom(discount.coupon);
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
      // e-mail" que o editor pediu — conta TODOS os pagamentos da pessoa na
      // janela, não só os da assinatura do cupom). Janela ancorada em
      // `discount.start` (quando o cupom foi de fato aplicado/resgatado), com
      // fallback pra `sub.created` — mais fiel a "desde o resgate" quando o
      // cupom é aplicado a uma assinatura já existente (start > created).
      const windowAnchor = discount.start ?? sub.created;
      const windowEnd = commissionWindowEnd(windowAnchor);
      // #2758: lista completa de pagamentos calculada UMA vez — paidCents e o
      // 1º pagamento (#2749) são derivados dela (mesmos filtros, sem reescanear
      // `charges` 3× separadamente).
      const payments = paymentsInWindow(charges, sub.customer, windowAnchor, windowEnd);
      const paidCents = payments.reduce((sum, p) => sum + p.amount_cents, 0);
      // #2749: previsão do 1º pagamento (fim do trial, fallback start_date).
      // Clamp em windowAnchor: a previsão nunca é anterior ao resgate (evita
      // mostrar data passada com "*" quando o cupom foi aplicado a uma assinatura
      // já existente, ou quando trial_end vem 0/ausente).
      const forecastEpoch = Math.max(sub.trial_end ?? sub.start_date, windowAnchor);
      const firstPayment = payments.length > 0
        ? { epoch: payments[0].epoch, isForecast: false }
        : { epoch: forecastEpoch, isForecast: true };

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
        first_payment_epoch: firstPayment.epoch,
        first_payment_is_forecast: firstPayment.isForecast,
        payments,
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
    // #2743: total PAGO deduplicado por cliente. No modelo por-e-mail,
    // computePaidCents já soma TODOS os pagamentos da pessoa na janela — então
    // se a mesma pessoa tiver +1 assinatura com o cupom, cada linha traria o
    // mesmo valor e somá-las inflaria o total. Contamos cada cliente UMA vez
    // (max entre as linhas dela, cobrindo âncoras diferentes por assinatura).
    const paidByCustomer = new Map<string, number>();
    for (const r of entry.redemptions) {
      const prev = paidByCustomer.get(r.customer) ?? 0;
      paidByCustomer.set(r.customer, Math.max(prev, r.paid_cents ?? 0));
    }
    entry.totalPaidCents = [...paidByCustomer.values()].reduce((sum, v) => sum + v, 0);
    // Comissão arredondada UMA vez sobre o pago total — somar comissões já
    // arredondadas por linha divergiria do valor correto em até ~N/2 centavos.
    entry.totalCommissionCents = commissionCents(entry.totalPaidCents);
  }

  return report;
}

// ---------------------------------------------------------------------------
// Portable Stripe fetch helpers — injetável pra testes e Worker-safe
// ---------------------------------------------------------------------------

/**
 * #2750: erro tipado com `status` HTTP estruturado — os callers checam
 * `err.status` (ex.: tolerar 404 de coupon deletado) em vez de fazer regex na
 * mensagem de texto livre. Mensagem de texto livre acopla o caller ao formato
 * exato da string, que quebra silenciosamente se `stripeGet` mudar o wording.
 */
export class StripeApiError extends Error {
  readonly status: number;
  constructor(path: string, status: number, body: string) {
    super(`Stripe GET ${path} → ${status}: ${body.slice(0, 300)}`);
    this.name = "StripeApiError";
    this.status = status;
  }
}

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
    throw new StripeApiError(path, res.status, body);
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

  const couponIds = new Set<string>(
    codes
      .map((pc) => couponIdFrom(pc.promotion) ?? couponIdFrom(pc.coupon))
      .filter((id): id is string => !!id),
  );
  const coupons: CouponRaw[] = [];
  for (const id of couponIds) {
    try {
      coupons.push(await stripeGet<CouponRaw>(`/coupons/${id}`, apiKey, fetchImpl));
    } catch (err) {
      // #2750: um coupon pode ter sido DELETADO na Stripe (404) — seja porque o
      // promotion_code que o referenciava está inativo, seja porque o editor
      // limpou o coupon enquanto uma assinatura AINDA o usa (Stripe permite
      // deletar um coupon com discounts ativos). Só tolera 404 — 401/403/5xx
      // (auth/infra) continuam estourando pra não mascarar falha real.
      if (!(err instanceof StripeApiError) || err.status !== 404) throw err;
      // Placeholder: garante que `couponById.get(id)` resolva mesmo sem os
      // metadados reais do coupon (percent_off/duration), pra que uma
      // assinatura que ainda referencia esse id NÃO seja descartada da
      // agregação — o que importa (pago/comissão) vem dos charges, não do
      // coupon. `duration: "desconhecido"` deixa explícito nos dados que é
      // um placeholder degradado, não um coupon real.
      coupons.push({
        id, object: "coupon", amount_off: null, percent_off: null, currency: null,
        duration: "desconhecido", duration_in_months: null, name: "(coupon deletado)",
        times_redeemed: 0, valid: false, max_redemptions: null,
      });
      console.warn(`[coupon-usage] coupon ${id} deletado/ausente (404) — metadados indisponíveis, comissão ainda rastreada.`);
    }
  }

  const subscriptions = await stripeListAll<SubscriptionRaw>(
    "/subscriptions?status=all&expand[]=data.discounts",
    apiKey,
    fetchImpl,
  );

  // `couponIds` já é o Set completo (inclui os 404'd — de propósito: uma
  // assinatura ainda pode referenciar um coupon deletado e precisa ser
  // encontrada/rastreada; ver o placeholder acima).
  const matchedCustomerIds = new Set<string>();
  for (const sub of subscriptions) {
    for (const d of sub.discounts ?? []) {
      const discId = couponIdFrom(d.source) ?? couponIdFrom(d.coupon);
      if (discId && couponIds.has(discId)) {
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
