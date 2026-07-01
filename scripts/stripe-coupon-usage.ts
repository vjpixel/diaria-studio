#!/usr/bin/env node
/**
 * stripe-coupon-usage.ts (#2717)
 *
 * Consulta a Stripe API para ver o uso dos cupons de desconto NEWS50 e NEWS25.
 * Read-only: apenas GET requests. Nunca escreve nem publica nada.
 *
 * Uso:
 *   npx tsx scripts/stripe-coupon-usage.ts [--write-kv] [--no-pii]
 *
 * Flags:
 *   --write-kv  sobe o report pro KV `coupons:usage` do dashboard.
 *   --no-pii    não imprime e-mail de cliente no stdout (mostra o cus_id) e não
 *               grava o CSV local. Usar em CI (GitHub Actions) — os logs do
 *               Actions são retidos e visíveis a colaboradores (#2750).
 *
 * Env:
 *   STRIPE_API_KEY  chave restrita (read-only: Coupons, Promotion Codes,
 *                   Customers, Subscriptions, Charges = Read). Valor em .env.local.
 *
 * Output:
 *   data/stripe-coupon-usage-YYYY-MM-DD.csv  (gitignored via data/; pulado c/ --no-pii)
 *   Resumo por cupom no stdout.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";

// Re-exports da lib compartilhada — tipos e funções puras disponíveis para testes
// que importam deste módulo (#2718: extraídos pra scripts/lib/stripe-coupons.ts).
export {
  TARGET_CODES,
  aggregateCouponUsage,
  fetchCouponUsage,
  // #2743: comissão sobre o realizado
  COMMISSION_RATE,
  COMMISSION_WINDOW_MONTHS,
  commissionWindowEnd,
  computePaidCents,
  commissionCents,
  // #2749: data do 1º pagamento (real vs previsão)
  firstPaymentInfo,
  // #2750: normalização de shape do coupon id (versões da Stripe API)
  couponIdFrom,
  type CouponRef,
  type PromoCodeRaw,
  type CouponRaw,
  type DiscountRaw,
  type SubscriptionRaw,
  type CustomerRaw,
  type ChargeRaw,
  type RedemptionRow,
  type CouponCodeReport,
  type CouponUsageReport,
} from "./lib/stripe-coupons.ts";

import { TARGET_CODES, fetchCouponUsage } from "./lib/stripe-coupons.ts";
import type { RedemptionRow } from "./lib/stripe-coupons.ts";
import { uploadTextToWorkerKV } from "./lib/cloudflare-kv-upload.ts";
import { DASHBOARD_KV_NAMESPACE_ID } from "./lib/dashboard-kv.ts";

// #2743: chave KV canônica do relatório de cupons (== COUPONS_KV_KEY no worker).
const COUPONS_KV_KEY = "coupons:usage";

const __dir = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dir, "..");

// ---------------------------------------------------------------------------
// CSV + print helpers (CLI-only — não entram no bundle do Worker)
// ---------------------------------------------------------------------------

function fmtBRL(cents: number): string {
  const abs = Math.abs(cents);
  return `R$${Math.floor(abs / 100)},${String(abs % 100).padStart(2, "0")}`;
}

/**
 * Quota um campo CSV conforme RFC 4180: se contém vírgula, aspas ou quebra de
 * linha, envolve em aspas duplas e escapa aspas internas dobrando-as. Campos
 * "limpos" passam sem alteração. Protege contra corrupção de colunas quando um
 * email vem com display name (`"Sobrenome, Nome" <a@b.com>`) ou qualquer campo
 * externo trouxer vírgula/aspas/newline (#2719).
 */
export function csvField(value: string | number | null): string {
  const s = value == null ? "" : String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * #2750: identificador do cliente pro stdout. Com `noPii` (CI), mostra o cus_id
 * (opaco) em vez do e-mail — os logs do GitHub Actions são retidos/visíveis.
 */
export function redemptionWho(r: RedemptionRow, noPii: boolean): string {
  if (noPii) return r.customer;
  return r.customer_email || r.customer;
}

export function toCSV(rows: RedemptionRow[]): string {
  const header =
    "coupon_code,coupon_id,percent_off,duration,customer,customer_email,subscription,status,created,plan_amount_cents,currency,interval,discount_value_cents,paid_cents,commission_cents,first_payment_epoch,first_payment_is_forecast";
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
      r.paid_cents ?? 0,
      r.commission_cents ?? 0,
      // #2749: data do 1º pagamento (epoch) + se é previsão (trial) — mantém o
      // CSV em sincronia com o report JSON gravado no KV.
      r.first_payment_epoch ?? "",
      r.first_payment_is_forecast == null ? "" : String(r.first_payment_is_forecast),
    ]
      .map(csvField)
      .join(","),
  );
  // Trailing newline — arquivos de texto POSIX terminam em \n (#2719)
  return [header, ...lines].join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// KV write (#2743) — repopula `coupons:usage` do dashboard, reproduzível.
// ---------------------------------------------------------------------------

/**
 * Valida as credenciais do Cloudflare exigidas por `--write-kv`. Chamado cedo
 * (antes do fetch caro na Stripe) pra fail-fast num run mal configurado, e de
 * novo dentro de writeReportToKv. Se faltarem, sai com código 1.
 */
