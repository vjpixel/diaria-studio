/**
 * scripts/coupon-clarice-class.ts (#9571 adendo)
 *
 * Calcula "novo/antigo" da Clarice por resgate de cupom e sobe pro KV
 * `coupons:clarice-class` do dashboard. Precisa rodar onde existe `data/`
 * (o `300`): o refresh de `coupons:usage` roda no GitHub Actions, sem o store.
 * O worker renderiza "—" quando esta chave falta ou está defasada.
 *
 * Uso: npx tsx scripts/coupon-clarice-class.ts [--dry-run]
 * Lê `coupons:usage` via API do Cloudflare (CLOUDFLARE_ACCOUNT_ID/_WORKERS_TOKEN).
 */
import { loadProjectEnv } from "./lib/env-loader.ts";
import { openClariceDb, findContactByEmail } from "./lib/clarice-db.ts";
import { uploadTextToWorkerKV } from "./lib/cloudflare-kv-upload.ts";
import { DASHBOARD_KV_NAMESPACE_ID } from "./lib/dashboard-kv.ts";
import {
  COUPON_CLARICE_CLASS_KV_KEY,
  classifyRedeemer,
  clariceClassKey,
  type CouponClariceClassPayload,
} from "./lib/coupon-clarice-class.ts";
import type { CouponUsageReport } from "./lib/stripe-coupons.ts";

async function main(): Promise<void> {
  loadProjectEnv();
  const dryRun = process.argv.includes("--dry-run");
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const token = process.env.CLOUDFLARE_WORKERS_TOKEN ?? "";
  if (!accountId || !token) {
    console.error("erro: CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_WORKERS_TOKEN ausentes.");
    process.exit(1);
  }
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${DASHBOARD_KV_NAMESPACE_ID}/values/coupons:usage`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    console.error(`erro: leitura de coupons:usage falhou (HTTP ${res.status}).`);
    process.exit(1);
  }
  const usage = (await res.json()) as CouponUsageReport;
  const db = openClariceDb();
  const classes: CouponClariceClassPayload["classes"] = {};
  let undated = 0;
  for (const rep of Object.values(usage)) {
    for (const r of rep.redemptions) {
      const m = findContactByEmail(db, r.customer_email);
      const row = m.row
        ? {
            created: (m.row.created as string | null) ?? null,
            brevo_created_at: (m.row.brevo_created_at as string | null) ?? null,
          }
        : null;
      const { cls, undated: u } = classifyRedeemer(row, r.created);
      if (u) undated++;
      classes[clariceClassKey(r.customer_email, r.created)] = cls;
    }
  }
  db.close();
  const payload: CouponClariceClassPayload = { generated_at: new Date().toISOString(), classes };
  console.log(`${Object.keys(classes).length} resgate(s) classificado(s); ${undated} sem data no store (→ antigo).`);
  if (dryRun) return;
  await uploadTextToWorkerKV(JSON.stringify(payload), COUPON_CLARICE_CLASS_KV_KEY, {
    kvNamespaceId: DASHBOARD_KV_NAMESPACE_ID, accountId, token, contentType: "application/json",
  });
  console.log(`KV atualizado: ${COUPON_CLARICE_CLASS_KV_KEY}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
