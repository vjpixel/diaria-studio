/**
 * scripts/coupon-clarice-class.ts (#9571 adendo)
 *
 * Calcula "novo/antigo" da Clarice por resgate de cupom e sobe pro KV
 * `coupons:clarice-class` do dashboard. Precisa rodar onde existe `data/`
 * (o `300`): o refresh de `coupons:usage` roda no GitHub Actions, sem o store.
 * O worker renderiza "—" quando esta chave falta ou está defasada (>72h).
 *
 * Agendamento (#9617): unit `diaria-coupon-clarice-class` no `300`, diária —
 * registrada em `scripts/lib/scheduled-tasks.ts` e em
 * `docs/scheduled-tasks-registry.md`. Cadência < 72h é obrigatória: sem ela a
 * coluna "Clarice" volta a "—" três dias depois da última rodada.
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
  buildClariceClasses,
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
  // #9617: a data usada é a do RESGATE (`redemptionEpoch`), a mesma da chave do worker.
  const { classes, undated } = buildClariceClasses(usage, (email) => {
    const m = findContactByEmail(db, email);
    return m.row
      ? {
          created: (m.row.created as string | null) ?? null,
          brevo_created_at: (m.row.brevo_created_at as string | null) ?? null,
        }
      : null;
  });
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