function assertKvCreds(): { accountId: string; token: string } {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const token = process.env.CLOUDFLARE_WORKERS_TOKEN ?? "";
  if (!accountId || !token) {
    console.error(
      "[--write-kv] erro: CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_WORKERS_TOKEN ausentes — " +
        "não consegui subir o relatório ao KV. Defina-os no ambiente e rode de novo.",
    );
    process.exit(1);
  }
  return { accountId, token };
}

/**
 * Sobe o relatório de cupons pro KV do dashboard. Roda ANTES do early-return de
 * "0 resgates" (#2743): um report vazio ainda é válido e deve zerar o KV, em vez
 * de deixar dados velhos no dashboard.
 */
async function writeReportToKv(report: unknown): Promise<void> {
  const { accountId, token } = assertKvCreds();
  await uploadTextToWorkerKV(JSON.stringify(report), COUPONS_KV_KEY, {
    kvNamespaceId: DASHBOARD_KV_NAMESPACE_ID,
    accountId,
    token,
    contentType: "application/json",
  });
  console.log(`KV atualizado: ${COUPONS_KV_KEY} (dashboard de cupons).`);
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

  const writeKv = process.argv.includes("--write-kv");
  // #2750: --no-pii não imprime e-mail no stdout nem grava o CSV local — pra CI,
  // onde os logs do Actions são retidos e visíveis a colaboradores.
  const noPii = process.argv.includes("--no-pii");

  // #2750: se vamos escrever no KV, validar credenciais do Cloudflare ANTES do
  // fetch caro na Stripe — fail-fast, sem gastar quota da Stripe num run mal
  // configurado.
  if (writeKv) assertKvCreds();

  console.log("Buscando dados na Stripe API…");
  const report = await fetchCouponUsage(apiKey);

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
    console.log(`  Pago total (12m):          ${fmtBRL(entry.totalPaidCents ?? 0)}`);
    console.log(`  Comissão total (40%):      ${fmtBRL(entry.totalCommissionCents ?? 0)}`);
    for (const r of entry.redemptions) {
      const trial = r.status === "trialing" ? " [pending/trial]" : "";
      // #2749: data do 1º pagamento — "*" quando é previsão (trial, sem cobrança).
      const payDate = r.first_payment_epoch != null
        ? new Date(r.first_payment_epoch * 1000).toISOString().slice(0, 10) +
          (r.first_payment_is_forecast ? "*" : "")
        : "—";
      console.log(
        `    ${r.subscription}  ${redemptionWho(r, noPii)}  ` +
          `${r.status}${trial}  plan=${fmtBRL(r.plan_amount_cents)}/${r.interval}  ` +
          `pago=${fmtBRL(r.paid_cents ?? 0)}  comissão=${fmtBRL(r.commission_cents ?? 0)}  ` +
          `1ºpag=${payDate}`,
      );
    }
    console.log();
  }

  // #2743: total geral de comissão a receber (todos os cupons).
  const grandCommission = TARGET_CODES.reduce(
    (sum, c) => sum + (report[c]?.totalCommissionCents ?? 0),
    0,
  );
  console.log(`>>> Comissão total a receber (40% do pago em 12m): ${fmtBRL(grandCommission)}\n`);

  // #2743: `--write-kv` repopula o KV `coupons:usage` do dashboard (reproduzível,
  // em vez de wrangler kv put manual). Roda ANTES do early-return de "0 resgates"
  // — um report vazio ainda é válido e deve refletir no dashboard.
  if (writeKv) {
    await writeReportToKv(report);
  }

  const allRows = TARGET_CODES.flatMap((c) => report[c]?.redemptions ?? []);
  if (allRows.length === 0) {
    console.log("Nenhuma assinatura com esses cupons encontrada.");
    return;
  }

  // #2750: o CSV carrega customer_email (PII). Em CI (--no-pii) não gravamos o
  // arquivo — evita PII em disco no runner e em eventuais artifacts.
  if (noPii) {
    console.log(`CSV pulado (--no-pii). ${allRows.length} linha(s) no report.`);
    return;
  }

  const date = new Date().toISOString().slice(0, 10);
  const outDir = resolve(PROJECT_ROOT, "data");
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, `stripe-coupon-usage-${date}.csv`);
  writeFileSync(outPath, toCSV(allRows), "utf8");
  console.log(`CSV salvo em: ${outPath}`);
}

/**
 * Detecta se o módulo foi invocado diretamente (vs. importado por um teste).
 *
 * Comparação case-insensitive (#2719): no Windows, `process.argv[1]` pode vir
 * com casing diferente de `fileURLToPath(import.meta.url)` (ex.: letra do drive
 * `c:` vs `C:`). Uma comparação estrita case-sensitive daria `false` no Windows
 * e o script sairia silenciosamente sem rodar `main()`. Normalizamos ambos os
 * lados com `resolve()` + `toLowerCase()` antes de comparar.
 */
export function isMainModule(argv1: string | undefined, moduleUrl: string): boolean {
  if (argv1 == null) return false;
  return (
    resolve(argv1).toLowerCase() ===
    resolve(fileURLToPath(moduleUrl)).toLowerCase()
  );
}

if (isMainModule(process.argv[1], import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
